/**
 * Adapter over the verified system FFmpeg / ffprobe (MacPorts on this machine).
 *
 * FFmpeg policy (DEVELOPMENT_PLAN.md §3): non-Remotion media work uses the verified system
 * FFmpeg. `ffmpeg-skill` is the agent-facing tool for ad-hoc work; deterministic library code
 * calls the same binaries through this one module so versions are pinned and recorded.
 *
 * Every call uses an argument array (never a shell) and read-only access to sources.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MediaTools {
  readonly ffprobe: string;
  readonly ffmpeg: string;
  readonly ffprobeVersion: string;
}

const DEFAULT_FFPROBE = "/opt/local/bin/ffprobe";
const DEFAULT_FFMPEG = "/opt/local/bin/ffmpeg";

export async function resolveMediaTools(env: NodeJS.ProcessEnv = process.env): Promise<MediaTools> {
  const ffprobe = env.BALI_FFPROBE ?? DEFAULT_FFPROBE;
  const ffmpeg = env.BALI_FFMPEG ?? DEFAULT_FFMPEG;
  for (const bin of [ffprobe, ffmpeg]) {
    try {
      await access(bin, constants.X_OK);
    } catch {
      throw new Error(`media tool not executable: ${bin} (set BALI_FFPROBE / BALI_FFMPEG)`);
    }
  }
  const { stdout } = await execFileAsync(ffprobe, ["-version"]);
  const m = /ffprobe version (\S+)/.exec(stdout);
  return { ffprobe, ffmpeg, ffprobeVersion: m?.[1] ?? "unknown" };
}

export type FfprobeJson = {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
  error?: { code?: number; string?: string };
};

export type ProbeResult =
  | { readonly ok: true; readonly json: FfprobeJson }
  | { readonly ok: false; readonly message: string };

export async function probeFile(tools: MediaTools, file: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      tools.ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_error", "--", file],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const json = JSON.parse(stdout) as FfprobeJson;
    if (json.error) return { ok: false, message: json.error.string ?? `ffprobe error ${json.error.code}` };
    if (!json.format) return { ok: false, message: "ffprobe returned no format section" };
    return { ok: true, json };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    try {
      const json = JSON.parse(e.stdout ?? "") as FfprobeJson;
      if (json.error?.string) return { ok: false, message: json.error.string };
    } catch {
      /* fall through */
    }
    return { ok: false, message: (e.stderr || e.message).trim().split("\n").slice(-3).join(" | ") };
  }
}

/** Presentation timestamps (stream time-base ticks) of every packet in one stream. */
export async function probePacketPts(tools: MediaTools, file: string, streamIndex: number): Promise<number[]> {
  const { stdout } = await execFileAsync(
    tools.ffprobe,
    ["-v", "error", "-select_streams", String(streamIndex), "-show_entries", "packet=pts", "-of", "csv=p=0", "--", file],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const out: number[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim().replace(/,$/, "");
    if (t === "" || t === "N/A") continue;
    const n = Number(t);
    if (Number.isSafeInteger(n)) out.push(n);
  }
  return out;
}

export interface DecodeCheckResult {
  readonly ok: boolean;
  readonly messages: string[];
}

/**
 * Sampled decode check: decode the first and last ~2 s of one stream to the null muxer.
 * Catches truncated/corrupt files cheaply without a full decode of long sources.
 */
export async function sampledDecodeCheck(
  tools: MediaTools,
  file: string,
  streamIndex: number,
): Promise<DecodeCheckResult> {
  const runs: string[][] = [
    ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", `0:${streamIndex}`, "-t", "2", "-f", "null", "-"],
    ["-hide_banner", "-nostdin", "-v", "error", "-sseof", "-2", "-i", file, "-map", `0:${streamIndex}`, "-f", "null", "-"],
  ];
  const messages: string[] = [];
  let ok = true;
  for (const args of runs) {
    try {
      const { stderr } = await execFileAsync(tools.ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
      for (const line of stderr.split("\n")) if (line.trim()) messages.push(line.trim());
    } catch (err) {
      ok = false;
      const e = err as { stderr?: string; message: string };
      messages.push(((e.stderr || e.message) ?? "").trim().split("\n").slice(-2).join(" | "));
    }
  }
  return { ok, messages: [...new Set(messages)].slice(0, 20) };
}

export async function runFfmpeg(tools: MediaTools, args: string[]): Promise<{ stderr: string }> {
  const { stderr } = await execFileAsync(tools.ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
  return { stderr };
}
