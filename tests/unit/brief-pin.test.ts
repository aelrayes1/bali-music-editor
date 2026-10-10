import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MediaManifest } from "../../src/media/schema.ts";
import { parseSync, resolveEvents } from "../../src/music/overrides.ts";
import { rational } from "../../src/time/rational.ts";
import { ProjectBriefSchema, resolveBrief } from "../../src/project/brief.ts";
import { type VocalFeatureProvider, resolveHumanOccurrences } from "../../src/vocal/occurrences.ts";
import { event, fakeAnalysis } from "../helpers/vocal-fixtures.ts";

const drop = { ...event("drop", 10.53, 1), id: "drop:464373" };
const hit = event("vocal_attack", 4.53, 0.8);
const echo = event("vocal_attack", 4.88, 0.6);
const analysis = fakeAnalysis([drop, hit, echo]);
const features: VocalFeatureProvider = { similarity: (a, b) => (a.id === b.id ? 1 : 0.9), levelDb: () => 40 };
const occurrences = resolveHumanOccurrences({
  analysis, patternId: "usr:hook", label: "hook", exhaustive: true, referenceEventId: hit.id,
  windows: [{ occurrenceId: "usr:b1", start: rational(4), end: rational(5) }], features, targetWord: "hook",
});

const baseSync = {
  schemaVersion: "1.0.0",
  sourceMediaId: "m_00000000000000aa",
  requiredEvents: [
    { id: "usr:start", type: "start_boundary", time: "2.000s", label: "start" },
    { id: "usr:drop", type: "structural_boundary", time: "10.500s", label: "drop" },
    { id: "usr:end", type: "end_boundary", time: "12.000s", label: "end" },
  ],
  requiredPatterns: [{ id: "usr:hook", label: "hook", window: { start: "4.000s", end: "6.000s" }, matchEventTypes: ["vocal_attack"], requirement: "every_occurrence_mandatory" }],
  occurrenceGroundTruth: [{ patternId: "usr:hook", exhaustive: true, referenceEventId: hit.id, occurrences: [{ id: "usr:b1", window: { start: "4.000s", end: "5.000s" } }] }],
};
const pin = (extra: Record<string, unknown> = {}) => ({
  id: "usr:pin", targetEventId: "usr:drop", action: "pin", time: "10.530s", exactTime: { num: 1053, den: 100 },
  evidenceEventIds: [drop.id], approved: { by: "user", date: "2026-09-27" }, ...extra,
});
const sync = (overrides: unknown[] = [pin()]) => parseSync({ ...baseSync, eventOverrides: overrides });

describe("pin override (approved exact handoff)", () => {
  it("pins the exact time, keeps the raw user marker in the sync layer, and explains itself", () => {
    const s = sync();
    assert.equal(s.requiredEvents.find((e) => e.id === "usr:drop")!.time, "10.500s"); // raw marker untouched
    const r = resolveEvents(analysis, s, null, [occurrences]);
    const e = r.events.find((x) => x.id === "usr:drop")!;
    assert.deepEqual(e.time, rational(1053, 100));
    assert.deepEqual([e.origin, e.tier, e.mandatory, e.overrideIds], ["user", "USER_REQUIRED", true, ["usr:pin"]]);
    assert.match(e.resolutionReason!, /previous 10\.500000 s .*evidence at exactly this time: drop:464373/);
    assert.equal(r.warnings.length, 0);
  });

  it("never follows moved evidence: the pin holds and a warning is raised", () => {
    const moved = { ...drop, time: rational(1060, 100) };
    const r = resolveEvents(fakeAnalysis([moved, hit, echo]), sync(), null, [occurrences]);
    assert.deepEqual(r.events.find((x) => x.id === "usr:drop")!.time, rational(1053, 100));
    assert.ok(r.warnings.some((w) => w.code === "PIN_EVIDENCE_MOVED"));
  });

  it("rejects a pin whose readable time and exact time disagree, or that lacks approval", () => {
    assert.throws(() => sync([pin({ time: "10.540s" })]), /differs from 10\.540s/);
    assert.throws(() => sync([pin({ approved: undefined })]), /pin needs time, exactTime and approved/);
  });
});

describe("project brief (future planner constraints)", () => {
  const manifest = {
    media: [
      { mediaId: "m_archive1", source: { rootId: "archive" }, isPlayableVideoFootage: true, duplicateOf: null },
      { mediaId: "m_archive2", source: { rootId: "archive" }, isPlayableVideoFootage: true, duplicateOf: null },
      { mediaId: "m_cover", source: { rootId: "archive" }, isPlayableVideoFootage: false, duplicateOf: null },
      { mediaId: "m_payoff", source: { rootId: "phone" }, isPlayableVideoFootage: true, duplicateOf: null },
    ],
  } as unknown as MediaManifest;
  const brief = (patch: Record<string, unknown> = {}) =>
    ProjectBriefSchema.parse({
      schemaVersion: "1.0.0", projectId: "t", kind: "future-acceptance-test", status: "constraints only",
      audio: { mediaId: "m_00000000000000aa", startEventId: "usr:start", endEventId: "usr:end", approximate: true },
      visualSegments: [
        { id: "seg:a", description: "archive only", startEventId: "usr:start", endEventId: "usr:drop", expected: { start: "2.000s", end: "10.530s" }, sourcePool: { rootIds: ["archive"], exclusive: true } },
        { id: "seg:b", description: "payoff only", startEventId: "usr:drop", endEventId: "usr:end", expected: { start: "10.530s", end: "12.000s" }, sourcePool: { mediaIds: ["m_payoff"], exclusive: true } },
      ],
      hardHandoffs: [{ id: "handoff:a-b", kind: "hard_visual_switch", eventId: "usr:drop", expected: "10.530s", fromSegment: "seg:a", toSegment: "seg:b", mandatory: true }],
      syncTargets: [{ id: "sync:b", patternId: "usr:hook", occurrenceIds: ["usr:b1"], expected: ["4.530s"], mandatory: true, effectRepeats: { expected: ["4.880s"], mandatory: false, use: "fx" } }],
      ...patch,
    });

  it("resolves to unambiguous exact spans, pools, the hard handoff and sync targets", () => {
    const r = resolveBrief(brief(), resolveEvents(analysis, sync(), null, [occurrences]), manifest);
    assert.deepEqual(r.segments.map((s) => [s.id, s.start, s.end, s.mediaIds]), [
      ["seg:a", rational(2), rational(1053, 100), ["m_archive1", "m_archive2"]],
      ["seg:b", rational(1053, 100), rational(12), ["m_payoff"]],
    ]);
    assert.deepEqual(r.handoffs.map((h) => [h.id, h.time, h.overrideIds]), [["handoff:a-b", rational(1053, 100), ["usr:pin"]]]);
    assert.deepEqual(r.syncTargets[0]!.primaries.map((p) => p.eventId), [hit.id]);
    assert.deepEqual(r.syncTargets[0]!.effectRepeats.map((p) => p.eventId), [echo.id]);
  });

  it("fails loudly when the resolved view no longer matches the approved brief", () => {
    const unpinned = resolveEvents(analysis, sync([]), null, [occurrences]); // handoff back at 10.500
    assert.throws(() => resolveBrief(brief(), unpinned, manifest), /expected 10\.530s/);
    assert.throws(() => ProjectBriefSchema.parse({ ...brief(), kind: "edit" }));
  });
});
