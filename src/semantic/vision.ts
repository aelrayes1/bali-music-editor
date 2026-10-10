/**
 * Runs the local Apple-Vision tool (native/vision-shots, built into gitignored tools/) on sampled
 * frames. Results are cached per media by tool binary hash + macOS build + frame content hashes +
 * crops, so cached semantic inputs are exactly reproducible. No network; no downloaded models.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), conf: z.number() }).strict();
export const VisionResultSchema = z
  .object({
    id: z.string(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    error: z.string().optional(),
    humans: z.array(Box).default([]),
    faces: z.array(Box.extend({ yaw: z.number().nullable(), roll: z.number().nullable(), pitch: z.number().nullable() }).strict()).default([]),
    bodies: z.array(z.object({ conf: z.number(), joints: z.record(z.string(), z.array(z.number())) }).strict()).default([]),
    labels: z.array(z.object({ id: z.string(), conf: z.number() }).strict()).default([]),
    saliency: z.array(Box).default([]),
    text: z.array(Box).default([]),
    featurePrint: z.string().optional(),
    featurePrintCount: z.number().int().optional(),
  })
  .strict();
export type VisionResult = z.infer<typeof VisionResultSchema>;

export interface VisionTool {
  binary: string;
  binarySha256: string;
  osBuild: string;
  framework: string;
}

export class VisionUnavailableError extends Error {}

export async function resolveVisionTool(root = process.cwd()): Promise<VisionTool> {
  const binary = path.join(root, "tools/vision-shots/vision-shots");
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new VisionUnavailableError(`vision tool not built: run npm run build:vision (${binary})`);
  }
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  const { stdout } = await promisify(execFile)("/usr/bin/sw_vers", ["-buildVersion"]);
  return { binary, binarySha256, osBuild: stdout.trim(), framework: "Apple Vision (on-device, CPU compute devices)" };
}

export interface VisionItem {
  id: string;
  path: string;
  crop: { x: number; y: number; w: number; h: number } | null;
}

export async function runVision(tool: VisionTool, items: VisionItem[], cacheFile: string | null): Promise<{ results: Map<string, VisionResult>; cacheHit: boolean; key: string }> {
  const h = createHash("sha256").update(tool.binarySha256).update(tool.osBuild);
  for (const it of items) {
    h.update(it.id).update(JSON.stringify(it.crop));
    h.update(createHash("sha256").update(await readFile(it.path)).digest("hex"));
  }
  const key = h.digest("hex").slice(0, 20);
  const file = cacheFile ? cacheFile.replace(/\.json$/, `-${key}.json`) : null;
  if (file) {
    try {
      const doc = JSON.parse(await readFile(file, "utf8")) as { key: string; results: unknown[] };
      if (doc.key === key) return { results: new Map(doc.results.map((r) => VisionResultSchema.parse(r)).map((r) => [r.id, r])), cacheHit: true, key };
    } catch {
      /* miss */
    }
  }
  const job = JSON.stringify({ images: items.map((i) => ({ id: i.id, path: i.path, ...(i.crop ? { crop: i.crop } : {}) })) });
  let out = "";
  let err = "";
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(tool.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
    p.stdin.end(job);
  });
  if (code !== 0) throw new Error(`vision tool failed (${code}): ${err.slice(-300)}`);
  const results = out.trim().split("\n").filter(Boolean).map((l) => VisionResultSchema.parse(JSON.parse(l)));
  if (results.length !== items.length) throw new Error(`vision tool returned ${results.length} results for ${items.length} images`);
  if (file) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ key, tool, results }) + "\n");
    await rename(`${file}.tmp`, file);
  }
  return { results: new Map(results.map((r) => [r.id, r])), cacheHit: false, key };
}

/** Decode a base64 float32 feature print. */
export function featureVector(b64: string | undefined): Float32Array | null {
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
