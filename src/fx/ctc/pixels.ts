/**
 * CLEAN_TO_CHAOS pixel engine (pure, deterministic, dependency-free).
 *
 * Every function takes RGB frames (w x h x 3, 8-bit) and a strength s >= 0 and returns a new
 * frame; s = 0 always returns an exact copy of the base frame (the clean frame). Pseudo-random
 * choices use the Phase 6A integer hash (seed, frame, index): no Math.random, no clocks, no
 * dependence on call order except the datamosh state, which is advanced frame by frame in a fixed
 * order and reset on every cut.
 */

import { echoBlendFor, hash01 } from "../core.ts";
import type { CtcParams, ProtectBand } from "./contract.ts";

export interface Rgb {
  w: number;
  h: number;
  data: Uint8Array;
}
export type BlendMode = "lighten" | "darken" | "screen" | "normal";
/** clip-local frame getter (callers clamp to the clip; never reads across a cut) */
export type FrameAt = (j: number) => Rgb;

export const copyRgb = (a: Rgb): Rgb => ({ w: a.w, h: a.h, data: new Uint8Array(a.data) });

/** share of pixels with luma >= 200 (the Phase 6A high-key measure) */
export function brightShare(a: Rgb, step = 7): number {
  let n = 0;
  let k = 0;
  for (let i = 0; i < a.w * a.h; i += step) {
    const l = 0.2126 * a.data[i * 3]! + 0.7152 * a.data[i * 3 + 1]! + 0.0722 * a.data[i * 3 + 2]!;
    if (l >= 200) n++;
    k++;
  }
  return n / k;
}

/** "auto" follows the Phase 6A rule: darken on high-key footage, lighten otherwise */
export const resolveBlend = (b: BlendMode | "auto", share: number): BlendMode => (b === "auto" ? echoBlendFor(share) : b);

/** mean absolute luma difference between two frames (sampled), normalised to [0, 1] by `ref` */
export function motionNorm(a: Rgb, b: Rgb, ref = 12, step = 13): number {
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.w * a.h; i += step) {
    t += Math.abs(0.2126 * (a.data[i * 3]! - b.data[i * 3]!) + 0.7152 * (a.data[i * 3 + 1]! - b.data[i * 3 + 1]!) + 0.0722 * (a.data[i * 3 + 2]! - b.data[i * 3 + 2]!));
    k++;
  }
  return Math.min(1, t / k / ref);
}

/** protect weight per row: 1 = full effect, 1 - keep inside the band, feathered at its edges */
export function protectRows(h: number, p: ProtectBand | null): Float32Array {
  const w = new Float32Array(h).fill(1);
  if (!p) return w;
  const fe = Math.max(1e-6, p.featherFrac);
  for (let y = 0; y < h; y++) {
    const u = (y + 0.5) / h;
    const inside = u >= p.from && u <= p.to ? 1 : u < p.from ? Math.max(0, 1 - (p.from - u) / fe) : Math.max(0, 1 - (u - p.to) / fe);
    const sm = inside * inside * (3 - 2 * inside);
    w[y] = 1 - p.keep * sm;
  }
  return w;
}

function blendByte(a: number, b: number, m: BlendMode): number {
  switch (m) {
    case "lighten":
      return a > b ? a : b;
    case "darken":
      return a < b ? a : b;
    case "screen":
      return 255 - ((255 - a) * (255 - b)) / 255;
    default:
      return b;
  }
}

/** out = out + (blend(out, layer) - out) * weight * rowWeight[y] (in place) */
export function compose(out: Rgb, layer: Rgb, weight: number, mode: BlendMode, rowWeight: Float32Array | null = null): void {
  if (weight <= 0) return;
  const { w, h } = out;
  const o = out.data;
  const l = layer.data;
  for (let y = 0; y < h; y++) {
    const wy = weight * (rowWeight ? rowWeight[y]! : 1);
    if (wy <= 0) continue;
    const r0 = y * w * 3;
    for (let i = r0; i < r0 + w * 3; i++) {
      const a = o[i]!;
      o[i] = a + (blendByte(a, l[i]!, mode) - a) * wy + 0.5;
    }
  }
}

/**
 * Bilinear resample of `src` zoomed by z (>= 1: zoom in) and rotated by rotDeg about the centre,
 * with the red / blue channels sampled chromaPx left / right (a small analog chroma drift).
 */
