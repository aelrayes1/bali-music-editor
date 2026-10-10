/**
 * Structure and energy: silence, breaks, drops, builds, impacts, fills, phrase boundaries,
 * sections and a 10 Hz energy curve. Heuristic, evidence-based, always with confidence;
 * weak evidence yields no label rather than a guessed one.
 */

import { type Rational, rational } from "../time/rational.ts";
import { median, percentile } from "./dsp.ts";
import { type FrameFeatures, FRAMES_PER_SECOND, HOP, SAMPLE_RATE } from "./features.ts";
import { KICK_PULSE_DB, type Meter } from "./meter.ts";
import { type Onset, nearestSample } from "./tempo.ts";

export type PointType = "impact" | "drop" | "phrase_boundary";
export type RegionType = "silence" | "break" | "build" | "fill";

export interface PointEvent {
  type: PointType;
  time: Rational;
  sample: number;
  strength: number;
  confidence: number;
  method: string;
  detail: string;
}

export interface Region {
  type: RegionType;
  start: Rational;
  end: Rational;
  startSample: number;
  endSample: number;
  confidence: number;
  method: string;
  detail: string;
}

export type SectionLabel = "intro" | "groove" | "break" | "build" | "drop" | "outro" | "unknown";

export interface Section {
  start: Rational;
  end: Rational;
  startBeat: number;
  endBeat: number;
  label: SectionLabel;
  energyLevel: "low" | "medium" | "high";
  trend: "rising" | "falling" | "steady";
  meanEnergyDb: number;
  meanLowDb: number;
  confidence: number;
  evidence: string;
}

export interface EnergyCurve {
  /** Exact spacing of curve points: 1/10 s. */
  step: Rational;
  rmsDbfs: number[];
  lowDb: number[];
  midDb: number[];
  highDb: number[];
  onsetsPerSecond: number[];
}

export interface Structure {
  points: PointEvent[];
  regions: Region[];
  sections: Section[];
  curve: EnergyCurve;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;

function powerMean(xs: Float64Array, from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let k = Math.max(0, from); k < Math.min(xs.length, to); k++) {
    s += Math.pow(10, xs[k]! / 10);
    n++;
  }
  return n ? 10 * Math.log10(Math.max(s / n, 1e-12)) : -120;
}

function frameTime(frame: number): Rational {
  return rational(frame, FRAMES_PER_SECOND);
}

export function detectSilence(f: FrameFeatures, thresholdDbfs = -60, minFrames = 30): Region[] {
  const out: Region[] = [];
  let start = -1;
  for (let k = 0; k <= f.frames; k++) {
    const quiet = k < f.frames && f.rmsDbfs[k]! < thresholdDbfs;
    if (quiet && start < 0) start = k;
    if (!quiet && start >= 0) {
      if (k - start >= minFrames) {
        out.push({
          type: "silence",
          start: frameTime(start),
          end: frameTime(k),
          startSample: start * HOP,
          endSample: k * HOP,
          confidence: 1,
          method: `rms < ${thresholdDbfs} dBFS for >= ${minFrames / FRAMES_PER_SECOND} s`,
          detail: `${r2((k - start) / FRAMES_PER_SECOND)} s`,
        });
      }
      start = -1;
    }
  }
  return out;
}

