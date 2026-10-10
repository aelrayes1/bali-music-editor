/**
 * Onsets, tempo and the beat grid.
 *
 * Drift-free by construction: the grid is defined by an exact rational anchor and an exact
 * rational period, and every beat time is computed as anchor + i * period (never by
 * accumulation). The period is estimated by weighted least squares over matched onsets of
 * the whole track, then snapped to a simple rational BPM only when that fits equally well.
 */

import { type Rational, add, ceil, div, floor, mul, rational, sub } from "../time/rational.ts";
import { type Peak, percentile, pickPeaks, refineAttack, weightedLinearFit } from "./dsp.ts";
import { type FrameFeatures, FRAMES_PER_SECOND, HOP, SAMPLE_RATE } from "./features.ts";

export interface Onset {
  sample: number;
  frame: number;
  /** Normalised strength (1 = 99th percentile of the novelty curve). */
  strength: number;
  lowStrength: number;
}

export interface TempoCandidate {
  bpm: number;
  score: number;
  /** F1 of grid support and onset coverage. */
  contrast: number;
  relation: "selected" | "half" | "double" | "other";
}

export interface BeatGrid {
  /** Exact seconds of beat 0 (first grid beat at or after t = 0). */
  anchor: Rational;
  /** Exact seconds per beat. */
  period: Rational;
  canonicalBpm: Rational;
  measuredBpm: Rational;
  snapped: boolean;
  snapRule: string;
  beatCount: number;
  confidence: number;
  support: number;
  residualRmsMs: number;
  constantTempo: { isConstant: boolean; halfDifferencePercent: number; driftMsPerMinute: number };
  candidates: TempoCandidate[];
}

export interface TempoConfig {
  minBpm: number;
  maxBpm: number;
  priorBpm: number;
}

// ---------------------------------------------------------------------------
// Novelty and onsets
// ---------------------------------------------------------------------------

function normalise(xs: Float64Array): Float64Array {
  const p = percentile(xs, 99) || 1;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[i]! / p;
  return out;
}

/** Beat-oriented novelty: kick-band flux weighted above full-band flux. */
export function beatNovelty(f: FrameFeatures): Float64Array {
  const lo = normalise(f.fluxLow);
  const all = normalise(f.flux);
  const out = new Float64Array(f.frames);
  for (let i = 0; i < f.frames; i++) out[i] = lo[i]! + 0.5 * all[i]!;
  return out;
}

export function detectOnsets(samples: Float32Array, f: FrameFeatures): Onset[] {
  const all = normalise(f.flux);
  const lo = normalise(f.fluxLow);
  const peaks: Peak[] = pickPeaks(all, 3, 101, 1.4, 0.06);
  const onsets: Onset[] = [];
  let lastSample = -Infinity;
  for (const p of peaks) {
    const centre = p.index * HOP;
    // Flux at frame k = energy newly entering the leading part of frame k's window, so the
    // attack lies between one hop before the centre and the window's leading edge.
    const sample = refineAttack(samples, centre - HOP, centre + 1024);
    if (sample - lastSample < 441) continue; // at most one onset per 10 ms
    lastSample = sample;
    onsets.push({ sample, frame: p.index, strength: p.value, lowStrength: lo[p.index]! });
  }
  return onsets;
}

// ---------------------------------------------------------------------------
// Tempo candidates (autocorrelation) and grid evaluation (onset F1)
// ---------------------------------------------------------------------------

/** Candidate BPMs: strongest autocorrelation lags plus metrical relatives. */
export function candidateBpms(nov: Float64Array, cfg: TempoConfig): number[] {
  const minLag = Math.floor((FRAMES_PER_SECOND * 60) / cfg.maxBpm);
  const maxLag = Math.ceil((FRAMES_PER_SECOND * 60) / cfg.minBpm);
  let m = 0;
  for (let i = 0; i < nov.length; i++) m += nov[i]!;
  m /= nov.length;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < nov.length; i++) s += (nov[i]! - m) * (nov[i + lag]! - m);
    ac[lag] = s;
  }
  const raw: Array<{ lag: number; value: number }> = [];
  for (let lag = Math.max(2, minLag); lag <= maxLag; lag++) {
    if (ac[lag]! > ac[lag - 1]! && ac[lag]! >= ac[lag + 1]!) {
      const a = ac[lag - 1]!;
      const b = ac[lag]!;
      const c = ac[lag + 1]!;
      const den = a - 2 * b + c;
      const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      raw.push({ lag: lag + shift, value: b });
    }
  }
  raw.sort((x, y) => y.value - x.value || x.lag - y.lag);
  const out: number[] = [];
  for (const r of raw.slice(0, 4)) {
    const bpm = (60 * FRAMES_PER_SECOND) / r.lag;
    for (const k of [1, 2, 0.5, 2 / 3, 3 / 2, 4 / 3, 3 / 4]) {
      const b = bpm * k;
      if (b < cfg.minBpm || b > cfg.maxBpm) continue;
      if (out.some((x) => Math.abs(x / b - 1) < 0.005)) continue;
      out.push(Math.round(b * 1000) / 1000);
    }
  }
  return out.sort((a, b) => a - b);
}