export function zoomRotate(src: Rgb, z: number, rotDeg: number, chromaPx = 0): Rgb {
  const { w, h } = src;
  const out = new Uint8Array(w * h * 3);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const a = (rotDeg * Math.PI) / 180;
  const ca = Math.cos(a) / z;
  const sa = Math.sin(a) / z;
  const s = src.data;
  const sample = (fx: number, fy: number, ch: number) => {
    const x0c = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
    const y0c = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
    const x0 = Math.floor(x0c);
    const y0 = Math.floor(y0c);
    const x1 = x0 + 1 < w ? x0 + 1 : x0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const tx = x0c - x0;
    const ty = y0c - y0;
    const p00 = s[(y0 * w + x0) * 3 + ch]!;
    const p10 = s[(y0 * w + x1) * 3 + ch]!;
    const p01 = s[(y1 * w + x0) * 3 + ch]!;
    const p11 = s[(y1 * w + x1) * 3 + ch]!;
    return (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
  };
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const sx = cx + ca * dx + sa * dy;
      const sy = cy - sa * dx + ca * dy;
      const o = (y * w + x) * 3;
      out[o] = sample(sx + chromaPx, sy, 0) + 0.5;
      out[o + 1] = sample(sx, sy, 1) + 0.5;
      out[o + 2] = sample(sx - chromaPx, sy, 2) + 0.5;
    }
  }
  return { w, h, data: out };
}

/**
 * Motion-gated tracking instability: bands of rows shifted horizontally (edge-clamped). A band
 * moves with probability prob * s * motion; its shift is up to jitterPx * s * motion, scaled by
 * the row protect weight. Keyed by (seed, key, band) so it is a pure function of the key.
 */
export function jitterRows(img: Rgb, key: number, s: number, motion: number, jitterPx: number, bandPx: number, prob: number, seed: number, rowWeight: Float32Array | null): Rgb {
  const { w, h } = img;
  const out = new Uint8Array(img.data);
  if (s <= 0 || motion <= 0 || jitterPx <= 0) return { w, h, data: out };
  for (let b = 0; b * bandPx < h; b++) {
    if (hash01(seed, key, b) >= prob * s * motion) continue;
    const y0 = b * bandPx;
    const pw = rowWeight ? rowWeight[Math.min(h - 1, y0 + (bandPx >> 1))]! : 1;
    const shift = Math.round((hash01(seed, key, b + 7919) * 2 - 1) * jitterPx * s * motion * pw);
    if (!shift) continue;
    for (let y = y0; y < Math.min(h, y0 + bandPx); y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x - shift));
        const o = (y * w + x) * 3;
        const i = (y * w + sx) * 3;
        out[o] = img.data[i]!;
        out[o + 1] = img.data[i + 1]!;
        out[o + 2] = img.data[i + 2]!;
      }
  }
  return { w, h, data: out };
}

type P<T extends CtcParams["type"]> = Extract<CtcParams, { type: T }>;

/**
 * Echo Print: ghost trails of prior frames. The number of active trails grows with s (trail k
 * fades in as s * trails passes k - 1); nearer trails are composited last (on top).
 */
export function echoPrint(F: FrameAt, f: number, s: number, p: P<"echoPrint">, mode: BlendMode, rows: Float32Array | null): Rgb {
  const out = copyRgb(F(f));
  if (s <= 0) return out;
  const n = s * p.trails;
  for (let k = p.trails; k >= 1; k--) {
    const wk = s * p.mix * Math.pow(p.decay, k - 1) * Math.min(1, Math.max(0, n - (k - 1)));
    if (wk <= 0) continue;
    compose(out, F(Math.max(0, f - k * p.spacing)), wk, mode, rows);
  }
  return out;
}

/**
 * Analog Feedback: prior output frames re-entering zoomed / rotated a little more per generation
 * (a persistence tunnel), with a small chroma drift, then motion-gated tracking instability.
 * `prev(k)` returns the base (untreated) frame shown k output frames earlier.
 */
export function analogFeedback(base: Rgb, prev: (k: number) => Rgb, key: number, s: number, motion: number, p: P<"analogFeedback">, mode: BlendMode, rows: Float32Array | null, seed: number): Rgb {
  const out = copyRgb(base);
  if (s <= 0) return out;
  for (let k = p.layers; k >= 1; k--) {
    const wk = s * p.mix * Math.pow(p.decay, k - 1);
    if (wk <= 0.002) continue;
    compose(out, zoomRotate(prev(k), 1 + p.zoomPerLayer * k * s, p.rotateDegPerLayer * k * s, p.chromaPx * s * Math.min(1, k / 2)), wk, mode, rows);
  }
  return jitterRows(out, key, s, motion, p.jitterPx, p.jitterBandPx, p.jitterProbability, seed, rows);
}

