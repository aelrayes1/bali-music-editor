/**
 * Per-media semantic interpretation (pure, deterministic): Phase 3 objective facts + cached Apple
 * Vision observations on sampled frames -> SemanticMedia. Rules are explicit and documented in
 * docs/semantic-shot-understanding.md; every value carries confidence and evidence.
 */

import type { FootageAnalysis, Shot } from "../footage/schema.ts";
import { type Rational, mul, rational, sub, toNumberApprox } from "../time/rational.ts";
import type { SamplePlan } from "./sampling.ts";
import type { Framing, SemanticMedia, SemanticShot } from "./schema.ts";
import { type VisionResult, featureVector } from "./vision.ts";

const r3 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Box = { x: number; y: number; w: number; h: number; conf: number };
const area = (b: Box) => b.w * b.h;
const iou = (a: Box, b: Box) => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / Math.max(1e-9, area(a) + area(b) - i);
};

export interface SampleObs {
  plan: SamplePlan;
  time: Rational;
  persons: Box[];
  primary: Box | null;
  face: (Box & { yaw: number | null }) | null;
  framing: Framing;
  orientation: "front" | "three_quarter" | "profile" | "back" | "unknown";
  labels: Map<string, number>;
  saliency: Box[];
  text: Box[];
  bodyJoints: Record<string, number[]> | null;
  embedding: Float32Array | null;
}

/** Framing from the primary face height (fraction of picture height), else from the person box. */
export function framingOf(faceH: number | null, personBox: Box | null): { framing: Framing; basis: string } {
  if (faceH !== null) {
    const f: Framing = faceH >= 0.45 ? "extreme_close_up" : faceH >= 0.25 ? "close_up" : faceH >= 0.14 ? "medium_close_up" : faceH >= 0.08 ? "medium" : faceH >= 0.045 ? "medium_wide" : faceH >= 0.022 ? "wide" : "extreme_wide";
    return { framing: f, basis: "face" };
  }
  if (personBox) {
    const cutTop = personBox.y <= 0.02;
    const h = personBox.h;
    const f: Framing = h >= 0.9 && cutTop ? "medium" : h >= 0.6 ? "medium_wide" : h >= 0.3 ? "wide" : "extreme_wide";
    return { framing: f, basis: "person" };
  }
  return { framing: "unknown", basis: "none" };
}

export function orientationOf(face: { yaw: number | null } | null, joints: Record<string, number[]> | null): SampleObs["orientation"] {
  if (face && face.yaw !== null) {
    const y = Math.abs(face.yaw);
    return y <= 20 ? "front" : y <= 55 ? "three_quarter" : "profile";
  }
  if (joints && (joints.left_shoulder_1_joint || joints.right_shoulder_1_joint) && !joints.head_joint && !joints.left_eye_joint && !joints.right_eye_joint) return "back";
  return "unknown";
}

/**
 * Keep one subject identity across a shot's samples: starting from the representative sample's
 * primary subject, pick in each other sample the person that best overlaps it or sits closest with a
 * similar size. If none qualifies, that sample has no tracked subject (direction becomes unknown
 * rather than being faked by switching to another person).
 */
export function trackSubject(obs: SampleObs[], repIndex: number): Array<Box | null> {
  const anchor = obs[repIndex]?.primary ?? null;
  if (!anchor) return obs.map((o) => o.primary);
  const cx = (b: Box) => b.x + b.w / 2;
  const cy = (b: Box) => b.y + b.h / 2;
  const out: Array<Box | null> = obs.map(() => null);
  out[repIndex] = anchor;
  const walk = (from: number, step: number) => {
    let ref = anchor;
    for (let i = from; i >= 0 && i < obs.length; i += step) {
      const cands = obs[i]!.persons
        .map((p) => ({ p, iou: iou(p, ref), d: Math.hypot(cx(p) - cx(ref), cy(p) - cy(ref)), ratio: area(p) / Math.max(1e-6, area(ref)) }))
        .filter((c) => c.iou >= 0.2 || (c.d <= 0.25 && c.ratio >= 0.4 && c.ratio <= 2.5))
        .sort((a, b) => b.iou - a.iou || a.d - b.d);
      if (!cands.length) break;
      out[i] = cands[0]!.p;
      ref = cands[0]!.p;
    }
  };
  walk(repIndex + 1, 1);
  walk(repIndex - 1, -1);
  return out;
}

/** Body-pose joints belonging to a given subject box (neck/nose/shoulder inside the box). */
export function jointsFor(v: VisionResult, b: Box | null): Record<string, number[]> | null {
  if (!b) return null;
  const inside = (p?: number[]) => !!p && p[0]! >= b.x - 0.02 && p[0]! <= b.x + b.w + 0.02 && p[1]! >= b.y - 0.02 && p[1]! <= b.y + b.h + 0.02;
  const body = v.bodies.filter((x) => x.conf >= 0.3 && (inside(x.joints.neck_1_joint) || inside(x.joints.head_joint) || inside(x.joints.left_shoulder_1_joint) || inside(x.joints.right_shoulder_1_joint)));
  return body.length ? body.reduce((a, c) => (Object.keys(c.joints).length > Object.keys(a.joints).length ? c : a)).joints : null;
}

export function interpretSample(plan: SamplePlan, time: Rational, v: VisionResult): SampleObs {
  const humans = v.humans.filter((h) => h.conf >= 0.5);
  // faces not inside any human box count as additional persons
  const extraFaces = v.faces.filter((f) => f.conf >= 0.5 && !humans.some((h) => f.x >= h.x - 0.02 && f.x + f.w <= h.x + h.w + 0.02 && f.y >= h.y - 0.02 && f.y + f.h <= h.y + h.h + 0.02));
  const persons: Box[] = [...humans, ...extraFaces.map((f) => ({ x: Math.max(0, f.x - f.w * 0.6), y: f.y, w: Math.min(1, f.w * 2.2), h: Math.min(1 - f.y, f.h * 4), conf: f.conf }))];
  const primary = persons.length ? persons.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
  const faces = v.faces.filter((f) => f.conf >= 0.5);
  const face = faces.length ? faces.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
  const bodies = v.bodies.filter((b) => b.conf >= 0.3);
  const joints = bodies.length ? bodies.reduce((a, b) => (Object.keys(b.joints).length > Object.keys(a.joints).length ? b : a)).joints : null;
  const { framing } = framingOf(face ? face.h : null, primary);
  return {
    plan,
    time,
    persons,
    primary,
    face,
    framing,
    orientation: orientationOf(face, joints),
    labels: new Map(v.labels.map((l) => [l.id, l.conf])),
    saliency: v.saliency,
    text: v.text,
    bodyJoints: joints,
    embedding: featureVector(v.featurePrint),
  };
}

