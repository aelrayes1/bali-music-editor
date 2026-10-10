/**
 * FrameSeries: compact per-frame measurements accumulated while frames stream past (no frames are
 * kept), plus media-level overlay statistics. Pure and deterministic.
 */

import {
  OVERLAY_W,
  type Rect,
  THUMB_W,
  dHash,
  downsample,
  estimateMotion,
  frameBorders,
  frameStats,
  histL1,
  unionRect,
} from "./frame-metrics.ts";

export class FrameSeries {
  readonly w: number;
  readonly h: number;
  readonly halfW: number;
  readonly halfH: number;
  readonly thumbW = THUMB_W;
  readonly thumbH: number;
  readonly overlayW = OVERLAY_W;
  readonly overlayH: number;
  n = 0;
  // per-frame scalars
  mean: number[] = [];
  p05: number[] = [];
  p50: number[] = [];
  p95: number[] = [];
  clipHigh: number[] = [];
  crushLow: number[] = [];
  sharpness: number[] = [];
  black: boolean[] = [];
  identical: boolean[] = [];
  dx: number[] = [];
  dy: number[] = [];
  residual: number[] = [];
  rawDiff: number[] = [];
  /** histogram L1 distance to the previous frame (0..2), plain and brightness-centred */
  histDiff: number[] = [];
  histDiffCentered: number[] = [];
  rects: Rect[] = [];
  hashes: Array<[number, number]> = [];
  hists: Float32Array[] = [];
  thumbs: Uint8ClampedArray[] = [];
  /** Frames sampled every `ovStep` frames at OVERLAY_W resolution (overlay / watermark analysis). */
  readonly ovStep: number;
  ovFrames: Uint8ClampedArray[] = [];
  ovIndex: number[] = [];
  private prev: Uint8Array | null = null;
  private prevHalf: Float32Array | null = null;
  private prevHist: Float32Array | null = null;
  private prevHistC: Float32Array | null = null;

  /** Rect used for exposure/clipping/sharpness/black/hash: the media-level active picture (pre-pass). */
  readonly statsRect: Rect;

  constructor(w: number, h: number, statsRect: Rect | null = null, ovStep = 12) {
    this.w = w;
    this.h = h;
    this.statsRect = statsRect && statsRect.w >= 0.2 * w && statsRect.h >= 0.2 * h ? statsRect : { x: 0, y: 0, w, h };
    this.halfW = w >> 1;
    this.halfH = h >> 1;
    this.thumbH = Math.max(2, Math.round((THUMB_W * h) / w));
    this.overlayH = Math.max(2, Math.round((OVERLAY_W * h) / w));
    this.ovStep = Math.max(1, ovStep);
  }

  push(px: Uint8Array): void {
    const { w, h } = this;
    if (px.length !== w * h) throw new Error(`frame ${this.n}: ${px.length} bytes, expected ${w * h}`);
    const border = frameBorders(px, w, h);
    // Measure inside the media's dominant picture, widened by this frame's own picture where it is
    // larger (e.g. a full-frame title in pillarboxed footage); dark picture edges never shrink it.
    const r = border.w > 0 ? unionRect(border, this.statsRect) : this.statsRect;
    const s = frameStats(px, w, r);
    const black = s.mean < 12 && s.p95 < 28;
    const half = downsample(px, w, h, this.halfW, this.halfH);
    let identical = false;
    if (this.prev) {
      identical = true;
      for (let i = 0; i < px.length; i++) if (px[i] !== this.prev[i]) { identical = false; break; }
    }
    const hint = this.n > 1 ? { dx: this.dx[this.n - 1]!, dy: this.dy[this.n - 1]! } : null;
    const m = this.prevHalf ? estimateMotion(this.prevHalf, half, this.halfW, this.halfH, 6, hint) : { dx: 0, dy: 0, residual: 0, rawDiff: 0 };
    this.mean.push(s.mean);
    this.p05.push(s.p05);
    this.p50.push(s.p50);
    this.p95.push(s.p95);
    this.clipHigh.push(s.clipHigh);
    this.crushLow.push(s.crushLow);
    this.sharpness.push(s.sharpness);
    this.black.push(black);
    this.identical.push(identical);
    this.dx.push(m.dx);
    this.dy.push(m.dy);
    this.residual.push(m.residual);
    this.rawDiff.push(m.rawDiff);
    this.histDiff.push(this.prevHist ? histL1(this.prevHist, s.hist) : 0);
    this.histDiffCentered.push(this.prevHistC ? histL1(this.prevHistC, s.histCentered) : 0);
    this.rects.push(border);
    this.hashes.push(dHash(px, w, h, r));
    this.hists.push(s.hist);
    this.thumbs.push(Uint8ClampedArray.from(downsample(px, w, h, this.thumbW, this.thumbH), (v) => Math.round(v)));
    if (this.n % this.ovStep === 0) {
      this.ovFrames.push(Uint8ClampedArray.from(downsample(px, w, h, this.overlayW, this.overlayH), (v) => Math.round(v)));
      this.ovIndex.push(this.n);
    }
    this.prev = px.slice();
    this.prevHalf = half;
    this.prevHist = s.hist;
    this.prevHistC = s.histCentered;
    this.n++;
  }
}
