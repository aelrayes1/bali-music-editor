/**
 * Phase 12: resource safety. One policy for every media-producing step (the Phase 11.x CLIs each carried
 * their own copy of a 30 GB check). The floor is a HARD stop for media work; the warning threshold is
 * advisory. Nothing here ever deletes anything: cleanup stays a classified, human-approved action.
 *
 * Policy file: config/resource-policy.json (versioned). Disk is read through an injectable `statfs` so the
 * behaviour is testable without filling the disk.
 */

import { existsSync, readFileSync, statfsSync } from "node:fs";
import { BaliError } from "./errors.ts";

export interface ResourcePolicy {
  /** below this (GiB) media work is refused */
  mediaFloorGiB: number;
  /** below this (GiB) a warning is reported */
  warnGiB: number;
  /** caches above this (GiB) are reported for a cleanup classification (never auto-deleted) */
  cacheReportGiB: number;
}

export const DEFAULT_POLICY: ResourcePolicy = { mediaFloorGiB: 30, warnGiB: 32, cacheReportGiB: 5 };
export const POLICY_FILE = "config/resource-policy.json";

export function loadPolicy(file = POLICY_FILE): ResourcePolicy {
  if (!existsSync(file)) return DEFAULT_POLICY;
  const p = { ...DEFAULT_POLICY, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<ResourcePolicy>) };
  if (!(p.mediaFloorGiB > 0 && p.warnGiB >= p.mediaFloorGiB)) throw new BaliError({ code: "RESOURCE_POLICY_INVALID", what: "resource policy must have mediaFloorGiB > 0 and warnGiB >= mediaFloorGiB", file, actual: p, next: "fix config/resource-policy.json" });
  return p;
}

export type StatFs = (path: string) => { bavail: number; bsize: number };
const GiB = 2 ** 30;
export const freeGiB = (path = ".", statfs: StatFs = statfsSync as unknown as StatFs) => {
  const s = statfs(path);
  return (Number(s.bavail) * Number(s.bsize)) / GiB;
};

export interface Preflight {
  status: "OK" | "WARN" | "BLOCK";
  freeGiB: number;
  /** free space after the planned write */
  afterGiB: number;
  message: string;
}

/**
 * Decide whether a step may run. `kind: "metadata"` (JSON, tests, docs) is never blocked by the floor;
 * `kind: "media"` is blocked when the free space after the planned write would fall below the floor.
 */
export function preflight(kind: "media" | "metadata", estimatedBytes: number, opts: { path?: string; policy?: ResourcePolicy; statfs?: StatFs } = {}): Preflight {
  const policy = opts.policy ?? loadPolicy();
  const free = freeGiB(opts.path ?? ".", opts.statfs);
  const after = free - estimatedBytes / GiB;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  if (kind === "media" && after < policy.mediaFloorGiB) return { status: "BLOCK", freeGiB: r2(free), afterGiB: r2(after), message: `media work would leave ${r2(after)} GiB free, below the ${policy.mediaFloorGiB} GiB floor` };
  if (after < policy.warnGiB) return { status: "WARN", freeGiB: r2(free), afterGiB: r2(after), message: `${r2(after)} GiB free after this step (warning below ${policy.warnGiB} GiB)` };
  return { status: "OK", freeGiB: r2(free), afterGiB: r2(after), message: `${r2(after)} GiB free after this step` };
}

/** Throw a BaliError before media work would cross the floor (the guard every media CLI calls). */
export function assertMediaHeadroom(step: string, estimatedBytes: number, opts: { path?: string; policy?: ResourcePolicy; statfs?: StatFs } = {}): Preflight {
  const p = preflight("media", estimatedBytes, opts);
  if (p.status === "BLOCK") throw new BaliError({ code: "DISK_FLOOR", what: `${step} refused: ${p.message}`, expected: `>= ${(opts.policy ?? loadPolicy()).mediaFloorGiB} GiB after the step`, actual: `${p.afterGiB} GiB`, next: "free disk (classified cleanup, never approved artifacts) or raise the floor deliberately in config/resource-policy.json, then re-run" });
  return p;
}