const LABEL_GROUPS = {
  vehicle: ["car", "automobile", "vehicle", "limousine", "wheel", "tire", "rim", "motorcycle", "truck", "bus"],
  street: ["road", "street", "parking_lot", "sidewalk", "alley", "crosswalk", "highway"],
  performance: ["performance", "concert", "microphone", "nightclub", "musical_instrument", "music"],
  crowd: ["crowd"],
  outdoorEnv: ["outdoor", "sky", "blue_sky", "night_sky", "land", "grass", "tree", "building", "structure", "landscape", "cityscape"],
  screen: ["screenshot", "document", "television", "art"],
} as const;

const groupScore = (o: SampleObs, g: readonly string[]) => Math.max(0, ...g.map((id) => o.labels.get(id) ?? 0));

export interface SemanticMeta {
  generatedAt: string;
  collection: string;
  provenance: SemanticMedia["provenance"];
  nearDuplicates: Map<string, string[]>;
}

function mode<T extends string>(xs: T[]): { value: T; share: number } | null {
  if (!xs.length) return null;
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  const [value, n] = [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
  return { value, share: n / xs.length };
}

function meanEmbedding(obs: SampleObs[]): Float32Array | null {
  const vs = obs.map((o) => o.embedding).filter((v): v is Float32Array => v !== null);
  if (!vs.length) return null;
  const m = new Float32Array(vs[0]!.length);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i]! += v[i]!;
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i]! ** 2;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < m.length; i++) m[i] = Math.round((m[i]! / n) * 1e6) / 1e6;
  return m;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export function b64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

const FRAMING_WEIGHT: Record<Framing, number> = { extreme_close_up: 0.7, close_up: 1, medium_close_up: 1, medium: 0.95, medium_wide: 0.8, wide: 0.55, extreme_wide: 0.3, unknown: 0.15 };

export function technicalQuality(shot: Shot, fa: FootageAnalysis, sharpRank: number): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const e = shot.exposure.p50;
  const exposure = e < 20 ? 0.3 : e < 35 ? 0.7 : e > 235 ? 0.4 : 1;
  const clip = 1 - clamp01(shot.clipping.highlightFraction.p50 * 3) * 0.5 - clamp01(shot.clipping.shadowFraction.p50 * 1.5) * 0.4;
  const stability = shot.stability.class === "shaky" ? 0.75 : 1;
  const activeH = shot.activePicture.activeRect.h * (fa.geometry.stored.h / Math.max(fa.geometry.display.h, 1)) || shot.activePicture.activeRect.h;
  const res = activeH >= 900 ? 1 : activeH >= 700 ? 0.9 : activeH >= 450 ? 0.7 : activeH >= 260 ? 0.5 : 0.35;
  const usable = shot.usable.fraction;
  const score = clamp01((0.35 * sharpRank + 0.2 * exposure + 0.15 * clip + 0.15 * res + 0.15 * usable) * stability);
  if (sharpRank < 0.25) reasons.push(`soft for this source (sharpness rank ${r3(sharpRank)})`);
  if (exposure < 1) reasons.push(`exposure median ${e}`);
  if (clip < 0.85) reasons.push("clipped highlights/shadows");
  if (res < 0.8) reasons.push(`low native resolution (${Math.round(activeH)} px active height)`);
  if (stability < 1) reasons.push("shaky");
  if (usable < 0.8) reasons.push(`only ${Math.round(usable * 100)} % usable frames`);
  if (!reasons.length) reasons.push("sharp, well exposed, stable");
  return { score: r3(score), reasons };
}

