/**
 * CLEAN_TO_CHAOS: a reusable, deterministic escalation preset and the contracts of its effects.
 *
 *   CLEAN START -> MID-SHOT FX ENTRY -> PROGRESSIVE INTENSIFICATION -> HARD CLEAN RESET ON CUT
 *
 * Nothing here knows a project, a song or a subject. A project supplies its clips (timeline
 * ranges and roles), its approved music anchors, the time remaps it has already approved (which
 * are preserved, never re-authored), and an assignment of effects to clips. `resolveCtc` turns
 * that into exact clip-local windows and per-frame strengths; the pixel engine (pixels.ts) does
 * the rest. Every effect:
 *   - is clip-scoped: it starts at the clip's onset frame and ends at or before the clip's last
 *     frame, so the next clip always begins exactly clean (reset on cut);
 *   - starts from the untouched frame (strength ramps up from ~0, never switches on at full);
 *   - never touches a payoff clip and never reaches the final clean reset;
 *   - is deterministic (integer hashes for any pseudo-randomness, a seed per effect).
 * An approved time remap inside a window (e.g. an approved temporal stutter) keeps its timing:
 * the effect is keyed by the remapped SOURCE frame and holds its peak over the remap, so frames
 * the remap repeats stay identical and its loop structure is preserved exactly.
 */

import { z } from "zod";

export const CTC_VERSION = "1.0.0";
export const CTC_EFFECT_TYPES = ["echoPrint", "stepPrint", "analogFeedback", "slitScan", "datamoshStyle", "feedbackCrescendo"] as const;
export type CtcEffectType = (typeof CTC_EFFECT_TYPES)[number];

const Frac = z.number().min(0).max(1);
const Blend = z.enum(["lighten", "darken", "screen", "normal", "auto"]);
/** a horizontal band of the frame (fractions of the height) where the effect is reduced by `keep` */
export const ProtectBandSchema = z.object({ from: Frac, to: Frac, keep: Frac, featherFrac: Frac.default(0.06) }).strict();
export type ProtectBand = z.infer<typeof ProtectBandSchema>;

/** Parameters at FULL strength (strength 1); the per-frame strength scales them. */
export const CtcParamsSchema = z.discriminatedUnion("type", [
  // temporal ghost trails of prior frames; the number of active trails grows with strength
  z.object({ type: z.literal("echoPrint"), trails: z.number().int().min(1).max(8), spacing: z.number().int().min(1).max(6), decay: z.number().gt(0).max(0.95), mix: Frac, blend: Blend }).strict(),
  // step print: each group of `n` output frames shows its first frame; n grows 1 -> maxStep
  z.object({ type: z.literal("stepPrint"), maxStep: z.number().int().min(1).max(8) }).strict(),
  // analog video feedback: prior frames re-entering slightly zoomed (a tunnel of persistence),
  // a small chroma drift per re-entry, and motion-gated horizontal tracking instability
  z.object({ type: z.literal("analogFeedback"), layers: z.number().int().min(1).max(10), zoomPerLayer: z.number().min(0).max(0.05), rotateDegPerLayer: z.number().min(-2).max(2), decay: z.number().gt(0).max(0.95), mix: Frac, blend: Blend, chromaPx: z.number().min(0).max(8), jitterPx: z.number().min(0).max(32), jitterBandPx: z.number().int().min(2).max(96), jitterProbability: Frac }).strict(),
  // slit-scan: horizontal bands of the frame shown from earlier frames (time pulled through space)
  z.object({ type: z.literal("slitScan"), maxDelayFrames: z.number().int().min(1).max(30), bandPx: z.number().int().min(1).max(64), waveCycles: z.number().min(0).max(6), waveDepth: Frac, waveDriftPerFrame: z.number().min(0).max(0.5) }).strict(),
  // datamosh-style breakup: stale blocks persist and are dragged along the current motion
  // (motion-compensated prediction without residual); a block refreshes from the real frame with a
  // probability that falls as strength rises, and always after maxStaleFrames; the measured motion
  // is re-applied with a gain (1 + motionGain * s), the repeated-P-frame "bloom" of a real datamosh
  z.object({ type: z.literal("datamoshStyle"), blockPx: z.number().int().min(8).max(64), searchPx: z.number().int().min(4).max(48), carryover: Frac, maxStaleFrames: z.number().int().min(1).max(60), motionGain: z.number().min(0).max(6), mix: Frac }).strict(),
  // feedback crescendo: echo accumulation + feedback tunnel + instability, all at once
  z.object({ type: z.literal("feedbackCrescendo"), echoTrails: z.number().int().min(0).max(8), echoDecay: z.number().gt(0).max(0.95), layers: z.number().int().min(1).max(12), layerLag: z.number().int().min(1).max(6), zoomPerLayer: z.number().min(0).max(0.06), rotateDegPerLayer: z.number().min(-3).max(3), decay: z.number().gt(0).max(0.95), mix: Frac, blend: Blend, jitterPx: z.number().min(0).max(40), jitterBandPx: z.number().int().min(2).max(96), jitterProbability: Frac }).strict(),
]);
export type CtcParams = z.infer<typeof CtcParamsSchema>;

