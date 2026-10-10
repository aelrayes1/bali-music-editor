/**
 * Semantic overrides (user-authored, versioned, auditable) and the resolved semantic view that
 * Phase 4 reads. Raw model output (semantic-shot-analysis.json) is never modified: the resolved view
 * records, per field, the model value, the final value, its source and the override ids.
 */

import { z } from "zod";
import { FramingSchema, OrientationSchema, type SemanticIndex, type SemanticMedia } from "./schema.ts";

export const SEMANTIC_OVERRIDES_VERSION = "1.0.0";

const Target = z.object({ mediaId: z.string(), shotId: z.string().optional(), takeId: z.string().optional() }).strict().refine((t) => !!t.shotId !== !!t.takeId, "target a shot or a take");
export const SemanticOverrideSchema = z.discriminatedUnion("field", [
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("identity"), value: z.string().min(1), note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("framing"), value: FramingSchema, note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("subjectOrientation"), value: OrientationSchema, note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("screenDirection"), value: z.enum(["left_to_right", "right_to_left", "toward_camera", "away_from_camera", "none"]), note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("addTag"), value: z.string().min(1), note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("removeTag"), value: z.string().min(1), note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("heroCandidate"), value: z.boolean(), note: z.string().optional(), date: z.string() }).strict(),
  z.object({ id: z.string().regex(/^usr:/), target: Target, field: z.literal("exclude"), value: z.boolean(), note: z.string().optional(), date: z.string() }).strict(),
]);
export const SemanticOverridesSchema = z.object({ schemaVersion: z.literal(SEMANTIC_OVERRIDES_VERSION), projectId: z.string(), overrides: z.array(SemanticOverrideSchema) }).strict();
export type SemanticOverrides = z.infer<typeof SemanticOverridesSchema>;

type Field<T> = { value: T; source: "model" | "user"; modelValue: T; confidence: number; overrideIds: string[] };

export interface ResolvedSemanticShot {
  mediaId: string;
  shotId: string;
  takeId: string | null;
  identity: Field<string | null>;
  framing: Field<string>;
  subjectOrientation: Field<string>;
  screenDirection: Field<string>;
  tags: { value: string[]; added: string[]; removed: string[]; overrideIds: string[] };
  heroCandidate: Field<boolean | null>;
  excluded: Field<boolean>;
  features: SemanticMedia["shots"][number]["features"];
  visualNovelty: SemanticIndex["shots"][number]["visualNovelty"];
  duplicateGroup: string | null;
  continuity: SemanticIndex["shots"][number]["continuity"];
}

export function resolveSemantics(docs: SemanticMedia[], index: SemanticIndex, ov: SemanticOverrides | null): { shots: ResolvedSemanticShot[]; warnings: Array<{ code: string; message: string }> } {
  const warnings: Array<{ code: string; message: string }> = [];
  const idxOf = new Map(index.shots.map((s) => [`${s.mediaId}/${s.shotId}`, s]));
  const takeOf = new Map<string, string>();
  for (const d of docs) for (const t of d.takes) for (const s of t.shotIds) takeOf.set(`${d.mediaId}/${s}`, t.takeId);
  const seen = new Set<string>();
  for (const o of ov?.overrides ?? []) {
    if (seen.has(o.id)) throw new Error(`duplicate semantic override id ${o.id}`);
    seen.add(o.id);
  }
  const applies = (o: SemanticOverrides["overrides"][number], mediaId: string, shotId: string) =>
    o.target.mediaId === mediaId && (o.target.shotId ? o.target.shotId === shotId : takeOf.get(`${mediaId}/${shotId}`) === o.target.takeId);
  for (const o of ov?.overrides ?? []) {
    const exists = docs.some((d) => d.mediaId === o.target.mediaId && (o.target.shotId ? d.shots.some((s) => s.shotId === o.target.shotId) : d.takes.some((t) => t.takeId === o.target.takeId)));
    if (!exists) warnings.push({ code: "OVERRIDE_TARGET_MISSING", message: `${o.id}: ${JSON.stringify(o.target)} not found` });
  }
  const shots = docs.flatMap((d) =>
    d.shots.map((s) => {
      const mine = (ov?.overrides ?? []).filter((o) => applies(o, d.mediaId, s.shotId));
      const field = <T,>(name: string, model: T, conf: number): Field<T> => {
        const os = mine.filter((o) => o.field === name);
        const last = os.at(-1);
        return last ? { value: last.value as T, source: "user", modelValue: model, confidence: 1, overrideIds: os.map((o) => o.id) } : { value: model, source: "model", modelValue: model, confidence: conf, overrideIds: [] };
      };
      const modelTags = [...s.content, ...s.context].filter((t) => t.confidence >= 0.4 && t.label !== "unknown").map((t) => t.label);
      const added = mine.filter((o) => o.field === "addTag").map((o) => o.value as string);
      const removed = mine.filter((o) => o.field === "removeTag").map((o) => o.value as string);
      const ix = idxOf.get(`${d.mediaId}/${s.shotId}`);
      return {
        mediaId: d.mediaId,
        shotId: s.shotId,
        takeId: takeOf.get(`${d.mediaId}/${s.shotId}`) ?? null,
        identity: field<string | null>("identity", null, 0),
        framing: field<string>("framing", s.framing.value, s.framing.confidence),
        subjectOrientation: field<string>("subjectOrientation", s.subjectOrientation.value, s.subjectOrientation.confidence),
        screenDirection: field<string>("screenDirection", s.subjectMotion.screenDirection.value, s.subjectMotion.screenDirection.confidence),
        tags: { value: [...new Set([...modelTags.filter((t) => !removed.includes(t)), ...added])].sort(), added, removed, overrideIds: mine.filter((o) => o.field === "addTag" || o.field === "removeTag").map((o) => o.id) },
        heroCandidate: field<boolean | null>("heroCandidate", null, 0),
        excluded: field<boolean>("exclude", false, 1),
        features: s.features,
        visualNovelty: ix?.visualNovelty ?? { score: 0.5, reasons: ["not indexed"] },
        duplicateGroup: ix?.duplicateGroup ?? null,
        continuity: ix?.continuity ?? [],
      };
    }),
  );
  return { shots, warnings };
}
