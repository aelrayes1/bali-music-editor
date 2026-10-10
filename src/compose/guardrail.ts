/**
 * PRIMARY_HUMAN_COMPOSITION_GUARDRAIL (Phase 6A, pure and deterministic).
 *
 * Phase 5 showed that "subject visible inside the crop" is not enough: a crop can contain the
 * person and still push them against an edge. For vertical short-form edits the default target for
 * ONE dominant human is near-centre framing (safe band 35-65 %, ideal ~50 %), unless motion (lead
 * room), multiple subjects, source composition, creative intent or a human override justifies
 * otherwise. This module:
 *   1. identifies the primary subject with a fixed precedence
 *        HUMAN_REFRAME_OVERRIDE > explicit project subject > reliably tracked dominant face >
 *        semantic primary-subject estimate > safe source composition
 *      (never "highest detector confidence");
 *   2. measures the executed crop against that subject (post-render composition QC);
 *   3. proposes a bounded correction (static if the subject barely moves, otherwise a smoothed,
 *      dead-banded, rate-limited "camera operator" path) as a PROPOSED HUMAN_REFRAME_OVERRIDE.
 * It never changes shots, source/timeline ranges, cuts or audio, and never overrides a human crop.
 */

import { type FaceSample, type SubjectTrack, trackSubject } from "../render/crop-options.ts";
import type { Rational } from "../time/rational.ts";

export const GUARDRAIL_VERSION = "1.0.0";
export const COMPOSITION = {
  safeBand: [0.35, 0.65] as const,
  targetBand: [0.4, 0.6] as const,
  maxFractionOutsideSafe: 0.3,
  /** a face this much larger (area) than the next is "clearly dominant" */
  dominanceAreaRatio: 1.6,
  /** faces smaller than this fraction of the frame height are not reliable primary subjects */
  minFaceHeightFraction: 0.06,
  /** a subject may turn away for a while: the track keeps gaps (never switches person) */
  minTrackCoverage: 0.35,
  /** a static crop is preferred when it keeps the subject "comfortably framed" this often */
  staticMinInsideSafe: 0.9,
  staticComfortBand: [0.32, 0.68] as const,
  /** camera-operator dead zone (fraction of crop width) and smoothing windows (frames) */
  deadZone: 0.06,
  smoothWindow: 9,
  pathSmoothWindow: 15,
  maxStepPx: 16,
  maxAccelPx: 6,
  jumpyStepPx: 24,
  jumpyAccelPx: 8,
  leadRoomBand: { left_to_right: [0.25, 0.55], right_to_left: [0.45, 0.75] } as const,
};

export type SubjectSource = "HUMAN_REFRAME_OVERRIDE" | "PROJECT_SUBJECT" | "TRACKED_PRIMARY" | "SEMANTIC_ESTIMATE" | "NONE";
export type CompositionState = "OK" | "REFRAME_REVIEW_RECOMMENDED" | "PRIMARY_SUBJECT_UNCERTAIN" | "HUMAN_OVERRIDE" | "INTENTIONAL_OFF_CENTRE" | "NO_PRIMARY_HUMAN" | "NOT_APPLICABLE";

export interface ClipGeometry {
  clipId: string;
  frames: number;
  /** source time (s) of each output frame */
  sourceTimes: number[];
  sourceTimesRational: Rational[];
  cropW: number;
  frameH: number;
  activeX: number;
  activeW: number;
  cropX: number[];
  nativeVertical: boolean;
  override: { id: string; option: string | null } | null;
}

export interface Hints {
  /** explicit project subject (e.g. a reviewer's seed or confirmed identity position) */
  projectSubject?: { j: number; x: number; y: number; note: string } | null;
  /** Phase 3B estimate: single-subject centre path in source display px */
  semantic?: { presence: string; centerPath: Array<{ t: number; x: number }>; screenDirection: string; motionLabels: string[] } | null;
  /** explicit creative brief allowing off-centre composition for this clip */
  intentionalOffCentre?: string | null;
}

