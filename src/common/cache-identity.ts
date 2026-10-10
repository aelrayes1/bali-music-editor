/**
 * Cache identity helpers.
 *
 * An analysis cache entry is valid only for the same input content, the same configuration, the
 * same declared analyzer version AND the same implementation. The implementation fingerprint is
 * a SHA-256 over an explicit list of the analyzer's own source files (not the whole repository),
 * computed once per process, so an incompatible code change can never silently reuse a stale
 * result even if nobody bumped the version string.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const memo = new Map<string, string>();

/** SHA-256 (16 hex) over the given module files, in the given order. */
export function implementationFingerprint(files: readonly URL[]): string {
  const key = files.map((f) => f.href).join("\n");
  let v = memo.get(key);
  if (!v) {
    const h = createHash("sha256");
    for (const f of files) {
      h.update(fileURLToPath(f).split("/src/").pop()!); // path relative to src/, stable across checkouts
      h.update("\0");
      h.update(readFileSync(f));
      h.update("\0");
    }
    v = h.digest("hex").slice(0, 16);
    memo.set(key, v);
  }
  return v;
}

export interface CacheIdentity {
  /** Content fingerprint of the input media. */
  input: string;
  analyzer: string;
  analyzerVersion: string;
  implementation: string;
  configHash: string;
  /** External tools whose output feeds the analysis (e.g. the FFmpeg decoder version). */
  tools: Record<string, string>;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(id: CacheIdentity): string {
  return createHash("sha256").update(canonical(id)).digest("hex").slice(0, 20);
}
