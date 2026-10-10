/**
 * Local whisper.cpp runner (Phase 2.5, optional).
 *
 *  - local files only (model/binary paths that look like URLs are refused)
 *  - always executed under macOS `sandbox-exec` with all network access denied
 *  - deterministic decoding: no temperature fallback (-nf), no cross-window context (-mc 0)
 *  - bar-aligned overlapping windows from the Phase 2 beat grid
 *  - raw output cached by content fingerprint + range + model hash + engine + configuration
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";
import { canonicalJson } from "../music/analyze.ts";
import type { MusicAnalysis } from "../music/schema.ts";
import { type Rational, add, compare, rational, toDecimalString } from "../time/rational.ts";
import type { AsrWindow } from "./schema.ts";

export const WHISPER_PINNED_VERSION = "v1.9.4";
export const WHISPER_PINNED_COMMIT = "927cfce34f31707e17f2bff35c349632fb9e2c3a";
export const ASR_SAMPLE_RATE = 16000;
const SANDBOX = "/usr/bin/sandbox-exec";
const NO_NETWORK_PROFILE = "(version 1)(allow default)(deny network*)";

export class WhisperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperUnavailableError";
  }
}

export interface WhisperEngine {
  binary: string;
  model: string;
  modelName: string;
  modelSizeBytes: number;
  modelSha256: string;
  version: string;
  commit: string;
  sandbox: string;
}

export interface WindowingConfig {
  windowBars: number;
  stepBars: number;
}

export const DECODE_ARGS = ["-l", "en", "-t", "4", "-mc", "0", "-ml", "1", "-sow", "-nf", "-ojf", "-np"] as const;

const looksLikeUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);

export async function resolveWhisper(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Promise<WhisperEngine> {
  const binary = env.BALI_WHISPER_CLI ?? path.join(root, "tools/whisper.cpp/build/bin/whisper-cli");
  const model = env.BALI_WHISPER_MODEL ?? path.join(root, "tools/whisper.cpp/models/ggml-base.en.bin");
  for (const p of [binary, model]) {
    if (looksLikeUrl(p)) throw new WhisperUnavailableError(`remote path refused (local-only): ${p}`);
  }
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new WhisperUnavailableError(`whisper-cli not found or not executable: ${binary}`);
  }
  try {
    await access(model, constants.R_OK);
  } catch {
    throw new WhisperUnavailableError(`whisper model not found: ${model}`);
  }
  try {
    await access(SANDBOX, constants.X_OK);
  } catch {
    throw new WhisperUnavailableError("sandbox-exec is unavailable; refusing to run ASR without a network sandbox");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(model)) hash.update(chunk as Buffer);
  const version = await new Promise<string>((resolve) => {
    let out = "";
    const p = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr.on("data", (c: Buffer) => (out += c.toString()));
    p.on("close", () => resolve(/version:\s*(\S+)/.exec(out)?.[1] ?? "unknown"));
    p.on("error", () => resolve("unknown"));
  });
  let commit = "unknown";
  try {
    const head = (await readFile(path.join(path.dirname(binary), "../../.git/HEAD"), "utf8")).trim();
    commit = head.startsWith("ref:")
      ? (await readFile(path.join(path.dirname(binary), "../../.git", head.slice(5)), "utf8")).trim()
      : head;
  } catch {
    /* not a git checkout */
  }
  return {
    binary,
    model,
    modelName: path.basename(model).replace(/^ggml-|\.bin$/g, ""),
    modelSizeBytes: (await stat(model)).size,
    modelSha256: hash.digest("hex"),
    version,
    commit,
    sandbox: SANDBOX,
  };
}

/**
 * Bar-aligned overlapping windows: each starts on a Phase 2 downbeat inside [start, end) and spans
 * `windowBars` bars (clipped to the range). Window starts snap to the nearest 16 kHz sample, and
 * that exact sample time (not the bar time) is the window's time origin.
 */
export function planWindows(analysis: MusicAnalysis, start: Rational, end: Rational, cfg: WindowingConfig): AsrWindow[] {
  const bars = analysis.bars;
  const out: AsrWindow[] = [];
  const inRange = bars.flatMap((b, j) => (compare(b.time, start) >= 0 && compare(b.time, end) < 0 ? [j] : []));
  for (let k = 0; k < inRange.length; k += cfg.stepBars) {
    const j = inRange[k]!;
    const bar = bars[j]!;
    const endBar = bars[j + cfg.windowBars];
    const rawEnd = endBar ? endBar.time : analysis.durationSeconds;
    const we = compare(rawEnd, end) > 0 ? end : rawEnd;
    const a = Math.round((bar.time.num * ASR_SAMPLE_RATE) / bar.time.den);
    const b = Math.round((we.num * ASR_SAMPLE_RATE) / we.den);
    if (b - a < ASR_SAMPLE_RATE) continue; // shorter than 1 s: too little context for ASR
    out.push({
      id: `win:${String(out.length).padStart(2, "0")}`,
      start: rational(a, ASR_SAMPLE_RATE),
      end: rational(b, ASR_SAMPLE_RATE),
      startSample16k: a,
      endSample16k: b,
      anchoredToBarId: bar.id,
    });
  }
  return out;
}

