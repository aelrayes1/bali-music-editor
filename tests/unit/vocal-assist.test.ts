import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSync, resolveEvents } from "../../src/music/overrides.ts";
import { ResolvedMusicEventsSchema } from "../../src/music/schema.ts";
import { compare, rational } from "../../src/time/rational.ts";
import {
  DEFAULT_ASSIST_CONFIG,
  applyWordOverrides,
  buildVocalTranscription,
  deterministicVocalView,
  flagWindowWords,
  matchTarget,
  normalizeWord,
  refineSyncTime,
} from "../../src/vocal/assist.ts";
import { VocalTranscriptionSchema } from "../../src/vocal/schema.ts";
import { WhisperUnavailableError, asrCacheKey, parseWhisperJson, planWindows, resolveWhisper } from "../../src/vocal/whisper.ts";
import { FAKE_ENGINE, type W, event, fakeAnalysis, fakeRaw } from "../helpers/vocal-fixtures.ts";

const EVENTS = [
  event("vocal_attack", 5.02, 0.7), // "hit" (heard in 2 windows)
  event("vocal_attack", 5.95, 0.5), // 200 ms before the hook hearings: outside the refinement window
  event("vocal_attack", 6.05, 0.8), // "hook" sync point
  event("vocal_attack", 6.28, 0.6), // weaker attack inside the refinement window / later syllable
  event("vocal_attack", 6.4, 0.6), // later syllable
  event("vocal_attack", 9.3, 0.9), // 300 ms after a single-window "hook": out of reach
  event("vocal_attack", 10.5, 0.6), // nothing intelligible heard
  event("onset", 11.0, 0.5),
];
const DOCS: Record<string, W[]> = {
  "win:01": [[" Hit", 3000, 3500, 0.9]],
  "win:02": [[" Hit", 1000, 1500, 0.9], [" hook,", 2100, 2600, 0.8]],
  "win:03": [[" hook", 200, 700, 0.7], [" hook", 3000, 3500, 0.9]],
  "win:04": [[" ♪", 0, 100, 0.5], [" (upbeat", 1000, 1200, 0.9], [" music)", 1200, 1500, 0.9]],
  "win:05": [2200, 2300, 2400, 2500, 2600].map((t) => [" more", t, t + 100, 0.9] as W),
  "win:06": [1000, 1100, 1200, 1300].map((t) => [" hook", t, t + 100, 0.9] as W),
};
const SYNC = {
  schemaVersion: "1.0.0",
  sourceMediaId: "m_00000000000000aa",
  requiredPatterns: [
    { id: "usr:hook", label: "hook", window: { start: "4.000s", end: "12.000s" }, matchEventTypes: ["vocal_attack"], requirement: "every_occurrence_mandatory" },
  ],
};
const RANGE = { start: rational(0), end: rational(16) };
const PATTERN = { patternId: "usr:hook", start: rational(4), end: rational(12), matchEventTypes: ["vocal_attack"] };

function build(docs = DOCS, events = EVENTS, generatedAt = "2026-01-01T00:00:00.000Z") {
  const analysis = fakeAnalysis(events);
  const windows = planWindows(analysis, RANGE.start, RANGE.end, DEFAULT_ASSIST_CONFIG);
  const vt = buildVocalTranscription({
    raw: fakeRaw(windows, docs),
    analysis,
    range: RANGE,
    pattern: PATTERN,
    engine: FAKE_ENGINE,
    config: DEFAULT_ASSIST_CONFIG,
    generatedAt,
  });
  return { analysis, vt };
}
const sync = (overrides: unknown[] = []) => parseSync({ ...SYNC, eventOverrides: overrides });
const cand = (vt: ReturnType<typeof build>["vt"], id: string) => vt.candidateAssessments.find((a) => a.eventId === id)!;

