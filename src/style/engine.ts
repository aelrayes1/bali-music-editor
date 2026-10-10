/**
 * Bali Style Skill engine (v5 Phase 10) — pure and deterministic.
 *
 *  - load + validate: every preference traces to human decisions or explicit statements (plan /
 *    user instruction); a preference backed only by reports/metrics is rejected.
 *  - scope: a project sees BALI_GENERAL preferences plus its OWN project-specific ones (no leakage).
 *    A project preference that contradicts a general one overrides it for that project only.
 *  - promotion: a principle becomes BALI_GENERAL only by explicit statement (plan / user) or by
 *    REPEATED EVIDENCE: the same principle and polarity approved on >= 3 distinct projects.
 *  - advice: options are filtered by precedence — current human override > project hard constraint >
 *    technical safety / QC — then ranked by approved project preferences, then Bali general
 *    preferences, then the default heuristic (the given option order). Every choice names the
 *    preferences that decided it and their provenance; nothing is an opaque score.
 *  - learning: only from human decisions. A new explicit decision that contradicts a stored
 *    preference wins for its project (the old project preference is superseded; a general one is
 *    marked challenged, not changed); only an explicit general statement updates general taste.
 */

import { createHash } from "node:crypto";
import { type Condition, type Conflict, type Decision, DecisionLogSchema, type DecisionLog, type Predicate, type Preference, PreferenceSchema, type StyleMemory, StyleMemorySchema } from "./schema.ts";

export const STYLE_ENGINE_VERSION = "1.0.0";
export const REPEATED_EVIDENCE_PROJECTS = 3;
export const PRECEDENCE = ["CURRENT_HUMAN_OVERRIDE", "PROJECT_HARD_CONSTRAINT", "TECHNICAL_SAFETY_QC", "APPROVED_PROJECT_PREFERENCE", "BALI_GENERAL_PREFERENCE", "DEFAULT_HEURISTIC"] as const;
export type Level = (typeof PRECEDENCE)[number];

export interface StyleContext {
  memory: StyleMemory;
  decisions: Decision[];
  sha256: string;
}

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

/** Load and validate a style memory and its decision logs (deterministic: sorted, hashed). */
export function loadStyle(memoryJson: unknown, logsJson: unknown[]): StyleContext {
  const memory = StyleMemorySchema.parse(memoryJson);
  const logs: DecisionLog[] = logsJson.map((l) => DecisionLogSchema.parse(l));
  const decisions = byId(logs.flatMap((l) => l.decisions.map((d) => ({ ...d, projectId: l.projectId }))));
  const ids = new Set(decisions.map((d) => d.id));
  if (ids.size !== decisions.length) throw new Error("duplicate decision ids");
  for (const p of memory.preferences) {
    for (const e of p.evidence) if (e.decisionId && !ids.has(e.decisionId)) throw new Error(`${p.id}: evidence ${e.decisionId} is not a recorded human decision`);
    const human = p.evidence.some((e) => e.decisionId) || p.evidence.some((e) => e.ref && (e.ref.kind === "plan" || e.ref.kind === "instruction"));
    if (!human) throw new Error(`${p.id}: a preference needs a human decision or an explicit statement as evidence (metrics / reports alone never create taste)`);
    if (p.origin === "HUMAN_DECISIONS") for (const e of p.evidence) if (e.decisionId && decisions.find((d) => d.id === e.decisionId)!.projectId !== p.projectId) throw new Error(`${p.id}: cites a decision of another project`);
    // general taste: an explicit origin must cite explicit general statements (not one project's decisions relabelled);
    // a stored repeated-evidence preference must really span >= REPEATED_EVIDENCE_PROJECTS projects
    const cited = p.evidence.flatMap((e) => (e.decisionId ? [decisions.find((d) => d.id === e.decisionId)!] : []));
    if (p.scope === "BALI_GENERAL" && (p.origin === "V5_PLAN" || p.origin === "EXPLICIT_USER_STATEMENT"))
      for (const d of cited) if (d.kind !== "GENERAL_STATEMENT") throw new Error(`${p.id}: a ${p.origin} general preference cites ${d.id} (${d.kind}, ${d.projectId}), which is not an explicit general statement`);
    if (p.origin === "REPEATED_EVIDENCE" && new Set(cited.map((d) => d.projectId)).size < REPEATED_EVIDENCE_PROJECTS) throw new Error(`${p.id}: repeated evidence needs approvals on >= ${REPEATED_EVIDENCE_PROJECTS} distinct projects`);
  }
  const sorted: StyleMemory = { ...memory, technicalRules: byId(memory.technicalRules), policies: byId(memory.policies), preferences: byId(memory.preferences), presets: byId(memory.presets), conflicts: byId(memory.conflicts) };
  const sha256 = createHash("sha256").update(JSON.stringify({ sorted, decisions })).digest("hex");
  return { memory: sorted, decisions, sha256 };
}

