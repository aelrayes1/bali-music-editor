/**
 * semantic-shot-analysis.json (Phase 3B): model-derived, confidence-aware interpretation layered on
 * top of Phase 3 (which stays the objective truth and is never modified). Every judgement carries a
 * confidence and its evidence; UNKNOWN is preferred to fabricated certainty. Editorial-potential
 * values are FEATURES for Phase 4, not rankings or decisions.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

export const SEMANTIC_SCHEMA_VERSION = "1.0.0";

const Conf = z.number().min(0).max(1);
export const Labelled = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, confidence: Conf, evidence: z.string() }).strict();
const Tag = z.object({ label: z.string(), confidence: Conf, evidence: z.string() }).strict();
const NBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();

export const FramingSchema = z.enum(["extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide", "unknown"]);
export const OrientationSchema = z.enum(["front", "three_quarter", "profile", "back", "mixed", "unknown"]);
export const Potential = z.object({ score: Conf, reasons: z.array(z.string()) }).strict();

export const SemanticShotSchema = z
  .object({
    mediaId: z.string(),
    shotId: z.string(),
    start: RationalSchema,
    end: RationalSchema,
    samples: z.array(z.object({ frameIndex: z.number().int(), time: RationalSchema, position: z.number(), representative: z.boolean() }).strict()).min(1),
    subject: z
      .object({
        presence: Labelled(z.enum(["none", "single", "pair", "small_group", "group", "crowd", "unknown"])),
        personCount: z.object({ median: z.number(), max: z.number().int() }).strict(),
        /** Primary subject box (normalized to the shot's active picture) in the representative sample. */
        primaryBox: NBox.nullable(),
        /** No face/identity recognition is performed; identity comes only from user overrides. */
        identity: z.object({ value: z.null(), note: z.string() }).strict(),
      })
      .strict(),
    content: z.array(Tag),
    context: z.array(Tag),
    framing: Labelled(FramingSchema).extend({ perSample: z.array(FramingSchema) }).strict(),
    subjectOrientation: Labelled(OrientationSchema),
    subjectMotion: z.object({ labels: z.array(Tag), screenDirection: Labelled(z.enum(["left_to_right", "right_to_left", "toward_camera", "away_from_camera", "none", "unknown"])) }).strict(),
    cameraMotion: z.object({ labels: z.array(Tag), direction: z.object({ x: z.number(), y: z.number() }).strict() }).strict(),
    features: z
      .object({
        subjectClarity: Potential,
        semanticInterest: Potential,
        technicalQuality: Potential,
        heroPotential: Potential,
        openingPotential: Potential,
        dropPotential: Potential,
        transitionPotential: Potential,
        loopPotential: Potential,
        cropPotential9x16: Potential.extend({
          nativeVertical: z.boolean(),
          cropWidth: z.number().int(),
          centerPath: z.array(z.object({ time: RationalSchema, centerX: z.number().int() }).strict()),
          difficulty: z.enum(["none", "easy", "moderate", "hard", "not_applicable"]),
          risks: z.array(z.enum(["subject_clipping", "watermark_intrusion", "insufficient_resolution", "context_outside_crop", "no_subject"])),
          upscaleFactor: z.number(),
        }).strict(),
      })
      .strict(),
    /** Unit-normalized mean image embedding (Apple Vision feature print), base64 float32. */
    embedding: z.string(),
    phase3: z
      .object({ staticImageVideo: z.boolean(), boundaryInConfidence: z.number(), overlayIds: z.array(z.string()), nearDuplicateShotIds: z.array(z.string()) })
      .strict(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();

export const TakeSchema = z
  .object({
    takeId: z.string(),
    shotIds: z.array(z.string()).min(2),
    relation: z.enum(["LIGHTING_EVENT_SAME_TAKE", "SAME_TAKE"]),
    confidence: Conf,
    evidence: z.string(),
  })
  .strict();

export const SemanticMediaSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
    generatedAt: z.string(),
    mediaId: z.string(),
    provenance: z
      .object({
        tool: z.string(),
        framework: z.string(),
        toolSha256: z.string(),
        osBuild: z.string(),
        visionCacheKey: z.string(),
        phase3: z.object({ analyzerVersion: z.string(), implementation: z.string(), configHash: z.string() }).strict(),
        semanticVersion: z.string(),
        implementation: z.string(),
      })
      .strict(),
    source: z
      .object({
        collection: z.string(),
        archival: Labelled(z.boolean()),
        musicVideoEditing: Labelled(z.boolean()),
        staticImageVideo: z.boolean(),
        display: z.object({ w: z.number().int(), h: z.number().int() }).strict(),
      })
      .strict(),
    shots: z.array(SemanticShotSchema),
    takes: z.array(TakeSchema),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  })
  .strict();

export const ContinuityCandidateSchema = z
  .object({
    to: z.object({ mediaId: z.string(), shotId: z.string() }).strict(),
    score: Conf,
    kind: z.enum(["match_cut", "motion_match", "contrast_cut", "energy_build", "sequence_neighbor", "other"]),
    motionRelation: z.enum(["same_direction", "opposite_direction", "none"]),
    framingRelation: z.enum(["similar", "tighter", "wider", "strong_contrast", "unknown"]),
    reasons: z.array(z.string()),
  })
  .strict();

export const SemanticIndexSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
    media: z.array(z.string()),
    shots: z.array(
      z
        .object({
          mediaId: z.string(),
          shotId: z.string(),
          visualNovelty: Potential,
          duplicateGroup: z.string().nullable(),
          continuity: z.array(ContinuityCandidateSchema),
        })
        .strict(),
    ),
    duplicateGroups: z.array(z.object({ id: z.string(), members: z.array(z.object({ mediaId: z.string(), shotId: z.string() }).strict()), evidence: z.string() }).strict()),
  })
  .strict();

export type SemanticShot = z.infer<typeof SemanticShotSchema>;
export type SemanticMedia = z.infer<typeof SemanticMediaSchema>;
export type SemanticIndex = z.infer<typeof SemanticIndexSchema>;
export type Framing = z.infer<typeof FramingSchema>;
export type ContinuityCandidate = z.infer<typeof ContinuityCandidateSchema>;
