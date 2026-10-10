import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSync, resolveEvents } from "../../src/music/overrides.ts";
import { ResolvedMusicEventsSchema } from "../../src/music/schema.ts";
import { rational } from "../../src/time/rational.ts";
import { type VocalFeatureProvider, VocalOccurrencesSchema, resolveHumanOccurrences } from "../../src/vocal/occurrences.ts";
import type { VocalTranscription } from "../../src/vocal/schema.ts";
import { event, fakeAnalysis } from "../helpers/vocal-fixtures.ts";

// 120 BPM fixture: bars every 2 s; the reference "hit-" sits at beat 2 + 30 ms of its bar (0.53 s in).
const A = {
  pickup: event("vocal_attack", 2.3, 0.6), // the pickup word, 230 ms before "hit-"
  hit: event("vocal_attack", 2.53, 0.6),
  echo1: event("vocal_attack", 2.88, 0.5),
  echo2: event("vocal_attack", 3.23, 0.4), // second tap, after the window end
  hit2: event("vocal_attack", 4.53, 0.6),
  tail: event("vocal_attack", 4.8, 0.5), // later "-tail" syllable
  hit3: event("vocal_attack", 6.53, 0.4),
  echo3: event("vocal_attack", 6.88, 0.5), // louder, near-equal re-triggered chop
  x1: event("vocal_attack", 8.2, 0.5),
  x2: event("vocal_attack", 8.7, 0.5),
  ref: event("vocal_attack", 10.53, 0.9),
};
A.ref.strength = 1.3;
const SIM_REF: Record<string, number> = {
  pickup: 0.6, hit: 0.85, echo1: 0.78, echo2: 0.75, hit2: 0.82, tail: 0.62, hit3: 0.76, echo3: 0.77, x1: 0.7, x2: 0.7, ref: 1,
};
const PAIR: Record<string, number> = { "hit|echo1": 0.85, "hit|echo2": 0.82, "echo1|echo2": 0.9, "hit3|echo3": 0.83, "hit2|tail": 0.6, "x1|x2": 0.5 };
const LEVEL: Record<string, number> = { hit: 45, echo1: 42, echo2: 39, hit3: 40, echo3: 42 };
const name = new Map(Object.entries(A).map(([k, e]) => [e.id, k]));
const FEATURES: VocalFeatureProvider = {
  similarity: (a, b) => {
    const [x, y] = [name.get(a.id)!, name.get(b.id)!];
    if (x === y) return 1;
    if (x === "ref") return SIM_REF[y]!;
    if (y === "ref") return SIM_REF[x]!;
    return PAIR[`${x}|${y}`] ?? PAIR[`${y}|${x}`] ?? 0.5;
  },
  levelDb: (e) => LEVEL[name.get(e.id)!] ?? 40,
};
const analysis = fakeAnalysis(Object.values(A));
const WINDOWS = [
  { occurrenceId: "usr:b1", start: rational(2), end: rational(3) },
  { occurrenceId: "usr:b2", start: rational(4), end: rational(5) },
  { occurrenceId: "usr:b3", start: rational(6), end: rational(7) },
  { occurrenceId: "usr:b4", start: rational(8), end: rational(9) },
  { occurrenceId: "usr:b5", start: rational(10), end: rational(11) },
];
const resolve = (transcriptions: VocalTranscription[] = []) =>
  resolveHumanOccurrences({
    analysis,
    patternId: "usr:hook",
    label: "hook",
    exhaustive: true,
    referenceEventId: A.ref.id,
    windows: WINDOWS,
    features: FEATURES,
    transcriptions,
    targetWord: "hook",
  });
const occ = (id: string, r = resolve()) => r.occurrences.find((o) => o.occurrenceId === id)!;
const SYNC = parseSync({
  schemaVersion: "1.0.0",
  sourceMediaId: "m_00000000000000aa",
  requiredPatterns: [{ id: "usr:hook", label: "hook", window: { start: "2.000s", end: "11.000s" }, matchEventTypes: ["vocal_attack"], requirement: "every_occurrence_mandatory" }],
  occurrenceGroundTruth: [
    {
      patternId: "usr:hook",
      exhaustive: true,
      referenceEventId: A.ref.id,
      occurrences: WINDOWS.map((w) => ({ id: w.occurrenceId, window: { start: `${w.start.num / w.start.den}.000s`, end: `${w.end.num / w.end.den}.000s` } })),
    },
  ],
});

