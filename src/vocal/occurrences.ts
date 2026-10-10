/**
 * Human ground-truth vocal occurrences (Phase 2.5C).
 *
 * The user declares WHERE each occurrence of a word is (a coarse window, e.g. 1:21–1:22) and, for an
 * exhaustive set, that there are no others. This module picks the PRIMARY attack inside each window
 * from signal evidence and groups delay/reverb/chop repeats with it, so an echo is never counted as
 * another word.
 *
 *  - Reference: a confirmed attack of the same word (user-named event, e.g. a confirmed onset at 1:27.230).
 *  - Similarity: Phase 2's own vocal feature (harmonic-masked vocal-band patch, 250 ms, pitch-tolerant
 *    cosine), computed from the audio.
 *  - Primary: the window's attack most similar to the reference. Causal grouping: when an EARLIER
 *    attack is near-equally similar to the reference and the two are mutual copies, the earlier one
 *    is the source (echoes follow their source, never precede it). A remaining near-tie is broken
 *    only by bar position (the reference's slot in its bar); otherwise the result is AMBIGUOUS.
 *  - Effect repeats: later attacks within a bounded search range that are copies of the primary.
 *    No delay time is assumed; each repeat's measured delay is reported, and so is its consistency
 *    with the other occurrences' repeats.
 *  - Whisper is supporting evidence only: it can raise confidence and never removes an occurrence.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";
import { FRAME_SIZE, HOP, SAMPLE_RATE, VOCAL_BINS, computeFeatures } from "../music/features.ts";
import type { MusicAnalysis, MusicEvent } from "../music/schema.ts";
import { harmonicSpectrogram, maskedSpectrogram, patch, shiftedSimilarity } from "../music/vocals.ts";
import { type Rational, compare, sub, toNumberApprox } from "../time/rational.ts";
import { matchTarget, normalizeWord } from "./assist.ts";
import type { VocalTranscription } from "./schema.ts";

export const OCCURRENCES_SCHEMA_VERSION = "1.0.0";

export const EffectCharacterSchema = z.enum(["DRY", "LIGHT_REVERB", "DELAYED", "CHOPPED", "REVERB_DELAY_CHOP", "UNKNOWN"]);
const Conf = z.enum(["HIGH", "MEDIUM", "LOW"]);
const AttackRef = z
  .object({
    eventId: z.string(),
    time: RationalSchema,
    clusterId: z.string().nullable(),
    strength: z.number(),
    phase2Confidence: z.number(),
    similarityToReference: z.number(),
    levelDb: z.number(),
    bar: z.object({ barIndex: z.number().int(), offsetInBarMs: z.number(), referenceSlotDeltaMs: z.number() }).strict().nullable(),
  })
  .strict();

export const HumanOccurrenceSchema = z
  .object({
    occurrenceId: z.string(),
    humanWindow: z.object({ start: RationalSchema, end: RationalSchema }).strict(),
    status: z.enum(["RESOLVED", "AMBIGUOUS", "NO_CANDIDATE"]),
    primaryAttack: AttackRef.nullable(),
    /** Only for AMBIGUOUS: the two plausible primaries. */
    ambiguousCandidates: z.array(AttackRef),
    effectRepeats: z.array(
      z
        .object({ eventId: z.string(), time: RationalSchema, delayMs: z.number(), levelDbRelative: z.number(), similarityToPrimary: z.number(), intervalConsistent: z.boolean() })
        .strict(),
    ),
    effectCharacter: EffectCharacterSchema,
    effectConfidence: z.number().min(0).max(1),
    effectEvidence: z.string(),
    candidatesConsidered: z.array(
      z
        .object({
          eventId: z.string(),
          time: RationalSchema,
          similarityToReference: z.number(),
          role: z.enum(["primary", "effect_repeat", "ambiguous_primary", "other"]),
        })
        .strict(),
    ),
    whisperEvidence: z.array(z.object({ model: z.string(), heard: z.string(), rawStart: RationalSchema, deltaToPrimaryMs: z.number().nullable(), target: z.boolean() }).strict()),
    /** Exact sync target (the primary attack time) or null when AMBIGUOUS / NO_CANDIDATE. */
    syncTarget: RationalSchema.nullable(),
    confidence: Conf,
    reasoning: z.string(),
  })
  .strict();

