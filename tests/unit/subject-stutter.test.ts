/**
 * Phase 6B SUBJECT_ISOLATED_TEMPORAL_STUTTER (synthetic, deterministic): subject precedence and
 * ambiguity, identity continuity (stitching, fragments, merged groups), mattes and bounded temporal
 * smoothing, the timing pattern (never a future frame, clean reset, 6A maps reused), the
 * non-generative integer-exact composite, background modes, 6A anchoring and composition rules,
 * mask QC, PRIMARY_SUBJECT_CONFLICT, HUMAN_SUBJECT_OVERRIDE and cache identity.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { remapFrame, type ResolvedFx } from "../../src/fx/core.ts";
import { FxContractError, fromPreset, resolveEffects } from "../../src/fx/contract.ts";
import { alphaFull, blend, compositeFrame, estimateShift, lumaSmall, type Rgb, regionMask, seamMismatch, shiftRgb } from "../../src/fx/subject/composite.ts";
import { insertFrameAt } from "../../src/fx/subject/insert.ts";
import { type Mask, area, binarize, blur, close, dilate, emptyMask, fillHoles, temporalSmooth } from "../../src/fx/subject/mask.ts";
import { SubjectOverridesSchema, approvedSubjectOverride } from "../../src/fx/subject/override.ts";
import { maskCacheKey, type MaskIdentity } from "../../src/fx/subject/pipeline.ts";
import { MASK_QC, maskQc } from "../../src/fx/subject/qc.ts";
import { type FrameMasks, checkConflict, linkTracks, selectSubject, subjectMattes } from "../../src/fx/subject/select.ts";
import { SUBJECT_MODES, SUBJECT_PRESETS, SUBJECT_PRESETS_LIST, SubjectStutterSchema, resolveSubjectStutter, seededPattern, subjectFrameAt, subjectFromPreset, validateInserts } from "../../src/fx/subject/stutter.ts";
import { decodePng, encodePng } from "../../src/media/png.ts";
import { rational } from "../../src/time/rational.ts";

const MW = 60;
const MH = 100;
/** a soft "person": filled rectangle with a head, peak value v */
function person(x: number, y = 20, w = 14, h = 60, v = 255): Mask {
  const m = emptyMask(MW, MH);
  for (let yy = y; yy < Math.min(MH, y + h); yy++) for (let xx = x; xx < Math.min(MW, x + w); xx++) if (xx >= 0) m.data[yy * MW + xx] = v;
  return m;
}
const face = (cx: number, cy: number, h: number) => ({ x: cx / MW - h / 2, y: cy / MH - h / 2, w: h, h, conf: 0.5 });
/** N frames, one person walking right; optional second person; the segmentation matte = all people */
function scene(n: number, opts: { second?: (j: number) => number | null; drop?: number[]; faces?: (j: number) => FrameMasks["faces"] } = {}): FrameMasks[] {
  return Array.from({ length: n }, (_, j) => {
    const a = person(10 + j);
    const bx = opts.second?.(j);
    const b = bx === null || bx === undefined ? null : person(bx);
    const seg = emptyMask(MW, MH);
    for (let i = 0; i < seg.data.length; i++) seg.data[i] = Math.max(a.data[i]!, b?.data[i] ?? 0);
    const instances = opts.drop?.includes(j) ? [] : [{ index: 1, mask: a }, ...(b ? [{ index: 2, mask: b }] : [])];
    return { j, instances, faces: opts.faces?.(j) ?? [], seg };
  });
}
const rgb = (w: number, h: number, f: (x: number, y: number) => [number, number, number]): Rgb => {
  const d = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 3);
  return { w, h, data: d };
};

