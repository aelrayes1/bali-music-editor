/**
 * Resolve detected music events + user sync file into the view the Edit Planner consumes.
 *
 * Raw analysis is never modified. Every resolved event records where it came from
 * (detected / user), which pattern or overrides touched it, and an identity status.
 *
 * Identity rules for pattern matches (e.g. "every 'hook' between 1:20 and 1:30"):
 *  - CONFIRMED only when a human says so (a `confirm` override, or a user-timed vocal_hit).
 *  - HIGH_CONFIDENCE_CANDIDATE when the attack belongs to the window's dominant repeated-pattern
 *    cluster with tonal evidence.
 *  - NEEDS_HUMAN_CONFIRMATION otherwise.
 * All pattern matches are mandatory targets (the user asked for every occurrence); identity
 * status tells the planner and the reviewer how sure we are that each one is the word.
 *
 * Optional Phase 2.5 vocal assist (vocal-transcription.json): applied after the Phase 2 statuses
 * and before user overrides. It can grade a candidate (CONFIRMED_BY_SIGNAL / HIGH_CONFIDENCE_CANDIDATE
 * / NEEDS_HUMAN_CONFIRMATION), demote it (REJECTED -> non-mandatory DETAIL, still listed), or add a
 * heard occurrence Phase 2 missed. It never moves a time off a detected signal event. Without an
 * assist the output is exactly the Phase 2 (1.0.0) view. User overrides are applied last and win.
 */

import { createHash } from "node:crypto";
import { add, compare, div, rational, sub, toNumberApprox } from "../time/rational.ts";
import { literalToSeconds, parseTimeLiteral } from "../time/time.ts";
import type { VocalOccurrences } from "../vocal/occurrences.ts";
import type { VocalTranscription } from "../vocal/schema.ts";
import { canonicalJson } from "./analyze.ts";
import {
  MUSIC_SCHEMA_VERSION,
  RESOLVED_GT_SCHEMA_VERSION,
  RESOLVED_SCHEMA_VERSION,
  type MusicAnalysis,
  type MusicEvent,
  type MusicSync,
  MusicSyncSchema,
  type ResolvedEvent,
  type ResolvedMusicEvents,
  ResolvedMusicEventsSchema,
  type Tier,
} from "./schema.ts";

export const TIER_ORDER: Tier[] = ["USER_REQUIRED", "STRUCTURAL", "DOWNBEAT", "BEAT", "DETAIL"];

function seconds(literal: string) {
  const lit = parseTimeLiteral(literal);
  if (lit.unit !== "seconds") throw new SyntaxError(`sync times must be seconds or clock literals, got ${literal}`);
  return literalToSeconds(lit);
}

