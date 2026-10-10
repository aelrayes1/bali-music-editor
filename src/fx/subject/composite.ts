/**
 * Phase 6B subject-region temporal patch (pure, deterministic, integer-exact).
 *
 * For output frame f the subject shows source frame p = p(f) <= f. The patch region is
 *     R = feather(dilate(B_f U B_p, margin))
 * (B = subject matte, binary, at mask resolution): it covers the subject in BOTH poses plus a margin
 * of background. Inside R the output is frame p; outside it is the background frame (f, or the held
 * frame). So the repeated subject keeps its own real edges, hair and hands, the current pose is fully
 * replaced (no double limbs), and the only seam is a soft blend between two real background plates
 * where they are nearly identical. Nothing is generated or inpainted.
 *
 * BACKGROUND_SMOOTH_CONTINUE first aligns frame p to f with a bounded global translation estimated
 * on the background only (for camera drift), so the seam still falls on matching background; known
 * frame-locked graphics (burned-in logos) are kept out of a shifted patch (`protect`).
 *
 * Blending is integer: out = (base*(255-a) + patch*a + 127) / 255 with a in 0..255, so a = 0 gives
 * the clean pixel exactly and p = f gives the clean frame exactly.
 */

import { type Mask, blur, dilate, shift, union } from "./mask.ts";

export interface Rgb {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Soft region (0-255) at mask resolution. margin/feather are in full-resolution px. */
export function regionMask(bf: Mask, bp: Mask, marginPx: number, featherPx: number, downscale: number): Mask {
  const d = dilate(union(bf, bp), Math.max(1, Math.round(marginPx / downscale)));
  return blur(d, Math.max(0, Math.round(featherPx / downscale / 2)), 2);
}

/** Box-downsampled luma (Rec. 709 weights) at mask resolution, for alignment and seam metrics. */
export function lumaSmall(img: Rgb, ds: number): Mask {
  const w = Math.floor(img.w / ds), h = Math.floor(img.h / ds);
  const o = new Uint8Array(w * h);
  const n = ds * ds;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < ds; yy++) {
        let i = ((y * ds + yy) * img.w + x * ds) * 3;
        for (let xx = 0; xx < ds; xx++, i += 3) s += 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
      }
      o[y * w + x] = Math.round(s / n);
    }
  return { w, h, data: o };
}

/** Alignment only engages when the background clearly mismatches and the shift clearly fixes it. */
export const ALIGN = { minMismatch: 3, minGain: 0.2 };

/** Mean of the lowest `keep` fraction of a 0-255 difference histogram (robust to moving objects). */
function histMedian(hist: Uint32Array, keep = 0.75): number {
  let n = 0;
  for (const c of hist) n += c;
  if (!n) return Infinity;
  const lim = n * keep;
  let acc = 0, sum = 0;
  for (let v = 0; v < 256 && acc < lim; v++) {
    const take = Math.min(hist[v]!, lim - acc);
    acc += take;
    sum += take * v;
  }
  return sum / acc;
}

/**
 * Global translation (full-res px) that best maps frame p onto frame f over the BACKGROUND (outside
 * the dilated subject region and a border). Integer search at mask resolution (+-maxShift/ds, every 2nd pixel), then
 * +-(ds-1) px refinement at full resolution on a sparse grid. Returns {0,0} unless the shift improves
 * the background match clearly (locked shots stay exactly unshifted). The cost is a trimmed mean (lowest 75 %) of the
 * absolute differences, so a large moving object in the background (a swinging car door) cannot pull the
 * estimate: only a shift that matches most of the background wins.
 */
