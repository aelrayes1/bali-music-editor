/**
 * Phase 6B mask math (pure, dependency-free, deterministic). Masks are low-resolution soft mattes
 * (w x h bytes, 0-255) aligned with a conformed clip's frames at 1/`downscale` of its size. The
 * subject-isolated stutter never uses a mask edge as a visible cut line: masks only decide WHICH
 * pixels come from the stuttered frame, and the region around them is dilated and feathered so the
 * seam lies in the background. Mask precision therefore matters less than temporal stability.
 */

export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

export const emptyMask = (w: number, h: number): Mask => ({ w, h, data: new Uint8Array(w * h) });
export const cloneMask = (m: Mask): Mask => ({ w: m.w, h: m.h, data: new Uint8Array(m.data) });

export function binarize(m: Mask, t = 128): Mask {
  const d = new Uint8Array(m.data.length);
  for (let i = 0; i < d.length; i++) d[i] = m.data[i]! >= t ? 255 : 0;
  return { w: m.w, h: m.h, data: d };
}

export function union(...ms: Mask[]): Mask {
  const o = cloneMask(ms[0]!);
  for (const m of ms.slice(1)) for (let i = 0; i < o.data.length; i++) if (m.data[i]! > o.data[i]!) o.data[i] = m.data[i]!;
  return o;
}

export function multiply(a: Mask, b: Mask): Mask {
  const d = new Uint8Array(a.data.length);
  for (let i = 0; i < d.length; i++) d[i] = Math.round((a.data[i]! * b.data[i]!) / 255);
  return { w: a.w, h: a.h, data: d };
}

export function area(m: Mask, t = 128): number {
  let n = 0;
  for (const v of m.data) if (v >= t) n++;
  return n;
}

export function bbox(m: Mask, t = 128): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.data[y * m.w + x]! >= t) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function centroid(m: Mask, t = 128): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.data[y * m.w + x]! >= t) {
        sx += x;
        sy += y;
        n++;
      }
  return n ? { x: sx / n, y: sy / n } : null;
}

export function iou(a: Mask, b: Mask, t = 128): number {
  let i = 0, u = 0;
  for (let k = 0; k < a.data.length; k++) {
    const p = a.data[k]! >= t, q = b.data[k]! >= t;
    if (p && q) i++;
    if (p || q) u++;
  }
  return u ? i / u : 0;
}

/** Fraction of `a` (binary) covered by `b` (binary). */
export function coverage(a: Mask, b: Mask, t = 128): number {
  let n = 0, s = 0;
  for (let k = 0; k < a.data.length; k++)
    if (a.data[k]! >= t) {
      n++;
      if (b.data[k]! >= t) s++;
    }
  return n ? s / n : 0;
}

/**
 * Euclidean-ish distance to the nearest set pixel (two-pass 3-4 chamfer, units of 1/3 px), used for
 * round (not square) dilation/erosion so the dilated region has no corners.
 */
function chamfer(m: Mask, t: number, inside: boolean): Int32Array {
  const { w, h } = m;
  const INF = 1 << 28;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = (m.data[i]! >= t) === inside ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w]! + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1]! + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1]! + 4);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w]! + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1]! + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1]! + 4);
      }
      d[i] = v;
    }
  return d;
}

/** Binary round dilation by radius r (px). */
export function dilate(m: Mask, r: number, t = 128): Mask {
  if (r <= 0) return binarize(m, t);
  const d = chamfer(m, t, true);
  const lim = r * 3;
  const o = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) o[i] = d[i]! <= lim ? 255 : 0;
  return { w: m.w, h: m.h, data: o };
}

/** Binary round erosion by radius r (px). */
export function erode(m: Mask, r: number, t = 128): Mask {
  if (r <= 0) return binarize(m, t);
  const d = chamfer(m, t, false);
  const lim = r * 3;
  const o = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) o[i] = d[i]! > lim ? 255 : 0;
  return { w: m.w, h: m.h, data: o };
}

/** Morphological closing (bridges thin gaps between limbs and body, removes pinholes). */
export const close = (m: Mask, r: number, t = 128): Mask => erode(dilate(m, r, t), r);

