/**
 * Phase 6A core FX math (pure, dependency-free, shared by the Remotion components and the tests).
 *
 * All effects operate on integer clip-local frames [0, clipFrames) of a conformed clip (the render
 * grid). Nothing here chooses WHEN an effect is used: callers pass fully resolved effects.
 *
 * Determinism: no Math.random, no clocks. Pseudo-random values come from a 32-bit integer hash of
 * (seed, frame, index). Time remaps are integer frame maps that never read outside the clip and
 * never move the clip's first/last frame or any cut: every remap is local to its window and the
 * source position re-aligns with the timeline at the window end.
 *
 * Composition order per output frame (fixed):
 *   1. time remap (at most one of frameRepeat / temporalStutter / freezeFrame / speedRamp)
 *   2. echoTrail layers (prior frames of the remapped timeline)
 *   3. spatial transform (microZoom x cameraPunch, with automatic cover scale)
 *   4. rgbSplit (channel offset filter)
 *   5. filmTexture (grain overlay)
 *   6. flashFrame (overlay)
 */

export const FX_TYPES = ["flashFrame", "microZoom", "cameraPunch", "frameRepeat", "temporalStutter", "rgbSplit", "speedRamp", "freezeFrame", "echoTrail", "filmTexture"] as const;
export type FxType = (typeof FX_TYPES)[number];
export const REMAP_TYPES: readonly FxType[] = ["frameRepeat", "temporalStutter", "freezeFrame", "speedRamp"];
export type Curve = "linear" | "smooth" | "exp";

export interface Envelope {
  attack: number;
  hold: number;
  release: number;
  curve: Curve;
}

export type FxParams =
  | { type: "flashFrame"; mode: "exposure"; peakGain: number }
  | { type: "flashFrame"; mode: "screen"; color: string; peakOpacity: number }
  | { type: "microZoom"; peakScale: number; focusX: number; focusY: number }
  | { type: "cameraPunch"; translatePx: number; angleDeg: number; scalePunch: number; rotateDeg: number; oscillations: number }
  | { type: "frameRepeat"; mode: "hold"; sourceFrame: number | null }
  | { type: "frameRepeat"; mode: "step"; pattern: number[] }
  | { type: "temporalStutter"; loop: number; repeats: number; shrink: boolean }
  | { type: "rgbSplit"; offsetPx: number; angleDeg: number }
  | { type: "speedRamp"; profile: "surge" | "dip"; amount: number }
  | { type: "freezeFrame"; sourceFrame: number | null }
  | { type: "echoTrail"; trails: number; spacing: number; decay: number; blend: "lighten" | "darken" | "screen" | "normal" }
  | { type: "filmTexture"; grainSize: number; amount: number; chroma: number; flicker: number };

/** A resolved effect instance: clip-local integer frames, validated parameters. */
export interface ResolvedFx {
  id: string;
  type: FxType;
  enabled: boolean;
  /** first affected clip-local frame (inclusive) and end (exclusive) */
  start: number;
  end: number;
  intensity: number;
  mix: number;
  seed: number;
  envelope: Envelope;
  params: FxParams;
}

// ---------------------------------------------------------------------------------------------
// Deterministic noise

/** 32-bit integer hash (murmur3 finalizer style) of up to three integers -> [0, 1). */
export function hash01(seed: number, a: number, b = 0): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (a + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ (b * 0x27d4eb2d), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // unsigned: bitwise ops yield signed int32
}

// ---------------------------------------------------------------------------------------------
// Envelope

const shape = (x: number, curve: Curve) => (curve === "linear" ? x : curve === "smooth" ? x * x * (3 - 2 * x) : 1 - Math.pow(1 - x, 3));

/**
 * Envelope value in [0, 1] at clip-local frame f. Outside [start, end) it is exactly 0. The hold
 * stretches to fill the window; attack ramps up to reach 1 at frame start+attack-1 (attack 0 = hit
 * at full level on the first frame); release ramps down and never reaches 0 inside the window.
 */
export function envelopeAt(fx: Pick<ResolvedFx, "start" | "end" | "envelope">, f: number): number {
  if (f < fx.start || f >= fx.end) return 0;
  const L = fx.end - fx.start;
  const t = f - fx.start;
  const a = Math.min(fx.envelope.attack, L);
  const r = Math.min(fx.envelope.release, Math.max(0, L - a));
  if (t < a) return shape((t + 1) / (a + 1), fx.envelope.curve);
  if (t >= L - r) return shape((L - t) / (r + 1), fx.envelope.curve);
  return 1;
}

/** Effective strength at f: intensity x envelope, 0 when disabled. */
export function strengthAt(fx: ResolvedFx, f: number): number {
  return fx.enabled ? fx.intensity * envelopeAt(fx, f) : 0;
}

// ---------------------------------------------------------------------------------------------
// Time remap (integer frame maps; aligned with the timeline at both ends of the window)