export const CurveSchema = z.object({ kind: z.enum(["linear", "easeIn", "smooth"]), gamma: z.number().min(0.5).max(4).default(1.5) }).strict();
export type Curve = z.infer<typeof CurveSchema>;

/** The generic preset: behaviour only, no project knowledge. */
export const CleanToChaosPresetSchema = z
  .object({
    id: z.literal("CLEAN_TO_CHAOS"),
    version: z.literal(CTC_VERSION),
    /** share of each treated clip that stays exactly clean before the effect enters */
    cleanFraction: Frac,
    /** the onset may only move (music alignment) inside this band of the clip */
    cleanFractionBand: z.tuple([Frac, Frac]),
    escalation: CurveSchema,
    /** global ceiling; per-clip maxima escalate toward it across the treated clips */
    maxIntensity: Frac,
    resetOnCut: z.literal(true),
    /** the payoff clip stays completely clean (no effect at or after its first frame) */
    finalCleanPayoff: z.literal(true),
    /** optional: snap each onset to an approved music anchor of these types within maxShiftFrames */
    musicAlignment: z.object({ enabled: z.boolean(), eventTypes: z.array(z.string()), maxShiftFrames: z.number().int().min(0).max(30) }).strict(),
    /** how an effect behaves over an approved time remap inside its window */
    lockedRemap: z.literal("HOLD_PEAK_KEYED_BY_SOURCE_FRAME"),
  })
  .strict();
export type CleanToChaosPreset = z.infer<typeof CleanToChaosPresetSchema>;

export const CLEAN_TO_CHAOS: CleanToChaosPreset = {
  id: "CLEAN_TO_CHAOS",
  version: CTC_VERSION,
  cleanFraction: 0.5,
  cleanFractionBand: [0.45, 0.55],
  escalation: { kind: "easeIn", gamma: 1.5 },
  maxIntensity: 1,
  resetOnCut: true,
  finalCleanPayoff: true,
  musicAlignment: { enabled: true, eventTypes: ["downbeat"], maxShiftFrames: 6 },
  lockedRemap: "HOLD_PEAK_KEYED_BY_SOURCE_FRAME",
};

/** A project's use of the preset: which effects on which clips, and their per-clip ceilings. */
export const CtcConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("CLEAN_TO_CHAOS_CONFIG"),
    projectId: z.string(),
    /** display name of this variant (e.g. "CLEAN_TO_CHAOS POLISHED") */
    name: z.string().optional(),
    preset: CleanToChaosPresetSchema,
    seed: z.number().int().min(0).max(2 ** 31 - 1),
    assignments: z.array(
      z
        .object({
          clipId: z.string(),
          label: z.string(),
          /** per-clip ceiling (fraction of preset.maxIntensity) */
          maxIntensity: Frac,
          cleanFraction: Frac.optional(),
          effects: z.array(z.object({ type: z.enum(CTC_EFFECT_TYPES), params: CtcParamsSchema, protect: ProtectBandSchema.optional() }).strict()).min(1),
        })
        .strict(),
    ),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type CtcConfig = z.input<typeof CtcConfigSchema>;

