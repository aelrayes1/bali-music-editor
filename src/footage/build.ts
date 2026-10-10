/**
 * Shot segmentation and objective aggregation from a FrameSeries (pure, deterministic).
 * No creative ranking, no semantic labels.
 */

import { type Rational, add, mul, rational, sub, toNumberApprox } from "../time/rational.ts";
import { type Rect, dominantRect, hamming, histL1 } from "./frame-metrics.ts";
import type { ActivePicture, FootageAnalysis, Overlay, Shot } from "./schema.ts";
import type { FrameSeries } from "./series.ts";

export interface FootageConfig {
  /** Hard cut: histogram jump >= max(cutHistMin, cutHistRatio x local median) with real content change. */
  cutHistMin: number;
  cutHistRatio: number;
  cutResidualMin: number;
  /**
   * Content cut with similar histograms: motion-compensated change >= max(cutResidualAlt, ratio x
   * local median) AND brightness-normalised structure change >= max(cutStructureMin, ratio x local median).
   */
  cutResidualAlt: number;
  cutResidualRatio: number;
  /**
   * Every cut needs a contrast-normalised structure change (z-scored thumbnails, mean abs diff)
   * >= max(cutStructureMin, 2.5 x local median): fades, darkening and flashes cannot fake it.
   * Content-only cuts need >= max(cutStructureContentMin, 4 x local median).
   */
  cutStructureMin: number;
  cutStructureContentMin: number;
  /** Flash / lighting suppression. */
  flashLookahead: number;
  lightingCenteredMax: number;
  minShotSeconds: number;
  /** Local median histogram change above which the context is "lighting-unstable" (strobes). */
  strobeContextHist: number;
  strobeConfidenceCap: number;
  /** A fade through black needs at least this many seconds (and >= 3 frames) of black. */
  fadeMinBlackSeconds: number;
  freezeDiffMax: number;
  freezeMinSeconds: number;
  staticVideoFraction: number;
  /** Stability classes (jitter RMS, % of frame width per frame). */
  jitterStable: number;
  jitterShaky: number;
  lowMotionSpeed: number;
  highMotionSpeed: number;
  nearDuplicateHamming: number;
}

export const DEFAULT_FOOTAGE_CONFIG: FootageConfig = {
  cutHistMin: 0.45,
  cutHistRatio: 3,
  cutResidualMin: 8,
  cutResidualAlt: 15,
  cutResidualRatio: 2.5,
  cutStructureMin: 0.15,
  cutStructureContentMin: 0.3,
  flashLookahead: 4,
  lightingCenteredMax: 0.25,
  minShotSeconds: 0.25,
  strobeContextHist: 0.15,
  strobeConfidenceCap: 0.4,
  fadeMinBlackSeconds: 0.12,
  freezeDiffMax: 0.4,
  freezeMinSeconds: 0.5,
  staticVideoFraction: 0.9,
  jitterStable: 0.25,
  jitterShaky: 0.8,
  lowMotionSpeed: 0.02,
  highMotionSpeed: 0.25,
  nearDuplicateHamming: 6,
};

export interface FrameTiming {
  /** Presentation timestamps (stream ticks) in decode order = presentation order. */
  pts: number[];
  /** Duration of the last frame in ticks (for the media end). */
  lastDuration: number;
  timeBase: Rational;
}

export interface BuildMeta {
  mediaId: string;
  fingerprint: string;
  fileName: string;
  streamIndex: number;
  stored: { w: number; h: number };
  display: { w: number; h: number };
  rotationClockwise: number;
  orientation: string;
  frameRateMode: string;
  codec: string;
  fieldOrder: string | null;
  bitRate: number | null;
  analyzer: FootageAnalysis["analyzer"];
  generatedAt: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const stat = (xs: number[]) => ({ mean: r3(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0), p10: r3(quantile(xs, 0.1)), p50: r3(quantile(xs, 0.5)), p90: r3(quantile(xs, 0.9)) });

function localMedian(xs: number[], i: number, half: number): number {
  const vals: number[] = [];
  for (let j = Math.max(1, i - half); j <= Math.min(xs.length - 1, i + half); j++) if (Math.abs(j - i) > 1) vals.push(xs[j]!);
  return quantile(vals, 0.5);
}

/**
 * Steady-state level next to frame i: the smaller of the medians before and after it. A cut is a
 * change relative to the calmer side, so fast motion on one side (e.g. a whip pan starting right
 * after the cut) cannot raise the threshold and hide the cut.
 */
function sideMedian(xs: number[], i: number, half: number): number {
  const before: number[] = [];
  const after: number[] = [];
  for (let j = Math.max(1, i - half); j <= i - 2; j++) before.push(xs[j]!);
  for (let j = i + 2; j <= Math.min(xs.length - 1, i + half); j++) after.push(xs[j]!);
  if (!before.length) return quantile(after, 0.5);
  if (!after.length) return quantile(before, 0.5);
  return Math.min(quantile(before, 0.5), quantile(after, 0.5));
}

/** Mean abs difference of z-scored thumbnails: structure change independent of brightness and contrast. */
export function structureDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const z = (t: Uint8ClampedArray) => {
    let m = 0;
    for (let i = 0; i < t.length; i++) m += t[i]!;
    m /= t.length;
    let sd = 0;
    for (let i = 0; i < t.length; i++) sd += (t[i]! - m) ** 2;
    return { m, sd: Math.sqrt(sd / t.length) + 4 };
  };
  const za = z(a);
  const zb = z(b);
  let q = 0;
  for (let i = 0; i < a.length; i++) q += Math.abs((a[i]! - za.m) / za.sd - (b[i]! - zb.m) / zb.sd);
  return q / a.length;
}

function thumbDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, centered = false): number {
  let ma = 0;
  let mb = 0;
  if (centered) {
    for (let i = 0; i < a.length; i++) {
      ma += a[i]!;
      mb += b[i]!;
    }
    ma /= a.length;
    mb /= b.length;
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - ma - (b[i]! - mb));
  return s / a.length;
}

export interface Boundary {
  frame: number;
  type: "hard_cut" | "fade_through_black";
  confidence: number;
  evidence: string;
}

/** Conservative hard-cut detection with flash / lighting-change suppression. */
export function detectBoundaries(s: FrameSeries, fps: number, cfg: FootageConfig): { cuts: Boundary[]; suppressed: Array<{ frame: number; reason: string }> } {
  const half = Math.max(5, Math.round(fps / 2));
  const cuts: Boundary[] = [];
  const suppressed: Array<{ frame: number; reason: string }> = [];
  const minGap = Math.max(2, Math.round(cfg.minShotSeconds * fps));
  // brightness-normalised structural change between consecutive frames (40-wide thumbnails)
  const structure = s.thumbs.map((t, i) => (i ? structureDiff(s.thumbs[i - 1]!, t) : 0));
  for (let i = 1; i < s.n; i++) {
    if (s.black[i] || s.black[i - 1]) continue; // handled by fade-through-black below
    const d = s.histDiff[i]!;
    const e = s.residual[i]!;
    const st = structure[i]!;
    // calmer-side steady state, except in strobe lighting where a calm side is misleading
    const strobeCtx = localMedian(s.histDiff, i, Math.round(fps)) >= cfg.strobeContextHist;
    const fires = (level: (xs: number[], i: number, half: number) => number) => {
      const md = level(s.histDiff, i, half);
      const me = level(s.residual, i, half);
      const ms = level(structure, i, half);
      const thrA = Math.max(cfg.cutHistMin, cfg.cutHistRatio * md);
      const thrE = Math.max(cfg.cutResidualAlt, cfg.cutResidualRatio * me);
      const structural = st >= Math.max(cfg.cutStructureMin, 2.5 * ms);
      return { md, me, ms, thrA, thrE, structural, byHist: d >= thrA && e >= Math.max(cfg.cutResidualMin, 2 * me) && structural, byContent: e >= thrE && st >= Math.max(cfg.cutStructureContentMin, 4 * ms) };
    };
    const sym = fires(localMedian);
    let use = sym;
    if (!sym.byHist && !sym.byContent && !strobeCtx) {
      // calmer-side steady state (fast motion on one side must not hide a cut) — but then the frame
      // must be an isolated spike: a cut is one frame, a camera move is sustained.
      const side = fires(sideMedian);
      const n1 = Math.max(structure[i - 1] ?? 0, structure[i + 1] ?? 0);
      const e1 = Math.max(s.residual[i - 1] ?? 0, s.residual[i + 1] ?? 0);
      if ((side.byHist || side.byContent) && st >= 1.8 * n1 && e >= 1.5 * e1) use = side;
    }
    const { md, me, ms, thrA, thrE, structural, byHist, byContent } = use;
    if (!byHist && !byContent && d >= thrA && !structural) {
      suppressed.push({ frame: i, reason: `brightness/contrast change without structural change (hist jump ${r3(d)}, structure ${r3(st)}): fade, flash or lighting` });
      continue;
    }
    if (!byHist && !byContent) continue;
    // Flash: the picture returns to the pre-jump content within a few frames (skip the whole span).
    let returnAt = -1;
    for (let k = 1; k <= cfg.flashLookahead && i + k < s.n; k++) {
      const back = histL1(s.hists[i - 1]!, s.hists[i + k]!);
      const tdBack = thumbDiff(s.thumbs[i - 1]!, s.thumbs[i + k]!);
      const tdJump = thumbDiff(s.thumbs[i - 1]!, s.thumbs[i]!);
      if (back <= 0.5 * d + 0.02 && tdBack < 0.5 * tdJump) {
        returnAt = i + k;
        break;
      }
    }
    if (returnAt > 0) {
      suppressed.push({ frame: i, reason: `flash: content returns after ${returnAt - i} frame(s) (hist jump ${r3(d)})` });
      i = returnAt; // the return transition is part of the flash, not a cut
      continue;
    }
    // Lighting change: brightness-centred histogram and structure barely change.
    if (s.histDiffCentered[i]! <= cfg.lightingCenteredMax && thumbDiff(s.thumbs[i - 1]!, s.thumbs[i]!, true) < 6) {
      suppressed.push({ frame: i, reason: `global brightness change without structural change (centred hist ${r3(s.histDiffCentered[i]!)})` });
      continue;
    }
    const strength = byHist ? d / thrA : e / thrE;
    const strobe = localMedian(s.histDiff, i, Math.round(fps)) >= cfg.strobeContextHist;
    let conf = r3(Math.min(1, 0.5 + 0.25 * (strength - 1) + (byHist && byContent ? 0.2 : 0)));
    if (strobe) conf = Math.min(conf, cfg.strobeConfidenceCap);
    const evidence = (strobe ? `lighting-unstable context (strobe): may be a lighting change within one take; ` : "") + `hist jump ${r3(d)} (local median ${r3(md)}), motion-compensated change ${r2(e)} (local median ${r2(me)}), structure change ${r3(st)} (local median ${r3(ms)})${byContent && !byHist ? "; content change with similar histogram" : ""}`;
    const last = cuts.at(-1);
    if (last && i - last.frame < minGap) {
      if (conf > last.confidence) cuts[cuts.length - 1] = { frame: i, type: "hard_cut", confidence: conf, evidence };
      else suppressed.push({ frame: i, reason: `within ${cfg.minShotSeconds} s of a stronger cut` });
      continue;
    }
    cuts.push({ frame: i, type: "hard_cut", confidence: conf, evidence });
  }
  // Fade / dip through black: compare the picture before the black run with the picture ~0.4 s after
  // it (past any fade-in). Short runs need stronger evidence and must not sit in strobe lighting.
  const settle = Math.max(3, Math.round(0.4 * fps));
  for (let i = 1; i < s.n; i++) {
    if (!s.black[i] || s.black[i - 1]) continue;
    let j = i;
    while (j < s.n && s.black[j]) j++;
    if (j >= s.n) break;
    const sd = (t: Uint8ClampedArray) => {
      let m = 0;
      for (let k = 0; k < t.length; k++) m += t[k]!;
      m /= t.length;
      let v = 0;
      for (let k = 0; k < t.length; k++) v += (t[k]! - m) ** 2;
      return Math.sqrt(v / t.length);
    };
    // compare real picture content: before a fade-out and after a fade-in (the more contrasty frame)
    const pickBy = (cands: number[]) => cands.filter((k) => k >= 0 && k < s.n && !s.black[k]).sort((a, b) => sd(s.thumbs[b]!) - sd(s.thumbs[a]!) || a - b)[0] ?? cands[0]!;
    const before = pickBy([i - 1, i - 1 - settle]);
    const after = pickBy([Math.min(s.n - 1, j + settle), Math.min(s.n - 1, j + 2 * settle)]);
    const st = structureDiff(s.thumbs[before]!, s.thumbs[after]!);
    if (Math.min(sd(s.thumbs[before]!), sd(s.thumbs[after]!)) < 10) {
      suppressed.push({ frame: i, reason: `${j - i} black frame(s) in a dark, low-contrast scene: structure not measurable, not a cut` });
      i = j;
      continue;
    }
    const long = j - i >= Math.max(3, Math.round(cfg.fadeMinBlackSeconds * fps));
    const strobe = localMedian(s.histDiff, i, Math.round(fps)) >= cfg.strobeContextHist;
    if (long ? st >= cfg.cutStructureContentMin : st >= 0.45 && !strobe) {
      cuts.push({ frame: i, type: "fade_through_black", confidence: long ? 0.8 : 0.65, evidence: `${j - i} black frame(s) between different content (structure ${r3(st)} before vs ${Math.round(settle / fps * 100) / 100} s after)` });
    } else {
      suppressed.push({ frame: i, reason: `${j - i} black frame(s), same content around it (structure ${r3(st)})${strobe ? " in strobe lighting" : ""}: blackout, not a cut` });
    }
    i = j;
  }
  cuts.sort((a, b) => a.frame - b.frame);
  const dedup: Boundary[] = [];
  for (const c of cuts) {
    const last = dedup.at(-1);
    if (last && c.frame - last.frame < minGap) {
      if (c.confidence > last.confidence) dedup[dedup.length - 1] = c;
    } else dedup.push(c);
  }
  return { cuts: dedup, suppressed };
}

