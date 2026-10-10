/**
 * Music Intelligence orchestration.
 *
 * analyzeSamples()  pure: samples + config -> validated MusicAnalysis (no I/O)
 * analyzeMusic()    decode via the verified FFmpeg, EBU R128 loudness, cache, then analyzeSamples()
 *
 * Cache key = content fingerprint + analyzer version + analyzer implementation fingerprint (hash of
 * the analyzer's source modules) + configuration hash + FFmpeg version (src/cache/identity.ts).
 */

import { createHash } from "node:crypto";
import { type CacheIdentity, cacheKey, implementationFingerprint } from "../common/cache-identity.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";
import { type Rational, compare, div, mul, rational, roundHalfUp, sub, toNumberApprox } from "../time/rational.ts";
import { parseTimeLiteral, literalToSeconds } from "../time/time.ts";
import { percentile } from "./dsp.ts";
import { FRAME_SIZE, HOP, SAMPLE_RATE, computeFeatures, decodeMono } from "./features.ts";
import { type LoudnessCurve, measureLoudness } from "./loudness.ts";
import { KICK_PULSE_DB, analyzeMeter } from "./meter.ts";
import { MUSIC_SCHEMA_VERSION, type MusicAnalysis, MusicAnalysisSchema, type MusicEvent } from "./schema.ts";
import { analyzeStructure } from "./structure.ts";
import { beatNovelty, beatOnsets, beatTime, detectOnsets, fitBeatGrid, nearestSample } from "./tempo.ts";
import { type FocusWindow, analyzeVocals } from "./vocals.ts";

export const ANALYZER_VERSION = "1.0.0";

/** The modules whose code determines music-analysis.json (hashed into the cache identity). */
export const ANALYZER_MODULES: readonly URL[] = ["analyze.ts", "dsp.ts", "features.ts", "loudness.ts", "meter.ts", "schema.ts", "structure.ts", "tempo.ts", "vocals.ts"].map(
  (f) => new URL(`./${f}`, import.meta.url),
);

export function musicCacheIdentity(fingerprint: string, config: MusicAnalysisConfig, ffmpegVersion: string, overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    input: fingerprint,
    analyzer: "bali-music-intelligence",
    analyzerVersion: ANALYZER_VERSION,
    implementation: implementationFingerprint(ANALYZER_MODULES),
    configHash: configHash(config),
    tools: { ffmpeg: ffmpegVersion },
    ...overrides,
  };
}

export interface MusicAnalysisConfig {
  tempo: { minBpm: number; maxBpm: number; priorBpm: number };
  beatsPerBar: number;
  phraseBars: number;
  /** Windows (unit-explicit literals) where vocal repetition clustering runs. */
  focusWindows: Array<{ id: string; start: string; end: string }>;
  vocalClusterThreshold: number;
}

export const DEFAULT_CONFIG: MusicAnalysisConfig = {
  tempo: { minBpm: 70, maxBpm: 180, priorBpm: 125 },
  beatsPerBar: 4,
  phraseBars: 8,
  focusWindows: [],
  vocalClusterThreshold: 0.8,
};

export interface SourceInfo {
  mediaId: string;
  fingerprint: string;
  audioStreamIndex: number;
  fileName: string;
}

