/**
 * Phase 6B review visualisations (pure): mask overlays, region outlines and ambiguity sheets drawn
 * into RGB buffers. Review material only; never part of a production render.
 */

import type { Rgb } from "./composite.ts";
import { type Mask, sample } from "./mask.ts";

/** Box-downscale an RGB frame by an integer factor. */
export function downscaleRgb(img: Rgb, k: number): Rgb {
  const w = Math.floor(img.w / k), h = Math.floor(img.h / k);
  const o = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) s += img.data[((y * k + yy) * img.w + x * k + xx) * 3 + c]!;
        o[(y * w + x) * 3 + c] = Math.round(s / (k * k));
      }
  return { w, h, data: o };
}

/**
 * Mask visualisation: background dimmed, the subject matte tinted (cyan), other people tinted
 * (red), the matte edge drawn in yellow and the effect region edge (if given) in magenta.
 */
export function maskOverlay(img: Rgb, matte: Mask, others: Mask | null, region: Mask | null): Rgb {
  const o = new Uint8Array(img.data.length);
  const sx = matte.w / img.w, sy = matte.h / img.h;
  const at = (m: Mask, x: number, y: number) => sample(m, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) / 255;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 3;
      const a = at(matte, x, y);
      const oth = others ? at(others, x, y) : 0;
      let r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      const dim = 0.4 + 0.6 * a;
      r *= dim;
      g *= dim;
      b *= dim;
      r = r * (1 - 0.25 * a);
      g = g + (255 - g) * 0.12 * a;
      b = b + (255 - b) * 0.2 * a;
      if (oth > 0.5) {
        r = r + (255 - r) * 0.35;
        g *= 0.8;
        b *= 0.8;
      }
      const edge = a > 0.35 && a < 0.65;
      const rv = region ? at(region, x, y) : 0;
      const redge = region && rv > 0.45 && rv < 0.55;
      o[i] = redge ? 255 : edge ? 255 : r;
      o[i + 1] = redge ? 60 : edge ? 230 : g;
      o[i + 2] = redge ? 255 : edge ? 40 : b;
    }
  return { w: img.w, h: img.h, data: o };
}

export const ALT_COLORS: Array<[number, number, number]> = [
  [0, 200, 255],
  [255, 170, 0],
  [120, 255, 90],
];

/** Tint each alternative's mask in its own colour (ambiguity review sheet). */
export function tintAlternatives(img: Rgb, masks: Array<Mask | null>): Rgb {
  const o = Uint8Array.from(img.data);
  masks.forEach((m, k) => {
    if (!m) return;
    const [cr, cg, cb] = ALT_COLORS[k % ALT_COLORS.length]!;
    const sx = m.w / img.w, sy = m.h / img.h;
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        const a = sample(m, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) / 255;
        if (a < 0.5) continue;
        const i = (y * img.w + x) * 3;
        o[i] = o[i]! * 0.55 + cr * 0.45;
        o[i + 1] = o[i + 1]! * 0.55 + cg * 0.45;
        o[i + 2] = o[i + 2]! * 0.55 + cb * 0.45;
      }
  });
  return { w: img.w, h: img.h, data: o };
}

/** Crop (clamped) an RGB region. */
export function cropRgb(img: Rgb, x0: number, y0: number, w: number, h: number): Rgb {
  const x = Math.max(0, Math.min(img.w - w, Math.round(x0)));
  const y = Math.max(0, Math.min(img.h - h, Math.round(y0)));
  const o = new Uint8Array(w * h * 3);
  for (let r = 0; r < h; r++) o.set(img.data.subarray(((y + r) * img.w + x) * 3, ((y + r) * img.w + x + w) * 3), r * w * 3);
  return { w, h, data: o };
}

/**
 * Region contour (no tint): magenta where the patch region is half on (the middle of the seam),
 * yellow at its outer edge, so edge close-ups show exactly where the blend happens.
 */
export function regionEdges(img: Rgb, region: Mask): Rgb {
  const o = Uint8Array.from(img.data);
  const sx = region.w / img.w, sy = region.h / img.h;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const a = sample(region, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) / 255;
      const i = (y * img.w + x) * 3;
      if (a > 0.47 && a < 0.53) o.set([255, 40, 255], i);
      else if (a > 0.02 && a < 0.05) o.set([255, 230, 40], i);
    }
  return { w: img.w, h: img.h, data: o };
}
