/**
 * Phase 6B subject-mask QC (pure). Measured on the final (temporally smoothed) subject mattes over
 * the frames an effect actually uses. Anything outside the thresholds -> MASK_REVIEW_RECOMMENDED
 * with the reasons; the effect is still renderable for review, but the report says a human must
 * look at the mask visualisation before it is used.
 *
 *   retention      every used frame has a subject of plausible size (no vanished subject)
 *   continuity     motion-compensated IoU between consecutive frames (no flicker, no jumps)
 *   area change    frame-to-frame area change (limbs/hair appearing and disappearing)
 *   edge stability boundary disagreement beyond rigid motion, px at mask resolution
 *   identity       the subject track never switches person; bridged (lost-instance) frames bounded
 *   leakage        share of the subject matte lying on other persistent people
 *   seam           background mismatch across the soft region edge (from the compositor)
 *   graphics       a shifted patch had to be withheld around a frame-locked graphic (burned-in logo)
 */

import { type Mask, area, binarize, centroid, perimeter, shift } from "./mask.ts";
import type { SubjectFrame } from "./select.ts";

export const MASK_QC = {
  minAreaFraction: 0.004,
  minContinuity: 0.8,
  maxAreaChange: 0.2,
  maxEdgeDisplacementPx: 1.5,
  maxConsecutiveBridged: 2,
  maxLeakage: 0.03,
  maxSeamMean: 6,
  maxSeamP95: 30,
};

export interface MaskQc {
  state: "MASK_OK" | "MASK_REVIEW_RECOMMENDED";
  reasons: string[];
  frames: number;
  retention: number;
  continuity: { min: number; mean: number; worstFrame: number | null };
  areaChange: { max: number; worstFrame: number | null };
  edgeDisplacementPx: { mean: number; max: number; worstFrame: number | null };
  identity: { trackId: string; bridgedFrames: number[]; missingFrames: number[]; maxConsecutiveBridged: number; switches: number[] };
  leakage: { max: number; worstFrame: number | null };
  seam: { maxMean: number; maxP95: number; worstFrame: number | null } | null;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Pixels where two binary masks disagree. */
function xorCount(a: Mask, b: Mask): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if ((a.data[i]! >= 128) !== (b.data[i]! >= 128)) n++;
  return n;
}

