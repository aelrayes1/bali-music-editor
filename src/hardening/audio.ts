/**
 * Phase 12: audio QC on decoded samples. Separates what a codec / container legitimately does (AAC priming
 * and end padding, compensated by the container's start time / edit list) from real faults: a sync drift,
 * an accidental gain change, inserted silence, a missing or remixed stream. All functions are pure.
 */

import { type Issue } from "./errors.ts";

export const rmsDb = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(Math.max(1e-20, s / Math.max(1, to - from)));
};

/** Sample-accurate lag of `x` against `ref` (positive = x is late), by normalised cross-correlation. */
export function estimateLag(ref: Float32Array, x: Float32Array, maxLag: number, opts: { from?: number; to?: number } = {}): { lag: number; corr: number } {
  const from = Math.max(maxLag, opts.from ?? maxLag);
  const to = Math.min(ref.length - maxLag, x.length - maxLag, opts.to ?? Number.POSITIVE_INFINITY);
  let best = { lag: 0, corr: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = from; i < to; i++) {
      const a = ref[i]!;
      const b = x[i + lag]!;
      sxy += a * b;
      sxx += a * a;
      syy += b * b;
    }
    const c = sxy / Math.sqrt(Math.max(1e-20, sxx * syy));
    if (c > best.corr) best = { lag, corr: c };
  }
  return { lag: best.lag, corr: Math.round(best.corr * 1e6) / 1e6 };
}

/** Runs of silence (below `db` for at least `minMs`), in samples. */
export function silenceRuns(x: Float32Array, rate: number, db = -60, minMs = 100): Array<[number, number]> {
  const win = Math.max(1, Math.round(rate * 0.01));
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < x.length; i += win) {
    const silent = rmsDb(x, i, Math.min(x.length, i + win)) < db;
    if (silent && start < 0) start = i;
    if ((!silent || i + win >= x.length) && start >= 0) {
      const end = silent ? x.length : i;
      if (end - start >= (minMs / 1000) * rate) runs.push([start, end]);
      start = -1;
    }
  }
  return runs;
}

export interface AudioCompare {
  lagSamples: number;
  corr: number;
  verdict: "IN_SYNC" | "CODEC_PADDING" | "SYNC_DRIFT";
  gainDb: number;
  addedSilence: Array<[number, number]>;
  issues: Issue[];
}

/**
 * Compare a delivered stream (decoded, mono) with the approved reference (decoded, mono, same rate).
 * `containerOffsetSamples` is the offset the container itself declares (start time / edit list) — a lag
 * equal to it is codec padding, anything else is drift.
 */
export function compareAudio(ref: Float32Array, out: Float32Array, rate: number, opts: { containerOffsetSamples?: number; maxLagMs?: number; gainToleranceDb?: number; file?: string } = {}): AudioCompare {
  const maxLag = Math.round(((opts.maxLagMs ?? 100) / 1000) * rate);
  const { lag, corr } = estimateLag(ref, out, maxLag);
  const declared = opts.containerOffsetSamples ?? 0;
  const verdict: AudioCompare["verdict"] = lag === 0 ? "IN_SYNC" : declared !== 0 && Math.abs(lag - declared) <= 1 ? "CODEC_PADDING" : "SYNC_DRIFT";
  // gain over the aligned body
  const a0 = Math.max(0, -lag) + maxLag;
  const a1 = Math.min(ref.length, out.length - lag) - maxLag;
  const gainDb = Math.round((rmsDb(out, a0 + lag, a1 + lag) - rmsDb(ref, a0, a1)) * 100) / 100;
  const refSilence = silenceRuns(ref, rate);
  const outSilence = silenceRuns(out, rate);
  const covered = (r: [number, number]) => refSilence.some(([s, e]) => s - maxLag <= r[0] - lag && e + maxLag >= r[1] - lag);
  const addedSilence = outSilence.filter((r) => !covered(r));
  const issues: Issue[] = [];
  if (verdict === "SYNC_DRIFT") issues.push({ code: "AUDIO_SYNC_DRIFT", severity: "BLOCKING", what: `audio is ${lag} samples (${Math.round((lag / rate) * 100000) / 100} ms) ${lag > 0 ? "late" : "early"}`, file: opts.file, expected: declared, actual: lag, next: "re-mux the approved audio with the video at the same start; never re-time audio to hide drift" });
  if (Math.abs(gainDb) > (opts.gainToleranceDb ?? 0.5)) issues.push({ code: "AUDIO_GAIN_CHANGED", severity: "BLOCKING", what: `level changed by ${gainDb} dB`, file: opts.file, expected: 0, actual: gainDb, next: "deliver the approved audio stream unchanged (stream copy or the approved encode)" });
  if (addedSilence.length) issues.push({ code: "AUDIO_SILENCE_ADDED", severity: "BLOCKING", what: `${addedSilence.length} silent run(s) not in the approved audio (first at ${Math.round((addedSilence[0]![0] / rate) * 1000)} ms)`, file: opts.file, next: "re-mux the approved audio; check the edit for a muted or missing segment" });
  if (corr < 0.9 && verdict !== "SYNC_DRIFT") issues.push({ code: "AUDIO_CONTENT_CHANGED", severity: "BLOCKING", what: `audio does not match the approved stream (correlation ${corr})`, file: opts.file, next: "the stream was remixed or replaced; deliver the approved audio" });
  return { lagSamples: lag, corr, verdict, gainDb, addedSilence, issues };
}
