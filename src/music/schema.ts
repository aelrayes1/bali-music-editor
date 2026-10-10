/**
 * Music Intelligence contracts (Phase 2).
 *
 *  - music-analysis.json          detected facts (never edited by hand)
 *  - music-sync.json              user-authored required events, patterns and overrides
 *  - music-events.resolved.json   the merged view the Edit Planner consumes, with provenance
 *
 * All times are exact rationals (Phase 1 primitives). `sample` fields are the nearest 44.1 kHz
 * sample, for display and refinement only; `time` is canonical.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

export const MUSIC_SCHEMA_VERSION = "1.0.0";
/**
 * Resolved view versions: 1.0.0 = Phase 2 (no vocal assist; emitted unchanged when the assist is
 * absent/disabled), 1.1.0 = Phase 2.5 vocal assist applied (adds `vocalAssist`/`resolutionReason`).
 */
export const RESOLVED_SCHEMA_VERSION = "1.1.0";
/** 1.2.0 = human ground-truth occurrences applied (adds `occurrence` on events and `groundTruth`). */
export const RESOLVED_GT_SCHEMA_VERSION = "1.2.0";

const Id = z.string().regex(/^[a-z_]+:[0-9a-z._-]+$/);
const Conf = z.number().min(0).max(1);

export const MusicEventTypeSchema = z.enum(["onset", "vocal_attack", "impact", "drop"]);

