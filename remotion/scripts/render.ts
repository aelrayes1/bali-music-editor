/**
 * Remotion render driver (called by the project CLI; no creative logic). Bundles the composition
 * with the conform directory as a symlinked public dir and renders one output with fixed settings.
 *
 *   node scripts/render.ts --props <props.json> --public-dir <dir> --bundle-dir <dir> --out <file> --preset preview|master [--separate-audio <wav>]
 *
 * preview: H.264 picture; its audio mix is written uncompressed to --separate-audio (Remotion's own
 * AAC-in-MP4 carried 2048 untrimmed priming samples = audio 42.7 ms late, found by Phase 5 QC), and
 * the project CLI encodes/muxes AAC with a correct priming edit list.
 */

import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "separate-audio": { type: "string" }, props: { type: "string" }, "public-dir": { type: "string" }, "bundle-dir": { type: "string" }, out: { type: "string" }, preset: { type: "string" }, concurrency: { type: "string", default: "2" }, "settings-out": { type: "string" } } });
const inputProps = JSON.parse(await readFile(values.props!, "utf8"));
const presets = {
  preview: { codec: "h264", crf: 14, x264Preset: "slow", pixelFormat: "yuv420p", imageFormat: "png", colorSpace: "bt709", audioCodec: "pcm-16" },
  master: { codec: "prores", proResProfile: "hq", pixelFormat: "yuv422p10le", imageFormat: "png", colorSpace: "bt709", audioCodec: "pcm-16" },
} as const;
const preset = presets[values.preset as keyof typeof presets];
if (!preset) throw new Error(`unknown preset ${values.preset}`);
const common = { sampleRate: 48000, concurrency: Number(values.concurrency), offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024, offthreadVideoThreads: 2, enforceAudioTrack: true, muted: false, chromiumOptions: { gl: "swangle" as const }, logLevel: "warn" as const };

await ensureBrowser();
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), publicDir: path.resolve(values["public-dir"]!), symlinkPublicDir: true, outDir: path.resolve(values["bundle-dir"]!), enableCaching: false });
const composition = await selectComposition({ serveUrl, id: "CleanEdit", inputProps });
const t0 = performance.now();
let last = -1;
const result = await renderMedia({
  ...common,
  ...preset,
  composition,
  serveUrl,
  inputProps,
  outputLocation: path.resolve(values.out!),
  ...(values["separate-audio"] ? { separateAudioTo: path.resolve(values["separate-audio"]) } : {}),
  overwrite: false,
  onProgress: ({ progress }) => {
    const p = Math.floor(progress * 10);
    if (p !== last) {
      last = p;
      process.stderr.write(`render ${values.preset} ${p * 10}%\n`);
    }
  },
});
const settings = { preset: values.preset, ...common, ...preset, separateAudioTo: values["separate-audio"] ?? null, composition: { id: composition.id, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames }, renderSeconds: Math.round((performance.now() - t0) / 100) / 10, slowestFrames: result.slowestFrames.slice(0, 3) };
if (values["settings-out"]) await writeFile(values["settings-out"], JSON.stringify(settings, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, out: values.out, renderSeconds: settings.renderSeconds }));