/**
 * Slit-scan: horizontal bands shown from earlier frames. The delay of a band grows toward the
 * bottom of the frame and is modulated by a slowly drifting wave, so selected regions are pulled
 * through time; fractional delays blend the two neighbouring frames (smooth shear on motion).
 */
export function slitScan(F: FrameAt, f: number, s: number, p: P<"slitScan">, rows: Float32Array | null): Rgb {
  const base = F(f);
  const out = copyRgb(base);
  if (s <= 0) return out;
  const { w, h } = base;
  for (let y0 = 0; y0 < h; y0 += p.bandPx) {
    const yc = Math.min(h - 1, y0 + (p.bandPx >> 1));
    const u = (yc + 0.5) / h;
    const wave = 1 - p.waveDepth + p.waveDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * p.waveCycles * u - p.waveDriftPerFrame * f * 2 * Math.PI));
    const d = p.maxDelayFrames * s * u * wave * (rows ? rows[yc]! : 1);
    if (d <= 0.01) continue;
    const di = Math.floor(d);
    const fr = d - di;
    const A = F(Math.max(0, f - di)).data;
    const B = F(Math.max(0, f - di - 1)).data;
    for (let y = y0; y < Math.min(h, y0 + p.bandPx); y++) {
      const r0 = y * w * 3;
      for (let i = r0; i < r0 + w * 3; i++) out.data[i] = A[i]! * (1 - fr) + B[i]! * fr + 0.5;
    }
  }
  return out;
}

/**
 * Datamosh-style breakup (stateful across one clip window; reset on every cut). The mosh image M
 * behaves like a P-frame chain whose I-frame was removed: every block of M either REFRESHES from
 * the real frame, or stays stale and is dragged along the motion the real footage shows between
 * the previous and the current frame (quarter-resolution block matching; prediction without
 * residual). The refresh probability falls as the strength rises (1 - carryover * s, reduced in
 * the protect band) and a block always refreshes after maxStaleFrames, so nothing freezes and the
 * accumulated error grows only while the treatment builds. The measured motion is re-applied with
 * a gain of 1 + motionGain * s (the repeated-P-frame "bloom"): moving areas overshoot and smear,
 * static areas (zero motion) look unchanged.
 */