export function parseSync(raw: unknown): MusicSync {
  const sync = MusicSyncSchema.parse(raw);
  // Validate every time literal eagerly (unit-explicit, no bare numbers).
  for (const e of sync.requiredEvents) seconds(e.time);
  for (const p of sync.requiredPatterns) {
    if (compare(seconds(p.window.end), seconds(p.window.start)) <= 0) throw new RangeError(`${p.id}: empty window`);
  }
  for (const o of sync.eventOverrides) {
    if (o.time) seconds(o.time);
    if (o.action === "pin") {
      const d = Math.abs(toNumberApprox(sub(rational(o.exactTime!.num, o.exactTime!.den), seconds(o.time!)))) * 1000;
      if (d > 1) throw new RangeError(`${o.id}: exactTime differs from ${o.time} by ${d.toFixed(3)} ms`);
    }
  }
  for (const g of sync.occurrenceGroundTruth ?? []) {
    const p = sync.requiredPatterns.find((x) => x.id === g.patternId);
    if (!p) throw new Error(`ground truth for unknown pattern ${g.patternId}`);
    for (const o of g.occurrences) {
      const a = seconds(o.window.start);
      const b = seconds(o.window.end);
      if (compare(b, a) <= 0) throw new RangeError(`${o.id}: empty window`);
      if (compare(a, seconds(p.window.start)) < 0 || compare(b, seconds(p.window.end)) > 0) throw new RangeError(`${o.id}: window outside ${p.id}`);
      if (o.approval) {
        const t = seconds(o.approval.time);
        if (compare(t, a) < 0 || compare(t, b) >= 0) throw new RangeError(`${o.id}: approved time ${o.approval.time} is outside its window`);
      }
    }
  }
  const ids = [
    ...sync.requiredEvents.map((e) => e.id),
    ...sync.requiredPatterns.map((p) => p.id),
    ...sync.eventOverrides.map((o) => o.id),
    ...(sync.occurrenceGroundTruth ?? []).flatMap((g) => g.occurrences.map((o) => o.id)),
  ];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate sync id ${dup}`);
  return sync;
}

export const TIER_RANK: Record<Tier, number> = { USER_REQUIRED: 0, STRUCTURAL: 1, DOWNBEAT: 2, BEAT: 3, DETAIL: 4 };

export function resolveEvents(
  analysis: MusicAnalysis,
  sync: MusicSync | null,
  vocalAssist: VocalTranscription | null = null,
  groundTruth: VocalOccurrences[] = [],
): ResolvedMusicEvents {
  const warnings: ResolvedMusicEvents["warnings"] = [];
  if (sync && sync.sourceMediaId !== analysis.source.mediaId) {
    throw new Error(`sync file is for ${sync.sourceMediaId}, analysis is for ${analysis.source.mediaId}`);
  }
  let assist = vocalAssist;
  if (assist && assist.sourceMediaId !== analysis.source.mediaId) {
    throw new Error(`vocal transcription is for ${assist.sourceMediaId}, analysis is for ${analysis.source.mediaId}`);
  }
  if (assist && (assist.phase2.configHash !== analysis.analyzer.configHash || assist.phase2.analyzerVersion !== analysis.analyzer.version)) {
    warnings.push({
      code: "VOCAL_ASSIST_STALE",
      message: `vocal transcription was built on Phase 2 ${assist.phase2.analyzerVersion}/${assist.phase2.configHash}; ignored (Phase 2 fallback)`,
    });
    assist = null;
  }
  const out = new Map<string, ResolvedEvent>();
  const gtApplied: NonNullable<ResolvedMusicEvents["groundTruth"]> = [];
  const put = (e: ResolvedEvent) => {
    const prev = out.get(e.id);
    if (!prev || TIER_RANK[e.tier] < TIER_RANK[prev.tier]) out.set(e.id, e);
  };
  const detected = (e: MusicEvent, tier: Tier, evidence: string | null = null): ResolvedEvent => ({
    id: e.id,
    type: e.type,
    time: e.time,
    tier,
    mandatory: false,
    label: null,
    identityStatus: null,
    confidence: e.confidence,
    origin: "detected",
    detectedEventId: e.id,
    patternId: null,
    overrideIds: [],
    nearestBeatId: e.nearestBeatId,
    beatOffsetMs: e.beatOffsetMs,
    evidence: evidence ?? e.method,
  });

  // Structural and metrical events.
  for (const e of analysis.events) {
    if (e.type === "drop") put(detected(e, "STRUCTURAL"));
    else if (e.type === "impact" && e.confidence >= 0.4) put(detected(e, "STRUCTURAL"));
    else if (e.type === "vocal_attack") put(detected(e, "DETAIL"));
    else if (e.type === "onset" && e.confidence >= 0.5) put(detected(e, "DETAIL"));
  }
  for (const p of analysis.phrases) {
    put({
      id: p.id, type: "phrase_boundary", time: p.time, tier: "STRUCTURAL", mandatory: false, label: null,
      identityStatus: null, confidence: p.confidence, origin: "detected", detectedEventId: p.id, patternId: null,
      overrideIds: [], nearestBeatId: null, beatOffsetMs: 0, evidence: p.method,
    });
  }
  for (const r of analysis.regions.filter((x) => x.type === "break" || x.type === "build")) {
    put({
      id: `${r.id}#start`, type: `${r.type}_start`, time: r.start, tier: "STRUCTURAL", mandatory: false, label: null,
      identityStatus: null, confidence: r.confidence, origin: "detected", detectedEventId: r.id, patternId: null,
      overrideIds: [], nearestBeatId: null, beatOffsetMs: null, evidence: r.method,
    });
  }
  for (const b of analysis.beats) {
    put({
      id: b.id, type: b.isDownbeat ? "downbeat" : "beat", time: b.time, tier: b.isDownbeat ? "DOWNBEAT" : "BEAT",
      mandatory: false, label: b.isDownbeat ? `bar ${b.barIndex}` : null, identityStatus: null,
      confidence: analysis.tempo.bpmConfidence, origin: "detected", detectedEventId: b.id, patternId: null,
      overrideIds: [], nearestBeatId: b.id, beatOffsetMs: 0, evidence: "beat grid",
    });
  }

  if (sync) {
    // Required patterns: every matching detected event in the window becomes a mandatory target.
    for (const p of sync.requiredPatterns) {
      const start = seconds(p.window.start);
      const end = seconds(p.window.end);
      const matches = analysis.events.filter(
        (e) => p.matchEventTypes.includes(e.type) && compare(e.time, start) >= 0 && compare(e.time, end) < 0,
      );
      // Dominant cluster: the best repeating pattern present in the window (size x tightness).
      const clusterInfo = new Map(analysis.vocal.clusters.map((c) => [c.id, c]));
      const counts = new Map<string, number>();
      for (const m of matches) if (m.vocal?.clusterId) counts.set(m.vocal.clusterId, (counts.get(m.vocal.clusterId) ?? 0) + 1);
      const dominant =
        [...counts.entries()]
          .filter(([, n]) => n >= 2)
          .map(([id, n]) => ({ id, score: n * (clusterInfo.get(id)?.meanSimilarity ?? 0) }))
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]?.id ?? null;
      if (matches.length === 0) warnings.push({ code: "PATTERN_NO_CANDIDATES", message: `${p.id}: no detected candidates in window` });
      const useAssist = assist !== null && assist.patternId === p.id;
      const assessments = new Map((useAssist ? assist!.candidateAssessments : []).map((a) => [a.eventId, a]));
      const occurrences = new Map((useAssist ? assist!.occurrences : []).map((o) => [o.id, o]));
      for (const m of matches) {
        const strong =
          m.vocal !== null && m.vocal.harmonicity >= 0.5 && m.strength >= 0.5 && (m.vocal.clusterSimilarity ?? 0) >= 0.85;
        const inDominant = dominant !== null && m.vocal?.clusterId === dominant;
        const phase2Status = inDominant && strong ? "HIGH_CONFIDENCE_CANDIDATE" : "NEEDS_HUMAN_CONFIRMATION";
        const event: ResolvedEvent = {
          ...detected(m, "USER_REQUIRED"),
          mandatory: true,
          label: p.label,
          identityStatus: phase2Status,
          patternId: p.id,
          evidence: inDominant
            ? `dominant repeated-attack cluster ${dominant} (similarity to medoid ${m.vocal!.clusterSimilarity}); harmonicity ${m.vocal!.harmonicity}; formant rise ${Math.round(m.strength * 100) / 10} dB`
            : `tonal mid-band attack${m.vocal?.clusterId ? ` in cluster ${m.vocal.clusterId}` : " (not in a repetition cluster)"}; harmonicity ${m.vocal?.harmonicity ?? "n/a"}`,
        };
        const a = assessments.get(m.id);
        if (useAssist && !a) {
          warnings.push({ code: "VOCAL_ASSIST_CANDIDATE_MISSING", message: `${m.id}: not assessed by the vocal assist; Phase 2 status kept` });
        }
        if (a) {
          const occ = a.occurrenceId ? occurrences.get(a.occurrenceId) : undefined;
          const own = occ?.refinedFromEventId === m.id ? occ : undefined;
          const hearing = new Map(assist!.words.map((w) => [w.id, w.rawText.trim()]));
          event.identityStatus = a.state;
          if (a.state === "REJECTED") {
            event.tier = "DETAIL";
            event.mandatory = false;
          }
          event.vocalAssist = {
            occurrenceId: a.occurrenceId,
            phase2EventId: m.id,
            phase2Time: m.time,
            phase2Status,
            rawWhisperStart: own?.rawWhisperStart ?? null,
            rawWhisperEnd: own?.rawWhisperEnd ?? null,
            refinedSyncTime: own?.refinedSyncTime ?? null,
            asrWords: own ? own.asrWords : a.overlappingWords.map((id) => hearing.get(id) ?? id),
            asrConfidence: own?.asrConfidence ?? null,
            consensusWindows: own?.consensusWindows ?? null,
            state: a.state,
            reason: a.reason,
          };
          event.resolutionReason = `Phase 2 ${phase2Status} -> vocal assist ${a.state}: ${a.reason}`;
        }
        // A demoted candidate replaces its plain DETAIL twin so the REJECTED grade stays visible.
        if (event.identityStatus === "REJECTED") out.set(event.id, event);
        else put(event);
      }
      // Heard occurrences whose signal sync point is not one of the pattern candidates.
      const inWindow = (t: MusicEvent["time"]) => compare(t, start) >= 0 && compare(t, end) < 0;
      for (const o of occurrences.values()) {
        if (o.state === "REJECTED" || (o.refinedFromEventId && assessments.has(o.refinedFromEventId))) continue;
        if (!inWindow(o.rawWhisperStart) && !(o.refinedSyncTime && inWindow(o.refinedSyncTime))) continue;
        const src = o.refinedFromEventId ? analysis.events.find((e) => e.id === o.refinedFromEventId) : undefined;
        const time = o.refinedSyncTime ?? o.rawWhisperStart;
        put({
          id: src ? src.id : `vox:${o.id.slice(4)}`,
          type: src ? src.type : "vocal_word",
          time,
          tier: "USER_REQUIRED",
          mandatory: true,
          label: p.label,
          identityStatus: o.state,
          confidence: o.refinedConfidence,
          origin: "detected",
          detectedEventId: src?.id ?? null,
          patternId: p.id,
          overrideIds: [],
          nearestBeatId: src?.nearestBeatId ?? null,
          beatOffsetMs: src?.beatOffsetMs ?? null,
          evidence: src
            ? `ASR occurrence ${o.id} refined to ${o.refinementMethod.replace("phase2_", "Phase 2 ")} ${src.id} (${o.refinementDeltaMs} ms)`
            : `ASR occurrence ${o.id}; no signal event within the refinement window, time is the raw Whisper start (unrefined)`,
          vocalAssist: {
            occurrenceId: o.id,
            phase2EventId: src?.id ?? null,
            phase2Time: src?.time ?? null,
            phase2Status: null,
            rawWhisperStart: o.rawWhisperStart,
            rawWhisperEnd: o.rawWhisperEnd,
            refinedSyncTime: o.refinedSyncTime,
            asrWords: o.asrWords,
            asrConfidence: o.asrConfidence,
            consensusWindows: o.consensusWindows,
            state: o.state,
            reason: o.reason,
          },
          resolutionReason: `added by vocal assist ${o.state}: ${o.reason}`,
        });
      }
      if (useAssist && matches.length === 0 && occurrences.size === 0) {
        warnings.push({ code: "VOCAL_ASSIST_NO_EVIDENCE", message: `${p.id}: neither Phase 2 nor ASR found candidates` });
      }
    }
    // Human ground-truth occurrences (after the assist, before overrides): the human says the word
    // exists in each window; signal evidence chose the primary attack; echoes are not extra words.
    for (const g of sync.occurrenceGroundTruth ?? []) {
      const occ = groundTruth.find((x) => x.patternId === g.patternId);
      if (!occ) {
        warnings.push({ code: "GROUND_TRUTH_NOT_RESOLVED", message: `${g.patternId}: ground truth declared but no resolved occurrences supplied` });
        continue;
      }
      if (occ.phase2.configHash !== analysis.analyzer.configHash || occ.phase2.analyzerVersion !== analysis.analyzer.version) {
        warnings.push({ code: "GROUND_TRUTH_STALE", message: `${g.patternId}: occurrences were resolved on another Phase 2 analysis; ignored` });
        continue;
      }
      const role = new Map<string, { o: VocalOccurrences["occurrences"][number]; role: "primary" | "effect_repeat" | "ambiguous_primary"; approved: boolean }>();
      const approvals = new Map(g.occurrences.flatMap((x) => (x.approval ? [[x.id, x.approval] as const] : [])));
      for (const o of occ.occurrences) {
        const ap = approvals.get(o.occurrenceId);
        if (ap) {
          // Human approval is authoritative: it fixes the primary even if the signal choice differs.
          const ev = analysis.events.find((x) => x.id === ap.primaryEventId);
          if (!ev) throw new Error(`${o.occurrenceId}: approved primary ${ap.primaryEventId} is not a Phase 2 event`);
          const dMs = Math.abs(toNumberApprox(sub(ev.time, seconds(ap.time)))) * 1000;
          if (dMs > 1) throw new Error(`${o.occurrenceId}: approved time ${ap.time} is ${dMs.toFixed(3)} ms from ${ev.id}`);
          if (o.primaryAttack?.eventId !== ev.id) {
            warnings.push({ code: "GROUND_TRUTH_APPROVAL_DIFFERS", message: `${o.occurrenceId}: signal chose ${o.primaryAttack?.eventId ?? "nothing"}, the approved primary ${ev.id} is used` });
          }
          const detectedRepeats = o.effectRepeats.map((r) => r.eventId);
          if (JSON.stringify([...detectedRepeats].sort()) !== JSON.stringify([...ap.effectRepeatEventIds].sort())) {
            warnings.push({ code: "GROUND_TRUTH_REPEATS_DIFFER", message: `${o.occurrenceId}: detected repeats [${detectedRepeats.join(", ")}] differ from the acknowledged [${ap.effectRepeatEventIds.join(", ")}]` });
          }
          role.set(ev.id, { o, role: "primary", approved: true });
          for (const id of ap.effectRepeatEventIds) if (id !== ev.id) role.set(id, { o, role: "effect_repeat", approved: true });
          continue;
        }
        if (o.primaryAttack) role.set(o.primaryAttack.eventId, { o, role: "primary", approved: false });
        for (const r of o.effectRepeats) role.set(r.eventId, { o, role: "effect_repeat", approved: false });
        for (const a of o.ambiguousCandidates) role.set(a.eventId, { o, role: "ambiguous_primary", approved: false });
      }
      const touch = (e: ResolvedEvent, why: string) => (e.resolutionReason = `${e.resolutionReason ? `${e.resolutionReason}; ` : ""}${why}`);
      for (const [id, r] of role) {
        const src = analysis.events.find((x) => x.id === id);
        const e = out.get(id) ?? (src ? detected(src, "DETAIL") : undefined);
        if (!e) continue;
        const next: ResolvedEvent = { ...e, patternId: g.patternId, label: e.label ?? occ.label };
        next.occurrence = {
          occurrenceId: r.o.occurrenceId,
          role: r.role,
          syncTarget: r.role === "primary",
          effectCharacter: r.o.effectCharacter,
          timingConfidence: r.role === "effect_repeat" ? null : r.o.confidence,
          ...(r.approved ? { humanApproved: true } : {}),
        };
        if (r.role === "primary") {
          Object.assign(next, { tier: "USER_REQUIRED", mandatory: true, identityStatus: "CONFIRMED" });
          touch(next, `human ground truth ${r.o.occurrenceId}: primary attack, sync target (timing confidence ${r.o.confidence}; ${r.o.effectCharacter})`);
          if (r.approved) {
            const ap = approvals.get(r.o.occurrenceId)!;
            next.evidence = `${next.evidence ?? ""}; human-approved primary ${ap.time} (${ap.date}, ${ap.method})`.replace(/^; /, "");
            touch(next, `APPROVED by user ${ap.date} as the primary sync point of ${r.o.occurrenceId}`);
          }
        } else if (r.role === "effect_repeat") {
          Object.assign(next, { tier: "DETAIL", mandatory: false, identityStatus: "REJECTED" });
          const rep = r.o.effectRepeats.find((x) => x.eventId === id);
          touch(next, `effect repeat in ${r.o.occurrenceId}${rep ? ` of ${r.o.primaryAttack!.eventId} (+${rep.delayMs} ms, ${rep.levelDbRelative} dB)` : ""}: not a separate word${r.approved ? " (acknowledged by user)" : ""}`);
        } else {
          Object.assign(next, { tier: "USER_REQUIRED", mandatory: true, identityStatus: "NEEDS_HUMAN_CONFIRMATION" });
          touch(next, `human ground truth ${r.o.occurrenceId}: AMBIGUOUS primary — choose one`);
        }
        out.set(id, next);
      }
      for (const o of occ.occurrences.filter((x) => x.status === "NO_CANDIDATE")) {
        const mid = add(o.humanWindow.start, div(sub(o.humanWindow.end, o.humanWindow.start), rational(2)));
        out.set(`gt:${o.occurrenceId}`, {
          id: `gt:${o.occurrenceId}`, type: "vocal_word", time: mid, tier: "USER_REQUIRED", mandatory: true, label: occ.label,
          identityStatus: "NEEDS_HUMAN_CONFIRMATION", confidence: 0, origin: "user", detectedEventId: null, patternId: g.patternId,
          overrideIds: [], nearestBeatId: null, beatOffsetMs: null, evidence: "human ground truth window without a detected attack (placeholder at the window centre; retime it)",
          resolutionReason: `human ground truth ${o.occurrenceId}: no attack detected`,
          occurrence: { occurrenceId: o.occurrenceId, role: "primary", syncTarget: true, effectCharacter: "UNKNOWN", timingConfidence: "LOW" },
        });
      }
      if (g.exhaustive) {
        for (const e of [...out.values()].filter((x) => x.patternId === g.patternId && !role.has(x.id) && !x.id.startsWith("gt:"))) {
          const next: ResolvedEvent = { ...e, tier: "DETAIL", mandatory: false, identityStatus: "REJECTED" };
          next.occurrence = { occurrenceId: "none", role: "other", syncTarget: false, effectCharacter: null, timingConfidence: null };
          touch(next, `human ground truth: exactly ${occ.occurrences.length} occurrences of "${occ.label}" in ${g.patternId}; this attack is none of them`);
          out.set(e.id, next);
        }
      }
      gtApplied.push({
        patternId: g.patternId,
        exhaustive: g.exhaustive,
        occurrences: occ.occurrences.length,
        resolved: occ.occurrences.filter((x) => x.status === "RESOLVED").length,
        ambiguous: occ.occurrences.filter((x) => x.status === "AMBIGUOUS").length,
      });
    }
    if (assist && assist.patternId && !sync.requiredPatterns.some((p) => p.id === assist!.patternId)) {
      warnings.push({ code: "VOCAL_ASSIST_PATTERN_MISSING", message: `vocal transcription targets ${assist.patternId}, not in the sync file; ignored` });
    }

    // Required user events (asserted by the user, so identity is confirmed).
    for (const e of sync.requiredEvents) {
      put({
        id: e.id, type: e.type, time: seconds(e.time), tier: "USER_REQUIRED", mandatory: e.mandatory, label: e.label,
        identityStatus: "CONFIRMED", confidence: 1, origin: "user", detectedEventId: null, patternId: null,
        overrideIds: [], nearestBeatId: null, beatOffsetMs: null, evidence: e.note ?? "user-specified",
      });
    }
  }

  // Overrides.
  const eventTime = (id: string) =>
    analysis.events.find((x) => x.id === id)?.time ?? analysis.beats.find((x) => x.id === id)?.time ?? analysis.phrases.find((x) => x.id === id)?.time ?? null;
  const excluded: ResolvedMusicEvents["excluded"] = [];
  for (const o of sync?.eventOverrides ?? []) {
    // Word-level decisions (asr:*) live in the vocal transcription (applyWordOverrides).
    if (assist && o.targetEventId.startsWith("asr:")) continue;
    // Occurrence ids (occ:*) address the resolved event that carries that occurrence.
    const occ = assist?.occurrences.find((x) => x.id === o.targetEventId);
    const gtOcc = groundTruth.flatMap((x) => x.occurrences).find((x) => x.occurrenceId === o.targetEventId);
    const key = out.has(o.targetEventId)
      ? o.targetEventId
      : gtOcc
        ? (gtOcc.primaryAttack?.eventId ?? `gt:${gtOcc.occurrenceId}`)
        : occ
          ? [occ.refinedFromEventId, `vox:${occ.id.slice(4)}`].find((id) => id && out.get(id)?.vocalAssist?.occurrenceId === occ.id)
          : undefined;
    const target = key ? out.get(key) : undefined;
    if (!key || !target) {
      warnings.push({ code: "OVERRIDE_TARGET_MISSING", message: `${o.id}: no resolved event ${o.targetEventId}` });
      continue;
    }
    if (o.action === "exclude") {
      out.delete(key);
      excluded.push({ detectedEventId: key, overrideId: o.id, note: o.note ?? null });
      continue;
    }
    const next: ResolvedEvent = { ...target, overrideIds: [...target.overrideIds, o.id] };
    if (o.action === "confirm") {
      next.identityStatus = "CONFIRMED";
      if (next.patternId && !next.mandatory) {
        // A human confirmation restores a candidate the assist had demoted.
        next.tier = "USER_REQUIRED";
        next.mandatory = true;
      }
    }
    if (o.action === "retime") {
      next.time = seconds(o.time!);
      next.origin = "user";
      next.beatOffsetMs = null;
    }
    if (o.action === "pin") {
      const exact = rational(o.exactTime!.num, o.exactTime!.den);
      const before = next.time;
      next.time = exact;
      next.origin = "user";
      next.beatOffsetMs = null;
      next.nearestBeatId = null;
      const moved = (o.evidenceEventIds ?? []).filter((id) => {
        const t = eventTime(id);
        return t === null || compare(t, exact) !== 0;
      });
      if (moved.length) {
        warnings.push({ code: "PIN_EVIDENCE_MOVED", message: `${o.id}: evidence ${moved.join(", ")} no longer at the pinned time; the pin is kept` });
      }
      const why = `pinned by ${o.id} to ${o.time} (exact ${o.exactTime!.num}/${o.exactTime!.den} s), approved by user ${o.approved!.date}; previous ${toNumberApprox(before).toFixed(6)} s (the raw user marker stays in requiredEvents)${o.evidenceEventIds?.length ? `; evidence at exactly this time: ${o.evidenceEventIds.filter((x) => !moved.includes(x)).join(", ") || "none"}` : ""}`;
      next.resolutionReason = next.resolutionReason ? `${next.resolutionReason}; ${why}` : why;
      next.evidence = `${next.evidence ?? ""}; hard pin ${o.time}`.replace(/^; /, "");
    }
    if (o.action === "relabel") next.label = o.label!;
    if (next.resolutionReason !== undefined) {
      next.resolutionReason += `; user override ${o.id} ${o.action}${o.action === "retime" ? ` -> ${o.time}` : ""} (authoritative)`;
    }
    out.set(key, next);
  }

  // Nearest-beat offsets for user-timed events.
  const beats = analysis.beats;
  for (const e of out.values()) {
    if (e.beatOffsetMs !== null || beats.length === 0) continue;
    let best = beats[0]!;
    for (const b of beats) if (Math.abs(b.sample / 44100 - e.time.num / e.time.den) < Math.abs(best.sample / 44100 - e.time.num / e.time.den)) best = b;
    e.nearestBeatId = best.id;
    e.beatOffsetMs = Math.round(((e.time.num / e.time.den - best.time.num / best.time.den) * 1000) * 100) / 100;
  }

  const events = [...out.values()].sort(
    (a, b) => compare(a.time, b.time) || TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.id.localeCompare(b.id),
  );
  const applied = assist !== null && sync !== null && sync.requiredPatterns.some((p) => p.id === assist!.patternId);
  return ResolvedMusicEventsSchema.parse({
    schemaVersion: gtApplied.length ? RESOLVED_GT_SCHEMA_VERSION : applied ? RESOLVED_SCHEMA_VERSION : MUSIC_SCHEMA_VERSION,
    sourceMediaId: analysis.source.mediaId,
    analysis: { analyzerVersion: analysis.analyzer.version, configHash: analysis.analyzer.configHash },
    sync: sync ? { sha256: createHash("sha256").update(canonicalJson(sync)).digest("hex") } : null,
    ...(applied
      ? {
          vocalAssist: {
            schemaVersion: assist!.schemaVersion,
            cacheKey: assist!.cacheKey,
            model: assist!.model.name,
            modelSha256: assist!.model.sha256,
            patternId: assist!.patternId,
          },
        }
      : {}),
    ...(gtApplied.length ? { groundTruth: gtApplied } : {}),
    tierOrder: TIER_ORDER,
    events,
    excluded,
    warnings,
  });
}
