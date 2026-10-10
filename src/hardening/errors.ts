/**
 * Phase 12: application-layer diagnostics. Every failure the Bali editor reports should say WHAT failed,
 * WHERE (file / clip / frame), EXPECTED vs ACTUAL, and the SAFE NEXT ACTION, instead of a bare `False` or
 * "render failed". `BaliError` carries those fields; `Issue` is the same shape for validators that collect
 * several problems before failing.
 */

export type Severity = "BLOCKING" | "ERROR" | "WARNING";

export interface Issue {
  /** stable machine code, e.g. TIMELINE_GAP, SOURCE_RANGE_OUTSIDE_MEDIA */
  code: string;
  severity: Severity;
  what: string;
  file?: string;
  clipId?: string;
  frame?: number;
  expected?: unknown;
  actual?: unknown;
  /** the safe next action */
  next: string;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function formatIssue(i: Issue): string {
  const where = [i.file && `file ${i.file}`, i.clipId && `clip ${i.clipId}`, i.frame !== undefined && `frame ${i.frame}`].filter(Boolean).join(", ");
  const ea = i.expected !== undefined || i.actual !== undefined ? ` (expected ${show(i.expected)}, actual ${show(i.actual)})` : "";
  return `[${i.severity}] ${i.code}: ${i.what}${where ? ` — ${where}` : ""}${ea}. Next: ${i.next}`;
}

export class BaliError extends Error {
  readonly issue: Issue;
  constructor(issue: Omit<Issue, "severity"> & { severity?: Severity }) {
    const full: Issue = { severity: "BLOCKING", ...issue };
    super(formatIssue(full));
    this.name = "BaliError";
    this.issue = full;
  }
  get code(): string {
    return this.issue.code;
  }
}

/** Throw one BaliError summarising a list of blocking / error issues (warnings never throw). */
export function assertNoErrors(issues: Issue[], context: string): void {
  const bad = issues.filter((i) => i.severity !== "WARNING");
  if (!bad.length) return;
  const first = bad[0]!;
  throw new BaliError({ ...first, what: `${context}: ${bad.length} problem(s); first: ${first.what}`, next: first.next });
}

/**
 * Wrap a low-level tool failure (FFmpeg / ffprobe exit code, a Resolve API `False`) with context: the
 * operation, the file, the tail of the tool's own diagnostic, and what to do next.
 */
export function toolFailure(op: { tool: string; operation: string; file?: string; exitCode?: number | null; stderr?: string; next?: string }): BaliError {
  const tail = (op.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
  return new BaliError({
    code: `${op.tool.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_FAILED`,
    what: `${op.tool} ${op.operation} failed${op.exitCode !== undefined && op.exitCode !== null ? ` (exit ${op.exitCode})` : ""}${tail ? `: ${tail}` : ""}`,
    file: op.file,
    next: op.next ?? "check the input file and the tool's message above; nothing was marked complete",
  });
}

/** A Resolve scripting call that returned `False` / `None` without a reason. */
export function resolveFalse(api: string, target: string, knownCause?: string): BaliError {
  return new BaliError({
    code: "RESOLVE_API_FALSE",
    what: `Resolve ${api} returned False on ${target}${knownCause ? ` (known cause: ${knownCause})` : ""}`,
    next: "read it back with the matching probe_* action; check the page (Color-only calls), playback (stop it), and resolve_control api_truth for this symbol",
  });
}
