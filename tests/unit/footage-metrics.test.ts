import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FOOTAGE_CONFIG, buildFootageAnalysis, detectBoundaries } from "../../src/footage/build.ts";
import { dHash, downsample, estimateMotion, frameBorders, frameStats, hamming } from "../../src/footage/frame-metrics.ts";
import { FootageAnalysisSchema } from "../../src/footage/schema.ts";
import { FrameSeries } from "../../src/footage/series.ts";
import { rational } from "../../src/time/rational.ts";

const W = 160;
const H = 90;

/** Smooth-plus-detail texture, deterministic per seed; (ox, oy) shifts the content. */
function texture(seed: number, ox = 0, oy = 0, w = W, h = H): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - ox;
      const v = y - oy;
      const val =
        110 +
        50 * Math.sin(u * (0.09 + seed * 0.013) + seed) * Math.cos(v * (0.11 + seed * 0.007)) +
        30 * Math.sin((u + v) * 0.31 + seed * 1.7) +
        20 * Math.sin(u * 0.7 - v * 0.45 + seed * 0.3);
      px[y * w + x] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
  return px;
}
const withBorders = (px: Uint8Array, l: number, r: number, t: number, b: number) => {
  const out = px.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < l || x >= W - r || y < t || y >= H - b) out[y * W + x] = 2;
  return out;
};
const scaleLuma = (px: Uint8Array, k: number, add = 0) => px.map((v) => Math.max(0, Math.min(255, Math.round(v * k + add))));
function series(frames: Uint8Array[]): FrameSeries {
  const s = new FrameSeries(W, H);
  for (const f of frames) s.push(f);
  return s;
}
const build = (frames: Uint8Array[], fps = 25) =>
  buildFootageAnalysis(series(frames), { pts: frames.map((_, i) => i), lastDuration: 1, timeBase: rational(1, fps) }, {
    mediaId: "m_test", fingerprint: "f".repeat(64), fileName: "t", streamIndex: 0, stored: { w: W * 4, h: H * 4 }, display: { w: W * 4, h: H * 4 },
    rotationClockwise: 0, orientation: "landscape", frameRateMode: "CFR", codec: "synthetic", fieldOrder: null, bitRate: null,
    analyzer: { name: "bali-footage-intelligence", version: "1.0.0", implementation: "x", configHash: "y", config: {}, ffmpeg: { path: "-", version: "-" } },
    generatedAt: "t",
  });
const hold = (f: Uint8Array, n: number, jitter = 0) => Array.from({ length: n }, (_, i) => (jitter ? texture(0, Math.round(jitter * Math.sin(i * 2.1)), Math.round(jitter * Math.cos(i * 1.3))) : f));
const pan = (seed: number, n: number, pxPerFrame: number) => Array.from({ length: n }, (_, i) => texture(seed, i * pxPerFrame, 0));

describe("frame metrics", () => {
  it("measures black borders (pillarbox, letterbox, none)", () => {
    const t = texture(1);
    assert.deepEqual(frameBorders(withBorders(t, 20, 20, 0, 0), W, H), { x: 20, y: 0, w: 120, h: 90 });
    assert.deepEqual(frameBorders(withBorders(t, 0, 0, 11, 11), W, H), { x: 0, y: 11, w: 160, h: 68 });
    assert.deepEqual(frameBorders(t, W, H), { x: 0, y: 0, w: 160, h: 90 });
    assert.equal(frameBorders(new Uint8Array(W * H), W, H).w, 0);
  });

  it("separates sharp from blurred, and measures clipping", () => {
    const t = texture(2);
    let blurred = t;
    for (let pass = 0; pass < 6; pass++) {
      const src = blurred;
      blurred = src.map((_, i) => {
        const x = i % W;
        const y = (i / W) | 0;
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) { sum += src[yy * W + xx]!; n++; }
        }
        return Math.round(sum / n);
      });
    }
    const full = { x: 0, y: 0, w: W, h: H };
    assert.ok(frameStats(blurred, W, full).sharpness < 0.3 * frameStats(t, W, full).sharpness, `${frameStats(blurred, W, full).sharpness} vs ${frameStats(t, W, full).sharpness}`);
    assert.ok(frameStats(scaleLuma(t, 1.6, 90), W, full).clipHigh > 0.3, "overexposed");
    assert.ok(frameStats(scaleLuma(t, 0.3, -30), W, full).crushLow > 0.3, "underexposed");
    const ok = frameStats(t, W, full);
    assert.ok(ok.clipHigh < 0.01 && ok.crushLow < 0.01);
  });

  it("estimates global translation (sub-pixel) and the difference hash is stable", () => {
    const half = (px: Uint8Array) => downsample(px, W, H, W / 2, H / 2);
    const m = estimateMotion(half(texture(3, 0, 0)), half(texture(3, 6, -4)), W / 2, H / 2);
    assert.ok(Math.abs(m.dx - 6) <= 1 && Math.abs(m.dy + 4) <= 1, `${m.dx},${m.dy}`);
    assert.ok(m.residual < m.rawDiff / 3);
    const a = texture(4);
    assert.equal(hamming(dHash(a, W, H, { x: 0, y: 0, w: W, h: H }), dHash(scaleLuma(a, 1, 3), W, H, { x: 0, y: 0, w: W, h: H })), 0);
    assert.ok(hamming(dHash(a, W, H, { x: 0, y: 0, w: W, h: H }), dHash(texture(9), W, H, { x: 0, y: 0, w: W, h: H })) > 10);
  });
});

