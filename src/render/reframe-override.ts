/**
 * HUMAN_REFRAME_OVERRIDE (Phase 5.1): a reviewer's crop decision for one clip of an approved plan.
 * It may change only the 9:16 crop centre (static) or centre path (tracked). It can never change
 * the clip's identity, source range, timeline, cut timing, audio or any other clip, and it never
 * modifies Phase 3/3B analysis or the Edit Plan: it is applied at execution (render spec) time.
 * Only APPROVED overrides are executed; PROPOSED ones are review material.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";

const Point = z.object({ sourceTime: RationalSchema, centerX: z.number() }).strict();

export const ReframeOverrideSchema = z
  .object({
    id: z.string().regex(/^usr:/),
    kind: z.literal("HUMAN_REFRAME_OVERRIDE"),
    clipId: z.string(),
    mediaId: z.string(),
    shotId: z.string(),
    status: z.enum(["PROPOSED", "APPROVED"]),
    /** review option this came from, e.g. CROP_D_STATIC_MANUAL */
    option: z.string().optional(),
    mode: z.enum(["static", "tracked"]),
    centerX: z.number().optional(),
    path: z.array(Point).optional(),
    /** constant horizontal offset (display px) added to the centre / every path point */
    offsetX: z.number().optional(),
    /** zero-phase moving-average window (frames) applied to the per-frame crop centre */
    smoothingFrames: z.number().int().min(1).max(61).optional(),
    /** human-verified subject positions (display px) used for the subject-margin QC */
    subjectTrack: z.array(Point).optional(),
    basis: z.string(),
    note: z.string().optional(),
    date: z.string().optional(),
  })
  .strict()
  .refine((o) => (o.mode === "static" ? typeof o.centerX === "number" : (o.path?.length ?? 0) >= 2), { message: "static needs centerX; tracked needs a path of >= 2 points" });
export type ReframeOverride = z.infer<typeof ReframeOverrideSchema>;

export const ReframeOverridesSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("HUMAN_REFRAME_OVERRIDES"),
    projectId: z.string(),
    planId: z.string(),
    overrides: z.array(ReframeOverrideSchema),
  })
  .strict();
export type ReframeOverrides = z.infer<typeof ReframeOverridesSchema>;

/** Largest crop movement a tracked override may make per output frame (display px). */
export const MAX_OVERRIDE_STEP = 24;
