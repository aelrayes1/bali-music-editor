/**
 * Small, dependency-free DSP toolkit for music analysis.
 *
 * Everything is deterministic: fixed window sizes, fixed iteration order, typed arrays.
 * Floating point is used for signal features only; all *timing* leaves this module as
 * integer sample or frame indices, which callers convert to exact rationals.
 */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new RangeError("FFT size must be a power of two");
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
  }

  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function db(power: number, floor = 1e-12): number {
  return 10 * Math.log10(Math.max(power, floor));
}

/** Round for serialization so floats are stable and readable. */
export function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function mean(xs: ArrayLike<number>, from = 0, to = xs.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i]!;
  return to > from ? s / (to - from) : 0;
}

/** Deterministic percentile (nearest-rank on a sorted copy). */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(xs as ArrayLike<number>).sort();
  if (a.length === 0) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i]!;
}

export function median(xs: ArrayLike<number>): number {
  return percentile(xs, 50);
}

/** Centred moving median with an odd window; edges use the available samples. */
export function movingMedian(xs: Float64Array, window: number): Float64Array {
  const half = Math.floor(window / 2);
  const out = new Float64Array(xs.length);
  const buf: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(xs.length - 1, i + half); j++) buf.push(xs[j]!);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1]!;
  }
  return out;
}

/** Centred moving mean using a prefix sum. */
export function movingMean(xs: Float64Array, window: number): Float64Array {
  const half = Math.floor(window / 2);
  const prefix = new Float64Array(xs.length + 1);
  for (let i = 0; i < xs.length; i++) prefix[i + 1] = prefix[i]! + xs[i]!;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(xs.length, i + half + 1);
    out[i] = (prefix[b]! - prefix[a]!) / (b - a);
  }
  return out;
}

export interface Peak {
  index: number;
  value: number;
}

/**
 * Local maxima above an adaptive threshold: value >= every neighbour within `radius`,
 * and value > localMean * ratio + floor. Ties resolve to the earliest index.
 */
export function pickPeaks(xs: Float64Array, radius: number, localWindow: number, ratio: number, floor: number): Peak[] {
  const local = movingMean(xs, localWindow);
  const peaks: Peak[] = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (v <= local[i]! * ratio + floor) continue;
    let isMax = true;
    for (let j = Math.max(0, i - radius); j <= Math.min(xs.length - 1, i + radius); j++) {
      if (j === i) continue;
      const u = xs[j]!;
      if (u > v || (u === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push({ index: i, value: v });
  }
  return peaks;
}

/** RBJ biquad band-pass (constant 0 dB peak gain), applied forward only. */
export function bandPass(samples: Float32Array, sampleRate: number, lowHz: number, highHz: number): Float32Array {
  const f0 = Math.sqrt(lowHz * highHz);
  const bw = Math.log2(highHz / lowHz);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) * Math.sinh((Math.LN2 / 2) * bw * (w0 / Math.sin(w0)));
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/**
 * Sample-accurate attack time inside [from, to): the sample where short-time energy rises
 * fastest (64-sample RMS windows every 16 samples). Returns the first sample of the window
 * with the largest positive energy step.
 */
export function refineAttack(signal: Float32Array, from: number, to: number): number {
  const win = 64;
  const step = 16;
  const a = Math.max(0, from);
  const b = Math.min(signal.length - win, to);
  let best = a;
  let bestRise = Number.NEGATIVE_INFINITY;
  let prev = -1;
  for (let s = a; s <= b; s += step) {
    let e = 0;
    for (let k = 0; k < win; k++) {
      const v = signal[s + k]!;
      e += v * v;
    }
    if (prev >= 0) {
      const rise = e - prev;
      if (rise > bestRise) {
        bestRise = rise;
        best = s;
      }
    }
    prev = e;
  }
  return best;
}

/** Cosine similarity of two equal-length vectors (0 when either is silent). */
export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Weighted least squares fit y = a + b x. */
export function weightedLinearFit(xs: number[], ys: number[], ws: number[]): { a: number; b: number; rms: number } {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i]!;
    sw += w;
    sx += w * xs[i]!;
    sy += w * ys[i]!;
    sxx += w * xs[i]! * xs[i]!;
    sxy += w * xs[i]! * ys[i]!;
  }
  const den = sw * sxx - sx * sx;
  if (den === 0) throw new Error("degenerate linear fit");
  const b = (sw * sxy - sx * sy) / den;
  const a = (sy - b * sx) / sw;
  let err = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i]! - (a + b * xs[i]!);
    err += ws[i]! * r * r;
  }
  return { a, b, rms: Math.sqrt(err / sw) };
}