describe("human ground-truth occurrences", () => {
  it("a primary with several delay echoes is ONE occurrence; echoes are auditable repeats", () => {
    const o = occ("usr:b1");
    assert.equal(o.status, "RESOLVED");
    assert.equal(o.primaryAttack?.eventId, A.hit.id);
    assert.deepEqual(o.effectRepeats.map((r) => r.eventId), [A.echo1.id, A.echo2.id]); // second tap outside the window kept
    assert.deepEqual(o.effectRepeats.map((r) => [r.delayMs, r.levelDbRelative, r.similarityToPrimary]), [[350, -3, 0.85], [700, -6, 0.82]]);
    assert.equal(o.effectCharacter, "DELAYED");
    assert.equal(o.candidatesConsidered.find((c) => c.eventId === A.echo1.id)?.role, "effect_repeat");
  });

  it("does not pick the preceding pickup word or the later tail syllable", () => {
    assert.equal(occ("usr:b1").candidatesConsidered.find((c) => c.eventId === A.pickup.id)?.role, "other");
    const o = occ("usr:b2");
    assert.equal(o.primaryAttack?.eventId, A.hit2.id);
    assert.equal(o.effectRepeats.length, 0, "a dissimilar later syllable is not an echo");
    assert.equal(o.effectCharacter, "LIGHT_REVERB");
  });

  it("prefers the primary over a near-equal (even louder) later repetition", () => {
    const o = occ("usr:b3");
    assert.equal(o.primaryAttack?.eventId, A.hit3.id);
    assert.deepEqual(o.effectRepeats.map((r) => r.eventId), [A.echo3.id]);
    assert.equal(o.effectRepeats[0]!.levelDbRelative, 2);
    assert.equal(o.effectCharacter, "REVERB_DELAY_CHOP");
    assert.equal(o.confidence, "MEDIUM");
    assert.match(o.reasoning, /grouped as its effect repeat/);
  });

  it("returns AMBIGUOUS with exactly two candidates instead of guessing", () => {
    const o = occ("usr:b4");
    assert.equal(o.status, "AMBIGUOUS");
    assert.equal(o.syncTarget, null);
    assert.deepEqual(o.ambiguousCandidates.map((c) => c.eventId), [A.x1.id, A.x2.id]);
  });

  it("keeps the confirmed reference stable and exact", () => {
    const o = occ("usr:b5");
    assert.deepEqual(o.syncTarget, A.ref.time);
    assert.equal(o.confidence, "HIGH");
    assert.equal(o.effectCharacter, "DRY");
  });

  it("measures (never assumes) the repeat delay; results are deterministic and schema-valid", () => {
    const r = resolve();
    assert.deepEqual(r.measuredRepeatDelayMs, { values: [350, 350], median: 350 });
    assert.equal(JSON.stringify(resolve()), JSON.stringify(r));
    assert.deepEqual(VocalOccurrencesSchema.parse(JSON.parse(JSON.stringify(r))), r);
  });

  it("human occurrences survive ASR failure, and Whisper evidence only adds", () => {
    const none = resolve([]);
    assert.equal(none.occurrences.filter((o) => o.status === "RESOLVED").length, 4);
    const heard = {
      model: { name: "base.en" },
      words: [{ id: "asr:00:000", rawText: " hook", normalized: "hook", start: rational(251, 100), flags: [] }],
    } as unknown as VocalTranscription;
    const withAsr = resolve([heard]);
    assert.deepEqual(occ("usr:b1", withAsr).whisperEvidence.map((x) => [x.model, x.target, x.deltaToPrimaryMs]), [["base.en", true, -20]]);
    assert.equal(occ("usr:b1", withAsr).primaryAttack?.eventId, A.hit.id);
  });
});