describe("subject selection: precedence, identity, ambiguity", () => {
  it("a single persistent person is TRACKED_SOLE_PERSON; tracks link through motion", () => {
    const fr = scene(20);
    const s = selectSubject(fr, linkTracks(fr));
    assert.equal(s.state, "SUBJECT_SELECTED");
    assert.equal(s.source, "TRACKED_SOLE_PERSON");
    assert.equal(s.tracks.length, 1);
  });

  it("two comparable people: PRIMARY_SUBJECT_UNCERTAIN with <= 3 bounded alternatives, never a guess", () => {
    const fr = scene(20, { second: () => 40 });
    const s = selectSubject(fr, linkTracks(fr));
    assert.equal(s.state, "PRIMARY_SUBJECT_UNCERTAIN");
    assert.equal(s.trackId, null);
    assert.ok(s.alternatives.length >= 2 && s.alternatives.length <= 3);
    assert.ok(s.alternatives.every((a) => a.label.startsWith("ALTERNATIVE_")));
  });

  it("precedence: human override > project subject > tracking; an explicit reference on nobody is never replaced by a guess", () => {
    const fr = scene(20, { second: () => 40 });
    const tr = linkTracks(fr);
    const ids = selectSubject(fr, tr).alternatives.map((a) => a.id);
    const onB = { j: 5, x: 46, y: 50 };
    const onA = { j: 5, x: 20, y: 50 };
    const o = selectSubject(fr, tr, { humanSubjectOverride: { id: "usr:s", point: onB }, projectSubject: { point: onA, note: "x" } });
    assert.equal(o.source, "HUMAN_SUBJECT_OVERRIDE");
    const p = selectSubject(fr, tr, { projectSubject: { point: onA, note: "confirmed" } });
    assert.equal(p.source, "PROJECT_SUBJECT");
    assert.notEqual(o.trackId, p.trackId);
    assert.ok(ids.includes(o.trackId!) && ids.includes(p.trackId!));
    const r = selectSubject(fr, tr, { reframeOverrideSubject: { id: "usr:reframe", points: [{ j: 3, x: 46, y: null }, { j: 9, x: 46, y: null }] } });
    assert.equal(r.source, "HUMAN_REFRAME_OVERRIDE");
    assert.equal(r.trackId, o.trackId);
    const nobody = selectSubject(fr, tr, { humanSubjectOverride: { id: "usr:s", point: { j: 5, x: 2, y: 95 } } });
    assert.equal(nobody.state, "PRIMARY_SUBJECT_UNCERTAIN");
  });

  it("an explicit point beside a person is never snapped onto them; a point on a person Vision missed on that frame resolves on a nearby frame", () => {
    const fr = scene(20, { second: () => 40 });
    const tr = linkTracks(fr);
    const beside = selectSubject(fr, tr, { humanSubjectOverride: { id: "usr:s", point: { j: 5, x: 35, y: 50 } } });
    assert.equal(beside.state, "PRIMARY_SUBJECT_UNCERTAIN", "5-7 mask px (20-28 px full-res) from both people: nobody");
    const one = scene(20, { drop: [5] });
    const t1 = linkTracks(one);
    const missed = selectSubject(one, t1, { humanSubjectOverride: { id: "usr:s", point: { j: 5, x: 20, y: 50 } } });
    assert.equal(missed.source, "HUMAN_SUBJECT_OVERRIDE");
    assert.equal(missed.trackId, t1[0]!.id);
  });

  it("an occluder taking over a track is an identity break (the person's face stays visible outside the track, or vanishes while the mask collapses)", () => {
    const f0 = face(12, 25, 0.1);
    const frames: FrameMasks[] = Array.from({ length: 20 }, (_, j) => {
      const m = j < 10 ? person(10) : person(16); // overlaps enough to stay linked, but the face is left behind
      return { j, instances: [{ index: 1, mask: m }], faces: [f0], seg: m };
    });
    const tr = linkTracks(frames);
    assert.equal(tr.length, 1, "mask overlap alone links the occluder into the same track");
    const s = selectSubject(frames, tr, { projectSubject: { point: { j: 2, x: 16, y: 50 }, note: "the person" } });
    assert.deepEqual(s.identityBreaks, [10]);
    assert.match(s.warnings.join(), /IDENTITY_SWITCH_SUSPECTED/);
    const hidden: FrameMasks[] = Array.from({ length: 20 }, (_, j) => ({ j, instances: [{ index: 1, mask: j < 12 ? person(10) : person(10, 20, 6, 30) }], faces: j < 12 ? [f0] : [], seg: person(10) }));
    const th = linkTracks(hidden);
    assert.deepEqual(selectSubject(hidden, th, { projectSubject: { point: { j: 2, x: 16, y: 50 }, note: "p" } }).identityBreaks, [12, 13, 14, 15, 16, 17, 18, 19]);
    const walk = scene(20, { faces: (j) => [face(17 + j, 25, 0.1)] });
    assert.deepEqual(selectSubject(walk, linkTracks(walk)).identityBreaks, [], "a person walking with their face is not a break");
  });

  it("the dominant face wins by size, never by detector confidence", () => {
    const fr = scene(20, { second: () => 40, faces: (j) => [{ ...face(17 + j, 25, 0.12), conf: 0.3 }, { ...face(47, 25, 0.06), conf: 0.99 }] });
    const tr = linkTracks(fr);
    const s = selectSubject(fr, tr);
    assert.equal(s.source, "TRACKED_DOMINANT_FACE");
    const a = s.tracks.find((t) => t.id === s.trackId)!;
    assert.ok(a.centroid!.x < 40, "the large (low-confidence) face's person");
  });

  it("a mask containing several faces is a merged group: never auto-selected; an explicit pick warns SUBJECT_NOT_SEPARABLE", () => {
    const fr = scene(20, { faces: (j) => [face(13 + j, 25, 0.08), face(20 + j, 30, 0.07)] });
    const tr = linkTracks(fr);
    const s = selectSubject(fr, tr);
    assert.equal(s.state, "PRIMARY_SUBJECT_UNCERTAIN");
    assert.ok(s.alternatives[0]!.group);
    const o = selectSubject(fr, tr, { humanSubjectOverride: { id: "usr:g", point: { j: 4, x: 20, y: 50 } } });
    assert.equal(o.state, "SUBJECT_SELECTED");
    assert.match(o.warnings[0]!, /SUBJECT_NOT_SEPARABLE/);
  });

  it("a person lost for a few frames is stitched back into the same track (no identity switch)", () => {
    const fr = scene(30, { drop: [10, 11, 12] });
    const tr = linkTracks(fr);
    assert.equal(tr.length, 1);
    const s = selectSubject(fr, tr);
    const m = subjectMattes(fr, tr, s.trackId!);
    assert.deepEqual(m.filter((x) => x.basis === "BRIDGED").map((x) => x.j), [10, 11, 12]);
    assert.ok(m.every((x) => area(binarize(x.matte)) > 0), "bridged frames keep the subject from the segmentation");
  });

  it("the matte excludes another persistent person even when the segmentation merges them", () => {
    const fr = scene(20, { second: (j) => 26 + j });
    const tr = linkTracks(fr);
    const s = selectSubject(fr, tr, { projectSubject: { point: { j: 0, x: 12, y: 50 }, note: "left" } });
    const m = subjectMattes(fr, tr, s.trackId!);
    for (const x of m) {
      let leak = 0;
      for (let i = 0; i < x.matte.data.length; i++) if (x.matte.data[i]! >= 128 && x.others.data[i]) leak++;
      assert.ok(leak / Math.max(1, area(binarize(x.matte))) <= 0.05, `frame ${x.j} leak`);
    }
  });

  it("selection is deterministic and side-effect free", () => {
    const fr = scene(15, { second: () => 42 });
    const before = JSON.stringify(fr.map((f) => [f.j, f.instances.map((i) => Array.from(i.mask.data).join())]));
    const a = JSON.stringify(selectSubject(fr, linkTracks(fr)));
    assert.equal(a, JSON.stringify(selectSubject(fr, linkTracks(fr))));
    assert.equal(JSON.stringify(fr.map((f) => [f.j, f.instances.map((i) => Array.from(i.mask.data).join())])), before);
  });
});

