/**
 * CLEAN_TO_CHAOS accents (src/fx/ctc/accents.ts): an identity op is the exact clean crop; punch, jolt, RGB
 * and feedback bands sample source overscan (no exposed border); bands avoid the face; deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blendLayers, cleanCrop, feedbackBands, renderAccent } from "../../src/fx/ctc/accents.ts";
import type { Rgb } from "../../src/fx/ctc/pixels.ts";

const work: Rgb = (() => {
  const w = 160, h = 90, data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; data[o] = x; data[o + 1] = y * 2; data[o + 2] = (x * 7 + y * 3) & 255; }
  return { w, h, data };
})();
const id = { src: 0, scale: 1, joltPx: 0, rgbPx: 0, bands: [] };

describe("ctc accents", () => {
  it("an identity op returns the exact clean crop", () => {
    const r = renderAccent(work, 40, 50, id);
    assert.deepEqual(r.img.data, cleanCrop(work, 40, 50).data);
    assert.equal(r.outside, 0);
    assert.equal(r.img.data[0], 40, "first pixel is source column 40");
  });

  it("punch, jolt, RGB and bands sample inside the source when there is overscan (no exposed border)", () => {
    const r = renderAccent(work, 40, 50, { src: 0, scale: 1.055, joltPx: 3, rgbPx: 1.5, bands: [{ y0: 50, h: 6, dx: 3.5, rgbPx: 1.5 }] });
    assert.equal(r.outside, 0);
    assert.notDeepEqual(r.img.data, cleanCrop(work, 40, 50).data);
  });

  it("counts samples that would leave the source (a crop on the edge cannot jolt outward)", () => {
    assert.ok(renderAccent(work, 0, 50, { ...id, joltPx: 4 }).outside > 0);
  });

  it("a punch-in zooms about the crop centre", () => {
    const r = renderAccent(work, 40, 50, { ...id, scale: 2 });
    // the centre column stays the centre column; the edges move inward
    assert.ok(Math.abs(r.img.data[(45 * 50 + 25) * 3]! - 65) <= 1);
    assert.ok(r.img.data[(45 * 50) * 3]! > 40 + 5);
  });

  it("feedback bands are deterministic and keep clear of the face rows", () => {
    const face = { top: 150, bottom: 300 };
    const a = feedbackBands(7, 433, 2, 960, face, [7, 11], 3.5, 1.5), b = feedbackBands(7, 433, 2, 960, face, [7, 11], 3.5, 1.5);
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
    for (const band of a) assert.ok(band.y0 + band.h <= face.top - 0.25 * 150 || band.y0 >= face.bottom + 0.35 * 150, JSON.stringify(band));
  });

  it("video feedback blends delayed layers as a normalised mix (never brighter than its inputs) and keeps the current image dominant", () => {
    const cur = { w: 2, h: 1, data: new Uint8Array([100, 100, 100, 200, 200, 200]) };
    const lay = { w: 2, h: 1, data: new Uint8Array([255, 255, 255, 0, 0, 0]) };
    const out = blendLayers(cur, [{ img: lay, opacity: 0.25 }, { img: lay, opacity: 0.2 }]);
    assert.deepEqual([...out.data], [Math.round(100 * 0.55 + 255 * 0.45), Math.round(100 * 0.55 + 255 * 0.45), Math.round(100 * 0.55 + 255 * 0.45), 110, 110, 110]);
    assert.deepEqual(blendLayers(cur, []).data, cur.data);
    assert.throws(() => blendLayers(cur, [{ img: lay, opacity: 0.6 }, { img: lay, opacity: 0.5 }]));
  });
});
