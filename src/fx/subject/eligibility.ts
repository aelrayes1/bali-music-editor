/**
 * Phase 6B production policy: SUBJECT-AWARE FX MUST BE QUALITY-GATED (pure).
 *
 * A successful segmentation or render is not automatically production-safe. Every subject-isolated
 * effect instance gets one of three eligibility states, derived from (never replacing) the detailed
 * states the pipeline already reports: SUBJECT_SELECTED / PRIMARY_SUBJECT_UNCERTAIN /
 * PRIMARY_SUBJECT_CONFLICT / HUMAN_SUBJECT_OVERRIDE / IDENTITY_SWITCH_SUSPECTED / MASK_OK /
 * MASK_REVIEW_RECOMMENDED.
 *
 *   AUTO_ELIGIBLE    may be used automatically when creatively justified: confident subject, no
 *                    unresolved identity switch or conflict, MASK_OK, a background mode valid for
 *                    the camera motion, clean reset and deterministic timing.
 *   REVIEW_REQUIRED  may be generated as a candidate / review option (labelled
 *                    HUMAN_REVIEW_REQUIRED) but never silently becomes the selected production effect.
 *   NOT_ELIGIBLE     never applied automatically.
 *
 * Intensity: stronger is not better. The weakest preset that is AUTO_ELIGIBLE is preferred; MEDIUM /
 * STRONG stay review-gated whenever their larger temporal displacement lowers mask/seam quality.
 * Background: CONTINUES for locked/stable backgrounds; SMOOTH_CONTINUE when bounded global camera
 * translation makes CONTINUES seam; HOLD is locked-camera only and never chosen automatically.
 * Identity: an effect never spans a suspected identity switch; a start-anchored window is shortened
 * where that leaves enough frames, otherwise the effect is unavailable until a human confirms the subject.
 */

import type { MaskQc } from "./qc.ts";
import type { ConflictCheck, Selection } from "./select.ts";
import type { BackgroundMode, SubjectPreset } from "./stutter.ts";

export type SubjectFxEligibility = "AUTO_ELIGIBLE" | "REVIEW_REQUIRED" | "NOT_ELIGIBLE";
export const HUMAN_REVIEW_REQUIRED = "HUMAN_REVIEW_REQUIRED";

export const ELIGIBILITY = {
  /** max background translation between neighbouring frames (px) still counted as a locked camera */
  lockedCameraPx: 2,
  /** beyond this, a global translation is not "bounded" (SMOOTH_CONTINUE searches +-64 px) */
  boundedTranslationPx: 48,
  /** shortest useful subject stutter window after avoiding an identity switch (frames) */
  minWindowFrames: 6,
};

export interface EligibilityInput {
  selection: Pick<Selection, "state" | "source" | "identityBreaks" | "warnings">;
  conflicts: Array<Pick<ConflictCheck, "state">>;
  /** an APPROVED HUMAN_SUBJECT_OVERRIDE that explicitly records resolvesConflict: true */
  conflictResolvedByHuman?: boolean;
  window: { start: number; end: number };
  maskQc: MaskQc | null;
  backgroundMode: BackgroundMode;
  /** largest background translation between neighbouring frames in the window (px), null = not measured */
  cameraMotionPx: number | null;
  timing: { cleanReset: boolean; deterministic: boolean } | null;
}

export interface EligibilityResult {
  state: SubjectFxEligibility;
  /** detailed states preserved verbatim (never collapsed) */
  detail: { subject: string; conflict: string; identity: string; mask: string; background: string; timing: string };
  reasons: string[];
  label: typeof HUMAN_REVIEW_REQUIRED | null;
}

/** Camera-motion class from the measured background translation. */
export function cameraMotionClass(px: number | null): "LOCKED" | "BOUNDED_TRANSLATION" | "UNBOUNDED" | "UNKNOWN" {
  if (px === null) return "UNKNOWN";
  if (px <= ELIGIBILITY.lockedCameraPx) return "LOCKED";
  if (px <= ELIGIBILITY.boundedTranslationPx) return "BOUNDED_TRANSLATION";
  return "UNBOUNDED";
}

/** The background mode policy: CONTINUES when locked, SMOOTH_CONTINUE for bounded translation, else none. HOLD is never automatic. */
export function backgroundModeFor(cameraMotionPx: number | null): BackgroundMode | null {
  const c = cameraMotionClass(cameraMotionPx);
  return c === "LOCKED" ? "BACKGROUND_CONTINUES" : c === "BOUNDED_TRANSLATION" ? "BACKGROUND_SMOOTH_CONTINUE" : null;
}

/** Is a mask QC result a hard failure (not merely "review recommended")? */
export function maskQcFails(q: MaskQc): string[] {
  const out: string[] = [];
  if (q.retention < 1) out.push(`subject missing on ${Math.round((1 - q.retention) * q.frames)} used frames`);
  if (q.identity.missingFrames.length) out.push(`subject identity missing on frames ${q.identity.missingFrames.join(",")}`);
  if (q.identity.switches.length) out.push(`identity switch on used frames ${q.identity.switches.join(",")}`);
  return out;
}