export interface Proposal {
  label: string;
  mode: "static" | "tracked";
  centerX: number | null;
  path: Array<{ sourceTime: Rational; centerX: number }> | null;
  cropX: number[];
  positions: { start: number; mid: number; end: number; outsideSafe: number };
  movement: { travelPx: number; maxStepPx: number; maxAccelPx: number };
  reason: string;
}

export interface Assessment {
  clipId: string;
  state: CompositionState;
  subject: { source: SubjectSource; reason: string; track: Array<{ j: number; cx: number; w: number }> };
  metrics: { start: number; mid: number; end: number; fractionOutsideSafe: number; minEdgeMargin: number; clipped: boolean; cropTravelPx: number; maxStepPx: number; maxAccelPx: number } | null;
  flags: string[];
  exception: string | null;
  proposals: Proposal[];
}

// ---------------------------------------------------------------------------------------------

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const area = (f: { w: number; h: number }) => f.w * f.h;

/** Symmetric (zero-phase) moving average with edge clamping. */
export function smooth(xs: number[], window: number): number[] {
  const h = Math.floor(window / 2);
  return xs.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = -h; k <= h; k++) {
      s += xs[Math.min(xs.length - 1, Math.max(0, i + k))]!;
      n++;
    }
    return s / n;
  });
}

/** Dead-banded follower, run forward and backward and averaged (no lag, no chasing small moves). */
export function deadband(xs: number[], dz: number): number[] {
  const run = (a: number[]) => {
    const c = [a[0]!];
    for (let i = 1; i < a.length; i++) {
      const d = a[i]! - c[i - 1]!;
      c.push(Math.abs(d) > dz ? c[i - 1]! + d - Math.sign(d) * dz : c[i - 1]!);
    }
    return c;
  };
  const f = run(xs);
  const b = run([...xs].reverse()).reverse();
  return f.map((v, i) => (v + b[i]!) / 2);
}

export function movement(x: number[]): { travelPx: number; maxStepPx: number; maxAccelPx: number } {
  const v = x.slice(1).map((q, k) => q - x[k]!);
  const a = v.slice(1).map((q, k) => q - v[k]!);
  return { travelPx: Math.round(v.reduce((s, q) => s + Math.abs(q), 0)), maxStepPx: Math.round(Math.max(0, ...v.map(Math.abs)) * 10) / 10, maxAccelPx: Math.round(Math.max(0, ...a.map(Math.abs)) * 10) / 10 };
}

/** Identify the primary subject following the precedence (never by detector confidence). */
export function identifySubject(g: ClipGeometry, samples: FaceSample[], hints: Hints): { source: SubjectSource; reason: string; track: SubjectTrack | null; semanticPath: Array<{ t: number; x: number }> | null; uncertain: Array<{ cx: number; cy: number; w: number; h: number }> | null } {
  if (hints.projectSubject) {
    const t = trackSubject(samples, { j: hints.projectSubject.j, x: hints.projectSubject.x, y: hints.projectSubject.y, note: hints.projectSubject.note }, 140, 220);
    return { source: "PROJECT_SUBJECT", reason: `explicit project subject: ${hints.projectSubject.note}`, track: t, semanticPath: null, uncertain: null };
  }
  // reliable dominant face: first sample where one face is clearly the largest and large enough
  const minH = COMPOSITION.minFaceHeightFraction * g.frameH;
  for (const s of [...samples].sort((a, b) => a.j - b.j)) {
    const fs = s.faces.filter((f) => f.h >= minH).sort((a, b) => area(b) - area(a));
    if (!fs.length) continue;
    if (fs.length >= 2 && area(fs[0]!) < COMPOSITION.dominanceAreaRatio * area(fs[1]!)) {
      // two comparable faces: do not pick one arbitrarily
      return { source: "NONE", reason: `${fs.length} comparable faces at frame ${s.j} (area ratio ${r3(area(fs[0]!) / area(fs[1]!))} < ${COMPOSITION.dominanceAreaRatio})`, track: null, semanticPath: null, uncertain: fs.slice(0, 3) };
    }
    const top = fs[0]!;
    const t = trackSubject(samples, { j: s.j, x: top.cx, y: top.cy, note: "dominant face (size and persistence, not confidence)" }, 10, 220);
    const coverage = t.points.length / samples.length;
    if (coverage >= COMPOSITION.minTrackCoverage) return { source: "TRACKED_PRIMARY", reason: `dominant face (area >= ${COMPOSITION.dominanceAreaRatio}x the next, height >= ${Math.round(COMPOSITION.minFaceHeightFraction * 100)} pct) tracked by continuity in ${t.points.length}/${samples.length} samples`, track: t, semanticPath: null, uncertain: null };
    break;
  }
  if (hints.semantic && hints.semantic.presence === "single" && hints.semantic.centerPath.length) return { source: "SEMANTIC_ESTIMATE", reason: "Phase 3B single-subject centre path (no reliable face track)", track: null, semanticPath: hints.semantic.centerPath, uncertain: null };
  return { source: "NONE", reason: "no reliable primary human (keep the source composition)", track: null, semanticPath: null, uncertain: null };
}

