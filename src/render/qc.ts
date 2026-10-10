/**
 * Render QC (Phase 5, MacPorts FFmpeg + structured checks). Verifies a rendered output against
 * the render spec and its conformed intermediates, never against taste:
 *  - container/stream facts (size, fps, frame count, duration, orientation, audio present);
 *  - full decode without errors;
 *  - every output frame matches its expected intermediate frame better than its neighbours and
 *    the adjacent clips (right clip, right frame, cut on the planned frame, no transition
 *    contamination, no wrong crop), no unexpected black or frozen frames;
 *  - audio equals the conformed song window at lag 0 at start / drop / end (no offset, no drift),
 *    no fades, and does not contain the Payoff source audio.
 * Known archival watermarks are ACKNOWLEDGED_SOURCE_ARTIFACT / NO_ACTION_REQUIRED and never fail.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaTools } from "../media/ffmpeg.ts";

const execFileAsync = promisify(execFile);
export const QC_SIZE = { w: 108, h: 192 }; // 1/10 scale RGB frames for matching

export interface Check {
  id: string;
  passed: boolean;
  severity: "error" | "warning" | "info";
  evidence: string;
}

function collect(bin: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
  });
}

export async function probe(tools: MediaTools, file: string) {
  const { stdout } = await execFileAsync(tools.ffprobe, ["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", "--", file], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as { streams: Array<Record<string, unknown> & { codec_type: string; side_data_list?: Array<Record<string, unknown>> }>; format: Record<string, unknown> };
}

/** md5 of every decoded video frame, in order (framemd5). */
export async function frameHashes(tools: MediaTools, file: string): Promise<string[]> {
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
  if (r.code !== 0) throw new Error(`framemd5 failed: ${r.stderr.slice(-200)}`);
  return r.stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1)!.trim());
}

export async function decodeErrors(tools: MediaTools, file: string): Promise<string[]> {
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-f", "null", "-"]);
  return r.stderr.split("\n").map((l) => l.trim()).filter(Boolean).concat(r.code === 0 ? [] : [`exit ${r.code}`]);
}

/**
 * All video frames as small RGB images (bounded memory: 62 KB per frame), converted
 * format-consistently: YUV inputs explicitly as BT.709 TV range, RGB inputs unchanged. (Implicit
 * conversions treat 8/10-bit YUV and RGB differently and invent level shifts.)
 */
export async function qcFrames(tools: MediaTools, file: string): Promise<Uint8Array[]> {
  const pr = await probe(tools, file);
  const pix = String(pr.streams.find((s) => s.codec_type === "video")?.pix_fmt ?? "");
  const rgbIn = /^(rgb|bgr|gbr|argb|rgba)/.test(pix);
  const vf = rgbIn ? `scale=${QC_SIZE.w}:${QC_SIZE.h}:flags=area+accurate_rnd,format=rgb24` : `scale=${QC_SIZE.w}:${QC_SIZE.h}:flags=area+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24`;
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  if (r.code !== 0) throw new Error(`frame decode failed: ${r.stderr.slice(-200)}`);
  const n = QC_SIZE.w * QC_SIZE.h * 3;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + n <= r.stdout.length; o += n) frames.push(new Uint8Array(r.stdout.subarray(o, o + n)));
  return frames;
}

export async function audioMono(tools: MediaTools, file: string, rate = 48000, streamSpec = "0:a:0"): Promise<Float32Array> {
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", streamSpec, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"]);
  if (r.code !== 0) throw new Error(`audio decode failed: ${r.stderr.slice(-200)}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
}

export const mse = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s / a.length;
};
export const psnr = (m: number) => (m <= 1e-9 ? 99 : Math.round(10 * Math.log10((255 * 255) / m) * 10) / 10);
export async function assertPlayable(tools: MediaTools, file: string, frames: number): Promise<void> {
  const { stdout } = await execFileAsync(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=start_time,nb_read_frames", "-of", "json", file]);
  const st = (JSON.parse(stdout) as { streams: Array<{ start_time?: string; nb_read_frames?: string }> }).streams[0];
  if (!st || Number(st.start_time) !== 0) throw new Error(`${file}: video starts at ${st?.start_time} s, not 0 (re-conform with timestamps reset)`);
  if (Number(st.nb_read_frames) !== frames) throw new Error(`${file}: ${st.nb_read_frames} frames, expected ${frames}`);
}