export const VocalOccurrencesSchema = z
  .object({
    schemaVersion: z.literal(OCCURRENCES_SCHEMA_VERSION),
    sourceMediaId: z.string(),
    patternId: z.string(),
    label: z.string(),
    exhaustive: z.boolean(),
    phase2: z.object({ analyzerVersion: z.string(), configHash: z.string() }).strict(),
    reference: z.object({ eventId: z.string(), time: RationalSchema, source: z.enum(["user"]) }).strict(),
    method: z
      .object({
        similarity: z.string(),
        tieMargin: z.number(),
        repeatSimilarityMin: z.number(),
        repeatSearchMs: z.number(),
        repeatMaxLevelDb: z.number(),
        slotToleranceMs: z.number(),
        highSimilarity: z.number(),
      })
      .strict(),
    measuredRepeatDelayMs: z.object({ values: z.array(z.number()), median: z.number().nullable() }).strict(),
    occurrences: z.array(HumanOccurrenceSchema),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();

export type HumanOccurrence = z.infer<typeof HumanOccurrenceSchema>;
export type VocalOccurrences = z.infer<typeof VocalOccurrencesSchema>;
export type EffectCharacter = z.infer<typeof EffectCharacterSchema>;

export interface OccurrenceConfig {
  tieMargin: number;
  repeatSimilarityMin: number;
  repeatSearchMs: number;
  repeatMaxLevelDb: number;
  slotToleranceMs: number;
  highSimilarity: number;
}

export const DEFAULT_OCCURRENCE_CONFIG: OccurrenceConfig = {
  tieMargin: 0.02, // similarities closer than this are a tie
  repeatSimilarityMin: 0.8, // a repeat must be a near-copy of its primary (an unrelated neighbouring word measured ≈ 0.62)
  repeatSearchMs: 750, // bounded search after the primary (a search limit, not a delay time)
  repeatMaxLevelDb: 3, // a repeat may not be much louder than its source
  slotToleranceMs: 60, // bar-position tie-break tolerance
  highSimilarity: 0.8,
};

/** Acoustic access to Phase 2 vocal attacks: similarity (Phase 2 patch feature) and formant level. */
export interface VocalFeatureProvider {
  similarity(a: MusicEvent, b: MusicEvent): number;
  levelDb(e: MusicEvent): number;
}

/**
 * Computes Phase 2's vocal patch for the given attacks from a frame-aligned audio slice (the slice
 * starts on a multiple of the analysis hop, so frames coincide with the full-track analysis).
 */
export function vocalFeatureProvider(samples: Float32Array, events: MusicEvent[]): VocalFeatureProvider {
  if (events.length === 0) return { similarity: () => 0, levelDb: () => -120 };
  const first = Math.min(...events.map((e) => e.sample));
  const last = Math.max(...events.map((e) => e.sample));
  const startFrame = Math.max(0, Math.floor(first / HOP) - 300);
  const s0 = startFrame * HOP;
  const s1 = Math.min(samples.length, last + 3 * SAMPLE_RATE);
  const f = computeFeatures(samples.subarray(s0, s1));
  const mk = maskedSpectrogram(f, harmonicSpectrogram(f).h);
  const bins = Math.floor(VOCAL_BINS / 4);
  const lo = Math.round((450 * FRAME_SIZE) / SAMPLE_RATE) - Math.round((150 * FRAME_SIZE) / SAMPLE_RATE);
  const hi = Math.round((1800 * FRAME_SIZE) / SAMPLE_RATE) - Math.round((150 * FRAME_SIZE) / SAMPLE_RATE);
  const frameOf = (e: MusicEvent) => Math.floor(e.sample / HOP) - startFrame;
  const patches = new Map<string, Float64Array>();
  const p = (e: MusicEvent) => {
    let v = patches.get(e.id);
    if (!v) patches.set(e.id, (v = patch(mk, frameOf(e), f.frames)));
    return v;
  };
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    similarity: (a, b) => (a.id === b.id ? 1 : r3(shiftedSimilarity(p(a), p(b), bins))),
    levelDb: (e) => {
      let best = -120;
      for (let k = frameOf(e); k < Math.min(f.frames, frameOf(e) + 10); k++) {
        let s = 0;
        for (let b = lo; b < hi; b++) s += mk[k * VOCAL_BINS + b]! ** 2;
        best = Math.max(best, 10 * Math.log10(s + 1e-12));
      }
      return Math.round(best * 100) / 100;
    },
  };
}

export interface OccurrenceWindowInput {
  occurrenceId: string;
  start: Rational;
  end: Rational;
}

export interface ResolveOccurrencesInput {
  analysis: MusicAnalysis;
  patternId: string;
  label: string;
  exhaustive: boolean;
  referenceEventId: string;
  windows: OccurrenceWindowInput[];
  features: VocalFeatureProvider;
  /** Optional ASR evidence (any number of models); never required. */
  transcriptions?: VocalTranscription[];
  targetWord: string;
  config?: OccurrenceConfig;
}

const ms = (r: Rational) => toNumberApprox(r) * 1000;
const round2 = (x: number) => Math.round(x * 100) / 100;

function barSlot(analysis: MusicAnalysis, t: Rational) {
  let bar: MusicAnalysis["bars"][number] | null = null;
  for (const b of analysis.bars) {
    if (compare(b.time, t) <= 0) bar = b;
    else break;
  }
  return bar ? { barIndex: bar.index, offsetInBarMs: round2(ms(sub(t, bar.time))) } : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

export function resolveHumanOccurrences(input: ResolveOccurrencesInput): VocalOccurrences {
  const cfg = input.config ?? DEFAULT_OCCURRENCE_CONFIG;
  const { analysis, features } = input;
  const warnings: VocalOccurrences["warnings"] = [];
  const attacks = analysis.events.filter((e) => e.type === "vocal_attack");
  const ref = attacks.find((e) => e.id === input.referenceEventId);
  if (!ref) throw new Error(`reference event ${input.referenceEventId} is not a Phase 2 vocal attack`);
  const refSlot = barSlot(analysis, ref.time);
  const simRef = (e: MusicEvent) => features.similarity(e, ref);
  const attackRef = (e: MusicEvent) => {
    const slot = barSlot(analysis, e.time);
    return {
      eventId: e.id,
      time: e.time,
      clusterId: e.vocal?.clusterId ?? null,
      strength: e.strength,
      phase2Confidence: e.confidence,
      similarityToReference: simRef(e),
      levelDb: features.levelDb(e),
      bar: slot && refSlot ? { ...slot, referenceSlotDeltaMs: round2(slot.offsetInBarMs - refSlot.offsetInBarMs) } : null,
    };
  };
  const inSlot = (e: MusicEvent) => {
    const s = attackRef(e).bar;
    return s !== null && Math.abs(s.referenceSlotDeltaMs) <= cfg.slotToleranceMs;
  };
  const isCopy = (a: MusicEvent, b: MusicEvent) => features.similarity(a, b) >= cfg.repeatSimilarityMin;

  // Pass 1: primaries and raw repeats per window.
  const drafts = input.windows.map((w) => {
    const cands = attacks.filter((e) => compare(e.time, w.start) >= 0 && compare(e.time, w.end) < 0);
    const ranked = [...cands].sort((a, b) => simRef(b) - simRef(a) || compare(a.time, b.time));
    let primary: MusicEvent | null = ranked[0] ?? null;
    let how = "most similar to the reference";
    let ambiguous: MusicEvent[] = [];
    if (primary) {
      // Causal grouping: an earlier near-equal attack that the best one copies is the source.
      const source = cands
        .filter((e) => compare(e.time, primary!.time) < 0 && ms(sub(primary!.time, e.time)) <= cfg.repeatSearchMs)
        .filter((e) => simRef(e) >= simRef(primary!) - cfg.tieMargin && isCopy(e, primary!))
        .sort((a, b) => compare(a.time, b.time))[0];
      if (source) {
        how = `earlier near-equal attack ${source.id} is the source of ${primary.id} (echoes follow their source)`;
        primary = source;
      }
      const isOwnRepeat = (e: MusicEvent) => compare(e.time, primary!.time) > 0 && ms(sub(e.time, primary!.time)) <= cfg.repeatSearchMs && isCopy(primary!, e);
      const echoTie = ranked.find((e) => e !== primary && isOwnRepeat(e) && simRef(e) >= simRef(primary!) - cfg.tieMargin);
      if (echoTie) how += `; the near-equal later attack ${echoTie.id} is a copy of it and is grouped as its effect repeat (echoes follow their source)`;
      const rivals = ranked.filter((e) => e !== primary && !isOwnRepeat(e) && simRef(e) >= simRef(primary!) - cfg.tieMargin);
      if (rivals.length) {
        const rival = rivals[0]!;
        const pIn = inSlot(primary);
        const rIn = inSlot(rival);
        if (pIn !== rIn) {
          if (rIn) primary = rival;
          how += `; near-tie with ${pIn ? rival.id : primary.id} broken by bar position (reference slot)`;
        } else {
          ambiguous = [primary, rival].sort((a, b) => compare(a.time, b.time));
        }
      }
    }
    const repeats = primary && !ambiguous.length
      ? cands
          .concat(attacks.filter((e) => compare(e.time, w.end) >= 0))
          .filter((e) => compare(e.time, primary!.time) > 0 && ms(sub(e.time, primary!.time)) <= cfg.repeatSearchMs)
          .filter((e) => isCopy(primary!, e) && features.levelDb(e) - features.levelDb(primary!) <= cfg.repeatMaxLevelDb)
          .sort((a, b) => compare(a.time, b.time))
      : [];
    return { w, cands, primary: ambiguous.length ? null : primary, ambiguous, how, repeats: [...new Set(repeats)] };
  });

  // Measured repeat delays (first repeat of each occurrence) and their consistency.
  const firstDelays = drafts.flatMap((d) => (d.primary && d.repeats[0] ? [round2(ms(sub(d.repeats[0].time, d.primary.time)))] : []));
  const med = median(firstDelays);

  const occurrences: HumanOccurrence[] = drafts.map((d) => {
    const { w, primary } = d;
    const whisperEvidence = (input.transcriptions ?? []).flatMap((vt) =>
      vt.words
        .filter((x) => x.flags.length === 0 && compare(x.start, w.start) >= 0 && compare(x.start, w.end) < 0)
        .map((x) => ({
          model: vt.model.name,
          heard: x.rawText.trim(),
          rawStart: x.start,
          deltaToPrimaryMs: primary ? round2(ms(sub(x.start, primary.time))) : null,
          target: matchTarget(x.normalized, normalizeWord(input.targetWord)) !== null,
        })),
    );
    const heardTarget = whisperEvidence.some((x) => x.target);
    const roles = new Map<string, "primary" | "effect_repeat" | "ambiguous_primary" | "other">();
    for (const c of d.cands) roles.set(c.id, "other");
    if (primary) roles.set(primary.id, "primary");
    for (const r of d.repeats) roles.set(r.id, "effect_repeat");
    for (const a of d.ambiguous) roles.set(a.id, "ambiguous_primary");
    const candidatesConsidered = d.cands.map((c) => ({ eventId: c.id, time: c.time, similarityToReference: simRef(c), role: roles.get(c.id)! }));

    if (!primary) {
      const status = d.ambiguous.length ? "AMBIGUOUS" : "NO_CANDIDATE";
      if (status === "NO_CANDIDATE") warnings.push({ code: "OCCURRENCE_NO_CANDIDATE", message: `${d.w.occurrenceId}: no Phase 2 vocal attack inside the human window; add a retime override` });
      return {
        occurrenceId: w.occurrenceId,
        humanWindow: { start: w.start, end: w.end },
        status,
        primaryAttack: null,
        ambiguousCandidates: d.ambiguous.map(attackRef),
        effectRepeats: [],
        effectCharacter: "UNKNOWN",
        effectConfidence: 0,
        effectEvidence: "no primary selected",
        candidatesConsidered,
        whisperEvidence,
        syncTarget: null,
        confidence: "LOW",
        reasoning: status === "AMBIGUOUS"
          ? `two attacks are equally similar to the reference (Δ < ${cfg.tieMargin}), are not copies of each other, and bar position does not separate them; human choice needed`
          : "no candidate attack in the window",
      };
    }

    const pLevel = features.levelDb(primary);
    const effectRepeats = d.repeats.map((r) => {
      const delay = round2(ms(sub(r.time, primary.time)));
      const others = firstDelays.filter((x) => x !== delay);
      const ref2 = median(others);
      return {
        eventId: r.id,
        time: r.time,
        delayMs: delay,
        levelDbRelative: round2(features.levelDb(r) - pLevel),
        similarityToPrimary: features.similarity(primary, r),
        // consistent with the other occurrences' first repeats (or a multiple of it: a 2nd tap)
        intervalConsistent: ref2 !== null && [1, 2, 3].some((k) => Math.abs(delay - k * ref2) <= 40),
      };
    });

    // Descriptive effect character (not an effects-analysis subsystem).
    const sharpness = primary.strength / Math.max(1e-6, ref.strength);
    const first = effectRepeats[0];
    let effectCharacter: EffectCharacter;
    const ev: string[] = [`attack sharpness ${round2(sharpness)}× the reference`];
    if (!first) effectCharacter = primary.id === ref.id || sharpness >= 0.8 ? "DRY" : "LIGHT_REVERB";
    else if (first.levelDbRelative <= -1) effectCharacter = "DELAYED";
    else effectCharacter = sharpness < 0.6 ? "REVERB_DELAY_CHOP" : "CHOPPED";
    if (first) ev.push(`copy (similarity ${first.similarityToPrimary}) ${first.delayMs} ms later at ${first.levelDbRelative >= 0 ? "+" : ""}${first.levelDbRelative} dB${first.levelDbRelative > -1 ? " (not decaying: re-triggered chop)" : " (decaying: delay)"}`);
    else ev.push("no copy of the attack follows");
    let effectConfidence = 0.4;
    if (first) effectConfidence += first.similarityToPrimary >= 0.8 ? 0.2 : 0;
    if (first?.intervalConsistent) effectConfidence += 0.2;
    if (!first && primary.id === ref.id) effectConfidence = 0.7;
    if (sharpness < 0.6 || sharpness >= 0.8) effectConfidence += 0.1;
    effectConfidence = Math.min(0.9, round2(effectConfidence));

    const s = simRef(primary);
    const slotOk = inSlot(primary);
    let confidence: "HIGH" | "MEDIUM" | "LOW" =
      primary.id === ref.id ? "HIGH" : s >= cfg.highSimilarity && (slotOk || heardTarget) && !/near-tie|near-equal/.test(d.how) ? "HIGH" : s >= 0.7 ? "MEDIUM" : "LOW";
    if (confidence === "LOW" && heardTarget) confidence = "MEDIUM"; // Whisper may raise, never lower
    const slot = attackRef(primary).bar;
    const reasoning = [
      primary.id === ref.id ? "the confirmed reference attack itself" : `${d.how} (similarity ${s})`,
      slot ? `bar ${slot.barIndex} at ${slot.offsetInBarMs} ms (reference slot ${slot.referenceSlotDeltaMs >= 0 ? "+" : ""}${slot.referenceSlotDeltaMs} ms)` : "",
      effectRepeats.length ? `${effectRepeats.length} effect repeat(s) grouped` : "no effect repeats",
      heardTarget ? "Whisper heard the word here" : "Whisper did not hear the word here (does not affect existence)",
    ]
      .filter(Boolean)
      .join("; ");
    return {
      occurrenceId: w.occurrenceId,
      humanWindow: { start: w.start, end: w.end },
      status: "RESOLVED",
      primaryAttack: attackRef(primary),
      ambiguousCandidates: [],
      effectRepeats,
      effectCharacter,
      effectConfidence,
      effectEvidence: ev.join("; "),
      candidatesConsidered,
      whisperEvidence,
      syncTarget: primary.time,
      confidence,
      reasoning,
    };
  });

  // An attack may be the primary of only one occurrence.
  const prim = occurrences.flatMap((o) => (o.primaryAttack ? [o.primaryAttack.eventId] : []));
  const dup = prim.find((id, i) => prim.indexOf(id) !== i);
  if (dup) throw new Error(`attack ${dup} selected as the primary of two occurrences`);

  return VocalOccurrencesSchema.parse({
    schemaVersion: OCCURRENCES_SCHEMA_VERSION,
    sourceMediaId: analysis.source.mediaId,
    patternId: input.patternId,
    label: input.label,
    exhaustive: input.exhaustive,
    phase2: { analyzerVersion: analysis.analyzer.version, configHash: analysis.analyzer.configHash },
    reference: { eventId: ref.id, time: ref.time, source: "user" },
    method: {
      similarity: "Phase 2 harmonic-masked vocal-band patch (250 ms), pitch-tolerant cosine",
      ...cfg,
    },
    measuredRepeatDelayMs: { values: firstDelays, median: med },
    occurrences,
    warnings,
  });
}
