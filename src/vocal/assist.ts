/**
 * Vocal timing assist (Phase 2.5): turn raw Whisper words into evidence-graded word events and
 * relate them to the Phase 2 signal analysis. Pure (no I/O).
 *
 * Whisper is an assistant, never the timing authority:
 *  - raw Whisper times are stored untouched;
 *  - a refined sync time is always an existing Phase 2 event time (vocal attack, else onset) found
 *    inside ±refinementWindowMs of the raw Whisper start; nothing outside that window is used;
 *  - word identity is graded by cross-window consensus and hallucination flags; anything
 *    uncertain stays NEEDS_HUMAN_CONFIRMATION;
 *  - human overrides are applied later (resolveEvents / applyWordOverrides) and are authoritative.
 */

import { type Rational, add, compare, div, rational, sub, toNumberApprox } from "../time/rational.ts";
import type { MusicAnalysis, MusicEvent, MusicSync } from "../music/schema.ts";
import {
  type AsrWord,
  type CandidateAssessment,
  type Occurrence,
  type OccurrenceState,
  VOCAL_SCHEMA_VERSION,
  type VocalTranscription,
  VocalTranscriptionSchema,
} from "./schema.ts";
import type { RawTranscript, RawWord, WhisperEngine } from "./whisper.ts";

export interface AssistConfig {
  windowBars: number;
  stepBars: number;
  consensusToleranceMs: number;
  refinementWindowMs: number;
  targetWords: string[];
}

export const DEFAULT_ASSIST_CONFIG: AssistConfig = {
  windowBars: 2,
  stepBars: 1,
  consensusToleranceMs: 250,
  refinementWindowMs: 150,
  targetWords: ["hook"],
};

export interface PatternTarget {
  patternId: string | null;
  start: Rational;
  end: Rational;
  matchEventTypes: string[];
}

const ms = (r: Rational) => Math.round(toNumberApprox(r) * 100000) / 100;
const deltaMs = (a: Rational, b: Rational) => ms(sub(a, b));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

/** EXACT: the word itself (or its dropped-g form). NEAR: same stem or within edit distance 2. */
export function matchTarget(normalized: string, target: string): "EXACT" | "NEAR" | null {
  if (!normalized) return null;
  if (normalized === target || (target.endsWith("ing") && normalized === target.slice(0, -1))) return "EXACT";
  if (target.length >= 5 && normalized.startsWith(target.slice(0, 4))) return "NEAR";
  if (normalized.length >= 4 && levenshtein(normalized, target) <= 2) return "NEAR";
  return null;
}

/** Hallucination / artifact flags for the words of one window (in Whisper order). */
export function flagWindowWords(words: RawWord[], windowEnd: Rational): AsrWord["flags"][] {
  const flags = words.map(() => new Set<AsrWord["flags"][number]>());
  const norm = words.map((w) => normalizeWord(w.rawText));
  let depth = 0;
  words.forEach((w, i) => {
    const t = w.rawText;
    const opens = (t.match(/[([]/g) ?? []).length;
    const closes = (t.match(/[)\]]/g) ?? []).length;
    if (depth > 0 || opens > 0 || /[♪*]/.test(t) || norm[i] === "") flags[i]!.add("NON_SPEECH");
    depth = Math.max(0, depth + opens - closes);
  });
  // Runs of the same word: >= 4 consecutive, or >= 3 within 0.5 s.
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j + 1 < words.length && norm[j + 1] === norm[i] && norm[i] !== "") j++;
    const n = j - i + 1;
    const span = toNumberApprox(sub(words[j]!.start, words[i]!.start));
    if (n >= 4 || (n >= 3 && span <= 0.5)) for (let k = i; k <= j; k++) flags[k]!.add("REPETITION_LOOP");
    i = j + 1;
  }
  // Timestamp compression: >= 3 words whose starts fall within 30 ms of each other.
  for (let i = 0; i < words.length; i++) {
    const group = words.filter((w) => Math.abs(deltaMs(w.start, words[i]!.start)) <= 30);
    if (group.length >= 3) flags[i]!.add("TIMESTAMP_COMPRESSED");
    if (compare(words[i]!.start, sub(windowEnd, rational(1, 10))) >= 0) flags[i]!.add("WINDOW_EDGE");
  }
  const order: AsrWord["flags"] = ["NON_SPEECH", "REPETITION_LOOP", "TIMESTAMP_COMPRESSED", "WINDOW_EDGE"];
  return flags.map((f) => order.filter((x) => f.has(x)));
}

