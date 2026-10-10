/**
 * Cross-media semantic index: visual novelty against the whole pool (duplicates never count as
 * diversity), duplicate groups (from Phase 3 pixel-level links), and bounded continuity candidates
 * (at most CANDIDATES_EVALUATED per shot, CANDIDATES_KEPT kept) — no O(N^2) output.
 */

import type { ContinuityCandidate, Framing, SemanticIndex, SemanticMedia, SemanticShot } from "./schema.ts";
import { cosine } from "./build.ts";
import { featureVector } from "./vision.ts";

export const CANDIDATES_KEPT = 8;
export const CANDIDATES_EVALUATED = 14;
const r3 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
const FRAMING_ORD: Record<Framing, number | null> = { extreme_close_up: 0, close_up: 1, medium_close_up: 2, medium: 3, medium_wide: 4, wide: 5, extreme_wide: 6, unknown: null };

export interface DuplicateLink {
  a: { mediaId: string; shotId: string };
  b: { mediaId: string; shotId: string };
  evidence: string;
}

/** Horizontal screen flow: +1 content/subject moves left->right on screen, -1 right->left, 0 none. */
export function screenFlow(s: SemanticShot): number {
  const d = s.subjectMotion.screenDirection;
  if (d.value === "left_to_right" && d.confidence >= 0.5) return 1;
  if (d.value === "right_to_left" && d.confidence >= 0.5) return -1;
  const pan = s.cameraMotion.labels.find((l) => (l.label === "pan_left" || l.label === "pan_right") && l.confidence >= 0.5);
  if (pan) return pan.label === "pan_left" ? 1 : -1; // panning left makes content move right on screen
  return 0;
}

export function scoreContinuity(a: SemanticShot, b: SemanticShot, sim: number, sequence: boolean): ContinuityCandidate {
  const fa = screenFlow(a);
  const fb = screenFlow(b);
  const motionRelation = fa && fb ? (fa === fb ? "same_direction" : "opposite_direction") : "none";
  const oa = FRAMING_ORD[a.framing.value];
  const ob = FRAMING_ORD[b.framing.value];
  const framingRelation = oa === null || ob === null ? "unknown" : Math.abs(oa - ob) >= 3 ? "strong_contrast" : oa === ob ? "similar" : ob < oa ? "tighter" : "wider";
  const energyA = a.features.dropPotential.score;
  const energyB = b.features.dropPotential.score;
  const reasons: string[] = [];
  let score = 0.2 * b.features.technicalQuality.score;
  let kind: ContinuityCandidate["kind"] | null = null;
  if (motionRelation === "same_direction") {
    score += 0.35;
    reasons.push("same screen direction");
    kind = "motion_match";
  } else if (motionRelation === "opposite_direction") {
    score -= 0.1;
    reasons.push("opposite screen direction (jarring unless intended)");
  }
  if (sim >= 0.85 && framingRelation === "similar") {
    score += 0.3;
    reasons.push(`visually similar (${r3(sim)}) with similar framing: match-cut candidate`);
    kind = "match_cut";
  } else if (framingRelation === "strong_contrast") {
    score += 0.2;
    reasons.push(`strong framing contrast (${a.framing.value} -> ${b.framing.value})`);
    if (kind === null) kind = "contrast_cut";
  }
  if (energyB - energyA >= 0.25) {
    score += 0.15;
    reasons.push(`energy build ${r3(energyA)} -> ${r3(energyB)}`);
    if (kind === null) kind = "energy_build";
  }
  if (a.subject.presence.value !== "none" && b.subject.presence.value !== "none") score += 0.1;
  if (b.phase3.staticImageVideo) {
    score *= 0.3;
    reasons.push("target is a static image");
  }
  if (sequence) reasons.push("next shot in the source");
  return { to: { mediaId: b.mediaId, shotId: b.shotId }, score: r3(score), kind: kind ?? (sequence ? "sequence_neighbor" : "other"), motionRelation, framingRelation, reasons };
}

