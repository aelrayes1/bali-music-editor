/**
 * CLEAN_TO_CHAOS accents (pure, deterministic): punch-in, horizontal jolt, RGB separation and thin
 * analog-feedback displacement bands, sampled from the wider SOURCE frame (overscan) so no border is
 * ever exposed. Temporal accents (freeze, stutter) are a choice of source frame per output frame and
 * live in the caller's plan; this module only draws one output frame.
 *
 * Coordinates: the work frame is the full source at the crop's pixel scale (e.g. 1708 x 960 for an
 * 854 x 480 source and a 540 x 960 crop); the clean output is the integer crop [cropLeft, cropLeft + W).
 * All pixel amounts are OUTPUT pixels. An identity op returns the exact clean crop.
 */

import { hash01 } from "../core.ts";
import type { Rgb } from "./pixels.ts";

export interface FeedbackBand {
  /** top row and height in output pixels */
  y0: number;
  h: number;
  /** extra horizontal displacement of the band's rows */
  dx: number;
  /** RGB misregistration inside the band */
  rgbPx: number;
}
export interface AccentOp {
  /** source frame shown (temporal remap is the caller's: freeze / stutter) */
  src: number;
  /** punch-in scale about the crop centre (>= 1) */
  scale: number;
  /** horizontal jolt of the whole frame */
  joltPx: number;
  /** whole-frame RGB separation: red sampled +rgbPx, blue -rgbPx */
  rgbPx: number;
  bands: FeedbackBand[];
  /** controlled video feedback: delayed images (output frames back) with outward scale / translation (resolved by the caller) */
  layers?: FeedbackLayer[];
  /** directional smear: the mean of `smearTaps` samples spread over smearPx (signed, output pixels), from source overscan */
  smearPx?: number;
  smearTaps?: number;
}
export interface FeedbackLayer {
  /** output frames back (the frame shown then, temporal remap included) */
  delay: number;
  opacity: number;
  /** extra outward scale on top of the current op's scale */
  scale: number;
  /** extra horizontal offset, output pixels */
  dx: number;
}
export const isIdentity = (op: AccentOp) => op.scale === 1 && op.joltPx === 0 && op.rgbPx === 0 && op.bands.length === 0 && !op.layers?.length && !op.smearPx;

/** the clean crop: rows [cropLeft, cropLeft + W) of the work frame (W x work height) */
export function cleanCrop(work: Rgb, cropLeft: number, W: number): Rgb {
  const out = new Uint8Array(W * work.h * 3);
  for (let y = 0; y < work.h; y++) out.set(work.data.subarray((y * work.w + cropLeft) * 3, (y * work.w + cropLeft + W) * 3), y * W * 3);
  return { w: W, h: work.h, data: out };
}

/**
 * One treated frame. Bilinear sampling of the work frame; `outside` counts samples that would have
 * fallen outside the source (they are clamped; a correct plan keeps it 0 = no exposed border).
 */
export function renderAccent(work: Rgb, cropLeft: number, W: number, op: AccentOp): { img: Rgb; outside: number } {
  if (isIdentity({ ...op, layers: [] })) return { img: cleanCrop(work, cropLeft, W), outside: 0 };
  const H = work.h, sw = work.w, s = work.data;
  const out = new Uint8Array(W * H * 3);
  const cx = cropLeft + W / 2, cy = H / 2;
  const rowDx = new Float32Array(H), rowRgb = new Float32Array(H).fill(op.rgbPx);
  for (const b of op.bands) for (let y = Math.max(0, Math.round(b.y0)); y < Math.min(H, Math.round(b.y0 + b.h)); y++) { rowDx[y] = rowDx[y]! + b.dx; rowRgb[y] = Math.max(rowRgb[y]!, b.rgbPx); }
  let outside = 0;
  const taps = op.smearPx ? Math.max(2, op.smearTaps ?? 6) : 1;
  for (let y = 0; y < H; y++) {
    let v = cy + (y + 0.5 - H / 2) / op.scale - 0.5;
    if (v < 0 || v > H - 1) { outside++; v = v < 0 ? 0 : H - 1; }
    const y0 = Math.floor(v), y1 = y0 + 1 < H ? y0 + 1 : y0, ty = v - y0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const off = ch === 0 ? rowRgb[y]! : ch === 2 ? -rowRgb[y]! : 0;
        let acc = 0;
        for (let t = 0; t < taps; t++) {
          const sm = taps > 1 ? (op.smearPx! * t) / (taps - 1) : 0;
          let u = cx + (x + 0.5 - W / 2 - op.joltPx - rowDx[y]! - off - sm) / op.scale - 0.5;
          if (u < 0 || u > sw - 1) { outside++; u = u < 0 ? 0 : sw - 1; }
          const x0 = Math.floor(u), x1 = x0 + 1 < sw ? x0 + 1 : x0, tx = u - x0;
          const p00 = s[(y0 * sw + x0) * 3 + ch]!, p10 = s[(y0 * sw + x1) * 3 + ch]!, p01 = s[(y1 * sw + x0) * 3 + ch]!, p11 = s[(y1 * sw + x1) * 3 + ch]!;
          acc += (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
        }
        out[o + ch] = acc / taps + 0.5;
      }
    }
  }
  return { img: { w: W, h: H, data: out }, outside };
}

/**
 * Deterministic thin feedback bands, kept away from the face: candidate rows exclude
 * [faceTop - 0.25 faceH, faceBottom + 0.35 faceH] (eyes and mouth stay clean); placement keyed by
 * (seed, frame, band). Heights / displacements are output pixels.
 */
export function feedbackBands(seed: number, frame: number, count: number, H: number, face: { top: number; bottom: number } | null, heightPx: [number, number], dx: number, rgbPx: number): FeedbackBand[] {
  const avoid = face ? [face.top - 0.25 * (face.bottom - face.top), face.bottom + 0.35 * (face.bottom - face.top)] : [-1, -1];
  const bands: FeedbackBand[] = [];
  for (let b = 0, tries = 0; bands.length < count && tries < 64; tries++) {
    const h = Math.round(heightPx[0] + hash01(seed, frame, 100 + tries) * (heightPx[1] - heightPx[0]));
    const y0 = Math.round(0.06 * H + hash01(seed, frame, 200 + tries) * (0.88 * H - h));
    if (y0 + h > avoid[0]! && y0 < avoid[1]!) continue;
    if (bands.some((q) => y0 < q.y0 + q.h + 0.08 * H && q.y0 < y0 + h + 0.08 * H)) continue;
    const sign = hash01(seed, frame, 300 + b) < 0.5 ? -1 : 1;
    bands.push({ y0, h, dx: sign * dx, rgbPx });
    b++;
  }
  return bands;
}

/**
 * Normalised feedback composite: out = (1 - sum w) * current + sum w_i * layer_i (a convex mix, so the
 * layers never brighten the picture beyond its own range); the current image keeps >= 1 - sum w.
 */
export function blendLayers(cur: Rgb, layers: Array<{ img: Rgb; opacity: number }>): Rgb {
  const total = layers.reduce((s, l) => s + l.opacity, 0);
  if (total <= 0) return cur;
  if (total >= 1) throw new Error(`feedback opacities sum to ${total}: the current image must stay dominant`);
  const out = new Uint8Array(cur.data.length), wc = 1 - total;
  for (let i = 0; i < out.length; i++) {
    let v = cur.data[i]! * wc;
    for (const l of layers) v += l.img.data[i]! * l.opacity;
    out[i] = v + 0.5;
  }
  return { w: cur.w, h: cur.h, data: out };
}
