/**
 * Phase 6B SUBJECT_ISOLATED_TEMPORAL_STUTTER: contract, review presets and the subject timing
 * pattern. A higher-level, subject-aware composition built ON the Phase 6A vocabulary (anchors and
 * the frameRepeat / temporalStutter frame maps), never a change to it: the whole-frame 6A
 * temporalStutter still exists unchanged as a separate capability.
 *
 * The primary human repeats/stutters in time while the background continues (default), holds, or
 * continues with global alignment. There is no generative fill: every output pixel is a real pixel
 * of the clean frame or of the earlier source frame being repeated. The pattern only ever shows the
 * current or an earlier frame and returns to the clean timeline at the window end, so the first
 * frame after the effect IS the clean frame and the timeline duration never changes.
 */

import { z } from "zod";
import { REMAP_TYPES, remapFrame, type ResolvedFx, hash01 } from "../core.ts";
import { Anchor, type ResolveContext, FxContractError, resolveEffects } from "../contract.ts";
import type { SubjectInsert } from "./insert.ts";

export const SUBJECT_STUTTER_VERSION = "1.0.0";
export const SUBJECT_MODES = ["SUBJECT_FRAME_REPEAT", "SUBJECT_TEMPORAL_STUTTER", "SUBJECT_STUTTER_CRESCENDO"] as const;
export type SubjectMode = (typeof SUBJECT_MODES)[number];
export const BACKGROUND_MODES = ["BACKGROUND_CONTINUES", "BACKGROUND_HOLD", "BACKGROUND_SMOOTH_CONTINUE"] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];
export const SUBJECT_PRESETS_LIST = ["SUBTLE", "MEDIUM", "STRONG"] as const;
export type SubjectPreset = (typeof SUBJECT_PRESETS_LIST)[number];
type Curve = "linear" | "smooth" | "exp";

/** Who the subject is. Pixel coordinates are in the conformed clip frame (e.g. 1080x1920). */
export const SubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }).strict(),
  z.object({ kind: z.literal("humanOverride"), overrideId: z.string().regex(/^usr:/) }).strict(),
  z.object({ kind: z.literal("projectSubject"), j: z.number().int().min(0), x: z.number(), y: z.number(), note: z.string() }).strict(),
]);

export const SubjectStutterSchema = z
  .object({
    id: z.string().regex(/^fx:[a-z0-9-]+$/),
    kind: z.literal("SUBJECT_ISOLATED_TEMPORAL_STUTTER"),
    enabled: z.boolean().default(true),
    clipId: z.string(),
    subject: SubjectRefSchema.default({ kind: "auto" }),
    /** start: a frame, an exact rational time, or a music event (+ offset) — the Phase 6A anchors */
    anchor: Anchor,
    /** end = start + durationFrames (exclusive); the window never crosses a cut */
    durationFrames: z.number().int().min(2).max(60),
    preset: z.enum(SUBJECT_PRESETS_LIST).optional(),
    mode: z.enum(SUBJECT_MODES),
    /** SUBJECT_FRAME_REPEAT: hold lengths (cycled); null = deterministic seeded pattern around `interval` */
    pattern: z.array(z.number().int().min(1).max(12)).min(1).max(32).nullable().default(null),
    /** loop passes per segment (TEMPORAL_STUTTER / CRESCENDO) */
    repeats: z.number().int().min(1).max(8),
    /** loop length (stutter) or hold length (frame repeat), in frames */
    interval: z.number().int().min(1).max(12),
    /** CRESCENDO: how the loop tightens toward the window end */
    crescendoCurve: z.enum(["linear", "smooth", "exp"]).default("linear"),
    /** soft edge of the region, full-resolution px (the seam lies in the background) */
    featherPx: z.number().min(0).max(32),
    /** how far the region reaches beyond the subject (both poses), full-resolution px */
    marginPx: z.number().min(8).max(96),
    /** bounded temporal smoothing of the subject matte (median radius, frames) */
    temporalSmoothing: z.number().int().min(0).max(3),
    backgroundMode: z.enum(BACKGROUND_MODES).default("BACKGROUND_CONTINUES"),
    /** opacity of the repeated subject over the clean frame (1 = replace; < 1 = ghosted double) */
    mix: z.number().min(0).max(1).default(1),
    seed: z.number().int().min(0).max(2 ** 31 - 1).default(1),
  })
  .strict();
