/**
 * Phase 12: one Edit Plan validator. The planner, the final-plan builder and the render-spec compiler each
 * enforce parts of an Edit Plan's correctness; this collects the structural and policy checks in one place
 * and reports EVERY violation as a coded Issue (what, clip, frame, expected vs actual, next action), so a
 * known-bad plan fails for the right, named reason before any media work starts.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { EditPlanSchema, type EditPlan } from "../plan/schema.ts";
import { FX_TYPES } from "../fx/core.ts";
import { type Rational, toNumberApprox } from "../time/rational.ts";
import { type Issue } from "./errors.ts";

export interface PlanMedia {
  /** absolute path of the source (checked for existence when `checkFiles`) */
  path: string;
  /** current content fingerprint of the file */
  fingerprint: string;
  /** fingerprint recorded when the plan was approved */
  approvedFingerprint?: string;
  durationSeconds: number;
  frameRateMode: "CFR" | "VFR" | "UNKNOWN";
  /** display (rotation-applied) size */
  displayW: number;
  displayH: number;
  hasAudio: boolean;
  audioSampleRate?: number;
}

export interface PlanContext {
  projectId: string;
  /** approved delivery frame rate */
  fps: Rational;
  media: Record<string, PlanMedia>;
  /** shots: source time bounds, keyed `${mediaId}/${shotId}` (shot ids repeat across media) */
  shots?: Record<string, { mediaId: string; start: number; end: number }>;
  /** mandatory cut frames (approved vocal hits), by music event id */
  mandatoryCuts: Array<{ eventId: string; frame: number }>;
  /** hard clean-reset frames no effect may cross or leak into */
  protectedResets: number[];
  /** approved audio (mediaId + source window) and delivery sample rate */
  audio: { mediaId: string; sourceStart: Rational; sourceEnd: Rational; sampleRate: number };
  /** clip ordering policy: duplicates of the same shot / overlapping source forbidden */
  forbidDuplicateShots: boolean;
  /** Edit Plan fx intents allowed for this project */
  allowedFxIntents?: string[];
  maxUpscale?: number;
  /** a Resolve mapping to check against the plan (record / source frames per clip), when present */
  resolveMapping?: Array<{ clipId: string; recordIn: number; recordOut: number; mediaId: string }>;
  /** the approval this plan claims: the sha256 of the approved plan and the project it was approved for */
  approval?: { projectId: string; planSha256: string };
  /** provenance inputs the plan must cite (name -> sha256) */
  expectedInputs?: Record<string, string>;
  checkFiles?: boolean;
}

const sec = (r: Rational) => toNumberApprox(r);
export const planSha256 = (plan: unknown) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

