/**
 * Phase 6B primary-subject selection and subject mattes (pure, deterministic).
 *
 * Input: per-frame Apple Vision person INSTANCE masks (separable people, sometimes soft, sometimes
 * split or missing for a frame), face boxes, and the whole-person SEGMENTATION matte (cleanest edges,
 * all people together). Output: one subject matte per frame.
 *
 *   1. Instances are linked into person tracks by mask overlap (never by detector confidence).
 *      Short-lived tracks that hug a persistent one (a leg separated by a car door, an arm) are
 *      merged into it as fragments.
 *   2. The primary subject follows the Phase 6A precedence:
 *        HUMAN_SUBJECT_OVERRIDE / HUMAN_REFRAME_OVERRIDE subject > explicit project subject >
 *        reliable tracking (dominant face, the only person, or a clearly dominant person) >
 *        semantic estimate > safe fallback (PRIMARY_SUBJECT_UNCERTAIN with bounded alternatives,
 *        or NO_SUBJECT: the effect is not applied).
 *   3. The matte takes identity from the subject's instance track and edges from the segmentation
 *      matte: segmentation components are claimed only when they overlap the subject's (gated)
 *      instance and not another person's. Frames where Vision lost the instance are bridged from
 *      the nearest frames (bounded gap).
 */

import { COMPOSITION } from "../../compose/guardrail.ts";
import { type Mask, area, bbox, binarize, centroid, components, coverage, dilate, emptyMask, iou, multiply, union } from "./mask.ts";

export const SELECT_VERSION = "1.0.0";
export const SELECT = {
  /** instance masks are normalised to their peak; this level (half the peak) counts as "inside" */
  instanceThreshold: 128,
  minInstancePeak: 48,
  linkIou: 0.2,
  maxGap: 6,
  /** a track present in fewer frames than this (fraction of the range) may be a fragment */
  fragmentMaxCoverage: 0.4,
  fragmentAdjacencyPx: 8,
  fragmentMinXOverlap: 0.5,
  fragmentMaxGapHeights: 0.5,
  fragmentMaxAreaRatio: 0.6,
  stitchMin: 0.5,
  /** a person must be present this often to be a candidate subject */
  candidateMinCoverage: 0.2,
  soleOthersMaxAreaRatio: 0.25,
  dominantAreaRatio: 2.5,
  minSubjectArea: 0.01,
  /** an explicit point may miss a mask edge by this much (mask px; 16 px full resolution), never more */
  pointRadiusPx: 4,
  /** frames searched around an explicit point when Vision missed the person on the point's frame */
  pointMaxGap: 2,
  /** an x-only framing reference matches the person occupying this column band (mask px) */
  columnRadiusPx: 12,
  /** faces smaller than this (fraction of frame height) are ignored when counting people */
  groupMinFaceHeight: 0.025,
  groupMinFraction: 0.05,
  identityMaxGap: 4,
  identityMaxJumpFaces: 2,
  identityMaxSizeRatio: 1.8,
  /** a track is face-bearing when a face lies inside it in at least this share of its frames */
  identityFaceBearing: 0.5,
  /** ...and is occluded (identity unverifiable) when faceless with less than this share of its typical area */
  identityOccludedArea: 0.5,
  /** identity gate level (of the peak-normalised instance): soft presence, not shape */
  gateThreshold: 40,
  gatePx: 6,
  seamPx: 2,
  claimMin: 0.2,
};

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}
export interface FrameMasks {
  j: number;
  instances: Array<{ index: number; mask: Mask }>;
  faces: FaceBox[];
  seg: Mask | null;
}
export interface Point {
  j: number;
  /** mask coordinates (conformed px / downscale) */
  x: number;
  /** null = a horizontal position only (a framing subject track records x only): column match */
  y: number | null;
}
export interface SubjectHints {
  humanSubjectOverride?: { id: string; point: Point } | null;
  reframeOverrideSubject?: { id: string; points: Point[] } | null;
  projectSubject?: { point: Point; note: string } | null;
  semantic?: { point: Point; presence: string } | null;
}
export type SubjectSourceB = "HUMAN_SUBJECT_OVERRIDE" | "HUMAN_REFRAME_OVERRIDE" | "PROJECT_SUBJECT" | "TRACKED_DOMINANT_FACE" | "TRACKED_SOLE_PERSON" | "TRACKED_DOMINANT_PERSON" | "SEMANTIC_ESTIMATE" | "NONE";