export function estimateShift(lf: Mask, lp: Mask, exclude: Mask, maxShiftPx: number, ds: number, full?: { f: Rgb; p: Rgb }): { dx: number; dy: number; gain: number } {
  const S = Math.max(1, Math.round(maxShiftPx / ds));
  const { w, h } = lf;
  const sad = (dx: number, dy: number) => {
    const hist = new Uint32Array(256);
    for (let y = S; y < h - S; y += 2)
      for (let x = S; x < w - S; x += 2) {
        const i = y * w + x;
        if (exclude.data[i]) continue;
        hist[Math.abs(lf.data[i]! - lp.data[(y - dy) * w + (x - dx)]!)]!++;
      }
    return histMedian(hist);
  };
  const zero = sad(0, 0);
  let best = { dx: 0, dy: 0, s: zero };
  for (let dy = -S; dy <= S; dy++)
    for (let dx = -S; dx <= S; dx++) {
      const s = sad(dx, dy);
      if (s < best.s - 1e-9) best = { dx, dy, s };
    }
  let dx = best.dx * ds, dy = best.dy * ds;
  let bestS = best.s;
  if (full) {
    const { f, p } = full;
    const fs = (ddx: number, ddy: number) => {
      const hist = new Uint32Array(256);
      const m = maxShiftPx + ds;
      for (let y = m; y < f.h - m; y += 3)
        for (let x = m; x < f.w - m; x += 3) {
          if (exclude.data[Math.min(h - 1, Math.floor(y / ds)) * w + Math.min(w - 1, Math.floor(x / ds))]) continue;
          const i = (y * f.w + x) * 3;
          const j = ((y - ddy) * p.w + (x - ddx)) * 3;
          hist[Math.abs(f.data[i + 1]! - p.data[j + 1]!)]!++;
        }
      return histMedian(hist);
    };
    let fb = { dx, dy, s: fs(dx, dy) };
    const z = fs(0, 0);
    for (let ry = -(ds - 1); ry <= ds - 1; ry++)
      for (let rx = -(ds - 1); rx <= ds - 1; rx++) {
        const cx = best.dx * ds + rx, cy = best.dy * ds + ry;
        if (Math.abs(cx) > maxShiftPx || Math.abs(cy) > maxShiftPx) continue;
        const s = fs(cx, cy);
        if (s < fb.s - 1e-9) fb = { dx: cx, dy: cy, s };
      }
    dx = fb.dx;
    dy = fb.dy;
    bestS = fb.s;
    if (!(z >= ALIGN.minMismatch && fb.s < z * (1 - ALIGN.minGain))) return { dx: 0, dy: 0, gain: 0 };
    return { dx, dy, gain: Math.round((1 - fb.s / z) * 1000) / 1000 };
  }
  if (!(zero >= ALIGN.minMismatch && bestS < zero * (1 - ALIGN.minGain))) return { dx: 0, dy: 0, gain: 0 };
  return { dx, dy, gain: Math.round((1 - bestS / zero) * 1000) / 1000 };
}

/** Translate an RGB frame by an integer offset (edges replicate the nearest pixel; never generated content in the region, which lies inside the frame). */
export function shiftRgb(img: Rgb, dx: number, dy: number): Rgb {
  if (!dx && !dy) return img;
  const o = new Uint8Array(img.data.length);
  for (let y = 0; y < img.h; y++) {
    const sy = Math.min(img.h - 1, Math.max(0, y - dy));
    for (let x = 0; x < img.w; x++) {
      const sx = Math.min(img.w - 1, Math.max(0, x - dx));
      const i = (y * img.w + x) * 3, j = (sy * img.w + sx) * 3;
      o[i] = img.data[j]!;
      o[i + 1] = img.data[j + 1]!;
      o[i + 2] = img.data[j + 2]!;
    }
  }
  return { w: img.w, h: img.h, data: o };
}

/**
 * Upsampled alpha (0-255 integers) for a full-resolution frame from a mask-resolution soft region,
 * bilinear with pixel-centre alignment, scaled by mix.
 */