export interface CtcClip {
  clipId: string;
  frameIn: number;
  frameOut: number;
  role: "opening" | "body" | "payoff";
}
export interface CtcAnchor {
  eventId: string;
  type: string;
  timelineFrame: number;
}
/** an approved time remap (timeline frames [start, end)) that must be preserved exactly */
export interface LockedRemap {
  id: string;
  clipId: string;
  start: number;
  end: number;
}

export interface ResolvedCtcEffect {
  id: string;
  type: CtcEffectType;
  params: CtcParams;
  protect: ProtectBand | null;
  seed: number;
}

export interface ResolvedCtcClip {
  clipId: string;
  label: string;
  frames: number;
  timeline: { frameIn: number; frameOut: number };
  /** clip-local: frames [0, onset) are exactly clean; the effect runs [onset, frames) */
  onset: number;
  onsetReason: string;
  cleanFraction: number;
  /** clip-local frame at which strength reaches its maximum (the clip end, or an approved remap) */
  peakAt: number;
  maxIntensity: number;
  curve: Curve;
  lockedRemap: { id: string; start: number; end: number } | null;
  effects: ResolvedCtcEffect[];
}

export class CtcContractError extends Error {}

const shape = (x: number, c: Curve) => (c.kind === "linear" ? x : c.kind === "smooth" ? x * x * (3 - 2 * x) : Math.pow(x, c.gamma));

/**
 * Strength at clip-local frame f in [0, 1]: exactly 0 before the onset, then ramping up with the
 * escalation curve to reach maxIntensity at `peakAt`, held from there to the clip end. With a
 * locked remap the strength is looked up at the remap's SOURCE frame (callers pass it), and every
 * source frame at or after `peakAt` has the peak value, so a repeated source frame always gets
 * the same strength.
 */
export function strengthAt(c: Pick<ResolvedCtcClip, "onset" | "peakAt" | "maxIntensity" | "curve" | "frames">, f: number): number {
  if (f < c.onset || f >= c.frames) return 0;
  if (f >= c.peakAt - 1) return c.maxIntensity;
  const x = (f - c.onset + 1) / (c.peakAt - c.onset);
  return c.maxIntensity * shape(Math.min(1, Math.max(0, x)), c.curve);
}

/**
 * Resolve a project's CLEAN_TO_CHAOS config to exact clip-local windows (throws CtcContractError on
 * anything that would move a cut, reach the payoff, or cross a locked remap's timing).
 */