export interface PersonTrack {
  id: string;
  /** frame -> indices into that frame's `instances` */
  frames: Map<number, number[]>;
  fragments: string[];
}
export interface TrackSummary {
  id: string;
  coverage: number;
  medianArea: number;
  firstFrame: number;
  lastFrame: number;
  centroid: { x: number; y: number } | null;
  fragments: string[];
  /** frames where two or more faces lie inside this "person": Vision merged several people */
  groupFrames: number;
  group: boolean;
}
export interface Selection {
  state: "SUBJECT_SELECTED" | "PRIMARY_SUBJECT_UNCERTAIN" | "NO_SUBJECT";
  source: SubjectSourceB;
  reason: string;
  trackId: string | null;
  alternatives: Array<TrackSummary & { label: string }>;
  tracks: TrackSummary[];
  /** frames with two or more comparable faces (no dominant face): a crowd or a group */
  crowdFrames: number;
  /** frames where the selected track's person appears to change (see identityBreaks) */
  identityBreaks: number[];
  warnings: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Vision instance masks are soft and their overall level varies from frame to frame (a person can
 * come back at 30 % "strength"). Identity only needs the shape, so each instance is normalised to its
 * own peak before thresholding (a relative threshold). Instances with a negligible peak stay empty.
 */
const normCache = new WeakMap<Mask, Mask>();
export function normalizeInstance(m: Mask): Mask {
  const c = normCache.get(m);
  if (c) return c;
  let mx = 0;
  for (const v of m.data) if (v > mx) mx = v;
  const d = new Uint8Array(m.data.length);
  if (mx >= SELECT.minInstancePeak) for (let i = 0; i < d.length; i++) d[i] = Math.min(255, Math.round((m.data[i]! * 255) / mx));
  const o = { w: m.w, h: m.h, data: d };
  normCache.set(m, o);
  return o;
}
const inst = (fr: FrameMasks, k: number) => binarize(normalizeInstance(fr.instances[k]!.mask), SELECT.instanceThreshold);

/** Union (soft) of a track's instances at one frame, or null when absent. */
export function trackMask(fr: FrameMasks, t: PersonTrack, all: PersonTrack[]): Mask | null {
  const ids = [t, ...all.filter((x) => t.fragments.includes(x.id))].flatMap((x) => x.frames.get(fr.j) ?? []);
  if (!ids.length) return null;
  return union(...ids.map((k) => normalizeInstance(fr.instances[k]!.mask)));
}

/** Link instances into person tracks by mask IoU (greedy, deterministic), then merge fragments. */
export function linkTracks(frames: FrameMasks[]): PersonTrack[] {
  const tracks: PersonTrack[] = [];
  const last = new Map<string, { j: number; mask: Mask }>();
  for (const fr of frames) {
    const pairs: Array<{ t: string; k: number; s: number }> = [];
    for (const t of tracks) {
      const l = last.get(t.id)!;
      if (fr.j - l.j > SELECT.maxGap) continue;
      fr.instances.forEach((_, k) => {
        const s = iou(l.mask, inst(fr, k));
        if (s >= SELECT.linkIou) pairs.push({ t: t.id, k, s });
      });
    }
    pairs.sort((a, b) => b.s - a.s || a.t.localeCompare(b.t) || a.k - b.k);
    const usedT = new Set<string>();
    const usedK = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedK.has(p.k)) continue;
      usedT.add(p.t);
      usedK.add(p.k);
      tracks.find((t) => t.id === p.t)!.frames.set(fr.j, [p.k]);
    }
    fr.instances.forEach((_, k) => {
      if (usedK.has(k)) return;
      const t: PersonTrack = { id: `person:${String(tracks.length).padStart(2, "0")}`, frames: new Map([[fr.j, [k]]]), fragments: [] };
      tracks.push(t);
    });
    for (const t of tracks) {
      const ks = t.frames.get(fr.j);
      if (ks) last.set(t.id, { j: fr.j, mask: union(...ks.map((k) => inst(fr, k))) });
    }
  }
  const byJ = new Map(frames.map((f) => [f.j, f]));
  const maskAt = (t: PersonTrack, j: number) => union(...t.frames.get(j)!.map((k) => inst(byJ.get(j)!, k)));
  // stitch: a track that starts within maxGap after another ends, where the other left off (compared
  // with its last few frames: Vision sometimes returns one degenerate mask before losing a person),
  // is the same person. Tracks that co-exist are never stitched.
  for (let changed = true; changed; ) {
    changed = false;
    const order = [...tracks].sort((a, b) => Math.min(...a.frames.keys()) - Math.min(...b.frames.keys()) || a.id.localeCompare(b.id));
    for (const b of order) {
      const b0 = Math.min(...b.frames.keys());
      const cands = order.filter((a) => a !== b && Math.max(...a.frames.keys()) < b0 && b0 - Math.max(...a.frames.keys()) <= SELECT.maxGap);
      let best: { a: PersonTrack; s: number } | null = null;
      for (const a of cands) {
        const tail = [...a.frames.keys()].sort((x, y) => y - x).slice(0, 3);
        const s = Math.max(...tail.map((j) => coverage(maskAt(b, b0), dilate(maskAt(a, j), SELECT.fragmentAdjacencyPx))));
        if (s >= SELECT.stitchMin && (!best || s > best.s)) best = { a, s };
      }
      if (best) {
        for (const [j, ks] of b.frames) best.a.frames.set(j, ks);
        tracks.splice(tracks.indexOf(b), 1);
        changed = true;
        break;
      }
    }
  }
  // fragments: short-lived tracks that belong to a persistent person in every frame they appear:
  // smaller, and inside the person's column (x overlap) within half a body height above/below.
  // This covers limbs split off by an occluder (a leg under a car door, an arm across a pole).
  const n = frames.length;
  const cov = (t: PersonTrack) => t.frames.size / Math.max(1, n);
  const persistent = tracks.filter((t) => cov(t) > SELECT.fragmentMaxCoverage).sort((a, b) => b.frames.size - a.frames.size);
  const typical = new Map(persistent.map((m) => {
    const as = [...m.frames.keys()].map((j) => area(maskAt(m, j))).sort((a, b) => a - b);
    return [m.id, as[Math.floor(as.length / 2)]!];
  }));
  for (const t of tracks) {
    if (persistent.includes(t)) continue;
    const host = persistent.find((m) =>
      [...t.frames.keys()].every((j) => {
        if (!m.frames.has(j)) return false;
        const tm = maskAt(t, j);
        const hm = maskAt(m, j);
        const tb = bbox(tm);
        const hb = bbox(hm);
        if (!tb) return true;
        if (!hb || area(tm) > SELECT.fragmentMaxAreaRatio * typical.get(m.id)!) return false;
        const xOverlap = Math.min(tb.x1, hb.x1) - Math.max(tb.x0, hb.x0) + 1;
        const hh = hb.y1 - hb.y0 + 1;
        const gap = Math.max(0, tb.y0 - hb.y1, hb.y0 - tb.y1);
        return xOverlap >= SELECT.fragmentMinXOverlap * (tb.x1 - tb.x0 + 1) && gap <= SELECT.fragmentMaxGapHeights * hh;
      }),
    );
    if (host) host.fragments.push(t.id);
  }
  return tracks;
}

