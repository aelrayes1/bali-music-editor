/**
 * Phase 6B pipeline (Node side effects: FFmpeg, the local Vision tool, cache files). Pure decisions
 * live in mask.ts / select.ts / composite.ts / stutter.ts / qc.ts; this module only moves pixels.
 *
 *   computeMasks   conformed clip range -> per-frame Vision instance + segmentation masks (cached)
 *   prepareSubject masks -> primary subject selection, subject mattes, smoothing, conflict checks
 *   renderInsert   resolved effect + mattes -> "insert" clip (lossless RGB PNG-in-MOV) covering the
 *                  effect window; FxClip plays it in place of the clean frames for that window
 *
 * Everything runs on this machine (Apple Vision, MacPorts FFmpeg). No footage leaves the device.
 *
 * Mask cache identity: decoded-content fingerprint of the exact frame range, the range, the tool
 * (binary sha256 + source sha256 + Vision request names + macOS build), the parameters and the code
 * identity of this module. Any change produces a new key; nothing is ever silently reused.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MediaTools } from "../../media/ffmpeg.ts";
import { decodePng } from "../../media/png.ts";
import { assertPlayable } from "../../render/qc.ts";
import { type Rect, type Rgb, compositeFrame, estimateShift, lumaSmall, seamMismatch, shiftRgb } from "./composite.ts";
import { type Mask, binarize, close, dilate, fillHoles, shift, temporalSmooth, union } from "./mask.ts";
import { type ConflictCheck, type FrameMasks, type Point, type Selection, type SubjectFrame, type SubjectHints, checkConflict, linkTracks, selectSubject, subjectMattes } from "./select.ts";
import { type ResolvedSubjectStutter, subjectFrameAt } from "./stutter.ts";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export { assertPlayable };
export const ROOT = path.resolve(HERE, "../../..");
export const SUBJECT_TOOL = path.join(ROOT, "tools/subject-masks/subject-masks");
export const SUBJECT_TOOL_SOURCE = path.join(ROOT, "native/subject-masks/main.swift");
export const MASK_PARAMS = { downscale: 4, segmentation: true, requests: ["VNGeneratePersonInstanceMaskRequest", "VNGeneratePersonSegmentationRequest(accurate)", "VNDetectFaceRectanglesRequest"], computeDevice: "cpu" } as const;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function collect(bin: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout!.on("data", (d: Buffer) => out.push(d));
    p.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
    if (input) p.stdin!.end(input);
  });
}

export async function toolIdentity(): Promise<{ binarySha256: string; sourceSha256: string; macosBuild: string; requests: readonly string[] }> {
  if (!existsSync(SUBJECT_TOOL)) throw new Error(`subject mask tool missing: run \`npm run build:subject-masks\` (${SUBJECT_TOOL})`);
  const { stdout } = await execFileAsync("/usr/bin/sw_vers", ["-buildVersion"]);
  return { binarySha256: sha(await readFile(SUBJECT_TOOL)), sourceSha256: sha(await readFile(SUBJECT_TOOL_SOURCE)), macosBuild: stdout.trim(), requests: MASK_PARAMS.requests };
}

/** sha256 over the Phase 6B source modules (code identity for caches and reports). */
export async function codeIdentity(): Promise<string> {
  const files = ["mask.ts", "select.ts", "composite.ts", "stutter.ts", "qc.ts", "pipeline.ts"].map((f) => path.join(HERE, f)).concat(path.join(ROOT, "src/media/png.ts"));
  const h = createHash("sha256");
  for (const f of files) h.update(f.slice(ROOT.length)).update(await readFile(f));
  return h.digest("hex");
}

/** Decode frames [from, to) of a lossless RGB clip into full-resolution RGB buffers. */
export async function readFrames(tools: MediaTools, file: string, from: number, to: number, w: number, h: number): Promise<Rgb[]> {
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-vf", `select=between(n\\,${from}\\,${to - 1}),format=rgb24`, "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
  if (r.code !== 0) throw new Error(`decode ${file} failed: ${r.stderr.slice(-300)}`);
  const n = w * h * 3;
  const out: Rgb[] = [];
  for (let o = 0; o + n <= r.stdout.length; o += n) out.push({ w, h, data: new Uint8Array(r.stdout.subarray(o, o + n)) });
  if (out.length !== to - from) throw new Error(`decode ${file}: expected ${to - from} frames, got ${out.length}`);
  return out;
}

