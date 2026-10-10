/**
 * Project brief (versioned, user-authored): future Edit Planner constraints for an acceptance test.
 * It stores intent only — which source pool covers which span, hard handoffs, mandatory sync
 * targets — by reference to resolved music event ids. It is never an edit and executes nothing.
 *
 * `resolveBrief` turns the references into exact times using the resolved music view and the media
 * manifest, and fails if the readable `expected` times drift from the resolved events by > 1 ms.
 */

import { z } from "zod";
import type { MediaManifest } from "../media/schema.ts";
import type { ResolvedMusicEvents } from "../music/schema.ts";
import { type Rational, compare, sub, toNumberApprox } from "../time/rational.ts";
import { literalToSeconds, parseTimeLiteral } from "../time/time.ts";

export const BRIEF_SCHEMA_VERSION = "1.0.0";

const Lit = z.string().min(2);
const Pool = z
  .object({ rootIds: z.array(z.string()).default([]), mediaIds: z.array(z.string()).default([]), exclusive: z.boolean() })
  .strict()
  .refine((p) => p.rootIds.length + p.mediaIds.length > 0, "a source pool needs rootIds or mediaIds");

export const ProjectBriefSchema = z
  .object({
    schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
    projectId: z.string(),
    kind: z.literal("future-acceptance-test"),
    status: z.string(),
    audio: z.object({ mediaId: z.string(), startEventId: z.string(), endEventId: z.string(), approximate: z.boolean() }).strict(),
    visualSegments: z
      .array(
        z
          .object({
            id: z.string().regex(/^seg:[a-z0-9-]+$/),
            description: z.string(),
            /** who the segment is about (matched against user identity overrides; Phase 4 opening) */
            subject: z.string().optional(),
            startEventId: z.string(),
            endEventId: z.string(),
            expected: z.object({ start: Lit, end: Lit }).strict(),
            sourcePool: Pool,
          })
          .strict(),
      )
      .min(1),
    hardHandoffs: z.array(
      z
        .object({
          id: z.string().regex(/^handoff:[a-z0-9-]+$/),
          kind: z.literal("hard_visual_switch"),
          eventId: z.string(),
          expected: Lit,
          fromSegment: z.string(),
          toSegment: z.string(),
          mandatory: z.literal(true),
          note: z.string().optional(),
        })
        .strict(),
    ),
    syncTargets: z.array(
      z
        .object({
          id: z.string().regex(/^sync:[a-z0-9-]+$/),
          patternId: z.string(),
          occurrenceIds: z.array(z.string()).min(1),
          expected: z.array(Lit),
          mandatory: z.literal(true),
          effectRepeats: z.object({ expected: z.array(Lit), mandatory: z.literal(false), use: z.string() }).strict(),
        })
        .strict(),
    ),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;

export interface ResolvedBrief {
  projectId: string;
  audio: { mediaId: string; start: Rational; end: Rational };
  segments: Array<{ id: string; start: Rational; end: Rational; mediaIds: string[]; exclusive: boolean; description: string; subject: string | null }>;
  handoffs: Array<{ id: string; time: Rational; eventId: string; fromSegment: string; toSegment: string; overrideIds: string[] }>;
  syncTargets: Array<{ id: string; primaries: Array<{ occurrenceId: string; eventId: string; time: Rational }>; effectRepeats: Array<{ occurrenceId: string; eventId: string; time: Rational }> }>;
}

const lit = (s: string) => literalToSeconds(parseTimeLiteral(s));

export function resolveBrief(brief: ProjectBrief, resolved: ResolvedMusicEvents, manifest: MediaManifest): ResolvedBrief {
  const byId = new Map(resolved.events.map((e) => [e.id, e]));
  const at = (id: string, expected: string, what: string) => {
    const e = byId.get(id);
    if (!e) throw new Error(`${what}: resolved event ${id} not found`);
    const d = Math.abs(toNumberApprox(sub(e.time, lit(expected)))) * 1000;
    if (d > 1) throw new Error(`${what}: ${id} resolves to ${toNumberApprox(e.time).toFixed(6)} s, expected ${expected} (${d.toFixed(3)} ms off)`);
    return e;
  };
  if (brief.audio.mediaId !== resolved.sourceMediaId) throw new Error(`brief audio ${brief.audio.mediaId} vs resolved ${resolved.sourceMediaId}`);
  const pool = (p: ProjectBrief["visualSegments"][number]["sourcePool"]) => {
    const ids = new Set(p.mediaIds);
    for (const m of manifest.media) if (p.rootIds.includes(m.source.rootId) && m.isPlayableVideoFootage && !m.duplicateOf) ids.add(m.mediaId);
    for (const id of ids) {
      const m = manifest.media.find((x) => x.mediaId === id);
      if (!m || !m.isPlayableVideoFootage) throw new Error(`source pool media ${id} is not playable footage in the manifest`);
    }
    return [...ids].sort();
  };
  const segments = brief.visualSegments.map((s) => ({
    id: s.id,
    start: at(s.startEventId, s.expected.start, s.id).time,
    end: at(s.endEventId, s.expected.end, s.id).time,
    mediaIds: pool(s.sourcePool),
    exclusive: s.sourcePool.exclusive,
    description: s.description,
    subject: s.subject ?? null,
  }));
  for (let i = 1; i < segments.length; i++) {
    if (compare(segments[i - 1]!.end, segments[i]!.start) !== 0) throw new Error(`segments ${segments[i - 1]!.id} and ${segments[i]!.id} do not meet exactly`);
  }
  const handoffs = brief.hardHandoffs.map((h) => {
    const e = at(h.eventId, h.expected, h.id);
    const from = segments.find((s) => s.id === h.fromSegment);
    const to = segments.find((s) => s.id === h.toSegment);
    if (!from || !to || compare(from.end, e.time) !== 0 || compare(to.start, e.time) !== 0) throw new Error(`${h.id}: not the exact boundary of ${h.fromSegment} -> ${h.toSegment}`);
    if (!e.mandatory || e.tier !== "USER_REQUIRED") throw new Error(`${h.id}: ${e.id} is not a mandatory USER_REQUIRED event`);
    return { id: h.id, time: e.time, eventId: e.id, fromSegment: h.fromSegment, toSegment: h.toSegment, overrideIds: e.overrideIds };
  });
  const syncTargets = brief.syncTargets.map((t) => {
    const events = resolved.events.filter((e) => e.patternId === t.patternId && e.occurrence);
    const primaries = t.occurrenceIds.map((oid, i) => {
      const e = events.find((x) => x.occurrence!.occurrenceId === oid && x.occurrence!.role === "primary");
      if (!e) throw new Error(`${t.id}: no resolved primary for ${oid}`);
      at(e.id, t.expected[i] ?? "", `${t.id}/${oid}`);
      if (!e.mandatory) throw new Error(`${t.id}: primary ${e.id} is not mandatory`);
      return { occurrenceId: oid, eventId: e.id, time: e.time };
    });
    const effectRepeats = events
      .filter((e) => e.occurrence!.role === "effect_repeat" && t.occurrenceIds.includes(e.occurrence!.occurrenceId))
      .map((e) => ({ occurrenceId: e.occurrence!.occurrenceId, eventId: e.id, time: e.time }));
    if (effectRepeats.some((r) => byId.get(r.eventId)!.mandatory)) throw new Error(`${t.id}: an effect repeat is mandatory`);
    const want = t.effectRepeats.expected.map(lit);
    if (want.length !== effectRepeats.length || want.some((w, i) => Math.abs(toNumberApprox(sub(effectRepeats[i]!.time, w))) > 0.001)) {
      throw new Error(`${t.id}: effect repeats differ from the brief`);
    }
    return { id: t.id, primaries, effectRepeats };
  });
  const aStart = at(brief.audio.startEventId, brief.visualSegments[0]!.expected.start, "audio").time;
  const aEnd = byId.get(brief.audio.endEventId)?.time;
  if (!aEnd) throw new Error(`audio end ${brief.audio.endEventId} not found`);
  return { projectId: brief.projectId, audio: { mediaId: brief.audio.mediaId, start: aStart, end: aEnd }, segments, handoffs, syncTargets };
}