describe("shot boundaries", () => {
  it("finds a hard cut exactly", () => {
    const { cuts } = detectBoundaries(series([...pan(1, 30, 0.5), ...pan(7, 30, 0.5)]), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.deepEqual(cuts.map((c) => [c.frame, c.type]), [[30, "hard_cut"]]);
  });

  it("does not cut on a gradual exposure change", () => {
    const t = texture(1);
    const frames = Array.from({ length: 60 }, (_, i) => scaleLuma(t, 0.6 + i * 0.012));
    assert.equal(detectBoundaries(series(frames), 25, DEFAULT_FOOTAGE_CONFIG).cuts.length, 0);
  });

  it("does not cut on a flash frame (and records the suppression)", () => {
    const t = texture(5);
    const frames = hold(t, 40).map((f, i) => (i === 20 ? scaleLuma(f, 0.2, 220) : f));
    const r = detectBoundaries(series(frames), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.equal(r.cuts.length, 0);
    assert.ok(r.suppressed.length >= 1);
  });

  it("finds a cut followed immediately by fast camera motion (calmer-side threshold)", () => {
    const frames = [...pan(1, 30, 0.5), ...pan(6, 30, 2)];
    const { cuts } = detectBoundaries(series(frames), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.deepEqual(cuts.map((c) => c.frame), [30]);
  });

  it("finds a short dip to black (2 frames + fade-in) between different scenes, but not a same-scene blackout", () => {
    const black = new Uint8Array(W * H);
    const fadeIn = Array.from({ length: 10 }, (_, k) => scaleLuma(texture(8), (k + 1) / 10));
    const dip = detectBoundaries(series([...hold(texture(1), 25), black, black, ...fadeIn, ...hold(texture(8), 20)]), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.deepEqual(dip.cuts.map((c) => [c.frame, c.type]), [[25, "fade_through_black"]]);
    const blink = detectBoundaries(series([...hold(texture(1), 25), black, ...hold(texture(1), 25)]), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.equal(blink.cuts.length, 0);
    assert.ok(blink.suppressed.some((x) => /same content/.test(x.reason)));
  });

  it("marks a fade through black between different content", () => {
    const black = new Uint8Array(W * H);
    const r = detectBoundaries(series([...hold(texture(1), 20), ...hold(black, 6), ...hold(texture(8), 20)]), 25, DEFAULT_FOOTAGE_CONFIG);
    assert.deepEqual(r.cuts.map((c) => [c.frame, c.type]), [[20, "fade_through_black"]]);
  });
});

describe("shot and media aggregation", () => {
  it("measures pillarbox active picture, static video, motion speed and shake", () => {
    const pillar = build(Array.from({ length: 30 }, (_, i) => withBorders(texture(1, i * 0.8, 0), 20, 20, 0, 0)));
    assert.equal(pillar.activePicture.type, "pillarbox");
    assert.deepEqual(pillar.activePicture.activeRect, { x: 80, y: 0, w: 480, h: 360 }); // display px (x4)
    assert.equal(pillar.activePicture.activeAspect, 1.333);

    const still = build(hold(texture(2), 50));
    assert.equal(still.static.staticImageVideo, true);
    assert.equal(still.static.freezeRegions.length, 1);
    assert.equal(still.shots.length, 1);

    const moving = build(pan(3, 50, 2)); // 2 px/frame of 160 at 25 fps = 0.3125 widths/s
    const sp = moving.shots[0]!.motion.globalSpeed.p50;
    assert.ok(Math.abs(sp - 0.3125) < 0.05, `speed ${sp}`);
    assert.ok(moving.shots[0]!.motion.directionalConsistency > 0.95);
    assert.equal(moving.shots[0]!.stability.class, "stable");

    const shaky = build(hold(texture(0), 50, 4));
    assert.equal(shaky.shots[0]!.stability.class, "shaky");
    assert.ok(shaky.shots[0]!.motion.directionalConsistency < 0.5);
  });

  it("is deterministic, schema-valid and uses exact frame times", () => {
    const frames = [...pan(1, 25, 1), ...pan(6, 25, 1)];
    const a = build(frames);
    assert.equal(JSON.stringify(build(frames)), JSON.stringify(a));
    assert.doesNotThrow(() => FootageAnalysisSchema.parse(a));
    assert.deepEqual(a.shots.map((s) => [s.start, s.end]), [[rational(0), rational(1)], [rational(1), rational(2)]]);
    assert.deepEqual(a.shots[1]!.duration, rational(1));
  });
});
