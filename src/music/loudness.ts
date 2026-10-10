/**
 * EBU R128 loudness curve via the verified system FFmpeg (`ebur128` filter).
 *
 * The filter reports every 100 ms. Curve point k is taken to be at exactly (k + 1) / 10 s
 * (end of the 100 ms block); ffmpeg's printed float time is not used as a timestamp.
 */

import { spawn } from "node:child_process";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";

export interface LoudnessCurve {
  momentaryLufs: number[];
  shortTermLufs: number[];
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
}

export async function measureLoudness(tools: MediaTools, entry: MediaEntry): Promise<LoudnessCurve> {
  const idx = entry.audio!.streamIndex;
  const args = [
    "-hide_banner", "-nostdin", "-nostats", "-v", "info",
    "-i", entry.source.absolutePath,
    "-map", `0:${idx}`, "-vn", "-sn", "-dn",
    "-af", "ebur128=framelog=info:peak=true", "-f", "null", "-",
  ];
  let stderr = "";
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new Error(`ebur128 failed (${code}): ${stderr.slice(-300)}`);

  const momentary: number[] = [];
  const shortTerm: number[] = [];
  const lineRe = /\bt:\s*[\d.]+\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/;
  for (const line of stderr.split("\n")) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const v = (s: string) => (s === "-inf" ? -120 : Math.max(-120, Math.round(Number(s) * 10) / 10));
    momentary.push(v(m[1]!));
    shortTerm.push(v(m[2]!));
  }
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : null;
  };
  return {
    momentaryLufs: momentary,
    shortTermLufs: shortTerm,
    integratedLufs: num(/I:\s*(-?[\d.]+) LUFS/),
    loudnessRangeLu: num(/LRA:\s*(-?[\d.]+) LU/),
    truePeakDbtp: num(/Peak:\s*(-?[\d.]+) dBFS/),
  };
}