describe("vocal assist: text and flags", () => {
  it("normalizes and matches target words conservatively", () => {
    assert.equal(normalizeWord(" Jumpin',"), "jumpin");
    assert.equal(normalizeWord(" I'm"), "im");
    assert.equal(matchTarget("jumping", "jumping"), "EXACT");
    assert.equal(matchTarget("jumpin", "jumping"), "EXACT");
    assert.equal(matchTarget("jump", "jumping"), "NEAR");
    assert.equal(matchTarget("pumping", "jumping"), "NEAR");
    assert.equal(matchTarget("switch", "jumping"), null);
    assert.equal(matchTarget("", "hook"), null);
  });

  it("flags non-speech tags, repetition loops, compressed timestamps and window edges", () => {
    const win = planWindows(fakeAnalysis([]), rational(0), rational(16), DEFAULT_ASSIST_CONFIG)[0]!; // 0-4 s
    const words = parseWhisperJson(
      {
        transcription: [
          { text: " (upbeat", offsets: { from: 0, to: 100 }, tokens: [] },
          { text: " music)", offsets: { from: 100, to: 200 }, tokens: [] },
          { text: " go", offsets: { from: 300, to: 400 }, tokens: [] },
          ...[500, 600, 700, 800].map((f) => ({ text: " more,", offsets: { from: f, to: f + 50 }, tokens: [] })),
          ...[" a", " b", " c"].map((text) => ({ text, offsets: { from: 3000, to: 3000 }, tokens: [] })),
          { text: " end", offsets: { from: 3950, to: 4000 }, tokens: [] },
        ],
      },
      win,
    );
    const f = flagWindowWords(words, win.end);
    assert.deepEqual(f.slice(0, 3), [["NON_SPEECH"], ["NON_SPEECH"], []]);
    assert.deepEqual(f.slice(3, 7), [["REPETITION_LOOP"], ["REPETITION_LOOP"], ["REPETITION_LOOP"], ["REPETITION_LOOP"]]);
    assert.deepEqual(f.slice(7, 10), [["TIMESTAMP_COMPRESSED"], ["TIMESTAMP_COMPRESSED"], ["TIMESTAMP_COMPRESSED"]]);
    assert.deepEqual(f[10], ["WINDOW_EDGE"]);
  });
});

describe("vocal assist: timing", () => {
  it("serializes exact rational times (window start + whisper offset) that survive JSON", () => {
    const { vt } = build();
    const w = vt.words.find((x) => x.id === "asr:02:001")!;
    assert.deepEqual(w.start, rational(61, 10)); // 4 s + 2100 ms
    assert.deepEqual(w.end, rational(33, 5));
    assert.deepEqual(vt.windows[2]!.start, rational(4));
    assert.equal(vt.windows[2]!.startSample16k, 64000);
    assert.deepEqual(VocalTranscriptionSchema.parse(JSON.parse(JSON.stringify(vt))), vt);
  });

  it("refinement is bounded to ±150 ms (inclusive) and prefers the most confident vocal attack", () => {
    const raw = rational(10);
    const at = (t: number, c: number, type: "vocal_attack" | "onset" = "vocal_attack") => event(type, t, c);
    assert.equal(refineSyncTime(raw, [at(10.151, 0.99), at(10.149, 0.3)], 150).event?.time.num, 10149);
    assert.equal(refineSyncTime(raw, [at(9.85, 0.4)], 150).event?.time.num, 197); // 9.85 = 197/20
    assert.equal(refineSyncTime(raw, [at(10.1, 0.5), at(9.95, 0.5)], 150).event?.time.num, 199); // tie -> nearest (9.95)
    assert.equal(refineSyncTime(raw, [at(10.1, 0.5), at(10.05, 0.9)], 150).event?.time.num, 201); // 10.05
    const onset = refineSyncTime(raw, [at(10.2, 0.9), at(10.05, 0.4, "onset")], 150);
    assert.equal(onset.method, "phase2_onset");
    const none = refineSyncTime(raw, [at(10.2, 0.9), at(9.7, 0.9, "onset")], 150);
    assert.deepEqual(none, { event: null, method: "none" });
  });

  it("keeps the raw Whisper time and never refines outside the window", () => {
    const { vt } = build();
    const a = vt.occurrences.find((o) => o.id === "occ:hook:00615")!;
    assert.deepEqual(a.rawWhisperStart, rational(123, 20)); // mean(6.10, 6.20), exact
    assert.deepEqual(a.refinedSyncTime, rational(121, 20)); // the 6.05 attack, not 5.95 (200 ms) or 6.28 (weaker)
    assert.equal(a.refinementDeltaMs, -100);
    assert.equal(a.refinementMethod, "phase2_vocal_attack");
    assert.equal(a.state, "CONFIRMED_BY_SIGNAL");
    assert.equal(a.consensusWindows, 2);
    assert.deepEqual(a.beat, { beatId: "beat:0012", barIndex: 3, beatInBar: 1, offsetMs: 50 });
    const b = vt.occurrences.find((o) => o.id === "occ:hook:00900")!;
    assert.deepEqual(b.rawWhisperStart, rational(9));
    assert.equal(b.refinedSyncTime, null);
    assert.equal(b.refinementMethod, "none");
    assert.equal(b.nearestPhase2Candidate?.deltaMs, 300);
    assert.equal(b.state, "NEEDS_HUMAN_CONFIRMATION");
  });
});

