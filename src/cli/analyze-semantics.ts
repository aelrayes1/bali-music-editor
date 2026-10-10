/**
 * Phase 3B semantic shot understanding (local only: Apple Vision on sampled frames).
 *
 *   npm run build:vision                       # once: compile native/vision-shots (Swift) into tools/
 *   npm run analyze-semantics -- --media <id> [--media …] | --all [--review 12] [--overrides projects/<p>/semantic-overrides.json]
 *
 * Reads Phase 3 analysis/footage/<id>/footage-analysis.json (never modified). Writes
 *   analysis/semantic/<id>/semantic-shot-analysis.json     raw model-derived semantics (per media)
 *   analysis/semantic/semantic-index.json                  novelty, duplicate groups, continuity candidates
 *   analysis/semantic/semantic-resolved.json               + user overrides (what Phase 4 reads)
 *   analysis/semantic/review/<id>/semantic-review.{jpg,md} human review sheet
 * Caches sampled frames and vision results in cache/semantic/.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { implementationFingerprint } from "../common/cache-identity.ts";
import { FootageAnalysisSchema } from "../footage/schema.ts";
import { probePacketPts, resolveMediaTools } from "../media/ffmpeg.ts";
import { findMedia } from "../media/manifest.ts";
import { MediaManifestSchema } from "../media/schema.ts";
import { buildSemanticMedia, frameTimeMap } from "../semantic/build.ts";
import { extractSampleFrames } from "../semantic/frames.ts";
import { type DuplicateLink, buildSemanticIndex } from "../semantic/index.ts";
import { SemanticOverridesSchema, resolveSemantics } from "../semantic/overrides.ts";
import { writeSemanticReview } from "../semantic/review.ts";
import { planSamples } from "../semantic/sampling.ts";
import { type SemanticMedia, SemanticMediaSchema, SemanticIndexSchema } from "../semantic/schema.ts";
import { resolveVisionTool, runVision } from "../semantic/vision.ts";
import { writeJson } from "./project.ts";

export const SEMANTIC_VERSION = "1.0.0";
const SEMANTIC_MODULES = ["build.ts", "index.ts", "sampling.ts", "schema.ts", "vision.ts", "frames.ts"].map((f) => new URL(`../semantic/${f}`, import.meta.url));

const { values } = parseArgs({
  options: {
    media: { type: "string", multiple: true, default: [] },
    all: { type: "boolean", default: false },
    manifest: { type: "string", default: "analysis/media-manifest.json" },
    out: { type: "string", default: "analysis/semantic" },
    review: { type: "string", default: "12" },
    overrides: { type: "string" },
  },
});
const manifest = MediaManifestSchema.parse(JSON.parse(await readFile(values.manifest!, "utf8")));
const footageIds = (await readdir("analysis/footage", { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const targets = values.all ? footageIds : values.media!;
if (!targets.length) throw new Error("pass --media <id> or --all");
const tools = await resolveMediaTools();
const tool = await resolveVisionTool();
const out = values.out!;
const implementation = implementationFingerprint(SEMANTIC_MODULES);
const footageIndex = JSON.parse(await readFile("analysis/footage/footage-index.json", "utf8")) as { crossMediaNearDuplicates: Array<{ a: { mediaId: string; shotId: string }; b: { mediaId: string; shotId: string }; hamming: number; strength: string }> };

for (const id of targets) {
  const t0 = performance.now();
  const entry = findMedia(manifest, id);
  if (!entry) throw new Error(`${id} not in manifest`);
  const fa = FootageAnalysisSchema.parse(JSON.parse(await readFile(`analysis/footage/${id}/footage-analysis.json`, "utf8")));
  const plan = planSamples(fa);
  const { files, w } = await extractSampleFrames(tools, entry, plan.map((p) => p.frameIndex), `cache/semantic/frames/${id}`);
  const scale = w / fa.geometry.display.w;
  const shotOf = new Map(fa.shots.map((s) => [s.shotId, s]));
  const items = plan.map((p) => {
    const r = shotOf.get(p.shotId)!.activePicture.activeRect;
    return { id: `${p.shotId}@${p.frameIndex}`, path: files.get(p.frameIndex)!, crop: { x: Math.round(r.x * scale), y: Math.round(r.y * scale), w: Math.max(8, Math.round(r.w * scale)), h: Math.max(8, Math.round(r.h * scale)) } };
  });
  const t1 = performance.now();
  const vision = await runVision(tool, items, `cache/semantic/vision/${id}.json`);
  const t2 = performance.now();
  const pts = (await probePacketPts(tools, entry.source.absolutePath, entry.video!.streamIndex)).sort((a, b) => a - b);
  const nd = new Map(fa.shots.map((s) => [s.shotId, s.nearDuplicates.map((d) => d.shotId)]));
  const doc = SemanticMediaSchema.parse(
    buildSemanticMedia(fa, plan, vision.results, frameTimeMap(pts, entry.video!.timeBase, plan.map((p) => p.frameIndex)), {
      generatedAt: new Date().toISOString(),
      collection: entry.source.rootId,
      nearDuplicates: nd,
      provenance: {
        tool: "native/vision-shots",
        framework: tool.framework,
        toolSha256: tool.binarySha256,
        osBuild: tool.osBuild,
        visionCacheKey: vision.key,
        phase3: { analyzerVersion: fa.analyzer.version, implementation: fa.analyzer.implementation, configHash: fa.analyzer.configHash },
        semanticVersion: SEMANTIC_VERSION,
        implementation,
      },
    }),
  );
  await writeJson(path.join(out, id, "semantic-shot-analysis.json"), doc);
  console.log(`${id} ${entry.source.relativePath}: ${plan.length} samples (${doc.shots.length} shots, ${doc.takes.length} same-take groups); frames ${((t1 - t0) / 1000).toFixed(1)} s, vision ${vision.cacheHit ? "cache hit" : `${((t2 - t1) / 1000).toFixed(1)} s`}`);
}

// Cross-media index, resolved view and review over everything analysed.
const docs: SemanticMedia[] = [];
for (const d of (await readdir(out, { withFileTypes: true }).catch(() => [])).filter((x) => x.isDirectory() && x.name.startsWith("m_")).map((x) => x.name).sort()) {
  docs.push(SemanticMediaSchema.parse(JSON.parse(await readFile(path.join(out, d, "semantic-shot-analysis.json"), "utf8"))));
}
const links: DuplicateLink[] = footageIndex.crossMediaNearDuplicates.map((l) => ({ a: l.a, b: l.b, evidence: `Phase 3 cross-media near-duplicate (dHash ${l.hamming}, ${l.strength})` }));
const index = SemanticIndexSchema.parse(buildSemanticIndex(docs, links));
await writeJson(path.join(out, "semantic-index.json"), index);
const overrides = values.overrides ? SemanticOverridesSchema.parse(JSON.parse(await readFile(values.overrides, "utf8"))) : null;
const resolved = resolveSemantics(docs, index, overrides);
await writeJson(path.join(out, "semantic-resolved.json"), { schemaVersion: "1.0.0", overrides: values.overrides ?? null, ...resolved });
const n = Number(values.review);
if (n > 0) {
  for (const d of docs.filter((x) => targets.includes(x.mediaId))) {
    const entry = findMedia(manifest, d.mediaId)!;
    const fa = FootageAnalysisSchema.parse(JSON.parse(await readFile(`analysis/footage/${d.mediaId}/footage-analysis.json`, "utf8")));
    const { files, w } = await extractSampleFrames(tools, entry, d.shots.flatMap((s) => s.samples.map((x) => x.frameIndex)), `cache/semantic/frames/${d.mediaId}`);
    const r = await writeSemanticReview(tools, d, fa, index, files, w, path.join(out, "review"), n);
    console.log(`review: ${r.sheets.join(", ")} + ${r.markdown}`);
  }
}
console.log(`index: ${docs.length} media, ${index.shots.length} shots, ${index.duplicateGroups.length} duplicate group(s); resolved warnings ${resolved.warnings.length}`);
