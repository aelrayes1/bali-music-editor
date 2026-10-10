/**
 * CLEAN_TO_CHAOS (pure): the generic preset, window resolution (clean start, music-aligned onset,
 * reset on cut, clean payoff, locked-remap preservation), the intensity ramp, the step-print map,
 * and the pixel engine (strength 0 = the exact clean frame, determinism, protect bands, datamosh
 * reset, and identical output for a repeated source frame so an approved stutter keeps its
 * repetition).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hash01, remapFrame } from "../../src/fx/core.ts";
import { CLEAN_TO_CHAOS, type CtcConfig, CtcContractError, type ResolvedCtcClip, resolveCtc, stepPrintMap, strengthAt } from "../../src/fx/ctc/contract.ts";
import { Datamosh, type Rgb, analogFeedback, echoPrint, feedbackCrescendo, protectRows, slitScan, zoomRotate } from "../../src/fx/ctc/pixels.ts";

const clips = [
  { clipId: "a", frameIn: 0, frameOut: 48, role: "opening" as const },
  { clipId: "b", frameIn: 48, frameOut: 105, role: "body" as const },
  { clipId: "c", frameIn: 105, frameOut: 188, role: "body" as const },
  { clipId: "p", frameIn: 188, frameOut: 300, role: "payoff" as const },
];
const echo = { type: "echoPrint" as const, params: { type: "echoPrint" as const, trails: 4, spacing: 2, decay: 0.7, mix: 0.9, blend: "lighten" as const } };
const cfg = (assignments: CtcConfig["assignments"], preset = CLEAN_TO_CHAOS): CtcConfig => ({ schemaVersion: "1.0.0", kind: "CLEAN_TO_CHAOS_CONFIG", projectId: "test", preset, seed: 7, assignments });

describe("CLEAN_TO_CHAOS preset + resolution", () => {
  it("the preset is generic: no project, subject or song knowledge", () => {
    const s = JSON.stringify(CLEAN_TO_CHAOS);
    assert.doesNotMatch(s, /reference-project|clip:|shot:|song/i);
    assert.equal(CLEAN_TO_CHAOS.resetOnCut, true);
    assert.equal(CLEAN_TO_CHAOS.finalCleanPayoff, true);
    assert.ok(CLEAN_TO_CHAOS.cleanFractionBand[0] <= CLEAN_TO_CHAOS.cleanFraction && CLEAN_TO_CHAOS.cleanFraction <= CLEAN_TO_CHAOS.cleanFractionBand[1]);
  });
  it("cleanFraction sets the onset; the window always runs to the clip's own cut (reset on cut)", () => {
    const r = resolveCtc(cfg([{ clipId: "a", label: "x", maxIntensity: 0.5, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [] });
    assert.equal(r[0]!.onset, 24);
    assert.equal(r[0]!.peakAt, 48);
    assert.equal(r[0]!.frames, 48);
    assert.equal(r[0]!.maxIntensity, 0.5);
  });
  it("music alignment snaps the onset to an approved anchor only inside the band and the shift limit", () => {
    const r = resolveCtc(cfg([{ clipId: "b", label: "x", maxIntensity: 0.5, effects: [echo] }]), { clips, anchors: [{ eventId: "beat:1", type: "downbeat", timelineFrame: 75 }], lockedRemaps: [] });
    assert.equal(r[0]!.onset, 27);
    assert.match(r[0]!.onsetReason, /beat:1/);
    // out of band (0.40 of the clip) -> ignored; wrong type -> ignored
    const q = resolveCtc(cfg([{ clipId: "a", label: "x", maxIntensity: 0.5, effects: [echo] }]), { clips, anchors: [{ eventId: "beat:0", type: "downbeat", timelineFrame: 19 }, { eventId: "v", type: "vocal_primary", timelineFrame: 25 }], lockedRemaps: [] });
    assert.equal(q[0]!.onset, 24);
    assert.match(q[0]!.onsetReason, /cleanFraction/);
  });
  it("refuses the payoff, a duplicate clip, an out-of-band cleanFraction and a remap before the onset", () => {
    const bad = (f: () => unknown, re: RegExp) => assert.throws(f, (e: unknown) => e instanceof CtcContractError && re.test((e as Error).message));
    bad(() => resolveCtc(cfg([{ clipId: "p", label: "x", maxIntensity: 1, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [] }), /payoff stays completely clean/);
    bad(() => resolveCtc(cfg([{ clipId: "a", label: "x", maxIntensity: 1, effects: [echo] }, { clipId: "a", label: "y", maxIntensity: 1, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [] }), /assigned twice/);
    bad(() => resolveCtc(cfg([{ clipId: "a", label: "x", maxIntensity: 1, cleanFraction: 0.3, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [] }), /outside the band/);
    bad(() => resolveCtc(cfg([{ clipId: "c", label: "x", maxIntensity: 1, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [{ id: "st", clipId: "c", start: 120, end: 138 }] }), /starts before the effect onset/);
    bad(() => resolveCtc(cfg([{ clipId: "c", label: "x", maxIntensity: 1, effects: [{ type: "stepPrint", params: { type: "stepPrint", maxStep: 3 } }] }]), { clips, anchors: [], lockedRemaps: [{ id: "st", clipId: "c", start: 170, end: 188 }] }), /cannot share a clip with another remap/);
  });
  it("a locked remap keeps its window: the ramp peaks at its first frame and holds to the cut", () => {
    const r = resolveCtc(cfg([{ clipId: "c", label: "x", maxIntensity: 1, cleanFraction: 0.45, effects: [echo] }]), { clips, anchors: [], lockedRemaps: [{ id: "st", clipId: "c", start: 170, end: 188 }] })[0]!;
    assert.deepEqual(r.lockedRemap, { id: "st", start: 65, end: 83 });
    assert.equal(r.peakAt, 65);
    for (let g = 64; g < 83; g++) assert.equal(strengthAt(r, g), 1, `source frame ${g}`);
  });
});

describe("intensity ramp and step print", () => {
  const c: ResolvedCtcClip = { clipId: "x", label: "", frames: 40, timeline: { frameIn: 0, frameOut: 40 }, onset: 20, onsetReason: "", cleanFraction: 0.5, peakAt: 40, maxIntensity: 0.6, curve: { kind: "easeIn", gamma: 1.5 }, lockedRemap: null, effects: [] };
  it("exactly 0 before the onset, emerges small, never decreases, reaches the ceiling at the end, 0 past the clip", () => {
    for (let f = 0; f < 20; f++) assert.equal(strengthAt(c, f), 0);
    assert.ok(strengthAt(c, 20) > 0 && strengthAt(c, 20) < 0.05, "emerges from clean");
    for (let f = 21; f < 40; f++) assert.ok(strengthAt(c, f) >= strengthAt(c, f - 1));
    assert.equal(strengthAt(c, 39), 0.6);
    assert.equal(strengthAt(c, 40), 0);
  });
  it("step print: identity before the onset; the source never runs ahead; the cadence only grows", () => {
    const m = stepPrintMap(c, 4);
    for (let f = 0; f < 20; f++) assert.equal(m[f], f);
    for (let f = 20; f < 40; f++) assert.ok(m[f]! <= f && m[f]! >= 20);
    const groups: number[] = [];
    for (let f = 20; f < 40; ) {
      let n = 1;
      while (f + n < 40 && m[f + n] === m[f]) n++;
      assert.equal(m[f], f, "each group starts on its own frame (re-aligned)");
      groups.push(n);
      f += n;
    }
    for (let i = 1; i < groups.length - 1; i++) assert.ok(groups[i]! >= groups[i - 1]!);
    assert.ok(Math.max(...groups) > 1);
  });
});

describe("pixel engine", () => {
  const W = 48;
  const H = 72;
  const frame = (j: number): Rgb => {
    const d = new Uint8Array(W * H * 3);
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(hash01(11, j, i) * 255);
    return { w: W, h: H, data: d };
  };
  const cache = new Map<number, Rgb>();
  const F = (j: number) => {
    const k = Math.max(0, j);
    if (!cache.has(k)) cache.set(k, frame(k));
    return cache.get(k)!;
  };
  const same = (a: Rgb, b: Rgb) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
  const fb = { type: "analogFeedback" as const, layers: 4, zoomPerLayer: 0.02, rotateDegPerLayer: 0.2, decay: 0.7, mix: 0.8, blend: "lighten" as const, chromaPx: 2, jitterPx: 10, jitterBandPx: 8, jitterProbability: 0.5 };
  const cr = { type: "feedbackCrescendo" as const, echoTrails: 3, echoDecay: 0.7, layers: 5, layerLag: 2, zoomPerLayer: 0.02, rotateDegPerLayer: 0.3, decay: 0.75, mix: 0.75, blend: "darken" as const, jitterPx: 12, jitterBandPx: 8, jitterProbability: 0.5 };
  const sl = { type: "slitScan" as const, maxDelayFrames: 8, bandPx: 4, waveCycles: 2, waveDepth: 0.5, waveDriftPerFrame: 0.03 };
  it("strength 0 returns the exact clean frame for every effect", () => {
    assert.ok(same(echoPrint(F, 20, 0, echo.params, "lighten", null), F(20)));
    assert.ok(same(analogFeedback(F(20), (k) => F(20 - k), 20, 0, 1, fb, "lighten", null, 3), F(20)));
    assert.ok(same(slitScan(F, 20, 0, sl, null), F(20)));
    assert.ok(same(feedbackCrescendo(F, 20, 0, 1, cr, "darken", null, 3), F(20)));
    assert.ok(same(zoomRotate(F(20), 1, 0, 0), F(20)), "identity resample is exact");
  });
  it("deterministic: the same inputs give bit-identical frames; strength changes the picture", () => {
    for (const fn of [() => echoPrint(F, 30, 0.6, echo.params, "lighten", null), () => analogFeedback(F(30), (k) => F(30 - k), 30, 0.6, 1, fb, "lighten", null, 3), () => slitScan(F, 30, 0.6, sl, null), () => feedbackCrescendo(F, 30, 0.6, 1, cr, "darken", null, 3)]) {
      const a = fn();
      assert.ok(same(a, fn()));
      assert.ok(!same(a, F(30)));
    }
  });
  it("a repeated source frame gives the identical crescendo frame (an approved stutter keeps its exact repetition)", () => {
    // the approved loop-4 x2 shrinking stutter over 18 frames: output frames that show the same source frame
    const st = { id: "st", type: "temporalStutter" as const, enabled: true, start: 65, end: 83, intensity: 1, mix: 1, seed: 1, envelope: { attack: 0, hold: 18, release: 0, curve: "linear" as const }, params: { type: "temporalStutter" as const, loop: 4, repeats: 2, shrink: true } };
    const src = Array.from({ length: 18 }, (_, k) => remapFrame(st, 65 + k)!);
    const out = src.map((g) => feedbackCrescendo(F, g, 1, 0.8, cr, "darken", null, 3));
    let pairs = 0;
    for (let i = 0; i < 18; i++) for (let j = i + 1; j < 18; j++) if (src[i] === src[j]) {
      pairs++;
      assert.ok(same(out[i]!, out[j]!), `${65 + i} = ${65 + j}`);
    }
    assert.ok(pairs > 0);
  });
  it("protect band: rows inside keep (1 - keep) of the effect; slit-scan with keep 1 leaves those rows clean", () => {
    const rows = protectRows(H, { from: 0.25, to: 0.5, keep: 1, featherFrac: 0 });
    assert.equal(rows[Math.floor(H * 0.35)], 0);
    assert.equal(rows[H - 1], 1);
    const o = slitScan(F, 30, 1, sl, rows);
    const y = Math.floor(H * 0.35);
    assert.deepEqual([...o.data.subarray(y * W * 3, (y + 1) * W * 3)], [...F(30).data.subarray(y * W * 3, (y + 1) * W * 3)]);
  });
  it("datamosh: starts clean at the onset, is deterministic, carries blocks as strength rises, and resets", () => {
    const p = { type: "datamoshStyle" as const, blockPx: 16, searchPx: 8, carryover: 0.95, maxStaleFrames: 6, motionGain: 2, mix: 1 };
    const run = () => {
      const d = new Datamosh(p, 5, null);
      return Array.from({ length: 10 }, (_, k) => d.step(F(40 + k), F(39 + k), 40 + k, k === 0 ? 0 : 0.2 + k * 0.08));
    };
    const a = run();
    const b = run();
    assert.ok(same(a[0]!.out, F(40)), "first frame of the window is the clean frame");
    a.forEach((x, i) => assert.ok(same(x.out, b[i]!.out)));
    assert.ok(a.slice(1).some((x) => x.carried > 0));
    const d = new Datamosh(p, 5, null);
    d.step(F(40), F(39), 40, 0);
    d.step(F(41), F(40), 41, 0.9);
    d.reset();
    assert.ok(same(d.step(F(60), F(59), 60, 0.9).out, F(60)), "after a reset (cut) the next frame is clean");
  });
});