function subjectPath(g: ClipGeometry, track: SubjectTrack | null, sem: Array<{ t: number; x: number }> | null): number[] {
  if (track && track.points.length) {
    const xs = track.points.map((p) => g.sourceTimes[p.j]!);
    const ys = track.points.map((p) => p.cx);
    return g.sourceTimes.map((t) => pchip(xs, ys, t));
  }
  const xs = sem!.map((p) => p.t);
  const ys = sem!.map((p) => p.x);
  return g.sourceTimes.map((t) => pchip(xs, ys, t));
}

const positions = (subject: number[], cropX: number[], W: number) => subject.map((s, f) => (s - cropX[f]!) / W);
const summary = (pos: number[]) => ({ start: r3(pos[0]!), mid: r3(pos[Math.floor(pos.length / 2)]!), end: r3(pos.at(-1)!), outsideSafe: r3(pos.filter((p) => p < COMPOSITION.safeBand[0] || p > COMPOSITION.safeBand[1]).length / pos.length) });

/** Bounded correction: least crop movement that keeps the subject near centre. */
export function proposeCorrection(g: ClipGeometry, subject: number[], label = "PROPOSED_REFRAME"): Proposal {
  const W = g.cropW;
  const lo = g.activeX + W / 2;
  const hi = g.activeX + g.activeW - W / 2;
  const clampC = (c: number) => Math.min(hi, Math.max(lo, c));
  const toCropX = (c: number) => 2 * Math.round((clampC(c) - W / 2) / 2);
  const travel = Math.max(...subject) - Math.min(...subject);
  const staticCentre = Math.round((Math.max(...subject) + Math.min(...subject)) / 2);
  const staticX = g.cropX.map(() => toCropX(staticCentre));
  const staticPos = summary(positions(subject, staticX, W));
  const staticRaw = positions(subject, staticX, W);
  const comfortable = staticRaw.filter((p) => p >= COMPOSITION.staticComfortBand[0] && p <= COMPOSITION.staticComfortBand[1]).length / staticRaw.length;
  if (comfortable >= COMPOSITION.staticMinInsideSafe) {
    return { label, mode: "static", centerX: clampC(staticCentre), path: null, cropX: staticX, positions: staticPos, movement: movement(staticX), reason: `subject travels ${Math.round(travel)} px; a static crop centred on the middle of its range keeps it comfortably framed (32-68 pct) for ${Math.round(comfortable * 100)} pct of frames (least movement)` };
  }
  // camera operator: smooth -> dead band -> smooth -> rate limit -> clamp
  let c = smooth(subject, COMPOSITION.smoothWindow);
  c = deadband(c, COMPOSITION.deadZone * W);
  c = smooth(c, COMPOSITION.pathSmoothWindow);
  for (let pass = 0; pass < 6; pass++) {
    const m = movement(c);
    if (m.maxStepPx <= COMPOSITION.maxStepPx && m.maxAccelPx <= COMPOSITION.maxAccelPx) break;
    for (let i = 1; i < c.length; i++) {
      const d = c[i]! - c[i - 1]!;
      if (Math.abs(d) > COMPOSITION.maxStepPx) c[i] = c[i - 1]! + Math.sign(d) * COMPOSITION.maxStepPx;
    }
    c = smooth(c, 5);
  }
  const cropX = c.map(toCropX);
  const mv = movement(cropX);
  const pos = summary(positions(subject, cropX, W));
  // least movement: if tracking is not clearly better than static, keep static
  if (pos.outsideSafe >= staticPos.outsideSafe - 0.05 && Math.abs(pos.start - 0.5) >= Math.abs(staticPos.start - 0.5) - 0.05) {
    return { label, mode: "static", centerX: clampC(staticCentre), path: null, cropX: staticX, positions: staticPos, movement: movement(staticX), reason: "tracking would not materially improve on a static crop; static preferred" };
  }
  const path = cropX.map((x, f) => ({ sourceTime: g.sourceTimesRational[f]!, centerX: x + W / 2 })).filter((_, f) => f % 2 === 0 || f === cropX.length - 1);
  return { label, mode: "tracked", centerX: null, path, cropX, positions: pos, movement: mv, reason: `subject travels ${Math.round(travel)} px: smoothed, dead-banded (${Math.round(COMPOSITION.deadZone * 100)} pct) tracked crop, <= ${COMPOSITION.maxStepPx} px/frame` };
}