/** Content fingerprint of frames [from, to): md5 over per-frame md5s of the decoded pictures. */
export async function rangeFingerprint(tools: MediaTools, file: string, from: number, to: number): Promise<string> {
  const r = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-vf", `select=between(n\\,${from}\\,${to - 1})`, "-fps_mode", "passthrough", "-f", "framemd5", "-"]);
  if (r.code !== 0) throw new Error(`framemd5 failed: ${r.stderr.slice(-300)}`);
  const hs = r.stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1)!.trim());
  if (hs.length !== to - from) throw new Error(`fingerprint: expected ${to - from} frames, got ${hs.length}`);
  return createHash("md5").update(hs.join("\n")).digest("hex");
}

export interface MaskIdentity {
  kind: "PHASE_6B_SUBJECT_MASKS";
  source: { fingerprint: string; range: [number, number] | number[]; size: [number, number] | number[] };
  tool: { binarySha256: string; sourceSha256: string; macosBuild: string; requests: readonly string[] };
  params: { downscale: number; segmentation: boolean; computeDevice: string };
  code: string;
}

/** Cache key over every identity component (pure: any change -> a different key). */
export function maskCacheKey(identity: MaskIdentity): string {
  return sha(JSON.stringify(identity)).slice(0, 20);
}

export interface MaskSet {
  key: string;
  dir: string;
  identity: MaskIdentity;
  frames: FrameMasks[];
  cached: boolean;
  seconds: number | null;
  msPerFrame: number | null;
  toolPeakRssMb: number | null;
  bytes: number;
}

async function dirBytes(d: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(d, { withFileTypes: true })) n += e.isDirectory() ? await dirBytes(path.join(d, e.name)) : (await stat(path.join(d, e.name))).size;
  return n;
}

/**
 * Person masks for clip-local frames [from, to) of a conformed clip (1080x1920 RGB). Cached under
 * cacheRoot/<key>; a completed entry is reused only when every identity component matches.
 */
