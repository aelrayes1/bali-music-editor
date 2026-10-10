/**
 * Per-frame objective measurements on small full-range 8-bit luma frames (display orientation,
 * square pixels, longest side = analysis size). Pure: no I/O, deterministic.
 *
 * FrameSeries accumulates compact per-frame values (a few numbers, a 32-bin histogram, row/column
 * maxima, a 64-bit difference hash and a 40x22 thumbnail) so shot segmentation and shot/media
 * aggregation can run afterwards without keeping frames. Media-level overlay statistics are
 * accumulated at 160-wide resolution.
 */

export const HIST_BINS = 32;
export const THUMB_W = 40;
export const OVERLAY_W = 160;
/**
 * A row/column is "black border" if it is dark (mean <= BORDER_MEAN, max <= BORDER_MAX) AND flat
 * (mean absolute deviation <= BORDER_FLAT): digital bars are flat, dark picture areas carry grain/noise.
 */
export const BORDER_MEAN = 20;
export const BORDER_MAX = 48;
export const BORDER_FLAT = 5;
export const CLIP_HIGH = 250;
export const CLIP_LOW = 5;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Active picture of one frame. Columns (then rows within the picture columns, then columns again
 * within those rows) are classified as border (dark AND flat) or picture; the picture is the widest
 * run of picture columns/rows, merging gaps of up to 2 % (dark flat areas inside the picture). Thin
 * bright lines or graphics inside black bars are therefore border decoration, not picture.
 */
export function frameBorders(px: Uint8Array, w: number, h: number): Rect {
  const isBorder = (get: (i: number) => number, n: number) => {
    let s = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const v = get(i);
      s += v;
      if (v > m) m = v;
    }
    const mean = s / Math.max(1, n);
    if (mean > BORDER_MEAN || m > BORDER_MAX) return false;
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(get(i) - mean);
    return dev / Math.max(1, n) <= BORDER_FLAT;
  };
  const span = (flags: boolean[], total: number): [number, number] | null => {
    const gap = Math.max(2, Math.round(0.02 * total));
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < flags.length; ) {
      if (flags[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < flags.length && !flags[j]) j++;
      const last = runs.at(-1);
      if (last && i - last[1] <= gap) last[1] = j;
      else runs.push([i, j]);
      i = j;
    }
    if (!runs.length) return null;
    return runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  };
  const cols = (y0: number, y1: number) => Array.from({ length: w }, (_, x) => isBorder((i) => px[(y0 + i) * w + x]!, y1 - y0));
  const rows = (x0: number, x1: number) => Array.from({ length: h }, (_, y) => isBorder((i) => px[y * w + x0 + i]!, x1 - x0));
  let c = span(cols(0, h), w);
  if (!c) return { x: 0, y: 0, w: 0, h: 0 };
  const r = span(rows(c[0], c[1]), h);
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  c = span(cols(r[0], r[1]), w) ?? c;
  return { x: c[0], y: r[0], w: c[1] - c[0], h: r[1] - r[0] };
}

export interface FrameStats {
  mean: number;
  p05: number;
  p50: number;
  p95: number;
  clipHigh: number;
  crushLow: number;
  sharpness: number;
  hist: Float32Array;
  /** histogram of (luma - frame mean): insensitive to global brightness changes (flashes, fades). */
  histCentered: Float32Array;
}

/** Exposure, clipping, sharpness (variance of the 4-neighbour Laplacian) inside `r`. */
export function frameStats(px: Uint8Array, w: number, r: Rect): FrameStats {
  const counts = new Uint32Array(256);
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x, o = y * w + r.x; x < r.x + r.w; x++, o++) counts[px[o]!]!++;
  }
  n = r.w * r.h;
  const hist = new Float32Array(HIST_BINS);
  const histCentered = new Float32Array(HIST_BINS);
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * counts[v]!;
  const mean = n ? sum / n : 0;
  const pct = (q: number) => {
    const target = q * n;
    let c = 0;
    for (let v = 0; v < 256; v++) {
      c += counts[v]!;
      if (c >= target) return v;
    }
    return 255;
  };
  let hi = 0;
  let lo = 0;
  for (let v = 0; v < 256; v++) {
    hist[v >> 3]! += counts[v]! / Math.max(1, n);
    const c = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((v - mean + 128) / 8)));
    histCentered[c]! += counts[v]! / Math.max(1, n);
    if (v >= CLIP_HIGH) hi += counts[v]!;
    if (v <= CLIP_LOW) lo += counts[v]!;
  }
  // Laplacian variance (skip the 1-px rim of the rect).
  let ls = 0;
  let ls2 = 0;
  let ln = 0;
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    for (let x = r.x + 1, o = y * w + r.x + 1; x < r.x + r.w - 1; x++, o++) {
      const l = 4 * px[o]! - px[o - 1]! - px[o + 1]! - px[o - w]! - px[o + w]!;
      ls += l;
      ls2 += l * l;
      ln++;
    }
  }
  const lm = ln ? ls / ln : 0;
  return {
    mean,
    p05: pct(0.05),
    p50: pct(0.5),
    p95: pct(0.95),
    clipHigh: n ? hi / n : 0,
    crushLow: n ? lo / n : 0,
    sharpness: ln ? ls2 / ln - lm * lm : 0,
    hist,
    histCentered,
  };
}