describe("vocal assist: identity", () => {
  it("grades every Phase 2 candidate against the ASR evidence", () => {
    const { vt } = build();
    assert.equal(vt.candidateAssessments.length, 7);
    assert.equal(cand(vt, "vocal:221382").state, "REJECTED"); // 5.02 "hit" in 2 windows
    assert.match(cand(vt, "vocal:221382").reason, /"hit" starting here in 2 windows/);
    assert.equal(cand(vt, "vocal:262395").state, "NEEDS_HUMAN_CONFIRMATION"); // 5.95: near, not refined
    assert.equal(cand(vt, "vocal:266805").state, "CONFIRMED_BY_SIGNAL"); // 6.05
    assert.equal(cand(vt, "vocal:276948").state, "REJECTED"); // 6.28: later attack in the word
    assert.equal(cand(vt, "vocal:282240").state, "REJECTED"); // 6.40
    assert.equal(cand(vt, "vocal:410130").state, "NEEDS_HUMAN_CONFIRMATION"); // 9.30
    assert.match(cand(vt, "vocal:463050").reason, /no intelligible lyric/); // 10.5
  });

  it("repetition loops are flagged and never become evidence", () => {
    const { vt } = build();
    const loop = vt.words.filter((w) => w.windowId === "win:05");
    assert.ok(loop.every((w) => w.flags.includes("REPETITION_LOOP") && w.state === "REJECTED"));
    const looped = vt.occurrences.filter((o) => o.hearingWordIds.every((id) => id.startsWith("asr:06:")));
    assert.ok(looped.length >= 1);
    assert.ok(looped.every((o) => o.state === "REJECTED"));
    assert.ok(vt.warnings.some((w) => w.code === "ASR_ARTIFACTS_FLAGGED"));
  });

  it("an uncertain single hearing is never promoted", () => {
    const docs = { "win:02": [[" hook", 2100, 2600, 0.4]] as W[] };
    const { vt } = build(docs);
    assert.equal(vt.occurrences[0]!.state, "NEEDS_HUMAN_CONFIRMATION");
    assert.equal(vt.words[0]!.state, "UNCONFIRMED");
  });

  it("an empty transcript yields no occurrences and leaves every candidate for a human", () => {
    const { vt } = build({});
    assert.equal(vt.words.length, 0);
    assert.equal(vt.occurrences.length, 0);
    assert.ok(vt.warnings.some((w) => w.code === "EMPTY_TRANSCRIPT"));
    assert.ok(vt.candidateAssessments.every((a) => a.state === "NEEDS_HUMAN_CONFIRMATION"));
  });

  it("malformed whisper output is rejected loudly", () => {
    const w = planWindows(fakeAnalysis([]), rational(0), rational(16), DEFAULT_ASSIST_CONFIG)[0]!;
    assert.throws(() => parseWhisperJson({}, w), /malformed/);
    assert.throws(() => parseWhisperJson({ transcription: [{ text: " x", offsets: { from: 500, to: 100 } }] }, w), /malformed offsets/);
    assert.deepEqual(parseWhisperJson({ transcription: [{ text: "  ", offsets: { from: 0, to: 0 } }] }, w), []);
  });

  it("IDs are stable and a rebuild is deterministic", () => {
    const one = build(DOCS, EVENTS, "2026-01-01T00:00:00.000Z").vt;
    const two = build(DOCS, EVENTS, "2027-06-01T00:00:00.000Z").vt;
    assert.equal(deterministicVocalView(one), deterministicVocalView(two));
    assert.deepEqual(one.occurrences.map((o) => o.id).slice(0, 2), ["occ:hook:00615", "occ:hook:00900"]);
    assert.ok(one.words.every((w) => /^asr:\d{2}:\d{3}$/.test(w.id)));
    assert.equal(new Set(one.words.map((w) => w.id)).size, one.words.length);
  });
});

