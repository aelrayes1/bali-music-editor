/**
 * Phase 12: content-level render QC against an approved reference picture. Decoded frames are compared
 * (never just file names or metadata): frame alignment finds dropped / duplicated frames and one-frame
 * timing shifts; per-frame measures find black frames, brightness spikes, clipping, a proxy / low-res
 * substitution, and an effect tail leaking across a clean reset. Pure functions on RGB24 frames.
 */

import { type Issue } from "./errors.ts";

export interface Frames {
  w: number;
  h: number;
  /** RGB24, one buffer per frame */
  frames: Uint8Array[];
}

const lumaMean = (f: Uint8Array) => {
  let t = 0;
  for (let i = 0; i < f.length; i += 3) t += 0.2126 * f[i]! + 0.7152 * f[i + 1]! + 0.0722 * f[i + 2]!;
  return t / (f.length / 3);
};
const clipShare = (f: Uint8Array) => {
  let c = 0;
  for (let i = 0; i < f.length; i += 3) if (f[i]! >= 250 || f[i + 1]! >= 250 || f[i + 2]! >= 250) c++;
  return c / (f.length / 3);
};
export const psnr = (a: Uint8Array, b: Uint8Array) => {
  let e = 0;
  for (let i = 0; i < a.length; i++) e += (a[i]! - b[i]!) ** 2;
  return e === 0 ? 99 : 10 * Math.log10(65025 / (e / a.length));
};
/** mean absolute horizontal + vertical luma gradient (detail) */
const detail = (f: Uint8Array, w: number, h: number) => {
  const L = (i: number) => 0.2126 * f[i * 3]! + 0.7152 * f[i * 3 + 1]! + 0.0722 * f[i * 3 + 2]!;
  let t = 0, n = 0;
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      t += Math.abs(L(i + 1) - L(i)) + Math.abs(L(i + w) - L(i));
      n++;
    }
  return t / Math.max(1, n);
};

export interface AlignResult {
  /** for each output frame, the reference frame it shows */
  map: number[];
  dropped: number[];
  duplicated: number[];
  /** output frames whose best reference is not the same index (shifted) */
  shifted: number[];
}

/**
 * Align output frames to reference frames: each output frame is matched to the best reference frame
 * within ±window of where it should be. Distinct reference pictures are required for a reliable result
 * (static content cannot reveal a drop); `minPsnr` marks frames that match nothing.
 */
export function alignFrames(ref: Uint8Array[], out: Uint8Array[], window = 3): AlignResult {
  const map = out.map((f, i) => {
    let best = i;
    let bestP = -1;
    for (let k = Math.max(0, i - window); k <= Math.min(ref.length - 1, i + window); k++) {
      const p = psnr(f, ref[k]!);
      if (p > bestP + 1e-9 || (Math.abs(p - bestP) <= 1e-9 && Math.abs(k - i) < Math.abs(best - i))) {
        bestP = p;
        best = k;
      }
    }
    return best;
  });
  const seen = new Set(map);
  const dropped = Array.from({ length: ref.length }, (_, k) => k).filter((k) => !seen.has(k) && k <= (map.at(-1) ?? 0));
  const duplicated = map.flatMap((k, i) => (i && k === map[i - 1] ? [i] : []));
  const shifted = map.flatMap((k, i) => (k !== i ? [i] : []));
  return { map, dropped, duplicated, shifted };
}

export interface RenderQcOptions {
  /** frames that start a hard clean reset (e.g. the Bali frame-300 handoff) */
  resetFrames?: number[];
  /** frames after each reset that must be clean (identical to the reference within resetPsnr) */
  resetGuardFrames?: number;
  resetPsnr?: number;
  brightnessSpike?: number;
  clipIncreasePts?: number;
  /** detail(out) / detail(ref) below this = soft / proxy / low-res substitution */
  minDetailRatio?: number;
  file?: string;
}