describe("ground truth in the resolved view", () => {
  const vetoingAssist = {
    sourceMediaId: "m_00000000000000aa",
    phase2: { analyzerVersion: "1.0.0", configHash: "0123456789abcdef" },
    patternId: "usr:hook",
    schemaVersion: "1.0.0",
    cacheKey: "k",
    model: { name: "base.en", sha256: "b".repeat(64) },
    words: [],
    occurrences: [],
    candidateAssessments: [
      { eventId: A.hit2.id, time: A.hit2.time, phase2Status: null, state: "REJECTED", occurrenceId: null, overlappingWords: [], reason: 'ASR hears a different word' },
    ],
  } as unknown as VocalTranscription;

  it("exactly the human occurrences are mandatory; echoes and other attacks are listed but not words", () => {
    const r = resolveEvents(analysis, SYNC, null, [resolve()]);
    assert.equal(r.schemaVersion, "1.2.0");
    assert.doesNotThrow(() => ResolvedMusicEventsSchema.parse(r));
    const mandatory = r.events.filter((e) => e.patternId === "usr:hook" && e.mandatory).map((e) => e.id);
    assert.deepEqual(mandatory.sort(), [A.hit.id, A.hit2.id, A.hit3.id, A.x1.id, A.x2.id, A.ref.id].sort()); // 4 primaries + 1 ambiguous pair
    const echo = r.events.find((e) => e.id === A.echo1.id)!;
    assert.deepEqual([echo.mandatory, echo.identityStatus, echo.occurrence?.role, echo.occurrence?.occurrenceId], [false, "REJECTED", "effect_repeat", "usr:b1"]);
    assert.match(echo.resolutionReason!, /effect repeat in usr:b1 of .*\(\+350 ms, -3 dB\): not a separate word/);
    const p = r.events.find((e) => e.id === A.hit.id)!;
    assert.deepEqual([p.identityStatus, p.tier, p.occurrence?.syncTarget, p.occurrence?.timingConfidence], ["CONFIRMED", "USER_REQUIRED", true, "HIGH"]);
    assert.deepEqual(r.groundTruth, [{ patternId: "usr:hook", exhaustive: true, occurrences: 5, resolved: 4, ambiguous: 1 }]);
    assert.equal(r.events.find((e) => e.id === A.pickup.id)!.identityStatus, "REJECTED");
  });

  it("Whisper cannot veto a human-confirmed occurrence", () => {
    const r = resolveEvents(analysis, SYNC, vetoingAssist, [resolve()]);
    const e = r.events.find((x) => x.id === A.hit2.id)!;
    assert.deepEqual([e.identityStatus, e.mandatory], ["CONFIRMED", true]);
    assert.match(e.resolutionReason!, /vocal assist REJECTED.*human ground truth usr:b2: primary attack/);
  });

  it("user overrides still win and can address an occurrence by its id", () => {
    const sync = parseSync({ ...SYNC, eventOverrides: [{ id: "usr:fix", targetEventId: "usr:b3", action: "retime", time: "6.550s" }] });
    const r = resolveEvents(analysis, sync, null, [resolve()]);
    const e = r.events.find((x) => x.id === A.hit3.id)!;
    assert.deepEqual(e.time, rational(131, 20));
    assert.deepEqual(e.overrideIds, ["usr:fix"]);
    assert.match(e.resolutionReason!, /user override usr:fix retime/);
  });

  it("without ground truth the view is unchanged", () => {
    const noGt = parseSync({ ...SYNC, occurrenceGroundTruth: undefined });
    assert.equal(JSON.stringify(resolveEvents(analysis, noGt, null, [resolve()])), JSON.stringify(resolveEvents(analysis, noGt)));
    assert.equal(resolveEvents(analysis, noGt).schemaVersion, "1.0.0");
  });
});

describe("human approval of primary sync points", () => {
  const withApproval = (approval: Record<string, unknown>, id = "usr:b2") =>
    parseSync({
      ...SYNC,
      occurrenceGroundTruth: [
        {
          ...SYNC.occurrenceGroundTruth![0]!,
          occurrences: SYNC.occurrenceGroundTruth![0]!.occurrences.map((o) =>
            o.id === id ? { ...o, approval: { approvedBy: "user", date: "2026-09-27", method: "listening", effectRepeatEventIds: [], ...approval } } : o,
          ),
        },
      ],
    });

  it("an approval pins the primary and is recorded on the event", () => {
    const r = resolveEvents(analysis, withApproval({ primaryEventId: A.hit2.id, time: "4.530s" }), null, [resolve()]);
    const e = r.events.find((x) => x.id === A.hit2.id)!;
    assert.deepEqual([e.identityStatus, e.mandatory, e.occurrence?.humanApproved], ["CONFIRMED", true, true]);
    assert.match(e.resolutionReason!, /APPROVED by user 2026-09-27/);
    assert.equal(r.warnings.filter((w) => w.code.startsWith("GROUND_TRUTH_")).length, 0);
  });

  it("a human approval overrides a different signal choice (with a warning)", () => {
    const r = resolveEvents(analysis, withApproval({ primaryEventId: A.tail.id, time: "4.800s" }), null, [resolve()]);
    assert.equal(r.events.find((x) => x.id === A.tail.id)!.occurrence?.role, "primary");
    assert.equal(r.events.find((x) => x.id === A.hit2.id)!.mandatory, false);
    assert.ok(r.warnings.some((w) => w.code === "GROUND_TRUTH_APPROVAL_DIFFERS"));
  });

  it("acknowledged repeats are checked against detection", () => {
    const r = resolveEvents(analysis, withApproval({ primaryEventId: A.hit.id, time: "2.530s", effectRepeatEventIds: [A.echo1.id] }, "usr:b1"), null, [resolve()]);
    assert.ok(r.warnings.some((w) => w.code === "GROUND_TRUTH_REPEATS_DIFFER")); // echo2 was also detected
    assert.equal(r.events.find((x) => x.id === A.echo1.id)!.occurrence?.humanApproved, true);
  });

  it("rejects an approval whose time does not match its event or lies outside its window", () => {
    assert.throws(() => resolveEvents(analysis, withApproval({ primaryEventId: A.hit2.id, time: "4.540s" }), null, [resolve()]), /ms from/);
    assert.throws(() => withApproval({ primaryEventId: A.hit2.id, time: "5.100s" }), /outside its window/);
  });
});
