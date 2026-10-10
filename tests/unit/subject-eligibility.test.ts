/**
 * Phase 6B production policy: subject-aware FX are quality-gated. AUTO_ELIGIBLE only when every
 * condition holds; MASK_REVIEW_RECOMMENDED stays review-gated; uncertain subjects, unresolved
 * conflicts, identity switches in the window, failed mask QC and unsuitable background modes are
 * NOT_ELIGIBLE. The weakest eligible intensity is preferred; HOLD is locked-camera only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ELIGIBILITY, type EligibilityInput, HUMAN_REVIEW_REQUIRED, avoidIdentityBreaks, backgroundModeFor, preferredIntensity, subjectFxEligibility } from "../../src/fx/subject/eligibility.ts";
import type { MaskQc } from "../../src/fx/subject/qc.ts";

const qc = (over: Partial<MaskQc> = {}): MaskQc => ({ state: "MASK_OK", reasons: [], frames: 12, retention: 1, continuity: { min: 0.9, mean: 0.95, worstFrame: null }, areaChange: { max: 0.05, worstFrame: null }, edgeDisplacementPx: { mean: 1, max: 2, worstFrame: null }, identity: { trackId: "person:00", bridgedFrames: [], missingFrames: [], maxConsecutiveBridged: 0, switches: [] }, leakage: { max: 0, worstFrame: null }, seam: null, ...over });
const base = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({ selection: { state: "SUBJECT_SELECTED", source: "TRACKED_SOLE_PERSON", identityBreaks: [], warnings: [] }, conflicts: [{ state: "CONSISTENT" }], window: { start: 20, end: 32 }, maskQc: qc(), backgroundMode: "BACKGROUND_CONTINUES", cameraMotionPx: 0, timing: { cleanReset: true, deterministic: true }, ...over });

describe("subject-aware FX production eligibility", () => {
  it("AUTO_ELIGIBLE only when subject, identity, conflict, mask, background and timing all pass", () => {
    const r = subjectFxEligibility(base());
    assert.equal(r.state, "AUTO_ELIGIBLE");
    assert.equal(r.label, null);
    assert.deepEqual(r.detail, { subject: "SUBJECT_SELECTED (TRACKED_SOLE_PERSON)", conflict: "NONE", identity: "VERIFIED", mask: "MASK_OK", background: "BACKGROUND_CONTINUES / camera LOCKED", timing: "OK" });
  });
  it("MASK_REVIEW_RECOMMENDED is REVIEW_REQUIRED and labelled HUMAN_REVIEW_REQUIRED, never auto", () => {
    const r = subjectFxEligibility(base({ maskQc: qc({ state: "MASK_REVIEW_RECOMMENDED", reasons: ["seam"] }) }));
    assert.equal(r.state, "REVIEW_REQUIRED");
    assert.equal(r.label, HUMAN_REVIEW_REQUIRED);
    assert.equal(r.detail.mask, "MASK_REVIEW_RECOMMENDED", "the detailed state is preserved, not collapsed");
  });
  it("NOT_ELIGIBLE: uncertain subject, unresolved conflict, identity switch in the window, failed mask QC, unmeasured inputs, bad timing", () => {
    const cases: Array<[string, Partial<EligibilityInput>]> = [
      ["uncertain", { selection: { state: "PRIMARY_SUBJECT_UNCERTAIN", source: "NONE", identityBreaks: [], warnings: [] } }],
      ["conflict", { conflicts: [{ state: "PRIMARY_SUBJECT_CONFLICT" }] }],
      ["switch", { selection: { state: "SUBJECT_SELECTED", source: "TRACKED_DOMINANT_FACE", identityBreaks: [25], warnings: [] } }],
      ["merged group", { selection: { state: "SUBJECT_SELECTED", source: "HUMAN_SUBJECT_OVERRIDE", identityBreaks: [], warnings: ["SUBJECT_NOT_SEPARABLE: x"] } }],
      ["mask lost", { maskQc: qc({ retention: 0.9 }) }],
      ["mask switch", { maskQc: qc({ identity: { trackId: "p", bridgedFrames: [], missingFrames: [], maxConsecutiveBridged: 0, switches: [24] } }) }],
      ["no mask QC", { maskQc: null }],
      ["no camera measure", { cameraMotionPx: null }],
      ["reset", { timing: { cleanReset: false, deterministic: true } }],
      ["nondeterministic", { timing: { cleanReset: true, deterministic: false } }],
    ];
    for (const [name, over] of cases) assert.equal(subjectFxEligibility(base(over)).state, "NOT_ELIGIBLE", name);
    assert.equal(subjectFxEligibility(base({ selection: { state: "SUBJECT_SELECTED", source: "TRACKED_DOMINANT_FACE", identityBreaks: [20, 32], warnings: [] } })).state, "AUTO_ELIGIBLE", "switches outside the window don't matter");
    assert.equal(subjectFxEligibility(base({ conflicts: [{ state: "PRIMARY_SUBJECT_CONFLICT" }], conflictResolvedByHuman: true })).state, "AUTO_ELIGIBLE", "an explicit human resolution unblocks, auditable in detail");
  });
  it("background policy: CONTINUES when locked, SMOOTH_CONTINUE for bounded translation, HOLD locked-only and never automatic", () => {
    assert.equal(backgroundModeFor(0), "BACKGROUND_CONTINUES");
    assert.equal(backgroundModeFor(20), "BACKGROUND_SMOOTH_CONTINUE");
    assert.equal(backgroundModeFor(ELIGIBILITY.boundedTranslationPx + 10), null);
    assert.equal(subjectFxEligibility(base({ backgroundMode: "BACKGROUND_HOLD", cameraMotionPx: 26 })).state, "NOT_ELIGIBLE");
    assert.equal(subjectFxEligibility(base({ backgroundMode: "BACKGROUND_HOLD", cameraMotionPx: 0 })).state, "REVIEW_REQUIRED", "HOLD on a locked camera is an explicit choice, not automatic");
    assert.equal(subjectFxEligibility(base({ backgroundMode: "BACKGROUND_CONTINUES", cameraMotionPx: 20 })).state, "REVIEW_REQUIRED");
    assert.equal(subjectFxEligibility(base({ backgroundMode: "BACKGROUND_SMOOTH_CONTINUE", cameraMotionPx: 20 })).state, "AUTO_ELIGIBLE");
    assert.equal(subjectFxEligibility(base({ backgroundMode: "BACKGROUND_SMOOTH_CONTINUE", cameraMotionPx: 90 })).state, "NOT_ELIGIBLE");
  });
  it("intensity policy: the weakest AUTO_ELIGIBLE preset wins, never the strongest; else the weakest review option", () => {
    const e = (s: "AUTO_ELIGIBLE" | "REVIEW_REQUIRED" | "NOT_ELIGIBLE") => ({ state: s, detail: {} as never, reasons: [], label: null });
    assert.equal(preferredIntensity([{ preset: "STRONG" as const, eligibility: e("AUTO_ELIGIBLE") }, { preset: "SUBTLE" as const, eligibility: e("AUTO_ELIGIBLE") }])!.preset, "SUBTLE");
    assert.equal(preferredIntensity([{ preset: "SUBTLE" as const, eligibility: e("REVIEW_REQUIRED") }, { preset: "MEDIUM" as const, eligibility: e("AUTO_ELIGIBLE") }])!.preset, "MEDIUM");
    assert.equal(preferredIntensity([{ preset: "MEDIUM" as const, eligibility: e("REVIEW_REQUIRED") }, { preset: "STRONG" as const, eligibility: e("REVIEW_REQUIRED") }])!.preset, "MEDIUM");
    assert.equal(preferredIntensity([{ preset: "SUBTLE" as const, eligibility: e("NOT_ELIGIBLE") }]), null);
  });
  it("pair/occlusion: a start-anchored window is shortened before the switch; an end-anchored one is unavailable", () => {
    assert.deepEqual(avoidIdentityBreaks({ start: 20, end: 32 }, [40], "start"), { start: 20, end: 32, changed: false });
    assert.deepEqual(avoidIdentityBreaks({ start: 20, end: 32 }, [29, 30], "start"), { start: 20, end: 29, changed: true });
    assert.ok("unavailable" in avoidIdentityBreaks({ start: 20, end: 32 }, [23], "start"), "too short");
    assert.ok("unavailable" in avoidIdentityBreaks({ start: 20, end: 32 }, [29], "end"), "never moved past a switch automatically");
  });
});