interface Match {
  index: number;
  sample: number;
  weight: number;
  onset: number;
}

const kickWeight = (o: Onset): number => o.lowStrength + 0.25 * o.strength;

function matchOnsets(
  onsets: Onset[],
  anchorS: number,
  periodS: number,
  tolS: number,
  maxSample: number,
  maxAbsIndex = Number.POSITIVE_INFINITY,
): Match[] {
  const matches: Match[] = [];
  let j = 0;
  const first = Math.max(Math.ceil((0 - anchorS) / periodS), -maxAbsIndex);
  for (let i = first; anchorS + i * periodS <= maxSample && i <= maxAbsIndex; i++) {
    const t = anchorS + i * periodS;
    while (j < onsets.length && onsets[j]!.sample < t - tolS) j++;
    let best = -1;
    for (let k = j; k < onsets.length && onsets[k]!.sample <= t + tolS; k++) {
      if (best < 0 || kickWeight(onsets[k]!) > kickWeight(onsets[best]!)) best = k;
    }
    if (best >= 0) matches.push({ index: i, sample: onsets[best]!.sample, weight: kickWeight(onsets[best]!), onset: best });
  }
  return matches;
}

interface GridEval {
  bpm: number;
  anchorS: number;
  periodS: number;
  matches: Match[];
  support: number;
  coverage: number;
  f1: number;
  prior: number;
  score: number;
}

/** Fit a grid of roughly `bpm` to the onsets and score it (F1 of support x coverage). */
function evaluateGrid(bpm: number, onsets: Onset[], totalSamples: number, cfg: TempoConfig): GridEval {
  let periodS = (60 * SAMPLE_RATE) / bpm;
  const tol0 = Math.min(0.03 * SAMPLE_RATE, periodS * 0.2);
  // Phase: try the strongest onsets as anchors (deterministic order), keep the best-supported.
  const strong = [...onsets].sort((a, b) => kickWeight(b) - kickWeight(a) || a.sample - b.sample).slice(0, 48);
  let anchorS = strong[0]?.sample ?? 0;
  let bestW = -1;
  for (const o of strong) {
    const w = matchOnsets(onsets, o.sample, periodS, tol0, totalSamples).reduce((s, m) => s + m.weight, 0);
    if (w > bestW) {
      bestW = w;
      anchorS = o.sample;
    }
  }
  // Progressive refinement: widen the window only after the period is accurate enough that
  // accumulated error stays inside the tolerance (index 0 = the anchor onset).
  let matches: Match[] = [];
  const passes: Array<[number, number]> = [[8, 40], [32, 30], [128, 25], [512, 20], [Infinity, 20], [Infinity, 15]];
  for (const [window, tolMs] of passes) {
    const tol = Math.min((tolMs / 1000) * SAMPLE_RATE, periodS * 0.2);
    const m = matchOnsets(onsets, anchorS, periodS, tol, totalSamples, window);
    if (m.length < 4) continue;
    matches = m;
    const fit = weightedLinearFit(matches.map((x) => x.index), matches.map((x) => x.sample), matches.map((x) => x.weight));
    anchorS = fit.a;
    periodS = fit.b;
  }
  matches = matchOnsets(onsets, anchorS, periodS, Math.min(0.02 * SAMPLE_RATE, periodS * 0.2), totalSamples);
  const firstOn = onsets[0]?.sample ?? 0;
  const lastOn = onsets[onsets.length - 1]?.sample ?? 0;
  const expected = Math.max(1, Math.floor((lastOn - firstOn) / periodS) + 1);
  const support = Math.min(1, matches.length / expected);
  const coverage = onsets.length ? new Set(matches.map((m) => m.onset)).size / onsets.length : 0;
  const f1 = support + coverage > 0 ? (2 * support * coverage) / (support + coverage) : 0;
  const prior = Math.exp(-0.5 * (Math.log2((60 * SAMPLE_RATE) / periodS / cfg.priorBpm) / 0.5) ** 2);
  return { bpm: (60 * SAMPLE_RATE) / periodS, anchorS, periodS, matches, support, coverage, f1, prior, score: f1 * (0.85 + 0.15 * prior) };
}

/** Kick-like onsets for beat tracking (falls back to all onsets when there is no kick). */
export function beatOnsets(onsets: Onset[]): Onset[] {
  const kicks = onsets.filter((o) => o.lowStrength >= 0.35);
  return kicks.length >= 16 ? kicks : onsets;
}

const SNAP_STEPS = [1, 2, 4]; // integer, half and quarter BPM

/** Exact rational BPM from a period measured in samples (1/1000-sample resolution). */
function bpmFromPeriodSamples(periodSamples: number): Rational {
  return div(rational(60 * SAMPLE_RATE * 1000), rational(Math.round(periodSamples * 1000)));
}