export function subjectFxEligibility(x: EligibilityInput): EligibilityResult {
  const not: string[] = [];
  const review: string[] = [];
  // subject identity
  if (x.selection.state !== "SUBJECT_SELECTED") not.push(`${x.selection.state}: no confident primary subject (whole-frame effects may still be used)`);
  if (x.selection.warnings.some((w) => w.startsWith("SUBJECT_NOT_SEPARABLE"))) not.push("SUBJECT_NOT_SEPARABLE: the subject is merged with other people");
  const conflict = x.conflicts.find((c) => c.state === "PRIMARY_SUBJECT_CONFLICT");
  if (conflict && !x.conflictResolvedByHuman) not.push("PRIMARY_SUBJECT_CONFLICT: blocked until a human resolves it");
  const inside = x.selection.identityBreaks.filter((j) => j > x.window.start && j < x.window.end);
  if (inside.length) not.push(`IDENTITY_SWITCH_SUSPECTED inside the window (frames ${inside.join(",")})`);
  // mask quality
  let mask = "NOT_MEASURED";
  if (!x.maskQc) not.push("mask QC not measured");
  else {
    mask = x.maskQc.state;
    const fails = maskQcFails(x.maskQc);
    if (fails.length) {
      mask = "MASK_QC_FAILED";
      not.push(...fails.map((f) => `mask QC failed: ${f}`));
    } else if (x.maskQc.state === "MASK_REVIEW_RECOMMENDED") review.push(...x.maskQc.reasons.map((r) => `MASK_REVIEW_RECOMMENDED: ${r}`));
  }
  // background vs camera motion
  const cam = cameraMotionClass(x.cameraMotionPx);
  let background = `${x.backgroundMode} / camera ${cam}`;
  if (cam === "UNKNOWN") not.push("camera motion not measured: background mode cannot be validated");
  else if (x.backgroundMode === "BACKGROUND_HOLD" && cam !== "LOCKED") {
    not.push(`BACKGROUND_HOLD needs a locked camera (measured ${x.cameraMotionPx} px/frame)`);
    background += " (unsuitable)";
  } else if (cam === "UNBOUNDED") {
    not.push(`camera moves beyond a bounded translation (${x.cameraMotionPx} px/frame)`);
    background += " (unsuitable)";
  } else if (x.backgroundMode === "BACKGROUND_CONTINUES" && cam === "BOUNDED_TRANSLATION") review.push("BACKGROUND_CONTINUES during camera translation: seams likely; BACKGROUND_SMOOTH_CONTINUE preferred");
  else if (x.backgroundMode === "BACKGROUND_HOLD") review.push("BACKGROUND_HOLD is never chosen automatically (locked-camera only, explicit choice)");
  // timing
  let timing = "NOT_MEASURED";
  if (!x.timing) not.push("timing QC not measured");
  else {
    timing = x.timing.cleanReset && x.timing.deterministic ? "OK" : "FAILED";
    if (!x.timing.cleanReset) not.push("clean reset failed");
    if (!x.timing.deterministic) not.push("timing not deterministic");
  }
  const state: SubjectFxEligibility = not.length ? "NOT_ELIGIBLE" : review.length ? "REVIEW_REQUIRED" : "AUTO_ELIGIBLE";
  return {
    state,
    detail: { subject: `${x.selection.state} (${x.selection.source})`, conflict: conflict ? (x.conflictResolvedByHuman ? "PRIMARY_SUBJECT_CONFLICT (resolved by human)" : "PRIMARY_SUBJECT_CONFLICT") : "NONE", identity: inside.length ? "IDENTITY_SWITCH_SUSPECTED" : "VERIFIED", mask, background, timing },
    reasons: [...not, ...review],
    label: state === "REVIEW_REQUIRED" ? HUMAN_REVIEW_REQUIRED : null,
  };
}

const ORDER: SubjectPreset[] = ["SUBTLE", "MEDIUM", "STRONG"];

/**
 * Intensity policy: the weakest preset that is AUTO_ELIGIBLE; otherwise the weakest REVIEW_REQUIRED
 * one (labelled HUMAN_REVIEW_REQUIRED); otherwise none. Never "the strongest that passes".
 */
export function preferredIntensity<T extends { preset: SubjectPreset; eligibility: EligibilityResult }>(options: T[]): T | null {
  const by = [...options].sort((a, b) => ORDER.indexOf(a.preset) - ORDER.indexOf(b.preset));
  return by.find((o) => o.eligibility.state === "AUTO_ELIGIBLE") ?? by.find((o) => o.eligibility.state === "REVIEW_REQUIRED") ?? null;
}

/**
 * Pair / occlusion policy: keep a window clear of identity switches. With the musical anchor at the
 * window START, the window may be shortened to end before the first switch (up to there the track is
 * the selected person). After a switch the track may be the occluder, so a window anchored at its
 * END (e.g. a crescendo into a hit) is never moved past a switch automatically: it is unavailable
 * until a human confirms the subject. Too short after shortening -> unavailable.
 */
export function avoidIdentityBreaks(window: { start: number; end: number }, breaks: number[], anchor: "start" | "end"): { start: number; end: number; changed: boolean } | { unavailable: string } {
  const inside = breaks.filter((j) => j > window.start && j < window.end).sort((a, b) => a - b);
  if (!inside.length) return { ...window, changed: false };
  if (anchor === "end") return { unavailable: `identity switch at frames ${inside.join(",")} inside a window anchored at its end: the person after the switch is unverified; needs human subject confirmation or another window` };
  const w = { start: window.start, end: inside[0]! };
  if (w.end - w.start < ELIGIBILITY.minWindowFrames) return { unavailable: `identity switch at frame ${inside[0]} leaves ${w.end - w.start} frames (< ${ELIGIBILITY.minWindowFrames}) after the start anchor: needs human subject confirmation or another window` };
  return { ...w, changed: true };
}
