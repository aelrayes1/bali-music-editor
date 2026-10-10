/**
 * HUMAN_SUBJECT_OVERRIDE (Phase 6B): a reviewer's statement of WHO the primary subject of one clip
 * is, for subject-aware effects. It controls subject identity only. It never edits Phase 3/3B
 * semantics, identity labels, the Edit Plan, crops (HUMAN_REFRAME_OVERRIDE stays authoritative for
 * framing) or timing; it lives in its own file and is read, never written, by the render path.
 * Only APPROVED overrides are used. When the isolation subject disagrees with the framing subject
 * (PRIMARY_SUBJECT_CONFLICT), an override proceeds only if it explicitly says it resolves that
 * conflict, which keeps the decision auditable.
 */

import { z } from "zod";

export const SubjectOverrideSchema = z
  .object({
    id: z.string().regex(/^usr:/),
    kind: z.literal("HUMAN_SUBJECT_OVERRIDE"),
    clipId: z.string(),
    mediaId: z.string().optional(),
    shotId: z.string().optional(),
    status: z.enum(["PROPOSED", "APPROVED"]),
    /** a point on the subject: clip-local frame, conformed-frame pixels */
    point: z.object({ j: z.number().int().min(0), x: z.number(), y: z.number() }).strict(),
    /** true = the reviewer knowingly isolates a different person than the framing subject */
    resolvesConflict: z.boolean().default(false),
    basis: z.string(),
    note: z.string().optional(),
    date: z.string().optional(),
  })
  .strict();
export type SubjectOverride = z.infer<typeof SubjectOverrideSchema>;

export const SubjectOverridesSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("HUMAN_SUBJECT_OVERRIDES"),
    projectId: z.string(),
    overrides: z.array(SubjectOverrideSchema),
  })
  .strict()
  .refine((f) => new Set(f.overrides.map((o) => o.id)).size === f.overrides.length, { message: "duplicate override id" })
  .refine((f) => f.overrides.filter((o) => o.status === "APPROVED").every((o, _, a) => a.filter((x) => x.clipId === o.clipId).length === 1), { message: "at most one APPROVED subject override per clip" });
export type SubjectOverrides = z.infer<typeof SubjectOverridesSchema>;

/** The APPROVED override for a clip (or null). PROPOSED overrides are review material only. */
export function approvedSubjectOverride(file: SubjectOverrides | null, clipId: string): SubjectOverride | null {
  return file?.overrides.find((o) => o.clipId === clipId && o.status === "APPROVED") ?? null;
}
