/**
 * Phase 12: crash-safe writes. Authoritative JSON is written to a unique temp file, fsynced, then renamed
 * over the target (rename is atomic on one filesystem), so an interruption leaves either the old file or
 * the new one, never a torn file. Media outputs follow the same rule through `.partial` names: a render is
 * only visible under its final name once it is complete, so a partial output can never be reused.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const TEMP_MARK = ".tmp-";
export const PARTIAL_SUFFIX = ".partial";

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // some filesystems do not allow fsync on a directory; the rename is still atomic
  }
}

/** Write bytes atomically: unique temp in the same directory, fsync, rename; the temp is removed on failure. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}${TEMP_MARK}${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    fsyncDir(dir);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const writeJsonAtomic = (file: string, data: unknown) => writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

/** Temp files left by an interrupted atomic write (older than `minAgeMs`), for a cleanup report. */
export function staleTemps(dir: string, minAgeMs = 60_000, now = Date.now()): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.includes(TEMP_MARK) || n.endsWith(PARTIAL_SUFFIX)).map((n) => path.join(dir, n)).filter((f) => now - statSync(f).mtimeMs >= minAgeMs);
}

/** The temp name a media step writes to; `commitPartial` makes it visible only after the step succeeded. */
export const partialPath = (file: string) => `${file}${PARTIAL_SUFFIX}`;
export function commitPartial(file: string): void {
  renameSync(partialPath(file), file);
  fsyncDir(path.dirname(file));
}