export function cropAnalysis(shot: Shot, fa: FootageAnalysis, obs: SampleObs[]): SemanticShot["features"]["cropPotential9x16"] {
  const ar = shot.activePicture.activeRect;
  const nativeVertical = ar.h > 0 && ar.w / ar.h <= 9 / 16 + 0.02;
  const cropWidth = Math.round((ar.h * 9) / 16);
  const nativeScale = fa.geometry.stored.w / Math.max(1, fa.geometry.rotationClockwise % 180 === 0 ? fa.geometry.display.w : fa.geometry.display.h);
  const nativeCropW = cropWidth * (fa.geometry.rotationClockwise % 180 === 0 ? nativeScale : fa.geometry.stored.h / Math.max(1, fa.geometry.display.w));
  const upscaleFactor = Math.round((1080 / Math.max(1, nativeVertical ? ar.w * nativeScale : nativeCropW)) * 100) / 100;
  const risks: SemanticShot["features"]["cropPotential9x16"]["risks"] = [];
  if (nativeVertical) {
    return { score: r3(upscaleFactor <= 1.6 ? 0.95 : 0.75), reasons: ["already vertical: no crop needed"], nativeVertical, cropWidth: ar.w, centerPath: [], difficulty: "none", risks: upscaleFactor > 2 ? ["insufficient_resolution"] : [], upscaleFactor };
  }
  const c = cropWidth / Math.max(1, ar.w); // crop width as a fraction of the picture width
  const subj = obs.filter((o) => o.primary);
  // core subject: the face with margin (face width x 1.6), else 60 % of the person box
  const core = (o: SampleObs) => {
    if (o.face) return { cx: o.face.x + o.face.w / 2, w: Math.min(1, o.face.w * 1.6) };
    const b = o.primary!;
    return { cx: b.x + b.w / 2, w: b.w * 0.6 };
  };
  const centerX = (o: SampleObs) => {
    const cx = o.primary ? core(o).cx : o.saliency[0] ? o.saliency[0].x + o.saliency[0].w / 2 : 0.5;
    const lo = c / 2;
    return Math.min(1 - lo, Math.max(lo, cx));
  };
  const centerPath = obs.map((o) => ({ time: o.time, centerX: Math.round(ar.x + centerX(o) * ar.w) }));
  const spanL = subj.length ? Math.min(...subj.map((o) => core(o).cx - core(o).w / 2)) : 0.5;
  const spanR = subj.length ? Math.max(...subj.map((o) => core(o).cx + core(o).w / 2)) : 0.5;
  const widest = subj.length ? Math.max(...subj.map((o) => core(o).w)) : 0;
  const groupSpread = Math.max(0, ...obs.map((o) => (o.persons.length >= 2 ? Math.max(...o.persons.map((p) => p.x + p.w)) - Math.min(...o.persons.map((p) => p.x)) : 0)));
  let difficulty: "easy" | "moderate" | "hard" = spanR - spanL <= c ? "easy" : spanR - spanL <= 1.6 * c ? "moderate" : "hard";
  if (widest > c) {
    risks.push("subject_clipping");
    difficulty = "hard";
  } else if (groupSpread > c * 1.1) risks.push("context_outside_crop"); // other people are cut, not the subject
  if (!subj.length) risks.push("no_subject");
  const disp = (b: { x: number; y: number; w: number; h: number }) => ({ x: (b.x - ar.x) / Math.max(1, ar.w), w: b.w / Math.max(1, ar.w) });
  const overlays = fa.overlays.filter((o) => o.kind === "graphic" && shot.overlayIds.includes(o.id)).map((o) => disp(o.bbox));
  if (overlays.some((o) => obs.some((s) => o.x < centerX(s) + c / 2 && o.x + o.w > centerX(s) - c / 2))) risks.push("watermark_intrusion");
  const salOut = mean(obs.map((o) => {
    const sb = o.saliency[0];
    if (!sb) return 0;
    const cx = centerX(o);
    const inside = Math.max(0, Math.min(sb.x + sb.w, cx + c / 2) - Math.max(sb.x, cx - c / 2));
    return 1 - inside / Math.max(1e-6, sb.w);
  }));
  if (salOut > 0.4) risks.push("context_outside_crop");
  if (upscaleFactor > 2.2) risks.push("insufficient_resolution");
  const base = difficulty === "easy" ? 0.9 : difficulty === "moderate" ? 0.65 : 0.3;
  const resF = upscaleFactor <= 1.2 ? 1 : upscaleFactor <= 2 ? 0.85 : upscaleFactor <= 3 ? 0.6 : 0.4;
  const score = base * resF * (risks.includes("watermark_intrusion") ? 0.7 : 1) * (subj.length ? 1 : 0.6) * (risks.includes("context_outside_crop") ? 0.85 : 1);
  const reasons = [
    `9:16 crop is ${Math.round(c * 100)} % of the picture width`,
    `core subject (head-and-shoulders) span ${Math.round((spanR - spanL) * 100)} % over the shot: ${difficulty}`,
    `upscale ${upscaleFactor}x to 1080 px width`,
    ...risks.map((r) => `risk: ${r}`),
  ];
  return { score: r3(score), reasons, nativeVertical, cropWidth, centerPath, difficulty, risks: [...new Set(risks)], upscaleFactor };
}

