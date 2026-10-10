/**
 * Canonical Edit Plan (v5 Phase 4): the creative source of truth for downstream execution
 * (FFmpeg, Remotion, Resolve MCP), the Critic Agent and human revision. Every decision is
 * auditable: each clip records why it was chosen, each cut the music event that triggered it.
 * Times are exact rationals: song time for music events, source time per media, timeline time =
 * song time - audio source start. Frame numbers are the render grid (nearest frame at `fps`).
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

export const EDIT_PLAN_SCHEMA_VERSION = "1.0.0";

const Conf = z.number().min(0).max(1);
const Warn = z.object({ code: z.string(), message: z.string() }).strict();
const TimelinePoint = z.object({ time: RationalSchema, frame: z.number().int().nonnegative(), snapErrorMs: z.number() }).strict();

export const ReframeSchema = z
  .object({
    intent: z.enum(["native_vertical", "subject_centred_crop", "tracked_crop", "static_crop", "preserve_wider_composition", "alternative_treatment_needed"]),
    /** 9:16 crop window centre (display px of the source) over the clip's source range. */
    centerPath: z.array(z.object({ sourceTime: RationalSchema, centerX: z.number().int() }).strict()),
    cropWidth: z.number().int(),
    upscaleFactor: z.number(),
    difficulty: z.string(),
    risks: z.array(z.string()),
    watermarkRisk: z.boolean(),
    contextLoss: z.boolean(),
    note: z.string(),
  })
  .strict();

export const FxIntentSchema = z
  .object({
    kind: z.enum(["none", "subtle_punch", "micro_stutter", "frame_repeat", "visual_echo", "flash_accent"]),
    /** song time the effect is anchored to */
    at: RationalSchema,
    durationFrames: z.number().int().nonnegative(),
    eventId: z.string().nullable(),
    reason: z.string(),
  })
  .strict();

export const ClipSchema = z
  .object({
    clipId: z.string().regex(/^clip:\d{2}$/),
    segmentId: z.string(),
    mediaId: z.string(),
    /** Phase 3 shot(s) the source range lies in (several only across a same-take lighting event). */
    shotIds: z.array(z.string()).min(1),
    takeId: z.string().nullable(),
    sourceIn: RationalSchema,
    sourceOut: RationalSchema,
    timelineIn: TimelinePoint,
    timelineOut: TimelinePoint,
    songIn: RationalSchema,
    songOut: RationalSchema,
    duration: RationalSchema,
    selection: z
      .object({
        score: z.number(),
        components: z.record(z.string(), z.number()),
        reasons: z.array(z.string()),
        alternatives: z.array(z.object({ mediaId: z.string(), shotId: z.string(), score: z.number() }).strict()),
      })
      .strict(),
    semanticEvidence: z
      .object({
        framing: z.string(),
        subject: z.string(),
        orientation: z.string(),
        content: z.array(z.string()),
        context: z.array(z.string()),
        subjectMotion: z.array(z.string()),
        screenDirection: z.string(),
        cameraMotion: z.array(z.string()),
        heroPotential: Conf,
        openingPotential: Conf,
        dropPotential: Conf,
        novelty: Conf,
        identity: z.string().nullable(),
      })
      .strict(),
    technicalEvidence: z
      .object({
        technicalQuality: Conf,
        sharpnessP50: z.number(),
        exposureP50: z.number(),
        stability: z.string(),
        activePicture: z.string(),
        overlays: z.array(z.string()),
        staticImageVideo: z.boolean(),
        duplicateGroup: z.string().nullable(),
      })
      .strict(),
    reframe: ReframeSchema,
    fx: z.array(FxIntentSchema),
    warnings: z.array(Warn),
  })
  .strict();

export const CutSchema = z
  .object({
    cutId: z.string().regex(/^cut:\d{2}$/),
    songTime: RationalSchema,
    timeline: TimelinePoint,
    trigger: z.object({ eventId: z.string(), kind: z.string(), priority: z.number().int(), label: z.string() }).strict(),
    from: z.object({ clipId: z.string(), mediaId: z.string(), shotId: z.string(), sourceTime: RationalSchema }).strict(),
    to: z.object({ clipId: z.string(), mediaId: z.string(), shotId: z.string(), sourceTime: RationalSchema }).strict(),
    transition: z.enum(["hard_cut"]),
    reason: z.string(),
    semanticEvidence: z.string(),
    technicalEvidence: z.string(),
    transitionRationale: z.string(),
    confidence: Conf,
  })
  .strict();

export const EditPlanSchema = z
  .object({
    schemaVersion: z.literal(EDIT_PLAN_SCHEMA_VERSION),
    projectId: z.string(),
    /** Stable id: hash of the plan's decisions (independent of generation time). */
    planId: z.string().regex(/^plan:[a-z0-9-]+:[0-9a-f]{10}$/),
    candidateId: z.enum(["A", "B", "C"]),
    strategy: z.object({ id: z.string(), name: z.string(), description: z.string(), weights: z.record(z.string(), z.number()) }).strict(),
    audio: z.object({ mediaId: z.string(), sourceStart: RationalSchema, sourceEnd: RationalSchema }).strict(),
    timeline: z
      .object({
        duration: RationalSchema,
        fps: RationalSchema,
        frames: z.number().int().positive(),
        aspectRatio: z.literal("9:16"),
        width: z.literal(1080),
        height: z.literal(1920),
      })
      .strict(),
    humanConstraints: z.array(z.object({ id: z.string(), description: z.string(), satisfied: z.boolean(), evidence: z.string() }).strict()),
    musicEvents: z.array(z.object({ eventId: z.string(), songTime: RationalSchema, kind: z.string(), priority: z.number().int(), use: z.string() }).strict()),
    clips: z.array(ClipSchema).min(2),
    cuts: z.array(CutSchema),
    metrics: z.record(z.string(), z.number()),
    confidence: Conf,
    warnings: z.array(Warn),
    provenance: z
      .object({
        planner: z.string(),
        plannerVersion: z.string(),
        implementation: z.string(),
        inputs: z.record(z.string(), z.string()),
      })
      .strict(),
  })
  .strict();

export type EditPlan = z.infer<typeof EditPlanSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Cut = z.infer<typeof CutSchema>;