export function resolveCtc(configIn: CtcConfig, ctx: { clips: CtcClip[]; anchors: CtcAnchor[]; lockedRemaps: LockedRemap[] }): ResolvedCtcClip[] {
  const config = CtcConfigSchema.parse(configIn);
  const p = config.preset;
  if (p.cleanFractionBand[0] > p.cleanFraction || p.cleanFraction > p.cleanFractionBand[1]) throw new CtcContractError("preset cleanFraction lies outside its own band");
  const payoff = ctx.clips.filter((c) => c.role === "payoff");
  const firstPayoff = payoff.length ? Math.min(...payoff.map((c) => c.frameIn)) : Infinity;
  const seen = new Set<string>();
  const out: ResolvedCtcClip[] = [];
  config.assignments.forEach((a, ai) => {
    if (seen.has(a.clipId)) throw new CtcContractError(`${a.clipId}: assigned twice`);
    seen.add(a.clipId);
    const clip = ctx.clips.find((c) => c.clipId === a.clipId);
    if (!clip) throw new CtcContractError(`${a.clipId}: unknown clip`);
    if (clip.role === "payoff" || clip.frameIn >= firstPayoff) throw new CtcContractError(`${a.clipId}: the payoff stays completely clean (finalCleanPayoff)`);
    const n = clip.frameOut - clip.frameIn;
    const cf = a.cleanFraction ?? p.cleanFraction;
    const band = p.cleanFractionBand;
    if (cf < band[0] || cf > band[1]) throw new CtcContractError(`${a.clipId}: cleanFraction ${cf} outside the band ${band.join("-")}`);
    let onset = Math.round(n * cf);
    let onsetReason = `cleanFraction ${cf} of ${n} frames`;
    if (p.musicAlignment.enabled) {
      const cands = ctx.anchors
        .filter((e) => p.musicAlignment.eventTypes.includes(e.type) && e.timelineFrame > clip.frameIn && e.timelineFrame < clip.frameOut)
        .map((e) => ({ e, local: e.timelineFrame - clip.frameIn }))
        .filter((x) => Math.abs(x.local - onset) <= p.musicAlignment.maxShiftFrames && x.local / n >= band[0] && x.local / n <= band[1])
        .sort((x, y) => Math.abs(x.local - onset) - Math.abs(y.local - onset) || x.local - y.local);
      if (cands[0]) {
        onsetReason = `approved ${cands[0].e.type} ${cands[0].e.eventId} (timeline frame ${cands[0].e.timelineFrame}; ${(cands[0].local / n).toFixed(3)} of the clip)`;
        onset = cands[0].local;
      }
    }
    if (onset < 1 || onset >= n - 1) throw new CtcContractError(`${a.clipId}: onset ${onset} leaves no clean start or no effect`);
    const remaps = ctx.lockedRemaps.filter((r) => r.clipId === a.clipId);
    if (remaps.length > 1) throw new CtcContractError(`${a.clipId}: more than one locked remap`);
    const r = remaps[0] ?? null;
    if (r && (r.start < clip.frameIn || r.end > clip.frameOut)) throw new CtcContractError(`${r.id}: locked remap crosses a cut`);
    if (r && r.start - clip.frameIn <= onset) throw new CtcContractError(`${a.clipId}: the locked remap ${r.id} starts before the effect onset; the effect would ramp through it`);
    const peakAt = r ? r.start - clip.frameIn : n;
    const effects = a.effects.map((e, ei) => {
      if (e.params.type !== e.type) throw new CtcContractError(`${a.clipId}: params are for ${e.params.type}, effect is ${e.type}`);
      return { id: `ctc:${a.clipId.replace(/[^a-z0-9]/gi, "")}:${e.type}`, type: e.type, params: e.params, protect: e.protect ?? null, seed: (config.seed + ai * 1009 + ei * 101) >>> 0 };
    });
    // at most one temporal re-timing per clip (a step print is a remap of its own)
    if (effects.filter((e) => e.type === "stepPrint").length > 1 || (r && effects.some((e) => e.type === "stepPrint"))) throw new CtcContractError(`${a.clipId}: a step print cannot share a clip with another remap`);
    out.push({ clipId: a.clipId, label: a.label, frames: n, timeline: { frameIn: clip.frameIn, frameOut: clip.frameOut }, onset, onsetReason, cleanFraction: Math.round((onset / n) * 1000) / 1000, peakAt, maxIntensity: a.maxIntensity * p.maxIntensity, curve: p.escalation, lockedRemap: r ? { id: r.id, start: r.start - clip.frameIn, end: r.end - clip.frameIn } : null, effects });
  });
  return out;
}

/**
 * Step-print source map over [onset, frames): groups of n output frames show the group's first
 * frame; n = 1 + round((maxStep - 1) * strength) grows with the ramp (maxStep is the cadence at
 * strength 1, so the clip's ceiling also limits it). Returns the clip-local source frame for every
 * clip frame (identity outside the window). The source is never later than the output frame and
 * re-aligns at every group start.
 */
export function stepPrintMap(c: ResolvedCtcClip, maxStep: number): number[] {
  const m = Array.from({ length: c.frames }, (_, f) => f);
  let pos = c.onset;
  while (pos < c.frames) {
    const n = Math.max(1, 1 + Math.round((maxStep - 1) * strengthAt(c, pos)));
    for (let k = 0; k < n && pos + k < c.frames; k++) m[pos + k] = pos;
    pos += n;
  }
  return m;
}