const faceArea = (f: FaceBox) => f.w * f.h;
const countable = (fr: FrameMasks) => fr.faces.filter((f) => f.h >= SELECT.groupMinFaceHeight);

/** Faces (large enough to be a person, not a poster) whose centre lies inside a soft mask. */
export function facesInside(fr: FrameMasks, m: Mask): number {
  const b = binarize(m, SELECT.gateThreshold);
  return countable(fr).filter((f) => {
    const x = Math.min(b.w - 1, Math.max(0, Math.floor((f.x + f.w / 2) * b.w)));
    const y = Math.min(b.h - 1, Math.max(0, Math.floor((f.y + f.h / 2) * b.h)));
    return b.data[y * b.w + x]! > 0;
  }).length;
}

/** A frame with two or more comparable faces (none clearly dominant): a crowd or a group shot. */
export function crowdFrame(fr: FrameMasks): boolean {
  const fs = countable(fr).sort((a, b) => faceArea(b) - faceArea(a));
  return fs.length >= 2 && faceArea(fs[0]!) < COMPOSITION.dominanceAreaRatio * faceArea(fs[1]!);
}

export function summarize(frames: FrameMasks[], tracks: PersonTrack[]): TrackSummary[] {
  const byJ = new Map(frames.map((f) => [f.j, f]));
  const frag = new Set(tracks.flatMap((t) => t.fragments));
  return tracks
    .filter((t) => !frag.has(t.id))
    .map((t) => {
      const js = [...t.frames.keys()].sort((a, b) => a - b);
      const areas = js.map((j) => {
        const m = trackMask(byJ.get(j)!, t, tracks)!;
        return area(binarize(m, SELECT.instanceThreshold)) / (m.w * m.h);
      }).sort((a, b) => a - b);
      const mid = js[Math.floor(js.length / 2)]!;
      const mm = trackMask(byJ.get(mid)!, t, tracks)!;
      const c = centroid(mm, SELECT.instanceThreshold);
      const groupFrames = js.filter((j) => facesInside(byJ.get(j)!, trackMask(byJ.get(j)!, t, tracks)!) >= 2).length;
      return { id: t.id, coverage: r3(js.length / Math.max(1, frames.length)), medianArea: r3(areas[Math.floor(areas.length / 2)] ?? 0), firstFrame: js[0]!, lastFrame: js.at(-1)!, centroid: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null, fragments: t.fragments, groupFrames, group: groupFrames >= Math.max(2, SELECT.groupMinFraction * js.length) };
    });
}