/**
 * Active picture over a set of frames: the dominant per-frame picture rect (within ±2 analysis px),
 * its coverage as `stableFraction`. `union` mode (shots) uses the robust union of lit area instead.
 */
function activePicture(rects: Rect[], use: boolean[], w: number, h: number, scaleX: number, scaleY: number, mode: "dominant" | "union" = "union"): ActivePicture {
  const idx = rects.map((_, i) => i).filter((i) => use[i] && rects[i]!.w > 0);
  const encodedFrame = { x: 0, y: 0, w: Math.round(w * scaleX), h: Math.round(h * scaleY) };
  if (!idx.length) {
    return { encodedFrame, activeRect: encodedFrame, borders: { left: 0, right: 0, top: 0, bottom: 0 }, type: "undetermined", activeAspect: null, stableFraction: 0, confidence: 0 };
  }
  let left: number;
  let top: number;
  let right: number;
  let bottom: number;
  let stable: number;
  if (mode === "dominant") {
    const d = dominantRect(idx.map((i) => rects[i]!))!;
    left = d.rect.x;
    top = d.rect.y;
    right = d.rect.x + d.rect.w;
    bottom = d.rect.y + d.rect.h;
    stable = d.coverage;
  } else {
    // Columns/rows lit in (almost) any frame: robust union of per-frame active rects.
    left = Math.round(quantile(idx.map((i) => rects[i]!.x), 0.02));
    top = Math.round(quantile(idx.map((i) => rects[i]!.y), 0.02));
    right = Math.round(quantile(idx.map((i) => rects[i]!.x + rects[i]!.w), 0.98));
    bottom = Math.round(quantile(idx.map((i) => rects[i]!.y + rects[i]!.h), 0.98));
    stable = idx.filter((i) => {
      const r = rects[i]!;
      return Math.abs(r.x - left) <= 2 && Math.abs(r.y - top) <= 2 && Math.abs(r.x + r.w - right) <= 2 && Math.abs(r.y + r.h - bottom) <= 2;
    }).length / idx.length;
  }
  const toD = (v: number, sc: number) => Math.round(v * sc);
  const activeRect = { x: toD(left, scaleX), y: toD(top, scaleY), w: toD(right, scaleX) - toD(left, scaleX), h: toD(bottom, scaleY) - toD(top, scaleY) };
  const borders = { left: activeRect.x, right: encodedFrame.w - activeRect.x - activeRect.w, top: activeRect.y, bottom: encodedFrame.h - activeRect.y - activeRect.h };
  const minB = 0.02; // borders narrower than 2 % of the frame are treated as none
  const lr = borders.left + borders.right > minB * encodedFrame.w;
  const tb = borders.top + borders.bottom > minB * encodedFrame.h;
  const type = lr && tb ? "windowbox" : lr ? "pillarbox" : tb ? "letterbox" : "full_frame";
  return {
    encodedFrame,
    activeRect,
    borders,
    type,
    activeAspect: activeRect.h ? r3(activeRect.w / activeRect.h) : null,
    stableFraction: r3(stable),
    confidence: r3(Math.min(1, 0.4 + 0.6 * stable) * Math.min(1, idx.length / 10)),
  };
}