describe("masks: morphology and bounded temporal smoothing", () => {
  it("holes inside the subject are filled; background connected to the border is not", () => {
    const m = person(10, 10, 30, 60);
    for (let y = 30; y < 40; y++) for (let x = 20; x < 28; x++) m.data[y * MW + x] = 0;
    const { mask, filled } = fillHoles(m);
    assert.equal(filled, 80);
    assert.equal(area(mask), 30 * 60);
    assert.equal(area(close(person(10, 10, 5, 20), 2)), area(person(10, 10, 5, 20)));
  });

  it("round dilation grows by the radius; blur keeps values in range", () => {
    const d = dilate(person(25, 45, 1, 1), 5);
    assert.ok(area(d) > 60 && area(d) < 121, "disc, not square");
    const b = blur(person(20, 20, 20, 20), 3);
    assert.ok(Math.max(...b.data) <= 255 && Math.min(...b.data) >= 0);
  });

  it("median smoothing removes one- and two-frame dropouts and one-frame blobs without dragging real motion", () => {
    const seq = Array.from({ length: 12 }, (_, j) => (j === 4 || j === 7 || j === 8 ? emptyMask(MW, MH) : person(10 + j)));
    seq[2] = person(10 + 2);
    seq[2].data[5] = 255; // a one-frame speck
    const s = temporalSmooth(seq, 2);
    // (a moving subject's median over the window is the overlap of its recent poses: slightly narrower)
    assert.ok([4, 7, 8].every((j) => area(binarize(s[j]!)) > 0.6 * area(person(0))), "dropouts filled");
    assert.equal(s[2]!.data[5], 0, "speck removed");
    // moving subject: the smoothed matte stays within `radius` frames of its true position
    const bb = (m: Mask) => { let x0 = MW; for (let i = 0; i < m.data.length; i++) if (m.data[i]! >= 128) x0 = Math.min(x0, i % MW); return x0; };
    assert.ok(Math.abs(bb(s[10]!) - (10 + 10)) <= 2);
    assert.deepEqual(temporalSmooth(seq, 9).map((m) => Array.from(m.data).join()), temporalSmooth(seq, 3).map((m) => Array.from(m.data).join()), "radius capped at 3");
  });
});