export function alphaFull(region: Mask, W: number, H: number, mix: number): Uint8Array {
  const a = new Uint8Array(W * H);
  const ds = W / region.w;
  const xs = new Float32Array(W);
  for (let x = 0; x < W; x++) xs[x] = Math.min(region.w - 1, Math.max(0, (x + 0.5) / ds - 0.5));
  for (let y = 0; y < H; y++) {
    const fy = Math.min(region.h - 1, Math.max(0, (y + 0.5) / ds - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(region.h - 1, y0 + 1), ty = fy - y0;
    const r0 = y0 * region.w, r1 = y1 * region.w;
    for (let x = 0; x < W; x++) {
      const fx = xs[x]!;
      const x0 = Math.floor(fx), x1 = Math.min(region.w - 1, x0 + 1), tx = fx - x0;
      const v = (region.data[r0 + x0]! * (1 - tx) + region.data[r0 + x1]! * tx) * (1 - ty) + (region.data[r1 + x0]! * (1 - tx) + region.data[r1 + x1]! * tx) * ty;
      a[y * W + x] = Math.round(Math.min(255, v * mix));
    }
  }
  return a;
}

/** Integer-exact blend: a = 0 -> base, a = 255 -> patch. */
export function blend(base: Rgb, patch: Rgb, alpha: Uint8Array): Rgb {
  const o = new Uint8Array(base.data.length);
  for (let i = 0, k = 0; k < alpha.length; k++, i += 3) {
    const a = alpha[k]!;
    if (a === 0) {
      o[i] = base.data[i]!;
      o[i + 1] = base.data[i + 1]!;
      o[i + 2] = base.data[i + 2]!;
    } else {
      const b = 255 - a;
      o[i] = ((base.data[i]! * b + patch.data[i]! * a + 127) / 255) | 0;
      o[i + 1] = ((base.data[i + 1]! * b + patch.data[i + 1]! * a + 127) / 255) | 0;
      o[i + 2] = ((base.data[i + 2]! * b + patch.data[i + 2]! * a + 127) / 255) | 0;
    }
  }
  return { w: base.w, h: base.h, data: o };
}

/**
 * Seam mismatch: mean absolute luma difference between the two background plates across the soft
 * part of the region (0.1 < a < 0.9), outside both subject poses. ~0-3 levels on a locked shot is
 * invisible; large values mean the seam crosses moving background (ghosting / halo risk).
 */
export function seamMismatch(lBase: Mask, lPatch: Mask, region: Mask, subjects: Mask): { mean: number; p95: number; pixels: number } {
  const d: number[] = [];
  for (let i = 0; i < region.data.length; i++) {
    const a = region.data[i]!;
    if (a <= 25 || a >= 230 || subjects.data[i]) continue;
    d.push(Math.abs(lBase.data[i]! - lPatch.data[i]!));
  }
  if (!d.length) return { mean: 0, p95: 0, pixels: 0 };
  d.sort((a, b) => a - b);
  return { mean: Math.round((d.reduce((s, v) => s + v, 0) / d.length) * 10) / 10, p95: d[Math.floor(d.length * 0.95)]!, pixels: d.length };
}

export interface FramePlan {
  f: number;
  p: number;
  /** background source frame (f, or the held frame) */
  bg: number;
  shift: { dx: number; dy: number; gain: number };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Frame-locked graphics (burned-in logos, captions) sit at the same pixels in every frame. An
 * aligned (shifted) patch would carry them along and double them, so inside these rectangles the
 * alpha falls to 0 (the background frame's own copy stays), with a short linear ramp outside.
 * Unshifted patches need no protection: the graphic is identical in both frames. Returns how many
 * pixels lost patch coverage: where the subject overlaps the graphic, the current pose can show
 * through there (a review flag; the real fix is cleaning the graphic before FX, as the production
 * order does).
 */
export function protectRects(alpha: Uint8Array, W: number, H: number, rects: readonly Rect[], ramp = PROTECT_RAMP_PX): number {
  let reduced = 0;
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x - ramp)), x1 = Math.min(W, Math.ceil(r.x + r.w + ramp));
    const y0 = Math.max(0, Math.floor(r.y - ramp)), y1 = Math.min(H, Math.ceil(r.y + r.h + ramp));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const d = Math.max(r.x - x, x - (r.x + r.w - 1), r.y - y, y - (r.y + r.h - 1), 0);
        const k = y * W + x;
        const a = Math.round(alpha[k]! * Math.min(1, d / ramp));
        if (a < alpha[k]!) reduced++;
        alpha[k] = a;
      }
  }
  return reduced;
}
export const PROTECT_RAMP_PX = 8;

/** One output frame of the effect. `B` = binary subject mattes by clip-local frame. */
export function compositeFrame(args: { base: Rgb; patch: Rgb; bBase: Mask; bPatch: Mask; marginPx: number; featherPx: number; mix: number; shift: { dx: number; dy: number }; protect?: readonly Rect[] }): { out: Rgb; region: Mask; protectedPixels: number } {
  const ds = args.base.w / args.bBase.w;
  const shifted = !!(args.shift.dx || args.shift.dy);
  const bp = shifted ? shift(args.bPatch, Math.round(args.shift.dx / ds), Math.round(args.shift.dy / ds)) : args.bPatch;
  const patch = shiftRgb(args.patch, args.shift.dx, args.shift.dy);
  const region = regionMask(args.bBase, bp, args.marginPx, args.featherPx, ds);
  const alpha = alphaFull(region, args.base.w, args.base.h, args.mix);
  // the patch carries its copy of each graphic to rect + shift: protect both positions
  const protectedPixels = shifted && args.protect?.length ? protectRects(alpha, args.base.w, args.base.h, args.protect.flatMap((r) => [r, { ...r, x: r.x + args.shift.dx, y: r.y + args.shift.dy }])) : 0;
  return { out: blend(args.base, patch, alpha), region, protectedPixels };
}