/** The track whose (gated) mask contains a point, at the point's frame or the nearest frame (<= maxGap). */
export function trackAtPoint(frames: FrameMasks[], tracks: PersonTrack[], p: Point): string | null {
  const frag = new Set(tracks.flatMap((t) => t.fragments));
  // a point is a claim about ONE moment: only the nearest frames are searched (a longer search would
  // let a moving person drift onto the point); an x-only column tolerates the full gap
  const reach = p.y === null ? SELECT.maxGap : SELECT.pointMaxGap;
  const order = [...frames].sort((a, b) => Math.abs(a.j - p.j) - Math.abs(b.j - p.j) || a.j - b.j).filter((f) => Math.abs(f.j - p.j) <= reach);
  for (const fr of order) {
    let best: { id: string; d: number } | null = null;
    if (p.y === null) {
      // column match: the person occupying most of the column x +- pointRadius
      let bestCol: { id: string; n: number } | null = null;
      for (const t of tracks) {
        if (frag.has(t.id)) continue;
        const m = trackMask(fr, t, tracks);
        if (!m) continue;
        let n = 0;
        for (let x = Math.max(0, Math.round(p.x) - SELECT.columnRadiusPx); x <= Math.min(m.w - 1, Math.round(p.x) + SELECT.columnRadiusPx); x++) for (let y = 0; y < m.h; y++) if (m.data[y * m.w + x]! >= SELECT.instanceThreshold) n++;
        if (n > 0 && (!bestCol || n > bestCol.n)) bestCol = { id: t.id, n };
      }
      if (bestCol) return bestCol.id;
      if (fr.instances.length) return null;
      continue;
    }
    for (const t of tracks) {
      if (frag.has(t.id)) continue;
      const m = trackMask(fr, t, tracks);
      if (!m) continue;
      const x = Math.max(0, Math.min(m.w - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(m.h - 1, Math.round(p.y!)));
      if (m.data[y * m.w + x]! >= SELECT.instanceThreshold) return t.id;
      const b = binarize(m, SELECT.instanceThreshold);
      // nearest set pixel within the point radius
      for (let r = 1; r <= SELECT.pointRadiusPx; r++) {
        let hit = false;
        for (let dy = -r; dy <= r && !hit; dy++)
          for (let dx = -r; dx <= r && !hit; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < b.w && yy < b.h && b.data[yy * b.w + xx]) hit = true;
          }
        if (hit) {
          if (!best || r < best.d) best = { id: t.id, d: r };
          break;
        }
      }
    }
    if (best) return best.id;
    // nobody at this point on this frame (Vision may not separate the person here): try the next
    // nearest frame; the point is never snapped to a neighbouring person further than pointRadius
  }
  return null;
}