describe("timing pattern: bounded, never a future frame, clean reset, 6A maps reused", () => {
  const W = (mode: (typeof SUBJECT_MODES)[number], p: "SUBTLE" | "MEDIUM" | "STRONG", start = 10) => {
    const d = SUBJECT_PRESETS[mode][p];
    return { ...d, enabled: true, seed: 7, start, end: start + d.durationFrames };
  };
  it("every mode x preset only shows the current or an earlier frame inside the window, and nothing outside", () => {
    for (const m of SUBJECT_MODES)
      for (const p of SUBJECT_PRESETS_LIST) {
        const fx = W(m, p);
        assert.equal(subjectFrameAt(fx, fx.start - 1), null);
        assert.equal(subjectFrameAt(fx, fx.end), null, `${m} ${p}: the first frame after the window is clean`);
        for (let f = fx.start; f < fx.end; f++) {
          const q = subjectFrameAt(fx, f)!;
          assert.ok(q <= f && q >= fx.start, `${m} ${p} f${f} -> ${q}`);
        }
        assert.equal(subjectFrameAt(fx, fx.start), fx.start, "starts on the clean frame");
        assert.ok(Array.from({ length: fx.end - fx.start }, (_, i) => fx.start + i).some((f) => subjectFrameAt(fx, f) !== f), `${m} ${p} visible`);
      }
  });
  it("SUBJECT_TEMPORAL_STUTTER / linear crescendo / frame repeat equal the 6A temporalStutter / shrink / frameRepeat maps exactly", () => {
    const base = { id: "p", enabled: true, intensity: 1, mix: 1, seed: 1, envelope: { attack: 0, hold: 18, release: 0, curve: "linear" as const }, start: 10, end: 28 };
    for (const [mode, params] of [["SUBJECT_TEMPORAL_STUTTER", { type: "temporalStutter", loop: 4, repeats: 3, shrink: false }], ["SUBJECT_STUTTER_CRESCENDO", { type: "temporalStutter", loop: 4, repeats: 3, shrink: true }], ["SUBJECT_FRAME_REPEAT", { type: "frameRepeat", mode: "step", pattern: [3] }]] as const) {
      const fx = { enabled: true, start: 10, end: 28, mode, pattern: mode === "SUBJECT_FRAME_REPEAT" ? [3] : null, repeats: mode === "SUBJECT_FRAME_REPEAT" ? 1 : 3, interval: mode === "SUBJECT_FRAME_REPEAT" ? 3 : 4, crescendoCurve: "linear" as const, seed: 1 };
      for (let f = 10; f < 28; f++) assert.equal(subjectFrameAt(fx, f), remapFrame({ ...base, type: params.type, params } as ResolvedFx, f), `${mode} f${f}`);
    }
  });
  it("shaped crescendo tightens toward the end; seeded repeat patterns are deterministic and bounded", () => {
    const fx = { ...W("SUBJECT_STUTTER_CRESCENDO", "STRONG"), crescendoCurve: "exp" as const };
    const jumps = Array.from({ length: fx.end - fx.start }, (_, i) => fx.start + i - subjectFrameAt(fx, fx.start + i)!);
    assert.ok(Math.max(...jumps.slice(0, 8)) > Math.max(...jumps.slice(-6)), JSON.stringify(jumps));
    assert.deepEqual(seededPattern(3, 42), seededPattern(3, 42));
    assert.ok(seededPattern(3, 42).every((n) => n >= 2 && n <= 4));
    assert.notDeepEqual(seededPattern(3, 42), seededPattern(3, 43));
  });
});

