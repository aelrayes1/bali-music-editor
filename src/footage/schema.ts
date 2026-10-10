/**
 * footage-analysis.json (Phase 3, objective footage intelligence): measured facts per media and
 * per shot. No creative or semantic labels. Times are exact rationals (Phase 1 primitives) taken
 * from decoded frame timestamps; rectangles are in display pixels (rotation and pixel aspect applied).
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

export const FOOTAGE_SCHEMA_VERSION = "1.0.0";

const Rect = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).strict();
const Stat = z.object({ mean: z.number(), p10: z.number(), p50: z.number(), p90: z.number() }).strict();
const Region = z.object({ start: RationalSchema, end: RationalSchema, duration: RationalSchema, frames: z.number().int() }).strict();
const Warning = z.object({ code: z.string(), message: z.string() }).strict();

export const ActivePictureSchema = z
  .object({
    encodedFrame: Rect,
    activeRect: Rect,
    borders: z.object({ left: z.number().int(), right: z.number().int(), top: z.number().int(), bottom: z.number().int() }).strict(),
    type: z.enum(["full_frame", "pillarbox", "letterbox", "windowbox", "undetermined"]),
    activeAspect: z.number().nullable(),
    stableFraction: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const OverlaySchema = z
  .object({
    id: z.string(),
    /** "graphic": watermark/logo/text; "edge_structure": thin static structure along the picture edge (analog blanking, frame line). */
    kind: z.enum(["graphic", "edge_structure"]),
    /** "picture": inside the active picture; "border": inside black bars. */
    location: z.enum(["picture", "border"]),
    bbox: Rect,
    bboxNormalized: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict(),
    persistence: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
  })
  .strict();

export const ShotSchema = z
  .object({
    shotId: z.string().regex(/^shot:\d{4}$/),
    index: z.number().int().nonnegative(),
    start: RationalSchema,
    end: RationalSchema,
    duration: RationalSchema,
    frames: z.object({ first: z.number().int(), last: z.number().int(), count: z.number().int() }).strict(),
    boundaryIn: z
      .object({
        type: z.enum(["media_start", "hard_cut", "fade_through_black"]),
        confidence: z.number().min(0).max(1),
        evidence: z.string(),
      })
      .strict(),
    representative: z.object({ time: RationalSchema, frameIndex: z.number().int(), reason: z.string() }).strict(),
    sharpness: Stat.extend({ scale: z.literal("laplacian variance at analysis resolution") }).strict(),
    exposure: z.object({ meanLuma: z.number(), p05: z.number(), p50: z.number(), p95: z.number(), dynamicRange: z.number() }).strict(),
    clipping: z
      .object({
        highlightFraction: Stat,
        shadowFraction: Stat,
        framesHighlightClipped: z.number().min(0).max(1),
        framesShadowCrushed: z.number().min(0).max(1),
      })
      .strict(),
    motion: z
      .object({
        globalSpeed: Stat.extend({ unit: z.literal("frame widths per second") }).strict(),
        meanDirection: z.object({ x: z.number(), y: z.number() }).strict(),
        directionalConsistency: z.number().min(0).max(1),
        frameChange: Stat.extend({ unit: z.literal("mean abs luma diff per frame (0-255)") }).strict(),
        localChange: Stat.extend({ unit: z.literal("motion-compensated mean abs luma diff (0-255)") }).strict(),
        lowMotionFraction: z.number().min(0).max(1),
        highMotionFraction: z.number().min(0).max(1),
      })
      .strict(),
    stability: z
      .object({
        jitterRms: z.number(),
        unit: z.literal("percent of frame width per frame"),
        class: z.enum(["stable", "moderate", "shaky", "undetermined"]),
      })
      .strict(),
    activePicture: ActivePictureSchema,
    static: z.object({ frozenFraction: z.number().min(0).max(1), identicalFraction: z.number().min(0).max(1), freezeRegions: z.array(Region) }).strict(),
    black: z.object({ fraction: z.number().min(0).max(1), regions: z.array(Region) }).strict(),
    usable: z.object({ seconds: RationalSchema, fraction: z.number().min(0).max(1), rule: z.string() }).strict(),
    overlayIds: z.array(z.string()),
    crop916: z
      .object({
        cropWidth: z.number().int(),
        fitsInActivePicture: z.boolean(),
        centeredCropOverlapsOverlay: z.boolean(),
        detailCentroidX: z.number().nullable(),
      })
      .strict(),
    dHash: z.string().regex(/^[0-9a-f]{16}$/),
    nearDuplicates: z.array(z.object({ mediaId: z.string(), shotId: z.string(), hamming: z.number().int() }).strict()),
    warnings: z.array(Warning),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const FootageAnalysisSchema = z
  .object({
    schemaVersion: z.literal(FOOTAGE_SCHEMA_VERSION),
    generatedAt: z.string(),
    analyzer: z
      .object({
        name: z.literal("bali-footage-intelligence"),
        version: z.string(),
        implementation: z.string(),
        configHash: z.string(),
        config: z.record(z.string(), z.unknown()),
        ffmpeg: z.object({ path: z.string(), version: z.string() }).strict(),
      })
      .strict(),
    source: z.object({ mediaId: z.string(), fingerprint: z.string(), fileName: z.string(), streamIndex: z.number().int() }).strict(),
    geometry: z
      .object({
        stored: z.object({ w: z.number().int(), h: z.number().int() }).strict(),
        display: z.object({ w: z.number().int(), h: z.number().int() }).strict(),
        rotationClockwise: z.number().int(),
        orientation: z.string(),
        analysis: z.object({ w: z.number().int(), h: z.number().int() }).strict(),
      })
      .strict(),
    timing: z
      .object({
        frameCount: z.number().int(),
        timeBase: RationalSchema,
        frameRateMode: z.string(),
        firstFrame: RationalSchema,
        end: RationalSchema,
        measuredFps: z.number(),
      })
      .strict(),
    technical: z
      .object({
        codec: z.string(),
        fieldOrder: z.string().nullable(),
        bitsPerPixel: z.number().nullable(),
        activePixelsDisplay: z.object({ w: z.number().int(), h: z.number().int() }).strict(),
      })
      .strict(),
    activePicture: ActivePictureSchema,
    static: z
      .object({
        frozenFraction: z.number().min(0).max(1),
        identicalFraction: z.number().min(0).max(1),
        uniqueFrames: z.number().int(),
        staticImageVideo: z.boolean(),
        confidence: z.number().min(0).max(1),
        freezeRegions: z.array(Region),
      })
      .strict(),
    overlays: z.array(OverlaySchema),
    overlayEvaluable: z.boolean(),
    shots: z.array(ShotSchema),
    suppressedBoundaries: z.array(z.object({ time: RationalSchema, frame: z.number().int(), reason: z.string() }).strict()),
    warnings: z.array(Warning),
  })
  .strict();

export type FootageAnalysis = z.infer<typeof FootageAnalysisSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type ActivePicture = z.infer<typeof ActivePictureSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