export function buildSemanticIndex(docs: SemanticMedia[], links: DuplicateLink[]): SemanticIndex {
  const all = docs.flatMap((d) => d.shots);
  const key = (s: { mediaId: string; shotId: string }) => `${s.mediaId}/${s.shotId}`;
  const emb = new Map(all.map((s) => [key(s), s.embedding ? featureVector(s.embedding) : null]));
  // duplicate groups (union-find over Phase 3 near-duplicate links, within and across media)
  const parent = new Map(all.map((s) => [key(s), key(s)]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const allLinks = [...links];
  for (const s of all) for (const d of s.phase3.nearDuplicateShotIds) allLinks.push({ a: s, b: { mediaId: s.mediaId, shotId: d }, evidence: "Phase 3 near-duplicate (same media)" });
  for (const l of allLinks) {
    if (!parent.has(key(l.a)) || !parent.has(key(l.b))) continue;
    const ra = find(key(l.a));
    const rb = find(key(l.b));
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const s of all) {
    const r = find(key(s));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(key(s));
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1).sort();
  const groupOf = new Map<string, string>();
  const duplicateGroups = dupGroups.map((g, i) => {
    const id = `dup:${String(i).padStart(3, "0")}`;
    for (const k of g) groupOf.set(k, id);
    return {
      id,
      members: g.map((k) => ({ mediaId: k.split("/")[0]!, shotId: k.split("/")[1]! })),
      evidence: allLinks.filter((l) => g.includes(key(l.a)) && g.includes(key(l.b))).map((l) => l.evidence).filter((v, i, a) => a.indexOf(v) === i).join("; "),
    };
  });
  const takeOf = new Map<string, string>();
  for (const d of docs) for (const t of d.takes) for (const s of t.shotIds) takeOf.set(`${d.mediaId}/${s}`, t.takeId);

  // nearest-neighbour similarity for every shot first (novelty = percentile of distance in the pool)
  const nnSim = new Map<string, number>();
  for (const s of all) {
    const e = emb.get(key(s));
    if (!e) continue;
    let best = -1;
    for (const o of all) {
      const k = key(o);
      if (k === key(s) || (takeOf.get(k) && takeOf.get(k) === takeOf.get(key(s)))) continue;
      const oe = emb.get(k);
      if (oe) best = Math.max(best, cosine(e, oe));
    }
    nnSim.set(key(s), best);
  }
  const sortedDist = [...nnSim.values()].map((v) => 1 - v).sort((a, b) => a - b);
  const percentile = (d: number) => (sortedDist.length > 1 ? sortedDist.filter((x) => x < d).length / (sortedDist.length - 1) : 0.5);
  const shots: SemanticIndex["shots"] = all.map((s) => {
    const e = emb.get(key(s));
    // novelty: nearest neighbour among OTHER shots (same-take shots excluded; duplicates included)
    let best = -1;
    let bestKey = "";
    const sims: Array<[string, number]> = [];
    if (e) {
      for (const o of all) {
        const k = key(o);
        if (k === key(s)) continue;
        if (takeOf.get(k) && takeOf.get(k) === takeOf.get(key(s)) && o.mediaId === s.mediaId) continue;
        const oe = emb.get(k);
        if (!oe) continue;
        const sim = cosine(e, oe);
        sims.push([k, sim]);
        if (sim > best || (sim === best && k < bestKey)) {
          best = sim;
          bestKey = k;
        }
      }
    }
    const dup = groupOf.get(key(s)) ?? null;
    let novelty = e ? percentile(1 - best) : 0.5;
    const reasons = e ? [`nearest other shot ${bestKey} (similarity ${r3(best)}); distance percentile in the pool ${r3(novelty)}`] : ["no embedding"];
    if (dup) {
      novelty = Math.min(novelty, 0.1);
      reasons.push(`duplicate group ${dup}: not visual diversity`);
    }
    if (s.phase3.staticImageVideo) reasons.push("static image");
    // bounded continuity candidates: next shots in the source + most similar + same-flow shots
    const idx = all.indexOf(s);
    const seq = all.slice(idx + 1, idx + 3).filter((o) => o.mediaId === s.mediaId);
    const similar = [...sims].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([k]) => all.find((o) => key(o) === k)!);
    const flow = screenFlow(s);
    const sameFlow = flow
      ? all.filter((o) => o !== s && screenFlow(o) === flow).sort((a, b) => b.features.technicalQuality.score - a.features.technicalQuality.score || (key(a) < key(b) ? -1 : 1)).slice(0, 6)
      : [];
    const cand = new Map<string, SemanticShot>();
    for (const o of [...seq, ...similar, ...sameFlow]) {
      if (cand.size >= CANDIDATES_EVALUATED) break;
      const k = key(o);
      if (k === key(s) || (dup && groupOf.get(k) === dup) || (takeOf.get(k) && takeOf.get(k) === takeOf.get(key(s)))) continue;
      cand.set(k, o);
    }
    const continuity = [...cand.values()]
      .map((o) => scoreContinuity(s, o, e && emb.get(key(o)) ? cosine(e, emb.get(key(o))!) : 0, seq.includes(o)))
      .sort((a, b) => b.score - a.score || (`${a.to.mediaId}/${a.to.shotId}` < `${b.to.mediaId}/${b.to.shotId}` ? -1 : 1))
      .slice(0, CANDIDATES_KEPT);
    return { mediaId: s.mediaId, shotId: s.shotId, visualNovelty: { score: r3(novelty), reasons }, duplicateGroup: dup, continuity };
  });
  return { schemaVersion: "1.0.0", media: docs.map((d) => d.mediaId), shots, duplicateGroups };
}
