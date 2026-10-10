/**
 * Stream decoded frames as small full-range 8-bit luma images in display orientation (FFmpeg
 * applies rotation; pixel aspect is squared), with exact presentation timestamps from showinfo.
 * Frames are handed to the callback and never written to disk.
 */

import { spawn } from "node:child_process";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";
import { type Rational, rational } from "../time/rational.ts";

export interface DecodedStream {
  w: number;
  h: number;
  pts: number[];
  lastDuration: number;
  timeBase: Rational;
}

export function analysisSize(displayW: number, displayH: number, maxSide: number): { w: number; h: number } {
  const k = maxSide / Math.max(displayW, displayH);
  const even = (v: number) => Math.max(2, 2 * Math.round((v * k) / 2));
  return { w: even(displayW), h: even(displayH) };
}

export type FrameSampling = "all" | "keyframes" | "fps2";

export async function streamGrayFrames(
  tools: MediaTools,
  entry: MediaEntry,
  maxSide: number,
  onFrame: (px: Uint8Array) => void,
  sampling: FrameSampling = "all",
): Promise<DecodedStream> {
  const v = entry.video;
  if (!entry.isPlayableVideoFootage || !v) throw new Error(`${entry.mediaId} is not playable video footage`);
  const { w, h } = analysisSize(v.displayWidth, v.displayHeight, maxSide);
  const args = [
    "-hide_banner", "-nostdin", "-v", "info",
    ...(sampling === "keyframes" ? ["-skip_frame", "nokey"] : []),
    "-i", entry.source.absolutePath,
    "-map", `0:${v.streamIndex}`, "-an", "-sn", "-dn",
    "-vf", `${sampling === "fps2" ? "fps=2," : ""}scale=iw*sar:ih,setsar=1,scale=${w}:${h}:flags=area:out_range=full,format=gray,showinfo`,
    "-fps_mode", "passthrough",
    "-f", "rawvideo", "pipe:1",
  ];
  const size = w * h;
  const pts: number[] = [];
  let lastDuration = 0;
  let timeBase: Rational | null = null;
  let pending: Buffer = Buffer.alloc(0);
  let lineBuf = "";
  let tail = "";
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (c: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, c]) : c;
      let off = 0;
      while (pending.length - off >= size) {
        onFrame(new Uint8Array(pending.buffer, pending.byteOffset + off, size).slice());
        off += size;
      }
      pending = pending.subarray(off);
    });
    p.stderr.on("data", (c: Buffer) => {
      lineBuf += c.toString();
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.includes("showinfo")) {
          tail = (tail + line + "\n").slice(-2000);
          continue;
        }
        const tbm = /config in time_base: (\d+)\/(\d+)/.exec(line);
        if (tbm) timeBase = rational(Number(tbm[1]), Number(tbm[2]));
        const fm = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line);
        if (fm) {
          if (Number(fm[1]) !== pts.length) throw new Error(`showinfo frame ${fm[1]} out of order`);
          pts.push(Number(fm[2]));
          const dm = /\bduration:\s*(\d+)/.exec(line);
          if (dm) lastDuration = Number(dm[1]);
        }
      }
    });
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new Error(`ffmpeg decode failed (${code}): ${tail.slice(-400)}`);
  if (pending.length) throw new Error(`${pending.length} trailing bytes (partial frame)`);
  if (!timeBase) throw new Error("no time base reported by showinfo");
  if (!lastDuration && pts.length > 1) lastDuration = Math.round((pts.at(-1)! - pts[0]!) / (pts.length - 1));
  return { w, h, pts, lastDuration, timeBase };
}