export function buildSemanticMedia(fa: FootageAnalysis, plan: SamplePlan[], vision: Map<string, VisionResult>, frameTimes: Map<number, Rational>, meta: SemanticMeta): SemanticMedia {
  const warnings: SemanticMedia["warnings"] = [];
  const sharpSorted = fa.shots.map((s) => s.sharpness.p50).sort((a, b) => a - b);
  const sharpRank = (v: number) => (sharpSorted.length > 1 ? sharpSorted.filter((x) => x < v).length / (sharpSorted.length - 1) : 0.5);
  const shotsPerSecond = fa.shots.length / Math.max(1, toNumberApprox(sub(fa.timing.end, fa.timing.firstFrame)));
  const musicVideo = shotsPerSecond >= 0.2 && fa.shots.length >= 20;
  const lowRes = Math.min(fa.geometry.stored.w, fa.geometry.stored.h) <= 480;
  const fourThree = fa.activePicture.activeAspect !== null && Math.abs(fa.activePicture.activeAspect - 4 / 3) < 0.05 && fa.geometry.display.w / fa.geometry.display.h > 1.6;
  const archivalEvidence = [meta.collection === "archive-collection" ? "source collection 'archive-collection'" : "", lowRes ? "SD resolution" : "", fourThree ? "4:3 picture inside a 16:9 frame" : ""].filter(Boolean);
  const archival = archivalEvidence.length > 0;

  const shots: SemanticShot[] = fa.shots.map((shot) => {
    const sp = plan.filter((p) => p.shotId === shot.shotId);
    const raw = sp.map((p) => {
      const v = vision.get(`${p.shotId}@${p.frameIndex}`);
      if (!v) throw new Error(`${fa.source.mediaId} ${p.shotId}: missing vision result for frame ${p.frameIndex}`);
      return { v, o: interpretSample(p, frameTimes.get(p.frameIndex)!, v) };
    });
    const repIndex = Math.max(0, raw.findIndex((r) => r.o.plan.representative));
    const tracked = trackSubject(raw.map((r) => r.o), repIndex);
    // the tracked subject replaces per-sample "largest person" so identity does not switch
    const obs: SampleObs[] = raw.map((r, i) => {
      const t = tracked[i]!;
      const face = t ? (r.v.faces.filter((f) => f.conf >= 0.5 && f.x + f.w / 2 >= t.x && f.x + f.w / 2 <= t.x + t.w && f.y + f.h / 2 >= t.y && f.y + f.h / 2 <= t.y + t.h).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null) : null;
      const joints = jointsFor(r.v, t);
      return { ...r.o, primary: t, face, framing: t ? framingOf(face ? face.h : null, t).framing : r.o.persons.length ? r.o.framing : "unknown", orientation: t ? orientationOf(face, joints) : "unknown", bodyJoints: joints };
    });
    const trackedShare = obs.filter((o) => o.primary).length / obs.length;
    const shotWarnings: SemanticShot["warnings"] = [];
    const rep = obs[repIndex]!;
    const counts = obs.map((o) => o.persons.length);
    const medCount = [...counts].sort((a, b) => a - b)[counts.length >> 1]!;
    const crowdLabel = mean(obs.map((o) => groupScore(o, LABEL_GROUPS.crowd)));
    const presenceValue = medCount === 0 && crowdLabel < 0.5 ? "none" : crowdLabel >= 0.5 || medCount >= 6 ? "crowd" : medCount === 1 ? "single" : medCount === 2 ? "pair" : medCount <= 3 ? "small_group" : "group";
    const personShare = obs.filter((o) => o.persons.length > 0).length / obs.length;
    const presenceConf = presenceValue === "none" ? 1 - personShare : presenceValue === "crowd" ? Math.max(crowdLabel, medCount >= 6 ? 0.7 : 0) : mean(obs.filter((o) => o.primary).map((o) => o.primary!.conf)) * personShare;

    // framing / orientation
    const fr = obs.map((o) => o.framing);
    const frMode = mode(fr.filter((f) => f !== "unknown"));
    const framing = frMode && frMode.share >= 0.5
      ? { value: frMode.value, confidence: r3(frMode.share * (rep.face ? 0.9 : 0.7)), evidence: `${Math.round(frMode.share * 100)} % of ${fr.length} samples (${rep.face ? "face size" : "person box"})`, perSample: fr }
      : { value: "unknown" as const, confidence: 0.5, evidence: frMode ? "framing varies across samples" : "no subject detected", perSample: fr };
    const orMode = mode(obs.map((o) => o.orientation).filter((x) => x !== "unknown"));
    const subjectOrientation = !orMode
      ? { value: "unknown" as const, confidence: 0.5, evidence: "no face or body orientation evidence" }
      : orMode.share >= 0.6
        ? { value: orMode.value, confidence: r3(orMode.share * (orMode.value === "back" ? 0.55 : 0.85)), evidence: `${orMode.value} in ${Math.round(orMode.share * 100)} % of oriented samples (face yaw / body pose)` }
        : { value: "mixed" as const, confidence: 0.5, evidence: "orientation changes across samples" };

    // subject motion (screen space)
    const withSubj = obs.filter((o) => o.primary);
    const subjectLabels: SemanticShot["subjectMotion"]["labels"] = [];
    let screenDirection: SemanticShot["subjectMotion"]["screenDirection"] = { value: "unknown", confidence: 0.5, evidence: "fewer than 2 samples with a subject" };
    if (withSubj.length >= 2) {
      const a = withSubj[0]!.primary!;
      const b = withSubj.at(-1)!.primary!;
      const fa0 = withSubj[0]!.face;
      const fb0 = withSubj.at(-1)!.face;
      // face centre/size when available (arms change the body box); else the body box
      const dx = fa0 && fb0 ? fb0.x + fb0.w / 2 - (fa0.x + fa0.w / 2) : b.x + b.w / 2 - (a.x + a.w / 2);
      const faceScale = fa0 && fb0 ? area(fb0) / Math.max(1e-6, area(fa0)) : null;
      const scale = faceScale ?? area(b) / Math.max(1e-6, area(a));
      const grow = faceScale !== null ? 1.5 : 2;
      if (dx > 0.12) screenDirection = { value: "left_to_right", confidence: r3(Math.min(0.9, 0.5 + dx)), evidence: `subject centre moves +${Math.round(dx * 100)} % of the width` };
      else if (dx < -0.12) screenDirection = { value: "right_to_left", confidence: r3(Math.min(0.9, 0.5 - dx)), evidence: `subject centre moves ${Math.round(dx * 100)} % of the width` };
      else if (scale > grow) screenDirection = { value: "toward_camera", confidence: 0.5, evidence: `subject ${faceScale !== null ? "face" : "box"} grows to ${Math.round(scale * 100)} % (or push-in)` };
      else if (scale < 1 / grow) screenDirection = { value: "away_from_camera", confidence: 0.5, evidence: `subject ${faceScale !== null ? "face" : "box"} shrinks to ${Math.round(scale * 100)} % (or pull-out)` };
      else screenDirection = { value: "none", confidence: 0.6, evidence: "subject stays in place on screen" };
      const jointSpread = (key: string) => {
        const pts = withSubj.map((o) => o.bodyJoints?.[key]).filter((p): p is number[] => !!p);
        if (pts.length < 2) return 0;
        const xs = pts.map((p) => p[0]!);
        const ys = pts.map((p) => p[1]!);
        return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
      };
      const armMove = Math.max(jointSpread("left_hand_joint"), jointSpread("right_hand_joint"), jointSpread("left_forearm_joint"), jointSpread("right_forearm_joint"));
      const legMove = Math.max(jointSpread("left_foot_joint"), jointSpread("right_foot_joint"));
      const local = shot.motion.localChange.p50;
      const bigEnough = Math.max(...withSubj.map((o) => area(o.primary!))) >= 0.02; // tiny subjects: no body-motion labels
      if (bigEnough) {
        if (Math.abs(dx) <= 0.05 && armMove < 0.08 && local < 6) subjectLabels.push({ label: "static", confidence: 0.6, evidence: "subject and limbs stay in place" });
        if (armMove >= 0.12) {
          const dancing = legMove >= 0.12;
          subjectLabels.push({ label: dancing ? "dancing" : "gesturing", confidence: r3(Math.min(dancing ? 0.5 : 0.75, 0.35 + armMove)), evidence: `hands/forearms of the tracked subject move ${Math.round(armMove * 100)} % of the frame across samples${dancing ? "; feet move too (limb movement, not a verified dance)" : ""}` });
        }
        if (Math.abs(dx) > 0.15 && legMove >= 0.1 && scale > 0.7 && scale < 1.4) subjectLabels.push({ label: "walking", confidence: 0.4, evidence: "subject translates with leg movement" });
      }
      if (!obs[0]!.primary && obs.at(-1)!.primary) subjectLabels.push({ label: "entering_frame", confidence: 0.5, evidence: "no subject in the first sample, subject later" });
      if (obs[0]!.primary && !obs.at(-1)!.primary) subjectLabels.push({ label: "exiting_frame", confidence: 0.5, evidence: "subject in the first sample, gone by the last" });
    }
    if (!subjectLabels.length) subjectLabels.push({ label: "unknown", confidence: 0.5, evidence: withSubj.length ? "no clear subject movement pattern" : "no subject" });

    // camera motion (from Phase 3 measurements)
    const m = shot.motion;
    const sp50 = m.globalSpeed.p50;
    const sp90 = m.globalSpeed.p90;
    const camDir = { x: r3n(-m.meanDirection.x), y: r3n(-m.meanDirection.y) };
    const camera: SemanticShot["cameraMotion"]["labels"] = [];
    if (fa.static.staticImageVideo) camera.push({ label: "locked_static", confidence: 0.95, evidence: "static-image video" });
    else {
      if (sp50 < 0.02 && shot.stability.class !== "shaky") camera.push({ label: "locked_static", confidence: r3(0.6 + (0.02 - sp50) * 10), evidence: `global speed p50 ${sp50} frame widths/s` });
      if (sp50 >= 0.04 && m.directionalConsistency >= 0.6) {
        const horiz = Math.abs(m.meanDirection.x) >= Math.abs(m.meanDirection.y);
        const label = horiz ? (camDir.x > 0 ? "pan_right" : "pan_left") : camDir.y > 0 ? "tilt_down" : "tilt_up";
        camera.push({ label, confidence: r3(Math.min(0.9, 0.4 + m.directionalConsistency * 0.5)), evidence: `consistent content motion (${m.directionalConsistency}) at ${sp50} widths/s` });
        if (sp50 < 0.12 && shot.stability.class === "stable") camera.push({ label: "slow_smooth", confidence: 0.6, evidence: "slow, consistent, stable motion" });
      }
      if (shot.stability.class === "shaky" || shot.stability.class === "moderate") camera.push({ label: "handheld", confidence: shot.stability.class === "shaky" ? 0.75 : 0.5, evidence: `jitter ${shot.stability.jitterRms} % width/frame` });
      if (sp90 >= 0.45 || (shot.stability.class === "shaky" && m.localChange.p50 >= 12)) camera.push({ label: "chaotic_high_energy", confidence: 0.6, evidence: `speed p90 ${sp90}, local change ${m.localChange.p50}` });
      if (withSubj.length >= 2 && screenDirection.value === "toward_camera" && sp50 < 0.04) camera.push({ label: "push_in", confidence: 0.35, evidence: "subject grows with little translation (push-in or subject approach)" });
      if (withSubj.length >= 2 && screenDirection.value === "away_from_camera" && sp50 < 0.04) camera.push({ label: "pull_out", confidence: 0.35, evidence: "subject shrinks with little translation (pull-out or subject retreat)" });
    }
    if (!camera.length) camera.push({ label: "unknown", confidence: 0.5, evidence: "no clear camera-motion pattern" });

    // burned-in text (titles, lower thirds, credits): Vision text boxes outside known watermark boxes
    const ar0 = shot.activePicture.activeRect;
    const ovBoxes = fa.overlays.filter((o) => shot.overlayIds.includes(o.id)).map((o) => ({ x: (o.bbox.x - ar0.x) / Math.max(1, ar0.w), y: (o.bbox.y - ar0.y) / Math.max(1, ar0.h), w: o.bbox.w / Math.max(1, ar0.w), h: o.bbox.h / Math.max(1, ar0.h), conf: 1 }));
    const textCov = obs.map((o) => o.text.filter((t) => !ovBoxes.some((b) => iou(t, b) > 0.1 || (t.x >= b.x && t.x + t.w <= b.x + b.w && t.y >= b.y && t.y + t.h <= b.y + b.h))).reduce((acc, t) => acc + area(t), 0));
    const textCoverage = [...textCov].sort((a, b) => a - b)[textCov.length >> 1]!;
    const titleCard = textCoverage >= 0.015 && personShare < 0.34 && presenceValue !== "crowd";
    if (textCoverage >= 0.015 && !titleCard) shotWarnings.push({ code: "BURNED_IN_TEXT", message: `burned-in text covers ${Math.round(textCoverage * 1000) / 10} % of the picture (lower third / credits)` });

    // content & context tags
    const g = (k: keyof typeof LABEL_GROUPS) => r3(mean(obs.map((o) => groupScore(o, LABEL_GROUPS[k]))));
    const content: SemanticShot["content"] = [];
    const context: SemanticShot["context"] = [];
    if (personShare > 0) content.push({ label: "person", confidence: r3(personShare * Math.max(0.5, mean(withSubj.map((o) => o.primary!.conf)))), evidence: `person in ${Math.round(personShare * 100)} % of samples` });
    if (presenceValue === "crowd") content.push({ label: "crowd", confidence: r3(presenceConf), evidence: `crowd label ${r3(crowdLabel)}, median ${medCount} persons` });
    const env = g("outdoorEnv");
    if (titleCard) content.push({ label: "text_dominant", confidence: r3(Math.min(0.9, 0.35 + textCoverage * 5)), evidence: `text covers ${Math.round(textCoverage * 1000) / 10} % of the picture, no person (title card, graphic or signage)` });
    if (personShare < 0.34 && presenceValue !== "crowd" && !titleCard) content.push({ label: "no_person_environmental", confidence: r3((1 - personShare) * Math.max(0.5, env)), evidence: `no person in ${Math.round((1 - personShare) * 100)} % of samples` });
    if (g("vehicle") >= 0.3) content.push({ label: "vehicle", confidence: g("vehicle"), evidence: "vehicle labels (car/automobile/wheel…)" });
    if (g("street") >= 0.25) content.push({ label: "street_lifestyle", confidence: g("street"), evidence: "street labels (road/street/parking lot…)" });
    const perf = g("performance");
    const faceFront = obs.filter((o) => o.orientation === "front").length / obs.length;
    const mic = mean(obs.map((o) => o.labels.get("microphone") ?? 0));
    const talking = (presenceValue === "single" || presenceValue === "pair") && ["close_up", "medium_close_up", "medium", "unknown"].includes(framing.value) && personShare >= 0.6 && sp50 < 0.03 && toNumberApprox(shot.duration) >= 3 && !musicVideo;
    if (talking) content.push({ label: "interview_talking_head", confidence: r3(0.4 + 0.25 * faceFront + (toNumberApprox(shot.duration) > 8 ? 0.1 : 0) + (mic >= 0.2 ? 0.15 : 0)), evidence: `${presenceValue} person(s), close/medium framing, locked camera, long take, non-music-video source${mic >= 0.2 ? ", microphone" : ""}` });
    const gesturing = subjectLabels.some((l) => l.label === "gesturing" || l.label === "dancing");
    if (perf >= 0.3 || (musicVideo && personShare > 0.5 && (gesturing || faceFront > 0.5))) {
      content.push({ label: "performer", confidence: r3(Math.max(perf, musicVideo ? 0.35 + 0.2 * faceFront + (gesturing ? 0.1 : 0) : 0)), evidence: perf >= 0.3 ? `performance labels ${perf}` : "person facing camera / gesturing in a music-video source (inferred)" });
    }
    if (musicVideo) content.push({ label: "music_video_imagery", confidence: 0.7, evidence: `source cut rate ${Math.round(shotsPerSecond * 100) / 100} shots/s` });
    if (perf >= 0.2 || (presenceValue === "crowd" && perf >= 0.1)) content.push({ label: "stage_club_performance", confidence: r3(Math.max(perf, 0.3)), evidence: `performance/concert/nightclub labels ${perf}` });
    if (g("screen") >= 0.4) shotWarnings.push({ code: "GRAPHIC_OR_SCREEN", message: `screen/document/art labels ${g("screen")}: may be a title card or graphic` });
    if (content.length === 0) content.push({ label: "unknown", confidence: 0.5, evidence: "no confident content evidence" });

    if (perf >= 0.2) context.push({ label: "stage_performance", confidence: r3(Math.max(0.3, perf)), evidence: "performance/concert/nightclub labels" });
    if (presenceValue === "crowd") context.push({ label: "crowd", confidence: r3(presenceConf), evidence: "crowd present" });
    if (talking) context.push({ label: "interview", confidence: content.find((c) => c.label === "interview_talking_head")!.confidence, evidence: "talking-head evidence" });
    if (musicVideo) context.push({ label: "music_video", confidence: 0.7, evidence: "music-video cut structure" });
    if (titleCard) context.push({ label: "graphic_or_signage", confidence: r3(Math.min(0.9, 0.35 + textCoverage * 5)), evidence: "text-dominated picture (title card, station graphic or signage)" });
    if (personShare < 0.34 && presenceValue !== "crowd" && !titleCard && env >= 0.3) context.push({ label: "environmental", confidence: r3(env), evidence: "outdoor/scenery labels without people" });
    if (personShare > 0.5 && !talking && perf < 0.2 && !musicVideo && camera.some((c) => c.label === "handheld")) context.push({ label: "candid", confidence: 0.35, evidence: "handheld, people, no performance or interview evidence" });
    if (archival) context.push({ label: "archival", confidence: r3(0.5 + 0.15 * archivalEvidence.length), evidence: archivalEvidence.join("; ") });
    if (context.length === 0) context.push({ label: "unknown", confidence: 0.5, evidence: "no confident context evidence" });

    // features
    const tq = technicalQuality(shot, fa, sharpRank(shot.sharpness.p50));
    const repSubjArea = rep.primary ? area(rep.primary) : 0;
    const salOnSubject = rep.primary && rep.saliency[0] ? iou(rep.primary, rep.saliency[0]) : 0;
    const faceTerm = rep.face ? (rep.orientation === "front" ? 1 : rep.orientation === "three_quarter" ? 0.85 : 0.6) * Math.min(1, rep.face.h / 0.1) : 0.25;
    const clarity = rep.primary ? clamp01(0.3 * Math.min(1, repSubjArea / 0.25) + 0.3 * faceTerm + 0.15 * salOnSubject + 0.15 * (rep.persons.length <= 1 ? 1 : rep.persons.length <= 2 ? 0.7 : 0.4) + 0.1 * trackedShare) : 0.05;
    const subjectClarity = { score: r3(clarity), reasons: rep.primary ? [`subject area ${Math.round(repSubjArea * 100)} %`, rep.face ? "face visible" : "no face", `saliency on subject ${r3(salOnSubject)}`, `${rep.persons.length} person(s)`] : ["no subject in the representative frame"] };
    const orientW = { front: 1, three_quarter: 0.9, profile: 0.7, back: 0.45, mixed: 0.75, unknown: 0.5 }[subjectOrientation.value];
    const interest = clamp01(0.45 * clarity + 0.25 * FRAMING_WEIGHT[framing.value] * orientW + 0.15 * (gesturing || perf >= 0.3 ? 1 : 0.4) + 0.15 * clamp01(shot.exposure.dynamicRange / 200));
    const semanticInterest = { score: r3(interest), reasons: [`framing ${framing.value}`, `orientation ${subjectOrientation.value}`, ...(gesturing ? ["gesturing/dancing"] : []), ...(perf >= 0.3 ? ["performance context"] : [])] };
    const staticVid = fa.static.staticImageVideo;
    const dur = toNumberApprox(shot.duration);
    let hero = 0.5 * interest + 0.5 * tq.score;
    if (!rep.primary) hero = Math.min(hero, 0.3); // no recognizable subject
    if (tq.score < 0.35) hero = Math.min(hero, tq.score + 0.2); // technical defects are not overridden by semantics
    if (dur < 0.5) hero *= 0.7;
    if (staticVid) hero *= 0.5;
    const heroReasons = [...(!rep.primary ? ["no subject"] : []), `semantic interest ${r3(interest)} (${semanticInterest.reasons.join(", ")})`, `technical quality ${tq.score} (${tq.reasons.join(", ")})`, ...(dur < 0.5 ? ["very short"] : []), ...(staticVid ? ["static image, not footage"] : [])];

    const first = obs[0]!;
    const firstClear = first.primary ? (["close_up", "medium_close_up", "medium"].includes(first.framing) ? 1 : first.framing === "medium_wide" ? 0.75 : 0.5) * (first.face ? 1 : 0.7) : 0.15;
    const confusion = first.persons.length <= 2 && first.saliency.length <= 2 ? 1 : 0.6;
    const quickMotion = m.frameChange.p50 >= 3 ? 1 : 0.6;
    let opening = clamp01(0.3 * firstClear + 0.15 * clamp01(shot.exposure.dynamicRange / 220) + 0.15 * confusion + 0.1 * quickMotion + 0.3 * tq.score) * (dur >= 1 ? 1 : 0.75);
    if (staticVid) opening *= 0.5;
    const openingReasons = [`first sample ${first.primary ? `shows a subject (${first.framing})` : "has no clear subject"}`, `contrast ${shot.exposure.dynamicRange}`, confusion === 1 ? "uncluttered" : "busy frame", quickMotion === 1 ? "movement from the start" : "little early movement", ...(staticVid ? ["static image"] : [])];

    const energy = clamp01(0.4 * clamp01(sp90 / 0.5) + 0.3 * clamp01(m.localChange.p50 / 20) + 0.3 * m.highMotionFraction);
    const lightingEvents = fa.suppressedBoundaries.filter((b) => b.frame >= shot.frames.first && b.frame <= shot.frames.last && /flash|brightness|blackout/.test(b.reason)).length;
    let drop = clamp01(0.4 * energy + 0.2 * Math.max(perf, presenceValue === "crowd" ? 0.8 : 0) + 0.15 * (camera.some((c) => c.label === "chaotic_high_energy" || c.label === "handheld") ? 1 : 0.3) + 0.1 * clamp01(lightingEvents / 3) + 0.15 * clamp01(shot.exposure.dynamicRange / 200));
    if (staticVid) drop *= 0.2;
    const dropReasons = [`motion energy ${r3(energy)}`, ...(perf >= 0.2 ? [`performance labels ${perf}`] : []), ...(presenceValue === "crowd" ? ["crowd"] : []), ...(lightingEvents ? [`${lightingEvents} lighting/flash event(s)`] : []), `contrast ${shot.exposure.dynamicRange}`, ...(staticVid ? ["static image"] : [])];

    const directional = screenDirection.value === "left_to_right" || screenDirection.value === "right_to_left" || camera.some((c) => c.label.startsWith("pan") || c.label.startsWith("tilt"));
    const entryExit = subjectLabels.some((l) => l.label === "entering_frame" || l.label === "exiting_frame");
    let transition = clamp01(0.35 * (directional ? 1 : 0.2) + 0.25 * (entryExit ? 1 : 0.2) + 0.2 * clamp01(sp90 / 0.4) + 0.2 * (framing.value === "extreme_close_up" || framing.value === "extreme_wide" ? 1 : 0.5));
    if (staticVid) transition *= 0.2;
    const transitionReasons = [directional ? "clear screen/camera direction" : "no clear direction", ...(entryExit ? ["subject enters/exits"] : []), `speed p90 ${sp90}`, ...(staticVid ? ["static image"] : [])];

    let loop = 0.1;
    const loopReasons: string[] = [];
    if (obs.length >= 2 && obs[0]!.embedding && obs.at(-1)!.embedding) {
      const sim = cosine(obs[0]!.embedding!, obs.at(-1)!.embedding!);
      loop = clamp01(0.55 * clamp01((sim - 0.5) / 0.45) + 0.25 * (sp50 < 0.05 ? 1 : 0.4) + 0.2 * (dur >= 1.5 ? 1 : 0.4));
      loopReasons.push(`start/end similarity ${r3(sim)}`, sp50 < 0.05 ? "stable background" : "moving camera", `duration ${Math.round(dur * 10) / 10} s`);
    } else loopReasons.push("single sample: not evaluable");
    if (staticVid) {
      loop *= 0.3;
      loopReasons.push("static image (trivially identical, not a real loop)");
    }

    const crop = cropAnalysis(shot, fa, obs);
    const emb = meanEmbedding(obs);
    if (!emb) shotWarnings.push({ code: "NO_EMBEDDING", message: "no feature print" });
    if (rep.primary && trackedShare < 0.5 && obs.length >= 3) shotWarnings.push({ code: "SUBJECT_TRACK_LOST", message: `subject tracked in ${Math.round(trackedShare * 100)} % of samples` });
    if (shot.boundaryIn.confidence <= 0.5 && shot.index > 0) shotWarnings.push({ code: "LOW_CONFIDENCE_BOUNDARY", message: `Phase 3 boundary confidence ${shot.boundaryIn.confidence}: see takes for semantic continuity` });
    if (staticVid) shotWarnings.push({ code: "STATIC_IMAGE_VIDEO", message: "still image presented as video" });
    const nd = meta.nearDuplicates.get(shot.shotId) ?? [];
    if (nd.length) shotWarnings.push({ code: "DUPLICATE_CONTENT", message: `near-duplicate of ${nd.join(", ")}` });

    return {
      mediaId: fa.source.mediaId,
      shotId: shot.shotId,
      start: shot.start,
      end: shot.end,
      samples: obs.map((o) => ({ frameIndex: o.plan.frameIndex, time: o.time, position: o.plan.position, representative: o.plan.representative })),
      subject: {
        presence: { value: presenceValue, confidence: r3(presenceConf), evidence: `median ${medCount} person(s) over ${obs.length} samples; crowd label ${r3(crowdLabel)}` },
        personCount: { median: medCount, max: Math.max(...counts) },
        primaryBox: rep.primary ? { x: r3(rep.primary.x), y: r3(rep.primary.y), w: r3(rep.primary.w), h: r3(rep.primary.h) } : null,
        identity: { value: null, note: "not identified (no face recognition); set via semantic overrides" },
      },
      content,
      context,
      framing,
      subjectOrientation,
      subjectMotion: { labels: subjectLabels, screenDirection },
      cameraMotion: { labels: camera, direction: camDir },
      features: {
        subjectClarity,
        semanticInterest,
        technicalQuality: tq,
        heroPotential: { score: r3(hero), reasons: heroReasons },
        openingPotential: { score: r3(opening), reasons: openingReasons },
        dropPotential: { score: r3(drop), reasons: dropReasons },
        transitionPotential: { score: r3(transition), reasons: transitionReasons },
        loopPotential: { score: r3(loop), reasons: loopReasons },
        cropPotential9x16: crop,
      },
      embedding: emb ? b64(emb) : "",
      phase3: { staticImageVideo: staticVid, boundaryInConfidence: shot.boundaryIn.confidence, overlayIds: shot.overlayIds, nearDuplicateShotIds: nd },
      warnings: shotWarnings,
    };
  });

  const takes = detectTakes(fa, shots);
  return {
    schemaVersion: "1.0.0",
    generatedAt: meta.generatedAt,
    mediaId: fa.source.mediaId,
    provenance: meta.provenance,
    source: {
      collection: meta.collection,
      archival: { value: archival, confidence: r3(archival ? 0.5 + 0.15 * archivalEvidence.length : 0.6), evidence: archival ? archivalEvidence.join("; ") : "HD, full-frame, not in an archive collection" },
      musicVideoEditing: { value: musicVideo, confidence: 0.7, evidence: `${fa.shots.length} shots, ${Math.round(shotsPerSecond * 100) / 100} shots/s` },
      staticImageVideo: fa.static.staticImageVideo,
      display: fa.geometry.display,
    },
    shots,
    takes,
    warnings,
  };
}

