/**
 * Phase 3 orchestration: stream frames -> FrameSeries -> FootageAnalysis, cached by content
 * fingerprint + analyzer version + implementation fingerprint + config hash + FFmpeg version.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CacheIdentity, cacheKey, implementationFingerprint } from "../common/cache-identity.ts";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";
import { canonicalJson } from "../music/analyze.ts";
import { DEFAULT_FOOTAGE_CONFIG, type FootageConfig, buildFootageAnalysis } from "./build.ts";
import { analysisSize, streamGrayFrames } from "./decode.ts";
import { type FootageAnalysis, FootageAnalysisSchema } from "./schema.ts";
import { type Rect, dominantRect, frameBorders } from "./frame-metrics.ts";
import { FrameSeries } from "./series.ts";

export const FOOTAGE_ANALYZER_VERSION = "1.0.0";
export const ANALYSIS_MAX_SIDE = 320;
export const FOOTAGE_MODULES: readonly URL[] = ["analyze.ts", "build.ts", "decode.ts", "frame-metrics.ts", "schema.ts", "series.ts"].map(
  (f) => new URL(`./${f}`, import.meta.url),
);

export function footageConfigHash(cfg: FootageConfig): string {
  return createHash("sha256").update(canonicalJson({ analyzer: FOOTAGE_ANALYZER_VERSION, maxSide: ANALYSIS_MAX_SIDE, cfg })).digest("hex").slice(0, 16);
}

export function footageCacheIdentity(entry: MediaEntry, cfg: FootageConfig, ffmpegVersion: string, overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    input: entry.contentFingerprint.value,
    analyzer: "bali-footage-intelligence",
    analyzerVersion: FOOTAGE_ANALYZER_VERSION,
    implementation: implementationFingerprint(FOOTAGE_MODULES),
    configHash: footageConfigHash(cfg),
    tools: { ffmpeg: ffmpegVersion },
    ...overrides,
  };
}

export interface FootageOptions {
  cacheDir?: string | null;
  config?: FootageConfig;
  now?: () => string;
  identityOverrides?: Partial<CacheIdentity>;
}

export async function analyzeFootage(
  tools: MediaTools,
  entry: MediaEntry,
  options: FootageOptions = {},
): Promise<{ analysis: FootageAnalysis; cacheHit: boolean; cacheFile: string | null }> {
  const cfg = options.config ?? DEFAULT_FOOTAGE_CONFIG;
  const v = entry.video;
  if (!entry.isPlayableVideoFootage || !v) throw new Error(`${entry.mediaId} is not playable video footage`);
  const identity = footageCacheIdentity(entry, cfg, tools.ffprobeVersion, options.identityOverrides);
  const key = cacheKey(identity);
  const cacheFile = options.cacheDir
    ? path.join(options.cacheDir, `${entry.contentFingerprint.value.slice(0, 16)}-f${FOOTAGE_ANALYZER_VERSION}-${key}.json`)
    : null;
  if (cacheFile) {
    try {
      const doc = JSON.parse(await readFile(cacheFile, "utf8")) as { key?: string; analysis?: unknown };
      if (doc.key === key) return { analysis: FootageAnalysisSchema.parse(doc.analysis), cacheHit: true, cacheFile };
    } catch {
      /* miss */
    }
  }
  const { w, h } = analysisSize(v.displayWidth, v.displayHeight, ANALYSIS_MAX_SIDE);
  // Pre-pass: media-level active picture from sparse frames (keyframes; 2 fps if too few), so
  // exposure is measured inside the real picture and dark scene edges are not mistaken for borders.
  const statsRect = await mediaActiveRect(tools, entry, w, h);
  // overlay samples at ~2 fps
  const fps = v.averageFrameRate ? v.averageFrameRate.num / v.averageFrameRate.den : 25;
  const series = new FrameSeries(w, h, statsRect, Math.max(1, Math.round(fps / 2)));
  const decoded = await streamGrayFrames(tools, entry, ANALYSIS_MAX_SIDE, (px) => series.push(px));
  if (decoded.w !== w || decoded.h !== h) throw new Error("analysis size mismatch");
  const analysis = FootageAnalysisSchema.parse(
    buildFootageAnalysis(
      series,
      { pts: decoded.pts, lastDuration: decoded.lastDuration, timeBase: decoded.timeBase },
      {
        mediaId: entry.mediaId,
        fingerprint: entry.contentFingerprint.value,
        fileName: entry.source.fileName,
        streamIndex: v.streamIndex,
        stored: { w: v.storedWidth, h: v.storedHeight },
        display: { w: v.displayWidth, h: v.displayHeight },
        rotationClockwise: v.rotation.clockwiseToDisplay,
        orientation: v.orientation,
        frameRateMode: v.frameRateMode.classification,
        codec: v.codec,
        fieldOrder: v.fieldOrder ?? null,
        bitRate: v.bitRate ?? entry.container?.bitRate ?? null,
        analyzer: {
          name: "bali-footage-intelligence",
          version: FOOTAGE_ANALYZER_VERSION,
          implementation: identity.implementation,
          configHash: identity.configHash,
          config: { maxSide: ANALYSIS_MAX_SIDE, ...cfg },
          ffmpeg: { path: tools.ffmpeg, version: tools.ffprobeVersion },
        },
        generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
      cfg,
    ),
  );
  if (cacheFile) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({ key, identity, analysis }) + "\n");
    await rename(tmp, cacheFile);
  }
  return { analysis, cacheHit: false, cacheFile };
}

async function mediaActiveRect(tools: MediaTools, entry: MediaEntry, w: number, h: number): Promise<Rect> {
  for (const sampling of ["keyframes", "fps2"] as const) {
    const rects: Rect[] = [];
    await streamGrayFrames(tools, entry, ANALYSIS_MAX_SIDE, (px) => {
      const r = frameBorders(px, w, h);
      if (r.w > 0) rects.push(r);
    }, sampling);
    if (rects.length >= 10 || sampling === "fps2") return dominantRect(rects)?.rect ?? { x: 0, y: 0, w, h };
  }
  return { x: 0, y: 0, w, h };
}

/** Everything except generatedAt. */
export function deterministicFootageView(a: FootageAnalysis): string {
  return JSON.stringify({ ...a, generatedAt: "<generatedAt>" });
}
