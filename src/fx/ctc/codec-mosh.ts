/**
 * REAL datamosh (codec level, not simulated): the frames are encoded as an MPEG-4 Part 2 elementary
 * stream with one I-frame and P-frames only (no B-frames, no scene-cut I-frames), the stream is split
 * at its VOP start codes (00 00 01 B6), selected P-VOPs are DUPLICATED (the "bloom": the decoder
 * re-applies the same motion vectors and residual to an image that has already moved, so pixels are
 * dragged and smeared along the motion), and the edited stream is decoded again. Deterministic for a
 * given ffmpeg build and input.
 */

import { execFileSync } from "node:child_process";
import type { Rgb } from "./pixels.ts";

export interface BloomResult {
  frames: Rgb[];
  vopTypes: string;
  sequence: number[];
}

/**
 * frames[0] is the reference (coded as the I-frame, not returned); every later frame i is coded as a
 * P-VOP and appears dup[i - 1] times (0 = dropped) in the edited stream. Returns the first `count`
 * decoded frames after the reference.
 */
export function pframeBloom(ffmpeg: string, frames: Rgb[], dup: number[], count: number, q = 18): BloomResult {
  const { w, h } = frames[0]!;
  const raw = Buffer.concat(frames.map((f) => f.data));
  const m4v = execFileSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", "30", "-i", "-", "-c:v", "mpeg4", "-q:v", String(q), "-bf", "0", "-g", "10000", "-sc_threshold", "1000000000", "-f", "m4v", "-"], { input: raw, maxBuffer: 1 << 29 });
  const starts: number[] = [];
  for (let i = 0; i + 3 < m4v.length; i++) if (m4v[i] === 0 && m4v[i + 1] === 0 && m4v[i + 2] === 1 && m4v[i + 3] === 0xb6) starts.push(i);
  if (starts.length !== frames.length) throw new Error(`codec mosh: ${starts.length} VOPs for ${frames.length} frames`);
  const header = m4v.subarray(0, starts[0]);
  const vops = starts.map((s, i) => m4v.subarray(s, starts[i + 1] ?? m4v.length));
  const vopTypes = vops.map((v) => ["I", "P", "B", "S"][v[4]! >> 6]).join("");
  if (!/^IP*$/.test(vopTypes)) throw new Error(`codec mosh: unexpected VOP types ${vopTypes}`);
  const sequence = [0];
  for (let i = 1; i < vops.length; i++) for (let r = 0; r < (dup[i - 1] ?? 1); r++) sequence.push(i);
  const out = execFileSync(ffmpeg, ["-v", "error", "-f", "m4v", "-i", "-", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { input: Buffer.concat([header, ...sequence.map((i) => vops[i]!)]), maxBuffer: 1 << 29 });
  const n = out.length / (w * h * 3);
  if (n < count + 1) throw new Error(`codec mosh: decoded ${n} frames, need ${count + 1}`);
  return { frames: Array.from({ length: count }, (_, i) => ({ w, h, data: new Uint8Array(out.subarray((i + 1) * w * h * 3, (i + 2) * w * h * 3)) })), vopTypes, sequence };
}
