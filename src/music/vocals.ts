/**
 * Vocal-band analysis without speech recognition.
 *
 * What this measures (honestly): tonal mid-band activity and the attacks of tonal mid-band
 * sounds, plus which attacks repeat the same short spectral pattern. In a mixed track this
 * cannot tell a sung word from a tonal synth stab, and it never identifies words. Anything it
 * produces is a *candidate*; word identity needs a human (or a future ASR stage).
 */

import { type Rational, compare, rational } from "../time/rational.ts";
import { bandPass, movingMean, percentile, pickPeaks, refineAttack } from "./dsp.ts";
import { type FrameFeatures, FRAMES_PER_SECOND, HOP, SAMPLE_RATE, VOCAL_BINS } from "./features.ts";

export interface VocalAttack {
  sample: number;
  frame: number;
  strength: number;
  /** Harmonic share of vocal-band energy around the attack (0..1). */
  harmonicity: number;
  /** Tonal mid-band level relative to the track's median tonal level (dB). */
  activityDb: number;
  clusterId: string | null;
  /** Similarity to the cluster medoid (pitch-tolerant cosine), when clustered. */
  clusterSimilarity: number | null;
}

export interface VocalRegion {
  startFrame: number;
  endFrame: number;
  meanActivityDb: number;
  confidence: number;
}

export interface VocalCluster {
  id: string;
  members: number[]; // attack samples
  meanSimilarity: number;
  windowId: string;
  medoidSample: number;
}

export interface VocalAnalysis {
  attacks: VocalAttack[];
  regions: VocalRegion[];
  clusters: VocalCluster[];
  activityDb: Float64Array;
}

export interface FocusWindow {
  id: string;
  start: Rational;
  end: Rational;
}

const H_TIME = 13; // frames (130 ms) for the harmonic median
/** Minimum formant-band level rise (dB) for a vocal attack candidate. */
export const MIN_RISE_DB = 3;
const P_FREQ = 13; // bins for the percussive median

function median13(buf: number[]): number {
  buf.sort((a, b) => a - b);
  return buf[buf.length >> 1]!;
}

/** Harmonic-masked vocal-band magnitudes (frames x VOCAL_BINS) via median-filter HPSS. */
export function harmonicSpectrogram(f: FrameFeatures): { h: Float32Array; ratio: Float64Array } {
  const n = f.frames;
  const B = VOCAL_BINS;
  const S = f.vocalSpec;
  const harm = new Float32Array(n * B);
  const perc = new Float32Array(n * B);
  const buf: number[] = [];
  const ht = H_TIME >> 1;
  for (let b = 0; b < B; b++) {
    for (let k = 0; k < n; k++) {
      buf.length = 0;
      for (let j = Math.max(0, k - ht); j <= Math.min(n - 1, k + ht); j++) buf.push(S[j * B + b]!);
      harm[k * B + b] = median13(buf);
    }
  }
  const pf = P_FREQ >> 1;
  for (let k = 0; k < n; k++) {
    for (let b = 0; b < B; b++) {
      buf.length = 0;
      for (let j = Math.max(0, b - pf); j <= Math.min(B - 1, b + pf); j++) buf.push(S[k * B + j]!);
      perc[k * B + b] = median13(buf);
    }
  }
  const h = new Float32Array(n * B);
  const ratio = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let eh = 0;
    let et = 0;
    for (let b = 0; b < B; b++) {
      const i = k * B + b;
      const hh = harm[i]! * harm[i]!;
      const pp = perc[i]! * perc[i]!;
      const mask = hh + pp > 0 ? hh / (hh + pp) : 0;
      const m = S[i]! * mask;
      h[i] = m;
      eh += m * m;
      et += S[i]! * S[i]!;
    }
    ratio[k] = et > 0 ? eh / et : 0;
  }
  return { h, ratio };
}

/** Formant band (Hz) where chopped vocals concentrate; attacks are measured here. */
export const FORMANT_LO_HZ = 450;
export const FORMANT_HI_HZ = 1800;

