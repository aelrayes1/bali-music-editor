/**
 * Phase 6A effect contract: authoring schema, restraint presets, and resolution to clip-local
 * integer frames. An effect is anchored by exactly one of:
 *   - a timeline frame index,
 *   - an exact rational timeline time (snapped with the project's render-frame rule, snap recorded),
 *   - a music-event reference (eventId + optional frame offset) resolved from the project's music
 *     events; the effect never chooses the event itself.
 * Validation fails loudly for anything that could break frames or timing: windows outside the
 * clip, overlapping time remaps, unsafe flash rates, parameters out of range, zoom-out, unknown
 * events, remaps across cuts.
 */

import { z } from "zod";
import { RationalSchema } from "../media/schema.ts";
import { type Rational, mul, roundHalfUp, sub, toNumberApprox } from "../time/rational.ts";
import { FX_TYPES, type FxParams, type FxType, MAX_FLASHES_PER_SECOND, MAX_FLASH_GAIN, MAX_FLASH_OPACITY, REMAP_TYPES, type ResolvedFx } from "./core.ts";

export const FX_CONTRACT_VERSION = "1.0.0";
export const PRESETS = ["SUBTLE", "MEDIUM", "STRONG"] as const;
export type Preset = (typeof PRESETS)[number];

const Frac = z.number().min(0).max(1);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const PARAM_SCHEMAS = [
  z.object({ type: z.literal("flashFrame"), mode: z.literal("exposure"), peakGain: z.number().min(1).max(MAX_FLASH_GAIN) }).strict(),
  z.object({ type: z.literal("flashFrame"), mode: z.literal("screen"), color: Hex, peakOpacity: z.number().min(0).max(MAX_FLASH_OPACITY) }).strict(),
  z.object({ type: z.literal("microZoom"), peakScale: z.number().min(1).max(1.25), focusX: Frac, focusY: Frac }).strict(),
  z.object({ type: z.literal("cameraPunch"), translatePx: z.number().min(0).max(80), angleDeg: z.number(), scalePunch: z.number().min(0).max(0.1), rotateDeg: z.number().min(-3).max(3), oscillations: z.number().min(0.5).max(3) }).strict(),
  z.object({ type: z.literal("frameRepeat"), mode: z.literal("hold"), sourceFrame: z.number().int().min(0).nullable() }).strict(),
  z.object({ type: z.literal("frameRepeat"), mode: z.literal("step"), pattern: z.array(z.number().int().min(1).max(12)).min(1).max(32) }).strict(),
  z.object({ type: z.literal("temporalStutter"), loop: z.number().int().min(1).max(12), repeats: z.number().int().min(1).max(8), shrink: z.boolean() }).strict(),
  z.object({ type: z.literal("rgbSplit"), offsetPx: z.number().min(0).max(24), angleDeg: z.number() }).strict(),
  z.object({ type: z.literal("speedRamp"), profile: z.enum(["surge", "dip"]), amount: z.number().gt(0).max(0.8) }).strict(),
  z.object({ type: z.literal("freezeFrame"), sourceFrame: z.number().int().min(0).nullable() }).strict(),
  z.object({ type: z.literal("echoTrail"), trails: z.number().int().min(1).max(6), spacing: z.number().int().min(1).max(8), decay: z.number().gt(0).max(0.95), blend: z.enum(["lighten", "darken", "screen", "normal"]) }).strict(),
  z.object({ type: z.literal("filmTexture"), grainSize: z.number().int().min(1).max(4), amount: z.number().min(0).max(0.35), chroma: Frac, flicker: z.number().min(0).max(0.04) }).strict(),
] as const;
// frameRepeat has two shapes (hold / step), so a plain union rather than a discriminated one
export const FxParamsSchema = z.union(PARAM_SCHEMAS);

export const Anchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame"), frame: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("time"), time: RationalSchema }).strict(),
  z.object({ kind: z.literal("musicEvent"), eventId: z.string(), offsetFrames: z.number().int().default(0) }).strict(),
]);

export const EnvelopeSchema = z.object({ attack: z.number().int().min(0), hold: z.number().int().min(0), release: z.number().int().min(0), curve: z.enum(["linear", "smooth", "exp"]) }).strict();

export const EffectSchema = z
  .object({
    id: z.string().regex(/^fx:[a-z0-9-]+$/),
    type: z.enum(FX_TYPES),
    enabled: z.boolean().default(true),
    /** clip the effect belongs to (all effects are clip-scoped; overlays may span a whole clip only) */
    clipId: z.string(),
    anchor: Anchor,
    durationFrames: z.number().int().min(1).max(90),
    preset: z.enum(PRESETS).optional(),
    intensity: z.number().min(0).max(1),
    mix: Frac.default(1),
    seed: z.number().int().min(0).max(2 ** 31 - 1).default(1),
    envelope: EnvelopeSchema.optional(),
    params: FxParamsSchema.optional(),
  })
  .strict();
