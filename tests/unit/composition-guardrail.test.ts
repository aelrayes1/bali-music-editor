/**
 * PRIMARY_HUMAN_COMPOSITION_GUARDRAIL (synthetic, deterministic): flags edge-pushed subjects, leaves
 * good framing alone, prefers static crops for small motion, produces smooth tracked proposals for
 * moving subjects, honours lead room, refuses to guess between comparable people, never outranks a
 * human override, and never touches timing, audio or shots.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPOSITION, type ClipGeometry, assessClip, deadband, movement } from "../../src/compose/guardrail.ts";
import type { FaceSample } from "../../src/render/crop-options.ts";
import { rational } from "../../src/time/rational.ts";

const N = 60;
const geo = (over: Partial<ClipGeometry> = {}): ClipGeometry => ({
  clipId: "clip:02",
  frames: N,
  sourceTimes: Array.from({ length: N }, (_, j) => j / 30),
  sourceTimesRational: Array.from({ length: N }, (_, j) => rational(j, 30)),
  cropW: 608,
  frameH: 1080,
  activeX: 240,
  activeW: 1440,
  cropX: Array(N).fill(570),
  nativeVertical: false,
  override: null,
  ...over,
});
type Face = FaceSample["faces"][number];
const face = (cx: number, h = 160, conf = 0.7, cy = 420): Face => ({ cx, cy, w: h * 0.9, h, conf });
const samples = (cx: (j: number) => number, extra: (j: number) => Face[] = () => []): FaceSample[] =>
  Array.from({ length: 16 }, (_, k) => Math.min(N - 1, k * 4)).filter((j, i, a) => a.indexOf(j) === i).map((j) => ({ j, sourceTime: rational(j, 30), faces: [face(cx(j)), ...extra(j)] }));
const centre = 570 + 304;

describe("primary human composition guardrail", () => {
  it("a single primary subject pushed to the edge triggers REFRAME_REVIEW_RECOMMENDED with one bounded proposal", () => {
    const a = assessClip(geo(), samples(() => centre + 250));
    assert.equal(a.state, "REFRAME_REVIEW_RECOMMENDED");
    assert.equal(a.subject.source, "TRACKED_PRIMARY");
    assert.ok(a.flags.some((f) => f.startsWith("START_OUTSIDE_SAFE_REGION")));
    assert.equal(a.proposals.length, 1);
    const p = a.proposals[0]!;
    assert.equal(p.mode, "static");
    assert.ok(Math.abs(p.positions.start - 0.5) < 0.05 && p.positions.outsideSafe === 0);
  });

  it("a well-centred person needs no correction; mild off-centre is not a failure", () => {
    assert.equal(assessClip(geo(), samples(() => centre)).state, "OK");
    const mild = assessClip(geo(), samples((j) => centre + (j < 30 ? 60 : -60)));
    assert.equal(mild.state, "OK");
    assert.equal(mild.proposals.length, 0);
  });

  it("an approved human crop always wins: reported, never re-proposed", () => {
    const a = assessClip(geo({ override: { id: "usr:reframe-clip02-crop-e", option: "CROP_E" } }), samples(() => centre + 280));
    assert.equal(a.state, "HUMAN_OVERRIDE");
    assert.equal(a.proposals.length, 0);
    assert.ok(a.metrics && a.metrics.start > 0.9, "metrics still measured for information");
  });

  it("a subject moving across the shot gets a smooth tracked proposal (bounded step and acceleration)", () => {
    const a = assessClip(geo(), samples((j) => 1150 - j * 5.5));
    assert.equal(a.state, "REFRAME_REVIEW_RECOMMENDED");
    const p = a.proposals[0]!;
    assert.equal(p.mode, "tracked");
    assert.ok(p.movement.maxStepPx <= COMPOSITION.maxStepPx && p.movement.maxAccelPx <= COMPOSITION.maxAccelPx, JSON.stringify(p.movement));
    assert.ok(p.positions.outsideSafe <= 0.1 && Math.abs(p.positions.mid - 0.5) < 0.1, JSON.stringify(p.positions));
    assert.ok(p.cropX.every((x) => x >= 240 && x + 608 <= 240 + 1440));
  });

  it("tiny movement never creates crop movement (dead band / static preference)", () => {
    const jitter = (j: number) => centre + 260 + (j % 8 < 4 ? 12 : -12);
    const p = assessClip(geo(), samples(jitter)).proposals[0]!;
    assert.equal(p.mode, "static");
    assert.equal(p.movement.travelPx, 0);
    const db = deadband(Array.from({ length: 40 }, (_, i) => 500 + (i % 2 ? 10 : -10)), 36);
    assert.ok(movement(db).travelPx < 1, "dead band absorbs jitter");
  });

  it("lead room: a subject moving left-to-right may stay left of centre (recorded, not corrected)", () => {
    const left = () => 570 + 0.3 * 608;
    assert.equal(assessClip(geo(), samples(left)).state, "REFRAME_REVIEW_RECOMMENDED", "without context it is flagged");
    const lead = assessClip(geo(), samples(left), { semantic: { presence: "single", centerPath: [], screenDirection: "left_to_right", motionLabels: ["walking"] } });
    assert.equal(lead.state, "INTENTIONAL_OFF_CENTRE");
    assert.match(lead.exception!, /lead room/);
    assert.equal(lead.proposals.length, 0);
    const wrongWay = assessClip(geo(), samples(left), { semantic: { presence: "single", centerPath: [], screenDirection: "right_to_left", motionLabels: [] } });
    assert.equal(wrongWay.state, "REFRAME_REVIEW_RECOMMENDED", "moving into the short side is not lead room");
    const brief = assessClip(geo(), samples(() => centre + 250), { intentionalOffCentre: "rule-of-thirds per creative brief" });
    assert.equal(brief.state, "INTENTIONAL_OFF_CENTRE");
  });

  it("two comparable people: PRIMARY_SUBJECT_UNCERTAIN with 2-3 bounded alternatives, never one aggressive reframe", () => {
    const a = assessClip(geo(), samples(() => 700, () => [face(1150, 155)]));
    assert.equal(a.state, "PRIMARY_SUBJECT_UNCERTAIN");
    assert.ok(a.proposals.length >= 2 && a.proposals.length <= 3);
    assert.ok(a.proposals.every((p) => p.label.startsWith("ALTERNATIVE_")));
  });

  it("the dominant (largest, persistent) face is the subject, not the most confident detection", () => {
    const a = assessClip(geo(), samples(() => centre + 250, () => [face(700, 90, 0.95, 110)]));
    assert.equal(a.subject.source, "TRACKED_PRIMARY");
    assert.ok(a.subject.track.every((p) => Math.abs(p.cx - (centre + 250)) < 5), "background face with higher confidence ignored");
  });

  it("an explicit project subject outranks automatic dominance", () => {
    const a = assessClip(geo(), samples(() => centre + 250, () => [face(700, 150)]), { projectSubject: { j: 0, x: 700, y: 420, note: "confirmed identity" } });
    assert.equal(a.subject.source, "PROJECT_SUBJECT");
    assert.ok(a.subject.track.every((p) => Math.abs(p.cx - 700) < 5));
  });

  it("native vertical sources and shots without a reliable human are left to the source composition", () => {
    assert.equal(assessClip(geo({ nativeVertical: true }), []).state, "NOT_APPLICABLE");
    assert.equal(assessClip(geo(), samples(() => centre).map((s) => ({ ...s, faces: [] }))).state, "NO_PRIMARY_HUMAN");
  });

  it("deterministic and side-effect free (inputs, including semantic hints, are not modified)", () => {
    const s = samples((j) => 1150 - j * 5.5);
    const hints = { semantic: { presence: "single", centerPath: [{ t: 0, x: 900 }], screenDirection: "none", motionLabels: [] } };
    const before = JSON.stringify([s, hints]);
    const a = JSON.stringify(assessClip(geo(), s, hints));
    assert.equal(a, JSON.stringify(assessClip(geo(), s, hints)));
    assert.equal(JSON.stringify([s, hints]), before);
  });
});