/**
 * Harmonic-masked but temporally UNsmoothed vocal-band magnitudes: S * min(1, H / S).
 * The median-filtered H blurs attacks; using it only as a mask keeps attack timing sharp
 * while down-weighting percussive energy (hats, claps).
 */
export function maskedSpectrogram(f: FrameFeatures, h: Float32Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const S = f.vocalSpec[i]!;
    out[i] = S > 0 ? S * Math.min(1, h[i]! / S) : 0;
  }
  return out;
}

export function patch(h: Float32Array, frame: number, frames: number): Float64Array {
  const DS = 4;
  const bins = Math.floor(VOCAL_BINS / DS);
  const v = new Float64Array(25 * bins);
  for (let t = 0; t < 25; t++) {
    const k = Math.min(frames - 1, Math.max(0, frame - 1 + t));
    for (let b = 0; b < bins; b++) {
      let s = 0;
      for (let d = 0; d < DS; d++) s += h[k * VOCAL_BINS + b * DS + d]!;
      v[t * bins + b] = Math.log1p(100 * s);
    }
  }
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! - m;
  return v;
}

/** Cosine similarity allowing a small frequency shift (pitch-tolerant). */
export function shiftedSimilarity(a: Float64Array, b: Float64Array, bins: number, maxShift = 3): number {
  let best = -1;
  const T = a.length / bins;
  for (let s = -maxShift; s <= maxShift; s++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let t = 0; t < T; t++) {
      for (let x = Math.max(0, -s); x < Math.min(bins, bins - s); x++) {
        const va = a[t * bins + x]!;
        const vb = b[t * bins + x + s]!;
        dot += va * vb;
        na += va * va;
        nb += vb * vb;
      }
    }
    if (na > 0 && nb > 0) best = Math.max(best, dot / Math.sqrt(na * nb));
  }
  return best;
}