export function histL1(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d;
}

/** Box-downsample the whole frame to tw x th (area average). */
export function downsample(px: Uint8Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, o = y * w + x0; x < x1; x++, o++) s += px[o]!;
      out[ty * tw + tx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** 64-bit difference hash (9x8 area-averaged luma, horizontal gradients) as two uint32. */
export function dHash(px: Uint8Array, w: number, _h: number, r: Rect): [number, number] {
  const sub = new Uint8Array(Math.max(1, r.w) * Math.max(1, r.h));
  for (let y = 0; y < r.h; y++) sub.set(px.subarray((r.y + y) * w + r.x, (r.y + y) * w + r.x + r.w), y * r.w);
  const d = downsample(sub, Math.max(1, r.w), Math.max(1, r.h), 9, 8);
  let a = 0;
  let b = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = d[y * 9 + x]! < d[y * 9 + x + 1]! ? 1 : 0;
      const i = y * 8 + x;
      if (i < 32) a = (a | (bit << i)) >>> 0;
      else b = (b | (bit << (i - 32))) >>> 0;
    }
  }
  return [a, b];
}

export function hamming(x: [number, number], y: [number, number]): number {
  let c = 0;
  for (let v of [x[0] ^ y[0], x[1] ^ y[1]]) {
    v >>>= 0;
    while (v) {
      c += v & 1;
      v >>>= 1;
    }
  }
  return c;
}

