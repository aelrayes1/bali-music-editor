/**
 * Bali Style Skill / approved preference memory (v5 Phase 10).
 *
 * Gate (v5 p.17): "Style memory must accelerate taste without overfitting or overriding the brief."
 * "Do not let historical preferences override the current brief. Do not auto-update global taste
 * from one project. Require repeated evidence or explicit approval."
 *
 * Three strictly separate layers:
 *  - TECHNICAL RULES: objective, verified by QC checks (not taste; never learned, never voted on);
 *  - POLICIES: how style memory may be used and updated (precedence, evidence requirements);
 *  - PREFERENCES: Bali creative taste — PREFERRED or AVOID, PROJECT_SPECIFIC or BALI_GENERAL, each with
 *    provenance back to explicit human decisions / statements (never to metrics alone).
 * Presets (performance, nightlife, lifestyle, teaser, drop-focused) bundle general preferences
 * qualitatively; they carry no invented numeric taste.
 */

import { z } from "zod";

const Id = z.string().regex(/^[a-z0-9-]+(:[a-z0-9-]+)+$/);
const Date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Ref = z.object({ kind: z.enum(["artifact", "record", "report", "plan", "instruction"]), ref: z.string(), note: z.string() }).strict();

/** A property condition on an option (declarative, inspectable; no code in memory). */
export const ConditionSchema = z
  .object({
    property: z.string(),
    op: z.enum(["eq", "neq", "lte", "gte", "in"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
  })
  .strict();
export type Condition = z.infer<typeof ConditionSchema>;
/** All conditions must hold. */
export const PredicateSchema = z.object({ all: z.array(ConditionSchema).min(1) }).strict();
export type Predicate = z.infer<typeof PredicateSchema>;

/** A human decision: the only evidence source for taste. Metrics may be attached, never decisive. */
export const DecisionSchema = z
  .object({
    id: Id,
    projectId: z.string(),
    date: Date,
    decidedBy: z.literal("human"),
    kind: z.enum(["SELECTION", "APPROVAL", "REJECTION", "INSTRUCTION", "GENERAL_STATEMENT"]),
    subject: z.string(),
    direction: z.enum(["APPROVED", "REJECTED", "PREFERRED", "RETAINED_AS_REFERENCE"]),
    over: z.array(z.string()),
    statement: z.string(),
    quote: z.string().nullable(),
    evidence: z.array(Ref),
    supportingMetrics: z.array(z.object({ metric: z.string(), value: z.unknown(), note: z.string() }).strict()),
    relatesTo: z.array(Id),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export const Scope = z.enum(["PROJECT_SPECIFIC", "BALI_GENERAL"]);
export const Origin = z.enum(["V5_PLAN", "EXPLICIT_USER_STATEMENT", "HUMAN_DECISIONS", "REPEATED_EVIDENCE"]);

export const PreferenceSchema = z
  .object({
    id: Id,
    principle: Id,
    statement: z.string(),
    polarity: z.enum(["PREFERRED", "AVOID"]),
    scope: Scope,
    projectId: z.string().nullable(),
    origin: Origin,
    appliesTo: z.array(z.string()).min(1),
    /** options this preference speaks for / against (empty = explanatory guidance only) */
    favours: z.array(PredicateSchema),
    disfavours: z.array(PredicateSchema),
    /** "when appropriate": the preference only applies when these hold on the request context */
    when: z.array(ConditionSchema),
    evidence: z.array(z.object({ decisionId: Id.nullable(), ref: Ref.nullable() }).strict()).min(1),
    since: Date,
    version: z.number().int().min(1),
    status: z.enum(["ACTIVE", "SUPERSEDED"]),
    supersededBy: Id.nullable(),
    note: z.string().nullable(),
  })
  .strict()
  .refine((p) => (p.scope === "PROJECT_SPECIFIC") === (p.projectId !== null), "PROJECT_SPECIFIC preferences name their project; BALI_GENERAL ones do not")
  .refine((p) => p.scope === "PROJECT_SPECIFIC" || p.origin !== "HUMAN_DECISIONS", "one project's decisions never make a BALI_GENERAL preference by themselves");
export type Preference = z.infer<typeof PreferenceSchema>;

export const TechnicalRuleSchema = z
  .object({ id: Id, statement: z.string(), enforcedBy: z.array(z.string()).min(1), note: z.string() })
  .strict();
export type TechnicalRule = z.infer<typeof TechnicalRuleSchema>;

export const PolicySchema = z.object({ id: Id, statement: z.string(), source: Ref }).strict();
export type Policy = z.infer<typeof PolicySchema>;

export const PresetSchema = z
  .object({
    id: Id,
    name: z.string(),
    origin: z.literal("V5_PLAN"),
    status: z.enum(["PLAN_DEFINED", "APPROVED_ON_PROJECTS"]),
    approvedOn: z.array(z.string()),
    intent: z.string(),
    pacing: z.string(),
    fx: z.string(),
    energyArc: z.string(),
    subject: z.string(),
    preferenceIds: z.array(Id),
  })
  .strict();
export type Preset = z.infer<typeof PresetSchema>;

export const ConflictSchema = z
  .object({
    id: Id,
    date: Date,
    decisionId: Id,
    preferenceId: Id,
    resolution: z.enum(["PROJECT_OVERRIDE_CURRENT_DECISION_WINS", "PROJECT_PREFERENCE_SUPERSEDED", "GENERAL_PREFERENCE_UPDATED_BY_EXPLICIT_STATEMENT", "GENERAL_PREFERENCE_CHALLENGED_PENDING_REVIEW"]),
    note: z.string(),
  })
  .strict();
export type Conflict = z.infer<typeof ConflictSchema>;

export const StyleMemorySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("BALI_STYLE_MEMORY"),
    version: z.number().int().min(1),
    updated: Date,
    technicalRules: z.array(TechnicalRuleSchema),
    policies: z.array(PolicySchema),
    preferences: z.array(PreferenceSchema),
    presets: z.array(PresetSchema),
    conflicts: z.array(ConflictSchema),
  })
  .strict();
export type StyleMemory = z.infer<typeof StyleMemorySchema>;

export const DecisionLogSchema = z.object({ schemaVersion: z.literal("1.0.0"), kind: z.literal("HUMAN_DECISION_LOG"), projectId: z.string(), decisions: z.array(DecisionSchema) }).strict();
export type DecisionLog = z.infer<typeof DecisionLogSchema>;
