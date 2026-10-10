/**
 * Ingest configured source roots into analysis/media-manifest.json.
 *
 *   npm run ingest -- [--config config/sources.local.json] [--out analysis/media-manifest.json]
 *                     [--full-hash] [--no-decode-check]
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveMediaTools } from "../media/ffmpeg.ts";
import { buildManifest, serializeManifest } from "../media/manifest.ts";
import { loadSourcesConfig } from "../media/sources.ts";
import { toDecimalString } from "../time/rational.ts";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "config/sources.local.json" },
    out: { type: "string", default: "analysis/media-manifest.json" },
    "full-hash": { type: "boolean", default: false },
    "no-decode-check": { type: "boolean", default: false },
  },
});

const tools = await resolveMediaTools();
const config = await loadSourcesConfig(values.config!);
const manifest = await buildManifest(tools, config, {
  fullHash: values["full-hash"],
  decodeCheck: !values["no-decode-check"],
});

const out = path.resolve(values.out!);
await mkdir(path.dirname(out), { recursive: true });
const tmp = `${out}.tmp-${process.pid}`;
await writeFile(tmp, serializeManifest(manifest));
await rename(tmp, out); // atomic replace of our own generated file

console.log(`wrote ${out}`);
console.log(`ffprobe ${manifest.generator.ffprobe.version} · ${manifest.summary.total} media · ${JSON.stringify(manifest.summary.byStatus)}`);
for (const m of manifest.media) {
  const v = m.video;
  const rate = (r: { num: number; den: number } | null) => (r ? `${r.num}/${r.den}` : "?");
  const desc = v
    ? `${v.displayWidth}x${v.displayHeight} ${v.orientation} rot${v.rotation.clockwiseToDisplay} ` +
      `nominal ${rate(v.nominalFrameRate)} avg ${rate(v.averageFrameRate)} ${v.frameRateMode.classification} ` +
      `frames ${v.frameCount.value ?? "?"}`
    : m.audio
      ? `audio ${m.audio.codec} ${m.audio.sampleRate}Hz ${m.audio.channels}ch`
      : "-";
  const dur = m.container?.durationSeconds ? `${toDecimalString(m.container.durationSeconds, 3)}s` : "?";
  const pics = m.attachedPictures.length ? ` +${m.attachedPictures.length} cover/still (not footage)` : "";
  console.log(`  ${m.mediaId}  ${m.status.padEnd(9)} ${m.kind.padEnd(5)} ${dur.padStart(10)}  ${desc}${pics}  [${m.source.rootId}/${m.source.relativePath}]`);
}