export type Effect = z.input<typeof EffectSchema>;

// ---------------------------------------------------------------------------------------------
// Restraint presets (demo/parameter presets; SUBTLE is the production-safe default). These are
// vocabulary, never editorial choices.

type PresetDef = { durationFrames: number; envelope: z.infer<typeof EnvelopeSchema>; params: FxParams; intensity: number; mix: number };
const env = (attack: number, hold: number, release: number, curve: "linear" | "smooth" | "exp" = "smooth") => ({ attack, hold, release, curve });

export const FX_PRESETS: Record<FxType, Record<Preset, PresetDef>> = {
  flashFrame: {
    SUBTLE: { durationFrames: 2, envelope: env(0, 0, 1, "exp"), params: { type: "flashFrame", mode: "exposure", peakGain: 1.3 }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 3, envelope: env(0, 0, 2, "exp"), params: { type: "flashFrame", mode: "exposure", peakGain: 1.6 }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 4, envelope: env(0, 1, 2, "exp"), params: { type: "flashFrame", mode: "exposure", peakGain: 2.0 }, intensity: 1, mix: 1 },
  },
  microZoom: {
    SUBTLE: { durationFrames: 12, envelope: env(2, 0, 9), params: { type: "microZoom", peakScale: 1.025, focusX: 0.5, focusY: 0.42 }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 14, envelope: env(2, 1, 10), params: { type: "microZoom", peakScale: 1.05, focusX: 0.5, focusY: 0.42 }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 16, envelope: env(2, 2, 11), params: { type: "microZoom", peakScale: 1.09, focusX: 0.5, focusY: 0.42 }, intensity: 1, mix: 1 },
  },
  cameraPunch: {
    SUBTLE: { durationFrames: 10, envelope: env(0, 0, 8, "exp"), params: { type: "cameraPunch", translatePx: 10, angleDeg: 90, scalePunch: 0.012, rotateDeg: 0.2, oscillations: 1 }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 12, envelope: env(0, 0, 10, "exp"), params: { type: "cameraPunch", translatePx: 18, angleDeg: 90, scalePunch: 0.02, rotateDeg: 0.4, oscillations: 1.25 }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 14, envelope: env(0, 0, 12, "exp"), params: { type: "cameraPunch", translatePx: 30, angleDeg: 80, scalePunch: 0.035, rotateDeg: 0.8, oscillations: 1.5 }, intensity: 1, mix: 1 },
  },
  frameRepeat: {
    SUBTLE: { durationFrames: 6, envelope: env(0, 6, 0, "linear"), params: { type: "frameRepeat", mode: "step", pattern: [2] }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 9, envelope: env(0, 9, 0, "linear"), params: { type: "frameRepeat", mode: "step", pattern: [3] }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 12, envelope: env(0, 12, 0, "linear"), params: { type: "frameRepeat", mode: "step", pattern: [4] }, intensity: 1, mix: 1 },
  },
  temporalStutter: {
    SUBTLE: { durationFrames: 8, envelope: env(0, 8, 0, "linear"), params: { type: "temporalStutter", loop: 2, repeats: 2, shrink: false }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 12, envelope: env(0, 12, 0, "linear"), params: { type: "temporalStutter", loop: 3, repeats: 2, shrink: true }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 18, envelope: env(0, 18, 0, "linear"), params: { type: "temporalStutter", loop: 4, repeats: 3, shrink: true }, intensity: 1, mix: 1 },
  },
  rgbSplit: {
    SUBTLE: { durationFrames: 4, envelope: env(0, 1, 2, "exp"), params: { type: "rgbSplit", offsetPx: 3, angleDeg: 0 }, intensity: 1, mix: 0.7 },
    MEDIUM: { durationFrames: 5, envelope: env(0, 1, 3, "exp"), params: { type: "rgbSplit", offsetPx: 6, angleDeg: 0 }, intensity: 1, mix: 0.8 },
    STRONG: { durationFrames: 6, envelope: env(0, 2, 3, "exp"), params: { type: "rgbSplit", offsetPx: 12, angleDeg: 10 }, intensity: 1, mix: 0.9 },
  },
  speedRamp: {
    SUBTLE: { durationFrames: 20, envelope: env(0, 20, 0, "linear"), params: { type: "speedRamp", profile: "surge", amount: 0.35 }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 24, envelope: env(0, 24, 0, "linear"), params: { type: "speedRamp", profile: "surge", amount: 0.55 }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 30, envelope: env(0, 30, 0, "linear"), params: { type: "speedRamp", profile: "surge", amount: 0.8 }, intensity: 1, mix: 1 },
  },
  freezeFrame: {
    SUBTLE: { durationFrames: 4, envelope: env(0, 4, 0, "linear"), params: { type: "freezeFrame", sourceFrame: null }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 8, envelope: env(0, 8, 0, "linear"), params: { type: "freezeFrame", sourceFrame: null }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 14, envelope: env(0, 14, 0, "linear"), params: { type: "freezeFrame", sourceFrame: null }, intensity: 1, mix: 1 },
  },
  echoTrail: {
    SUBTLE: { durationFrames: 12, envelope: env(2, 4, 5), params: { type: "echoTrail", trails: 2, spacing: 2, decay: 0.55, blend: "lighten" }, intensity: 1, mix: 0.35 },
    MEDIUM: { durationFrames: 16, envelope: env(3, 6, 6), params: { type: "echoTrail", trails: 3, spacing: 2, decay: 0.6, blend: "lighten" }, intensity: 1, mix: 0.5 },
    STRONG: { durationFrames: 20, envelope: env(3, 8, 8), params: { type: "echoTrail", trails: 4, spacing: 3, decay: 0.65, blend: "lighten" }, intensity: 1, mix: 0.7 },
  },
  filmTexture: {
    SUBTLE: { durationFrames: 60, envelope: env(0, 60, 0, "linear"), params: { type: "filmTexture", grainSize: 2, amount: 0.06, chroma: 0, flicker: 0 }, intensity: 1, mix: 1 },
    MEDIUM: { durationFrames: 60, envelope: env(0, 60, 0, "linear"), params: { type: "filmTexture", grainSize: 2, amount: 0.11, chroma: 0.08, flicker: 0.008 }, intensity: 1, mix: 1 },
    STRONG: { durationFrames: 60, envelope: env(0, 60, 0, "linear"), params: { type: "filmTexture", grainSize: 3, amount: 0.18, chroma: 0.15, flicker: 0.015 }, intensity: 1, mix: 1 },
  },
};

