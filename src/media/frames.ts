/**
 * Diagnostic thumbnails and contact sheets (frame grids).
 *
 * Concept adapted (not copied) from agamm/video-agent `detect` @ cc00d28 (labelled grid +
 * cell -> frame mapping); see PROVENANCE.md. Differences: cells map to exact source
 * timestamps and true frame indices (VFR-safe), frames are extracted from the explicit
 * footage stream (never cover art), rotation and non-square pixels are corrected, and
 * everything is written only inside the caller's output directory.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type MediaTools, probePacketPts, runFfmpeg } from "./ffmpeg.ts";
import type { MediaEntry, RationalJson } from "./schema.ts";
import {
  type Rational,
  add,
  compare,
  div,
  floor,
  mul,
  parseRatio,
  rational,
  toDecimalString,
} from "../time/rational.ts";

export const DEFAULT_LABEL_FONT = "/System/Library/Fonts/Menlo.ttc";

export class NotFootageError extends Error {
  constructor(entry: MediaEntry) {
    super(
      `${entry.mediaId} (${entry.source.relativePath}) has no playable video footage ` +
        `(status ${entry.status}, kind ${entry.kind}); cover art and still images are never sampled`,
    );
    this.name = "NotFootageError";
  }
}

export interface ExtractedFrame {
  /** Time that was requested (source time, seconds). */
  requestedSeconds: RationalJson;
  /** Presentation time of the frame actually decoded (source time, seconds). */
  frameSeconds: RationalJson;
  framePts: number;
  timeBase: RationalJson;
  /** Index of the decoded frame in presentation order (0-based), from packet timestamps. */
  frameIndex: number | null;
  file: string;
}

function requireFootage(entry: MediaEntry): NonNullable<MediaEntry["video"]> {
  if (!entry.isPlayableVideoFootage || !entry.video) throw new NotFootageError(entry);
  return entry.video;
}

function durationOf(entry: MediaEntry): { start: Rational; duration: Rational } {
  const video = requireFootage(entry);
  const start = video.startTimeSeconds ?? rational(0);
  const duration = video.durationSeconds ?? entry.container?.durationSeconds ?? null;
  if (!duration || compare(duration, rational(0)) <= 0) {
    throw new Error(`${entry.mediaId}: duration unknown, cannot place sample times`);
  }
  return { start, duration };
}

/** Evenly spaced sample times at the centre of n equal slices of the stream. */
export function sampleTimes(start: Rational, duration: Rational, n: number): Rational[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("sample count must be a positive integer");
  return Array.from({ length: n }, (_, i) => add(start, div(mul(duration, rational(2 * i + 1)), rational(2 * n))));
}