/** Stable, key-sorted JSON (for hashing). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function configHash(config: MusicAnalysisConfig): string {
  return createHash("sha256").update(canonicalJson({ analyzer: ANALYZER_VERSION, config })).digest("hex").slice(0, 16);
}

export function parseWindow(w: { id: string; start: string; end: string }): FocusWindow {
  const start = literalToSeconds(parseTimeLiteral(w.start));
  const end = literalToSeconds(parseTimeLiteral(w.end));
  if (compare(end, start) <= 0) throw new RangeError(`window ${w.id}: end must be after start`);
  return { id: w.id, start, end };
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const EMPTY_LOUDNESS: LoudnessCurve = { momentaryLufs: [], shortTermLufs: [], integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: null };

export function analyzeSamples(
  samples: Float32Array,
  source: SourceInfo,
  config: MusicAnalysisConfig,
  meta: { ffmpeg: { path: string; version: string }; loudness?: LoudnessCurve; now?: () => string },
): MusicAnalysis {
  const windows = config.focusWindows.map(parseWindow);
  const f = computeFeatures(samples);
  const onsets = detectOnsets(samples, f);
  const grid = fitBeatGrid(beatNovelty(f), onsets, samples.length, config.tempo);
  const meter = analyzeMeter(f, grid, config.beatsPerBar, config.phraseBars, samples, SAMPLE_RATE);
  const structure = analyzeStructure(f, meter, onsets);
  const vocals = analyzeVocals(samples, f, windows, config.vocalClusterThreshold);
  const kicks = beatOnsets(onsets);
  const warnings: MusicAnalysis["warnings"] = [];

  // --- Beats ---------------------------------------------------------------------------------
  const phase = meter.downbeatPhase;
  const bpb = meter.beatsPerBar;
  let k = 0;
  const beats = meter.beats.map((b) => {
    const s = nearestSample(b.time);
    while (k < kicks.length && kicks[k]!.sample < s - 0.03 * SAMPLE_RATE) k++;
    const hit = k < kicks.length && Math.abs(kicks[k]!.sample - s) <= 0.03 * SAMPLE_RATE ? kicks[k]! : null;
    const rel = b.index - phase;
    return {
      id: `beat:${pad(b.index, 4)}`,
      index: b.index,
      time: b.time,
      sample: s,
      isDownbeat: rel >= 0 && rel % bpb === 0,
      barIndex: rel >= 0 ? Math.floor(rel / bpb) : -1,
      beatInBar: (((rel % bpb) + bpb) % bpb) + 1,
      supported: hit !== null,
      onsetOffsetMs: hit ? r2(((hit.sample - s) / SAMPLE_RATE) * 1000) : null,
      kickAccent: r3(b.kickAccent),
      kickPulseDb: r2(b.kickPulseDb),
    };
  });
  // Beat-grid support: of the beats that carry a kick pulse, how many have an onset within 30 ms.
  const kickBeats = meter.beats.filter((b) => b.kickPulseDb >= KICK_PULSE_DB);
  const onsetSamples = onsets.map((o) => o.sample);
  let supportedKickBeats = 0;
  let oi = 0;
  for (const b of kickBeats) {
    const s = nearestSample(b.time);
    while (oi < onsetSamples.length && onsetSamples[oi]! < s - 0.03 * SAMPLE_RATE) oi++;
    if (oi < onsetSamples.length && Math.abs(onsetSamples[oi]! - s) <= 0.03 * SAMPLE_RATE) supportedKickBeats++;
  }
  const kickSupport = kickBeats.length ? supportedKickBeats / kickBeats.length : 0;
  const bpmConfidence = clamp01(kickSupport * Math.exp(-grid.residualRmsMs / 15));

  // --- Bars ------------------------------------------------------------------------------------
  const barEnergies = meter.barStartBeats.map((bi) => {
    const seg = meter.beats.slice(bi, bi + bpb);
    return 10 * Math.log10(seg.reduce((s, x) => s + Math.pow(10, x.energyDb / 10), 0) / Math.max(1, seg.length));
  });
  const barRef = percentile(barEnergies, 90);
  const bars = meter.barStartBeats.map((bi, j) => {
    const seg = meter.beats.slice(bi, bi + bpb);
    const low = 10 * Math.log10(seg.reduce((s, x) => s + Math.pow(10, x.lowDb / 10), 0) / Math.max(1, seg.length));
    const e = barEnergies[j]!;
    const prev = j > 0 ? barEnergies[j - 1]! : e;
    return {
      id: `bar:${pad(j, 3)}`,
      index: j,
      time: meter.beats[bi]!.time,
      sample: nearestSample(meter.beats[bi]!.time),
      startBeatId: `beat:${pad(bi, 4)}`,
      energyDb: r2(e),
      lowDb: r2(low),
      change: r3(meter.barChange[j]!),
      energyLevel: (e >= barRef - 3 ? "high" : e <= barRef - 9 ? "low" : "medium") as "high" | "medium" | "low",
      trend: (e - prev > 1.5 ? "rising" : e - prev < -1.5 ? "falling" : "steady") as "rising" | "falling" | "steady",
    };
  });

  // --- Phrases -------------------------------------------------------------------------------
  const phrasePoints = structure.points.filter((p) => p.type === "phrase_boundary");
  const phrases = phrasePoints.map((p, i) => {
    const barIdx = bars.findIndex((b) => b.sample === p.sample);
    return {
      id: `phrase:${pad(i, 2)}`,
      index: i,
      time: p.time,
      sample: p.sample,
      startBarId: `bar:${pad(Math.max(0, barIdx), 3)}`,
      lengthBars: meter.phraseBars,
      change: p.strength,
      confidence: p.confidence,
      method: p.method,
    };
  });

  // --- Sections --------------------------------------------------------------------------------
  const sections = structure.sections.map((s, i) => ({
    id: `section:${pad(i, 2)}`,
    index: i,
    start: s.start,
    end: s.end,
    startBeatId: `beat:${pad(s.startBeat, 4)}`,
    label: s.label,
    energyLevel: s.energyLevel,
    trend: s.trend,
    meanEnergyDb: s.meanEnergyDb,
    meanLowDb: s.meanLowDb,
    confidence: r2(s.confidence),
    evidence: s.evidence,
  }));

  // --- Point events ------------------------------------------------------------------------------
  const nearestBeat = (t: Rational) => {
    const idx = Math.max(0, Math.min(grid.beatCount - 1, roundHalfUp(div(sub(t, grid.anchor), grid.period))));
    const bt = beatTime(grid, idx);
    const b = beats[idx];
    return {
      nearestBeatId: b ? b.id : null,
      beatOffsetMs: r2(toNumberApprox(mul(sub(t, bt), rational(1000)))),
      barIndex: b ? b.barIndex : null,
      beatInBar: b ? b.beatInBar : null,
    };
  };
  const events: MusicEvent[] = [];
  const strongest = percentile(onsets.map((o) => o.strength), 99) || 1;
  for (const o of onsets) {
    const t = rational(o.sample, SAMPLE_RATE);
    events.push({
      id: `onset:${o.sample}`,
      type: "onset",
      time: t,
      sample: o.sample,
      strength: r3(o.strength),
      confidence: r2(clamp01(o.strength / strongest)),
      method: "spectral-flux peak, sample-refined",
      detail: o.lowStrength >= 0.35 ? "kick-like (low-band)" : null,
      ...nearestBeat(t),
      vocal: null,
    });
  }
  for (const a of vocals.attacks) {
    const t = rational(a.sample, SAMPLE_RATE);
    events.push({
      id: `vocal:${a.sample}`,
      type: "vocal_attack",
      time: t,
      sample: a.sample,
      strength: a.strength,
      confidence: r2(clamp01(0.3 * a.strength + 0.4 * a.harmonicity + 0.3 * clamp01(a.activityDb / 9))),
      method: "formant-band (450-1800 Hz) level rise >= 3 dB, harmonic-masked, band-passed attack",
      detail: "tonal mid-band attack; word identity unknown",
      ...nearestBeat(t),
      vocal: { harmonicity: a.harmonicity, activityDb: a.activityDb, clusterId: a.clusterId, clusterSimilarity: a.clusterSimilarity },
    });
  }
  for (const p of structure.points) {
    if (p.type === "phrase_boundary") continue;
    events.push({
      id: `${p.type}:${p.sample}`,
      type: p.type,
      time: p.time,
      sample: p.sample,
      strength: p.strength,
      confidence: p.confidence,
      method: p.method,
      detail: p.detail,
      ...nearestBeat(p.time),
      vocal: null,
    });
  }
  events.sort((a, b) => a.sample - b.sample || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const uniqueEvents = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  // --- Regions -------------------------------------------------------------------------------------
  const regions: MusicAnalysis["regions"] = structure.regions.map((r) => ({
    id: `${r.type}:${r.startSample}-${r.endSample}`,
    type: r.type,
    start: r.start,
    end: r.end,
    startSample: r.startSample,
    endSample: r.endSample,
    confidence: r2(r.confidence),
    method: r.method,
    detail: r.detail,
  }));
  for (const v of vocals.regions) {
    regions.push({
      id: `vocal_activity:${v.startFrame * HOP}-${v.endFrame * HOP}`,
      type: "vocal_activity",
      start: rational(v.startFrame, 100),
      end: rational(v.endFrame, 100),
      startSample: v.startFrame * HOP,
      endSample: v.endFrame * HOP,
      confidence: r2(clamp01(v.confidence)),
      method: "tonal mid-band level > +3 dB above 10 s running mean (vocal OR tonal instrument)",
      detail: `+${r2(v.meanActivityDb)} dB`,
    });
  }
  regions.sort((a, b) => a.startSample - b.startSample || a.id.localeCompare(b.id));

  // --- Warnings / confidence ---------------------------------------------------------------------
  if (!grid.constantTempo.isConstant) {
    warnings.push({ code: "TEMPO_NOT_CONSTANT", message: `halves differ by ${r3(grid.constantTempo.halfDifferencePercent)} %` });
  }
  if (bpmConfidence < 0.5) warnings.push({ code: "LOW_BPM_CONFIDENCE", message: `bpm confidence ${r2(bpmConfidence)}` });
  if (meter.downbeatConfidence < 0.2) {
    warnings.push({ code: "LOW_DOWNBEAT_CONFIDENCE", message: `downbeat phase margin ${r2(meter.downbeatConfidence)}` });
  }
  if (kickBeats.length === 0) warnings.push({ code: "NO_KICK_PULSE", message: "no beat carries a sub-band kick pulse" });
  if (kicks === onsets) warnings.push({ code: "NO_KICK_DETECTED", message: "beat grid fitted to all onsets (no kick-like onsets)" });
  for (const w of windows) {
    if (!vocals.clusters.some((c) => c.windowId === w.id)) {
      warnings.push({ code: "NO_VOCAL_REPETITION_IN_WINDOW", message: `no repeated tonal attack pattern in window ${w.id}` });
    }
  }
  warnings.push({
    code: "WORD_IDENTIFICATION_UNAVAILABLE",
    message: "no local speech recognition is installed; vocal attacks are candidates, never identified words",
  });

  const duration = rational(samples.length, SAMPLE_RATE);
  const analysis: MusicAnalysis = {
    schemaVersion: MUSIC_SCHEMA_VERSION,
    generatedAt: (meta.now ?? (() => new Date().toISOString()))(),
    analyzer: {
      name: "bali-music-intelligence",
      version: ANALYZER_VERSION,
      configHash: configHash(config),
      config: JSON.parse(JSON.stringify(config)) as Record<string, unknown>,
      sampleRate: SAMPLE_RATE,
      frameSamples: FRAME_SIZE,
      hopSamples: HOP,
      ffmpeg: meta.ffmpeg,
    },
    source,
    durationSeconds: duration,
    tempo: {
      canonicalBpm: grid.canonicalBpm,
      measuredBpm: grid.measuredBpm,
      bpmConfidence: r3(bpmConfidence),
      beatPeriodSeconds: grid.period,
      gridAnchorSeconds: grid.anchor,
      snapped: grid.snapped,
      snapRule: grid.snapRule,
      support: r3(kickSupport),
      residualRmsMs: r3(grid.residualRmsMs),
      constantTempo: {
        isConstant: grid.constantTempo.isConstant,
        halfDifferencePercent: r3(grid.constantTempo.halfDifferencePercent),
        driftMsPerMinute: r3(grid.constantTempo.driftMsPerMinute),
      },
      candidates: grid.candidates.slice(0, 8).map((c) => ({ bpm: c.bpm, score: r3(c.score), f1: r3(c.contrast), relation: c.relation })),
    },
    meter: {
      beatsPerBar: meter.beatsPerBar,
      downbeatPhase: meter.downbeatPhase,
      downbeatConfidence: r3(meter.downbeatConfidence),
      phraseBars: meter.phraseBars,
      phrasePhaseBars: meter.phrasePhaseBars,
      phraseConfidence: r3(meter.phraseConfidence),
    },
    beats,
    bars,
    phrases,
    sections,
    events: uniqueEvents,
    regions,
    vocal: {
      method: "HPSS-masked (unsmoothed) 450-1800 Hz formant-band level rises + pitch-tolerant medoid repetition clustering",
      wordIdentification: "unavailable",
      note: "Attacks are tonal mid-band candidates (vocal or tonal instrument). Clusters group attacks with matching short spectral patterns; they suggest a repeated sound, not a specific word.",
      clusters: vocals.clusters.map((c) => ({
        id: c.id,
        windowId: c.windowId,
        medoidEventId: `vocal:${c.medoidSample}`,
        memberEventIds: c.members.map((s) => `vocal:${s}`),
        meanSimilarity: c.meanSimilarity,
      })),
    },
    curves: {
      energy: {
        stepSeconds: structure.curve.step,
        rmsDbfs: structure.curve.rmsDbfs,
        lowDb: structure.curve.lowDb,
        midDb: structure.curve.midDb,
        highDb: structure.curve.highDb,
        onsetsPerSecond: structure.curve.onsetsPerSecond,
      },
      loudness: {
        method: "ffmpeg-ebur128",
        stepSeconds: rational(1, 10),
        ...(meta.loudness ?? EMPTY_LOUDNESS),
      },
    },
    confidence: {
      overall: r3(Math.min(bpmConfidence, 0.5 + 0.5 * meter.downbeatConfidence)),
      notes: [
        `tempo ${r2(toNumberApprox(grid.canonicalBpm))} BPM (${grid.snapRule}); ${supportedKickBeats}/${kickBeats.length} kick beats have an onset within 30 ms; residual ${r2(grid.residualRmsMs)} ms`,
        `downbeat phase ${meter.downbeatPhase} (margin ${r2(meter.downbeatConfidence)}), ${meter.phraseBars}-bar phrases from bar ${meter.phrasePhaseBars} (margin ${r2(meter.phraseConfidence)})`,
        "section labels and vocal candidates are heuristic; check the diagnostics before they drive an edit",
      ],
    },
    warnings,
  };
  return MusicAnalysisSchema.parse(analysis);
}

export interface AnalyzeOptions {
  cacheDir?: string | null;
  now?: () => string;
  /** Test hook: override parts of the cache identity (e.g. a different implementation). */
  identityOverrides?: Partial<CacheIdentity>;
}

