/**
 * Multi-job Remotion driver (Phase 6A): bundle once, render a list of jobs sequentially, record
 * per-job timing. No creative logic: compositions and props come from the caller.
 *
 *   node scripts/render-jobs.ts --jobs <jobs.json> --public-dir <dir> --bundle-dir <dir> --results <out.json>
 *
 * presets: "preview" = H.264 CRF 16 + separate PCM WAV (muxed by the caller, avoiding Remotion's
 * untrimmed AAC priming); "qc" = ProRes 4444 without audio (high fidelity for frame comparisons).
 * Production deliverables (the Phase 5 delivery profile): "social" = H.264 CRF 14 slow yuv420p BT.709 +
 * separate PCM WAV (muxed to AAC by the caller); "master" = ProRes HQ 4:2:2 10-bit without audio (PCM
 * muxed by the caller).
 */

import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { jobs: { type: "string" }, "public-dir": { type: "string" }, "bundle-dir": { type: "string" }, results: { type: "string" }, concurrency: { type: "string", default: "2" } } });
const jobs = JSON.parse(await readFile(values.jobs!, "utf8")) as Array<{ id: string; composition: string; props: Record<string, unknown>; out: string; preset: "preview" | "qc" | "social" | "master"; scale?: number; audioOut?: string }>;
await ensureBrowser();
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), publicDir: path.resolve(values["public-dir"]!), symlinkPublicDir: true, outDir: path.resolve(values["bundle-dir"]!), enableCaching: false });
const results: Array<Record<string, unknown>> = [];
for (const j of jobs) {
  const composition = await selectComposition({ serveUrl, id: j.composition, inputProps: j.props });
  const t0 = performance.now();
  const audio = { audioCodec: "pcm-16" as const, ...(j.audioOut ? { separateAudioTo: path.resolve(j.audioOut) } : { muted: true }) };
  const preset =
    j.preset === "qc"
      ? { codec: "prores" as const, proResProfile: "4444" as const, imageFormat: "png" as const, muted: true }
      : j.preset === "master"
        ? { codec: "prores" as const, proResProfile: "hq" as const, pixelFormat: "yuv422p10le" as const, colorSpace: "bt709" as const, imageFormat: "png" as const, muted: true }
        : j.preset === "social"
          ? { codec: "h264" as const, crf: 14, x264Preset: "slow" as const, pixelFormat: "yuv420p" as const, imageFormat: "png" as const, colorSpace: "bt709" as const, ...audio }
          : { codec: "h264" as const, crf: 16, x264Preset: "medium" as const, pixelFormat: "yuv420p" as const, imageFormat: "png" as const, colorSpace: "bt709" as const, audioCodec: "pcm-16" as const, ...(j.audioOut ? { separateAudioTo: path.resolve(j.audioOut) } : { muted: true }) };
  await renderMedia({ ...preset, composition, serveUrl, inputProps: j.props, outputLocation: path.resolve(j.out), overwrite: true, concurrency: Number(values.concurrency), scale: j.scale ?? 1, sampleRate: 48000, offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024, chromiumOptions: { gl: "swangle" }, logLevel: "warn" });
  const seconds = Math.round((performance.now() - t0) / 100) / 10;
  results.push({ id: j.id, frames: composition.durationInFrames, seconds, msPerFrame: Math.round((seconds * 1000) / composition.durationInFrames), width: composition.width * (j.scale ?? 1), height: composition.height * (j.scale ?? 1) });
  process.stderr.write(`job ${j.id}: ${composition.durationInFrames} frames in ${seconds} s\n`);
}
await writeFile(values.results!, JSON.stringify(results, null, 2) + "\n");
