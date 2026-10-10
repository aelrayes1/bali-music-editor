/**
 * media-manifest.json schema (Phase 1, Media Foundation).
 *
 * The zod schema is the single source of truth: TypeScript types are inferred from it,
 * runtime validation uses it, and `npm run schema:export` writes the JSON Schema to
 * schemas/media-manifest.schema.json.
 *
 * Timing fields are exact rationals ({num, den}); there are no float seconds.
 */

import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = "1.0.0";

export const RationalSchema = z
  .object({
    num: z.number().int(),
    den: z.number().int().positive(),
  })
  .strict()
  .describe("Exact rational number num/den (normalized).");

export const MediaStatusSchema = z.enum([
  "OK",
  "UNSUPPORTED",
  "NO_VIDEO_STREAM",
  "NO_AUDIO_STREAM",
  "AUDIO_ONLY",
  "ATTACHED_PICTURE_ONLY",
  "MALFORMED",
  "READ_FAILED",
  "DECODE_FAILED",
  "METADATA_INCONSISTENT",
]);

export const MediaKindSchema = z.enum(["video", "audio", "unknown"]);

export const WarningCodeSchema = z.enum([
  "VARIABLE_FRAME_RATE",
  "NOMINAL_AVERAGE_RATE_MISMATCH",
  "FRAME_COUNT_MISMATCH",
  "FRAME_COUNT_UNAVAILABLE",
  "ROTATION_METADATA",
  "NON_SQUARE_PIXELS",
  "ATTACHED_PICTURE_PRESENT",
  "STILL_IMAGE_STREAM",
  "MULTIPLE_VIDEO_STREAMS",
  "MULTIPLE_AUDIO_STREAMS",
  "NO_AUDIO",
  "DURATION_MISMATCH",
  "DURATION_UNKNOWN",
  "FRAME_RATE_UNKNOWN",
  "UNKNOWN_SAMPLE_ASPECT_RATIO",
  "DECODE_WARNINGS",
  "DUPLICATE_CONTENT",
  "INTERLACED",
  "HDR_TRANSFER",
]);

export const WarningSchema = z
  .object({
    code: WarningCodeSchema,
    message: z.string(),
    streamIndex: z.number().int().nullable(),
  })
  .strict();

export const StreamRoleSchema = z.enum([
  "footage",
  "attachedPicture",
  "stillImage",
  "audio",
  "subtitle",
  "data",
  "attachment",
  "unknown",
]);

export const StreamSummarySchema = z
  .object({
    index: z.number().int().nonnegative(),
    codecType: z.string(),
    codecName: z.string().nullable(),
    role: StreamRoleSchema,
    isDefault: z.boolean(),
  })
  .strict();

export const RotationSchema = z
  .object({
    /** Raw display-matrix rotation as reported by ffprobe (counter-clockwise positive). */
    displayMatrixDegrees: z.number().nullable(),
    /** Legacy `rotate` stream tag, if present. */
    tagDegrees: z.number().nullable(),
    /** Clockwise rotation a player applies to the stored frame for display. */
    clockwiseToDisplay: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    source: z.enum(["displayMatrix", "tag", "none"]),
  })
  .strict();

export const FrameRateModeSchema = z
  .object({
    classification: z.enum(["CFR", "VFR", "UNKNOWN"]),
    method: z.enum(["packetTimestamps", "rateFieldsOnly", "none"]),
    packetCount: z.number().int().nonnegative(),
    /** Frame-to-frame presentation interval statistics in stream time-base ticks. */
    minFrameDurationTicks: z.number().int().nullable(),
    maxFrameDurationTicks: z.number().int().nullable(),
    meanFrameDurationTicks: RationalSchema.nullable(),
    distinctFrameDurations: z.number().int().nonnegative(),
    /** Fraction of intervals deviating from the mean by more than the tolerance. */
    deviatingIntervalFraction: RationalSchema.nullable(),
    toleranceTicks: RationalSchema.nullable(),
  })
  .strict();