describe("composite: non-generative, integer-exact, seam in the background", () => {
  const S = 4;
  const A = rgb(80, 160, (x, y) => [(x * 3) % 256, (y * 2) % 256, 90]);
  const B = rgb(80, 160, (x, y) => [(x * 3 + 40) % 256, (y * 2 + 7) % 256, 30]);
  const ma = (x: number) => { const m = emptyMask(20, 40); for (let y = 10; y < 30; y++) for (let xx = x; xx < x + 4; xx++) m.data[y * 20 + xx] = 255; return m; };
  it("alpha 0 -> exactly the clean pixel; alpha 255 -> exactly the repeated pixel; p = f -> the clean frame", () => {
    const zero = blend(A, B, new Uint8Array(80 * 160));
    assert.deepEqual(zero.data, A.data);
    const one = blend(A, B, new Uint8Array(80 * 160).fill(255));
    assert.deepEqual(one.data, B.data);
    const same = compositeFrame({ base: A, patch: A, bBase: ma(5), bPatch: ma(5), marginPx: 16, featherPx: 8, mix: 1, shift: { dx: 0, dy: 0 } });
    assert.deepEqual(same.out.data, A.data);
  });
  it("every output pixel is a convex blend of the two real frames (nothing generated); the region covers both poses", () => {
    const { out, region } = compositeFrame({ base: A, patch: B, bBase: ma(3), bPatch: ma(12), marginPx: 12, featherPx: 8, mix: 1, shift: { dx: 0, dy: 0 } });
    for (let i = 0; i < out.data.length; i++) assert.ok(out.data[i]! >= Math.min(A.data[i]!, B.data[i]!) && out.data[i]! <= Math.max(A.data[i]!, B.data[i]!));
    for (const m of [ma(3), ma(12)]) for (let i = 0; i < m.data.length; i++) if (m.data[i]) assert.equal(region.data[i], 255, "both poses fully inside the region (no double limbs)");
    const a = alphaFull(region, 80, 160, 1);
    assert.equal(a[0], 0, "far background untouched");
    assert.deepEqual(alphaFull(region, 80, 160, 0), new Uint8Array(80 * 160), "mix 0 = clean");
  });
  it("feather is small by default: the region edge is soft but narrow (no glow, no halo band)", () => {
    for (const m of SUBJECT_MODES) for (const p of SUBJECT_PRESETS_LIST) assert.ok(SUBJECT_PRESETS[m][p].featherPx <= 12 && SUBJECT_PRESETS[m][p].mix === 1 && SUBJECT_PRESETS[m][p].backgroundMode === "BACKGROUND_CONTINUES");
    // realistic scale: a 40 x 200 subject on a 270 x 480 matte (1/4 of 1080 x 1920), MEDIUM margins
    const big = emptyMask(270, 480);
    for (let y = 150; y < 350; y++) for (let x = 115; x < 155; x++) big.data[y * 270 + x] = 255;
    const r = regionMask(big, big, SUBJECT_PRESETS.SUBJECT_TEMPORAL_STUTTER.MEDIUM.marginPx, SUBJECT_PRESETS.SUBJECT_TEMPORAL_STUTTER.MEDIUM.featherPx, S);
    const soft = Array.from(r.data).filter((v) => v > 0 && v < 255).length;
    assert.ok(soft > 0 && soft < area(binarize(r)), "the soft band is narrower than the region it feathers");
  });
  it("frame-locked graphics are never carried by a shifted (aligned) patch; unshifted patches are untouched by protection", () => {
    const big = (x: number) => { const m = emptyMask(20, 40); for (let y = 5; y < 38; y++) for (let xx = x; xx < x + 12; xx++) m.data[y * 20 + xx] = 255; return m; };
    const logo = { x: 30, y: 100, w: 20, h: 20 };
    const withP = compositeFrame({ base: A, patch: B, bBase: big(4), bPatch: big(4), marginPx: 8, featherPx: 4, mix: 1, shift: { dx: 4, dy: 0 }, protect: [logo] });
    // neither the graphic's own position nor the position the shifted patch would carry it to
    for (let y = logo.y; y < logo.y + logo.h; y++) for (let x = logo.x; x < logo.x + logo.w + 4; x++) for (let c = 0; c < 3; c++) assert.equal(withP.out.data[(y * 80 + x) * 3 + c], A.data[(y * 80 + x) * 3 + c]);
    const unshifted = compositeFrame({ base: A, patch: B, bBase: big(4), bPatch: big(4), marginPx: 8, featherPx: 4, mix: 1, shift: { dx: 0, dy: 0 }, protect: [logo] });
    const plain = compositeFrame({ base: A, patch: B, bBase: big(4), bPatch: big(4), marginPx: 8, featherPx: 4, mix: 1, shift: { dx: 0, dy: 0 } });
    assert.deepEqual(unshifted.out.data, plain.out.data);
    assert.ok(withP.protectedPixels > 0 && unshifted.protectedPixels === 0, "withheld patch pixels are counted for review");
  });
  it("seam mismatch is 0 on identical backgrounds and large when the background moved", () => {
    const r = regionMask(ma(8), ma(8), 12, 8, S);
    assert.equal(seamMismatch(lumaSmall(A, S), lumaSmall(A, S), r, ma(8)).mean, 0);
    assert.ok(seamMismatch(lumaSmall(A, S), lumaSmall(B, S), r, ma(8)).mean > 10);
  });
  it("BACKGROUND_SMOOTH_CONTINUE alignment recovers a known camera translation; locked shots stay unshifted", () => {
    const tex = rgb(240, 400, (x, y) => [(Math.sin(x * 0.21) * 60 + Math.cos(y * 0.13) * 60 + 128) | 0, ((x * y) % 97) + 60, ((x + 2 * y) % 131) + 40]);
    const moved = shiftRgb(tex, 12, -8);
    const ex = emptyMask(60, 100);
    const s = estimateShift(lumaSmall(tex, S), lumaSmall(moved, S), ex, 32, S, { f: tex, p: moved });
    assert.deepEqual([s.dx, s.dy], [-12, 8]);
    const still = estimateShift(lumaSmall(tex, S), lumaSmall(tex, S), ex, 32, S, { f: tex, p: tex });
    assert.deepEqual([still.dx, still.dy, still.gain], [0, 0, 0]);
  });
});

