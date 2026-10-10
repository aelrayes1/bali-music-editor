/**
 * Phase 3 objective footage intelligence.
 *
 *   npm run analyze-footage -- --media <mediaId> [--media <id> ...] | --all
 *                              [--manifest analysis/media-manifest.json] [--out analysis/footage]
 *                              [--no-cache] [--no-contact] [--max-mb 500]
 *
 * Writes analysis/footage/<mediaId>/footage-analysis.json, contact/shots-pNN.{jpg,json}, and
 * analysis/footage/footage-index.json (per-media summary + cross-media near-duplicate shots).
 * Frames are analysed in memory; nothing is transcoded, no proxies or frame caches are created.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { hamming } from "../footage/frame-metrics.ts";
import { parseHash } from "../footage/build.ts";
import { analyzeFootage } from "../footage/analyze.ts";
import { shotContactSheets } from "../footage/contact.ts";
import { type FootageAnalysis, FootageAnalysisSchema } from "../footage/schema.ts";
import { resolveMediaTools } from "../media/ffmpeg.ts";
import { MediaManifestSchema } from "../media/schema.ts";
import { toNumberApprox } from "../time/rational.ts";
import { writeJson } from "./project.ts";

const { values } = parseArgs({
  options: {
    media: { type: "string", multiple: true, default: [] },
    all: { type: "boolean", default: false },
    manifest: { type: "string", default: "analysis/media-manifest.json" },
    out: { type: "string", default: "analysis/footage" },
    "no-cache": { type: "boolean", default: false },
    "no-contact": { type: "boolean", default: false },
    "max-mb": { type: "string", default: "500" },
  },
});

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await stat(p)).size;
  }
  return total;
}

const manifest = MediaManifestSchema.parse(JSON.parse(await readFile(values.manifest!, "utf8")));
const footage = manifest.media.filter((m) => m.isPlayableVideoFootage && !m.duplicateOf);
const targets = values.all ? footage : footage.filter((m) => values.media!.includes(m.mediaId));
const unknown = values.media!.filter((id) => !footage.some((m) => m.mediaId === id));
if (unknown.length) throw new Error(`not playable footage in the manifest: ${unknown.join(", ")}`);
if (!targets.length) throw new Error("nothing to analyse: pass --media <id> or --all");
const maxBytes = Number(values["max-mb"]) * 1e6;
const tools = await resolveMediaTools();
const out = values.out!;

for (const entry of targets) {
  const t0 = performance.now();
  const { analysis, cacheHit } = await analyzeFootage(tools, entry, { cacheDir: values["no-cache"] ? null : "cache/footage" });
  const tA = performance.now();
  await writeJson(path.join(out, entry.mediaId, "footage-analysis.json"), analysis);
  let pages = 0;
  if (!values["no-contact"]) pages = (await shotContactSheets(tools, entry, analysis, { outDir: out })).length;
  const a = analysis;
  const used = await dirBytes(out);
  console.log(
    `${entry.mediaId} ${entry.source.relativePath}: ${cacheHit ? "cache hit" : "analysed"} in ${((tA - t0) / 1000).toFixed(1)} s` +
      `${values["no-contact"] ? "" : `, ${pages} contact page(s) in ${((performance.now() - tA) / 1000).toFixed(1)} s`}; ` +
      `${a.timing.frameCount} frames, ${a.shots.length} shots, active ${a.activePicture.type} ${a.activePicture.activeRect.w}x${a.activePicture.activeRect.h} of ${a.geometry.display.w}x${a.geometry.display.h}, ` +
      `static ${a.static.staticImageVideo}, overlays ${a.overlayEvaluable ? a.overlays.length : "n/a"}; output so far ${(used / 1e6).toFixed(1)} MB`,
  );
  if (used > maxBytes) throw new Error(`generated footage analysis exceeds the ${values["max-mb"]} MB cap (${(used / 1e6).toFixed(1)} MB); stopping`);
}

// Index over every analysed media on disk (not only this run).
const docs: FootageAnalysis[] = [];
for (const d of (await readdir(out, { withFileTypes: true }).catch(() => [])).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
  try {
    docs.push(FootageAnalysisSchema.parse(JSON.parse(await readFile(path.join(out, d, "footage-analysis.json"), "utf8"))));
  } catch {
    /* not an analysis dir */
  }
}
const crossDuplicates = [];
for (let i = 0; i < docs.length; i++) {
  for (let j = i + 1; j < docs.length; j++) {
    for (const x of docs[i]!.shots) {
      for (const y of docs[j]!.shots) {
        // 64-bit gradient hash of the representative frames (brightness-invariant). Different captures
        // of the same material differ more than re-cuts within one file: <= 6 strong, <= 14 possible.
        const h = hamming(parseHash(x.dHash), parseHash(y.dHash));
        // A fingerprint of a dark / featureless frame is unreliable: "possible" matches need detail on both sides.
        const detailed = (z: typeof x) => z.sharpness.p50 >= 150 && z.exposure.dynamicRange >= 100;
        const ok = h <= 6 || (detailed(x) && detailed(y));
        if (h <= 14 && ok && x.black.fraction < 0.5 && y.black.fraction < 0.5 && !docs[i]!.static.staticImageVideo && !docs[j]!.static.staticImageVideo) {
          crossDuplicates.push({ a: { mediaId: docs[i]!.source.mediaId, shotId: x.shotId }, b: { mediaId: docs[j]!.source.mediaId, shotId: y.shotId }, hamming: h, strength: h <= 6 ? "strong" : "possible" });
        }
      }
    }
  }
}
await writeJson(path.join(out, "footage-index.json"), {
  schemaVersion: "1.0.0",
  media: docs.map((a) => ({
    mediaId: a.source.mediaId,
    fileName: a.source.fileName,
    display: a.geometry.display,
    orientation: a.geometry.orientation,
    frameRateMode: a.timing.frameRateMode,
    durationSeconds: Math.round(toNumberApprox(a.timing.end) * 1000) / 1000,
    frames: a.timing.frameCount,
    shots: a.shots.length,
    activePicture: { type: a.activePicture.type, rect: a.activePicture.activeRect, aspect: a.activePicture.activeAspect, confidence: a.activePicture.confidence },
    staticImageVideo: a.static.staticImageVideo,
    overlays: a.overlayEvaluable ? a.overlays.map((o) => ({ id: o.id, bbox: o.bbox, persistence: o.persistence, confidence: o.confidence })) : null,
    usableSeconds: Math.round(a.shots.reduce((s, x) => s + toNumberApprox(x.usable.seconds), 0) * 1000) / 1000,
  })),
  crossMediaNearDuplicates: crossDuplicates,
});
console.log(`wrote ${path.join(out, "footage-index.json")} (${docs.length} media, ${crossDuplicates.length} cross-media near-duplicate shot pairs); total ${((await dirBytes(out)) / 1e6).toFixed(1)} MB`);
