/**
 * Content-based, location-independent media identity.
 *
 * mediaId = "m_" + first 16 hex chars of the sampled fingerprint. The fingerprint hashes the
 * file size plus three 1 MiB samples (start, middle, end), so the same file keeps its ID when
 * it is renamed or moved to another source root (e.g. an external SSD). It is fast on large
 * camera files. A full SHA-256 can be added on request for archival verification.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

export const FINGERPRINT_ALGORITHM = "sha256-sampled-v1" as const;
const SAMPLE_BYTES = 1024 * 1024;

export async function sampledFingerprint(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha256");
    hash.update(FINGERPRINT_ALGORITHM);
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64BE(BigInt(size));
    hash.update(sizeBuf);
    const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_BYTES / 2), Math.max(0, size - SAMPLE_BYTES)];
    for (const offset of offsets) {
      const length = Math.min(SAMPLE_BYTES, size - offset);
      const buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, offset);
      hash.update(buf);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function mediaIdFromFingerprint(fingerprint: string): string {
  return `m_${fingerprint.slice(0, 16)}`;
}

/** Deterministic ID for the 2nd+ file with identical content (ordered by root/relative path). */
export function duplicateMediaId(baseId: string, rootId: string, relativePath: string): string {
  const suffix = createHash("sha256").update(`${rootId}\u0000${relativePath}`).digest("hex").slice(0, 8);
  return `${baseId}-dup-${suffix}`;
}

export async function fullSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