function meanRational(xs: Rational[]): Rational {
  return div(xs.reduce((a, b) => add(a, b), rational(0)), rational(xs.length));
}

function nearestBeat(analysis: MusicAnalysis, t: Rational) {
  let best: MusicAnalysis["beats"][number] | null = null;
  let bestD = Infinity;
  for (const b of analysis.beats) {
    const d = Math.abs(deltaMs(t, b.time));
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? { beatId: best.id, barIndex: best.barIndex, beatInBar: best.beatInBar, offsetMs: deltaMs(t, best.time) } : null;
}

function nearestEvent(events: MusicEvent[], t: Rational): MusicEvent | null {
  let best: MusicEvent | null = null;
  for (const e of events) if (!best || Math.abs(deltaMs(e.time, t)) < Math.abs(deltaMs(best.time, t))) best = e;
  return best;
}

/**
 * Bounded, signal-based refinement: the most confident Phase 2 vocal attack within ±window of
 * `raw` (ties -> nearest, then earliest); else the strongest onset in the window; else none.
 */
export function refineSyncTime(
  raw: Rational,
  events: MusicEvent[],
  windowMs: number,
): { event: MusicEvent | null; method: Occurrence["refinementMethod"] } {
  const inWin = events.filter((e) => Math.abs(deltaMs(e.time, raw)) <= windowMs);
  const pick = (xs: MusicEvent[], key: (e: MusicEvent) => number) =>
    [...xs].sort(
      (a, b) => key(b) - key(a) || Math.abs(deltaMs(a.time, raw)) - Math.abs(deltaMs(b.time, raw)) || compare(a.time, b.time),
    )[0] ?? null;
  const vocal = pick(inWin.filter((e) => e.type === "vocal_attack"), (e) => e.confidence);
  if (vocal) return { event: vocal, method: "phase2_vocal_attack" };
  const onset = pick(inWin.filter((e) => e.type === "onset"), (e) => e.strength);
  if (onset) return { event: onset, method: "phase2_onset" };
  return { event: null, method: "none" };
}

export interface BuildInput {
  raw: RawTranscript;
  analysis: MusicAnalysis;
  range: { start: Rational; end: Rational };
  pattern: PatternTarget;
  engine: WhisperEngine;
  config: AssistConfig;
  generatedAt: string;
  /** Phase 2 identity status per candidate (from resolveEvents without the assist), for the record. */
  phase2Status?: Map<string, string>;
}

export function buildVocalTranscription(input: BuildInput): VocalTranscription {
  const { raw, analysis, pattern, config } = input;
  const warnings: VocalTranscription["warnings"] = [];
  const windowById = new Map(raw.windows.map((w) => [w.id, w]));

  // 1. Word events with flags.
  const words: AsrWord[] = [];
  for (const [wi, w] of raw.windows.entries()) {
    const ws = raw.words.filter((x) => x.windowId === w.id);
    const flags = flagWindowWords(ws, w.end);
    ws.forEach((x, k) => {
      const ps = x.tokens.map((t) => t.p);
      words.push({
        id: `asr:${String(wi).padStart(2, "0")}:${String(k).padStart(3, "0")}`,
        windowId: w.id,
        rawText: x.rawText,
        normalized: normalizeWord(x.rawText),
        start: x.start,
        end: x.end,
        asrConfidence: ps.length ? r3(ps.reduce((a, b) => a + b, 0) / ps.length) : 0,
        tokens: x.tokens,
        flags: flags[k]!,
        consensusWindows: 0,
        coveringWindows: 0,
        sourceMethod: "WHISPER",
        state: "UNCONFIRMED",
      });
    });
  }
  if (raw.words.length === 0) warnings.push({ code: "EMPTY_TRANSCRIPT", message: "Whisper returned no words for the analysed range" });

  // 2. Cross-window consensus: distinct windows hearing the same word within the tolerance.
  const clean = words.filter((w) => w.flags.length === 0);
  for (const w of words) {
    const same = clean.filter((o) => o.normalized === w.normalized && Math.abs(deltaMs(o.start, w.start)) <= config.consensusToleranceMs);
    w.consensusWindows = w.flags.length ? 0 : new Set(same.map((o) => o.windowId)).size;
    w.coveringWindows = raw.windows.filter((x) => compare(x.start, w.start) <= 0 && compare(w.start, x.end) < 0).length;
    w.state = w.flags.length ? "REJECTED" : w.consensusWindows >= 2 && w.asrConfidence >= 0.5 ? "HIGH_CONFIDENCE" : "UNCONFIRMED";
  }
  const flagged = words.filter((w) => w.flags.length).length;
  if (flagged) {
    warnings.push({
      code: "ASR_ARTIFACTS_FLAGGED",
      message: `${flagged}/${words.length} Whisper words flagged (non-speech tags, repetition loops, compressed timestamps or window edges) and excluded from identity evidence`,
    });
  }

  // 3. Target-word occurrences.
  const vocalEvents = analysis.events.filter((e) => e.type === "vocal_attack" || e.type === "onset");
  const vocalAttacks = analysis.events.filter((e) => e.type === "vocal_attack");
  const onsets = analysis.events.filter((e) => e.type === "onset");
  const occurrences: Occurrence[] = [];
  for (const target of config.targetWords.map(normalizeWord)) {
    const hits = words
      .map((w) => ({ w, kind: matchTarget(w.normalized, target) }))
      .filter((h): h is { w: AsrWord; kind: "EXACT" | "NEAR" } => h.kind !== null && !h.w.flags.includes("NON_SPEECH"))
      .sort((a, b) => compare(a.w.start, b.w.start) || a.w.id.localeCompare(b.w.id));
    const groups: Array<typeof hits> = [];
    for (const h of hits) {
      const g = groups.at(-1);
      if (g && Math.abs(deltaMs(h.w.start, g[0]!.w.start)) <= config.consensusToleranceMs) {
        g.push(h);
      } else groups.push([h]);
    }
    for (const g of groups) {
      const good = g.filter((h) => h.w.flags.length === 0);
      const basis = good.length ? good : g;
      const rawStart = meanRational(basis.map((h) => h.w.start));
      const rawEnd = meanRational(basis.map((h) => h.w.end));
      const asrConf = r3(basis.reduce((a, h) => a + h.w.asrConfidence, 0) / basis.length);
      const consensus = new Set(good.map((h) => h.w.windowId)).size;
      const exact = basis.some((h) => h.kind === "EXACT");
      const np = nearestEvent(vocalAttacks, rawStart);
      const no = nearestEvent(onsets, rawStart);
      const ref = refineSyncTime(rawStart, vocalEvents, config.refinementWindowMs);
      const syncTime = ref.event?.time ?? null;
      const refDelta = ref.event ? deltaMs(ref.event.time, rawStart) : null;
      const asrPart = Math.min(1, asrConf) * (consensus >= 2 ? 1 : 0.7);
      const refinedConfidence = ref.event
        ? r3(0.4 * asrPart + 0.4 * ref.event.confidence + 0.2 * (1 - Math.abs(refDelta!) / config.refinementWindowMs))
        : r3(0.3 * asrPart);
      let state: OccurrenceState;
      let reason: string;
      const heard = [...new Set(basis.map((h) => h.w.normalized))].join("/");
      if (!good.length) {
        state = g.every((h) => h.w.flags.includes("REPETITION_LOOP")) ? "REJECTED" : "NEEDS_HUMAN_CONFIRMATION";
        reason = `only heard in flagged ASR output (${[...new Set(g.flatMap((h) => h.w.flags))].join(", ")})`;
      } else if (!exact) {
        state = "NEEDS_HUMAN_CONFIRMATION";
        reason = `ASR heard "${heard}", not "${target}"`;
      } else if (ref.method === "phase2_vocal_attack" && consensus >= 2 && asrConf >= 0.5) {
        state = "CONFIRMED_BY_SIGNAL";
        reason = `"${target}" heard in ${consensus} overlapping windows (mean p ${asrConf}); Phase 2 vocal attack ${ref.event!.id} ${refDelta} ms from the Whisper start`;
      } else if (ref.event && (consensus >= 2 || asrConf >= 0.6)) {
        state = "HIGH_CONFIDENCE_CANDIDATE";
        reason = `"${target}" heard in ${consensus} window(s) (mean p ${asrConf}); refined to ${ref.method.replace("phase2_", "Phase 2 ")} ${ref.event.id}`;
      } else {
        state = "NEEDS_HUMAN_CONFIRMATION";
        reason = ref.event
          ? `"${target}" heard in a single window with p ${asrConf}`
          : `no Phase 2 vocal attack or onset within ±${config.refinementWindowMs} ms of the Whisper start; raw time only`;
      }
      const centis = Math.round(toNumberApprox(rawStart) * 100);
      occurrences.push({
        id: `occ:${target.replace(/[^a-z]/g, "")}:${String(centis).padStart(5, "0")}`,
        target,
        matchKind: exact ? "EXACT" : "NEAR",
        hearingWordIds: g.map((h) => h.w.id),
        asrWords: g.map((h) => h.w.rawText.trim()),
        rawWhisperStart: rawStart,
        rawWhisperEnd: rawEnd,
        asrConfidence: asrConf,
        consensusWindows: consensus,
        nearestPhase2Candidate: np ? { eventId: np.id, deltaMs: deltaMs(np.time, rawStart), confidence: np.confidence } : null,
        nearestOnset: no ? { eventId: no.id, strength: no.strength, deltaMs: deltaMs(no.time, rawStart) } : null,
        refinedSyncTime: syncTime,
        refinedFromEventId: ref.event?.id ?? null,
        refinementDeltaMs: refDelta,
        refinementMethod: ref.method,
        beat: nearestBeat(analysis, syncTime ?? rawStart),
        refinedConfidence,
        state,
        reason,
      });
    }
  }
  const occIds = occurrences.map((o) => o.id);
  const dup = occIds.find((id, i) => occIds.indexOf(id) !== i);
  if (dup) throw new Error(`occurrence id collision ${dup}`);

  // 4. Assess every Phase 2 pattern candidate against the ASR evidence.
  const candidates = analysis.events.filter(
    (e) => pattern.matchEventTypes.includes(e.type) && compare(e.time, pattern.start) >= 0 && compare(e.time, pattern.end) < 0,
  );
  const tol = config.refinementWindowMs;
  // Reviewer hint only (never changes a state): same Phase 2 repetition cluster as a signal-confirmed occurrence.
  const confirmedClusters = new Map<string, string>();
  for (const o of occurrences) {
    const ev = o.state === "CONFIRMED_BY_SIGNAL" ? analysis.events.find((x) => x.id === o.refinedFromEventId) : undefined;
    if (ev?.vocal?.clusterId) confirmedClusters.set(ev.vocal.clusterId, o.id);
  }
  const clusterNote = (e: MusicEvent) => {
    const c = e.vocal?.clusterId;
    return c && confirmedClusters.has(c) ? `; note: shares Phase 2 repetition cluster ${c} with ${confirmedClusters.get(c)} (review by ear)` : "";
  };
  const candidateAssessments: CandidateAssessment[] = candidates.map((e) => {
    const base = { eventId: e.id, time: e.time, phase2Status: input.phase2Status?.get(e.id) ?? null, occurrenceId: null as string | null };
    const covering = clean.filter(
      (w) => deltaMs(e.time, w.start) >= -tol && compare(e.time, w.end) < 0 && compare(e.time, windowById.get(w.windowId)!.end) < 0,
    );
    const overlappingWords = [...new Set(covering.map((w) => w.id))];
    const own = occurrences.find((o) => o.refinedFromEventId === e.id);
    if (own) return { ...base, occurrenceId: own.id, overlappingWords, state: own.state, reason: `refinement target of ${own.id}: ${own.reason}` };
    const inside = occurrences.find(
      (o) => o.matchKind === "EXACT" && o.state !== "REJECTED" && deltaMs(e.time, o.rawWhisperStart) >= -tol && compare(e.time, o.rawWhisperEnd) < 0,
    );
    if (inside && inside.refinedSyncTime && compare(e.time, inside.refinedSyncTime) > 0) {
      return { ...base, occurrenceId: inside.id, overlappingWords, state: "REJECTED", reason: `later attack inside the "${inside.target}" word span of ${inside.id} (sync point is ${inside.refinedFromEventId})` };
    }
    if (inside) {
      return { ...base, occurrenceId: inside.id, overlappingWords, state: "NEEDS_HUMAN_CONFIRMATION", reason: `inside the "${inside.target}" span of ${inside.id} but not its signal sync point` };
    }
    // The word most likely beginning at this attack: the covering word whose start is nearest.
    const word = [...covering].sort((a, b) => Math.abs(deltaMs(e.time, a.start)) - Math.abs(deltaMs(e.time, b.start)) || a.id.localeCompare(b.id))[0];
    if (!word) {
      return { ...base, overlappingWords, state: "NEEDS_HUMAN_CONFIRMATION", reason: `no intelligible lyric heard by ASR here (non-speech or silence); identity unverified${clusterNote(e)}` };
    }
    const isTarget = covering.some((w) => config.targetWords.some((t) => matchTarget(w.normalized, normalizeWord(t))));
    // Per window, the word most likely beginning at this attack; windows must agree on it.
    const perWindow = new Map<string, AsrWord>();
    for (const w of covering) {
      const cur = perWindow.get(w.windowId);
      if (!cur || Math.abs(deltaMs(e.time, w.start)) < Math.abs(deltaMs(e.time, cur.start))) perWindow.set(w.windowId, w);
    }
    const agreeing = [...perWindow.values()].filter((w) => w.normalized === word.normalized).length;
    // Rejection needs a confidently heard non-target word (>= 2 windows, p >= 0.5) that >= 2 windows
    // agree begins at this attack, and no target-word hearing overlapping it at all.
    if (word.state === "HIGH_CONFIDENCE" && agreeing >= 2 && !isTarget) {
      return { ...base, overlappingWords, state: "REJECTED", reason: `ASR hears "${word.normalized}" starting here in ${agreeing} windows (p ${word.asrConfidence}), not a target word` };
    }
    if (perWindow.size >= 2 && agreeing < 2) {
      const heard = [...perWindow.values()].map((w) => `${w.windowId}: "${w.normalized}"`).join(", ");
      return { ...base, overlappingWords, state: "NEEDS_HUMAN_CONFIRMATION", reason: `windows disagree on the word here (${heard}); identity unverified${clusterNote(e)}` };
    }
    return {
      ...base,
      overlappingWords,
      state: "NEEDS_HUMAN_CONFIRMATION",
      reason: `ASR hears "${word.normalized}" here (${word.consensusWindows} window(s), p ${word.asrConfidence}); identity unverified${clusterNote(e)}`,
    };
  });

  const segments = raw.windows.flatMap((w) => {
    const ws = words.filter((x) => x.windowId === w.id);
    return ws.length
      ? [{ windowId: w.id, text: ws.map((x) => x.rawText).join("").trim(), start: ws[0]!.start, end: ws.at(-1)!.end }]
      : [];
  });
  const normalizedText = segments.map((s) => `[${s.windowId}] ${normalizeWord(s.text)}`).join("\n");

  return VocalTranscriptionSchema.parse({
    schemaVersion: VOCAL_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    sourceMediaId: analysis.source.mediaId,
    sourceFingerprint: analysis.source.fingerprint,
    analyzedRange: input.range,
    targetWindow: { start: pattern.start, end: pattern.end },
    patternId: pattern.patternId,
    phase2: { analyzerVersion: analysis.analyzer.version, configHash: analysis.analyzer.configHash },
    engine: {
      name: "whisper.cpp",
      version: input.engine.version,
      commit: input.engine.commit,
      binary: input.engine.binary,
      networkSandbox: true,
      args: raw.engineArgs,
    },
    model: { name: input.engine.modelName, file: input.engine.model, sizeBytes: input.engine.modelSizeBytes, sha256: input.engine.modelSha256 },
    language: "en",
    config: {
      windowBars: config.windowBars,
      stepBars: config.stepBars,
      sampleRate: 16000,
      consensusToleranceMs: config.consensusToleranceMs,
      refinementWindowMs: config.refinementWindowMs,
      targetWords: config.targetWords,
    },
    cacheKey: raw.cacheKey,
    windows: raw.windows,
    segments,
    words,
    normalizedText,
    occurrences,
    candidateAssessments,
    warnings,
  });
}

/** Human word-level decisions from music-sync.json overrides that target `asr:` word ids. */
export function applyWordOverrides(vt: VocalTranscription, sync: MusicSync | null): VocalTranscription {
  if (!sync) return vt;
  const words = vt.words.map((w) => {
    const o = sync.eventOverrides.filter((x) => x.targetEventId === w.id).at(-1);
    if (!o) return w;
    if (o.action === "confirm") return { ...w, state: "HUMAN_CONFIRMED" as const };
    if (o.action === "exclude") return { ...w, state: "REJECTED" as const };
    return w;
  });
  return { ...vt, words };
}

/** Everything except generatedAt (for determinism checks). */
export function deterministicVocalView(vt: VocalTranscription): string {
  return JSON.stringify({ ...vt, generatedAt: "<generatedAt>" });
}