export function maskQc(args: { trackId: string; frames: SubjectFrame[]; smoothed: Mask[]; used: number[]; seams?: Array<{ f: number; mean: number; p95: number }>; graphicFrames?: number[]; identityBreaks?: number[] }): MaskQc {
  const byJ = new Map(args.frames.map((f, i) => [f.j, i]));
  const used = [...new Set(args.used)].sort((a, b) => a - b).filter((j) => byJ.has(j));
  const B = new Map(used.map((j) => [j, binarize(args.smoothed[byJ.get(j)!]!)]));
  const reasons: string[] = [];
  const total = args.smoothed[0] ? args.smoothed[0].w * args.smoothed[0].h : 1;
  const present = used.filter((j) => area(B.get(j)!) / total >= MASK_QC.minAreaFraction);
  const retention = used.length ? present.length / used.length : 0;
  if (retention < 1) reasons.push(`subject lost on ${used.length - present.length} of ${used.length} frames`);
  let cMin = 1, cSum = 0, cN = 0, cWorst: number | null = null;
  let aMax = 0, aWorst: number | null = null;
  let eSum = 0, eMax = 0, eN = 0, eWorst: number | null = null;
  for (let k = 1; k < used.length; k++) {
    const j = used[k]!, i = used[k - 1]!;
    if (j !== i + 1) continue;
    const a = B.get(j)!, b = B.get(i)!;
    const ca = centroid(a), cb = centroid(b);
    const bs = ca && cb ? shift(b, Math.round(ca.x - cb.x), Math.round(ca.y - cb.y)) : b;
    const aa = area(a), ab = area(b), abs = area(bs);
    const x = xorCount(a, bs);
    const inter = (aa + abs - x) / 2;
    const cont = inter + x > 0 ? inter / (inter + x) : 1;
    cSum += cont;
    cN++;
    if (cont < cMin) {
      cMin = cont;
      cWorst = j;
    }
    const ac = Math.abs(aa - ab) / Math.max(1, aa, ab);
    if (ac > aMax) {
      aMax = ac;
      aWorst = j;
    }
    const per = Math.max(1, (perimeter(a) + perimeter(bs)) / 2);
    const disp = x / per;
    eSum += disp;
    eN++;
    if (disp > eMax) {
      eMax = disp;
      eWorst = j;
    }
  }
  if (cMin < MASK_QC.minContinuity) reasons.push(`continuity ${r3(cMin)} at frame ${cWorst} (< ${MASK_QC.minContinuity}: flicker or jump)`);
  if (aMax > MASK_QC.maxAreaChange) reasons.push(`area change ${Math.round(aMax * 100)} % at frame ${aWorst} (> ${MASK_QC.maxAreaChange * 100} %)`);
  const eMean = eN ? eSum / eN : 0;
  if (eMean > MASK_QC.maxEdgeDisplacementPx) reasons.push(`edge instability ${r3(eMean)} px mean (> ${MASK_QC.maxEdgeDisplacementPx})`);
  const basisOf = (j: number) => args.frames[byJ.get(j)!]!.basis;
  const bridged = used.filter((j) => basisOf(j) === "BRIDGED");
  const missing = used.filter((j) => basisOf(j) === "MISSING");
  let run = 0, maxRun = 0;
  for (const j of used) {
    run = basisOf(j) === "BRIDGED" ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  if (missing.length) reasons.push(`subject identity missing on ${missing.length} frames`);
  if (maxRun > MASK_QC.maxConsecutiveBridged) reasons.push(`${maxRun} consecutive frames without a Vision instance (bridged)`);
  let lMax = 0, lWorst: number | null = null;
  for (const j of used) {
    const a = B.get(j)!;
    const o = args.frames[byJ.get(j)!]!.others;
    let s = 0;
    for (let p = 0; p < a.data.length; p++) if (a.data[p] && o.data[p]) s++;
    const l = s / Math.max(1, area(a));
    if (l > lMax) {
      lMax = l;
      lWorst = j;
    }
  }
  if (lMax > MASK_QC.maxLeakage) reasons.push(`matte leaks onto another person (${Math.round(lMax * 100)} % at frame ${lWorst})`);
  let seam: MaskQc["seam"] = null;
  if (args.seams?.length) {
    const w = args.seams.reduce((b, s) => (s.mean > b.mean ? s : b));
    seam = { maxMean: w.mean, maxP95: Math.max(...args.seams.map((s) => s.p95)), worstFrame: w.f };
    if (seam.maxMean > MASK_QC.maxSeamMean || seam.maxP95 > MASK_QC.maxSeamP95) reasons.push(`background mismatch across the region edge (mean ${seam.maxMean}, p95 ${seam.maxP95} levels at frame ${seam.worstFrame}): moving background or camera; consider BACKGROUND_SMOOTH_CONTINUE or another window`);
  }
  const brk = (args.identityBreaks ?? []).filter((j) => used.length && j > used[0]! && j <= used.at(-1)!);
  if (brk.length) reasons.push(`subject identity switch suspected at frames ${brk.join(",")} (occluder took over, or the subject is hidden)`);
  if (args.graphicFrames?.length) reasons.push(`shifted patch meets a frame-locked graphic on frames ${args.graphicFrames.join(",")}: the graphic is kept in place, but fragments of the current pose can show inside it (clean the graphic before FX)`);
  return {
    state: reasons.length ? "MASK_REVIEW_RECOMMENDED" : "MASK_OK",
    reasons,
    frames: used.length,
    retention: r3(retention),
    continuity: { min: r3(cMin), mean: r3(cN ? cSum / cN : 1), worstFrame: cWorst },
    areaChange: { max: r3(aMax), worstFrame: aWorst },
    edgeDisplacementPx: { mean: r3(eMean), max: r3(eMax), worstFrame: eWorst },
    identity: { trackId: args.trackId, bridgedFrames: bridged, missingFrames: missing, maxConsecutiveBridged: maxRun, switches: brk },
    leakage: { max: r3(lMax), worstFrame: lWorst },
    seam,
  };
}