function sad(a: Float32Array, b: Float32Array, w: number, h: number, dx: number, dy: number, margin: number): number {
  let s = 0;
  let n = 0;
  for (let y = margin; y < h - margin; y++) {
    const yb = y + dy;
    if (yb < 0 || yb >= h) continue;
    for (let x = margin; x < w - margin; x++) {
      const xb = x + dx;
      if (xb < 0 || xb >= w) continue;
      s += Math.abs(a[y * w + x]! - b[yb * w + xb]!);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

export interface MotionEstimate {
  /** Global translation from the previous frame to this one, in analysis pixels (content moves by +dx). */
  dx: number;
  dy: number;
  /** Mean abs luma difference after compensating the translation (local motion / change). */
  residual: number;
  /** Mean abs luma difference without compensation (plain frame change). */
  rawDiff: number;
}

/**
 * Global translation by coarse-to-fine block matching: exhaustive ±R at quarter resolution,
 * refined ±1 at half resolution. Frames are the half-resolution previews (prev, cur).
 */
export const MOTION_PENALTY = 0.08; // SAD units per half-resolution pixel away from zero / the hint

export function estimateMotion(
  prevHalf: Float32Array,
  curHalf: Float32Array,
  w: number,
  h: number,
  radius = 6,
  hint: { dx: number; dy: number } | null = null,
): MotionEstimate {
  const qw = w >> 1;
  const qh = h >> 1;
  const quarter = (f: Float32Array) => {
    const q = new Float32Array(qw * qh);
    for (let y = 0; y < qh; y++) for (let x = 0; x < qw; x++) {
      const o = 2 * y * w + 2 * x;
      q[y * qw + x] = (f[o]! + f[o + 1]! + f[o + w]! + f[o + w + 1]!) / 4;
    }
    return q;
  };
  const pq = quarter(prevHalf);
  const cq = quarter(curHalf);
  const m = Math.min(radius, Math.floor(Math.min(qw, qh) / 4));
  // Coarse: keep the three best shifts (plus zero) to avoid false minima on repetitive texture.
  const coarse: Array<{ dx: number; dy: number; e: number }> = [];
  for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) coarse.push({ dx, dy, e: sad(cq, pq, qw, qh, -dx, -dy, m) });
  coarse.sort((a, b) => a.e - b.e || Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)) || a.dy - b.dy || a.dx - b.dx);
  // hint = previous frame's motion (analysis px) as a temporal prior, converted to half-res px
  const hx = hint ? hint.dx / 2 : 0;
  const hy = hint ? hint.dy / 2 : 0;
  const seeds = [...coarse.slice(0, 3), { dx: 0, dy: 0, e: 0 }, { dx: Math.round(hx / 2), dy: Math.round(hy / 2), e: 0 }];
  const mh = 2 * m;
  const cost = (e: number, dx: number, dy: number) => e + MOTION_PENALTY * Math.min(Math.abs(dx) + Math.abs(dy), Math.abs(dx - hx) + Math.abs(dy - hy));
  let fine = { dx: 0, dy: 0, e: Infinity, c: Infinity };
  const tried = new Set<string>();
  for (const c of seeds) {
    for (let dy = 2 * c.dy - 1; dy <= 2 * c.dy + 1; dy++) {
      for (let dx = 2 * c.dx - 1; dx <= 2 * c.dx + 1; dx++) {
        const k = `${dx},${dy}`;
        if (tried.has(k)) continue;
        tried.add(k);
        const e = sad(curHalf, prevHalf, w, h, -dx, -dy, mh);
        const c = cost(e, dx, dy);
        if (c < fine.c - 1e-9 || (Math.abs(c - fine.c) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(fine.dx) + Math.abs(fine.dy))) fine = { dx, dy, e, c };
      }
    }
  }
  // Sub-pixel refinement: parabola through the SAD at best-1, best, best+1 (per axis).
  const sub = (em: number, e0: number, ep: number) => {
    const den = em - 2 * e0 + ep;
    return den > 1e-9 ? Math.max(-0.5, Math.min(0.5, (em - ep) / (2 * den))) : 0;
  };
  const e = (dx: number, dy: number) => sad(curHalf, prevHalf, w, h, -dx, -dy, mh);
  const fx = fine.dx + sub(e(fine.dx - 1, fine.dy), fine.e, e(fine.dx + 1, fine.dy));
  const fy = fine.dy + sub(e(fine.dx, fine.dy - 1), fine.e, e(fine.dx, fine.dy + 1));
  const round = (v: number) => Math.round(v * 2000) / 1000; // half-res -> analysis px, 0.001 px steps
  return { dx: round(fx), dy: round(fy), residual: fine.e, rawDiff: sad(curHalf, prevHalf, w, h, 0, 0, 0) };
}

/** Sobel gradient magnitude of a small frame. */
export function edgeMagnitude(f: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      const gx = f[o - w + 1]! + 2 * f[o + 1]! + f[o + w + 1]! - f[o - w - 1]! - 2 * f[o - 1]! - f[o + w - 1]!;
      const gy = f[o + w - 1]! + 2 * f[o + w]! + f[o + w + 1]! - f[o - w - 1]! - 2 * f[o - w]! - f[o - w + 1]!;
      out[o] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** The most common rect (within ±tol px) among `rects`, its coverage, and the median rect of that cluster. */
export function dominantRect(rects: Rect[], tol = 2): { rect: Rect; coverage: number } | null {
  const valid = rects.filter((r) => r.w > 0 && r.h > 0);
  if (!valid.length) return null;
  const key = (r: Rect) => `${Math.round(r.x / (tol + 1))},${Math.round(r.y / (tol + 1))},${Math.round((r.x + r.w) / (tol + 1))},${Math.round((r.y + r.h) / (tol + 1))}`;
  const counts = new Map<string, number>();
  for (const r of valid) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  const seed = valid.reduce((best, r) => ((counts.get(key(r)) ?? 0) > (counts.get(key(best)) ?? 0) ? r : best));
  const near = (a: Rect, b: Rect) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.x + a.w - b.x - b.w) <= tol && Math.abs(a.y + a.h - b.y - b.h) <= tol;
  const cluster = valid.filter((r) => near(r, seed));
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const x0 = med(cluster.map((r) => r.x));
  const y0 = med(cluster.map((r) => r.y));
  const x1 = med(cluster.map((r) => r.x + r.w));
  const y1 = med(cluster.map((r) => r.y + r.h));
  return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, coverage: cluster.length / valid.length };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}