export function confidence(p: Preference, decisions: Decision[]): { level: "LOW" | "MEDIUM" | "HIGH"; why: string } {
  if (p.origin === "V5_PLAN") return { level: "HIGH", why: "explicit in the authoritative v5 plan" };
  if (p.origin === "EXPLICIT_USER_STATEMENT") return { level: "HIGH", why: "stated explicitly by the user as a Bali preference" };
  const ds = p.evidence.flatMap((e) => (e.decisionId ? [decisions.find((d) => d.id === e.decisionId)!] : []));
  const projects = new Set(ds.map((d) => d.projectId)).size;
  if (p.origin === "REPEATED_EVIDENCE") return { level: "HIGH", why: `approved on ${projects} projects` };
  return ds.length >= 2 ? { level: "MEDIUM", why: `${ds.length} human decisions on one project` } : { level: "LOW", why: "a single human decision on one project" };
}

/** Principles approved on >= 3 distinct projects that have no general preference yet (derived, not stored). */
export function derivedGeneral(ctx: StyleContext): Preference[] {
  const groups = new Map<string, Preference[]>();
  for (const p of ctx.memory.preferences.filter((x) => x.status === "ACTIVE" && x.scope === "PROJECT_SPECIFIC")) {
    const k = `${p.principle}|${p.polarity}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out: Preference[] = [];
  for (const [k, ps] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const projects = [...new Set(ps.map((p) => p.projectId!))].sort();
    const principle = k.split("|")[0]!;
    if (projects.length < REPEATED_EVIDENCE_PROJECTS) continue;
    if (ctx.memory.preferences.some((g) => g.status === "ACTIVE" && g.scope === "BALI_GENERAL" && g.principle === principle)) continue;
    const first = byId(ps)[0]!;
    out.push(PreferenceSchema.parse({ ...first, id: `derived:${principle.replace(/:/g, "-")}`, scope: "BALI_GENERAL", projectId: null, origin: "REPEATED_EVIDENCE", evidence: ps.flatMap((p) => p.evidence), note: `promoted by repeated evidence: approved on ${projects.join(", ")}` }));
  }
  return out;
}

export interface Effective {
  projectId: string;
  preferences: Preference[];
  overriddenGeneral: Array<{ general: string; by: string }>;
  excludedOtherProjects: number;
}
/** What a project may use: active general (stored + derived) + its own project preferences. */
export function effectivePreferences(ctx: StyleContext, projectId: string): Effective {
  const active = ctx.memory.preferences.filter((p) => p.status === "ACTIVE");
  const own = active.filter((p) => p.scope === "PROJECT_SPECIFIC" && p.projectId === projectId);
  const general = [...active.filter((p) => p.scope === "BALI_GENERAL"), ...derivedGeneral(ctx)];
  const overriddenGeneral: Effective["overriddenGeneral"] = [];
  const keptGeneral = general.filter((g) => {
    const o = own.find((p) => p.principle === g.principle && p.polarity !== g.polarity);
    if (o) overriddenGeneral.push({ general: g.id, by: o.id });
    return !o;
  });
  return { projectId, preferences: byId([...own, ...keptGeneral]), overriddenGeneral, excludedOtherProjects: active.filter((p) => p.scope === "PROJECT_SPECIFIC" && p.projectId !== projectId).length };
}

// ------------------------------------------------------------------------------------------------
// advice
export interface Option {
  id: string;
  label: string;
  properties: Record<string, string | number | boolean>;
}
export interface AdviceRequest {
  projectId: string;
  topic: string;
  question: string;
  context: Record<string, string | number | boolean>;
  options: Option[];
  humanInstructions: Array<{ id: string; text: string; requires?: string[]; forbids?: Predicate[] }>;
  hardConstraints: Array<{ id: string; text: string; forbids: Predicate[] }>;
  technical: Array<{ optionId: string; pass: boolean; failing: string[] }>;
}
export interface Reason {
  level: Level;
  source: string;
  statement: string;
  effect: string;
  provenance: string | null;
}
export interface Advice {
  topic: string;
  question: string;
  recommended: string | null;
  ranking: Array<{ optionId: string; project: number; general: number; order: number }>;
  eliminated: Array<{ optionId: string; level: Level; by: string; why: string }>;
  reasons: Reason[];
  overridden: Array<{ preference: string; level: Level; by: string; why: string }>;
  warnings: string[];
  explanation: string;
}

const cond = (c: Condition, props: Record<string, unknown>): boolean => {
  const v = props[c.property];
  if (v === undefined) return false;
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "neq":
      return v !== c.value;
    case "lte":
      return typeof v === "number" && v <= (c.value as number);
    case "gte":
      return typeof v === "number" && v >= (c.value as number);
    case "in":
      return Array.isArray(c.value) && (c.value as unknown[]).includes(v);
  }
};
export const matches = (p: Predicate, props: Record<string, unknown>) => p.all.every((c) => cond(c, props));
const vote = (p: Preference, o: Option) => (p.favours.some((x) => matches(x, o.properties)) ? 1 : 0) - (p.disfavours.some((x) => matches(x, o.properties)) ? 1 : 0);

export function provenance(ctx: StyleContext, p: Preference): string {
  const c = confidence(p, ctx.decisions);
  const ev = p.evidence.map((e) => (e.decisionId ? `${e.decisionId} (${ctx.decisions.find((d) => d.id === e.decisionId)!.subject}: ${ctx.decisions.find((d) => d.id === e.decisionId)!.direction.toLowerCase()})` : `${e.ref!.kind} ${e.ref!.ref}`));
  return `${p.scope}${p.projectId ? ` ${p.projectId}` : ""}, ${p.origin}, confidence ${c.level} (${c.why}); evidence: ${ev.join("; ")}`;
}

export function advise(ctx: StyleContext, req: AdviceRequest): Advice {
  const eff = effectivePreferences(ctx, req.projectId);
  const applicable = eff.preferences.filter((p) => (p.appliesTo.includes(req.topic) || p.appliesTo.includes("*")) && p.when.every((c) => cond(c, req.context)));
  const required = new Set(req.humanInstructions.flatMap((h) => h.requires ?? []));
  const eliminated: Advice["eliminated"] = [];
  const warnings: string[] = [];
  let pool = req.options;
  // 1. current human override
  if (required.size) {
    for (const o of pool.filter((x) => !required.has(x.id))) eliminated.push({ optionId: o.id, level: "CURRENT_HUMAN_OVERRIDE", by: req.humanInstructions.find((h) => h.requires?.length)!.id, why: "the current human instruction requires another option" });
    pool = pool.filter((x) => required.has(x.id));
  }
  for (const h of req.humanInstructions)
    for (const f of h.forbids ?? [])
      for (const o of pool.filter((x) => matches(f, x.properties))) {
        eliminated.push({ optionId: o.id, level: "CURRENT_HUMAN_OVERRIDE", by: h.id, why: h.text });
        pool = pool.filter((x) => x.id !== o.id);
      }
  // 2. project hard constraints, 3. technical safety — an option the human explicitly requires is kept (the human outranks them) with a warning
  for (const hc of req.hardConstraints)
    for (const f of hc.forbids)
      for (const o of pool.filter((x) => matches(f, x.properties))) {
        if (required.has(o.id)) {
          warnings.push(`${o.id} violates hard constraint ${hc.id} (${hc.text}) but the current human instruction requires it: the human decision wins; confirm it is intended`);
          continue;
        }
        eliminated.push({ optionId: o.id, level: "PROJECT_HARD_CONSTRAINT", by: hc.id, why: hc.text });
        pool = pool.filter((x) => x.id !== o.id);
      }
  for (const t of req.technical.filter((x) => !x.pass)) {
    const o = pool.find((x) => x.id === t.optionId);
    if (!o) continue;
    if (required.has(o.id)) {
      warnings.push(`${o.id} fails technical QC (${t.failing.join(", ")}) but the current human instruction requires it: flagged for human review`);
      continue;
    }
    eliminated.push({ optionId: o.id, level: "TECHNICAL_SAFETY_QC", by: t.failing.join(", "), why: "fails technical QC" });
    pool = pool.filter((x) => x.id !== o.id);
  }
  // 4-6. rank: project preferences, then general preferences, then the given order
  const proj = applicable.filter((p) => p.scope === "PROJECT_SPECIFIC");
  const gen = applicable.filter((p) => p.scope === "BALI_GENERAL");
  const ranking = pool
    .map((o) => ({ optionId: o.id, project: proj.reduce((s, p) => s + vote(p, o), 0), general: gen.reduce((s, p) => s + vote(p, o), 0), order: req.options.indexOf(o) }))
    .sort((a, b) => b.project - a.project || b.general - a.general || a.order - b.order);
  const best = ranking[0] ?? null;
  const second = ranking[1] ?? null;
  const reasons: Reason[] = [];
  for (const e of eliminated) reasons.push({ level: e.level, source: e.by, statement: e.why, effect: `eliminated ${e.optionId}`, provenance: null });
  if (best) {
    const o = pool.find((x) => x.id === best.optionId)!;
    const decidingLevel: Level = !second ? (eliminated.length ? eliminated[0]!.level : "DEFAULT_HEURISTIC") : best.project !== second.project ? "APPROVED_PROJECT_PREFERENCE" : best.general !== second.general ? "BALI_GENERAL_PREFERENCE" : "DEFAULT_HEURISTIC";
    const other = second ? pool.find((x) => x.id === second.optionId)! : null;
    for (const p of [...proj, ...gen]) {
      const v = vote(p, o) - (other ? vote(p, other) : 0);
      if (v > 0) reasons.push({ level: p.scope === "PROJECT_SPECIFIC" ? "APPROVED_PROJECT_PREFERENCE" : "BALI_GENERAL_PREFERENCE", source: p.id, statement: p.statement, effect: `favours ${o.id}${other ? ` over ${other.id}` : ""}`, provenance: provenance(ctx, p) });
    }
    if (decidingLevel === "DEFAULT_HEURISTIC") reasons.push({ level: "DEFAULT_HEURISTIC", source: "option order", statement: "no stored preference separates the remaining options; the first listed (default heuristic) is kept", effect: `keeps ${o.id}`, provenance: null });
  }
  // preferences overruled by a higher level: they favoured an eliminated option or disfavour the choice
  const overridden: Advice["overridden"] = [];
  for (const p of applicable) {
    for (const e of eliminated) {
      const o = req.options.find((x) => x.id === e.optionId)!;
      if (vote(p, o) > 0) overridden.push({ preference: p.id, level: e.level, by: e.by, why: `${p.id} favours ${o.id}, but ${e.level} (${e.by}) removed it` });
    }
    if (best) {
      const o = req.options.find((x) => x.id === best.optionId)!;
      if (vote(p, o) < 0 && required.has(o.id)) overridden.push({ preference: p.id, level: "CURRENT_HUMAN_OVERRIDE", by: [...required].join(","), why: `${p.id} disfavours ${o.id}, but the current human instruction requires it` });
    }
  }
  for (const g of eff.overriddenGeneral) overridden.push({ preference: g.general, level: "APPROVED_PROJECT_PREFERENCE", by: g.by, why: `the project's own preference ${g.by} contradicts ${g.general} and wins for ${req.projectId}` });
  const chosen = best ? req.options.find((x) => x.id === best.optionId)! : null;
  const cite = (r: Reason) => {
    const p = applicable.find((x) => x.id === r.source)!;
    return `\`${p.id}\` (“${p.statement.replace(/\.$/, "")}” — ${p.scope}${p.projectId ? ` ${p.projectId}` : ""}, ${p.origin}, confidence ${confidence(p, ctx.decisions).level}; from ${p.evidence.map((e) => e.decisionId ?? e.ref!.ref).join(", ")})`;
  };
  const prefs = reasons.filter((r) => r.provenance).slice(0, 3);
  const ruledOut = eliminated.length ? `${eliminated.map((e) => `${e.optionId} was ruled out by ${e.level} (${e.by})`).join("; ")}` : "";
  const explanation = !chosen
    ? `${req.question}: no option survives — ${ruledOut}.`
    : !second
      ? `${req.question} → ${chosen.label}: the only option left${ruledOut ? ` (${ruledOut})` : ""}${prefs.length ? `; also consistent with ${prefs.map(cite).join(" and ")}` : ""}.`
      : `${req.question} → ${chosen.label}, because ${prefs.length ? prefs.map(cite).join(" and ") : "no stored preference separates the options (default heuristic: the first listed)"}${ruledOut ? `; ${ruledOut}` : ""}.`;
  return { topic: req.topic, question: req.question, recommended: chosen?.id ?? null, ranking, eliminated, reasons, overridden, warnings, explanation };
}

// ------------------------------------------------------------------------------------------------
// learning (human decisions only)
export interface Learning {
  principle: string;
  polarity: "PREFERRED" | "AVOID";
  statement: string;
  appliesTo: string[];
  favours: Predicate[];
  disfavours: Predicate[];
  when?: Condition[];
}
export interface RecordResult {
  memory: StyleMemory;
  decisions: Decision[];
  changes: string[];
}
export function recordDecision(ctx: StyleContext, decisionInput: unknown, learn: Learning | null): RecordResult {
  const parsed = DecisionLogSchema.shape.decisions.element.safeParse(decisionInput);
  if (!parsed.success) throw new Error(`not a recordable human decision: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — taste is learned only from explicit human decisions, never from scores or metrics`);
  const d = parsed.data;
  if (ctx.decisions.some((x) => x.id === d.id)) throw new Error(`${d.id} already recorded`);
  const changes: string[] = [];
  const prefs = [...ctx.memory.preferences];
  const conflicts: Conflict[] = [...ctx.memory.conflicts];
  const cid = () => `conflict:${d.id.replace(/:/g, "-")}-${conflicts.length + 1}`;
  if (learn) {
    const general = d.kind === "GENERAL_STATEMENT";
    const scopeMatch = (p: Preference) => p.status === "ACTIVE" && p.principle === learn.principle && (general ? p.scope === "BALI_GENERAL" : p.scope === "PROJECT_SPECIFIC" && p.projectId === d.projectId);
    const existing = prefs.find(scopeMatch);
    const base = { principle: learn.principle, statement: learn.statement, polarity: learn.polarity, appliesTo: learn.appliesTo, favours: learn.favours, disfavours: learn.disfavours, when: learn.when ?? [], since: d.date, status: "ACTIVE" as const, supersededBy: null, note: null };
    const ev = general ? [{ decisionId: d.id, ref: { kind: "instruction" as const, ref: d.id, note: d.statement } }] : [{ decisionId: d.id, ref: null }];
    if (existing && existing.polarity === learn.polarity) {
      prefs.splice(prefs.indexOf(existing), 1, PreferenceSchema.parse({ ...existing, evidence: [...existing.evidence, ...ev], version: existing.version + 1 }));
      changes.push(`${existing.id}: reinforced by ${d.id} (v${existing.version + 1})`);
    } else {
      const id = existing ? `${existing.id}-v${existing.version + 1}` : general ? `bali:${learn.principle.split(":").at(-1)}` : `${d.projectId}:${learn.principle.split(":").at(-1)}`;
      const created = PreferenceSchema.parse({ ...base, id, scope: general ? "BALI_GENERAL" : "PROJECT_SPECIFIC", projectId: general ? null : d.projectId, origin: general ? "EXPLICIT_USER_STATEMENT" : "HUMAN_DECISIONS", evidence: ev, version: existing ? existing.version + 1 : 1 });
      if (existing) {
        prefs.splice(prefs.indexOf(existing), 1, { ...existing, status: "SUPERSEDED", supersededBy: id });
        conflicts.push({ id: cid(), date: d.date, decisionId: d.id, preferenceId: existing.id, resolution: general ? "GENERAL_PREFERENCE_UPDATED_BY_EXPLICIT_STATEMENT" : "PROJECT_PREFERENCE_SUPERSEDED", note: `${d.id} (${d.date}) contradicts ${existing.id}; the current explicit decision wins` });
        changes.push(`${existing.id}: superseded by ${id} (${d.id})`);
      } else changes.push(`${id}: created from ${d.id}`);
      prefs.push(created);
      if (!general)
        for (const g of prefs.filter((p) => p.status === "ACTIVE" && p.scope === "BALI_GENERAL" && p.principle === learn.principle && p.polarity !== learn.polarity)) {
          conflicts.push({ id: cid(), date: d.date, decisionId: d.id, preferenceId: g.id, resolution: "PROJECT_OVERRIDE_CURRENT_DECISION_WINS", note: `${d.projectId} overrides ${g.id} for itself; general taste is not changed by one project` });
          conflicts.push({ id: cid(), date: d.date, decisionId: d.id, preferenceId: g.id, resolution: "GENERAL_PREFERENCE_CHALLENGED_PENDING_REVIEW", note: `${g.id} challenged by ${d.id}; it changes only by an explicit general statement or repeated evidence` });
          changes.push(`${g.id}: overridden for ${d.projectId} only; challenge recorded`);
        }
    }
  }
  const memory = StyleMemorySchema.parse({ ...ctx.memory, version: ctx.memory.version + 1, updated: d.date, preferences: byId(prefs), conflicts: byId(conflicts) });
  return { memory, decisions: byId([...ctx.decisions, d]), changes };
}

// ------------------------------------------------------------------------------------------------
// explanation of a past selection (reads the record; never re-decides)
export interface SelectionExplanation {
  projectId: string;
  subject: string;
  chain: Array<{ id: string; date: string; kind: string; direction: string; subject: string; over: string[]; statement: string; quote: string | null; metricsNote: string[] }>;
  preferences: Array<{ id: string; polarity: string; scope: string; status: string; supersededBy: string | null; statement: string; provenance: string }>;
  policies: string[];
  lines: string[];
}
export function explainSelection(ctx: StyleContext, projectId: string, subject: string): SelectionExplanation {
  const ds = ctx.decisions.filter((d) => d.projectId === projectId);
  const root = ds.filter((d) => d.subject === subject);
  if (!root.length) throw new Error(`no human decision about ${subject} in ${projectId}`);
  const seen = new Set<string>();
  const walk = (d: Decision) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    for (const r of d.relatesTo) {
      const x = ds.find((y) => y.id === r);
      if (x) walk(x);
    }
  };
  root.forEach(walk);
  const chain = ds.filter((d) => seen.has(d.id)).map((d) => ({ id: d.id, date: d.date, kind: d.kind, direction: d.direction, subject: d.subject, over: d.over, statement: d.statement, quote: d.quote, metricsNote: d.supportingMetrics.map((m) => `${m.metric} = ${JSON.stringify(m.value)} (${m.note})`) }));
  // a past selection is explained by the preferences its decisions supported, including ones a later decision has since
  // superseded (history is kept and labelled, never silently dropped)
  const prefs = ctx.memory.preferences.filter((p) => p.evidence.some((e) => e.decisionId && seen.has(e.decisionId)));
  const policies = ctx.memory.policies.map((p) => `${p.id}: ${p.statement}`);
  const lines = [
    `Why ${subject} (${projectId}), from ${chain.length} recorded human decisions:`,
    ...chain.map((c) => `- ${c.id} ${c.date} ${c.kind} — ${c.subject} ${c.direction.toLowerCase()}${c.over.length ? ` over ${c.over.join(", ")}` : ""}: ${c.statement}${c.metricsNote.length ? ` [metrics attached as evidence only: ${c.metricsNote.join("; ")}]` : ""}`),
    `Preferences these decisions support:`,
    ...prefs.map((p) => `- ${p.id} (${p.polarity}, ${p.scope}${p.status === "SUPERSEDED" ? `; SUPERSEDED by ${p.supersededBy}` : ""}): ${p.statement}`),
  ];
  return { projectId, subject, chain, preferences: prefs.map((p) => ({ id: p.id, polarity: p.polarity, scope: p.scope, status: p.status, supersededBy: p.supersededBy, statement: p.statement, provenance: provenance(ctx, p) })), policies, lines };
}
