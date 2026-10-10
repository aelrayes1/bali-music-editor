/**
 * Phase 11.75 highlight-selective bloom (pure): the anti-ghosting regression (a thin bright line and a
 * point bloom monotonically with distance under the dense kernel; the feasibility probe's sparse 4 px
 * kernel, kept as the positive control, produces periodic copies), highlight-only response, frame
 * edges (no streaks), strength scaling, white / darkening limits, the DCTL parameter contract,
 * determinism and the safety gates.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBloom, BLOOM_SHAPE, CEILING, ceilingFactor, latticeRatio, liftRGB, BloomParamError, type BloomParams, bloomDctl, bloomField, denseTaps, evaluateBloomGates, ghostIndex, sparseReferenceTaps, validateBloomParams } from "../../src/grade/bloom.ts";

const P: BloomParams = { ...BLOOM_SHAPE, strength: 1 };
const W = 160;
const H = 160;
const frame = (fill: (x: number, y: number) => number) => {
  const f = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f.fill(fill(x, y), (y * W + x) * 3, (y * W + x) * 3 + 3);
  return f;
};
const lumaField = (F: Float32Array) => {
  const L = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.2126 * F[i * 3]! + 0.7152 * F[i * 3 + 1]! + 0.0722 * F[i * 3 + 2]!;
  return L;
};
// kernels at 1920 scale regardless of the small test frame, so distances are the production ones
const dense = denseTaps(BLOOM_SHAPE, 1);
const sparse = sparseReferenceTaps(1);
const localMaxima = (xs: number[]) => xs.filter((v, i) => i > 0 && i < xs.length - 1 && v > xs[i - 1]! + 1e-12 && v > xs[i + 1]! + 1e-12).length;

describe("anti-ghosting regression", () => {
  const line = frame((x, y) => (y === 80 && x >= 20 && x < 140 ? 255 : 10));
  it("a 1 px bright line blooms monotonically with distance (dense kernel)", () => {
    const L = lumaField(bloomField(line, W, H, BLOOM_SHAPE, dense));
    const profile = Array.from({ length: 30 }, (_, k) => L[(81 + k) * W + 80]!);
    for (let k = 1; k < profile.length; k++) assert.ok(profile[k]! <= profile[k - 1]! + 1e-12, `non-monotonic at +${k + 1} px`);
    assert.equal(localMaxima(profile), 0);
    assert.ok(ghostIndex(L, W, H, 1e-4) < 0.12);
  });
  it("positive control: the probe's sparse 4 px kernel produces periodic copies of the same line", () => {
    const L = lumaField(bloomField(line, W, H, BLOOM_SHAPE, sparse));
    const profile = Array.from({ length: 30 }, (_, k) => L[(81 + k) * W + 80]!);
    assert.ok(localMaxima(profile) >= 3, "the sparse kernel must show the comb (else the regression cannot detect ghosting)");
    assert.ok(ghostIndex(L, W, H, 1e-4) > 0.3);
  });
  it("a single-pixel light blooms radially and monotonically; vertical lines too", () => {
    const pt = lumaField(bloomField(frame((x, y) => (x === 80 && y === 80 ? 255 : 0)), W, H, BLOOM_SHAPE, dense));
    const ray = Array.from({ length: 24 }, (_, k) => pt[80 * W + 80 + k]!);
    for (let k = 1; k < ray.length; k++) assert.ok(ray[k]! <= ray[k - 1]! + 1e-12);
    assert.ok(Math.abs(pt[80 * W + 90]! - pt[90 * W + 80]!) < 1e-9, "radial symmetry");
    const v = lumaField(bloomField(frame((x) => (x === 80 ? 255 : 0)), W, H, BLOOM_SHAPE, dense));
    assert.equal(localMaxima(Array.from({ length: 30 }, (_, k) => v[80 * W + 81 + k]!)), 0);
  });
  it("frame edges: a light on the edge blooms like an interior light (outside = black, no streak)", () => {
    const edge = lumaField(bloomField(frame((x, y) => (x === 0 && y === 80 ? 255 : 0)), W, H, BLOOM_SHAPE, dense));
    const mid = lumaField(bloomField(frame((x, y) => (x === 80 && y === 80 ? 255 : 0)), W, H, BLOOM_SHAPE, dense));
    for (const d of [1, 5, 12, 20]) {
      assert.ok(Math.abs(edge[80 * W + d]! - mid[80 * W + 80 + d]!) < 1e-9, `inward ${d}`);
      assert.ok(Math.abs(edge[(80 + d) * W]! - mid[(80 + d) * W + 80]!) < 1e-9, `along the edge ${d}`);
    }
  });
});

describe("highlight-only response and blending", () => {
  it("nothing at or below the threshold contributes (a frame just under it is unchanged)", () => {
    const f = frame(() => Math.floor(0.79 * 255));
    assert.deepEqual(applyBloom(f, bloomField(f, W, H, BLOOM_SHAPE, dense), 3), f);
  });
  it("strength 0 is the identity; output rises monotonically with strength; never darkens, never exceeds white", () => {
    const f = frame((x, y) => (Math.abs(x - 80) < 3 && Math.abs(y - 80) < 3 ? 250 : (x * 3 + y) % 180));
    const F = bloomField(f, W, H, BLOOM_SHAPE, dense);
    assert.deepEqual(applyBloom(f, F, 0), f);
    let prev: Uint8Array = f;
    for (const s of [0.5, 1, 2, 3]) {
      const o = applyBloom(f, F, s);
      for (let i = 0; i < f.length; i++) {
        assert.ok(o[i]! >= prev[i]!, "monotonic in strength");
        assert.ok(o[i]! >= f[i]! && o[i]! <= 255);
      }
      prev = o;
    }
  });
  it("is deterministic (identical bytes for identical input)", () => {
    const f = frame((x, y) => (x === y ? 255 : 30));
    assert.deepEqual(applyBloom(f, bloomField(f, W, H, BLOOM_SHAPE, dense), 1.5), applyBloom(f, bloomField(f, W, H, BLOOM_SHAPE, dense), 1.5));
  });
});

describe("highlight ceiling (clipping guard)", () => {
  it("never lifts a channel to or above the ceiling; a pixel with any channel at or above it is untouched; small additions equal the screen blend", () => {
    for (let v = 0; v <= 255; v += 5)
      for (const add of [0.001, 0.05, 0.3, 1]) {
        const src = v / 255;
        const [r, g, b] = liftRGB(src, 0.3, 0.1, add, add, add);
        if (src >= CEILING) assert.deepEqual([r, g, b], [src, 0.3, 0.1]);
        else for (const o of [r, g, b]) assert.ok(o < CEILING, `v ${v} add ${add}`);
        assert.ok(r >= src && g >= 0.3 && b >= 0.1);
      }
    const screen = (src: number, add: number) => 1 - (1 - src) * (1 - add);
    // equal to the screen blend up to a second-order term far below one 8-bit level (1/255)
    assert.ok(Math.abs(liftRGB(0.2, 0.2, 0.2, 0.002, 0.002, 0.002)[1] - screen(0.2, 0.002)) < 1e-5);
    assert.ok(Math.abs(ceilingFactor(1e-4) - (1 - Math.exp(-1e-4)) / 1e-4) < 1e-9);
    // a bright wash (235-249) under a very strong bloom produces no new clipping (>= 250)
    const wash = frame((x, y) => (Math.abs(x - 80) < 40 && Math.abs(y - 80) < 40 ? 245 : 238));
    const o = applyBloom(wash, bloomField(wash, W, H, BLOOM_SHAPE, dense), 12);
    for (let i = 0; i < o.length; i++) assert.ok(o[i]! < 250 || wash[i]! >= 250);
  });
  it("hue-preserving: the added light keeps its colour proportions, and a saturated light core is not whitened", () => {
    // a dark pixel receiving red glow: the increment keeps the red : green : blue proportion of the glow
    const [r, g, b] = liftRGB(0.1, 0.1, 0.1, 0.8, 0.2, 0.1);
    assert.ok(Math.abs((r - 0.1) / (g - 0.1) - 4) < 1e-9 && Math.abs((g - 0.1) / (b - 0.1) - 2) < 1e-9);
    // a red light core at the ceiling in red: untouched (a per-channel ceiling would lift green / blue and whiten it)
    assert.deepEqual(liftRGB(0.96, 0.4, 0.4, 0.9, 0.4, 0.4), [0.96, 0.4, 0.4]);
    // a coloured core below the ceiling keeps its hue direction: the increments are proportional to (1 - src) * add
    const c = liftRGB(0.9, 0.5, 0.3, 1, 1, 1);
    const inc = [(1 - 0.9), (1 - 0.5), (1 - 0.3)];
    assert.ok(Math.abs((c[0] - 0.9) / inc[0]! - (c[2] - 0.3) / inc[2]!) < 1e-12);
  });
  it("the lattice ratio separates a 4 px comb from a smooth falloff", () => {
    const comb = new Float32Array(W * H);
    const smooth = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        comb[y * W + x] = 2 + (y % 4 === 0 ? 18 : 0) + 0.05 * y;
        smooth[y * W + x] = 30 * Math.exp(-((y - 80) ** 2) / 800);
      }
    assert.ok(latticeRatio(comb, W, H) > 1.5);
    assert.ok(latticeRatio(smooth, W, H) < 0.6);
  });
});

describe("DCTL parameter contract", () => {
  it("the generated shader carries exactly the parameters and the dense-disc normalisation", () => {
    const src = bloomDctl("bali_test", { ...BLOOM_SHAPE, strength: 1.25 });
    for (const [k, v] of [["THRESH", BLOOM_SHAPE.threshold], ["KNEE", BLOOM_SHAPE.knee], ["STRENGTH", 1.25], ["SIGMA_CORE", BLOOM_SHAPE.sigmaCore], ["SIGMA_HALO", BLOOM_SHAPE.sigmaHalo], ["HALO_SHARE", BLOOM_SHAPE.haloShare], ["RADIUS", BLOOM_SHAPE.radius]] as const) assert.ok(src.includes(`#define ${k} ${v.toFixed(6)}f`), k);
    assert.ok(src.includes(`#define WSUM_1920 ${dense.wsum.toFixed(9)}f`));
    assert.ok(src.includes(`#define CEILING ${CEILING.toFixed(6)}f`) && src.includes("float3 o = liftRGB(r0, g0, b0, ar, ag, ab);") && src.includes("return make_float3(o.x, o.y, o.z);"));
    assert.ok(!/TIMELINE_FRAME_INDEX|static|\[\s*\d+\s*\]/.test(src), "no frame memory, no state");
    assert.equal(src, bloomDctl("bali_test", { ...BLOOM_SHAPE, strength: 1.25 }));
  });
  it("refuses unsafe parameters", () => {
    assert.throws(() => validateBloomParams({ ...P, threshold: 0.5 }), BloomParamError);
    assert.throws(() => validateBloomParams({ ...P, radius: 2 * P.sigmaHalo }), BloomParamError);
    assert.throws(() => validateBloomParams({ ...P, strength: 13 }), BloomParamError);
    assert.throws(() => validateBloomParams({ ...P, knee: 0 }), BloomParamError);
  });
});

describe("safety gates", () => {
  const ok = { prePayoffMaxAbs: 0, farMeanAbsDelta: 0.01, faceMeanDelta: 0.3, clipIncreasePts: 0.05, darkMeanDelta: 0.02, gradientRatioFar: 1, chromaShiftFar: 0.01, twinMinPsnr: 55, fieldGhostIndex: 0.09, renderLatticeRatio: 0.65, lightSaturationChange: -0.01, lightHueShiftDeg: 0.3 };
  it("passes a clean candidate and names every failure", () => {
    assert.deepEqual(evaluateBloomGates(ok), { ok: true, failures: [] });
    const bad = evaluateBloomGates({ ...ok, prePayoffMaxAbs: 1, faceMeanDelta: 1.4, clipIncreasePts: 0.3, fieldGhostIndex: 0.4, renderLatticeRatio: 0.98, twinMinPsnr: 45, lightSaturationChange: -0.2, lightHueShiftDeg: 3 });
    assert.equal(bad.ok, false);
    assert.equal(bad.failures.length, 8);
    assert.match(bad.failures.join(" "), /frames 0-299/);
  });
});

