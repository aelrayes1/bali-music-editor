/**
 * Bounded 9:16 crop options for a HUMAN_REFRAME_REQUIRED clip (Phase 5.1, pure parts).
 * The subject is identified by a human-verified seed (a point on the intended person at one
 * sample), never by detector confidence; it is then followed by position/size continuity through
 * on-device face detections. Options only move the crop window; everything else stays locked.
 */

import type { Rational } from "../time/rational.ts";
import type { ReframeOverride } from "./reframe-override.ts";

export interface FaceSample {
  j: number;
  sourceTime: Rational;
  faces: Array<{ cx: number; cy: number; w: number; h: number; conf: number }>;
}

export interface TrackPoint {
  j: number;
  sourceTime: Rational;
  cx: number;
  cy: number;
  w: number;
  h: number;
  conf: number;
}

export interface SubjectTrack {
  seed: { j: number; x: number; y: number; note: string };
  points: TrackPoint[];
  gaps: number[];
  rejectedHigherConfidence: Array<{ j: number; cx: number; cy: number; conf: number }>;
}

/**
 * Follow the seeded subject: at the seed sample take the face nearest the seed point (must be
 * within `seedRadius`); afterwards the face nearest the previous position with similar size.
 * Samples with no plausible match are gaps (never switched to another person).
 */
export function trackSubject(samples: FaceSample[], seed: SubjectTrack["seed"], seedRadius = 120, stepRadius = 160, sizeTolerance = 0.45): SubjectTrack {
  const order = [...samples].sort((a, b) => a.j - b.j);
  const s0 = order.findIndex((s) => s.j === seed.j);
  if (s0 < 0) throw new Error(`no face sample at seed frame ${seed.j}`);
  const pick = (s: FaceSample, x: number, y: number, radius: number, h: number | null) =>
    s.faces
      .map((f) => ({ f, d: Math.hypot(f.cx - x, f.cy - y) }))
      .filter(({ f, d }) => d <= radius && (h === null || Math.abs(f.h - h) / h <= sizeTolerance))
      .sort((a, b) => a.d - b.d)[0]?.f;
  const first = pick(order[s0]!, seed.x, seed.y, seedRadius, null);
  if (!first) throw new Error(`no face within ${seedRadius} px of the seed (${seed.x}, ${seed.y}) at frame ${seed.j}`);
  const points: TrackPoint[] = [];
  const gaps: number[] = [];
  const rejected: SubjectTrack["rejectedHigherConfidence"] = [];
  const walk = (range: FaceSample[], start: typeof first) => {
    let prev = start;
    for (const s of range) {
      const f = pick(s, prev.cx, prev.cy, stepRadius, prev.h);
      if (!f) {
        gaps.push(s.j);
        continue;
      }
      points.push({ j: s.j, sourceTime: s.sourceTime, cx: f.cx, cy: f.cy, w: f.w, h: f.h, conf: f.conf });
      for (const o of s.faces) if (o !== f && o.conf > f.conf) rejected.push({ j: s.j, cx: o.cx, cy: o.cy, conf: o.conf });
      prev = f;
    }
  };
  walk(order.slice(s0), first);
  walk(order.slice(0, s0).reverse(), first);
  points.sort((a, b) => a.j - b.j);
  return { seed, points, gaps: gaps.sort((a, b) => a - b), rejectedHigherConfidence: rejected };
}

export interface CropOption {
  option: "CROP_A_CURRENT" | "CROP_B_LEFT_SHIFTED" | "CROP_C_RIGHT_SHIFTED" | "CROP_D_STATIC_MANUAL" | "CROP_E_TRACKED_MANUAL";
  mode: "static" | "tracked";
  centerX: number | null;
  path: Array<{ sourceTime: Rational; centerX: number }> | null;
  derivation: string;
}

/** A: current plan centre; B/C: shifted; D: static minimax over the verified subject; E: follows it. */
export function deriveOptions(currentCenter: number, track: SubjectTrack, shift = { left: 96, right: 160 }): CropOption[] {
  const xs = track.points.map((p) => p.cx);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return [
    { option: "CROP_A_CURRENT", mode: "static", centerX: currentCenter, path: null, derivation: `Phase 5 execution: median of the Phase 3B centre path inside the clip (${currentCenter})` },
    { option: "CROP_B_LEFT_SHIFTED", mode: "static", centerX: currentCenter - shift.left, path: null, derivation: `current - ${shift.left} px` },
    { option: "CROP_C_RIGHT_SHIFTED", mode: "static", centerX: currentCenter + shift.right, path: null, derivation: `current + ${shift.right} px` },
    { option: "CROP_D_STATIC_MANUAL", mode: "static", centerX: Math.round((lo + hi) / 2), path: null, derivation: `static centre that minimises the verified subject's largest distance from centre: midpoint of ${Math.round(lo)}-${Math.round(hi)}` },
    { option: "CROP_E_TRACKED_MANUAL", mode: "tracked", centerX: null, path: track.points.map((p) => ({ sourceTime: p.sourceTime, centerX: Math.round(p.cx) })), derivation: `follows the verified subject's face (${track.points.length} samples, gaps ${track.gaps.join(",") || "none"}), monotone cubic, <= 24 px/frame` },
  ];
}

