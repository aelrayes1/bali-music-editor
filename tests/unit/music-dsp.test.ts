import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFT, pickPeaks, refineAttack, weightedLinearFit } from "../../src/music/dsp.ts";
import { parseWindow, canonicalJson, configHash, DEFAULT_CONFIG } from "../../src/music/analyze.ts";
import { rational } from "../../src/time/rational.ts";

describe("dsp", () => {
  it("FFT puts a pure tone in its bin", () => {
    const n = 1024;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 37 * i) / n);
    fft.transform(re, im);
    let best = 0;
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!)) best = k;
    assert.equal(best, 37);
    assert.ok(Math.abs(Math.hypot(re[37]!, im[37]!) - n / 2) < 1e-6);
    assert.throws(() => new FFT(1000), RangeError);
  });

  it("peak picking resolves ties to the earliest index", () => {
    const xs = Float64Array.from([0, 1, 1, 0, 0, 3, 0, 0]);
    assert.deepEqual(pickPeaks(xs, 1, 1, 0, 0.5).map((p) => p.index), [1, 5]);
  });

  it("weighted linear fit recovers an exact line", () => {
    const xs = [0, 1, 2, 3, 4];
    const fit = weightedLinearFit(xs, xs.map((x) => 5 + 21338.7 * x), xs.map(() => 1));
    assert.ok(Math.abs(fit.a - 5) < 1e-6 && Math.abs(fit.b - 21338.7) < 1e-6 && fit.rms < 1e-6);
  });

  it("refines an attack to within one analysis step", () => {
    const s = new Float32Array(4000);
    for (let i = 2345; i < 2600; i++) s[i] = Math.sin(i) * 0.8;
    const at = refineAttack(s, 1500, 3000);
    assert.ok(Math.abs(at - 2345) <= 64, `got ${at}`);
  });
});

describe("analysis configuration", () => {
  it("hashes configuration deterministically and key-order independently", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    assert.equal(configHash(DEFAULT_CONFIG), configHash(JSON.parse(JSON.stringify(DEFAULT_CONFIG))));
    assert.notEqual(configHash(DEFAULT_CONFIG), configHash({ ...DEFAULT_CONFIG, phraseBars: 16 }));
    assert.match(configHash(DEFAULT_CONFIG), /^[0-9a-f]{16}$/);
  });

  it("windows need explicit units", () => {
    assert.deepEqual(parseWindow({ id: "w", start: "00:01:30.000", end: "100.0s" }).start, rational(90));
    assert.throws(() => parseWindow({ id: "w", start: "170", end: "180" }), /ambiguous/);
    assert.throws(() => parseWindow({ id: "w", start: "100.0s", end: "90.0s" }), RangeError);
  });
});