export const FrameCountSchema = z
  .object({
    value: z.number().int().nonnegative().nullable(),
    source: z.enum(["packetCount", "containerNbFrames", "unavailable"]),
    reliable: z.boolean(),
    containerNbFrames: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const ColorSchema = z
  .object({
    range: z.string().nullable(),
    space: z.string().nullable(),
    transfer: z.string().nullable(),
    primaries: z.string().nullable(),
    chromaLocation: z.string().nullable(),
    hdrTransfer: z.boolean(),
  })
  .strict();

export const VideoStreamSchema = z
  .object({
    streamIndex: z.number().int().nonnegative(),
    codec: z.string(),
    codecLongName: z.string().nullable(),
    codecProfile: z.string().nullable(),
    pixelFormat: z.string().nullable(),
    bitsPerRawSample: z.number().int().nullable(),
    fieldOrder: z.string().nullable(),
    /** Frame dimensions as stored in the stream (before SAR and rotation). */
    storedWidth: z.number().int().positive(),
    storedHeight: z.number().int().positive(),
    /** Codec-level dimensions (may include alignment padding). */
    codedWidth: z.number().int().nullable(),
    codedHeight: z.number().int().nullable(),
    sampleAspectRatio: RationalSchema,
    sampleAspectRatioKnown: z.boolean(),
    rotation: RotationSchema,
    /** Dimensions as shown to a viewer: SAR applied, then rotation applied. */
    displayWidth: z.number().int().positive(),
    displayHeight: z.number().int().positive(),
    displayAspectRatio: RationalSchema,
    orientation: z.enum(["landscape", "portrait", "square"]),
    timeBase: RationalSchema,
    startTimeSeconds: RationalSchema.nullable(),
    durationSeconds: RationalSchema.nullable(),
    /** ffprobe r_frame_rate: the rate that can represent all timestamps (nominal). */
    nominalFrameRate: RationalSchema.nullable(),
    /** ffprobe avg_frame_rate: frames / duration as the demuxer computed it. */
    averageFrameRate: RationalSchema.nullable(),
    /** (frames - 1) / (last pts - first pts), from packet timestamps. */
    measuredFrameRate: RationalSchema.nullable(),
    frameRateMode: FrameRateModeSchema,
    frameCount: FrameCountSchema,
    bitRate: z.number().int().nullable(),
    color: ColorSchema,
    isAttachedPicture: z.literal(false),
    isFootage: z.literal(true),
  })
  .strict();

export const AttachedPictureSchema = z
  .object({
    streamIndex: z.number().int().nonnegative(),
    codec: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    role: z.enum(["attachedPicture", "stillImage"]),
  })
  .strict();

export const AudioStreamSchema = z
  .object({
    streamIndex: z.number().int().nonnegative(),
    codec: z.string(),
    codecLongName: z.string().nullable(),
    codecProfile: z.string().nullable(),
    sampleRate: z.number().int().positive().nullable(),
    channels: z.number().int().nonnegative().nullable(),
    channelLayout: z.string().nullable(),
    sampleFormat: z.string().nullable(),
    bitsPerSample: z.number().int().nullable(),
    bitRate: z.number().int().nullable(),
    timeBase: RationalSchema.nullable(),
    startTimeSeconds: RationalSchema.nullable(),
    durationSeconds: RationalSchema.nullable(),
  })
  .strict();

export const CreationSchema = z
  .object({
    time: z.string().nullable(),
    timeSource: z.string().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    software: z.string().nullable(),
    encoder: z.string().nullable(),
  })
  .strict();

export const DecodeCheckSchema = z
  .object({
    mode: z.enum(["sampled", "skipped"]),
    ok: z.boolean().nullable(),
    messages: z.array(z.string()),
  })
  .strict();

export const MediaEntrySchema = z
  .object({
    mediaId: z.string().regex(/^m_[0-9a-f]{16}(-dup-[0-9a-f]{8})?$/),
    contentFingerprint: z
      .object({ algorithm: z.literal("sha256-sampled-v1"), value: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
    fullSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    duplicateOf: z.string().nullable(),
    source: z
      .object({
        rootId: z.string(),
        relativePath: z.string(),
        absolutePath: z.string(),
        fileName: z.string(),
        extension: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        modifiedAt: z.string().nullable(),
      })
      .strict(),
    kind: MediaKindSchema,
    status: MediaStatusSchema,
    statusDetail: z.string().nullable(),
    warnings: z.array(WarningSchema),
    container: z
      .object({
        formatName: z.string().nullable(),
        formatLongName: z.string().nullable(),
        durationSeconds: RationalSchema.nullable(),
        startTimeSeconds: RationalSchema.nullable(),
        bitRate: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
    creation: CreationSchema,
    streams: z.array(StreamSummarySchema),
    video: VideoStreamSchema.nullable(),
    audio: AudioStreamSchema.nullable(),
    attachedPictures: z.array(AttachedPictureSchema),
    hasAudio: z.boolean(),
    isPlayableVideoFootage: z.boolean(),
    decodeCheck: DecodeCheckSchema,
  })
  .strict();

export const SourceRootSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    path: z.string(),
  })
  .strict();

export const MediaManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    /** The only intentionally non-deterministic field. */
    generatedAt: z.string(),
    generator: z
      .object({
        name: z.literal("bali-media-foundation"),
        version: z.string(),
        ffprobe: z.object({ path: z.string(), version: z.string() }).strict(),
      })
      .strict(),
    sourceRoots: z.array(SourceRootSchema),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        byStatus: z.record(z.string(), z.number().int().nonnegative()),
        byKind: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    media: z.array(MediaEntrySchema),
  })
  .strict();

export type RationalJson = z.infer<typeof RationalSchema>;
export type MediaStatus = z.infer<typeof MediaStatusSchema>;
export type MediaKind = z.infer<typeof MediaKindSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type WarningCode = z.infer<typeof WarningCodeSchema>;
export type StreamSummary = z.infer<typeof StreamSummarySchema>;
export type Rotation = z.infer<typeof RotationSchema>;
export type FrameRateMode = z.infer<typeof FrameRateModeSchema>;
export type VideoStream = z.infer<typeof VideoStreamSchema>;
export type AudioStream = z.infer<typeof AudioStreamSchema>;
export type AttachedPicture = z.infer<typeof AttachedPictureSchema>;
export type MediaEntry = z.infer<typeof MediaEntrySchema>;
export type MediaManifest = z.infer<typeof MediaManifestSchema>;
export type SourceRoot = z.infer<typeof SourceRootSchema>;
