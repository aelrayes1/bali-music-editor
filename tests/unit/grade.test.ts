/**
 * Phase 11.5 grade maths (pure): the ASC CDL (identity, clamp, power anchoring, saturation around
 * Rec.709 luma), the skin classifier, the shot solver (black point, white balance, skin-driven
 * matching as a black-and-white-anchored power, caps, the payoff exception, determinism) and the
 * highlight guard (a grade may not add clipping).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FrameStats, IDENTITY_CDL, applyCdl, cdlPixel, clipShare, DEFAULT_LIMITS, groupTargets, guardHighlights, isSkin, solveShot } from "../../src/grade/grade.ts";

const frame = (px: Array<[number, number, number]>) => Uint8Array.from(px.flat());
const stats = (o: Partial<FrameStats> = {}): FrameStats => ({ lumaP005: 0.01, lumaP05: 0.04, lumaP50: 0.3, lumaP95: 0.8, lumaP995: 0.95, lumaMean: 0.33, chroma: 0.1, neutral: null, neutralShare: 0, clip: 0, crush: 0, subjectLuma: 0.3, skinShare: 0.1, skinLuma: 0.254, skinChroma: 0.251, skinHue: 13, ...o });
const targets = { skinLuma: 0.254, skinChroma: 0.251 };

describe("ASC CDL", () => {
  it("identity returns the exact frame", () => {
    const f = frame([[0, 0, 0], [17, 130, 250], [255, 255, 255], [201, 88, 3]]);
    assert.deepEqual(applyCdl(IDENTITY_CDL, f), f);
  });
  it("a power keeps black and white anchored and lifts (p<1) or lowers (p>1) the midtones", () => {
    const c = { ...IDENTITY_CDL, power: [0.9, 0.9, 0.9] as [number, number, number] };
    assert.deepEqual(cdlPixel(c, 0, 0, 0), [0, 0, 0]);
    assert.deepEqual(cdlPixel(c, 1, 1, 1).map((x) => Math.round(x * 1e9) / 1e9), [1, 1, 1]);
    assert.ok(cdlPixel(c, 0.3, 0.3, 0.3)[1]! > 0.3);
    const d = { ...IDENTITY_CDL, power: [1.1, 1.1, 1.1] as [number, number, number] };
    assert.ok(cdlPixel(d, 0.3, 0.3, 0.3)[1]! < 0.3);
  });
  it("clamps before the power (no NaN from negative values) and saturation keeps neutrals neutral", () => {
    const c = { slope: [1, 1, 1] as [number, number, number], offset: [-0.2, -0.2, -0.2] as [number, number, number], power: [0.8, 0.8, 0.8] as [number, number, number], saturation: 1.3 };
    for (const v of cdlPixel(c, 0.1, 0.1, 0.1)) assert.ok(Number.isFinite(v) && v >= 0);
    const [r, g, b] = cdlPixel({ ...IDENTITY_CDL, saturation: 1.5 }, 0.4, 0.4, 0.4);
    assert.ok(Math.abs(r! - g!) < 1e-9 && Math.abs(g! - b!) < 1e-9);
  });
});

describe("skin classifier", () => {
  it("accepts typical skin tones and rejects neutrals, blue sky and deep shadow", () => {
    assert.ok(isSkin(0.62, 0.45, 0.36));
    assert.ok(isSkin(0.4, 0.27, 0.2));
    assert.ok(!isSkin(0.5, 0.5, 0.5));
    assert.ok(!isSkin(0.3, 0.5, 0.8));
    assert.ok(!isSkin(0.03, 0.02, 0.01));
  });
});

describe("shot solver", () => {
  it("a shot on target gets the identity grade", () => {
    const s = solveShot(stats(), targets, "group");
    assert.deepEqual(s.cdl, IDENTITY_CDL);
  });
  it("matches skin brightness with a power (slope stays 1: whites are never pushed past 1.0) and caps the move", () => {
    const dark = solveShot(stats({ skinLuma: 0.165 }), targets, "group");
    assert.deepEqual(dark.cdl.slope, [1, 1, 1]);
    assert.ok(dark.cdl.power[1] < 1);
    assert.equal(dark.matching.exposure, DEFAULT_LIMITS.exposure[1]);
    // the skin reaches exposure x its level
    const lifted = cdlPixel(dark.cdl, 0.165, 0.165, 0.165)[1]!;
    assert.ok(Math.abs(lifted / 0.165 - dark.matching.exposure) < 1e-3);
    const bright = solveShot(stats({ skinLuma: 0.32 }), targets, "group");
    assert.ok(bright.cdl.power[1] > 1 && bright.matching.exposure >= DEFAULT_LIMITS.exposure[0]);
  });
  it("lowers milky blacks black-pinned, within the cap", () => {
    const s = solveShot(stats({ lumaP005: 0.12 }), targets, "group");
    assert.ok(s.cdl.offset[1] < 0 && -s.normalization.blackLift <= DEFAULT_LIMITS.maxBlackOffset);
    assert.ok(Math.abs(cdlPixel(s.cdl, 1, 1, 1)[1]! - 1) < 1e-6);
  });
  it("estimates white balance only from enough near-neutral midtones, luma-preserving and capped", () => {
    const few = solveShot(stats({ neutral: [0.5, 0.45, 0.4], neutralShare: 0.01 }), targets, "group");
    assert.deepEqual(few.normalization.wb, [1, 1, 1]);
    const many = solveShot(stats({ neutral: [0.5, 0.45, 0.4], neutralShare: 0.2 }), targets, "group");
    for (const g of many.normalization.wb) assert.ok(g >= DEFAULT_LIMITS.wbGain[0] - 0.02 && g <= DEFAULT_LIMITS.wbGain[1] + 0.02);
    assert.ok(many.normalization.wb[0] < 1 && many.normalization.wb[2] > 1);
  });
  it("the payoff keeps its exposure, white balance and saturation (intentional club light)", () => {
    const s = solveShot(stats({ skinLuma: 0.1, skinChroma: 0.4, neutral: [0.6, 0.4, 0.3], neutralShare: 0.3 }), targets, "payoff");
    assert.deepEqual(s.cdl, IDENTITY_CDL);
  });
  it("is deterministic, and group targets are the medians of the probed shots", () => {
    assert.deepEqual(solveShot(stats({ skinLuma: 0.2, skinChroma: 0.3 }), targets, "group"), solveShot(stats({ skinLuma: 0.2, skinChroma: 0.3 }), targets, "group"));
    assert.deepEqual(groupTargets([stats({ skinLuma: 0.1 }), stats({ skinLuma: 0.3, skinChroma: null }), stats({ skinLuma: 0.2 })]), { skinLuma: 0.2, skinChroma: 0.251 });
  });
});

describe("highlight guard", () => {
  // a near-white, slightly warm sky: a saturation boost pushes red past 250
  const sky = frame(Array.from({ length: 100 }, (_, i) => (i < 40 ? [249, 225, 190] : [60, 50, 45])));
  it("pulls a saturation boost back until the grade adds no more than the tolerance of clipping", () => {
    const s = solveShot(stats({ skinChroma: 0.2 }), targets, "group");
    assert.ok(s.cdl.saturation > 1);
    assert.ok(clipShare(applyCdl(s.cdl, sky)) > clipShare(sky) + 0.005);
    const g = guardHighlights(s, [sky]);
    assert.ok(g.cdl.saturation < s.cdl.saturation);
    assert.ok(g.highlightGuard!.clipAfter - g.highlightGuard!.clipBefore <= 0.005);
  });
  it("leaves a grade that adds no clipping untouched", () => {
    const s = solveShot(stats({ skinLuma: 0.32 }), targets, "group");
    assert.deepEqual(guardHighlights(s, [sky]).cdl, s.cdl);
  });
});