/** Select the primary subject with the fixed precedence (never by detector confidence). */
export function selectSubject(frames: FrameMasks[], tracks: PersonTrack[], hints: SubjectHints = {}): Selection {
  const tracksSum = summarize(frames, tracks);
  const candidates = tracksSum.filter((t) => t.coverage >= SELECT.candidateMinCoverage && t.medianArea >= SELECT.minSubjectArea / 4).sort((a, b) => b.coverage * b.medianArea - a.coverage * a.medianArea || a.id.localeCompare(b.id));
  const crowdFrames = frames.filter(crowdFrame).length;
  const warn = (id: string, breaks: number[]) => {
    const t = tracksSum.find((x) => x.id === id);
    return [
      ...(t?.group ? [`SUBJECT_NOT_SEPARABLE: ${id} contains two or more faces in ${t.groupFrames} frames (Vision merged several people); the isolation would carry the others with it`] : []),
      ...(breaks.length ? [`IDENTITY_SWITCH_SUSPECTED: the person in ${id} appears to change, or is hidden, at frames ${breaks.join(",")} (an occluder took over the track); effects spanning these frames are not rendered`] : []),
    ];
  };
  const picked = (source: SubjectSourceB, id: string, reason: string): Selection => {
    const breaks = identityBreaks(frames, tracks, id);
    return { state: "SUBJECT_SELECTED", source, reason, trackId: id, alternatives: [], tracks: tracksSum, crowdFrames, identityBreaks: breaks, warnings: warn(id, breaks) };
  };
  const uncertain = (source: SubjectSourceB, reason: string): Selection => ({ state: "PRIMARY_SUBJECT_UNCERTAIN", source, reason, trackId: null, alternatives: candidates.slice(0, 3).map((c, i) => ({ ...c, label: `ALTERNATIVE_${"ABC"[i]}` })), tracks: tracksSum, crowdFrames, identityBreaks: [], warnings: [] });
  const explicit: Array<[SubjectSourceB, Point[] | undefined, string]> = [
    ["HUMAN_SUBJECT_OVERRIDE", hints.humanSubjectOverride ? [hints.humanSubjectOverride.point] : undefined, `human subject override ${hints.humanSubjectOverride?.id}`],
    ["HUMAN_REFRAME_OVERRIDE", hints.reframeOverrideSubject?.points, `subject of approved reframe override ${hints.reframeOverrideSubject?.id}`],
    ["PROJECT_SUBJECT", hints.projectSubject ? [hints.projectSubject.point] : undefined, `explicit project subject: ${hints.projectSubject?.note}`],
  ];
  for (const [source, pts, why] of explicit) {
    if (!pts?.length) continue;
    const votes = new Map<string, number>();
    for (const p of pts) {
      const id = trackAtPoint(frames, tracks, p);
      if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) return picked(source, best[0], `${why} (${best[1]}/${pts.length} reference points on ${best[0]})`);
    // an explicit reference that lands on nobody is never replaced by a guess
    return uncertain(source, `${why} does not coincide with any detected person`);
  }
  // reliable tracking: dominant face (area ratio + minimum height, the Phase 6A rule), owned by the
  // track whose instance covers it
  const faceOwners = new Map<string, number>();
  let faceFrames = 0;
  for (const fr of frames) {
    if (!fr.faces.length) continue;
    faceFrames++;
    const fs = [...fr.faces].sort((a, b) => b.w * b.h - a.w * a.h);
    const top = fs[0]!;
    if (top.h < COMPOSITION.minFaceHeightFraction) continue; // the 9:16 crop keeps the full source height
    if (fs[1] && top.w * top.h < COMPOSITION.dominanceAreaRatio * fs[1].w * fs[1].h) continue;
    const mw = fr.instances[0]?.mask.w ?? fr.seg?.w ?? 0;
    const mh = fr.instances[0]?.mask.h ?? fr.seg?.h ?? 0;
    const id = trackAtPoint([fr], tracks, { j: fr.j, x: (top.x + top.w / 2) * mw, y: (top.y + top.h / 2) * mh });
    if (id) faceOwners.set(id, (faceOwners.get(id) ?? 0) + 1);
  }
  // automatic identity never accepts a merged group as "the person"
  const isGroup = (id: string) => tracksSum.find((t) => t.id === id)?.group ?? false;
  const single = candidates.filter((c) => !c.group);
  const owners = [...faceOwners.entries()].filter(([id]) => !isGroup(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (owners.length && faceFrames && owners[0]![1] / faceFrames >= COMPOSITION.minTrackCoverage && (owners[1]?.[1] ?? 0) / faceFrames <= 0.2)
    return picked("TRACKED_DOMINANT_FACE", owners[0]![0], `dominant face in ${owners[0]![1]}/${faceFrames} face frames`);
  // body-based rules only when no frame shows a crowd/group of comparable faces and no candidate is a merged group
  const bodyRulesOk = crowdFrames === 0 && !candidates.some((c) => c.group);
  if (bodyRulesOk && (single.length === 1 || (single.length > 1 && single.slice(1).every((c) => c.medianArea < SELECT.soleOthersMaxAreaRatio * single[0]!.medianArea && c.coverage < 0.5)))) {
    const c = single[0]!;
    if (c.coverage >= 0.6) return picked("TRACKED_SOLE_PERSON", c.id, `the only persistent person (present in ${Math.round(c.coverage * 100)} % of frames)`);
  }
  if (bodyRulesOk && single.length > 1 && single[0]!.coverage >= 0.6 && single.slice(1).every((c) => single[0]!.medianArea >= SELECT.dominantAreaRatio * c.medianArea))
    return picked("TRACKED_DOMINANT_PERSON", single[0]!.id, `clearly dominant person (area >= ${SELECT.dominantAreaRatio}x every other person)`);
  if (hints.semantic && hints.semantic.presence === "single" && crowdFrames === 0) {
    const id = trackAtPoint(frames, tracks, hints.semantic.point);
    if (id && !isGroup(id)) return picked("SEMANTIC_ESTIMATE", id, "Phase 3B single-subject estimate");
  }
  if (!candidates.length) return { state: "NO_SUBJECT", source: "NONE", reason: "no persistent person detected", trackId: null, alternatives: [], tracks: tracksSum, crowdFrames, identityBreaks: [], warnings: [] };
  const why = [candidates.length > 1 ? `${candidates.length} comparable people` : null, crowdFrames ? `${crowdFrames} frames with several comparable faces` : null, candidates.some((c) => c.group) ? "Vision merged several people into one mask" : null].filter(Boolean).join("; ");
  return uncertain("NONE", `${why || "no reliable identity"}; no human/project reference: not guessing`);
}

export interface SubjectFrame {
  j: number;
  matte: Mask;
  /** how the frame's identity was established */
  basis: "INSTANCE" | "BRIDGED" | "MISSING";
  /** other people's instance masks at this frame (leakage QC) */
  others: Mask;
}

/**
 * Subject matte per frame: segmentation edges gated by the subject's instance identity; frames
 * where the instance is missing are bridged from the nearest frames within maxGap.
 */
export function subjectMattes(frames: FrameMasks[], tracks: PersonTrack[], trackId: string): SubjectFrame[] {
  const t = tracks.find((x) => x.id === trackId)!;
  const fragIds = new Set(t.fragments);
  // only persistent people can veto a segmentation component: a brief, ambiguous blob next to the
  // subject (often a limb Vision split off for a few frames) must not cut the subject's own leg
  const others = tracks.filter((x) => x.id !== t.id && !fragIds.has(x.id) && x.frames.size >= SELECT.candidateMinCoverage * frames.length);
  const own = frames.map((fr) => trackMask(fr, t, tracks));
  return frames.map((fr, i) => {
    const w = fr.seg?.w ?? fr.instances[0]?.mask.w ?? 1;
    const h = fr.seg?.h ?? fr.instances[0]?.mask.h ?? 1;
    const oth = others.map((o) => trackMask(fr, o, tracks)).filter((m): m is Mask => !!m);
    const otherMask = oth.length ? binarize(union(...oth), SELECT.instanceThreshold) : emptyMask(w, h);
    let idm = own[i];
    let basis: SubjectFrame["basis"] = "INSTANCE";
    if (!idm) {
      const near = [];
      for (let d = 1; d <= SELECT.maxGap && near.length < 2; d++) {
        const a = own[i - d];
        const b = own[i + d];
        if (a && !near.length) near.push(a);
        if (b) near.push(b);
        if (a && near.length === 1 && b) break;
      }
      if (!near.length) return { j: fr.j, matte: emptyMask(w, h), basis: "MISSING", others: otherMask };
      idm = binarize(union(...near), SELECT.instanceThreshold);
      basis = "BRIDGED";
    }
    if (!fr.seg) return { j: fr.j, matte: idm, basis, others: otherMask };
    // identity is temporally stable: the gate also admits what the subject's instance covered on the
    // neighbouring frames (Vision often under-covers a limb for a single frame)
    // (and at the lower "soft presence" level: a plaid torso can come back at 20 % of the peak)
    const nb = [own[i - 1], own[i + 1]].filter((m): m is Mask => !!m).map((m) => binarize(m, SELECT.gateThreshold));
    const gate = dilate(union(binarize(idm, SELECT.gateThreshold), ...nb), SELECT.gatePx + (basis === "BRIDGED" ? 4 : 0));
    const { labels, sizes } = components(fr.seg);
    const inGate = new Array(sizes.length).fill(0);
    const inOther = new Array(sizes.length).fill(0);
    for (let p = 0; p < labels.length; p++) {
      const l = labels[p]!;
      if (!l) continue;
      if (gate.data[p]) inGate[l]++;
      if (otherMask.data[p]) inOther[l]++;
    }
    const claimed = new Uint8Array(labels.length);
    for (let p = 0; p < labels.length; p++) {
      const l = labels[p]!;
      if (l && inGate[l] / sizes[l]! >= SELECT.claimMin && inGate[l] >= inOther[l]) claimed[p] = 255;
    }
    // keep the segmentation's soft fringe next to claimed components, but not inside other people
    const fringe = dilate({ w, h, data: claimed }, SELECT.seamPx);
    for (let p = 0; p < fringe.data.length; p++) if (otherMask.data[p] && !claimed[p]) fringe.data[p] = 0;
    const segPart = multiply(fr.seg, fringe);
    const instPart = basis === "INSTANCE" ? multiply(idm, gate) : emptyMask(w, h);
    return { j: fr.j, matte: union(segPart, instPart), basis, others: otherMask };
  });
}

export interface ConflictCheck {
  state: "CONSISTENT" | "PRIMARY_SUBJECT_CONFLICT" | "NOT_COMPARABLE";
  reference: string;
  onSubject: number;
  onOther: number;
  offPeople: number;
  otherTrack: string | null;
}

/**
 * Compare the isolation subject with another system's idea of the primary subject (the composition
 * guardrail's subject, or the subject track recorded with an approved reframe override). Disagreement
 * is PRIMARY_SUBJECT_CONFLICT: the effect must not silently proceed.
 */
/**
 * Frames where the person inside a track appears to change identity. Mask overlap links a person
 * to whoever overlaps them next, so an occluder passing in front can take over the track. The
 * track's own face (the largest face whose centre lies inside its mask) must move and scale smoothly:
 * a jump of more than `identityMaxJumpFaces` face heights, or a size change beyond
 * `identityMaxSizeRatio`, between face frames at most `identityMaxGap` apart, is a suspected switch;
 * so is the track's face staying visible where it was while the track's mask no longer covers it,
 * and a face-bearing track that loses its face while its mask collapses (occluded: unverifiable).
 */
export function identityBreaks(frames: FrameMasks[], tracks: PersonTrack[], trackId: string): number[] {
  const t = tracks.find((x) => x.id === trackId);
  if (!t) return [];
  const out: number[] = [];
  const sorted = [...frames].sort((a, b) => a.j - b.j);
  // a face-bearing person (a face inside the track in most of its frames) whose face vanishes while
  // the track's mask collapses is occluded: identity can't be verified there (treated as a break)
  const hasFace = (fr: FrameMasks, m: Mask) => facesInside(fr, m) > 0;
  const withFace = sorted.filter((fr) => {
    const m = trackMask(fr, t, tracks);
    return m && hasFace(fr, m);
  });
  const present = sorted.filter((fr) => trackMask(fr, t, tracks)).length;
  const faceAreas = withFace.map((fr) => area(binarize(trackMask(fr, t, tracks)!, SELECT.instanceThreshold))).sort((a, c) => a - c);
  const typical = faceAreas[Math.floor(faceAreas.length / 2)] ?? 0;
  const faceBearing = present > 0 && withFace.length / present >= SELECT.identityFaceBearing;
  let prev: { j: number; cx: number; cy: number; h: number } | null = null;
  for (const fr of sorted) {
    const m = trackMask(fr, t, tracks);
    if (!m) continue;
    if (faceBearing && !hasFace(fr, m) && area(binarize(m, SELECT.instanceThreshold)) < SELECT.identityOccludedArea * typical) {
      out.push(fr.j);
      continue;
    }
    const b = binarize(m, SELECT.gateThreshold);
    const inside = countable(fr).filter((f) => {
      const x = Math.min(b.w - 1, Math.max(0, Math.floor((f.x + f.w / 2) * b.w)));
      const y = Math.min(b.h - 1, Math.max(0, Math.floor((f.y + f.h / 2) * b.h)));
      return b.data[y * b.w + x]! > 0;
    });
    if (!inside.length) {
      // the track's person may have LEFT the track: their face is still visible where it was, but
      // no longer inside the track's mask (an occluder without a visible face took over)
      if (prev && fr.j - prev.j <= SELECT.identityMaxGap) {
        const p0 = prev;
        const stayed = countable(fr).some((f) => {
          const cx = (f.x + f.w / 2) * b.w, cy = (f.y + f.h / 2) * b.h, h = f.h * b.h;
          return Math.hypot(cx - p0.cx, cy - p0.cy) <= p0.h && Math.max(h, p0.h) / Math.max(1e-6, Math.min(h, p0.h)) <= SELECT.identityMaxSizeRatio;
        });
        if (stayed) {
          out.push(fr.j);
          prev = null;
        }
      }
      continue;
    }
    const f = inside.sort((a, c) => faceArea(c) - faceArea(a))[0]!;
    const cur = { j: fr.j, cx: (f.x + f.w / 2) * b.w, cy: (f.y + f.h / 2) * b.h, h: f.h * b.h };
    if (prev && cur.j - prev.j <= SELECT.identityMaxGap) {
      const jump = Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy) / Math.max(1, (cur.h + prev.h) / 2);
      const ratio = Math.max(cur.h, prev.h) / Math.max(1e-6, Math.min(cur.h, prev.h));
      if (jump > SELECT.identityMaxJumpFaces || ratio > SELECT.identityMaxSizeRatio) out.push(cur.j);
    }
    prev = cur;
  }
  return out;
}

export function checkConflict(frames: FrameMasks[], tracks: PersonTrack[], subjectTrack: string, reference: string, points: Point[]): ConflictCheck {
  let onSubject = 0, onOther = 0, offPeople = 0;
  const other = new Map<string, number>();
  for (const p of points) {
    const id = trackAtPoint(frames, tracks, p);
    if (!id) offPeople++;
    else if (id === subjectTrack) onSubject++;
    else {
      onOther++;
      other.set(id, (other.get(id) ?? 0) + 1);
    }
  }
  const otherTrack = [...other.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const state = onSubject + onOther === 0 ? "NOT_COMPARABLE" : onOther > onSubject ? "PRIMARY_SUBJECT_CONFLICT" : "CONSISTENT";
  return { state, reference, onSubject, onOther, offPeople, otherTrack };
}

