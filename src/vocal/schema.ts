/**
 * vocal-transcription.json — Phase 2.5 OPTIONAL local vocal timing assist.
 *
 * Separate from music-analysis.json. Whisper is an assistant, never the timing authority:
 * raw ASR times are stored untouched; refined sync times come only from Phase 2 signal
 * evidence inside a bounded window; identity labels are evidence levels, and human overrides
 * (in music-sync.json) stay authoritative.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

export const VOCAL_SCHEMA_VERSION = "1.0.0";

export const WordFlagSchema = z.enum([
  "NON_SPEECH", // ♪, (upbeat music), [BLANK_AUDIO] ...
  "REPETITION_LOOP", // run of the same word typical of Whisper hallucination loops
  "TIMESTAMP_COMPRESSED", // several words squashed onto one timestamp (end-of-window artifact)
  "WINDOW_EDGE", // starts at the very end of its window (truncated context)
]);

export const WordStateSchema = z.enum(["UNCONFIRMED", "HIGH_CONFIDENCE", "HUMAN_CONFIRMED", "REJECTED"]);
export const OccurrenceStateSchema = z.enum([
  "CONFIRMED_BY_SIGNAL",
  "HIGH_CONFIDENCE_CANDIDATE",
  "NEEDS_HUMAN_CONFIRMATION",
  "REJECTED",
]);

export const AsrWindowSchema = z
  .object({
    id: z.string().regex(/^win:\d{2}$/),
    start: RationalSchema,
    end: RationalSchema,
    startSample16k: z.number().int().nonnegative(),
    endSample16k: z.number().int().positive(),
    anchoredToBarId: z.string().nullable(),
  })
  .strict();

export const AsrWordSchema = z
  .object({
    id: z.string().regex(/^asr:\d{2}:\d{3}$/),
    windowId: z.string(),
    rawText: z.string(),
    normalized: z.string(),
    /** Absolute source time = window start + Whisper offset (10 ms resolution), exact. */
    start: RationalSchema,
    end: RationalSchema,
    /** Mean token probability reported by Whisper (not calibrated). */
    asrConfidence: z.number().min(0).max(1),
    tokens: z.array(z.object({ text: z.string(), p: z.number() }).strict()),
    flags: z.array(WordFlagSchema),
    /** Number of distinct windows that heard the same normalized word within the tolerance. */
    consensusWindows: z.number().int().nonnegative(),
    coveringWindows: z.number().int().nonnegative(),
    sourceMethod: z.literal("WHISPER"),
    state: WordStateSchema,
  })
  .strict();

export const OccurrenceSchema = z
  .object({
    id: z.string().regex(/^occ:[a-z]+:\d{5}$/),
    target: z.string(),
    matchKind: z.enum(["EXACT", "NEAR"]),
    hearingWordIds: z.array(z.string()).min(1),
    asrWords: z.array(z.string()),
    /** Mean of the hearings' raw starts (exact rational); never overwritten. */
    rawWhisperStart: RationalSchema,
    rawWhisperEnd: RationalSchema,
    asrConfidence: z.number().min(0).max(1),
    consensusWindows: z.number().int().nonnegative(),
    nearestPhase2Candidate: z.object({ eventId: z.string(), deltaMs: z.number(), confidence: z.number() }).strict().nullable(),
    nearestOnset: z.object({ eventId: z.string(), strength: z.number(), deltaMs: z.number() }).strict().nullable(),
    /** Signal-based sync time (a Phase 2 event time) or null when no evidence inside the window. */
    refinedSyncTime: RationalSchema.nullable(),
    refinedFromEventId: z.string().nullable(),
    refinementDeltaMs: z.number().nullable(),
    refinementMethod: z.enum(["phase2_vocal_attack", "phase2_onset", "none"]),
    beat: z.object({ beatId: z.string(), barIndex: z.number().int(), beatInBar: z.number().int(), offsetMs: z.number() }).strict().nullable(),
    refinedConfidence: z.number().min(0).max(1),
    state: OccurrenceStateSchema,
    reason: z.string(),
  })
  .strict();

export const CandidateAssessmentSchema = z
  .object({
    eventId: z.string(),
    time: RationalSchema,
    phase2Status: z.string().nullable(),
    state: OccurrenceStateSchema,
    occurrenceId: z.string().nullable(),
    overlappingWords: z.array(z.string()),
    reason: z.string(),
  })
  .strict();

export const VocalTranscriptionSchema = z
  .object({
    schemaVersion: z.literal(VOCAL_SCHEMA_VERSION),
    generatedAt: z.string(),
    sourceMediaId: z.string(),
    sourceFingerprint: z.string(),
    analyzedRange: z.object({ start: RationalSchema, end: RationalSchema }).strict(),
    targetWindow: z.object({ start: RationalSchema, end: RationalSchema }).strict(),
    patternId: z.string().nullable(),
    phase2: z.object({ analyzerVersion: z.string(), configHash: z.string() }).strict(),
    engine: z
      .object({
        name: z.literal("whisper.cpp"),
        version: z.string(),
        commit: z.string(),
        binary: z.string(),
        networkSandbox: z.boolean(),
        args: z.array(z.string()),
      })
      .strict(),
    model: z.object({ name: z.string(), file: z.string(), sizeBytes: z.number().int(), sha256: z.string() }).strict(),
    language: z.string(),
    config: z
      .object({
        windowBars: z.number().int().positive(),
        stepBars: z.number().int().positive(),
        sampleRate: z.literal(16000),
        consensusToleranceMs: z.number(),
        refinementWindowMs: z.number(),
        targetWords: z.array(z.string()),
      })
      .strict(),
    cacheKey: z.string(),
    windows: z.array(AsrWindowSchema),
    segments: z.array(z.object({ windowId: z.string(), text: z.string(), start: RationalSchema, end: RationalSchema }).strict()),
    words: z.array(AsrWordSchema),
    normalizedText: z.string(),
    occurrences: z.array(OccurrenceSchema),
    candidateAssessments: z.array(CandidateAssessmentSchema),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();

export type AsrWindow = z.infer<typeof AsrWindowSchema>;
export type AsrWord = z.infer<typeof AsrWordSchema>;
export type Occurrence = z.infer<typeof OccurrenceSchema>;
export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>;
export type VocalTranscription = z.infer<typeof VocalTranscriptionSchema>;
export type OccurrenceState = z.infer<typeof OccurrenceStateSchema>;