export type SubjectStutter = z.input<typeof SubjectStutterSchema>;
export type SubjectStutterParams = z.output<typeof SubjectStutterSchema>;

type PresetDef = Pick<SubjectStutterParams, "durationFrames" | "mode" | "pattern" | "repeats" | "interval" | "crescendoCurve" | "featherPx" | "marginPx" | "temporalSmoothing" | "backgroundMode" | "mix">;
const P = (durationFrames: number, mode: SubjectMode, interval: number, repeats: number, crescendoCurve: Curve, featherPx: number, marginPx: number, pattern: number[] | null = null): PresetDef => ({ durationFrames, mode, pattern, repeats, interval, crescendoCurve, featherPx, marginPx, temporalSmoothing: 2, backgroundMode: "BACKGROUND_CONTINUES", mix: 1 });

/**
 * Review presets (vocabulary, never editorial choices). SUBTLE reads as a musical hiccup, MEDIUM is
 * a clear stutter, STRONG is for creative review. Feathers stay small: the default must make the
 * segmentation invisible (no glow, no halo, no cut-out look).
 */
export const SUBJECT_PRESETS: Record<SubjectMode, Record<SubjectPreset, PresetDef>> = {
  SUBJECT_TEMPORAL_STUTTER: {
    SUBTLE: P(8, "SUBJECT_TEMPORAL_STUTTER", 2, 2, "linear", 8, 24),
    MEDIUM: P(12, "SUBJECT_TEMPORAL_STUTTER", 3, 2, "linear", 8, 28),
    STRONG: P(18, "SUBJECT_TEMPORAL_STUTTER", 4, 3, "linear", 10, 32),
  },
  SUBJECT_STUTTER_CRESCENDO: {
    SUBTLE: P(12, "SUBJECT_STUTTER_CRESCENDO", 3, 2, "linear", 8, 24),
    MEDIUM: P(18, "SUBJECT_STUTTER_CRESCENDO", 4, 2, "smooth", 8, 28),
    STRONG: P(24, "SUBJECT_STUTTER_CRESCENDO", 6, 2, "exp", 10, 32),
  },
  SUBJECT_FRAME_REPEAT: {
    SUBTLE: P(8, "SUBJECT_FRAME_REPEAT", 2, 1, "linear", 8, 24, [2]),
    MEDIUM: P(12, "SUBJECT_FRAME_REPEAT", 3, 1, "linear", 8, 28, [3]),
    STRONG: P(16, "SUBJECT_FRAME_REPEAT", 4, 1, "linear", 10, 32, [4]),
  },
};

export function subjectFromPreset(mode: SubjectMode, preset: SubjectPreset, base: { id: string; clipId: string; anchor: z.input<typeof Anchor>; subject?: z.input<typeof SubjectRefSchema>; seed?: number }, over: Partial<SubjectStutter> = {}): SubjectStutter {
  return { kind: "SUBJECT_ISOLATED_TEMPORAL_STUTTER", id: base.id, clipId: base.clipId, anchor: base.anchor, subject: base.subject ?? { kind: "auto" }, preset, seed: base.seed ?? 1, ...SUBJECT_PRESETS[mode][preset], ...over };
}

export interface ResolvedSubjectStutter extends SubjectStutterParams {
  /** clip-local window [start, end) */
  start: number;
  end: number;
  timelineStart: number;
  timelineEnd: number;
  anchorResolved: { kind: string; eventId?: string; snapErrorMs: number | null };
}

/**
 * Resolve the anchor exactly like a Phase 6A effect (same snap rule, same "never cross a cut"
 * validation) by resolving a proxy window through the 6A contract.
 */
export function resolveSubjectStutter(input: SubjectStutter, ctx: ResolveContext): ResolvedSubjectStutter {
  const e = SubjectStutterSchema.parse(input);
  if (e.mode === "SUBJECT_FRAME_REPEAT" && e.repeats !== 1) throw new FxContractError(`${e.id}: SUBJECT_FRAME_REPEAT uses hold lengths (pattern/interval), repeats must be 1`);
  const [w] = resolveEffects([{ id: e.id, type: "freezeFrame", clipId: e.clipId, anchor: e.anchor, durationFrames: e.durationFrames, intensity: 1, envelope: { attack: 0, hold: e.durationFrames, release: 0, curve: "linear" }, params: { type: "freezeFrame", sourceFrame: null } }], ctx);
  return { ...e, start: w!.start, end: w!.end, timelineStart: w!.timelineStart, timelineEnd: w!.timelineEnd, anchorResolved: w!.anchor };
}

