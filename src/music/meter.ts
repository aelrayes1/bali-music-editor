/**
 * Downbeats, bars and phrases on top of the exact beat grid (4/4 assumed; configurable).
 *
 * Downbeat phase: structural changes in dance music (new elements, crashes, drops, energy
 * jumps) land on bar starts. For each beat we measure change vs the previous beat (timbre
 * distance + energy rise + kick accent); the phase whose beats carry the most change (squared,
 * so big structural changes dominate) is the downbeat phase. Phrases do the same at bar level.
 * Confidence is the margin of the winner over the runner-up.
 */

import type { Rational } from "../time/rational.ts";
import { percentile } from "./dsp.ts";
import { type FrameFeatures, FRAMES_PER_SECOND, TIMBRE_BANDS } from "./features.ts";
import { type BeatGrid, beatTime } from "./tempo.ts";
import { toNumberApprox } from "../time/rational.ts";

export interface BeatInfo {
  index: number;
  time: Rational;
  frameFrom: number;
  frameTo: number;
  energyDb: number;
  lowDb: number;
  kickAccent: number;
  /** Low-band (<120 Hz) level 0-60 ms after the beat minus 250-400 ms after it (dB). */
  kickPulseDb: number;
  change: number;
}

/** A kick is present on a beat when its low-band pulse is at least this strong. */
export const KICK_PULSE_DB = 4;

/** Two cascaded one-pole low-passes at ~120 Hz (sub/kick band), squared. */
export function subBandPower(samples: Float32Array, sampleRate: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * 120) / sampleRate);
  const out = new Float32Array(samples.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    y1 = (1 - a) * samples[i]! + a * y1;
    y2 = (1 - a) * y1 + a * y2;
    out[i] = y2 * y2;
  }
  return out;
}

function levelDb(power: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from);
  const b = Math.min(power.length, to);
  if (b <= a) return -120;
  let x = 0;
  for (let i = a; i < b; i++) x += power[i]!;
  return 10 * Math.log10(x / (b - a) + 1e-12);
}

export interface Meter {
  beatsPerBar: number;
  downbeatPhase: number;
  downbeatConfidence: number;
  phraseBars: number;
  phrasePhaseBars: number;
  phraseConfidence: number;
  beats: BeatInfo[];
  /** Beat index of each bar start (bar j starts at beat downbeatPhase + j * beatsPerBar). */
  barStartBeats: number[];
  barChange: number[];
}

function frameOf(t: Rational): number {
  return Math.round(toNumberApprox(t) * FRAMES_PER_SECOND);
}

function meanVec(f: FrameFeatures, from: number, to: number): Float64Array {
  const v = new Float64Array(TIMBRE_BANDS);
  const n = Math.max(1, to - from);
  for (let k = from; k < to && k < f.frames; k++) {
    for (let b = 0; b < TIMBRE_BANDS; b++) v[b] = v[b]! + f.timbre[k * TIMBRE_BANDS + b]!;
  }
  for (let b = 0; b < TIMBRE_BANDS; b++) v[b] = v[b]! / n;
  return v;
}

function timbreDistance(a: Float64Array, b: Float64Array): number {
  // mean absolute dB difference across bands, scaled to ~[0, 1]
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length / 12;
}

function powerMeanDb(xs: Float64Array, from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let k = Math.max(0, from); k < Math.min(xs.length, to); k++) {
    s += Math.pow(10, xs[k]! / 10);
    n++;
  }
  return n ? 10 * Math.log10(Math.max(s / n, 1e-12)) : -120;
}

function pickPhase(values: number[], cycle: number): { phase: number; confidence: number } {
  const score = new Array<number>(cycle).fill(0);
  const count = new Array<number>(cycle).fill(0);
  values.forEach((v, i) => {
    score[i % cycle] = score[i % cycle]! + v * v;
    count[i % cycle] = count[i % cycle]! + 1;
  });
  const mean = score.map((s, i) => (count[i]! ? s / count[i]! : 0));
  const order = mean.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m || a.i - b.i);
  const best = order[0]!;
  const second = order[1] ?? { m: 0, i: 0 };
  const confidence = best.m > 0 ? Math.max(0, Math.min(1, (best.m - second.m) / best.m)) : 0;
  return { phase: best.i, confidence };
}

export function analyzeMeter(
  f: FrameFeatures,
  grid: BeatGrid,
  beatsPerBar: number,
  phraseBars: number,
  samples: Float32Array,
  sampleRate: number,
): Meter {
  const sub = subBandPower(samples, sampleRate);
  const lowNorm = percentile(f.fluxLow, 99) || 1;
  const beats: BeatInfo[] = [];
  let prevVec: Float64Array | null = null;
  let prevEnergy = 0;
  for (let i = 0; i < grid.beatCount; i++) {
    const time = beatTime(grid, i);
    const from = frameOf(time);
    const to = frameOf(beatTime(grid, i + 1));
    const vec = meanVec(f, from, to);
    const energyDb = powerMeanDb(f.totalDb, from, to);
    const lowDb = powerMeanDb(f.lowDb, from, to);
    let accent = 0;
    for (let k = Math.max(0, from - 3); k <= Math.min(f.frames - 1, from + 3); k++) accent = Math.max(accent, f.fluxLow[k]! / lowNorm);
    const t0 = Math.round(toNumberApprox(time) * sampleRate);
    const kickPulseDb =
      levelDb(sub, t0, t0 + Math.round(0.06 * sampleRate)) -
      levelDb(sub, t0 + Math.round(0.25 * sampleRate), t0 + Math.round(0.4 * sampleRate));
    const change = prevVec ? timbreDistance(vec, prevVec) + Math.max(0, energyDb - prevEnergy) / 6 + 0.25 * accent : 0;
    beats.push({ index: i, time, frameFrom: from, frameTo: to, energyDb, lowDb, kickAccent: accent, kickPulseDb, change });
    prevVec = vec;
    prevEnergy = energyDb;
  }

  const down = pickPhase(beats.map((b) => b.change), beatsPerBar);
  const barStartBeats: number[] = [];
  for (let i = down.phase; i < beats.length; i += beatsPerBar) barStartBeats.push(i);

  // Bar-level change for phrases.
  const barVecs = barStartBeats.map((b) => meanVec(f, beats[b]!.frameFrom, beats[Math.min(beats.length - 1, b + beatsPerBar - 1)]!.frameTo));
  const barEnergy = barStartBeats.map((b) => powerMeanDb(f.totalDb, beats[b]!.frameFrom, beats[Math.min(beats.length - 1, b + beatsPerBar - 1)]!.frameTo));
  const barLow = barStartBeats.map((b) => powerMeanDb(f.lowDb, beats[b]!.frameFrom, beats[Math.min(beats.length - 1, b + beatsPerBar - 1)]!.frameTo));
  const barChange = barStartBeats.map((_, j) =>
    j === 0 ? 0 : timbreDistance(barVecs[j]!, barVecs[j - 1]!) + Math.abs(barEnergy[j]! - barEnergy[j - 1]!) / 6 + Math.abs(barLow[j]! - barLow[j - 1]!) / 6,
  );
  const phrase = pickPhase(barChange, phraseBars);

  return {
    beatsPerBar,
    downbeatPhase: down.phase,
    downbeatConfidence: down.confidence,
    phraseBars,
    phrasePhaseBars: phrase.phase,
    phraseConfidence: phrase.confidence,
    beats,
    barStartBeats,
    barChange,
  };
}