describe("vocal assist: resolution and overrides", () => {
  it("applies the assist: grades, demotes and adds, without moving any signal time", () => {
    const { analysis, vt } = build();
    const r = resolveEvents(analysis, sync(), vt);
    assert.equal(r.schemaVersion, "1.1.0");
    assert.equal(r.vocalAssist?.model, "base.en");
    const byId = new Map(r.events.map((e) => [e.id, e]));
    const hit = byId.get("vocal:221382")!;
    assert.deepEqual([hit.identityStatus, hit.tier, hit.mandatory, hit.patternId], ["REJECTED", "DETAIL", false, "usr:hook"]);
    const b = byId.get("vocal:266805")!;
    assert.equal(b.identityStatus, "CONFIRMED_BY_SIGNAL");
    assert.deepEqual(b.time, rational(121, 20));
    assert.deepEqual(b.vocalAssist?.rawWhisperStart, rational(123, 20));
    assert.deepEqual(b.vocalAssist?.phase2Time, rational(121, 20));
    assert.equal(b.vocalAssist?.phase2Status, "NEEDS_HUMAN_CONFIRMATION");
    const vox = byId.get("vox:hook:00900")!;
    assert.deepEqual([vox.identityStatus, vox.mandatory, vox.tier], ["NEEDS_HUMAN_CONFIRMATION", true, "USER_REQUIRED"]);
    assert.deepEqual(vox.time, rational(9));
    assert.match(vox.evidence!, /unrefined/);
    assert.doesNotThrow(() => ResolvedMusicEventsSchema.parse(r));
  });

  it("user overrides stay authoritative over the assist", () => {
    const { analysis, vt } = build();
    const r = resolveEvents(
      analysis,
      sync([
        { id: "usr:is-hook", targetEventId: "vocal:221382", action: "confirm" },
        { id: "usr:move", targetEventId: "occ:hook:00615", action: "retime", time: "6.100s" },
        { id: "usr:not-it", targetEventId: "occ:hook:00900", action: "exclude" },
      ]),
      vt,
    );
    const byId = new Map(r.events.map((e) => [e.id, e]));
    const hit = byId.get("vocal:221382")!;
    assert.deepEqual([hit.identityStatus, hit.tier, hit.mandatory], ["CONFIRMED", "USER_REQUIRED", true]);
    assert.match(hit.resolutionReason!, /REJECTED.*user override usr:is-hook confirm \(authoritative\)/);
    const moved = byId.get("vocal:266805")!;
    assert.deepEqual(moved.time, rational(61, 10));
    assert.equal(moved.origin, "user");
    assert.deepEqual(moved.vocalAssist?.rawWhisperStart, rational(123, 20)); // raw kept
    assert.deepEqual(moved.vocalAssist?.refinedSyncTime, rational(121, 20)); // refined kept
    assert.ok(!byId.has("vox:hook:00900"));
    assert.deepEqual(r.excluded.map((x) => x.overrideId), ["usr:not-it"]);
    assert.equal(r.warnings.filter((w) => w.code === "OVERRIDE_TARGET_MISSING").length, 0);
  });

  it("word-level human decisions mark ASR words HUMAN_CONFIRMED / REJECTED", () => {
    const { analysis, vt } = build();
    const s = sync([
      { id: "usr:w1", targetEventId: "asr:03:001", action: "confirm" },
      { id: "usr:w2", targetEventId: "asr:02:000", action: "exclude" },
    ]);
    const v2 = applyWordOverrides(vt, s);
    assert.equal(v2.words.find((w) => w.id === "asr:03:001")!.state, "HUMAN_CONFIRMED");
    assert.equal(v2.words.find((w) => w.id === "asr:02:000")!.state, "REJECTED");
    assert.equal(vt.words.find((w) => w.id === "asr:03:001")!.state, "UNCONFIRMED"); // input untouched
    assert.equal(resolveEvents(analysis, s, v2).warnings.filter((w) => w.code === "OVERRIDE_TARGET_MISSING").length, 0);
  });

  it("without the assist (disabled, absent or stale) the Phase 2 view is unchanged", () => {
    const { analysis, vt } = build();
    const phase2 = resolveEvents(analysis, sync());
    assert.equal(phase2.schemaVersion, "1.0.0");
    assert.ok(phase2.events.every((e) => !("vocalAssist" in e) && !("resolutionReason" in e)));
    assert.ok(!("vocalAssist" in phase2));
    assert.equal(JSON.stringify(resolveEvents(analysis, sync(), null)), JSON.stringify(phase2));
    const stale = resolveEvents(analysis, sync(), { ...vt, phase2: { ...vt.phase2, configHash: "ffffffffffffffff" } });
    assert.ok(stale.warnings.some((w) => w.code === "VOCAL_ASSIST_STALE"));
    assert.equal(JSON.stringify(stale.events), JSON.stringify(phase2.events));
    assert.throws(() => resolveEvents(analysis, sync(), { ...vt, sourceMediaId: "m_ffffffffffffffff" }), /vocal transcription is for/);
  });
});