describe("contract: music-event anchors, presets, inserts and 6A composition", () => {
  const ctx = { fps: rational(30), clips: [{ clipId: "clip:a", frameIn: 0, frameOut: 90 }, { clipId: "clip:b", frameIn: 90, frameOut: 150 }], musicEvents: new Map([["ev:drop", rational(2, 1)]]), audioStart: rational(0) };
  it("anchors resolve exactly like 6A effects (music event + offset, snap recorded); windows never cross a cut", () => {
    const e = resolveSubjectStutter(subjectFromPreset("SUBJECT_STUTTER_CRESCENDO", "MEDIUM", { id: "fx:c", clipId: "clip:a", anchor: { kind: "musicEvent", eventId: "ev:drop", offsetFrames: -18 } }), ctx);
    assert.deepEqual([e.start, e.end, e.timelineEnd], [42, 60, 60], "crescendo ends on the drop");
    assert.equal(e.anchorResolved.eventId, "ev:drop");
    assert.throws(() => resolveSubjectStutter(subjectFromPreset("SUBJECT_TEMPORAL_STUTTER", "STRONG", { id: "fx:x", clipId: "clip:a", anchor: { kind: "frame", frame: 80 } }), ctx), FxContractError);
    assert.throws(() => SubjectStutterSchema.parse({ ...subjectFromPreset("SUBJECT_TEMPORAL_STUTTER", "SUBTLE", { id: "fx:x", clipId: "clip:a", anchor: { kind: "frame", frame: 0 } }), featherPx: 80 }));
  });
  it("all exposed parameters exist; no source file hard-codes a project, artist, song or timecode", () => {
    const keys = Object.keys(SubjectStutterSchema.shape);
    for (const k of ["id", "subject", "anchor", "durationFrames", "mode", "pattern", "repeats", "interval", "crescendoCurve", "featherPx", "temporalSmoothing", "backgroundMode", "mix", "seed"]) assert.ok(keys.includes(k), k);
    for (const f of readdirSync("src/fx/subject")) {
      const src = readFileSync(`src/fx/subject/${f}`, "utf8");
      assert.doesNotMatch(src, /reference[ -]project|m_[0-9a-f]{8}|shot:0\d{3}/i, f);
      assert.doesNotMatch(src, /\bREF\b/, f);
    }
  });
  it("insert frames replace clean frames only inside the window", () => {
    const ins = [{ id: "fx:s", file: "inserts/s.mov", start: 20, end: 32 }];
    assert.equal(insertFrameAt(ins, 19), null);
    assert.deepEqual(insertFrameAt(ins, 20), { file: "inserts/s.mov", frame: 0 });
    assert.deepEqual(insertFrameAt(ins, 31), { file: "inserts/s.mov", frame: 11 });
    assert.equal(insertFrameAt(ins, 32), null);
  });
  it("subject stutter + rgbSplit / cameraPunch / echoTrail is valid; a whole-frame remap or hold on the same frames is rejected", () => {
    const one = [{ clipId: "clip:a", frameIn: 0, frameOut: 90 }];
    const c = { ...ctx, clips: one };
    const ins = [{ id: "fx:s", file: "s.mov", start: 20, end: 32 }];
    const ok = resolveEffects([fromPreset("rgbSplit", "MEDIUM", { id: "fx:r", clipId: "clip:a", anchor: { kind: "frame", frame: 22 } }), fromPreset("cameraPunch", "SUBTLE", { id: "fx:p", clipId: "clip:a", anchor: { kind: "frame", frame: 20 } }), fromPreset("echoTrail", "SUBTLE", { id: "fx:e", clipId: "clip:a", anchor: { kind: "frame", frame: 24 } })], c);
    validateInserts(ok, ins, 90);
    assert.throws(() => validateInserts(resolveEffects([fromPreset("temporalStutter", "MEDIUM", { id: "fx:t", clipId: "clip:a", anchor: { kind: "frame", frame: 28 } })], c), ins, 90), /cannot share frames/);
    assert.throws(() => validateInserts(resolveEffects([fromPreset("freezeFrame", "SUBTLE", { id: "fx:z", clipId: "clip:a", anchor: { kind: "frame", frame: 50 } }, { params: { type: "freezeFrame", sourceFrame: 25 } })], c), ins, 90), /inside subject effect/);
    assert.throws(() => validateInserts([], [...ins, { id: "fx:s2", file: "t.mov", start: 30, end: 40 }], 90), /overlapping/);
    assert.throws(() => validateInserts([], [{ id: "fx:s3", file: "t.mov", start: 85, end: 95 }], 90), /outside clip/);
  });
});