/** Post-render composition QC + proposal for one clip. */
export function assessClip(g: ClipGeometry, samples: FaceSample[], hints: Hints = {}): Assessment {
  const base = (state: CompositionState, source: SubjectSource, reason: string): Assessment => ({ clipId: g.clipId, state, subject: { source, reason, track: [] }, metrics: null, flags: [], exception: null, proposals: [] });
  if (g.nativeVertical) return base("NOT_APPLICABLE", "NONE", "native vertical source: no crop to judge");
  const id = identifySubject(g, samples, hints);
  if (id.uncertain) {
    // bounded alternatives only: each candidate, and both together when they fit
    const alts: Proposal[] = [];
    const cands = id.uncertain.slice(0, 2);
    for (const [i, c] of cands.entries()) alts.push(proposeCorrection(g, g.sourceTimes.map(() => c.cx), `ALTERNATIVE_${String.fromCharCode(65 + i)}_FACE_${Math.round(c.cx)}`));
    if (cands.length === 2 && Math.abs(cands[0]!.cx - cands[1]!.cx) + (cands[0]!.w + cands[1]!.w) / 2 <= g.cropW) alts.push(proposeCorrection(g, g.sourceTimes.map(() => (cands[0]!.cx + cands[1]!.cx) / 2), "ALTERNATIVE_PAIR"));
    return { ...base("PRIMARY_SUBJECT_UNCERTAIN", "NONE", id.reason), proposals: alts };
  }
  if (id.source === "NONE") return base("NO_PRIMARY_HUMAN", "NONE", id.reason);
  const subject = subjectPath(g, id.track, id.semanticPath);
  const pos = positions(subject, g.cropX, g.cropW);
  const s = summary(pos);
  const mv = movement(g.cropX);
  const faces = id.track?.points ?? [];
  const clipped = faces.some((p) => p.cx - p.w / 2 < g.cropX[p.j]! || p.cx + p.w / 2 > g.cropX[p.j]! + g.cropW);
  const minEdge = r3(Math.min(...pos.map((p) => Math.min(p, 1 - p))));
  const metrics = { ...s, fractionOutsideSafe: s.outsideSafe, minEdgeMargin: minEdge, clipped, cropTravelPx: mv.travelPx, maxStepPx: mv.maxStepPx, maxAccelPx: mv.maxAccelPx };
  const track = faces.map((p) => ({ j: p.j, cx: Math.round(p.cx), w: Math.round(p.w) }));
  const subj = { source: id.source, reason: id.reason, track };
  if (g.override) return { clipId: g.clipId, state: "HUMAN_OVERRIDE", subject: subj, metrics, flags: [], exception: `approved ${g.override.id}${g.override.option ? ` (${g.override.option})` : ""} has precedence; never re-proposed`, proposals: [] };
  const flags: string[] = [];
  if (s.start < COMPOSITION.safeBand[0] || s.start > COMPOSITION.safeBand[1]) flags.push(`START_OUTSIDE_SAFE_REGION (${Math.round(s.start * 100)} pct)`);
  if (s.outsideSafe > COMPOSITION.maxFractionOutsideSafe) flags.push(`OFF_CENTRE_MUCH_OF_SHOT (${Math.round(s.outsideSafe * 100)} pct of frames outside 35-65 pct)`);
  if (clipped) flags.push("FACE_TOUCHES_OR_CROSSES_CROP_EDGE");
  if (mv.maxStepPx > COMPOSITION.jumpyStepPx || mv.maxAccelPx > COMPOSITION.jumpyAccelPx) flags.push(`JUMPY_CROP (step ${mv.maxStepPx}, accel ${mv.maxAccelPx})`);
  const crop = g.cropX.map((x) => x + g.cropW / 2);
  // a tracked crop that moves against the subject and ends far from it followed someone else
  if (mv.travelPx > 40) {
    const dc = crop.slice(1).map((c, k) => c - crop[k]!);
    const ds = subject.slice(1).map((v, k) => v - subject[k]!);
    const dot = dc.reduce((a, c, k) => a + c * ds[k]!, 0);
    if (dot < 0 && subject.some((v, f) => Math.abs(v - crop[f]!) > 0.3 * g.cropW)) flags.push("CROP_PATH_DIVERGES_FROM_SUBJECT (tracked the wrong person?)");
  }
  if (!flags.length) return { clipId: g.clipId, state: "OK", subject: subj, metrics, flags, exception: null, proposals: [] };
  // exceptions: explicit brief; lead room for a moving subject (only mild off-centring qualifies)
  if (hints.intentionalOffCentre) return { clipId: g.clipId, state: "INTENTIONAL_OFF_CENTRE", subject: subj, metrics, flags, exception: `creative brief: ${hints.intentionalOffCentre}`, proposals: [] };
  const dir = hints.semantic?.screenDirection;
  if ((dir === "left_to_right" || dir === "right_to_left") && !clipped) {
    const [a, b] = COMPOSITION.leadRoomBand[dir];
    if (pos.every((p) => p >= a && p <= b)) return { clipId: g.clipId, state: "INTENTIONAL_OFF_CENTRE", subject: subj, metrics, flags, exception: `lead room for ${dir.replace(/_/g, " ")} movement (subject stays within ${a * 100}-${b * 100} pct)`, proposals: [] };
  }
  return { clipId: g.clipId, state: "REFRAME_REVIEW_RECOMMENDED", subject: subj, metrics, flags, exception: null, proposals: [proposeCorrection(g, subject)] };
}

/** Monotone piecewise-cubic Hermite interpolation (PCHIP). */
export function pchip(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) throw new Error("pchip: no points");
  if (n === 1 || x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  const h = xs.slice(1).map((v, i) => v - xs[i]!);
  const d = h.map((hi, i) => (ys[i + 1]! - ys[i]!) / hi);
  const m = new Array<number>(n);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1]! * d[i]! <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i]! + h[i - 1]!;
      const w2 = h[i]! + 2 * h[i - 1]!;
      m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!);
    }
  }
  let k = 0;
  while (x > xs[k + 1]!) k++;
  const t = (x - xs[k]!) / h[k]!;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[k]! + (t3 - 2 * t2 + t) * h[k]! * m[k]! + (-2 * t3 + 3 * t2) * ys[k + 1]! + (t3 - t2) * h[k]! * m[k + 1]!;
}