export function analyzeVocals(
  samples: Float32Array,
  f: FrameFeatures,
  windows: FocusWindow[],
  clusterThreshold = 0.8,
): VocalAnalysis {
  const { h, ratio } = harmonicSpectrogram(f);
  const n = f.frames;

  // Tonal mid-band level and its excess over a 10 s running mean.
  const hDb = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let b = 0; b < VOCAL_BINS; b++) e += h[k * VOCAL_BINS + b]! ** 2;
    hDb[k] = 10 * Math.log10(Math.max(e, 1e-12));
  }
  // Relative to the track's median tonal level (a running mean would let a vocal-dense
  // passage raise its own baseline and hide its own attacks).
  const baseline = percentile(hDb, 50);
  const activityRaw = new Float64Array(n);
  for (let k = 0; k < n; k++) activityRaw[k] = hDb[k]! - baseline;
  const activityDb = movingMean(activityRaw, 15);
  const smooth = movingMean(activityRaw, 51);

  // Regions of sustained tonal mid-band activity.
  const regions: VocalRegion[] = [];
  let start = -1;
  for (let k = 0; k <= n; k++) {
    const on = k < n && smooth[k]! > 1.5;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      if (k - start >= 50) {
        let s = 0;
        for (let j = start; j < k; j++) s += smooth[j]!;
        const meanDb = s / (k - start);
        regions.push({ startFrame: start, endFrame: k, meanActivityDb: meanDb, confidence: Math.min(1, meanDb / 6) });
      }
      start = -1;
    }
  }

  // Attacks: level rises of the harmonic-masked formant band (next 30 ms vs previous 40 ms).
  const masked = maskedSpectrogram(f, h);
  const binLo = Math.max(0, Math.round((FORMANT_LO_HZ * 2048) / SAMPLE_RATE) - Math.round((150 * 2048) / SAMPLE_RATE));
  const binHi = Math.min(VOCAL_BINS, Math.round((FORMANT_HI_HZ * 2048) / SAMPLE_RATE) - Math.round((150 * 2048) / SAMPLE_RATE));
  const formantDb = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let b = binLo; b < binHi; b++) e += masked[k * VOCAL_BINS + b]! ** 2;
    formantDb[k] = 10 * Math.log10(e + 1e-12);
  }
  const rise = new Float64Array(n);
  for (let k = 4; k < n - 3; k++) {
    const after = (formantDb[k]! + formantDb[k + 1]! + formantDb[k + 2]!) / 3;
    const before = (formantDb[k - 1]! + formantDb[k - 2]! + formantDb[k - 3]! + formantDb[k - 4]!) / 4;
    rise[k] = Math.max(0, after - before);
  }
  const peaks = pickPeaks(rise, 8, 1, 0, MIN_RISE_DB); // local max within 80 ms, rise >= MIN_RISE_DB
  const formantSignal = bandPass(samples, SAMPLE_RATE, FORMANT_LO_HZ, FORMANT_HI_HZ);
  const attacks: VocalAttack[] = [];
  let last = -Infinity;
  for (const p of peaks) {
    const act = activityDb[p.index]!;
    if (act < -3) continue; // clearly below the track's typical tonal level
    const centre = p.index * HOP;
    const sample = refineAttack(formantSignal, centre - 2 * HOP, centre + 1024);
    if (sample - last < 0.06 * SAMPLE_RATE) continue;
    last = sample;
    let hr = 0;
    for (let j = p.index; j < Math.min(n, p.index + 10); j++) hr += ratio[j]!;
    attacks.push({
      sample,
      frame: p.index,
      strength: Math.round(Math.min(2, p.value / 10) * 1000) / 1000, // formant rise / 10 dB
      harmonicity: Math.round((hr / 10) * 1000) / 1000,
      activityDb: Math.round(act * 100) / 100,
      clusterId: null,
      clusterSimilarity: null,
    });
  }

  // Repetition clusters inside each focus window.
  const clusters: VocalCluster[] = [];
  const bins = Math.floor(VOCAL_BINS / 4);
  for (const w of windows) {
    const inWin = attacks.filter((a) => {
      const t = rational(a.sample, SAMPLE_RATE);
      return compare(t, w.start) >= 0 && compare(t, w.end) < 0;
    });
    const patches = inWin.map((a) => patch(masked, a.frame, n));
    // Medoid clustering (no chaining): seeds in order of strength; every member must match
    // the cluster's medoid at >= threshold.
    const sim = (i: number, j: number) => {
      if (i === j) return 1;
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let v = sims.get(key);
      if (v === undefined) {
        v = shiftedSimilarity(patches[i]!, patches[j]!, bins);
        sims.set(key, v);
      }
      return v;
    };
    const sims = new Map<string, number>();
    const order = inWin.map((_, i) => i).sort((a, b) => inWin[b]!.strength - inWin[a]!.strength || inWin[a]!.sample - inWin[b]!.sample);
    const assigned = new Set<number>();
    for (const seed of order) {
      if (assigned.has(seed)) continue;
      let members = order.filter((j) => !assigned.has(j) && sim(seed, j) >= clusterThreshold);
      if (members.length < 3) continue;
      // Re-centre on the medoid, then re-collect members around it.
      const medoid = members.reduce((best, m) =>
        members.reduce((s, x) => s + sim(m, x), 0) > members.reduce((s, x) => s + sim(best, x), 0) ? m : best,
      );
      members = order.filter((j) => !assigned.has(j) && sim(medoid, j) >= clusterThreshold).sort((a, b) => inWin[a]!.sample - inWin[b]!.sample);
      if (members.length < 3) continue;
      for (const m of members) assigned.add(m);
      let s = 0;
      let c = 0;
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
          s += sim(members[x]!, members[y]!);
          c++;
        }
      }
      const id = `vcluster:${inWin[medoid]!.sample}`;
      for (const m of members) {
        inWin[m]!.clusterId = id;
        inWin[m]!.clusterSimilarity = Math.round(sim(medoid, m) * 1000) / 1000;
      }
      clusters.push({
        id,
        members: members.map((m) => inWin[m]!.sample),
        meanSimilarity: Math.round((s / c) * 1000) / 1000,
        windowId: w.id,
        medoidSample: inWin[medoid]!.sample,
      });
    }
  }
  clusters.sort((a, b) => b.members.length - a.members.length || a.members[0]! - b.members[0]!);
  return { attacks, regions, clusters, activityDb };
}

export const FRAME_SECONDS = rational(1, FRAMES_PER_SECOND);