/** Clip-local source frame shown at output frame f by one remap effect (or null if not active). */
export function remapFrame(fx: ResolvedFx, f: number): number | null {
  if (!fx.enabled || fx.intensity <= 0 || f < fx.start || f >= fx.end) return null;
  const p = fx.params;
  const t = f - fx.start;
  const L = fx.end - fx.start;
  switch (p.type) {
    case "freezeFrame":
      return p.sourceFrame ?? fx.start;
    case "frameRepeat": {
      if (p.mode === "hold") return p.sourceFrame ?? fx.start;
      // step print: each group of `n` output frames shows the group's first frame, then catches up
      let pos = 0;
      let k = 0;
      while (true) {
        const n = Math.max(1, p.pattern[k % p.pattern.length]!);
        if (t < pos + n) return fx.start + pos;
        pos += n;
        k++;
      }
    }
    case "temporalStutter": {
      // segments of `repeats` loops over `m` source frames; the loop length shrinks toward the end
      // when `shrink` is set (a stutter that tightens into the target event); re-aligns per segment
      let pos = 0;
      let seg = 0;
      while (true) {
        const m = p.shrink ? Math.max(1, Math.round(p.loop - ((p.loop - 1) * pos) / Math.max(1, L - 1))) : p.loop;
        const len = m * Math.max(1, p.repeats);
        if (t < pos + len) return fx.start + pos + ((t - pos) % m);
        pos += len;
        seg++;
        if (seg > 10_000) return f;
      }
    }
    case "speedRamp": {
      // endpoint-fixed warp w(u) = u + s*A*(1 - cos 2*pi*u)/(2*pi): speed 1 + s*A*sin(2*pi*u),
      // 1x at both ends; surge = faster then slower, dip = slower then faster
      const A = Math.min(0.8, p.amount * fx.intensity);
      const s = p.profile === "surge" ? 1 : -1;
      const u = t / L;
      const w = u + (s * A * (1 - Math.cos(2 * Math.PI * u))) / (2 * Math.PI);
      return Math.min(fx.end - 1, Math.max(fx.start, fx.start + Math.round(w * L)));
    }
    default:
      return null;
  }
}

/** The source frame shown at output frame f after the (single) active remap, clamped to the clip. */
export function sourceFrameAt(effects: readonly ResolvedFx[], f: number, clipFrames: number): number {
  for (const fx of effects) {
    if (!REMAP_TYPES.includes(fx.type)) continue;
    const p = remapFrame(fx, f);
    if (p !== null) return Math.min(clipFrames - 1, Math.max(0, p));
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Echo trail

export interface Layer {
  frame: number;
  opacity: number;
  blend: "normal" | "lighten" | "darken" | "screen";
}

/** Base layer plus echo layers (prior frames of the remapped timeline) at output frame f. */
export function layersAt(effects: readonly ResolvedFx[], f: number, clipFrames: number): Layer[] {
  const base: Layer = { frame: sourceFrameAt(effects, f, clipFrames), opacity: 1, blend: "normal" };
  const out = [base];
  for (const fx of effects) {
    if (fx.type !== "echoTrail" || fx.params.type !== "echoTrail") continue;
    const s = strengthAt(fx, f) * fx.mix;
    if (s <= 0) continue;
    for (let k = 1; k <= fx.params.trails; k++) {
      const g = f - k * fx.params.spacing;
      const frame = sourceFrameAt(effects, Math.max(0, g), clipFrames);
      if (frame === base.frame) continue;
      out.push({ frame, opacity: s * Math.pow(fx.params.decay, k - 1), blend: fx.params.blend });
    }
  }
  return out;
}

/**
 * Echo blend for how high-key a clip is: `brightShare` = share of pixels with luma >= 200 (0-1).
 * "lighten" keeps the brighter pixel: right for dark/normal footage (light trails) but on high-key
 * footage (a bright backdrop) the earlier frames' backdrop wins wherever a dark subject moved, and
 * the subject washes out. "darken" keeps dark subjects dark there (dark trails on a bright field).
 * Mean luma is NOT a usable measure: a dark subject on a white backdrop averages mid-grey.
 * Found in the Phase 6A real-motion re-review; the presets keep "lighten".
 */
export const HIGH_KEY_BRIGHT_SHARE = 0.25;
export function echoBlendFor(brightShare: number): "lighten" | "darken" {
  return brightShare >= HIGH_KEY_BRIGHT_SHARE ? "darken" : "lighten";
}

// ---------------------------------------------------------------------------------------------
// Spatial transform (microZoom x cameraPunch) with automatic cover scale

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
  rotateDeg: number;
  originX: number;
  originY: number;
}

export const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0, rotateDeg: 0, originX: 0.5, originY: 0.5 };

/**
 * Combined transform at f. microZoom scales about its focus; cameraPunch is a damped, deterministic
 * displacement (no random shake). The scale always covers the frame so no border is ever revealed.
 */