function regions(flags: boolean[], times: Rational[], end: Rational, minSeconds: number): Array<{ start: Rational; end: Rational; duration: Rational; frames: number }> {
  const out = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (j < flags.length && flags[j]) j++;
    const s = times[i]!;
    const e = j < times.length ? times[j]! : end;
    const d = sub(e, s);
    if (toNumberApprox(d) >= minSeconds) out.push({ start: s, end: e, duration: d, frames: j - i });
    i = j;
  }
  return out;
}

const hex = (h: [number, number]) => h[1].toString(16).padStart(8, "0") + h[0].toString(16).padStart(8, "0");

/**
 * Burned-in overlays (watermarks, logos, bar graphics): on frames sampled at ~2 fps, a static overlay's
 * edges keep the same gradient direction in every frame even when semi-transparent, while scene edges
 * average out. Consistency = |sum of gradient vectors| / sum of magnitudes. Persistence is counted
 * over DISTINCT scenes (shots grouped by fingerprint), so a background repeated by several shots of
 * one camera set-up is not mistaken for an overlay.
 */
/** Overlay candidates below this confidence are not reported (heuristic; see docs/footage-intelligence.md). */
export const OVERLAY_MIN_CONFIDENCE = 0.35;

function detectOverlays(s: FrameSeries, shots: Array<[number, number]>, picture: Rect, scaleX: number, scaleY: number): { overlays: Overlay[]; evaluable: boolean } {
  const ow = s.overlayW;
  const oh = s.overlayH;
  const P = ow * oh;
  const shotOf = (f: number) => shots.findIndex(([a, b]) => f >= a && f < b);
  // distinct scenes: group shots whose representative fingerprints are close
  const sceneOf: number[] = [];
  const sceneHashes: Array<[number, number]> = [];
  for (const [a, b] of shots) {
    const h = s.hashes[a + ((b - a) >> 1)]!;
    let g = sceneHashes.findIndex((x) => hamming(x, h) <= 12);
    if (g < 0) {
      g = sceneHashes.length;
      sceneHashes.push(h);
    }
    sceneOf.push(g);
  }
  const samples = s.ovIndex.map((f, k) => ({ f, k })).filter(({ f }) => !s.black[f] && (f === 0 || s.rawDiff[f]! > 0.4));
  const scenes = new Map<number, { gx: Float32Array; gy: Float32Array; mag: Float32Array; n: number }>();
  const gx = new Float64Array(P);
  const gy = new Float64Array(P);
  const mag = new Float64Array(P);
  for (const { f, k } of samples) {
    const sc = sceneOf[shotOf(f)]!;
    let acc = scenes.get(sc);
    if (!acc) scenes.set(sc, (acc = { gx: new Float32Array(P), gy: new Float32Array(P), mag: new Float32Array(P), n: 0 }));
    acc.n++;
    const t = s.ovFrames[k]!;
    for (let y = 1; y < oh - 1; y++) {
      for (let x = 1; x < ow - 1; x++) {
        const o = y * ow + x;
        const X = t[o - ow + 1]! + 2 * t[o + 1]! + t[o + ow + 1]! - t[o - ow - 1]! - 2 * t[o - 1]! - t[o + ow - 1]!;
        const Y = t[o + ow - 1]! + 2 * t[o + ow]! + t[o + ow + 1]! - t[o - ow - 1]! - 2 * t[o - ow]! - t[o - ow + 1]!;
        const m = Math.hypot(X, Y);
        gx[o]! += X;
        gy[o]! += Y;
        mag[o]! += m;
        acc.gx[o]! += X;
        acc.gy[o]! += Y;
        acc.mag[o]! += m;
      }
    }
  }
  const eligible = [...scenes.values()].filter((x) => x.n >= 3);
  if (eligible.length < 3) return { overlays: [], evaluable: false };
  const n = samples.length;
  const cons = new Float64Array(P);
  const strength = new Float64Array(P);
  for (let p = 0; p < P; p++) {
    const v = Math.hypot(gx[p]!, gy[p]!);
    cons[p] = mag[p]! > 1e-6 ? v / mag[p]! : 0;
    strength[p] = v / n;
  }
  // picture rect in overlay coordinates; exclude a 2-px band around its boundary and the frame rim
  const px0 = Math.round((picture.x / s.w) * ow);
  const py0 = Math.round((picture.y / s.h) * oh);
  const px1 = Math.round(((picture.x + picture.w) / s.w) * ow);
  const py1 = Math.round(((picture.y + picture.h) / s.h) * oh);
  const nearBoundary = (x: number, y: number) =>
    (Math.abs(x - px0) <= 2 || Math.abs(x - px1) <= 2) && y >= py0 - 2 && y <= py1 + 2 ? true : (Math.abs(y - py0) <= 2 || Math.abs(y - py1) <= 2) && x >= px0 - 2 && x <= px1 + 2;
  const inPicture = (x: number, y: number) => x >= px0 && x < px1 && y >= py0 && y < py1;
  const ref: number[] = [];
  for (let y = 1; y < oh - 1; y++) for (let x = 1; x < ow - 1; x++) if (inPicture(x, y) && !nearBoundary(x, y)) ref.push(strength[y * ow + x]!);
  const refStrength = quantile(ref, 0.5);
  const cand = new Uint8Array(P);
  for (let y = 2; y < oh - 2; y++) {
    for (let x = 2; x < ow - 2; x++) {
      const p = y * ow + x;
      if (!nearBoundary(x, y) && cons[p]! >= 0.6 && strength[p]! >= Math.max(8, 3 * refStrength)) cand[p] = 1;
    }
  }
  // connect strokes: 8-connected components on a 1-px dilation
  const dil = new Uint8Array(P);
  for (let p = 0; p < P; p++) {
    if (!cand[p]) continue;
    const x = p % ow;
    const y = (p / ow) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < ow && yy < oh) dil[yy * ow + xx] = 1;
    }
  }
  const seen = new Uint8Array(P);
  const overlays: Overlay[] = [];
  for (let p0 = 0; p0 < P; p0++) {
    if (!dil[p0] || seen[p0]) continue;
    const stack = [p0];
    seen[p0] = 1;
    const cells: number[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      if (cand[p]) cells.push(p);
      const x = p % ow;
      const y = (p / ow) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= ow || yy >= oh) continue;
        const q = yy * ow + xx;
        if (dil[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (cells.length < 6) continue;
    const xs = cells.map((p) => p % ow);
    const ys = cells.map((p) => (p / ow) | 0);
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    const bw = Math.max(...xs) - bx + 1;
    const bh = Math.max(...ys) - by + 1;
    // A scene shows this overlay if its own gradient field over the component is consistent AND
    // points the same way as the media-wide field (the same graphic, not just any static scenery).
    const present = eligible.map((sc) => {
      let dot = 0;
      let ns = 0;
      let ng = 0;
      let cons = 0;
      for (const p of cells) {
        dot += sc.gx[p]! * gx[p]! + sc.gy[p]! * gy[p]!;
        ns += sc.gx[p]! ** 2 + sc.gy[p]! ** 2;
        ng += gx[p]! ** 2 + gy[p]! ** 2;
        cons += sc.mag[p]! > 1e-6 ? Math.hypot(sc.gx[p]!, sc.gy[p]!) / sc.mag[p]! : 0;
      }
      const cos = ns > 0 && ng > 0 ? dot / Math.sqrt(ns * ng) : 0;
      return cos >= 0.7 && cons / cells.length >= 0.5;
    });
    const persistence = present.filter(Boolean).length / eligible.length;
    if (persistence < 0.6) continue;
    const meanCons = cells.reduce((acc, p) => acc + cons[p]!, 0) / cells.length;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const location = inPicture(cx, cy) ? "picture" : "border";
    // thin structure hugging the picture edge (analog blanking, head-switching, frame lines)
    const edgeTol = 0.04;
    const pw = Math.max(1, px1 - px0);
    const ph = Math.max(1, py1 - py0);
    const hugsSide = (bx - px0 <= edgeTol * pw || px1 - (bx + bw) <= edgeTol * pw) && bh >= 4 * bw;
    const hugsTopBottom = (by - py0 <= edgeTol * ph || py1 - (by + bh) <= edgeTol * ph) && bw >= 4 * bh;
    const kind = hugsSide || hugsTopBottom ? "edge_structure" : "graphic";
    const dispW = Math.round(s.w * scaleX);
    const dispH = Math.round(s.h * scaleY);
    const toD = (v: number, nn: number, d: number) => Math.round((v / nn) * d);
    const confidence = r3(Math.min(1, persistence * meanCons * Math.min(1, eligible.length / 6)));
    if (confidence < OVERLAY_MIN_CONFIDENCE) continue; // weak candidates are not reported
    overlays.push({
      id: `overlay:${String(overlays.length).padStart(2, "0")}`,
      kind,
      location,
      bbox: { x: toD(bx, ow, dispW), y: toD(by, oh, dispH), w: toD(bx + bw, ow, dispW) - toD(bx, ow, dispW), h: toD(by + bh, oh, dispH) - toD(by, oh, dispH) },
      bboxNormalized: { x: r3(bx / ow), y: r3(by / oh), w: r3(bw / ow), h: r3(bh / oh) },
      persistence: r3(persistence),
      confidence,
      evidence: `${cells.length} px with gradient-direction consistency ${r2(meanCons)} across ${n} sampled frames; present in ${Math.round(persistence * eligible.length)}/${eligible.length} distinct scenes`,
    });
  }
  return { overlays, evaluable: true };
}

export function buildFootageAnalysis(s: FrameSeries, timing: FrameTiming, meta: BuildMeta, cfg: FootageConfig = DEFAULT_FOOTAGE_CONFIG): FootageAnalysis {
  if (s.n !== timing.pts.length) throw new Error(`${meta.mediaId}: ${s.n} frames decoded but ${timing.pts.length} timestamps`);
  if (s.n === 0) throw new Error(`${meta.mediaId}: no frames decoded`);
  const tb = timing.timeBase;
  const times = timing.pts.map((p) => mul(rational(p), tb));
  const end = add(times.at(-1)!, mul(rational(timing.lastDuration), tb));
  const span = toNumberApprox(sub(end, times[0]!));
  const fps = s.n / Math.max(1e-6, span);
  const frameDur = times.map((t, i) => toNumberApprox(sub(i + 1 < times.length ? times[i + 1]! : end, t)));
  const scaleX = meta.display.w / s.w;
  const scaleY = meta.display.h / s.h;
  const warnings: FootageAnalysis["warnings"] = [];

  const { cuts, suppressed } = detectBoundaries(s, fps, cfg);
  const starts = [0, ...cuts.map((c) => c.frame)];
  const ranges: Array<[number, number]> = starts.map((a, k) => [a, k + 1 < starts.length ? starts[k + 1]! : s.n]);

  const notBlack = s.black.map((b) => !b);
  const mediaActive = activePicture(s.rects, notBlack, s.w, s.h, scaleX, scaleY, "dominant");
  const frozen = s.rawDiff.map((d, i) => i > 0 && (s.identical[i]! || d <= cfg.freezeDiffMax));
  const unique = s.identical.filter((x) => !x).length;
  const frozenFraction = s.n > 1 ? frozen.filter(Boolean).length / (s.n - 1) : 0;
  const staticImageVideo = s.n > 1 && frozenFraction >= cfg.staticVideoFraction;
  const ov = staticImageVideo ? { overlays: [], evaluable: false } : detectOverlays(s, ranges, s.statsRect, scaleX, scaleY);
  if (!ov.evaluable) warnings.push({ code: "OVERLAY_NOT_EVALUABLE", message: "fewer than 3 distinct moving scenes: burned-in overlays cannot be separated from static scenery" });
  if (staticImageVideo) warnings.push({ code: "STATIC_IMAGE_VIDEO", message: `${r3(frozenFraction * 100)} % of frame transitions show no change: a still image presented as video` });

  const shots: Shot[] = ranges.map(([a, b], k) => {
    const idx = Array.from({ length: b - a }, (_, i) => a + i);
    const live = idx.filter((i) => !s.black[i]);
    const use = live.length ? live : idx;
    const pick = (arr: number[]) => use.map((i) => arr[i]!);
    const ap = activePicture(s.rects.slice(a, b), s.black.slice(a, b).map((x) => !x), s.w, s.h, scaleX, scaleY);
    // representative: sharpest frame in the middle third (ties -> earliest)
    const m0 = a + Math.floor((b - a) / 3);
    const m1 = Math.max(m0 + 1, a + Math.ceil((2 * (b - a)) / 3));
    let rep = a + Math.floor((b - a) / 2);
    for (let i = m0; i < m1; i++) if (!s.black[i] && (s.black[rep] || s.sharpness[i]! > s.sharpness[rep]!)) rep = i;
    const motionIdx = idx.filter((i) => i > a && !s.black[i]);
    const speed = motionIdx.map((i) => Math.hypot(s.dx[i]!, s.dy[i]!) / s.w / Math.max(1e-6, frameDur[i - 1]!));
    const sx = motionIdx.reduce((acc, i) => acc + s.dx[i]!, 0);
    const sy = motionIdx.reduce((acc, i) => acc + s.dy[i]!, 0);
    const sm = motionIdx.reduce((acc, i) => acc + Math.hypot(s.dx[i]!, s.dy[i]!), 0);
    const dirNorm = Math.hypot(sx, sy);
    // jitter: high-pass of the per-frame translation (centred moving average over ~0.5 s)
    const win = Math.max(3, Math.round(fps / 4));
    const jit: number[] = [];
    for (let q = 0; q < motionIdx.length; q++) {
      let ax = 0;
      let ay = 0;
      let c = 0;
      for (let j = Math.max(0, q - win); j <= Math.min(motionIdx.length - 1, q + win); j++) {
        ax += s.dx[motionIdx[j]!]!;
        ay += s.dy[motionIdx[j]!]!;
        c++;
      }
      jit.push((s.dx[motionIdx[q]!]! - ax / c) ** 2 + (s.dy[motionIdx[q]!]! - ay / c) ** 2);
    }
    const enough = jit.length >= Math.max(12, Math.round(fps / 2)); // at least ~0.5 s of motion samples
    const jitterRms = enough ? r3((Math.sqrt(jit.reduce((x, y) => x + y, 0) / jit.length) / s.w) * 100) : 0;
    const stabilityClass = !enough ? "undetermined" : jitterRms < cfg.jitterStable ? "stable" : jitterRms < cfg.jitterShaky ? "moderate" : "shaky";
    const usableFrames = idx.filter((i) => !s.black[i] && s.p50[i]! >= 8 && s.p50[i]! <= 247 && s.clipHigh[i]! < 0.25 && s.crushLow[i]! < 0.6);
    const shotEnd = b < s.n ? times[b]! : end;
    const duration = sub(shotEnd, times[a]!);
    const usableSeconds = usableFrames.reduce((acc, i) => add(acc, sub(i + 1 < s.n ? times[i + 1]! : end, times[i]!)), rational(0));
    // 9:16 crop safety
    const cropWidth = Math.round((ap.activeRect.h * 9) / 16);
    const cx0 = ap.activeRect.x + (ap.activeRect.w - cropWidth) / 2;
    const overlaps = ov.overlays.some((o) => o.bbox.x < cx0 + cropWidth && o.bbox.x + o.bbox.w > cx0 && o.bbox.y < ap.activeRect.y + ap.activeRect.h && o.bbox.y + o.bbox.h > ap.activeRect.y);
    let gx = 0;
    let gs = 0;
    const tw = s.thumbW;
    const axa = Math.floor((ap.activeRect.x / meta.display.w) * tw);
    const axb = Math.ceil(((ap.activeRect.x + ap.activeRect.w) / meta.display.w) * tw);
    for (const i of use) {
      const t = s.thumbs[i]!;
      for (let y = 0; y < s.thumbH; y++) for (let x = Math.max(1, axa); x < Math.min(tw, axb); x++) {
        const g = Math.abs(t[y * tw + x]! - t[y * tw + x - 1]!);
        gx += g * (x - axa) / Math.max(1, axb - axa);
        gs += g;
      }
    }
    const shotWarnings: Shot["warnings"] = [];
    if (b - a < 5) shotWarnings.push({ code: "VERY_SHORT_SHOT", message: `${b - a} frames` });
    if (!live.length) shotWarnings.push({ code: "ALL_BLACK", message: "every frame is black" });
    const boundary = k === 0 ? null : cuts[k - 1]!;
    const hl = pick(s.clipHigh);
    const sh = pick(s.crushLow);
    return {
      shotId: `shot:${String(k).padStart(4, "0")}`,
      index: k,
      start: times[a]!,
      end: shotEnd,
      duration,
      frames: { first: a, last: b - 1, count: b - a },
      boundaryIn: boundary ? { type: boundary.type, confidence: boundary.confidence, evidence: boundary.evidence } : { type: "media_start", confidence: 1, evidence: "first frame" },
      representative: { time: times[rep]!, frameIndex: rep, reason: "sharpest non-black frame in the middle third of the shot" },
      sharpness: { ...stat(pick(s.sharpness)), scale: "laplacian variance at analysis resolution" },
      exposure: {
        meanLuma: r3(quantile(pick(s.mean), 0.5)),
        p05: r3(quantile(pick(s.p05), 0.5)),
        p50: r3(quantile(pick(s.p50), 0.5)),
        p95: r3(quantile(pick(s.p95), 0.5)),
        dynamicRange: r3(quantile(pick(s.p95), 0.5) - quantile(pick(s.p05), 0.5)),
      },
      clipping: {
        highlightFraction: stat(hl),
        shadowFraction: stat(sh),
        framesHighlightClipped: r3(hl.filter((v) => v > 0.02).length / Math.max(1, hl.length)),
        framesShadowCrushed: r3(sh.filter((v) => v > 0.2).length / Math.max(1, sh.length)),
      },
      motion: {
        globalSpeed: { ...stat(speed), unit: "frame widths per second" },
        meanDirection: { x: dirNorm ? r3(sx / dirNorm) : 0, y: dirNorm ? r3(sy / dirNorm) : 0 },
        directionalConsistency: sm ? r3(dirNorm / sm) : 0,
        frameChange: { ...stat(motionIdx.map((i) => s.rawDiff[i]!)), unit: "mean abs luma diff per frame (0-255)" },
        localChange: { ...stat(motionIdx.map((i) => s.residual[i]!)), unit: "motion-compensated mean abs luma diff (0-255)" },
        lowMotionFraction: r3(speed.filter((v) => v < cfg.lowMotionSpeed).length / Math.max(1, speed.length)),
        highMotionFraction: r3(speed.filter((v) => v >= cfg.highMotionSpeed).length / Math.max(1, speed.length)),
      },
      stability: { jitterRms, unit: "percent of frame width per frame", class: stabilityClass },
      activePicture: ap,
      static: {
        frozenFraction: r3(idx.filter((i) => frozen[i]).length / Math.max(1, b - a)),
        identicalFraction: r3(idx.filter((i) => i > 0 && s.identical[i]).length / Math.max(1, b - a)),
        freezeRegions: regions(idx.map((i) => frozen[i]!), idx.map((i) => times[i]!), shotEnd, cfg.freezeMinSeconds),
      },
      black: { fraction: r3((b - a - live.length) / Math.max(1, b - a)), regions: regions(idx.map((i) => s.black[i]!), idx.map((i) => times[i]!), shotEnd, 0) },
      usable: {
        seconds: usableSeconds,
        fraction: r3(toNumberApprox(usableSeconds) / Math.max(1e-9, toNumberApprox(duration))),
        rule: "non-black frames with median luma 8-247, < 25 % pixels >= 250 and < 60 % pixels <= 5",
      },
      overlayIds: ov.overlays.map((o) => o.id),
      crop916: {
        cropWidth,
        fitsInActivePicture: cropWidth <= ap.activeRect.w,
        centeredCropOverlapsOverlay: overlaps,
        detailCentroidX: gs > 0 ? r3(gx / gs) : null,
      },
      dHash: hex(s.hashes[rep]!),
      nearDuplicates: [],
      warnings: shotWarnings,
      confidence: r3(Math.min(1, (boundary ? boundary.confidence : 1) * Math.min(1, (b - a) / 10) * (live.length ? 1 : 0.3))),
    };
  });

  // Near-duplicate shots within this media (cross-media pairs are added by the index step).
  for (const x of shots) {
    for (const y of shots) {
      if (x === y) continue;
      const hmm = hamming(parseHash(x.dHash), parseHash(y.dHash));
      if (hmm <= cfg.nearDuplicateHamming && Math.abs(x.exposure.meanLuma - y.exposure.meanLuma) < 12) x.nearDuplicates.push({ mediaId: meta.mediaId, shotId: y.shotId, hamming: hmm });
    }
  }

  const videoBits = meta.bitRate;
  return {
    schemaVersion: "1.0.0",
    generatedAt: meta.generatedAt,
    analyzer: meta.analyzer,
    source: { mediaId: meta.mediaId, fingerprint: meta.fingerprint, fileName: meta.fileName, streamIndex: meta.streamIndex },
    geometry: { stored: meta.stored, display: meta.display, rotationClockwise: meta.rotationClockwise, orientation: meta.orientation, analysis: { w: s.w, h: s.h } },
    timing: { frameCount: s.n, timeBase: tb, frameRateMode: meta.frameRateMode, firstFrame: times[0]!, end, measuredFps: r3(fps) },
    technical: {
      codec: meta.codec,
      fieldOrder: meta.fieldOrder,
      bitsPerPixel: videoBits ? r3(videoBits / (meta.stored.w * meta.stored.h * fps)) : null,
      activePixelsDisplay: { w: mediaActive.activeRect.w, h: mediaActive.activeRect.h },
    },
    activePicture: mediaActive,
    static: {
      frozenFraction: r3(frozenFraction),
      identicalFraction: r3(s.n > 1 ? s.identical.filter(Boolean).length / (s.n - 1) : 0),
      uniqueFrames: unique,
      staticImageVideo,
      confidence: r3(staticImageVideo ? Math.min(1, 0.5 + frozenFraction / 2) : 1 - frozenFraction),
      freezeRegions: regions(frozen, times, end, cfg.freezeMinSeconds),
    },
    overlays: ov.overlays,
    overlayEvaluable: ov.evaluable,
    shots,
    suppressedBoundaries: suppressed.map((x) => ({ time: times[x.frame]!, frame: x.frame, reason: x.reason })),
    warnings,
  };
}

export function parseHash(h: string): [number, number] {
  return [parseInt(h.slice(8), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0];
}