const shape = (x: number, c: Curve) => (c === "linear" ? x : c === "smooth" ? x * x * (3 - 2 * x) : 1 - Math.pow(1 - x, 3));

/** Deterministic hold lengths around `interval` (+-1) for a seeded frame-repeat pattern. */
export function seededPattern(interval: number, seed: number, n = 32): number[] {
  return Array.from({ length: n }, (_, k) => Math.max(1, interval + Math.floor(hash01(seed, k, 11) * 3) - 1));
}

/**
 * Clip-local source frame the SUBJECT shows at output frame f (null outside the window). Uses the
 * Phase 6A frame maps where they express the pattern exactly: frameRepeat for SUBJECT_FRAME_REPEAT,
 * temporalStutter for SUBJECT_TEMPORAL_STUTTER and for a linear crescendo (identical to 6A `shrink`).
 * Non-linear crescendo curves follow the same segment structure with a shaped loop length.
 */
export function subjectFrameAt(fx: Pick<ResolvedSubjectStutter, "enabled" | "start" | "end" | "mode" | "pattern" | "repeats" | "interval" | "crescendoCurve" | "seed">, f: number): number | null {
  if (!fx.enabled || f < fx.start || f >= fx.end) return null;
  const base = { id: "proxy", enabled: true, start: fx.start, end: fx.end, intensity: 1, mix: 1, seed: fx.seed, envelope: { attack: 0, hold: fx.end - fx.start, release: 0, curve: "linear" as const } };
  if (fx.mode === "SUBJECT_FRAME_REPEAT") return remapFrame({ ...base, type: "frameRepeat", params: { type: "frameRepeat", mode: "step", pattern: fx.pattern ?? seededPattern(fx.interval, fx.seed) } } as ResolvedFx, f);
  if (fx.mode === "SUBJECT_TEMPORAL_STUTTER" || fx.crescendoCurve === "linear")
    return remapFrame({ ...base, type: "temporalStutter", params: { type: "temporalStutter", loop: fx.interval, repeats: fx.repeats, shrink: fx.mode === "SUBJECT_STUTTER_CRESCENDO" } } as ResolvedFx, f);
  const t = f - fx.start;
  const L = fx.end - fx.start;
  let pos = 0;
  for (let seg = 0; seg < 10_000; seg++) {
    const m = Math.max(1, Math.round(fx.interval - (fx.interval - 1) * shape(pos / Math.max(1, L - 1), fx.crescendoCurve)));
    const len = m * Math.max(1, fx.repeats);
    if (t < pos + len) return fx.start + pos + ((t - pos) % m);
    pos += len;
  }
  return f;
}

/**
 * Fail loudly for ambiguous stacks: overlapping inserts; a 6A time remap on the same frames as a
 * subject insert (two different ideas of which frame is shown); a hold/freeze whose source frame
 * lies inside an insert (it would freeze a stuttered frame, not a clean one); windows outside the clip.
 */
export function validateInserts(effects: readonly (ResolvedFx & { id: string })[], inserts: readonly SubjectInsert[], clipFrames: number): void {
  const sorted = [...inserts].sort((a, b) => a.start - b.start);
  for (const [k, i] of sorted.entries()) {
    if (i.start < 0 || i.end > clipFrames || i.end <= i.start) throw new FxContractError(`${i.id}: insert window ${i.start}-${i.end} outside clip (0-${clipFrames})`);
    const n = sorted[k + 1];
    if (n && n.start < i.end) throw new FxContractError(`${i.id} and ${n.id}: overlapping subject effects`);
  }
  for (const e of effects) {
    if (!e.enabled || !REMAP_TYPES.includes(e.type)) continue;
    for (const i of inserts) {
      if (e.start < i.end && i.start < e.end) throw new FxContractError(`${e.id} (${e.type}) overlaps subject effect ${i.id}: a whole-frame time remap and a subject stutter cannot share frames`);
      const src = "sourceFrame" in e.params ? e.params.sourceFrame : null;
      if (src !== null && src >= i.start && src < i.end) throw new FxContractError(`${e.id} holds frame ${src}, inside subject effect ${i.id}`);
    }
  }
}
