/**
 * Phase 12: colour / delivery policy. Bali delivers SDR Rec.709 (BT.709 primaries / transfer / matrix,
 * limited range). Ambiguous sources are NOT silently interpreted: missing tags need an explicit, recorded
 * policy decision (the Phase 11.5 archive was interpreted "as tagged" by a human-reviewed record); HDR or
 * mismatched tags on a delivery are blocking.
 */

import { type Issue } from "./errors.ts";

export interface ColourTags {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  range: string | null;
}

export const SDR_709: ColourTags = { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" };
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const WIDE_PRIMARIES = new Set(["bt2020", "smpte432", "smpte431"]);

export type MissingTagPolicy = { decision: "REQUIRE_EXPLICIT" } | { decision: "ASSUME"; assume: ColourTags; reason: string; decidedBy: "human"; record: string };

export interface ColourInterpretation {
  tags: ColourTags;
  assumed: boolean;
  basis: string;
  issues: Issue[];
}

const missing = (t: ColourTags) => (Object.keys(t) as Array<keyof ColourTags>).filter((k) => !t[k] || t[k] === "unknown" || t[k] === "unspecified" || t[k] === "reserved");

/** Source interpretation: tags as given; missing tags only through an explicit, recorded human policy. */
export function interpretSourceColour(tags: ColourTags, policy: MissingTagPolicy, file?: string): ColourInterpretation {
  const gaps = missing(tags);
  const issues: Issue[] = [];
  if (tags.transfer && HDR_TRANSFERS.has(tags.transfer)) issues.push({ code: "COLOUR_HDR_SOURCE", severity: "ERROR", what: `HDR source (${tags.transfer}) in an SDR pipeline`, file, next: "an HDR -> SDR conversion needs its own approved transform; none is applied silently" });
  if (!gaps.length) return { tags, assumed: false, basis: "as tagged", issues };
  if (policy.decision === "REQUIRE_EXPLICIT") {
    issues.push({ code: "COLOUR_TAGS_MISSING", severity: "BLOCKING", what: `colour metadata missing: ${gaps.join(", ")}`, file, next: "record an explicit human colour-interpretation decision (MissingTagPolicy ASSUME with a record) — the editor does not invent one" });
    return { tags, assumed: false, basis: "unresolved", issues };
  }
  const filled = { ...tags };
  for (const k of gaps) filled[k] = policy.assume[k];
  issues.push({ code: "COLOUR_TAGS_ASSUMED", severity: "WARNING", what: `colour metadata missing (${gaps.join(", ")}): interpreted by human decision (${policy.reason})`, file, next: `keep the decision record ${policy.record} with the project` });
  return { tags: filled, assumed: true, basis: `human decision: ${policy.record}`, issues };
}

/** Delivery tags must be exactly SDR Rec.709 limited (or the requested spec); HDR / wide-gamut tags block. */
export function checkDeliveryColour(t: ColourTags, want: ColourTags = SDR_709, file?: string): Issue[] {
  const issues: Issue[] = [];
  if (t.transfer && HDR_TRANSFERS.has(t.transfer)) issues.push({ code: "COLOUR_HDR_TAG", severity: "BLOCKING", what: `HDR transfer tag ${t.transfer} on an SDR delivery`, file, expected: want.transfer, actual: t.transfer, next: "write BT.709 tags explicitly at mux; check no HDR flag leaked from a source" });
  if (t.primaries && WIDE_PRIMARIES.has(t.primaries)) issues.push({ code: "COLOUR_WIDE_GAMUT_TAG", severity: "BLOCKING", what: `wide-gamut primaries ${t.primaries} on a Rec.709 delivery`, file, expected: want.primaries, actual: t.primaries, next: "write BT.709 primaries explicitly" });
  for (const k of Object.keys(want) as Array<keyof ColourTags>) {
    if (!t[k]) issues.push({ code: "COLOUR_TAG_MISSING", severity: "BLOCKING", what: `delivery has no ${k} tag`, file, expected: want[k], actual: null, next: "tag deliveries explicitly; players guess differently when tags are missing" });
    else if (t[k] !== want[k] && !(k === "transfer" && HDR_TRANSFERS.has(t[k]!)) && !(k === "primaries" && WIDE_PRIMARIES.has(t[k]!))) issues.push({ code: k === "range" ? "COLOUR_RANGE" : "COLOUR_TAG_MISMATCH", severity: "BLOCKING", what: `${k} is ${t[k]}`, file, expected: want[k], actual: t[k], next: "re-mux with the delivery tags (no re-encode needed if only the tag is wrong)" });
  }
  return issues;
}

/** Social and master must carry the same interpretation (a mismatch means one of them was transformed differently). */
export function checkSocialMasterConsistency(social: ColourTags, master: ColourTags): Issue[] {
  const diff = (Object.keys(social) as Array<keyof ColourTags>).filter((k) => social[k] !== master[k]);
  return diff.length ? [{ code: "COLOUR_SOCIAL_MASTER_MISMATCH", severity: "BLOCKING", what: `social and master differ in ${diff.join(", ")}`, expected: master, actual: social, next: "derive the social from the master with the same tags" }] : [];
}

/**
 * A double transform (e.g. limited -> full expansion applied twice) shows as a level shift against the
 * approved reference: blacks crushed / whites clipped, or a milky lift. Means are 8-bit luma.
 */
export function checkLevelShift(ref: { p01: number; p99: number }, out: { p01: number; p99: number }, file?: string, tolerance = 6): Issue[] {
  const dLow = out.p01 - ref.p01;
  const dHigh = out.p99 - ref.p99;
  if (Math.abs(dLow) <= tolerance && Math.abs(dHigh) <= tolerance) return [];
  return [{ code: "COLOUR_LEVEL_SHIFT", severity: "BLOCKING", what: `levels shifted against the reference (black ${dLow > 0 ? "+" : ""}${dLow}, white ${dHigh > 0 ? "+" : ""}${dHigh}) — a range / transfer applied twice or not at all`, file, expected: ref, actual: out, next: "check the range interpretation at decode and at encode (tv vs pc)" }];
}