/** Validate an Edit Plan against its approved context; returns every issue (empty = valid). */
export function validateEditPlan(raw: unknown, ctx: PlanContext): Issue[] {
  const parsed = EditPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((e) => ({ code: "PLAN_SCHEMA_INVALID", severity: "BLOCKING" as const, what: `${e.message} at ${e.path.join(".")}`, actual: e.path.join("."), next: "fix the plan so it satisfies the Edit Plan schema (the planner never produces this)" }));
  }
  const plan: EditPlan = parsed.data;
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, "severity"> & { severity?: Issue["severity"] }) => issues.push({ severity: "BLOCKING", ...i });
  const fps = sec(ctx.fps);
  const frameOf = (t: Rational) => Math.round(sec(t) * fps);

  if (plan.projectId !== ctx.projectId) add({ code: "PLAN_PROJECT_MISMATCH", what: "plan belongs to another project", expected: ctx.projectId, actual: plan.projectId, next: "load the plan for this project" });
  if (Math.abs(sec(plan.timeline.fps) - fps) > 1e-9) add({ code: "PLAN_FPS_MISMATCH", what: "plan assumes another frame rate", expected: fps, actual: sec(plan.timeline.fps), next: "re-plan at the approved delivery rate (frame numbers depend on it)" });

  // ---- sources
  for (const c of plan.clips) {
    const m = ctx.media[c.mediaId];
    if (!m) {
      add({ code: "SOURCE_UNKNOWN", what: `clip uses media ${c.mediaId}, which is not in the project`, clipId: c.clipId, next: "choose a clip from the ingested media manifest" });
      continue;
    }
    if (ctx.checkFiles && !existsSync(m.path)) add({ code: "SOURCE_MISSING", what: "source file not found", clipId: c.clipId, file: m.path, next: "relink the source (do not substitute a different file)" });
    if (m.approvedFingerprint && m.approvedFingerprint !== m.fingerprint) add({ code: "SOURCE_FINGERPRINT_MISMATCH", what: "source content changed since approval", clipId: c.clipId, file: m.path, expected: m.approvedFingerprint, actual: m.fingerprint, next: "restore the approved source, or re-approve with the new media" });
    const sIn = sec(c.sourceIn);
    const sOut = sec(c.sourceOut);
    if (sIn < 0) add({ code: "SOURCE_RANGE_NEGATIVE", what: "source range starts before 0", clipId: c.clipId, actual: sIn, next: "clamp to the media" });
    if (sOut <= sIn) add({ code: "SOURCE_RANGE_EMPTY", what: "source out is not after source in", clipId: c.clipId, expected: `> ${sIn}`, actual: sOut, next: "fix the source range" });
    if (sOut > m.durationSeconds + 1e-6) add({ code: "SOURCE_RANGE_OUTSIDE_MEDIA", what: "source range runs past the end of the media", clipId: c.clipId, file: m.path, expected: `<= ${m.durationSeconds}`, actual: sOut, next: "choose a range inside the media (the media is shorter than requested)" });
    // the clip's range must lie inside the span of the shots it cites (a clip may cite consecutive shots of one take)
    const cited = ctx.shots ? c.shotIds.map((id) => ctx.shots![`${c.mediaId}/${id}`]) : [];
    if (ctx.shots && cited.some((sh) => !sh)) add({ code: "SOURCE_OUTSIDE_SHOT", what: `clip cites a shot that ${c.mediaId} does not have`, clipId: c.clipId, actual: c.shotIds, next: "re-plan from the current shot list" });
    const span = cited.length && cited.every(Boolean) ? { start: Math.min(...cited.map((sh) => sh!.start)), end: Math.max(...cited.map((sh) => sh!.end)) } : null;
    if (span && (sIn < span.start - 1e-6 || sOut > span.end + 1e-6)) add({ code: "SOURCE_OUTSIDE_SHOT", what: `source range is not inside its shot(s) ${c.shotIds.join(", ")}`, clipId: c.clipId, expected: `${span.start}-${span.end}`, actual: `${sIn}-${sOut}`, next: "the clip would cross a shot boundary (a hidden cut)" });
    // timing: the source duration must equal the timeline duration (no drift)
    const tl = sec(c.timelineOut.time) - sec(c.timelineIn.time);
    if (Math.abs(sOut - sIn - tl) > 1 / fps) add({ code: "TIMING_DRIFT", what: "source duration and timeline duration differ by more than a frame", clipId: c.clipId, expected: tl, actual: sOut - sIn, next: "retime the clip or fix its range (speed changes must be explicit effects)" });
    for (const p of [c.timelineIn, c.timelineOut]) if (frameOf(p.time) !== p.frame) add({ code: "TIMING_FRAME_MISMATCH", what: "timeline frame does not match its time at the approved fps", clipId: c.clipId, frame: p.frame, expected: frameOf(p.time), actual: p.frame, next: "recompute frame numbers at the approved fps" });
    // orientation / reframe
    const r = c.reframe;
    const cropH = m.displayH;
    const want = Math.round((cropH * 9) / 16);
    if (r.intent === "native_vertical" && m.displayW > m.displayH) add({ code: "ORIENTATION_WRONG", what: "plan treats a landscape source as native vertical", clipId: c.clipId, expected: "a 9:16 crop", actual: `${m.displayW}x${m.displayH} display`, next: "use a crop reframe, or fix the source rotation" });
    if (r.cropWidth <= 0 || r.cropWidth > m.displayW) add({ code: "CROP_OUT_OF_BOUNDS", what: "crop width is not inside the picture", clipId: c.clipId, expected: `1..${m.displayW}`, actual: r.cropWidth, next: "fix the reframe" });
    else if (r.intent !== "native_vertical" && Math.abs(r.cropWidth - want) > 2) add({ code: "CROP_ASPECT", what: "crop is not 9:16 of the display height", clipId: c.clipId, expected: want, actual: r.cropWidth, next: "a broken crop would stretch the picture" });
    for (const p of r.centerPath) {
      if (p.centerX - r.cropWidth / 2 < 0 || p.centerX + r.cropWidth / 2 > m.displayW) add({ code: "CROP_OUT_OF_BOUNDS", what: "crop window leaves the picture", clipId: c.clipId, expected: `centre in ${r.cropWidth / 2}..${m.displayW - r.cropWidth / 2}`, actual: p.centerX, next: "clamp the reframe path" });
      // keyframes hold their value, so a static path keyed at its shot start is fine; a keyframe outside the
      // clip's shot(s) (or the media) means the path was derived for other footage
      const t = sec(p.sourceTime);
      const lo = span?.start ?? 0;
      const hi = span?.end ?? m.durationSeconds;
      if (t < lo - 1e-6 || t > hi + 1e-6) add({ code: "REFRAME_PATH_OUTSIDE_CLIP", what: "reframe keyframe outside the clip's shot(s)", clipId: c.clipId, expected: `${lo}-${hi}`, actual: t, next: "re-derive the reframe path for this clip's footage" });
    }
    if (!(r.upscaleFactor > 0) || r.upscaleFactor > (ctx.maxUpscale ?? 6)) add({ code: "ILLEGAL_TRANSFORM", what: "upscale factor outside the allowed range", clipId: c.clipId, expected: `0 < x <= ${ctx.maxUpscale ?? 6}`, actual: r.upscaleFactor, next: "choose wider footage or a smaller crop" });
    // fx intents
    for (const fx of c.fx) {
      if (fx.kind === "none") continue;
      if (ctx.allowedFxIntents && !ctx.allowedFxIntents.includes(fx.kind)) add({ code: "FX_UNSUPPORTED", what: `fx ${fx.kind} is not allowed for this project`, clipId: c.clipId, expected: ctx.allowedFxIntents, actual: fx.kind, next: "remove it, or approve it through the FX layer" });
      // timeline time = song time - audio source start
      const startFrame = Math.round((sec(fx.at) - sec(plan.audio.sourceStart)) * fps);
      const endFrame = startFrame + fx.durationFrames;
      if (fx.durationFrames <= 0) add({ code: "FX_INVALID_PARAMS", what: `fx ${fx.kind} has no duration`, clipId: c.clipId, actual: fx.durationFrames, next: "give the effect a duration inside its clip" });
      if (startFrame < c.timelineIn.frame || endFrame > c.timelineOut.frame) add({ code: "FX_CROSSES_CUT", what: `fx ${fx.kind} leaves its clip (frames ${startFrame}-${endFrame})`, clipId: c.clipId, expected: `${c.timelineIn.frame}-${c.timelineOut.frame}`, actual: `${startFrame}-${endFrame}`, next: "effects end at their own cut (reset on cut)" });
      for (const rf of ctx.protectedResets) if (startFrame < rf && endFrame > rf) add({ code: "FX_CROSSES_RESET", what: `fx ${fx.kind} runs across the protected clean reset at frame ${rf}`, clipId: c.clipId, frame: rf, next: "the reset is hard: nothing may carry into the payoff" });
    }
  }

  // ---- timeline continuity and order
  const clips = plan.clips;
  if (clips[0] && clips[0].timelineIn.frame !== 0) add({ code: "TIMELINE_GAP", what: "the timeline does not start at frame 0", clipId: clips[0].clipId, frame: 0, expected: 0, actual: clips[0].timelineIn.frame, next: "close the gap" });
  for (let k = 1; k < clips.length; k++) {
    const a = clips[k - 1]!;
    const b = clips[k]!;
    if (b.timelineIn.frame > a.timelineOut.frame) add({ code: "TIMELINE_GAP", what: `gap between ${a.clipId} and ${b.clipId}`, clipId: b.clipId, frame: a.timelineOut.frame, expected: a.timelineOut.frame, actual: b.timelineIn.frame, next: "close the gap (unintended black)" });
    if (b.timelineIn.frame < a.timelineOut.frame) add({ code: "TIMELINE_OVERLAP", what: `${b.clipId} overlaps ${a.clipId}`, clipId: b.clipId, frame: b.timelineIn.frame, expected: a.timelineOut.frame, actual: b.timelineIn.frame, next: "trim one of the clips" });
    if (b.clipId <= a.clipId) add({ code: "CLIP_ORDER", what: `${b.clipId} comes after ${a.clipId}`, clipId: b.clipId, next: "clips must be in timeline order with ascending ids" });
  }
  const last = clips.at(-1);
  if (last && last.timelineOut.frame !== plan.timeline.frames) add({ code: "TIMELINE_LENGTH", what: "the last clip does not end at the timeline end", clipId: last.clipId, expected: plan.timeline.frames, actual: last.timelineOut.frame, next: "fill the timeline exactly" });
  if (ctx.forbidDuplicateShots) {
    const seen = new Map<string, string>();
    for (const c of clips)
      for (const id of c.shotIds) {
        const k = `${c.mediaId}/${id}`;
        if (seen.has(k)) add({ code: "DUPLICATE_SHOT", what: `shot ${id} is used twice (${seen.get(k)} and ${c.clipId})`, clipId: c.clipId, next: "use a different shot (the brief forbids repeats)" });
        else seen.set(k, c.clipId);
      }
  }
  // ---- cuts: on clip boundaries, matching clips, mandatory vocal hits on their exact frame
  const boundaries = clips.slice(1).map((c) => c.timelineIn.frame);
  for (const [k, cut] of plan.cuts.entries()) {
    if (boundaries[k] !== cut.timeline.frame) add({ code: "CUT_MISMATCH", what: `${cut.cutId} is not on the boundary between its clips`, frame: cut.timeline.frame, expected: boundaries[k], actual: cut.timeline.frame, next: "regenerate the cut list from the clips" });
    if (cut.from.clipId !== clips[k]?.clipId || cut.to.clipId !== clips[k + 1]?.clipId) add({ code: "CUT_ORDER", what: `${cut.cutId} joins ${cut.from.clipId} -> ${cut.to.clipId}`, expected: `${clips[k]?.clipId} -> ${clips[k + 1]?.clipId}`, actual: `${cut.from.clipId} -> ${cut.to.clipId}`, next: "the shot order changed; regenerate the cuts" });
  }
  for (const m of ctx.mandatoryCuts) {
    const cut = plan.cuts.find((c) => c.trigger.eventId === m.eventId);
    if (!cut) add({ code: "MANDATORY_CUT_MISSING", what: `mandatory cut on ${m.eventId} is missing`, frame: m.frame, next: "the approved vocal hits are hard sync points" });
    else if (cut.timeline.frame !== m.frame) add({ code: "MANDATORY_CUT_WRONG_FRAME", what: `cut on ${m.eventId} is at the wrong frame`, frame: cut.timeline.frame, expected: m.frame, actual: cut.timeline.frame, next: "snap the cut to the approved vocal hit frame" });
  }
  // ---- audio
  const a = plan.audio;
  if (a.mediaId !== ctx.audio.mediaId || Math.abs(sec(a.sourceStart) - sec(ctx.audio.sourceStart)) > 1e-9 || Math.abs(sec(a.sourceEnd) - sec(ctx.audio.sourceEnd)) > 1e-9) add({ code: "AUDIO_CHANGED", what: "the plan's audio is not the approved audio", expected: `${ctx.audio.mediaId} ${sec(ctx.audio.sourceStart)}-${sec(ctx.audio.sourceEnd)}`, actual: `${a.mediaId} ${sec(a.sourceStart)}-${sec(a.sourceEnd)}`, next: "the song window is approved; an audio change needs a new human decision" });
  const am = ctx.media[a.mediaId];
  if (am && am.audioSampleRate && am.audioSampleRate !== ctx.audio.sampleRate) add({ code: "AUDIO_SAMPLE_RATE_MISMATCH", what: "the audio source rate differs from the approved delivery rate", file: am.path, expected: ctx.audio.sampleRate, actual: am.audioSampleRate, next: "resample explicitly in the conform (recorded), never implicitly" });
  if (am && !am.hasAudio) add({ code: "AUDIO_MISSING", what: "the audio media has no audio stream", file: am.path, next: "point the plan at the song file" });
  // ---- Resolve mapping
  for (const r of ctx.resolveMapping ?? []) {
    const c = clips.find((x) => x.clipId === r.clipId);
    if (!c) add({ code: "RESOLVE_MAPPING_INVALID", what: `Resolve item maps to unknown clip ${r.clipId}`, next: "rebuild the Resolve plan from this Edit Plan" });
    else if (r.recordIn !== c.timelineIn.frame || r.recordOut !== c.timelineOut.frame || r.mediaId !== c.mediaId) add({ code: "RESOLVE_MAPPING_INVALID", what: `Resolve item for ${r.clipId} does not match the plan`, clipId: r.clipId, expected: `${c.mediaId} ${c.timelineIn.frame}-${c.timelineOut.frame}`, actual: `${r.mediaId} ${r.recordIn}-${r.recordOut}`, next: "rebuild the Resolve plan; never hand-edit record frames" });
  }
  // ---- approval / provenance
  if (ctx.approval) {
    if (ctx.approval.projectId !== plan.projectId) add({ code: "APPROVAL_WRONG_PROJECT", what: "approval belongs to another project", expected: plan.projectId, actual: ctx.approval.projectId, next: "an approval never transfers between projects" });
    const sha = planSha256(raw);
    if (ctx.approval.planSha256 !== sha) add({ code: "APPROVAL_STALE", what: "the plan changed since it was approved", expected: ctx.approval.planSha256, actual: sha, next: "re-approve (a human decision) or restore the approved plan" });
  }
  for (const [k, v] of Object.entries(ctx.expectedInputs ?? {})) if (plan.provenance.inputs[k] !== v) add({ code: "PROVENANCE_MISMATCH", what: `plan provenance input ${k} does not match the current record`, expected: v, actual: plan.provenance.inputs[k] ?? null, next: "re-plan from the current inputs" });
  return issues;
}

/** FX layer: seeded effect types must state their seed explicitly (a schema default is not a decision). */
export const SEEDED_FX = ["filmTexture"] as const;
export function validateEffectSeeds(effects: Array<Record<string, unknown>>): Issue[] {
  return effects.flatMap((e) => (typeof e.type === "string" && (SEEDED_FX as readonly string[]).includes(e.type) && typeof e.seed !== "number" ? [{ code: "FX_SEED_MISSING", severity: "BLOCKING" as const, what: `seeded effect ${String(e.id)} (${e.type}) has no explicit seed`, clipId: typeof e.clipId === "string" ? e.clipId : undefined, next: "record the seed so the render is reproducible" }] : []));
}
export const KNOWN_FX_TYPES: readonly string[] = FX_TYPES;
