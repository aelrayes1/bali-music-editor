/**
 * Extract sampled frames (display orientation, square pixels, longest side SAMPLE_MAX_SIDE) with one
 * decode per media, selecting by decoded frame index, and verify every frame's presentation time
 * against the packet timestamps. Frames are cached as JPEGs named by frame index.
 */

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { analysisSize } from "../footage/decode.ts";
import { type MediaTools, probePacketPts } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";

export const SAMPLE_MAX_SIDE = 768;

export async function extractSampleFrames(
  tools: MediaTools,
  entry: MediaEntry,
  frameIndices: number[],
  dir: string,
): Promise<{ files: Map<number, string>; w: number; h: number }> {
  const v = entry.video!;
  const { w, h } = analysisSize(v.displayWidth, v.displayHeight, SAMPLE_MAX_SIDE);
  await mkdir(dir, { recursive: true });
  const want = [...new Set(frameIndices)].sort((a, b) => a - b);
  const files = new Map(want.map((i) => [i, path.join(dir, `f${String(i).padStart(6, "0")}.jpg`)]));
  const missing: number[] = [];
  for (const i of want) {
    try {
      await stat(files.get(i)!);
    } catch {
      missing.push(i);
    }
  }
  if (!missing.length) return { files, w, h };
  const pts = (await probePacketPts(tools, entry.source.absolutePath, v.streamIndex)).sort((a, b) => a - b);
  // FFmpeg's expression parser limits nesting depth: sum the terms as a balanced tree (depth log2 n)
  const tree = (a: string[]): string => (a.length === 1 ? a[0]! : `(${tree(a.slice(0, a.length >> 1))}+${tree(a.slice(a.length >> 1))})`);
  for (let c = 0; c < missing.length; c += 2000) {
    const chunk = missing.slice(c, c + 2000);
    const expr = tree(chunk.map((i) => `eq(n,${i})`));
    const tmpPattern = path.join(dir, `.tmp-${process.pid}-${c}-%06d.jpg`);
    let stderr = "";
    const code = await new Promise<number>((resolve, reject) => {
      const p = spawn(tools.ffmpeg, [
        "-hide_banner", "-nostdin", "-v", "info",
        "-i", entry.source.absolutePath,
        "-map", `0:${v.streamIndex}`, "-an", "-sn", "-dn",
        "-vf", `select='${expr}',scale=iw*sar:ih,setsar=1,scale=${w}:${h}:flags=lanczos,showinfo`,
        "-fps_mode", "passthrough", "-q:v", "3", "-start_number", "0", "-y", tmpPattern,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      p.on("error", reject);
      p.on("close", (x) => resolve(x ?? -1));
    });
    if (code !== 0) throw new Error(`frame extraction failed (${code}): ${stderr.slice(-300)}`);
    const got = [...stderr.matchAll(/showinfo.*?\bn:\s*(\d+)\s+pts:\s*(-?\d+)/g)].map((m) => Number(m[2]));
    if (got.length !== chunk.length) throw new Error(`${entry.mediaId}: expected ${chunk.length} frames, got ${got.length}`);
    const { rename } = await import("node:fs/promises");
    for (let k = 0; k < chunk.length; k++) {
      if (got[k] !== pts[chunk[k]!]) throw new Error(`${entry.mediaId}: frame ${chunk[k]} pts ${got[k]} != expected ${pts[chunk[k]!]}`);
      await rename(tmpPattern.replace("%06d", String(k).padStart(6, "0")), files.get(chunk[k]!)!);
    }
  }
  return { files, w, h };
}