export async function analyzeMusic(
  tools: MediaTools,
  entry: MediaEntry,
  config: MusicAnalysisConfig = DEFAULT_CONFIG,
  options: AnalyzeOptions = {},
): Promise<{ analysis: MusicAnalysis; cacheHit: boolean; cacheFile: string | null }> {
  const hash = configHash(config);
  const identity = musicCacheIdentity(entry.contentFingerprint.value, config, tools.ffprobeVersion, options.identityOverrides);
  const key = cacheKey(identity);
  const cacheFile = options.cacheDir
    ? path.join(options.cacheDir, `${entry.contentFingerprint.value.slice(0, 16)}-a${identity.analyzerVersion}-${key}.json`)
    : null;
  if (cacheFile) {
    try {
      const doc = JSON.parse(await readFile(cacheFile, "utf8")) as { key?: string; identity?: unknown; analysis?: unknown };
      if (doc.key === key) {
        const cached = MusicAnalysisSchema.parse(doc.analysis);
        if (cached.source.fingerprint === entry.contentFingerprint.value && cached.analyzer.configHash === hash) {
          return { analysis: cached, cacheHit: true, cacheFile };
        }
      }
    } catch {
      /* cache miss */
    }
  }
  const samples = await decodeMono(tools, entry);
  const loudness = await measureLoudness(tools, entry);
  const analysis = analyzeSamples(
    samples,
    {
      mediaId: entry.mediaId,
      fingerprint: entry.contentFingerprint.value,
      audioStreamIndex: entry.audio!.streamIndex,
      fileName: entry.source.fileName,
    },
    config,
    { ffmpeg: { path: tools.ffmpeg, version: tools.ffprobeVersion }, loudness, now: options.now },
  );
  if (cacheFile) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({ key, identity, analysis }) + "\n");
    await rename(tmp, cacheFile);
  }
  return { analysis, cacheHit: false, cacheFile };
}

/** The analysis minus its only non-deterministic field. */
export function deterministicMusicView(a: MusicAnalysis): string {
  return JSON.stringify({ ...a, generatedAt: "<generatedAt>" });
}

