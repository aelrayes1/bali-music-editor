/**
 * Phase 12: frame-accurate timestamp integrity. Frame n of an approved CFR delivery must be presented at
 * exactly n / fps (in the container's own time base) and last exactly 1 / fps. A correct total duration
 * does NOT prove this: an earlier master once came out of a concat join with frames 290-449 half a
 * frame early and frame 289 half a frame long, while the frame count was right. This check looks at every
 * frame, so that bug class cannot recur silently.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaTools } from "../media/ffmpeg.ts";
import { type Issue } from "./errors.ts";

const execFileAsync = promisify(execFile);

export interface Ratio {
  num: number;
  den: number;
}
export interface PacketTiming {
  /** presentation timestamp in time-base ticks */
  pts: number;
  /** duration in time-base ticks (null when the container does not store one) */
  duration: number | null;
}
export interface FrameTimingReport {
  frames: number;
  ticksPerFrame: number;
  /** frames whose pts is not n / fps */
  shifted: Array<{ frame: number; pts: number; expected: number; offsetFrames: number }>;
  /** frames whose duration is not 1 / fps */
  irregularDuration: Array<{ frame: number; duration: number; expected: number }>;
  totalSeconds: number;
  ok: boolean;
  issues: Issue[];
}

/**
 * Check every frame. Ticks per frame = tb.den * fps.den / (tb.num * fps.num); when that is an integer
 * (e.g. 1/15360 or 1/30 at 30 fps) the comparison is exact, otherwise within half a tick (rounding).
 */
export function checkFrameTiming(packets: PacketTiming[], timeBase: Ratio, fps: Ratio, opts: { expectedFrames?: number; file?: string } = {}): FrameTimingReport {
  const sorted = [...packets].sort((a, b) => a.pts - b.pts);
  const tpf = (timeBase.den * fps.den) / (timeBase.num * fps.num);
  const tol = Number.isInteger(tpf) ? 0 : 0.5;
  const start = sorted[0]?.pts ?? 0;
  const shifted: FrameTimingReport["shifted"] = [];
  const irregular: FrameTimingReport["irregularDuration"] = [];
  sorted.forEach((p, n) => {
    const expected = start + n * tpf;
    if (Math.abs(p.pts - expected) > tol) shifted.push({ frame: n, pts: p.pts, expected, offsetFrames: Math.round(((p.pts - expected) / tpf) * 1000) / 1000 });
    if (p.duration !== null && Math.abs(p.duration - tpf) > Math.max(tol, 1)) irregular.push({ frame: n, duration: p.duration, expected: tpf });
  });
  const issues: Issue[] = [];
  if (start !== 0) issues.push({ code: "TIMING_START_OFFSET", severity: "ERROR", what: "the first frame is not at time 0", file: opts.file, frame: 0, expected: 0, actual: start, next: "re-mux with timestamps starting at 0" });
  if (shifted.length) issues.push({ code: "TIMING_FRAME_SHIFT", severity: "BLOCKING", what: `${shifted.length} frame(s) are not presented at n / fps (first at frame ${shifted[0]!.frame}, ${shifted[0]!.offsetFrames} frame)`, file: opts.file, frame: shifted[0]!.frame, expected: shifted[0]!.expected, actual: shifted[0]!.pts, next: "rewrite timestamps to n / fps on stream copy (setts) or re-join on exact frame boundaries; never trust the total duration alone" });
  if (irregular.length) issues.push({ code: "TIMING_FRAME_DURATION", severity: "BLOCKING", what: `${irregular.length} frame(s) do not last exactly 1 / fps (first at frame ${irregular[0]!.frame})`, file: opts.file, frame: irregular[0]!.frame, expected: irregular[0]!.expected, actual: irregular[0]!.duration, next: "re-time the stream (constant frame duration)" });
  if (opts.expectedFrames !== undefined && sorted.length !== opts.expectedFrames) issues.push({ code: "TIMING_FRAME_COUNT", severity: "BLOCKING", what: "wrong frame count", file: opts.file, expected: opts.expectedFrames, actual: sorted.length, next: "find the dropped / duplicated frames (render QC) before delivering" });
  const last = sorted.at(-1);
  const totalSeconds = last ? ((last.pts - start + (last.duration ?? tpf)) * timeBase.num) / timeBase.den : 0;
  return { frames: sorted.length, ticksPerFrame: tpf, shifted, irregularDuration: irregular, totalSeconds, ok: issues.length === 0, issues };
}

/** Read every video packet's pts / duration and the stream time base with ffprobe. */
export async function probeFrameTiming(tools: MediaTools, file: string): Promise<{ timeBase: Ratio; packets: PacketTiming[] }> {
  const { stdout } = await execFileAsync(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base:packet=pts,duration", "-of", "json", file], { maxBuffer: 64 << 20 });
  const j = JSON.parse(stdout) as { streams: Array<{ time_base: string }>; packets?: Array<{ pts?: number; duration?: number }> };
  const [num, den] = j.streams[0]!.time_base.split("/").map(Number) as [number, number];
  return { timeBase: { num, den }, packets: (j.packets ?? []).map((p) => ({ pts: Number(p.pts), duration: p.duration === undefined ? null : Number(p.duration) })) };
}

export async function verifyFrameTiming(tools: MediaTools, file: string, fps: Ratio, expectedFrames?: number): Promise<FrameTimingReport> {
  const { timeBase, packets } = await probeFrameTiming(tools, file);
  return checkFrameTiming(packets, timeBase, fps, { expectedFrames, file });
}