export class Datamosh {
  private m: Rgb | null = null;
  private age: Int32Array | null = null;
  private readonly p: P<"datamoshStyle">;
  private readonly seed: number;
  private readonly rows: Float32Array | null;
  constructor(p: P<"datamoshStyle">, seed: number, rows: Float32Array | null) {
    this.p = p;
    this.seed = seed;
    this.rows = rows;
  }
  reset(): void {
    this.m = null;
    this.age = null;
  }
  /** advance to frame f (cur) from its predecessor (prev); returns the output frame */
  step(cur: Rgb, prev: Rgb, f: number, s: number): { out: Rgb; carried: number; blocks: number } {
    const { w, h } = cur;
    const q = 4;
    const W = Math.floor(w / q);
    const Hq = Math.floor(h / q);
    const bq = Math.max(2, Math.floor(this.p.blockPx / q));
    const nbx = Math.ceil(W / bq);
    const nby = Math.ceil(Hq / bq);
    if (!this.m || !this.age || s <= 0) {
      this.m = copyRgb(cur);
      this.age = new Int32Array(nbx * nby);
      return { out: copyRgb(cur), carried: 0, blocks: nbx * nby };
    }
    const lq = (a: Rgb) => {
      const o = new Float32Array(W * Hq);
      for (let y = 0; y < Hq; y++)
        for (let x = 0; x < W; x++) {
          let t = 0;
          for (let dy = 0; dy < q; dy++)
            for (let dx = 0; dx < q; dx++) {
              const i = ((y * q + dy) * w + x * q + dx) * 3;
              t += 0.2126 * a.data[i]! + 0.7152 * a.data[i + 1]! + 0.0722 * a.data[i + 2]!;
            }
          o[y * W + x] = t / (q * q);
        }
      return o;
    };
    const C = lq(cur);
    const Pv = lq(prev);
    const sq = Math.max(1, Math.floor(this.p.searchPx / q));
    const old = this.m;
    const next = copyRgb(cur);
    let carried = 0;
    for (let by = 0; by < nby; by++)
      for (let bx = 0; bx < nbx; bx++) {
        const bi = by * nbx + bx;
        const x0 = bx * bq;
        const y0 = by * bq;
        const x1 = Math.min(W, x0 + bq);
        const y1 = Math.min(Hq, y0 + bq);
        const X0 = x0 * q;
        const Y0 = y0 * q;
        const X1 = bx === nbx - 1 ? w : x1 * q;
        const Y1 = by === nby - 1 ? h : y1 * q;
        const pw = this.rows ? this.rows[Math.min(h - 1, (Y0 + Y1) >> 1)]! : 1;
        const refresh = this.age[bi]! >= this.p.maxStaleFrames || hash01(this.seed, f, bi) >= this.p.carryover * s * pw;
        if (refresh) {
          this.age[bi] = 0;
          continue;
        }
        // motion of the real footage in this block: cur(x) ~ prev(x + d)
        const sad = (dx: number, dy: number) => {
          let t = 0;
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const px = Math.min(W - 1, Math.max(0, x + dx));
              const py = Math.min(Hq - 1, Math.max(0, y + dy));
              t += Math.abs(C[y * W + x]! - Pv[py * W + px]!);
            }
          return t;
        };
        let best = { dx: 0, dy: 0, c: sad(0, 0) };
        if (best.c > 0)
          for (let dy = -sq; dy <= sq; dy++)
            for (let dx = -sq; dx <= sq; dx++) {
              const c = sad(dx, dy);
              if (c < best.c - 1e-9 || (Math.abs(c - best.c) < 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, c };
            }
        // the repeated-P-frame bloom: the real motion re-applied with a gain that grows with s
        const gain = 1 + this.p.motionGain * s;
        const mvx = Math.round(best.dx * q * gain);
        const mvy = Math.round(best.dy * q * gain);
        this.age[bi] = this.age[bi]! + 1;
        carried++;
        for (let y = Y0; y < Y1; y++)
          for (let x = X0; x < X1; x++) {
            const sx = Math.min(w - 1, Math.max(0, x + mvx));
            const sy = Math.min(h - 1, Math.max(0, y + mvy));
            const o = (y * w + x) * 3;
            const i = (sy * w + sx) * 3;
            next.data[o] = old.data[i]!;
            next.data[o + 1] = old.data[i + 1]!;
            next.data[o + 2] = old.data[i + 2]!;
          }
      }
    this.m = next;
    const mix = Math.min(1, this.p.mix);
    const out = copyRgb(cur);
    for (let i = 0; i < out.data.length; i++) out.data[i] = cur.data[i]! + (next.data[i]! - cur.data[i]!) * mix + 0.5;
    return { out, carried, blocks: nbx * nby };
  }
}

/**
 * Feedback Crescendo, keyed by the SOURCE frame g (so a repeated source frame always produces the
 * same output: an approved stutter over it keeps its exact repetition): echo accumulation of the
 * nearest prior frames, a feedback tunnel of lagged frames zooming / turning a little more per
 * generation, then motion-gated instability.
 */
export function feedbackCrescendo(F: FrameAt, g: number, s: number, motion: number, p: P<"feedbackCrescendo">, mode: BlendMode, rows: Float32Array | null, seed: number): Rgb {
  const out = copyRgb(F(g));
  if (s <= 0) return out;
  const n = s * p.echoTrails;
  for (let k = p.echoTrails; k >= 1; k--) {
    const wk = s * p.mix * 0.6 * Math.pow(p.echoDecay, k - 1) * Math.min(1, Math.max(0, n - (k - 1)));
    if (wk > 0.002) compose(out, F(Math.max(0, g - k)), wk, mode, rows);
  }
  for (let k = p.layers; k >= 1; k--) {
    const wk = s * p.mix * Math.pow(p.decay, k - 1);
    if (wk <= 0.002) continue;
    compose(out, zoomRotate(F(Math.max(0, g - k * p.layerLag)), 1 + p.zoomPerLayer * k * s, p.rotateDegPerLayer * k * s), wk, mode, rows);
  }
  return jitterRows(out, g, s * s, motion, p.jitterPx, p.jitterBandPx, p.jitterProbability, seed, rows);
}