export async function computeMasks(tools: MediaTools, args: { clipFile: string; from: number; to: number; width: number; height: number; cacheRoot: string }): Promise<MaskSet> {
  const identity: MaskIdentity = {
    kind: "PHASE_6B_SUBJECT_MASKS",
    source: { fingerprint: await rangeFingerprint(tools, args.clipFile, args.from, args.to), range: [args.from, args.to], size: [args.width, args.height] },
    tool: await toolIdentity(),
    params: { downscale: MASK_PARAMS.downscale, segmentation: MASK_PARAMS.segmentation, computeDevice: MASK_PARAMS.computeDevice },
    code: sha(await readFile(fileURLToPath(import.meta.url))),
  };
  const key = maskCacheKey(identity);
  const dir = path.join(args.cacheRoot, key);
  let cached = true;
  let seconds: number | null = null;
  let toolPeakRssMb: number | null = null;
  if (!existsSync(path.join(dir, "complete.json"))) {
    cached = false;
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, "frames"), { recursive: true });
    const rgb = await collect(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", args.clipFile, "-map", "0:v:0", "-vf", `select=between(n\\,${args.from}\\,${args.to - 1}),format=rgb24`, "-fps_mode", "passthrough", "-start_number", String(args.from), "-c:v", "png", path.join(dir, "frames", "f%05d.png")]);
    if (rgb.code !== 0) throw new Error(`frame export failed: ${rgb.stderr.slice(-300)}`);
    const job = { outDir: path.join(dir, "masks"), downscale: MASK_PARAMS.downscale, segmentation: MASK_PARAMS.segmentation, frames: Array.from({ length: args.to - args.from }, (_, i) => ({ id: `f${String(args.from + i).padStart(5, "0")}`, path: path.join(dir, "frames", `f${String(args.from + i).padStart(5, "0")}.png`) })) };
    const t0 = performance.now();
    // /usr/bin/time -l reports the tool's peak resident memory (bytes) on stderr
    const r = await collect("/usr/bin/time", ["-l", SUBJECT_TOOL], Buffer.from(JSON.stringify(job)));
    seconds = Math.round(performance.now() - t0) / 1000;
    if (r.code !== 0) throw new Error(`subject-masks failed: ${r.stderr.slice(-400)}`);
    const rss = /(\d+)\s+maximum resident set size/.exec(r.stderr);
    toolPeakRssMb = rss ? Math.round(Number(rss[1]) / 1048576) : null;
    await writeFile(path.join(dir, "results.jsonl"), r.stdout);
    await rm(path.join(dir, "frames"), { recursive: true, force: true });
    await writeFile(path.join(dir, "identity.json"), JSON.stringify(identity, null, 2) + "\n");
    await writeFile(path.join(dir, "complete.json"), JSON.stringify({ seconds, frames: args.to - args.from, msPerFrame: Math.round((seconds * 1000) / (args.to - args.from)), toolPeakRssMb }) + "\n");
  } else ({ seconds, toolPeakRssMb } = JSON.parse(await readFile(path.join(dir, "complete.json"), "utf8")));
  const rows = (await readFile(path.join(dir, "results.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { id: string; error?: string; instances: Array<{ index: number; file: string }>; faces: FrameMasks["faces"]; segmentation: string | null });
  const load = async (f: string): Promise<Mask> => {
    const i = decodePng(await readFile(path.join(dir, "masks", f)));
    if (i.channels !== 1) throw new Error(`mask ${f}: expected gray`);
    return { w: i.w, h: i.h, data: i.data };
  };
  const frames: FrameMasks[] = [];
  for (const [i, r] of rows.entries()) {
    if (r.error) throw new Error(`subject-masks ${r.id}: ${r.error}`);
    frames.push({ j: args.from + i, instances: await Promise.all(r.instances.map(async (x) => ({ index: x.index, mask: await load(x.file) }))), faces: r.faces, seg: r.segmentation ? await load(r.segmentation) : null });
  }
  return { key, dir, identity, frames, cached, seconds, msPerFrame: seconds === null ? null : Math.round((seconds * 1000) / (args.to - args.from)), toolPeakRssMb, bytes: await dirBytes(dir) };
}

export interface PreparedSubject {
  selection: Selection;
  /** by clip-local frame */
  subjectFrames: Map<number, SubjectFrame>;
  smoothed: Map<number, Mask>;
  /** binary region mattes used by the compositor (smoothing may add, never remove, raw matte) */
  regions: Map<number, Mask>;
  conflicts: ConflictCheck[];
  seconds: number;
}

/** Selection + mattes + bounded smoothing + conflict checks against framing references. */
export function prepareSubject(frames: FrameMasks[], hints: SubjectHints, smoothing: number, references: Array<{ reference: string; points: Point[] }> = []): PreparedSubject {
  const t0 = performance.now();
  const tracks = linkTracks(frames);
  const selection = selectSubject(frames, tracks, hints);
  const subjectFrames = new Map<number, SubjectFrame>();
  const smoothed = new Map<number, Mask>();
  const regions = new Map<number, Mask>();
  const conflicts: ConflictCheck[] = [];
  if (selection.trackId) {
    const mat = subjectMattes(frames, tracks, selection.trackId);
    const sm = temporalSmooth(mat.map((m) => m.matte), smoothing);
    mat.forEach((m, i) => {
      subjectFrames.set(m.j, m);
      smoothed.set(m.j, sm[i]!);
      regions.set(m.j, fillHoles(close(union(binarize(sm[i]!), binarize(m.matte)), 2)).mask);
    });
    for (const r of references) conflicts.push(checkConflict(frames, tracks, selection.trackId, r.reference, r.points));
  }
  return { selection, subjectFrames, smoothed, regions, conflicts, seconds: Math.round(performance.now() - t0) / 1000 };
}

export interface InsertFrame {
  f: number;
  p: number;
  bg: number;
  shift: { dx: number; dy: number; gain: number };
  seam: { mean: number; p95: number; pixels: number } | null;
  /** pixels of a shifted patch withheld to keep frame-locked graphics in place (review flag) */
  protectedPixels: number;
  exactClean: boolean;
}

export interface InsertResult {
  file: string;
  frames: InsertFrame[];
  seconds: number;
  msPerFrame: number;
  bytes: number;
}

/**
 * Build the insert for one resolved effect: frames [start, end) of the clip with the subject
 * repeated per subjectFrameAt and the background per backgroundMode. `onFrame` receives every
 * composed frame (review artifacts: mask visualisation, edge close-ups).
 */
export async function renderInsert(tools: MediaTools, args: { clipFile: string; width: number; height: number; fx: ResolvedSubjectStutter; subject: PreparedSubject; outFile: string; maxShiftPx?: number; protect?: readonly Rect[]; onFrame?: (x: { f: number; p: number; bg: number; out: Rgb; region: Mask; clean: Rgb; patch: Rgb }) => void | Promise<void> }): Promise<InsertResult> {
  const { fx, subject } = args;
  const t0 = performance.now();
  const ds = MASK_PARAMS.downscale;
  const plan = Array.from({ length: fx.end - fx.start }, (_, i) => fx.start + i).map((f) => ({ f, p: subjectFrameAt(fx, f)!, bg: fx.backgroundMode === "BACKGROUND_HOLD" ? fx.start : f }));
  const lo = Math.min(...plan.map((x) => Math.min(x.p, x.bg)));
  const frames = await readFrames(tools, args.clipFile, lo, fx.end, args.width, args.height);
  const F = (j: number) => frames[j - lo]!;
  const R = (j: number) => {
    const m = subject.regions.get(j);
    if (!m) throw new Error(`no subject matte for frame ${j}`);
    return m;
  };
  await mkdir(path.dirname(args.outFile), { recursive: true });
  const enc = spawn(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${args.width}x${args.height}`, "-r", "30", "-i", "-", "-c:v", "png", "-pix_fmt", "rgb24", "-y", args.outFile], { stdio: ["pipe", "ignore", "pipe"] });
  let encErr = "";
  enc.stderr!.on("data", (d: Buffer) => (encErr += d.toString()));
  const done = new Promise<number>((resolve) => enc.on("close", (c) => resolve(c ?? -1)));
  const write = (b: Uint8Array) => new Promise<void>((resolve, reject) => enc.stdin!.write(b, (e) => (e ? reject(e) : resolve())));
  const out: InsertFrame[] = [];
  for (const { f, p, bg } of plan) {
    if (p === f && bg === f) {
      await write(F(f).data);
      out.push({ f, p, bg, shift: { dx: 0, dy: 0, gain: 0 }, seam: null, protectedPixels: 0, exactClean: true });
      await args.onFrame?.({ f, p, bg, out: F(f), region: { w: R(f).w, h: R(f).h, data: new Uint8Array(R(f).data.length) }, clean: F(f), patch: F(p) });
      continue;
    }
    let sh = { dx: 0, dy: 0, gain: 0 };
    if (fx.backgroundMode === "BACKGROUND_SMOOTH_CONTINUE" && p !== bg) {
      const ex = dilate(union(R(bg), R(p)), Math.round(fx.marginPx / ds));
      sh = estimateShift(lumaSmall(F(bg), ds), lumaSmall(F(p), ds), ex, args.maxShiftPx ?? 64, ds, { f: F(bg), p: F(p) });
    }
    const { out: o, region, protectedPixels } = compositeFrame({ base: F(bg), patch: F(p), bBase: R(bg), bPatch: R(p), marginPx: fx.marginPx, featherPx: fx.featherPx, mix: fx.mix, shift: sh, protect: args.protect });
    const seam = seamMismatch(lumaSmall(F(bg), ds), lumaSmall(shiftRgb(F(p), sh.dx, sh.dy), ds), region, union(R(bg), sh.dx || sh.dy ? shift(R(p), Math.round(sh.dx / ds), Math.round(sh.dy / ds)) : R(p)));
    await write(o.data);
    out.push({ f, p, bg, shift: sh, seam, protectedPixels, exactClean: false });
    await args.onFrame?.({ f, p, bg, out: o, region, clean: F(f), patch: F(p) });
  }
  enc.stdin!.end();
  const code = await done;
  if (code !== 0) throw new Error(`insert encode failed: ${encErr.slice(-300)}`);
  await assertPlayable(tools, args.outFile, plan.length);
  const seconds = Math.round(performance.now() - t0) / 1000;
  return { file: args.outFile, frames: out, seconds, msPerFrame: Math.round((seconds * 1000) / plan.length), bytes: (await stat(args.outFile)).size };
}

/**
 * Largest background translation between neighbouring frames in [from, to) (px/frame, full
 * resolution): the camera-motion measure the eligibility policy uses to validate a background mode.
 * Robust to the subject and other movers (trimmed-mean cost); 0 when the camera is locked.
 */
export async function measureCameraMotion(tools: MediaTools, args: { clipFile: string; from: number; to: number; width: number; height: number }): Promise<{ maxPx: number; perFrame: Array<{ f: number; dx: number; dy: number }> }> {
  const ds = MASK_PARAMS.downscale;
  const frames = await readFrames(tools, args.clipFile, args.from, args.to, args.width, args.height);
  const luma = frames.map((f) => lumaSmall(f, ds));
  const none: Mask = { w: luma[0]!.w, h: luma[0]!.h, data: new Uint8Array(luma[0]!.data.length) };
  const perFrame: Array<{ f: number; dx: number; dy: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const s = estimateShift(luma[i]!, luma[i - 1]!, none, 32, ds, { f: frames[i]!, p: frames[i - 1]! });
    perFrame.push({ f: args.from + i, dx: s.dx, dy: s.dy });
  }
  return { maxPx: Math.max(0, ...perFrame.map((x) => Math.hypot(x.dx, x.dy))), perFrame };
}