/** Fill background regions not connected to the image border (holes in the subject). */
export function fillHoles(m: Mask, t = 128): { mask: Mask; filled: number } {
  const { w, h } = m;
  const bin = binarize(m, t).data;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!seen[i] && !bin[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = new Uint8Array(m.data);
  let filled = 0;
  for (let i = 0; i < out.length; i++)
    if (!bin[i] && !seen[i]) {
      out[i] = 255;
      filled++;
    }
  return { mask: { w, h, data: out }, filled };
}

/** 4-connected components of a binary mask: label image (0 = background) and component sizes. */
export function components(m: Mask, t = 128): { labels: Int32Array; sizes: number[] } {
  const { w, h } = m;
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (labels[s] || m.data[s]! < t) continue;
    const id = sizes.length;
    let n = 0;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1])
        if (j >= 0 && !labels[j] && m.data[j]! >= t) {
          labels[j] = id;
          stack.push(j);
        }
    }
    sizes.push(n);
  }
  return { labels, sizes };
}

/** Separable box blur (radius r, repeated `passes` times ~ gaussian) of a soft mask: the feather. */
export function blur(m: Mask, r: number, passes = 2): Mask {
  if (r <= 0) return cloneMask(m);
  const { w, h } = m;
  let a = Float32Array.from(m.data);
  let b = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, k))]!;
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / n;
        s += a[y * w + Math.min(w - 1, x + r + 1)]! - a[y * w + Math.max(0, x - r)]!;
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[Math.min(h - 1, Math.max(0, k)) * w + x]!;
      for (let y = 0; y < h; y++) {
        b[y * w + x] = s / n;
        s += a[Math.min(h - 1, y + r + 1) * w + x]! - a[Math.max(0, y - r) * w + x]!;
      }
    }
    [a, b] = [b, a];
  }
  const o = new Uint8Array(a.length);
  for (let i = 0; i < o.length; i++) o[i] = Math.round(Math.min(255, Math.max(0, a[i]!)));
  return { w, h, data: o };
}

/** Shift a mask by an integer offset (pixels leaving the frame are dropped, new ones are 0). */
export function shift(m: Mask, dx: number, dy: number): Mask {
  const o = new Uint8Array(m.data.length);
  for (let y = 0; y < m.h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= m.h) continue;
    for (let x = 0; x < m.w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < m.w) o[y * m.w + x] = m.data[sy * m.w + sx]!;
    }
  }
  return { w: m.w, h: m.h, data: o };
}

/**
 * Bounded temporal smoothing: each frame's soft matte becomes the per-pixel MEDIAN of its neighbours
 * within +-radius (radius capped at 3; the window is clamped at the ends of the range). A median
 * removes one- and two-frame dropouts (a leg that Vision loses for a frame) and one-frame spurious
 * blobs without averaging them into a grey ghost, and it cannot drag the matte behind real motion by
 * more than `radius` frames.
 */
export function temporalSmooth(ms: Mask[], radius: number): Mask[] {
  const r = Math.max(0, Math.min(3, Math.floor(radius)));
  if (r === 0) return ms.map(cloneMask);
  const buf = new Uint8Array(2 * r + 1);
  return ms.map((m, i) => {
    const lo = Math.max(0, i - r);
    const hi = Math.min(ms.length - 1, i + r);
    const n = hi - lo + 1;
    const o = new Uint8Array(m.data.length);
    for (let p = 0; p < o.length; p++) {
      for (let k = 0; k < n; k++) buf[k] = ms[lo + k]!.data[p]!;
      const s = buf.subarray(0, n).sort();
      o[p] = n % 2 ? s[(n - 1) / 2]! : Math.round((s[n / 2 - 1]! + s[n / 2]!) / 2);
    }
    return { w: m.w, h: m.h, data: o };
  });
}

/** Boundary pixels of a binary mask (set pixels with an unset 4-neighbour). */
export function perimeter(m: Mask, t = 128): number {
  let n = 0;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (m.data[i]! < t) continue;
      if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1 || m.data[i - 1]! < t || m.data[i + 1]! < t || m.data[i - m.w]! < t || m.data[i + m.w]! < t) n++;
    }
  return n;
}

/** Bilinear sample of a mask at fractional mask coordinates (0-255). */
export function sample(m: Mask, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(m.w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(m.h - 1, Math.floor(y)));
  const x1 = Math.min(m.w - 1, x0 + 1);
  const y1 = Math.min(m.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const a = m.data[y0 * m.w + x0]!, b = m.data[y0 * m.w + x1]!, c = m.data[y1 * m.w + x0]!, d = m.data[y1 * m.w + x1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