export const MusicEventSchema = z
  .object({
    id: Id,
    type: MusicEventTypeSchema,
    time: RationalSchema,
    sample: z.number().int().nonnegative(),
    strength: z.number(),
    confidence: Conf,
    method: z.string(),
    detail: z.string().nullable(),
    nearestBeatId: Id.nullable(),
    /** Event time minus nearest beat time, in milliseconds (diagnostic). */
    beatOffsetMs: z.number().nullable(),
    barIndex: z.number().int().nullable(),
    beatInBar: z.number().int().nullable(),
    vocal: z
      .object({ harmonicity: z.number(), activityDb: z.number(), clusterId: Id.nullable(), clusterSimilarity: z.number().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

export const BeatSchema = z
  .object({
    id: Id,
    index: z.number().int().nonnegative(),
    time: RationalSchema,
    sample: z.number().int().nonnegative(),
    isDownbeat: z.boolean(),
    /** -1 for pickup beats before the first downbeat. */
    barIndex: z.number().int(),
    beatInBar: z.number().int().positive(),
    supported: z.boolean(),
    onsetOffsetMs: z.number().nullable(),
    kickAccent: z.number(),
    /** Sub-band pulse (dB); >= 4 means a kick is present on this beat. */
    kickPulseDb: z.number(),
  })
  .strict();

export const BarSchema = z
  .object({
    id: Id,
    index: z.number().int().nonnegative(),
    time: RationalSchema,
    sample: z.number().int().nonnegative(),
    startBeatId: Id,
    energyDb: z.number(),
    lowDb: z.number(),
    change: z.number(),
    energyLevel: z.enum(["low", "medium", "high"]),
    trend: z.enum(["rising", "falling", "steady"]),
  })
  .strict();

export const PhraseSchema = z
  .object({
    id: Id,
    index: z.number().int().nonnegative(),
    time: RationalSchema,
    sample: z.number().int().nonnegative(),
    startBarId: Id,
    lengthBars: z.number().int().positive(),
    change: z.number(),
    confidence: Conf,
    method: z.string(),
  })
  .strict();

export const SectionSchema = z
  .object({
    id: Id,
    index: z.number().int().nonnegative(),
    start: RationalSchema,
    end: RationalSchema,
    startBeatId: Id,
    label: z.enum(["intro", "groove", "break", "build", "drop", "outro", "unknown"]),
    energyLevel: z.enum(["low", "medium", "high"]),
    trend: z.enum(["rising", "falling", "steady"]),
    meanEnergyDb: z.number(),
    meanLowDb: z.number(),
    confidence: Conf,
    evidence: z.string(),
  })
  .strict();

export const RegionSchema = z
  .object({
    id: Id,
    type: z.enum(["silence", "break", "build", "fill", "vocal_activity"]),
    start: RationalSchema,
    end: RationalSchema,
    startSample: z.number().int().nonnegative(),
    endSample: z.number().int().nonnegative(),
    confidence: Conf,
    method: z.string(),
    detail: z.string(),
  })
  .strict();

export const WarningSchema = z.object({ code: z.string(), message: z.string() }).strict();

export const MusicAnalysisSchema = z
  .object({
    schemaVersion: z.literal(MUSIC_SCHEMA_VERSION),
    generatedAt: z.string(),
    analyzer: z
      .object({
        name: z.literal("bali-music-intelligence"),
        version: z.string(),
        configHash: z.string().regex(/^[0-9a-f]{16}$/),
        config: z.record(z.string(), z.unknown()),
        sampleRate: z.number().int(),
        frameSamples: z.number().int(),
        hopSamples: z.number().int(),
        ffmpeg: z.object({ path: z.string(), version: z.string() }).strict(),
      })
      .strict(),
    source: z
      .object({
        mediaId: z.string(),
        fingerprint: z.string(),
        audioStreamIndex: z.number().int(),
        fileName: z.string(),
      })
      .strict(),
    durationSeconds: RationalSchema,
    tempo: z
      .object({
        canonicalBpm: RationalSchema,
        measuredBpm: RationalSchema,
        bpmConfidence: Conf,
        beatPeriodSeconds: RationalSchema,
        gridAnchorSeconds: RationalSchema,
        snapped: z.boolean(),
        snapRule: z.string(),
        /** Share of kick-pulse beats with an onset within 30 ms. */
        support: Conf,
        residualRmsMs: z.number(),
        constantTempo: z
          .object({ isConstant: z.boolean(), halfDifferencePercent: z.number(), driftMsPerMinute: z.number() })
          .strict(),
        candidates: z
          .array(z.object({ bpm: z.number(), score: z.number(), f1: z.number(), relation: z.enum(["selected", "half", "double", "other"]) }).strict()),
      })
      .strict(),
    meter: z
      .object({
        beatsPerBar: z.number().int(),
        downbeatPhase: z.number().int(),
        downbeatConfidence: Conf,
        phraseBars: z.number().int(),
        phrasePhaseBars: z.number().int(),
        phraseConfidence: Conf,
      })
      .strict(),
    beats: z.array(BeatSchema),
    bars: z.array(BarSchema),
    phrases: z.array(PhraseSchema),
    sections: z.array(SectionSchema),
    events: z.array(MusicEventSchema),
    regions: z.array(RegionSchema),
    vocal: z
      .object({
        method: z.string(),
        wordIdentification: z.literal("unavailable"),
        note: z.string(),
        clusters: z.array(
          z.object({ id: Id, windowId: z.string(), medoidEventId: Id, memberEventIds: z.array(Id), meanSimilarity: z.number() }).strict(),
        ),
      })
      .strict(),
    curves: z
      .object({
        energy: z
          .object({
            stepSeconds: RationalSchema,
            rmsDbfs: z.array(z.number()),
            lowDb: z.array(z.number()),
            midDb: z.array(z.number()),
            highDb: z.array(z.number()),
            onsetsPerSecond: z.array(z.number()),
          })
          .strict(),
        loudness: z
          .object({
            method: z.literal("ffmpeg-ebur128"),
            stepSeconds: RationalSchema,
            momentaryLufs: z.array(z.number()),
            shortTermLufs: z.array(z.number()),
            integratedLufs: z.number().nullable(),
            loudnessRangeLu: z.number().nullable(),
            truePeakDbtp: z.number().nullable(),
          })
          .strict(),
      })
      .strict(),
    confidence: z.object({ overall: Conf, notes: z.array(z.string()) }).strict(),
    warnings: z.array(WarningSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// User-authored sync file
// ---------------------------------------------------------------------------

/** Times are unit-explicit literals: "90.000s" or "00:01:30.000" (bare numbers are rejected). */
const TimeLiteral = z.string().min(2);
const UserId = z.string().regex(/^usr:[a-z0-9._-]+$/);

export const MusicSyncSchema = z
  .object({
    schemaVersion: z.literal(MUSIC_SCHEMA_VERSION),
    sourceMediaId: z.string(),
    description: z.string().optional(),
    requiredEvents: z
      .array(
        z
          .object({
            id: UserId,
            type: z.enum(["structural_boundary", "start_boundary", "end_boundary", "vocal_hit", "custom"]),
            time: TimeLiteral,
            label: z.string(),
            mandatory: z.boolean().default(true),
            note: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    requiredPatterns: z
      .array(
        z
          .object({
            id: UserId,
            label: z.string(),
            window: z.object({ start: TimeLiteral, end: TimeLiteral }).strict(),
            matchEventTypes: z.array(MusicEventTypeSchema).min(1),
            requirement: z.literal("every_occurrence_mandatory"),
            note: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    /**
     * Human ground truth for a pattern (optional; absent = Phase 2 behaviour). Each occurrence is a
     * coarse window the user heard the word in; the exact sync onset is chosen from signal evidence.
     * `exhaustive`: there are no other occurrences of the word in the pattern window.
     */
    occurrenceGroundTruth: z
      .array(
        z
          .object({
            patternId: UserId,
            exhaustive: z.boolean(),
            /** A confirmed attack of the same word used as the acoustic reference. */
            referenceEventId: z.string(),
            occurrences: z
              .array(
                z
                  .object({
                    id: UserId,
                    window: z.object({ start: TimeLiteral, end: TimeLiteral }).strict(),
                    note: z.string().optional(),
                    /**
                     * Human approval of the primary sync point (authoritative). `time` must match the
                     * approved Phase 2 event within 1 ms. Effect repeats are acknowledged as
                     * descriptive events only (never word occurrences).
                     */
                    approval: z
                      .object({
                        primaryEventId: z.string(),
                        time: TimeLiteral,
                        effectRepeatEventIds: z.array(z.string()).default([]),
                        approvedBy: z.literal("user"),
                        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                        method: z.string(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict(),
              )
              .min(1),
            note: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    eventOverrides: z
      .array(
        z
          .object({
            id: UserId,
            targetEventId: z.string(),
            /**
             * `pin`: a human-approved exact time (`exactTime`, with `time` as its readable form, equal to
             * within 1 ms). The pinned time never follows later analysis; `evidenceEventIds` are only
             * checked (a warning if they no longer sit exactly there).
             */
            action: z.enum(["exclude", "confirm", "retime", "relabel", "pin"]),
            time: TimeLiteral.optional(),
            exactTime: RationalSchema.optional(),
            evidenceEventIds: z.array(z.string()).optional(),
            approved: z.object({ by: z.literal("user"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().optional(),
            label: z.string().optional(),
            note: z.string().optional(),
          })
          .strict()
          .superRefine((o, ctx) => {
            if (o.action === "pin" && (!o.time || !o.exactTime || !o.approved)) ctx.addIssue({ code: "custom", message: "pin needs time, exactTime and approved" });
            if (o.action === "retime" && !o.time) ctx.addIssue({ code: "custom", message: "retime needs a time" });
            if (o.action === "relabel" && !o.label) ctx.addIssue({ code: "custom", message: "relabel needs a label" });
          }),
      )
      .default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Resolved view (what the Edit Planner reads)
// ---------------------------------------------------------------------------

export const TierSchema = z.enum(["USER_REQUIRED", "STRUCTURAL", "DOWNBEAT", "BEAT", "DETAIL"]);
/**
 * CONFIRMED is human-only. CONFIRMED_BY_SIGNAL (1.1.0) = ASR consensus + Phase 2 signal agree; still
 * machine evidence, never a human decision. REJECTED (1.1.0) = evidence says this is not the word.
 */
export const IdentityStatusSchema = z.enum([
  "CONFIRMED",
  "CONFIRMED_BY_SIGNAL",
  "HIGH_CONFIDENCE_CANDIDATE",
  "NEEDS_HUMAN_CONFIRMATION",
  "REJECTED",
]);

/** Full provenance chain for an event touched by the vocal assist (raw values are never overwritten). */
export const ResolvedVocalAssistSchema = z
  .object({
    occurrenceId: z.string().nullable(),
    phase2EventId: z.string().nullable(),
    phase2Time: RationalSchema.nullable(),
    phase2Status: z.string().nullable(),
    rawWhisperStart: RationalSchema.nullable(),
    rawWhisperEnd: RationalSchema.nullable(),
    refinedSyncTime: RationalSchema.nullable(),
    asrWords: z.array(z.string()),
    asrConfidence: z.number().nullable(),
    consensusWindows: z.number().int().nullable(),
    state: z.enum(["CONFIRMED_BY_SIGNAL", "HIGH_CONFIDENCE_CANDIDATE", "NEEDS_HUMAN_CONFIRMATION", "REJECTED"]),
    reason: z.string(),
  })
  .strict();

export const ResolvedEventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    time: RationalSchema,
    tier: TierSchema,
    mandatory: z.boolean(),
    label: z.string().nullable(),
    identityStatus: IdentityStatusSchema.nullable(),
    confidence: Conf,
    origin: z.enum(["detected", "user"]),
    detectedEventId: z.string().nullable(),
    patternId: z.string().nullable(),
    overrideIds: z.array(z.string()),
    nearestBeatId: z.string().nullable(),
    beatOffsetMs: z.number().nullable(),
    evidence: z.string().nullable(),
    /** 1.1.0 only. */
    vocalAssist: ResolvedVocalAssistSchema.optional(),
    /** 1.1.0+: why the final identity/time is what it is (assist, ground truth and override steps). */
    resolutionReason: z.string().optional(),
    /** 1.2.0 only: role of this event in a human ground-truth occurrence. */
    occurrence: z
      .object({
        occurrenceId: z.string(),
        role: z.enum(["primary", "effect_repeat", "ambiguous_primary", "other"]),
        syncTarget: z.boolean(),
        effectCharacter: z.string().nullable(),
        timingConfidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable(),
        /** The user approved this event as the occurrence's primary sync point (or acknowledged it as a repeat). */
        humanApproved: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ResolvedMusicEventsSchema = z
  .object({
    schemaVersion: z.enum([MUSIC_SCHEMA_VERSION, RESOLVED_SCHEMA_VERSION, RESOLVED_GT_SCHEMA_VERSION]),
    sourceMediaId: z.string(),
    analysis: z.object({ analyzerVersion: z.string(), configHash: z.string() }).strict(),
    sync: z.object({ sha256: z.string() }).strict().nullable(),
    /** 1.1.0 only: the vocal-transcription artifact that was applied. */
    vocalAssist: z
      .object({ schemaVersion: z.string(), cacheKey: z.string(), model: z.string(), modelSha256: z.string(), patternId: z.string().nullable() })
      .strict()
      .optional(),
    /** 1.2.0 only: ground-truth occurrence sets that were applied. */
    groundTruth: z
      .array(z.object({ patternId: z.string(), exhaustive: z.boolean(), occurrences: z.number().int(), resolved: z.number().int(), ambiguous: z.number().int() }).strict())
      .optional(),
    tierOrder: z.array(TierSchema),
    events: z.array(ResolvedEventSchema),
    excluded: z.array(z.object({ detectedEventId: z.string(), overrideId: z.string(), note: z.string().nullable() }).strict()),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type MusicAnalysis = z.infer<typeof MusicAnalysisSchema>;
export type MusicEvent = z.infer<typeof MusicEventSchema>;
export type MusicSync = z.infer<typeof MusicSyncSchema>;
export type ResolvedEvent = z.infer<typeof ResolvedEventSchema>;
export type ResolvedMusicEvents = z.infer<typeof ResolvedMusicEventsSchema>;
export type Tier = z.infer<typeof TierSchema>;