/** Content QC of an output against its approved reference (same size; decoded RGB24). */
export function qcAgainstReference(ref: Frames, out: Frames, o: RenderQcOptions = {}): { issues: Issue[]; align: AlignResult; measures: Record<string, number> } {
  const issues: Issue[] = [];
  const file = o.file;
  if (out.w !== ref.w || out.h !== ref.h) issues.push({ code: "DELIVERY_RESOLUTION", severity: "BLOCKING", what: "decoded size differs from the reference", file, expected: `${ref.w}x${ref.h}`, actual: `${out.w}x${out.h}`, next: "decode both at the same size for QC; check the render resolution" });
  if (out.frames.length !== ref.frames.length) issues.push({ code: "FRAME_COUNT", severity: "BLOCKING", what: "frame count differs from the approved reference", file, expected: ref.frames.length, actual: out.frames.length, next: "find the dropped / duplicated frames below" });
  const align = alignFrames(ref.frames, out.frames);
  if (align.duplicated.length) issues.push({ code: "FRAME_DUPLICATED", severity: "BLOCKING", what: `${align.duplicated.length} duplicated frame(s)`, file, frame: align.duplicated[0], next: "check the conform / frame map for a repeated source frame" });
  if (align.dropped.length) issues.push({ code: "FRAME_DROPPED", severity: "BLOCKING", what: `${align.dropped.length} dropped frame(s)`, file, frame: align.dropped[0], next: "check the conform / encode for a skipped frame" });
  if (!align.duplicated.length && !align.dropped.length && align.shifted.length) issues.push({ code: "FRAME_TIMING_SHIFT", severity: "BLOCKING", what: `${align.shifted.length} frame(s) show a neighbouring reference frame (a timing shift)`, file, frame: align.shifted[0], expected: align.shifted[0], actual: align.map[align.shifted[0]!], next: "check timestamps (verifyFrameTiming) and the join points" });
  const n = Math.min(ref.frames.length, out.frames.length);
  let spikes = 0, black = 0, firstSpike = -1, firstBlack = -1;
  let clipRef = 0, clipOut = 0, detRef = 0, detOut = 0, detN = 0;
  for (let i = 0; i < n; i++) {
    const r = ref.frames[align.map[i] ?? i] ?? ref.frames[i]!;
    const f = out.frames[i]!;
    const lr = lumaMean(r);
    const lo = lumaMean(f);
    if (lo < 16 && lr >= 24) {
      black++;
      if (firstBlack < 0) firstBlack = i;
    }
    if (Math.abs(lo - lr) > (o.brightnessSpike ?? 12) && !(lo < 16 && lr >= 24)) {
      spikes++;
      if (firstSpike < 0) firstSpike = i;
    }
    clipRef += clipShare(r);
    clipOut += clipShare(f);
    if (i % Math.max(1, Math.floor(n / 12)) === 0) {
      detRef += detail(r, ref.w, ref.h);
      detOut += detail(f, out.w, out.h);
      detN++;
    }
  }
  if (black) issues.push({ code: "BLACK_FRAME", severity: "BLOCKING", what: `${black} black frame(s) where the reference has picture`, file, frame: firstBlack, next: "check for a missing source / failed decode at that frame" });
  if (spikes) issues.push({ code: "BRIGHTNESS_SPIKE", severity: "BLOCKING", what: `${spikes} frame(s) differ in brightness from the reference by more than ${o.brightnessSpike ?? 12} levels`, file, frame: firstSpike, next: "check for an unintended flash / grade / exposure change" });
  const clipInc = n ? ((clipOut - clipRef) / n) * 100 : 0;
  if (clipInc > (o.clipIncreasePts ?? 0.5)) issues.push({ code: "CLIPPING_INCREASE", severity: "BLOCKING", what: `clipping rose by ${Math.round(clipInc * 100) / 100} percentage points`, file, expected: `<= +${o.clipIncreasePts ?? 0.5} pt`, actual: `+${Math.round(clipInc * 100) / 100} pt`, next: "check the grade / effect for pushed highlights" });
  const detRatio = detRef ? detOut / detRef : 1;
  if (detRatio < (o.minDetailRatio ?? 0.7)) issues.push({ code: "PROXY_OR_LOWRES_SUBSTITUTION", severity: "BLOCKING", what: `the picture is much softer than the reference (detail ratio ${Math.round(detRatio * 100) / 100})`, file, expected: `>= ${o.minDetailRatio ?? 0.7}`, actual: Math.round(detRatio * 100) / 100, next: "check that full-resolution media (not a proxy / optimized media) was rendered" });
  for (const r of o.resetFrames ?? []) {
    for (let k = 0; k < (o.resetGuardFrames ?? 3); k++) {
      const i = r + k;
      if (i >= n) break;
      const p = psnr(out.frames[i]!, ref.frames[i]!);
      if (p < (o.resetPsnr ?? 40)) {
        issues.push({ code: "EFFECT_TAIL_ACROSS_RESET", severity: "BLOCKING", what: `frame ${i} after the clean reset at ${r} does not match the clean reference (PSNR ${Math.round(p * 10) / 10} dB): an effect / blend leaks across the cut`, file, frame: i, expected: `>= ${o.resetPsnr ?? 40} dB`, actual: Math.round(p * 10) / 10, next: "end every temporal effect at its own cut; no frame memory across a reset" });
        break;
      }
    }
  }
  return { issues, align, measures: { clipIncreasePts: Math.round(clipInc * 1000) / 1000, detailRatio: Math.round(detRatio * 1000) / 1000, blackFrames: black, brightnessSpikes: spikes } };
}
