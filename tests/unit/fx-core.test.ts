/**
 * Phase 6A FX core + contract (pure): bounded, deterministic, drift-free, restrained, composable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FX_TYPES, type FxType, IDENTITY, type ResolvedFx, echoBlendFor, envelopeAt, flashAt, grainAt, grainPixels, hash01, layersAt, rgbSplitAt, sourceFrameAt, strengthAt, transformAt } from "../../src/fx/core.ts";
import { type Effect, EffectSchema, FX_PRESETS, PRESETS, fromPreset, resolveEffects } from "../../src/fx/contract.ts";
import { rational } from "../../src/time/rational.ts";

const CLIPS = [{ clipId: "clip:00", frameIn: 0, frameOut: 48 }, { clipId: "clip:01", frameIn: 48, frameOut: 105 }];
const ctx = { fps: rational(30), clips: CLIPS, musicEvents: new Map([["vocal:hit-1", rational(4039951, 44100)]]), audioStart: rational(90) };
const at = (type: FxType, preset: (typeof PRESETS)[number], frame: number, clipId = "clip:01", over: Partial<Effect> = {}) => fromPreset(type, preset, { id: `fx:${type.toLowerCase()}-${preset.toLowerCase()}`, clipId, anchor: { kind: "frame", frame } }, over);
const one = (e: Effect) => resolveEffects([e], ctx)[0]!;
const N = CLIPS[1]!.frameOut - CLIPS[1]!.frameIn;

describe("contract: schema, presets, invalid parameters", () => {
  it("every effect exists with SUBTLE / MEDIUM / STRONG presets that validate; SUBTLE is the gentlest", () => {
    assert.equal(FX_TYPES.length, 10);
    for (const t of FX_TYPES) for (const p of PRESETS) assert.doesNotThrow(() => EffectSchema.parse(at(t, p, 50)), `${t} ${p}`);
    for (const t of FX_TYPES) for (const p of PRESETS) assert.doesNotThrow(() => resolveEffects([at(t, p, 0, "clip:00", t === "filmTexture" ? { durationFrames: 40 } : {})], ctx), `${t} ${p} resolves`);
    assert.ok(FX_PRESETS.flashFrame.SUBTLE.params.type === "flashFrame" && FX_PRESETS.flashFrame.SUBTLE.params.mode === "exposure" && FX_PRESETS.flashFrame.SUBTLE.params.peakGain <= 1.35);
    for (const p of PRESETS) assert.ok(FX_PRESETS.echoTrail[p].params.type === "echoTrail" && FX_PRESETS.echoTrail[p].params.blend === "lighten", "echo presets never wash out");
    assert.ok(FX_PRESETS.microZoom.SUBTLE.params.type === "microZoom" && FX_PRESETS.microZoom.SUBTLE.params.peakScale <= 1.03);
    assert.ok(FX_PRESETS.rgbSplit.SUBTLE.params.type === "rgbSplit" && FX_PRESETS.rgbSplit.SUBTLE.params.offsetPx <= 4);
  });
  it("rejects unsafe or invalid parameters", () => {
    const bad: Array<Partial<Effect>> = [
      { params: { type: "microZoom", peakScale: 0.9, focusX: 0.5, focusY: 0.5 } }, // zoom out would reveal borders
      { params: { type: "flashFrame", mode: "screen", color: "#ffffff", peakOpacity: 0.95 } }, // whiteout cap
      { params: { type: "speedRamp", profile: "surge", amount: 0.9 } }, // could reverse time
      { params: { type: "rgbSplit", offsetPx: 60, angleDeg: 0 } },
      { intensity: 1.2 },
      { id: "FX bad" },
      { durationFrames: 0 },
    ];
    const types: FxType[] = ["microZoom", "flashFrame", "speedRamp", "rgbSplit", "echoTrail", "echoTrail", "echoTrail"];
    bad.forEach((b, i) => assert.throws(() => one(at(types[i]!, "SUBTLE", 50, "clip:01", b)), Error, JSON.stringify(b)));
    assert.throws(() => one(at("microZoom", "SUBTLE", 50, "clip:01", { params: { type: "flashFrame", mode: "exposure", peakGain: 1.3 } })), /params are for flashFrame/);
    assert.throws(() => one(at("flashFrame", "SUBTLE", 50, "clip:01", { params: { type: "flashFrame", mode: "exposure", peakGain: 3 } })), Error, "exposure gain cap");
    assert.throws(() => resolveEffects([at("echoTrail", "MEDIUM", 50, "clip:01", { params: { type: "echoTrail", trails: 3, spacing: 2, decay: 0.6, blend: "screen" }, mix: 0.6 })], ctx), /washes the frame out/);
    assert.throws(() => one(at("freezeFrame", "SUBTLE", 50, "clip:01", { mix: 0.5 })), /cannot be mixed/);
  });
});

describe("bounded, reset, zero-intensity, disable", () => {
  for (const t of FX_TYPES) {
    it(`${t}: no influence outside its window, identity at intensity 0 and when disabled`, () => {
      const d = t === "filmTexture" ? { durationFrames: 20 } : {};
      const e = one(at(t, "MEDIUM", 60, "clip:01", d));
      const zero = one(at(t, "MEDIUM", 60, "clip:01", { intensity: 0, ...d }));
      const off: ResolvedFx = { ...e, enabled: false };
      for (let f = 0; f < N; f++) {
        const inside = f >= e.start && f < e.end;
        for (const fx of inside ? [zero, off] : [e, zero, off]) {
          assert.equal(sourceFrameAt([fx], f, N), f, `${t} frame ${f}`);
          assert.deepEqual(transformAt([fx], f, 1080, 1920), IDENTITY);
          assert.equal(rgbSplitAt([fx], f), null);
          assert.equal(flashAt([fx], f), null);
          assert.equal(grainAt([fx], f), null);
          assert.deepEqual(layersAt([fx], f, N).map((l) => l.frame), [f]);
        }
      }
      assert.equal(envelopeAt(e, e.end), 0, "first clean frame after the effect");
      assert.equal(envelopeAt(e, e.start - 1), 0);
    });
  }
  it("disabled effects are dropped at resolution", () => {
    assert.equal(resolveEffects([at("flashFrame", "SUBTLE", 60, "clip:01", { enabled: false })], ctx).length, 0);
  });
  it("envelope: attack reaches 1, release never hits 0 inside, hits are at full level on frame 0", () => {
    const e = one(at("microZoom", "MEDIUM", 60));
    const vals = Array.from({ length: e.end - e.start }, (_, t) => envelopeAt(e, e.start + t));
    assert.ok(vals.every((v) => v > 0 && v <= 1));
    assert.equal(Math.max(...vals), 1);
    const hit = one(at("flashFrame", "MEDIUM", 60));
    assert.equal(envelopeAt(hit, hit.start), 1);
    assert.ok(strengthAt(hit, hit.start) <= hit.intensity);
  });
});

describe("time remaps: exact frame maps, no drift, bounded to the window", () => {
  const map = (e: ResolvedFx) => Array.from({ length: N }, (_, f) => sourceFrameAt([e], f, N));
  it("frameRepeat step [3]: each frame held 3x, re-aligned at the window end", () => {
    const e = one(at("frameRepeat", "MEDIUM", 60));
    const m = map(e);
    assert.deepEqual(m.slice(e.start, e.end), [12, 12, 12, 15, 15, 15, 18, 18, 18]);
    assert.equal(m[e.end], e.end);
    const hold = one(at("frameRepeat", "MEDIUM", 60, "clip:01", { params: { type: "frameRepeat", mode: "hold", sourceFrame: 20 } }));
    assert.deepEqual(map(hold).slice(hold.start, hold.end), Array(9).fill(20));
  });
  it("temporalStutter: 2-frame and shrinking loops, never ahead of the timeline, aligned after", () => {
    const e = one(at("temporalStutter", "SUBTLE", 60));
    assert.deepEqual(map(e).slice(e.start, e.end), [12, 13, 12, 13, 16, 17, 16, 17]);
    const s = one(at("temporalStutter", "STRONG", 60));
    const m = map(s).slice(s.start, s.end);
    assert.equal(m.length, 18);
    m.forEach((p, i) => assert.ok(p >= s.start && p <= s.start + i, "never shows a future frame"));
    assert.equal(map(s)[s.end], s.end);
  });
  it("freezeFrame: the exact start frame (or the given frame) for the whole window", () => {
    const e = one(at("freezeFrame", "MEDIUM", 60));
    assert.deepEqual(map(e).slice(e.start, e.end), Array(8).fill(12));
    const g = one(at("freezeFrame", "MEDIUM", 60, "clip:01", { params: { type: "freezeFrame", sourceFrame: 30 } }));
    assert.deepEqual(new Set(map(g).slice(g.start, g.end)), new Set([30]));
  });
  it("speedRamp: monotone, inside the window, 1x at both ends; surge runs ahead first, dip behind", () => {
    for (const profile of ["surge", "dip"] as const) {
      const e = one(at("speedRamp", "STRONG", 50, "clip:01", { params: { type: "speedRamp", profile, amount: 0.8 } }));
      const m = map(e).slice(e.start, e.end);
      m.slice(1).forEach((p, i) => assert.ok(p >= m[i]!));
      assert.ok(m.every((p) => p >= e.start && p < e.end));
      assert.equal(m[0], e.start);
      assert.equal(map(e)[e.end], e.end);
      const q = Math.floor(m.length / 4);
      assert.ok(profile === "surge" ? m[q]! > e.start + q : m[q]! < e.start + q, profile);
    }
  });
});

describe("determinism and seeded texture", () => {
  it("hash is unsigned and uniform in [0, 1); grain tiles are centred on mid-grey (neutral exposure)", () => {
    let s = 0;
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = hash01(7, i, 3);
      assert.ok(v >= 0 && v < 1);
      s += v;
      bins[Math.floor(v * 10)]++;
    }
    assert.ok(Math.abs(s / 100_000 - 0.5) < 0.01);
    assert.ok(bins.every((b) => Math.abs(b - 10_000) < 600), bins.join(","));
    const px = grainPixels(256, 256, 3, 9, 0.3);
    let m = 0;
    for (let i = 0; i < px.length; i += 4) m += px[i + 1]!;
    assert.ok(Math.abs(m / (px.length / 4) - 128) < 2, `grain mean ${m / (px.length / 4)}`);
  });
  it("hash noise and grain tiles are pure functions of (seed, frame)", () => {
    assert.equal(hash01(7, 3, 2), hash01(7, 3, 2));
    assert.notEqual(hash01(7, 3, 2), hash01(8, 3, 2));
    const a = grainPixels(64, 32, 11, 5, 0.2);
    assert.deepEqual(a, grainPixels(64, 32, 11, 5, 0.2));
    assert.notDeepEqual(a, grainPixels(64, 32, 12, 5, 0.2));
    assert.notDeepEqual(a, grainPixels(64, 32, 11, 6, 0.2));
    const mono = grainPixels(16, 16, 1, 1, 0);
    for (let i = 0; i < 256; i++) assert.ok(mono[i * 4] === mono[i * 4 + 1] && mono[i * 4 + 1] === mono[i * 4 + 2], "luminance-only grain at chroma 0");
    const g = one(at("filmTexture", "MEDIUM", 50, "clip:01", { durationFrames: 20 }));
    assert.deepEqual(grainAt([g], 55), grainAt([g], 55));
  });
});

describe("spatial transforms never reveal borders", () => {
  it("microZoom x cameraPunch cover scale holds for every frame, including off-centre focus", () => {
    const z = one(at("microZoom", "STRONG", 50, "clip:01", { params: { type: "microZoom", peakScale: 1.09, focusX: 0.2, focusY: 0.8 } }));
    const p = one({ ...at("cameraPunch", "STRONG", 50), id: "fx:punch" });
    for (let f = 0; f < N; f++) {
      const t = transformAt([z, p], f, 1080, 1920);
      const edges = [t.tx / (t.originX * 1080), -t.tx / ((1 - t.originX) * 1080), t.ty / (t.originY * 1920), -t.ty / ((1 - t.originY) * 1920)];
      assert.ok(t.scale >= 1 + Math.max(0, ...edges) - 1e-9, `frame ${f}`);
    }
  });
});

describe("music-event anchoring and cut preservation", () => {
  it("anchors to a referenced event with the render-frame snap rule and records the snap", () => {
    const e = resolveEffects([fromPreset("flashFrame", "SUBTLE", { id: "fx:flash-b1", clipId: "clip:01", anchor: { kind: "musicEvent", eventId: "vocal:hit-1" } })], ctx)[0]!;
    assert.equal(e.timelineStart, 48); // song 1:21.609 -> timeline 1.609 s -> frame 48 (-8.87 ms)
    assert.equal(e.anchor.snapErrorMs, -8.87);
    assert.equal(e.start, 0);
    const pre = resolveEffects([fromPreset("echoTrail", "SUBTLE", { id: "fx:echo", clipId: "clip:01", anchor: { kind: "musicEvent", eventId: "vocal:hit-1", offsetFrames: 2 } })], ctx)[0]!;
    assert.equal(pre.timelineStart, 50);
    assert.throws(() => resolveEffects([fromPreset("flashFrame", "SUBTLE", { id: "fx:x", clipId: "clip:01", anchor: { kind: "musicEvent", eventId: "vocal:nope" } })], ctx), /not found/);
  });
  it("an effect can never cross a cut (window must stay inside its clip)", () => {
    assert.throws(() => one(at("microZoom", "STRONG", 40, "clip:00")), /never cross a cut/);
    assert.throws(() => one(at("frameRepeat", "MEDIUM", 100, "clip:01")), /never cross a cut/);
  });
});

describe("composition", () => {
  it("fixed order: echo samples the remapped timeline; zoom and punch combine", () => {
    const st = one(at("frameRepeat", "STRONG", 60));
    const ec = one({ ...at("echoTrail", "MEDIUM", 60), id: "fx:echo" });
    const f = st.start + 5;
    const layers = layersAt([st, ec], f, N);
    assert.equal(layers[0]!.frame, sourceFrameAt([st], f, N));
    for (const l of layers.slice(1)) assert.equal(l.frame, sourceFrameAt([st], Math.max(0, f - (layers.indexOf(l)) * 2), N));
    const z = one(at("microZoom", "MEDIUM", 60));
    const p = one({ ...at("cameraPunch", "MEDIUM", 60), id: "fx:punch" });
    const both = transformAt([z, p], 62, 1080, 1920);
    assert.ok(both.scale > transformAt([z], 62, 1080, 1920).scale - 1e-9);
  });
  it("fails loudly: overlapping remaps, duplicate spatial effects, flash rate, echo inside freeze", () => {
    assert.throws(() => resolveEffects([at("frameRepeat", "MEDIUM", 60), { ...at("temporalStutter", "MEDIUM", 64), id: "fx:st" }], ctx), /overlapping time remaps/);
    assert.throws(() => resolveEffects([at("microZoom", "MEDIUM", 60), { ...at("microZoom", "SUBTLE", 62), id: "fx:z2" }], ctx), /two overlapping microZoom/);
    const flashes = [50, 57, 64, 71].map((fr, i) => ({ ...at("flashFrame", "SUBTLE", fr), id: `fx:f${i}` }));
    assert.throws(() => resolveEffects(flashes, ctx), /photosensitivity/);
    assert.doesNotThrow(() => resolveEffects(flashes.slice(0, 3), ctx));
    assert.throws(() => resolveEffects([at("freezeFrame", "STRONG", 60), { ...at("echoTrail", "SUBTLE", 60, "clip:01", { durationFrames: 10 }), id: "fx:e" }], ctx), /frozen frame is invisible/);
    assert.doesNotThrow(() => resolveEffects([at("microZoom", "SUBTLE", 60), { ...at("rgbSplit", "SUBTLE", 60), id: "fx:rgb" }, { ...at("filmTexture", "SUBTLE", 50, "clip:01", { durationFrames: 30 }), id: "fx:grain" }], ctx));
  });
  it("deterministic resolution", () => {
    const set = [at("microZoom", "SUBTLE", 60), { ...at("echoTrail", "MEDIUM", 70), id: "fx:e2" }];
    assert.equal(JSON.stringify(resolveEffects(set, ctx)), JSON.stringify(resolveEffects(set, ctx)));
  });
});

describe("echoTrail on high-key footage (Phase 6A real-motion re-review)", () => {
  it("darken is available and recommended for bright footage; lighten stays the preset default", () => {
    assert.equal(echoBlendFor(0.02), "lighten");
    assert.equal(echoBlendFor(0.249), "lighten");
    assert.equal(echoBlendFor(0.35), "darken", "a dark subject on a white backdrop (mean luma ~120) is high-key");
    for (const p of PRESETS) assert.equal((FX_PRESETS.echoTrail[p].params as { blend: string }).blend, "lighten");
    const e = { ...fromPreset("echoTrail", "MEDIUM", { id: "fx:dk", clipId: "clip:x", anchor: { kind: "frame", frame: 10 } }), params: { type: "echoTrail" as const, trails: 3, spacing: 2, decay: 0.6, blend: "darken" as const } };
    assert.doesNotThrow(() => EffectSchema.parse(e));
    const [r] = resolveEffects([e], { fps: rational(30), clips: [{ clipId: "clip:x", frameIn: 0, frameOut: 60 }], musicEvents: new Map(), audioStart: rational(0) });
    assert.ok(layersAt([r!], 16, 60).slice(1).every((l) => l.blend === "darken"));
  });
});