function r3n(x: number) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Same-take continuity across low-confidence Phase 3 boundaries: if the frames on both sides show
 * the same scene (embedding similarity, same people count, overlapping labels), the boundary is a
 * lighting event (big brightness change) or camera move within one take — not a new shot semantically.
 */
export const SAME_TAKE_SIMILARITY = 0.8;

export function detectTakes(fa: FootageAnalysis, shots: SemanticShot[]): SemanticMedia["takes"] {
  const takes: SemanticMedia["takes"] = [];
  for (let i = 1; i < fa.shots.length; i++) {
    const b = fa.shots[i]!;
    if (b.boundaryIn.confidence > 0.5) continue;
    const prev = shots[i - 1]!;
    const cur = shots[i]!;
    const pe = prev.embedding ? featureVector(prev.embedding) : null;
    const ce = cur.embedding ? featureVector(cur.embedding) : null;
    if (!pe || !ce) continue;
    const sim = cosine(pe, ce);
    const samePeople = prev.subject.presence.value === cur.subject.presence.value;
    const labelsA = new Set(prev.content.map((c) => c.label).concat(prev.context.map((c) => c.label)));
    const labelsB = new Set(cur.content.map((c) => c.label).concat(cur.context.map((c) => c.label)));
    const inter = [...labelsA].filter((l) => labelsB.has(l)).length;
    const jacc = inter / Math.max(1, new Set([...labelsA, ...labelsB]).size);
    if (sim < SAME_TAKE_SIMILARITY || jacc < 0.5) continue;
    const lumaJump = Math.abs(fa.shots[i]!.exposure.meanLuma - fa.shots[i - 1]!.exposure.meanLuma);
    const lighting = lumaJump >= 15 || /strobe|lighting/.test(b.boundaryIn.evidence);
    takes.push({
      takeId: `take:${fa.shots[i - 1]!.shotId.slice(5)}-${b.shotId.slice(5)}`,
      shotIds: [prev.shotId, cur.shotId],
      relation: lighting ? "LIGHTING_EVENT_SAME_TAKE" : "SAME_TAKE",
      confidence: r3(Math.min(0.95, 0.4 + 0.5 * ((sim - SAME_TAKE_SIMILARITY) / (1 - SAME_TAKE_SIMILARITY)) + (samePeople ? 0.1 : 0) + 0.1 * jacc)),
      evidence: `embedding similarity ${r3(sim)}, same people ${samePeople}, label overlap ${r3(jacc)}, mean luma ${Math.round(fa.shots[i - 1]!.exposure.meanLuma)} -> ${Math.round(fa.shots[i]!.exposure.meanLuma)}; Phase 3 boundary confidence ${b.boundaryIn.confidence}`,
    });
  }
  // merge chained takes
  const merged: SemanticMedia["takes"] = [];
  for (const t of takes) {
    const last = merged.at(-1);
    if (last && last.shotIds.at(-1) === t.shotIds[0]) {
      last.shotIds.push(t.shotIds[1]!);
      last.confidence = Math.min(last.confidence, t.confidence);
      last.evidence += ` | ${t.evidence}`;
      if (t.relation === "LIGHTING_EVENT_SAME_TAKE") last.relation = t.relation;
    } else merged.push({ ...t, shotIds: [...t.shotIds] });
  }
  return merged;
}

/** Exact frame time from packet timestamps. */
export function frameTimeMap(sortedPts: number[], timeBase: Rational, frames: number[]): Map<number, Rational> {
  return new Map(frames.map((f) => [f, mul(rational(sortedPts[f]!), timeBase)]));
}