describe("mask QC, conflicts, overrides, cache identity", () => {
  it("a stable subject is MASK_OK; flicker, leakage and long bridging are MASK_REVIEW_RECOMMENDED", () => {
    const fr = scene(20);
    const tr = linkTracks(fr);
    const m = subjectMattes(fr, tr, selectSubject(fr, tr).trackId!);
    const sm = temporalSmooth(m.map((x) => x.matte), 2);
    const ok = maskQc({ trackId: "person:00", frames: m, smoothed: sm, used: [4, 5, 6, 7, 8, 9] });
    assert.equal(ok.state, "MASK_OK", ok.reasons.join());
    const flick = sm.map((x, i) => (i === 6 ? person(10 + i, 20, 5, 20) : x));
    assert.equal(maskQc({ trackId: "person:00", frames: m, smoothed: flick, used: [4, 5, 6, 7, 8] }).state, "MASK_REVIEW_RECOMMENDED");
    const leaky = m.map((x) => ({ ...x, others: person(10 + x.j, 20, 6, 60) }));
    assert.match(maskQc({ trackId: "person:00", frames: leaky, smoothed: sm, used: [4, 5, 6] }).reasons.join(), /leaks onto another person/);
    const bridged = m.map((x) => ({ ...x, basis: x.j >= 5 && x.j <= 8 ? ("BRIDGED" as const) : x.basis }));
    assert.match(maskQc({ trackId: "person:00", frames: bridged, smoothed: sm, used: [4, 5, 6, 7, 8, 9] }).reasons.join(), /consecutive frames without a Vision instance/);
    assert.match(maskQc({ trackId: "person:00", frames: m, smoothed: sm, used: [4, 5], seams: [{ f: 5, mean: MASK_QC.maxSeamMean + 3, p95: 10 }] }).reasons.join(), /background mismatch/);
    assert.match(maskQc({ trackId: "person:00", frames: m, smoothed: sm, used: [4, 5], graphicFrames: [5] }).reasons.join(), /frame-locked graphic/);
  });

  it("PRIMARY_SUBJECT_CONFLICT when the framing subject is another person; CONSISTENT when it is the same; NOT_COMPARABLE when off everyone", () => {
    const fr = scene(20, { second: () => 42 });
    const tr = linkTracks(fr);
    const s = selectSubject(fr, tr, { projectSubject: { point: { j: 0, x: 12, y: 50 }, note: "left" } });
    const col = (x: number) => Array.from({ length: 4 }, (_, k) => ({ j: k * 5, x, y: null }));
    assert.equal(checkConflict(fr, tr, s.trackId!, "guardrail", col(48)).state, "PRIMARY_SUBJECT_CONFLICT");
    assert.equal(checkConflict(fr, tr, s.trackId!, "guardrail", col(12 + 7)).state, "CONSISTENT");
    assert.equal(checkConflict(fr, tr, s.trackId!, "guardrail", [{ j: 3, x: 2, y: 2 }]).state, "NOT_COMPARABLE");
  });

  it("HUMAN_SUBJECT_OVERRIDE: only APPROVED is used, one per clip, auditable conflict resolution", () => {
    const base = { schemaVersion: "1.0.0", kind: "HUMAN_SUBJECT_OVERRIDES", projectId: "p", overrides: [{ id: "usr:a", kind: "HUMAN_SUBJECT_OVERRIDE", clipId: "clip:1", status: "PROPOSED", point: { j: 1, x: 2, y: 3 }, basis: "b" }] };
    const f = SubjectOverridesSchema.parse(base);
    assert.equal(approvedSubjectOverride(f, "clip:1"), null);
    assert.equal(f.overrides[0]!.resolvesConflict, false);
    const two = { ...base, overrides: [{ ...base.overrides[0]!, status: "APPROVED" }, { ...base.overrides[0]!, id: "usr:b", status: "APPROVED" }] };
    assert.throws(() => SubjectOverridesSchema.parse(two));
    assert.throws(() => SubjectOverridesSchema.parse({ ...base, overrides: [{ ...base.overrides[0]!, id: "subject-1" }] }), "ids are usr:");
  });

  it("the mask cache key changes with every identity component (source, range, tool, OS, params, code)", () => {
    const id: MaskIdentity = { kind: "PHASE_6B_SUBJECT_MASKS", source: { fingerprint: "f", range: [0, 90], size: [1080, 1920] }, tool: { binarySha256: "b", sourceSha256: "s", macosBuild: "26A", requests: ["r"] }, params: { downscale: 4, segmentation: true, computeDevice: "cpu" }, code: "c" };
    const k = maskCacheKey(id);
    const variants: MaskIdentity[] = [
      { ...id, source: { ...id.source, fingerprint: "g" } },
      { ...id, source: { ...id.source, range: [0, 60] } },
      { ...id, tool: { ...id.tool, binarySha256: "x" } },
      { ...id, tool: { ...id.tool, sourceSha256: "x" } },
      { ...id, tool: { ...id.tool, macosBuild: "27A" } },
      { ...id, tool: { ...id.tool, requests: ["other"] } },
      { ...id, params: { ...id.params, downscale: 2 } },
      { ...id, params: { ...id.params, segmentation: false } },
      { ...id, code: "d" },
    ];
    assert.equal(maskCacheKey({ ...id }), k);
    for (const v of variants) assert.notEqual(maskCacheKey(v), k, JSON.stringify(v));
  });

  it("PNG codec round-trips gray and RGB exactly", () => {
    const g = { w: 7, h: 5, channels: 1 as const, data: Uint8Array.from({ length: 35 }, (_, i) => (i * 37) % 256) };
    assert.deepEqual(decodePng(encodePng(g)), g);
    const c = { w: 3, h: 4, channels: 3 as const, data: Uint8Array.from({ length: 36 }, (_, i) => (i * 91) % 256) };
    assert.deepEqual(decodePng(encodePng(c)), c);
  });
});