export function transformAt(effects: readonly ResolvedFx[], f: number, width: number, height: number): Transform {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let rot = 0;
  let ox = 0.5;
  let oy = 0.5;
  for (const fx of effects) {
    const s = strengthAt(fx, f);
    if (s <= 0) continue;
    const p = fx.params;
    if (p.type === "microZoom") {
      scale *= 1 + (p.peakScale - 1) * s;
      ox = p.focusX;
      oy = p.focusY;
    } else if (p.type === "cameraPunch") {
      const t = (f - fx.start) / Math.max(1, fx.end - fx.start - 1);
      const osc = Math.cos(Math.PI * 2 * p.oscillations * t) * Math.exp(-3 * t);
      const d = s * osc;
      const a = (p.angleDeg * Math.PI) / 180;
      tx += Math.cos(a) * p.translatePx * d;
      ty += Math.sin(a) * p.translatePx * d;
      rot += p.rotateDeg * d;
      scale *= 1 + p.scalePunch * Math.abs(d);
    }
  }
  if (scale === 1 && tx === 0 && ty === 0 && rot === 0) return IDENTITY;
  // cover (exact for a scale about origin (ox, oy) followed by a translation): each edge must stay
  // outside the frame -> S >= 1 + tx/(ox W), 1 - tx/((1-ox) W), ...; rotation multiplies the need
  const r = (Math.abs(rot) * Math.PI) / 180;
  const coverRot = Math.cos(r) + Math.sin(r) * Math.max(width / height, height / width);
  const need = Math.max(0, tx / (ox * width), -tx / ((1 - ox) * width), ty / (oy * height), -ty / ((1 - oy) * height));
  return { scale: Math.max(scale, coverRot * (1 + need)), tx, ty, rotateDeg: rot, originX: ox, originY: oy };
}

// ---------------------------------------------------------------------------------------------
// Per-frame values for the filter / overlay effects

export function rgbSplitAt(effects: readonly ResolvedFx[], f: number): { dx: number; dy: number; mix: number } | null {
  for (const fx of effects) {
    if (fx.params.type !== "rgbSplit") continue;
    const s = strengthAt(fx, f);
    if (s <= 0) continue;
    const a = (fx.params.angleDeg * Math.PI) / 180;
    return { dx: Math.cos(a) * fx.params.offsetPx * s, dy: Math.sin(a) * fx.params.offsetPx * s, mix: fx.mix };
  }
  return null;
}

/**
 * Flash at f. "exposure" (default) is a multiplicative brightness lift of the picture (blacks stay
 * black, like a real exposure spike); "screen" is a coloured veil (lifts blacks; use sparingly).
 */
export function flashAt(effects: readonly ResolvedFx[], f: number): { gain: number; color: string | null; opacity: number } | null {
  let gain = 1;
  let veil: { color: string; opacity: number } | null = null;
  for (const fx of effects) {
    const p = fx.params;
    if (p.type !== "flashFrame") continue;
    const s = strengthAt(fx, f) * fx.mix;
    if (s <= 0) continue;
    if (p.mode === "exposure") gain = Math.max(gain, Math.min(MAX_FLASH_GAIN, 1 + (p.peakGain - 1) * s));
    else {
      const o = Math.min(MAX_FLASH_OPACITY, p.peakOpacity * s);
      if (!veil || o > veil.opacity) veil = { color: p.color, opacity: o };
    }
  }
  if (gain === 1 && !veil) return null;
  return { gain, color: veil?.color ?? null, opacity: veil?.opacity ?? 0 };
}

export function grainAt(effects: readonly ResolvedFx[], f: number): { seed: number; frame: number; grainSize: number; amount: number; chroma: number; flicker: number } | null {
  for (const fx of effects) {
    if (fx.params.type !== "filmTexture") continue;
    const s = strengthAt(fx, f) * fx.mix;
    if (s <= 0) continue;
    const flick = fx.params.flicker > 0 ? (hash01(fx.seed, f, 7) * 2 - 1) * fx.params.flicker * s : 0;
    return { seed: fx.seed, frame: f, grainSize: fx.params.grainSize, amount: fx.params.amount * s, chroma: fx.params.chroma, flicker: flick };
  }
  return null;
}

/**
 * Deterministic grain tile (RGBA, w x h) for one frame: approximately gaussian (sum of two
 * uniforms), centred on mid-grey for an overlay blend; chroma mixes independent channel noise.
 */
export function grainPixels(w: number, h: number, seed: number, frame: number, chroma: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const l = hash01(seed, frame, i * 4) + hash01(seed, frame, i * 4 + 1) - 1;
    const r = chroma > 0 ? hash01(seed, frame, i * 4 + 2) - 0.5 : 0;
    const b = chroma > 0 ? hash01(seed, frame, i * 4 + 3) - 0.5 : 0;
    const L = 128 + l * 127;
    px[i * 4] = L + r * 127 * chroma;
    px[i * 4 + 1] = L;
    px[i * 4 + 2] = L + b * 127 * chroma;
    px[i * 4 + 3] = 255;
  }
  return px;
}

// ---------------------------------------------------------------------------------------------
// Guardrails

/** Hard caps: coloured veil opacity (no whiteouts) and exposure gain. */
export const MAX_FLASH_OPACITY = 0.85;
export const MAX_FLASH_GAIN = 2.2;
/** Photosensitivity guard (WCAG 2.3.1): at most 3 flash onsets in any 1-second window. */
export const MAX_FLASHES_PER_SECOND = 3;
