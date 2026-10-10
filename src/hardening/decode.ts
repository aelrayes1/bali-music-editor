/**
 * Phase 12: single-pass frame decoding. `select=between(n,a,b)` still decodes the whole file (the filter
 * only drops frames after decode), so reading a file in N chunks costs N full decodes; and growing one
 * Buffer with concat per pipe chunk is quadratic. This reads the wanted range once, stops the decoder at
 * the last wanted frame, and copies each frame exactly once.
 */

import { spawn } from "node:child_process";
import type { MediaTools } from "../media/ffmpeg.ts";
import { toolFailure } from "./errors.ts";

export interface DecodeOptions {
  from?: number;
  /** exclusive */
  to?: number;
  width: number;
  height: number;
  /** called per frame instead of collecting (bounded memory) */
  onFrame?: (frame: Uint8Array, n: number) => void;
}

export function decodeFrames(tools: MediaTools, file: string, o: DecodeOptions): Promise<Uint8Array[]> {
  const from = o.from ?? 0;
  const frameBytes = o.width * o.height * 3;
  const vf = `${from > 0 ? `trim=start_frame=${from},setpts=PTS-STARTPTS,` : ""}scale=${o.width}:${o.height}:flags=area,format=rgb24`;
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-vf", vf, "-fps_mode", "passthrough", ...(o.to !== undefined ? ["-frames:v", String(o.to - from)] : []), "-f", "rawvideo", "-"];
  return new Promise((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args);
    const out: Uint8Array[] = [];
    let cur = new Uint8Array(frameBytes);
    let fill = 0;
    let n = from;
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      let off = 0;
      while (off < d.length) {
        const k = Math.min(frameBytes - fill, d.length - off);
        cur.set(d.subarray(off, off + k), fill);
        fill += k;
        off += k;
        if (fill === frameBytes) {
          if (o.onFrame) o.onFrame(cur, n);
          else out.push(cur);
          n++;
          cur = new Uint8Array(frameBytes);
          fill = 0;
        }
      }
    });
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(toolFailure({ tool: "ffmpeg", operation: `decode frames ${from}-${o.to ?? "end"}`, file, exitCode: code, stderr }))));
  });
}