/** Build an effect from a preset (explicit fields override the preset). */
export function fromPreset(type: FxType, preset: Preset, base: { id: string; clipId: string; anchor: z.input<typeof Anchor>; seed?: number }, overrides: Partial<Effect> = {}): Effect {
  const p = FX_PRESETS[type][preset];
  return { id: base.id, type, clipId: base.clipId, anchor: base.anchor, durationFrames: p.durationFrames, preset, intensity: p.intensity, mix: p.mix, seed: base.seed ?? 1, envelope: p.envelope, params: p.params, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface ResolveContext {
  fps: Rational;
  /** timeline frame range of every clip */
  clips: Array<{ clipId: string; frameIn: number; frameOut: number }>;
  /** music events by id: song time */
  musicEvents: Map<string, Rational>;
  /** song time of timeline frame 0 */
  audioStart: Rational;
}

export interface ResolvedWithAnchor extends ResolvedFx {
  clipId: string;
  timelineStart: number;
  timelineEnd: number;
  anchor: { kind: string; eventId?: string; snapErrorMs: number | null };
}

export class FxContractError extends Error {}

/** Resolve and validate a set of effects (throws FxContractError on any unsafe/ambiguous input). */
export function resolveEffects(input: Effect[], ctx: ResolveContext): ResolvedWithAnchor[] {
  const out: ResolvedWithAnchor[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    const e = EffectSchema.parse(raw);
    if (ids.has(e.id)) throw new FxContractError(`${e.id}: duplicate effect id`);
    ids.add(e.id);
    const preset = e.preset ? FX_PRESETS[e.type][e.preset] : null;
    const params = e.params ?? preset?.params;
    const envelope = e.envelope ?? preset?.envelope;
    if (!params || !envelope) throw new FxContractError(`${e.id}: params/envelope missing and no preset given`);
    if (params.type !== e.type) throw new FxContractError(`${e.id}: params are for ${params.type}, effect is ${e.type}`);
    const clip = ctx.clips.find((c) => c.clipId === e.clipId);
    if (!clip) throw new FxContractError(`${e.id}: unknown clip ${e.clipId}`);
    // anchor -> timeline frame (same snap rule as cuts: nearest frame, half up)
    let tf: number;
    let snapErrorMs: number | null = null;
    let eventId: string | undefined;
    if (e.anchor.kind === "frame") tf = e.anchor.frame;
    else {
      const t: Rational = e.anchor.kind === "time" ? e.anchor.time : (() => {
        const s = ctx.musicEvents.get(e.anchor.eventId);
        if (!s) throw new FxContractError(`${e.id}: music event ${e.anchor.eventId} not found`);
        eventId = e.anchor.eventId;
        return sub(s, ctx.audioStart);
      })();
      const exact = mul(t, ctx.fps);
      tf = roundHalfUp(exact) + (e.anchor.kind === "musicEvent" ? e.anchor.offsetFrames : 0);
      snapErrorMs = Math.round(((roundHalfUp(exact) - toNumberApprox(exact)) / toNumberApprox(ctx.fps)) * 100000) / 100;
    }
    const start = tf - clip.frameIn;
    const end = start + e.durationFrames;
    const n = clip.frameOut - clip.frameIn;
    if (start < 0 || end > n) throw new FxContractError(`${e.id}: window ${tf}-${tf + e.durationFrames} leaves clip ${e.clipId} (${clip.frameIn}-${clip.frameOut}); effects never cross a cut`);
    if (envelope.attack + envelope.release > e.durationFrames) throw new FxContractError(`${e.id}: attack + release exceed the duration`);
    if ((params.type === "frameRepeat" || params.type === "freezeFrame") && "sourceFrame" in params && params.sourceFrame !== null && (params.sourceFrame < 0 || params.sourceFrame >= n)) throw new FxContractError(`${e.id}: sourceFrame outside the clip`);
    if (REMAP_TYPES.includes(e.type) && e.mix !== 1) throw new FxContractError(`${e.id}: time remaps cannot be mixed (mix must be 1)`);
    out.push({ id: e.id, type: e.type, enabled: e.enabled, start, end, intensity: e.intensity, mix: e.mix, seed: e.seed, envelope, params, clipId: e.clipId, timelineStart: tf, timelineEnd: tf + e.durationFrames, anchor: { kind: e.anchor.kind, ...(eventId ? { eventId } : {}), snapErrorMs } });
  }
  validateComposition(out);
  return out.filter((f) => f.enabled);
}

/** Composition rules (fail loudly). */
export function validateComposition(fx: ResolvedWithAnchor[]): void {
  const on = fx.filter((f) => f.enabled);
  // at most one time remap active on any frame of a clip (ambiguous source frame otherwise)
  const remaps = on.filter((f) => REMAP_TYPES.includes(f.type));
  for (let i = 0; i < remaps.length; i++)
    for (let j = i + 1; j < remaps.length; j++) {
      const a = remaps[i]!;
      const b = remaps[j]!;
      if (a.clipId === b.clipId && a.start < b.end && b.start < a.end) throw new FxContractError(`${a.id} and ${b.id}: overlapping time remaps (${a.type} + ${b.type}) are ambiguous`);
    }
  // photosensitivity: flash onsets per rolling second on the timeline
  const onsets = on.filter((f) => f.type === "flashFrame").map((f) => f.timelineStart).sort((a, b) => a - b);
  for (let i = 0; i < onsets.length; i++) {
    const inSecond = onsets.filter((o) => o >= onsets[i]! && o < onsets[i]! + 30).length;
    if (inSecond > MAX_FLASHES_PER_SECOND) throw new FxContractError(`more than ${MAX_FLASHES_PER_SECOND} flashes within one second from timeline frame ${onsets[i]} (photosensitivity guard)`);
  }
  // one of each spatial/filter type per frame (their parameters would silently fight otherwise)
  for (const t of ["microZoom", "cameraPunch", "rgbSplit", "filmTexture", "echoTrail"] as const) {
    const xs = on.filter((f) => f.type === t);
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[i]!.clipId === xs[j]!.clipId && xs[i]!.start < xs[j]!.end && xs[j]!.start < xs[i]!.end) throw new FxContractError(`${xs[i]!.id} and ${xs[j]!.id}: two overlapping ${t} effects`);
  }
  // screen-blended echoes accumulate into haze: only allowed at a restrained mix
  for (const e of on) if (e.params.type === "echoTrail" && e.params.blend === "screen" && e.mix * e.intensity > 0.35) throw new FxContractError(`${e.id}: screen-blended echo above mix 0.35 washes the frame out (use lighten)`);
  // echo during a freeze shows nothing but a doubled frame: reject as a likely mistake
  for (const e of on.filter((f) => f.type === "echoTrail"))
    for (const z of on.filter((f) => f.type === "freezeFrame" && f.clipId === e.clipId)) if (e.start >= z.start && e.end <= z.end) throw new FxContractError(`${e.id} lies entirely inside freeze ${z.id}: an echo of a frozen frame is invisible`);
}