async function decode16k(tools: MediaTools, entry: MediaEntry): Promise<Int16Array> {
  if (entry.status !== "OK" || !entry.audio) throw new Error(`${entry.mediaId}: no decodable audio (status ${entry.status})`);
  const args = [
    "-hide_banner", "-nostdin", "-v", "error", "-i", entry.source.absolutePath,
    "-map", `0:${entry.audio!.streamIndex}`, "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(ASR_SAMPLE_RATE), "-f", "s16le", "-",
  ];
  const chunks: Buffer[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new Error(`ffmpeg 16 kHz decode failed (${code})`);
  const buf = Buffer.concat(chunks);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.byteLength & ~1)));
}

function wav(pcm: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(ASR_SAMPLE_RATE, 24);
  h.writeUInt32LE(ASR_SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export interface RawWord {
  windowId: string;
  rawText: string;
  start: Rational;
  end: Rational;
  tokens: Array<{ text: string; p: number }>;
}

export interface RawTranscript {
  cacheKey: string;
  engineArgs: string[];
  windows: AsrWindow[];
  words: RawWord[];
}

/** Parse one whisper.cpp `-ojf` document (word-level segments) into absolute-time words. */
export function parseWhisperJson(doc: unknown, window: AsrWindow): RawWord[] {
  const d = doc as { transcription?: Array<{ text?: unknown; offsets?: { from?: unknown; to?: unknown }; tokens?: Array<{ text?: unknown; p?: unknown }> }> };
  if (!d || !Array.isArray(d.transcription)) throw new Error(`${window.id}: malformed whisper JSON (no transcription array)`);
  const words: RawWord[] = [];
  for (const s of d.transcription) {
    const text = typeof s.text === "string" ? s.text : "";
    const from = Number(s.offsets?.from);
    const to = Number(s.offsets?.to);
    if (!text.trim()) continue;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw new Error(`${window.id}: malformed offsets for "${text}"`);
    }
    const tokens = (s.tokens ?? [])
      .filter((t) => typeof t.text === "string" && !(t.text as string).startsWith("[_"))
      .map((t) => ({ text: t.text as string, p: Math.round(Math.max(0, Math.min(1, Number(t.p) || 0)) * 10000) / 10000 }));
    words.push({
      windowId: window.id,
      rawText: text,
      start: add(window.start, rational(from, 1000)),
      end: add(window.start, rational(to, 1000)),
      tokens,
    });
  }
  return words;
}

/**
 * ASR cache identity: audio fingerprint + range + exact window samples + windowing config + model
 * hash + engine version/commit + decode args + Phase 2 analyzer version/config hash.
 */
export function asrCacheKey(
  fingerprint: string,
  range: { start: Rational; end: Rational },
  windows: AsrWindow[],
  cfg: WindowingConfig,
  engine: Pick<WhisperEngine, "modelSha256" | "version" | "commit">,
  analysis: Pick<MusicAnalysis, "analyzer">,
): string {
  const parts = {
    fingerprint,
    range: [range.start, range.end],
    windows: windows.map((w) => [w.startSample16k, w.endSample16k]),
    cfg: { windowBars: cfg.windowBars, stepBars: cfg.stepBars },
    model: engine.modelSha256,
    engine: [engine.version, engine.commit],
    args: DECODE_ARGS,
    phase2: [analysis.analyzer.version, analysis.analyzer.configHash],
  };
  return createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 20);
}

export async function runWhisper(
  tools: MediaTools,
  engine: WhisperEngine,
  entry: MediaEntry,
  analysis: MusicAnalysis,
  range: { start: Rational; end: Rational },
  cfg: WindowingConfig,
  cacheDir: string | null,
): Promise<{ raw: RawTranscript; cacheHit: boolean }> {
  const windows = planWindows(analysis, range.start, range.end, cfg);
  const key = asrCacheKey(entry.contentFingerprint.value, range, windows, cfg, engine, analysis);
  const cacheFile = cacheDir ? path.join(cacheDir, `asr-${key}.json`) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8")) as RawTranscript;
      if (cached.cacheKey === key) return { raw: cached, cacheHit: true };
    } catch {
      /* miss */
    }
  }
  const pcm = await decode16k(tools, entry);
  const work = path.join(cacheDir ?? path.join(process.cwd(), "cache/vocal"), `work-${key}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const files: string[] = [];
  for (const w of windows) {
    const f = path.join(work, `${w.id.replace(":", "_")}.wav`);
    await writeFile(f, wav(pcm.slice(w.startSample16k, w.endSample16k)));
    files.push(f);
  }
  const args = ["-p", NO_NETWORK_PROFILE, engine.binary, "-m", engine.model, ...files.flatMap((f) => ["-f", f]), ...DECODE_ARGS];
  let stderr = "";
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(engine.sandbox, args, { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) {
    await rm(work, { recursive: true, force: true });
    throw new Error(`whisper-cli failed (${code}): ${stderr.slice(-400)}`);
  }
  const words: RawWord[] = [];
  for (let i = 0; i < windows.length; i++) {
    words.push(...parseWhisperJson(JSON.parse(await readFile(`${files[i]}.json`, "utf8")), windows[i]!));
  }
  await rm(work, { recursive: true, force: true });
  const raw: RawTranscript = { cacheKey: key, engineArgs: [...DECODE_ARGS], windows, words };
  if (cacheFile) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(raw) + "\n");
  }
  return { raw, cacheHit: false };
}

export function describeWindow(w: AsrWindow): string {
  return `${w.id} ${toDecimalString(w.start, 3)}-${toDecimalString(w.end, 3)}s`;
}