export function analyzeStructure(f: FrameFeatures, meter: Meter, onsets: Onset[]): Structure {
  const beats = meter.beats;
  const points: PointEvent[] = [];
  const regions: Region[] = [...detectSilence(f)];
  const nb = beats.length;

  // --- Breaks: >= 1 bar without kick accents, with kicks before and after --------------
  const hasKick = beats.map((b) => b.kickPulseDb >= KICK_PULSE_DB);
  const firstKick = hasKick.indexOf(true);
  const lastKick = hasKick.lastIndexOf(true);
  const breaks: Array<{ from: number; to: number }> = [];
  for (let i = firstKick + 1; i <= lastKick && firstKick >= 0; i++) {
    if (hasKick[i]) continue;
    let j = i;
    while (j <= lastKick && !hasKick[j]) j++;
    if (j - i >= meter.beatsPerBar) {
      const prev = breaks[breaks.length - 1];
      if (prev && i - prev.to <= meter.beatsPerBar) prev.to = j; // merge across <= 1 bar of stray kicks
      else breaks.push({ from: i, to: j }); // [from, to) kickless beats
    }
    i = j;
  }
  for (const b of breaks) {
    const pulse = beats.slice(b.from, b.to).reduce((s, x) => s + x.kickPulseDb, 0) / (b.to - b.from);
    regions.push({
      type: "break",
      start: beats[b.from]!.time,
      end: beats[b.to]!.time,
      startSample: nearestSample(beats[b.from]!.time),
      endSample: nearestSample(beats[b.to]!.time),
      confidence: r2(clamp01(0.4 + (KICK_PULSE_DB - pulse) / 10 + 0.1 * Math.min(2, (b.to - b.from) / meter.beatsPerBar))),
      method: `sub-band kick pulse < ${KICK_PULSE_DB} dB on consecutive beats`,
      detail: `${b.to - b.from} beats without kick (beats ${b.from}-${b.to - 1}), mean pulse ${r2(pulse)} dB`,
    });
  }

  // --- Drops: kick returns after a break with an energy jump; or large low-band surges ---
  const dropBeats = new Set<number>();
  const addDrop = (i: number, jumpDb: number, lowJumpDb: number, why: string) => {
    if (dropBeats.has(i)) return;
    dropBeats.add(i);
    points.push({
      type: "drop",
      time: beats[i]!.time,
      sample: nearestSample(beats[i]!.time),
      strength: r2(Math.max(jumpDb, lowJumpDb)),
      confidence: r2(clamp01(0.35 + Math.max(jumpDb, lowJumpDb) / 12)),
      method: why,
      detail: `energy +${r2(jumpDb)} dB, low band +${r2(lowJumpDb)} dB`,
    });
  };
  const span = (from: number, to: number, key: "energyDb" | "lowDb") => {
    const xs = beats.slice(Math.max(0, from), Math.min(nb, to)).map((b) => Math.pow(10, b[key] / 10));
    return xs.length ? 10 * Math.log10(xs.reduce((s, x) => s + x, 0) / xs.length) : -120;
  };
  for (const b of breaks) {
    // The drop is the beat within one bar after the break with the largest low-band return
    // (pickup hits just before the downbeat do not count as the drop).
    // The moment of return: the earliest beat whose low-band level is within 1.5 dB of the
    // strongest return in that bar.
    const range = beats.slice(b.to, Math.min(nb, b.to + meter.beatsPerBar + 1));
    const maxLow = Math.max(...range.map((x) => x.lowDb));
    const firstStrong = range.findIndex((x) => x.lowDb >= maxLow - 1.5);
    const bestI = firstStrong < 0 ? -1 : b.to + firstStrong;
    if (bestI < 0) continue;
    const jump = span(bestI, bestI + meter.beatsPerBar, "energyDb") - span(b.from, b.to, "energyDb");
    const lowJump = span(bestI, bestI + meter.beatsPerBar, "lowDb") - span(b.from, b.to, "lowDb");
    if (jump >= 1.5 || lowJump >= 3) addDrop(bestI, jump, lowJump, "strongest low-band return within a bar after a break");
  }
  for (let j = 2; j < meter.barStartBeats.length; j++) {
    const i = meter.barStartBeats[j]!;
    const lowJump = span(i, i + meter.beatsPerBar, "lowDb") - span(i - 2 * meter.beatsPerBar, i, "lowDb");
    const jump = span(i, i + meter.beatsPerBar, "energyDb") - span(i - 2 * meter.beatsPerBar, i, "energyDb");
    const kicksInBar = beats.slice(i, i + meter.beatsPerBar).filter((b) => b.kickPulseDb >= KICK_PULSE_DB).length;
    // A surge only counts as a drop when the kick is actually present (risers also surge).
    if (lowJump >= 8 && jump >= 3 && kicksInBar >= 2) addDrop(i, jump, lowJump, "bar-level low-band surge with kick");
  }

  // Keep one drop per bar (largest low-band jump).
  const dropPoints = points.filter((p) => p.type === "drop").sort((a, b) => a.sample - b.sample);
  for (let x = 1; x < dropPoints.length; x++) {
    const a = dropPoints[x - 1]!;
    const c = dropPoints[x]!;
    const barSamples = meter.beatsPerBar * (beats[1] ? nearestSample(beats[1].time) - nearestSample(beats[0]!.time) : 0);
    if (c.sample - a.sample < barSamples) {
      const loser = a.strength >= c.strength ? c : a;
      points.splice(points.indexOf(loser), 1);
      for (const [i, b] of beats.entries()) if (nearestSample(b.time) === loser.sample) dropBeats.delete(i);
    }
  }

  // --- Builds: rising non-low energy leading into a drop ---------------------------------
  for (const d of [...dropBeats].sort((a, b) => a - b)) {
    const from = Math.max(0, d - 2 * meter.phraseBars * meter.beatsPerBar);
    const window = beats.slice(Math.max(from, d - 4 * meter.beatsPerBar), d);
    if (window.length < 2 * meter.beatsPerBar) continue;
    const highDb = window.map((b) => powerMean(f.highDb, b.frameFrom, b.frameTo));
    const n = highDb.length;
    const xm = (n - 1) / 2;
    const ym = highDb.reduce((s, x) => s + x, 0) / n;
    let num = 0;
    let den = 0;
    highDb.forEach((y, i) => {
      num += (i - xm) * (y - ym);
      den += (i - xm) ** 2;
    });
    const slopePerBar = (num / den) * meter.beatsPerBar;
    if (slopePerBar < 0.75) continue;
    const start = window[0]!;
    regions.push({
      type: "build",
      start: start.time,
      end: beats[d]!.time,
      startSample: nearestSample(start.time),
      endSample: nearestSample(beats[d]!.time),
      confidence: r2(clamp01(slopePerBar / 4)),
      method: "rising high-band energy before a drop",
      detail: `high band +${r2(slopePerBar)} dB/bar over ${n} beats`,
    });
  }

  // --- Impacts: strong onsets with a real energy jump, plus every drop ----------------------
  const strengths = onsets.map((o) => o.strength);
  const strongCut = strengths.length ? percentile(strengths, 95) : Infinity;
  for (const o of onsets) {
    if (o.strength < strongCut) continue;
    const before = powerMean(f.totalDb, o.frame - 25, o.frame - 2);
    const after = powerMean(f.totalDb, o.frame + 1, o.frame + 25);
    const rise = after - before;
    if (rise < 4) continue;
    const t = rational(o.sample, SAMPLE_RATE);
    points.push({
      type: "impact",
      time: t,
      sample: o.sample,
      strength: r2(o.strength),
      confidence: r2(clamp01(rise / 10) * clamp01(o.strength)),
      method: "top-5% onset with >= 4 dB energy rise",
      detail: `energy +${r2(rise)} dB`,
    });
  }
  for (const d of dropBeats) {
    const t = beats[d]!.time;
    const s = nearestSample(t);
    if (points.some((p) => p.type === "impact" && Math.abs(p.sample - s) < 0.06 * SAMPLE_RATE)) continue;
    const drop = points.find((p) => p.type === "drop" && p.sample === s)!;
    points.push({ ...drop, type: "impact", method: "drop" });
  }

  // --- Fills: onset density spike on a beat (bar-agnostic: a fill must not depend on an
  //     uncertain downbeat; the detail says whether it ends a bar).
  const perBeat = beats.map((b) => onsets.filter((o) => o.frame >= b.frameFrom && o.frame < b.frameTo).length);
  const typical = Math.max(1, median(perBeat.filter((_, i) => hasKick[i])));
  const barEnds = new Set(meter.barStartBeats.map((b) => b - 1));
  for (let i = 0; i < nb - 1; i++) {
    const count = perBeat[i]!;
    if (count < Math.max(3, 2 * typical)) continue;
    const prev = regions[regions.length - 1];
    if (prev && prev.type === "fill" && prev.endSample === nearestSample(beats[i]!.time)) {
      prev.end = beats[i + 1]!.time;
      prev.endSample = nearestSample(beats[i + 1]!.time);
      continue;
    }
    regions.push({
      type: "fill",
      start: beats[i]!.time,
      end: beats[i + 1]!.time,
      startSample: nearestSample(beats[i]!.time),
      endSample: nearestSample(beats[i + 1]!.time),
      confidence: r2(clamp01(count / (4 * typical))),
      method: "onset density spike on a beat",
      detail: `${count} onsets vs typical ${typical} per beat${barEnds.has(i) ? "; last beat of a bar" : ""}`,
    });
  }

  // --- Phrase boundaries --------------------------------------------------------------------
  const boundaryChanges = meter.barStartBeats
    .map((_, j) => j)
    .filter((j) => j % meter.phraseBars === meter.phrasePhaseBars % meter.phraseBars)
    .map((j) => meter.barChange[j]!);
  const bRef = percentile(boundaryChanges.length ? boundaryChanges : [1], 90) || 1;
  meter.barStartBeats.forEach((beatIdx, j) => {
    if (j % meter.phraseBars !== meter.phrasePhaseBars % meter.phraseBars) return;
    const t = beats[beatIdx]!.time;
    points.push({
      type: "phrase_boundary",
      time: t,
      sample: nearestSample(t),
      strength: r2(meter.barChange[j]!),
      confidence: r2(clamp01(meter.phraseConfidence * 0.5 + 0.5 * clamp01(meter.barChange[j]! / bRef))),
      method: `${meter.phraseBars}-bar phrase grid (phase ${meter.phrasePhaseBars})`,
      detail: `bar ${j}`,
    });
  });

  // --- Sections -----------------------------------------------------------------------------
  const cuts = new Set<number>([0, nb]);
  meter.barStartBeats.forEach((b, j) => {
    if (j % meter.phraseBars === meter.phrasePhaseBars % meter.phraseBars) cuts.add(b);
  });
  for (const b of breaks) {
    cuts.add(b.from);
    cuts.add(b.to);
  }
  for (const d of dropBeats) cuts.add(d);
  const edges = [...cuts].filter((x) => x >= 0 && x <= nb).sort((a, b) => a - b);
  const raw: Array<Omit<Section, "label" | "energyLevel" | "confidence" | "evidence">> = [];
  for (let s = 0; s + 1 < edges.length; s++) {
    const a = edges[s]!;
    const b = edges[s + 1]!;
    if (b - a < 1) continue;
    const seg = beats.slice(a, b);
    const e = seg.map((x) => x.energyDb);
    const slope = e.length > 1 ? ((e[e.length - 1]! - e[0]!) / (e.length - 1)) * meter.beatsPerBar : 0;
    raw.push({
      start: beats[a]!.time,
      end: b < nb ? beats[b]!.time : rational(Math.round(f.frames * HOP), SAMPLE_RATE),
      startBeat: a,
      endBeat: b,
      trend: slope > 0.75 ? "rising" : slope < -0.75 ? "falling" : "steady",
      meanEnergyDb: r2(span(a, b, "energyDb")),
      meanLowDb: r2(span(a, b, "lowDb")),
    });
  }
  const ref = percentile(raw.map((s) => s.meanEnergyDb), 90);
  const sections: Section[] = raw.map((s, idx) => {
    const energyLevel = s.meanEnergyDb >= ref - 3 ? "high" : s.meanEnergyDb <= ref - 9 ? "low" : "medium";
    const inBreak = breaks.some((b) => s.startBeat >= b.from && s.endBeat <= b.to);
    const startsDrop = dropBeats.has(s.startBeat);
    const endsInDrop = dropBeats.has(s.endBeat);
    let label: SectionLabel = "unknown";
    let evidence = "";
    let confidence = 0.4;
    if (inBreak) {
      label = s.trend === "rising" && endsInDrop ? "build" : "break";
      evidence = "no kick pulse on these beats";
      confidence = 0.75;
    } else if (startsDrop) {
      label = "drop";
      evidence = "starts where kicks return with an energy jump";
      confidence = 0.7;
    } else if (idx === 0 && energyLevel !== "high" && s.startBeat < (breaks[0]?.from ?? Infinity)) {
      label = "intro";
      evidence = "opening section below peak energy";
      confidence = 0.5;
    } else if (idx === raw.length - 1 && energyLevel !== "high") {
      label = "outro";
      evidence = "closing section below peak energy";
      confidence = 0.5;
    } else if (energyLevel === "high") {
      label = "groove";
      evidence = "full-energy section with kick";
      confidence = 0.6;
    }
    return { ...s, label, energyLevel, confidence, evidence };
  });

  // --- 10 Hz energy curve -------------------------------------------------------------------
  const steps = Math.floor(f.frames / 10);
  const curve: EnergyCurve = { step: rational(1, 10), rmsDbfs: [], lowDb: [], midDb: [], highDb: [], onsetsPerSecond: [] };
  const onsetFrames = onsets.map((o) => o.frame);
  let lo = 0;
  let hi = 0;
  for (let m = 0; m < steps; m++) {
    const a = m * 10;
    curve.rmsDbfs.push(r2(powerMean(f.rmsDbfs, a, a + 10)));
    curve.lowDb.push(r2(powerMean(f.lowDb, a, a + 10)));
    curve.midDb.push(r2(powerMean(f.midDb, a, a + 10)));
    curve.highDb.push(r2(powerMean(f.highDb, a, a + 10)));
    while (lo < onsetFrames.length && onsetFrames[lo]! < a - 45) lo++;
    while (hi < onsetFrames.length && onsetFrames[hi]! < a + 55) hi++;
    curve.onsetsPerSecond.push(hi - lo);
  }

  points.sort((a, b) => a.sample - b.sample || a.type.localeCompare(b.type));
  regions.sort((a, b) => a.startSample - b.startSample || a.type.localeCompare(b.type));
  return { points, regions, sections, curve };
}