describe("vocal assist: engine and cache", () => {
  it("is local-only: remote model/binary paths and missing tools disable it cleanly", async () => {
    await assert.rejects(resolveWhisper({ BALI_WHISPER_MODEL: "https://huggingface.co/x/ggml-base.en.bin" }), (e: unknown) => e instanceof WhisperUnavailableError && /remote path refused/.test((e as Error).message));
    await assert.rejects(resolveWhisper({ BALI_WHISPER_CLI: "/nonexistent/whisper-cli" }), WhisperUnavailableError);
  });

  it("cache identity covers fingerprint, range, windows, model, engine and Phase 2", () => {
    const analysis = fakeAnalysis(EVENTS);
    const cfg = { windowBars: 2, stepBars: 1 };
    const windows = planWindows(analysis, RANGE.start, RANGE.end, cfg);
    const key = (o: Partial<{ fp: string; range: typeof RANGE; cfg: typeof cfg; engine: typeof FAKE_ENGINE; hash: string }> = {}) =>
      asrCacheKey(
        o.fp ?? "a".repeat(64),
        o.range ?? RANGE,
        planWindows(analysis, (o.range ?? RANGE).start, (o.range ?? RANGE).end, o.cfg ?? cfg),
        o.cfg ?? cfg,
        o.engine ?? FAKE_ENGINE,
        { analyzer: { ...analysis.analyzer, configHash: o.hash ?? analysis.analyzer.configHash } },
      );
    const base = key();
    assert.equal(base, asrCacheKey("a".repeat(64), RANGE, windows, cfg, FAKE_ENGINE, analysis));
    assert.match(base, /^[0-9a-f]{20}$/);
    const variants = [
      key({ fp: "c".repeat(64) }),
      key({ range: { start: rational(2), end: rational(16) } }),
      key({ cfg: { windowBars: 3, stepBars: 1 } }),
      key({ engine: { ...FAKE_ENGINE, modelSha256: "d".repeat(64) } }),
      key({ engine: { ...FAKE_ENGINE, version: "1.9.5" } }),
      key({ hash: "fedcba9876543210" }),
    ];
    for (const v of variants) assert.notEqual(v, base);
    assert.equal(new Set(variants).size, variants.length);
  });

  it("windows are bar-aligned and clipped to the range", () => {
    const w = planWindows(fakeAnalysis([]), rational(3), rational(11), { windowBars: 2, stepBars: 1 });
    assert.deepEqual(w.map((x) => x.anchoredToBarId), ["bar:002", "bar:003", "bar:004", "bar:005"]);
    assert.deepEqual(w.map((x) => [x.start, x.end]), [
      [rational(4), rational(8)],
      [rational(6), rational(10)],
      [rational(8), rational(11)],
      [rational(10), rational(11)], // 1 s: the shortest window kept
    ]);
    assert.equal(planWindows(fakeAnalysis([]), rational(3), rational(21, 2), { windowBars: 2, stepBars: 1 }).length, 3); // 0.5 s tail dropped
    assert.deepEqual(
      planWindows(fakeAnalysis([]), rational(0), rational(16), { windowBars: 2, stepBars: 2 }).map((x) => x.anchoredToBarId),
      ["bar:000", "bar:002", "bar:004", "bar:006"],
    );
    assert.ok(w.every((x) => compare(x.end, rational(11)) <= 0));
  });
});