/** Index of `pts` in the sorted presentation order (binary search); null if not found. */
export function frameIndexOfPts(sortedPts: readonly number[], pts: number): number | null {
  let lo = 0;
  let hi = sortedPts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sortedPts[mid]!;
    if (v === pts) return mid;
    if (v < pts) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function parseShowinfo(stderr: string): { pts: number; timeBase: Rational } {
  const tb = /config in time_base:\s*(\d+\/\d+)/.exec(stderr);
  const pts = /Parsed_showinfo[^\n]*?\bpts:\s*(-?\d+)/.exec(stderr);
  const timeBase = tb ? parseRatio(tb[1]) : null;
  if (!pts || !timeBase) throw new Error("could not read the decoded frame timestamp (showinfo)");
  return { pts: Number(pts[1]), timeBase };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The frame on screen at `seconds`: the last frame whose presentation time is <= seconds
 * (the first frame if `seconds` precedes it). Returns its pts in stream time-base ticks.
 */
export function framePtsAt(sortedPts: readonly number[], timeBase: Rational, seconds: Rational): number {
  if (sortedPts.length === 0) throw new Error("no packet timestamps");
  const limit = floor(div(seconds, timeBase)); // pts * tb <= seconds  <=>  pts <= floor(seconds / tb)
  let lo = 0;
  let hi = sortedPts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedPts[mid]! <= limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return sortedPts[found]!;
}

/** Decimal seek point rounded DOWN, so it never lands after the intended frame start. */
function seekString(seconds: Rational): string {
  const scale = rational(1_000_000);
  return toDecimalString(div(rational(floor(mul(seconds, scale))), scale), 6);
}

/**
 * Extract the frame displayed at `seconds` (source time) as a PNG of the given width.
 *
 * With packet timestamps (always available for manifest footage) the target frame is chosen
 * exactly — the frame on screen at `seconds` — and the decoded frame's pts is verified; a
 * mismatch throws instead of returning a neighbouring frame.
 */
export async function extractFrame(
  tools: MediaTools,
  entry: MediaEntry,
  seconds: Rational,
  outFile: string,
  width: number,
  sortedPts?: readonly number[],
): Promise<ExtractedFrame> {
  const video = requireFootage(entry);
  const streamTb = video.timeBase;
  const targetPts = sortedPts && sortedPts.length > 0 ? framePtsAt(sortedPts, streamTb, seconds) : null;
  const seekTo = targetPts === null ? seconds : mul(rational(targetPts), streamTb);
  const { stderr } = await runFfmpeg(tools, [
    "-hide_banner", "-nostdin", "-v", "info",
    "-copyts", "-ss", seekString(seekTo),
    "-i", entry.source.absolutePath,
    "-map", `0:${video.streamIndex}`, "-an", "-sn", "-dn",
    "-frames:v", "1",
    "-vf", `scale=iw*sar:ih,setsar=1,scale=${width}:-2:flags=lanczos,showinfo`,
    "-y", outFile,
  ]);
  const { pts, timeBase } = parseShowinfo(stderr);
  const frameSeconds = mul(rational(pts), timeBase);
  if (targetPts !== null && compare(frameSeconds, mul(rational(targetPts), streamTb)) !== 0) {
    throw new Error(
      `${entry.mediaId}: seek landed on ${toDecimalString(frameSeconds, 6)}s, expected frame at ` +
        `${toDecimalString(mul(rational(targetPts), streamTb), 6)}s`,
    );
  }
  return {
    requestedSeconds: seconds,
    frameSeconds,
    framePts: pts,
    timeBase,
    frameIndex: sortedPts ? frameIndexOfPts(sortedPts, pts) : null,
    file: outFile,
  };
}

export interface ContactSheetOptions {
  cols: number;
  rows: number;
  cellWidth: number;
  outDir: string;
  labelFont?: string | null;
}

export interface ContactSheetResult {
  mediaId: string;
  sheet: string;
  mapping: string;
  cells: Array<ExtractedFrame & { cell: number; row: number; col: number; label: string }>;
}

function cellLabel(cell: number, frameSeconds: Rational, frameIdx: number | null): string {
  const idx = frameIdx === null ? "" : `  f${frameIdx}`;
  return `#${String(cell).padStart(2, "0")}  ${toDecimalString(frameSeconds, 3)}s${idx}`;
}

/** Deterministic contact sheet: cols x rows evenly spaced frames with labels and a JSON map. */
export async function contactSheet(
  tools: MediaTools,
  entry: MediaEntry,
  options: ContactSheetOptions,
): Promise<ContactSheetResult> {
  const video = requireFootage(entry);
  const { cols, rows, cellWidth } = options;
  const { start, duration } = durationOf(entry);
  const dir = path.join(options.outDir, entry.mediaId);
  const stem = `contact-${cols}x${rows}-w${cellWidth}`;
  const work = path.join(dir, `${stem}.cells`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const sortedPts = (await probePacketPts(tools, entry.source.absolutePath, video.streamIndex)).sort((a, b) => a - b);
  const font = options.labelFont === undefined ? DEFAULT_LABEL_FONT : options.labelFont;
  const useLabels = font !== null && (await fileExists(font));

  const times = sampleTimes(start, duration, cols * rows);
  const cells: ContactSheetResult["cells"] = [];
  for (let i = 0; i < times.length; i++) {
    const raw = path.join(work, `raw_${String(i).padStart(3, "0")}.png`);
    const frame = await extractFrame(tools, entry, times[i]!, raw, cellWidth, sortedPts);
    const label = cellLabel(i, frame.frameSeconds, frame.frameIndex);
    const labeled = path.join(work, `cell_${String(i).padStart(3, "0")}.png`);
    if (useLabels) {
      await runFfmpeg(tools, [
        "-hide_banner", "-nostdin", "-v", "error", "-i", raw,
        "-vf",
        `drawtext=fontfile=${font}:text='${label.replace(/[:']/g, "")}':x=8:y=8:fontsize=max(11\\,min(h/16\\,w/17)):fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=5`,
        "-y", labeled,
      ]);
    } else {
      await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-i", raw, "-y", labeled]);
    }
    cells.push({ ...frame, file: labeled, cell: i, row: Math.floor(i / cols), col: i % cols, label });
  }

  const sheet = path.join(dir, `${stem}.png`);
  await runFfmpeg(tools, [
    "-hide_banner", "-nostdin", "-v", "error",
    "-framerate", "1", "-i", path.join(work, "cell_%03d.png"),
    "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x101010`,
    "-frames:v", "1", "-y", sheet,
  ]);

  const mapping = path.join(dir, `${stem}.json`);
  const mappingDoc = {
    mediaId: entry.mediaId,
    source: `${entry.source.rootId}/${entry.source.relativePath}`,
    streamIndex: video.streamIndex,
    sheet: path.basename(sheet),
    cols,
    rows,
    cellWidth,
    orientation: video.orientation,
    cells: cells.map(({ file: _file, ...rest }) => ({ ...rest, cellFile: path.basename(_file) })),
  };
  await writeFile(mapping, JSON.stringify(mappingDoc, null, 2) + "\n");
  return { mediaId: entry.mediaId, sheet, mapping, cells };
}

/** Representative thumbnail: the frame at the middle of the footage. */
export async function thumbnail(
  tools: MediaTools,
  entry: MediaEntry,
  outDir: string,
  width = 480,
): Promise<ExtractedFrame> {
  const video = requireFootage(entry);
  const { start, duration } = durationOf(entry);
  const dir = path.join(outDir, entry.mediaId);
  await mkdir(dir, { recursive: true });
  const sortedPts = (await probePacketPts(tools, entry.source.absolutePath, video.streamIndex)).sort((a, b) => a - b);
  const at = add(start, div(duration, rational(2)));
  return extractFrame(tools, entry, at, path.join(dir, `thumb-w${width}.png`), width, sortedPts);
}