export function toOverride(o: CropOption | MicroOption, clip: { clipId: string; mediaId: string; shotId: string }, track: SubjectTrack, status: "PROPOSED" | "APPROVED"): ReframeOverride {
  return {
    id: `usr:reframe-${clip.clipId.replace(":", "")}-${o.option.toLowerCase().replace(/_/g, "-")}`,
    kind: "HUMAN_REFRAME_OVERRIDE",
    clipId: clip.clipId,
    mediaId: clip.mediaId,
    shotId: clip.shotId,
    status,
    option: o.option,
    mode: o.mode,
    ...(o.mode === "static" ? { centerX: o.centerX! } : { path: o.path! }),
    subjectTrack: track.points.map((p) => ({ sourceTime: p.sourceTime, centerX: p.cx })),
    basis: o.derivation,
  };
}

export interface OptionMetrics {
  subjectPositionAtCut: number | null;
  subjectPositionMid: number | null;
  subjectPositionEnd: number | null;
  subjectRange: [number, number];
  faceFullyInside: boolean;
  maxStepPx: number;
  travelPx: number;
  watermarksInCrop: string[];
}

/** Where the verified subject sits in each option's crop (0 = left edge, 1 = right edge). */
export function optionMetrics(cropX: number[], cropW: number, track: SubjectTrack, overlays: Array<{ id: string; label: string; x: number; w: number }>): OptionMetrics {
  const pos = track.points.map((p) => ({ j: p.j, v: (p.cx - cropX[p.j]!) / cropW, inside: p.cx - p.w / 2 >= cropX[p.j]! && p.cx + p.w / 2 <= cropX[p.j]! + cropW }));
  const at = (j: number) => {
    const p = pos.reduce((a, b) => (Math.abs(b.j - j) < Math.abs(a.j - j) ? b : a), pos[0]!);
    return Math.round(p.v * 100) / 100;
  };
  const n = cropX.length;
  const steps = cropX.slice(1).map((x, k) => Math.abs(x - cropX[k]!));
  const minX = Math.min(...cropX);
  const maxX = Math.max(...cropX) + cropW;
  return {
    subjectPositionAtCut: pos.length ? at(0) : null,
    subjectPositionMid: pos.length ? at(Math.floor(n / 2)) : null,
    subjectPositionEnd: pos.length ? at(n - 1) : null,
    subjectRange: [Math.round(Math.min(...pos.map((p) => p.v)) * 100) / 100, Math.round(Math.max(...pos.map((p) => p.v)) * 100) / 100],
    faceFullyInside: pos.every((p) => p.inside),
    maxStepPx: Math.max(0, ...steps),
    travelPx: steps.reduce((a, b) => a + b, 0),
    watermarksInCrop: overlays.filter((o) => o.x < maxX && o.x + o.w > minX).map((o) => o.label),
  };
}

export interface MicroOption {
  option: "CROP_CURRENT" | "HUMAN_RIGHT_SHIFT_OVERRIDE" | "HUMAN_RIGHT_SHIFT_TRACKED_OVERRIDE";
  mode: "static" | "tracked";
  centerX: number | null;
  path: Array<{ sourceTime: Rational; centerX: number }> | null;
  derivation: string;
  shiftPx: number;
}

/** Subject centre per output frame: monotone cubic through the track, ends held. */
export function subjectPerFrame(track: SubjectTrack, frameTimes: number[], toSec: (r: Rational) => number, interp: (xs: number[], ys: number[], x: number) => number): number[] {
  const xs = track.points.map((p) => toSec(p.sourceTime));
  const ys = track.points.map((p) => p.cx);
  return frameTimes.map((t) => interp(xs, ys, t));
}

/**
 * Bounded human-directed right shift (Phase 5.1 micro-adjustment). Static crops: the shift that puts
 * the subject's time-averaged position at the crop centre. Tracked crops: newPath = path + s with s
 * the mean offset of the subject from the current crop centre; path points are held at the picture
 * edge so the result stays smooth. Only positive shifts are proposed (the reviewer asked for right).
 */
export function rightShiftOptions(args: {
  current: { mode: "static"; centerX: number } | { mode: "tracked"; path: Array<{ sourceTime: Rational; centerX: number }> };
  currentCentres: number[];
  subject: number[];
  cropW: number;
  maxCentre: number;
}): MicroOption[] {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const even = (x: number) => 2 * Math.round(x / 2);
  const raw = mean(args.subject.map((s, j) => s - args.currentCentres[j]!));
  const shift = Math.max(0, even(raw));
  const cur: MicroOption =
    args.current.mode === "static"
      ? { option: "CROP_CURRENT", mode: "static", centerX: args.current.centerX, path: null, derivation: "Phase 5 execution (unchanged)", shiftPx: 0 }
      : { option: "CROP_CURRENT", mode: "tracked", centerX: null, path: args.current.path, derivation: "Phase 5 execution (unchanged)", shiftPx: 0 };
  if (args.current.mode === "static") {
    return [cur, { option: "HUMAN_RIGHT_SHIFT_OVERRIDE", mode: "static", centerX: Math.min(args.maxCentre, args.current.centerX + shift), path: null, derivation: `static; current centre ${args.current.centerX} + ${shift} px = the subject's time-averaged position (mean offset ${raw.toFixed(1)} px)`, shiftPx: shift }];
  }
  const base = args.current.path;
  const path = base.map((p) => ({ sourceTime: p.sourceTime, centerX: Math.min(args.maxCentre, p.centerX + shift) }));
  const held = path.filter((p, i) => p.centerX !== base[i]!.centerX + shift).length;
  return [cur, { option: "HUMAN_RIGHT_SHIFT_TRACKED_OVERRIDE", mode: "tracked", centerX: null, path, derivation: `tracked; existing path + ${shift} px (mean subject offset ${raw.toFixed(1)} px)${held ? `; ${held} path point(s) held at the picture edge` : ""}; relative motion preserved otherwise`, shiftPx: shift }];
}