export function fitBeatGrid(nov: Float64Array, allOnsets: Onset[], totalSamples: number, cfg: TempoConfig): BeatGrid {
  const onsets = beatOnsets(allOnsets);
  const evals = candidateBpms(nov, cfg).map((bpm) => evaluateGrid(bpm, onsets, totalSamples, cfg));
  evals.sort((a, b) => b.score - a.score || a.bpm - b.bpm);
  const best = evals[0];
  if (!best || best.matches.length < 4) throw new Error("no usable beat grid (too few onsets)");
  const candidates: TempoCandidate[] = evals.map((e, i) => {
    const r = e.bpm / best.bpm;
    const relation = i === 0 ? "selected" : Math.abs(r - 0.5) < 0.02 ? "half" : Math.abs(r - 2) < 0.04 ? "double" : "other";
    return { bpm: Math.round(e.bpm * 1000) / 1000, score: e.score, contrast: e.f1, relation };
  });
  let { anchorS, periodS } = best;
  const matches = best.matches;
  const measuredPeriodS = periodS;

  // Constant-tempo check: fit each half separately.
  let halfDiff = 0;
  let driftMsPerMinute = 0;
  if (matches.length >= 16) {
    const h = matches.length >> 1;
    const fitOf = (ms: Match[]) => weightedLinearFit(ms.map((m) => m.index), ms.map((m) => m.sample), ms.map((m) => m.weight));
    halfDiff = (Math.abs(fitOf(matches.slice(0, h)).b - fitOf(matches.slice(h)).b) / periodS) * 100;
    const res = matches.map((m) => ({ t: m.sample / SAMPLE_RATE, r: (m.sample - (anchorS + m.index * periodS)) / SAMPLE_RATE }));
    driftMsPerMinute = weightedLinearFit(res.map((x) => x.t), res.map((x) => x.r), res.map(() => 1)).b * 60_000;
  }

  const rmsFixed = (pS: number): { anchor: number; rms: number } => {
    let sw = 0;
    let s = 0;
    for (const m of matches) {
      sw += m.weight;
      s += m.weight * (m.sample - m.index * pS);
    }
    const anchor = s / sw;
    let e = 0;
    for (const m of matches) e += m.weight * (m.sample - (anchor + m.index * pS)) ** 2;
    return { anchor, rms: Math.sqrt(e / sw) };
  };

  // Snap to a simple rational BPM only when it fits (almost) as well as the free fit.
  const measuredBpmFloat = (60 * SAMPLE_RATE) / periodS;
  const baseRms = rmsFixed(periodS).rms;
  let period: Rational = rational(Math.round(periodS * 1000), 1000 * SAMPLE_RATE);
  let canonicalBpm: Rational = div(rational(60), period);
  let snapped = false;
  let snapRule = "measured (1/1000-sample period resolution)";
  for (const step of SNAP_STEPS) {
    const snapBpm = Math.round(measuredBpmFloat * step) / step;
    if (Math.abs(snapBpm - measuredBpmFloat) > 0.05) continue;
    const pS = (60 * SAMPLE_RATE) / snapBpm;
    const r = rmsFixed(pS);
    if (r.rms <= baseRms + Math.max(0.00025 * SAMPLE_RATE, baseRms * 0.1)) {
      canonicalBpm = rational(Math.round(snapBpm * step), step);
      period = div(rational(60), canonicalBpm);
      periodS = pS;
      snapped = true;
      snapRule = step === 1 ? "integer BPM" : step === 2 ? "half-BPM" : "quarter-BPM";
      break;
    }
  }
  anchorS = rmsFixed(periodS).anchor;

  // Exact anchor on the sample grid, moved to the first beat at or after t = 0.
  const anchorRaw = rational(Math.round(anchorS), SAMPLE_RATE);
  const k0 = ceil(div(sub(rational(0), anchorRaw), period));
  const anchor = add(anchorRaw, mul(rational(k0), period));
  const durationS = rational(totalSamples, SAMPLE_RATE);
  const beatCount = floor(div(sub(durationS, anchor), period)) + 1;
  const residualRmsMs = (rmsFixed(periodS).rms / SAMPLE_RATE) * 1000;
  const confidence = Math.max(0, Math.min(1, best.f1 * Math.exp(-residualRmsMs / 15)));
  return {
    anchor,
    period,
    canonicalBpm,
    measuredBpm: bpmFromPeriodSamples(measuredPeriodS),
    snapped,
    snapRule,
    beatCount,
    confidence,
    support: best.support,
    residualRmsMs,
    constantTempo: { isConstant: halfDiff < 0.1, halfDifferencePercent: halfDiff, driftMsPerMinute },
    candidates,
  };
}

/** Exact time of beat i: anchor + i * period. */
export function beatTime(grid: BeatGrid, i: number): Rational {
  return add(grid.anchor, mul(rational(i), grid.period));
}

/** Nearest sample index of an exact time (display/refinement only). */
export function nearestSample(t: Rational): number {
  const s = mul(t, rational(SAMPLE_RATE));
  return Math.floor((2 * s.num + s.den) / (2 * s.den));
}
