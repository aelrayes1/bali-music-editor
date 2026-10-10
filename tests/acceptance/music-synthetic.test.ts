/**
 * Music Intelligence against synthetic oracles: every expected time is known exactly.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveMediaTools, type MediaTools } from "../../src/media/ffmpeg.ts";
import { ingestFile } from "../../src/media/manifest.ts";
import { DEFAULT_CONFIG, analyzeMusic, analyzeSamples, deterministicMusicView, type MusicAnalysisConfig } from "../../src/music/analyze.ts";
import { MusicInputError } from "../../src/music/features.ts";
import { parseSync, resolveEvents } from "../../src/music/overrides.ts";
import { type MusicAnalysis, MusicAnalysisSchema } from "../../src/music/schema.ts";
import { add, compare, mul, rational, toNumberApprox } from "../../src/time/rational.ts";
import { Lcg, SR, Track, beatSample, groove, writeWav16 } from "../helpers/audio-fixtures.ts";
import { generateFixtures } from "../helpers/fixtures.ts";

const SOURCE = { mediaId: "m_0000000000000000", fingerprint: "0".repeat(64), audioStreamIndex: 0, fileName: "fixture.wav" };
const META = { ffmpeg: { path: "(none)", version: "(none)" }, now: () => "2026-01-01T00:00:00.000Z" };
const run = (samples: Float32Array, config: MusicAnalysisConfig = DEFAULT_CONFIG) => analyzeSamples(samples, SOURCE, config, META);

/** Max |grid - oracle| in ms over the first and last 10 oracle beats. */
function gridError(a: MusicAnalysis, oracle: number[]): { first: number; last: number; max: number } {
  const t = (s: number) => s / SR;
  const errs = oracle.map((s) => {
    let best = Infinity;
    for (const b of a.beats) best = Math.min(best, Math.abs(toNumberApprox(b.time) - t(s)));
    return best * 1000;
  });
  return { first: Math.max(...errs.slice(0, 10)), last: Math.max(...errs.slice(-10)), max: Math.max(...errs) };
}

describe("tempo and beat grid (exact oracles)", () => {
  const cases = [
    { name: "120 BPM", num: 120, den: 1, secs: 60, first: 22050, expect: "120/1" },
    { name: "124 BPM over 3 minutes", num: 124, den: 1, secs: 180, first: 11025, expect: "124/1" },
    { name: "127.5 BPM (half-BPM rational)", num: 255, den: 2, secs: 90, first: 5000, expect: "255/2" },
  ];
  for (const c of cases) {
    it(`${c.name}: exact canonical tempo, no drift`, () => {
      const { track, beats } = groove(c.secs, c.num, c.den, c.first);
      const a = run(track.samples);
      assert.equal(`${a.tempo.canonicalBpm.num}/${a.tempo.canonicalBpm.den}`, c.expect);
      assert.equal(a.tempo.snapped, true);
      const e = gridError(a, beats);
      assert.ok(e.max < 1, `max error ${e.max.toFixed(3)} ms`);
      assert.ok(Math.abs(e.last - e.first) < 0.25, `drift ${e.first.toFixed(3)} -> ${e.last.toFixed(3)} ms`);
      assert.ok(a.tempo.bpmConfidence > 0.9, `confidence ${a.tempo.bpmConfidence}`);
      assert.equal(a.tempo.constantTempo.isConstant, true);
    });
  }

  it("non-round tempo (123.37 BPM) is kept as a precise rational, not snapped, and does not drift", () => {
    const { track, beats } = groove(180, 12337, 100, 7000);
    const a = run(track.samples);
    assert.equal(a.tempo.snapped, false);
    assert.ok(Math.abs(toNumberApprox(a.tempo.canonicalBpm) - 123.37) < 0.001);
    const e = gridError(a, beats);
    assert.ok(e.max < 1, `max error ${e.max.toFixed(3)} ms`);
  });

  it("beat times are exactly anchor + i * period and survive JSON round-trips", () => {
    const { track } = groove(30, 124, 1, 3000);
    const a = run(track.samples);
    for (const b of a.beats) {
      assert.equal(compare(b.time, add(a.tempo.gridAnchorSeconds, mul(rational(b.index), a.tempo.beatPeriodSeconds))), 0);
    }
    assert.deepEqual(MusicAnalysisSchema.parse(JSON.parse(JSON.stringify(a))), a);
    assert.deepEqual(a.tempo.beatPeriodSeconds, rational(15, 31)); // 60/124 exactly
  });
});

describe("meter", () => {
  it("finds accented downbeats at phase 1 and indexes bars from there", () => {
    const track = new Track(60);
    for (let i = 0; ; i++) {
      const s = beatSample(i, 124, 1, 10000);
      if (s >= track.samples.length - SR) break;
      const downbeat = i % 4 === 1;
      track.kick(s, downbeat ? 0.9 : 0.45);
      if (downbeat) track.crash(s, 0.3);
      track.hat(s + Math.round((30 * SR) / 124));
    }
    const a = run(track.samples);
    assert.equal(a.meter.downbeatPhase, 1);
    assert.equal(a.beats[1]!.isDownbeat, true);
    assert.equal(a.beats[1]!.barIndex, 0);
    assert.equal(a.beats[0]!.barIndex, -1); // pickup
    assert.equal(a.beats[5]!.beatInBar, 1);
    assert.equal(a.bars[0]!.startBeatId, "beat:0001");
  });
});

describe("structure", () => {
  it("break -> build -> drop at the exact beat", () => {
    const bpm = 124;
    const track = new Track(52);
    const beatAt = (i: number) => beatSample(i, bpm, 1, 20000);
    for (let i = 0; i < 96; i++) {
      const s = beatAt(i);
      const inBreak = i >= 32 && i < 48;
      if (!inBreak) track.kick(s, i >= 48 ? 0.9 : 0.55);
      track.hat(s + Math.round((30 * SR) / bpm), inBreak ? 0.05 : 0.12);
      if (i >= 48) track.duckedBass(s, 0.46, 55, 0.2); // house-style sidechained bass under a dominant kick
    }
    track.riser(beatAt(32), (beatAt(48) - beatAt(32)) / SR, 0.35);
    const a = run(track.samples);
    const brk = a.regions.find((r) => r.type === "break");
    assert.ok(brk, "break found");
    assert.ok(Math.abs(brk!.startSample - beatAt(32)) < 0.03 * SR, "break starts at beat 32");
    const drop = a.events.find((e) => e.type === "drop");
    assert.ok(drop, "drop found");
    assert.ok(Math.abs(drop!.sample - beatAt(48)) < 0.03 * SR, `drop at beat 48 (got ${drop!.sample} vs ${beatAt(48)})`);
    assert.equal(drop!.nearestBeatId, a.beats.find((b) => Math.abs(b.sample - beatAt(48)) < 0.03 * SR)!.id);
    const build = a.regions.find((r) => r.type === "build");
    assert.ok(build, "build found");
    assert.ok(Math.abs(build!.endSample - drop!.sample) < 0.03 * SR, "build ends at the drop");
    assert.ok(a.sections.some((s) => s.label === "drop"), "a section is labelled drop");
  });

  it("digital silence is a region with exact-ish bounds", () => {
    const { track } = groove(24, 124, 1, 8000);
    track.silence(10 * SR, 12 * SR);
    const a = run(track.samples);
    // The inserted 10-12 s gap (trailing silence after the last hit is a separate, valid region).
    const sil = a.regions.filter((r) => r.type === "silence" && toNumberApprox(r.start) > 5 && toNumberApprox(r.start) < 15);
    assert.equal(sil.length, 1);
    assert.ok(Math.abs(toNumberApprox(sil[0]!.start) - 10) <= 0.3, `start ${toNumberApprox(sil[0]!.start)}`);
    assert.ok(Math.abs(toNumberApprox(sil[0]!.end) - 12) <= 0.02, `end ${toNumberApprox(sil[0]!.end)}`);
  });

  it("a snare roll in the last beat of a bar is a fill", () => {
    const { track } = groove(30, 124, 1, 8000);
    const last = beatSample(31, 124, 1, 8000); // last beat of bar 7
    for (let k = 0; k < 4; k++) track.snare(last + Math.round((k * 15 * SR) / 124), 0.5);
    const a = run(track.samples);
    const fill = a.regions.find((r) => r.type === "fill");
    assert.ok(fill, "fill found");
    assert.ok(Math.abs(fill!.startSample - last) < 0.03 * SR);
  });

  it("energy curve is sampled every exactly 1/10 s", () => {
    const { track } = groove(20, 124, 1, 8000);
    const a = run(track.samples);
    assert.deepEqual(a.curves.energy.stepSeconds, rational(1, 10));
    assert.equal(a.curves.energy.rmsDbfs.length, Math.floor((20 * 100 + 1) / 10));
  });
});

describe("vocal candidates", () => {
  it("finds repeated tonal chops at their exact times and clusters them", () => {
    const { track } = groove(30, 124, 1, 8000);
    const chopTimes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const s = beatSample(16 + 2 * i, 124, 1, 8000) + Math.round(0.117 * SR); // off the beat
      chopTimes.push(s);
      track.chop(s, 220 + (i % 3) * 5);
    }
    const config = { ...DEFAULT_CONFIG, focusWindows: [{ id: "w", start: "5.0s", end: "25.0s" }] };
    const a = run(track.samples, config);
    const attacks = a.events.filter((e) => e.type === "vocal_attack");
    for (const c of chopTimes) {
      const hit = attacks.find((e) => Math.abs(e.sample - c) <= 0.015 * SR);
      assert.ok(hit, `chop at ${(c / SR).toFixed(3)} s detected within 15 ms`);
    }
    const inCluster = chopTimes.filter((c) => attacks.find((e) => Math.abs(e.sample - c) <= 0.015 * SR)?.vocal?.clusterId);
    assert.ok(inCluster.length >= 10, `${inCluster.length}/12 chops clustered`);
    assert.equal(a.vocal.wordIdentification, "unavailable");
  });
});

describe("determinism, IDs and low-confidence behaviour", () => {
  it("identical input -> identical analysis (apart from generatedAt) and stable IDs", () => {
    const { track } = groove(30, 124, 1, 3000);
    const a = run(track.samples);
    const b = analyzeSamples(track.samples, SOURCE, DEFAULT_CONFIG, { ...META, now: () => "2099-01-01T00:00:00.000Z" });
    assert.equal(deterministicMusicView(a), deterministicMusicView(b));
    for (const e of a.events) assert.match(e.id, /^(onset|vocal|impact|drop):\d+$/);
    assert.equal(new Set(a.events.map((e) => e.id)).size, a.events.length);
    assert.deepEqual(a.beats.slice(0, 3).map((x) => x.id), ["beat:0000", "beat:0001", "beat:0002"]);
  });

  it("noise without a pulse yields low confidence (or a clear error), never a confident grid", () => {
    const rng = new Lcg(99);
    const noise = new Float32Array(20 * SR).map(() => rng.next() * 0.3);
    try {
      const a = run(noise);
      assert.ok(a.tempo.bpmConfidence < 0.3, `confidence ${a.tempo.bpmConfidence}`);
      assert.ok(a.warnings.some((w) => w.code === "LOW_BPM_CONFIDENCE" || w.code === "NO_KICK_PULSE"));
    } catch (err) {
      assert.match((err as Error).message, /beat grid|onsets/);
    }
  });
});

describe("end to end through the verified FFmpeg (decode, loudness, cache)", () => {
  let tools: MediaTools;
  let dir: string;
  before(async () => {
    tools = await resolveMediaTools();
    dir = await mkdtemp(path.join(tmpdir(), "bali-music-"));
  });
  after(async () => rm(dir, { recursive: true, force: true }));

  it("analyses a WAV via ffmpeg decode, then hits the cache", async () => {
    const { track } = groove(40, 124, 1, 9000);
    const file = await writeWav16(path.join(dir, "g124.wav"), track.samples);
    const entry = await ingestFile(tools, { rootId: "t", rootPath: dir, relativePath: "g124.wav", absolutePath: file, exists: true });
    const cacheDir = path.join(dir, "cache");
    const first = await analyzeMusic(tools, entry, DEFAULT_CONFIG, { cacheDir });
    assert.equal(first.cacheHit, false);
    assert.equal(`${first.analysis.tempo.canonicalBpm.num}/${first.analysis.tempo.canonicalBpm.den}`, "124/1");
    assert.ok(first.analysis.curves.loudness.momentaryLufs.length > 300);
    assert.ok(first.analysis.curves.loudness.integratedLufs !== null);
    const second = await analyzeMusic(tools, entry, DEFAULT_CONFIG, { cacheDir });
    assert.equal(second.cacheHit, true);
    assert.equal(deterministicMusicView(second.analysis), deterministicMusicView(first.analysis));
    assert.equal((await readdir(cacheDir)).length, 1);
    const other = await analyzeMusic(tools, entry, { ...DEFAULT_CONFIG, phraseBars: 16 }, { cacheDir });
    assert.equal(other.cacheHit, false, "a different config is a different cache key");
  });

  it("refuses media without usable audio with explicit errors", async () => {
    const fx = await generateFixtures();
    const broken = await ingestFile(tools, { rootId: "f", rootPath: fx, relativePath: "broken.mp4", absolutePath: path.join(fx, "broken.mp4"), exists: true });
    await assert.rejects(analyzeMusic(tools, broken), (e: unknown) => e instanceof MusicInputError && e.code === "MEDIA_NOT_OK");
    const silentVideo = await ingestFile(tools, { rootId: "f", rootPath: fx, relativePath: "anamorphic.mp4", absolutePath: path.join(fx, "anamorphic.mp4"), exists: true });
    await assert.rejects(analyzeMusic(tools, silentVideo), (e: unknown) => e instanceof MusicInputError && e.code === "NO_AUDIO_STREAM");
  });
});

describe("user sync events and overrides", () => {
  const { track } = groove(30, 124, 1, 8000);
  for (let i = 0; i < 8; i++) track.chop(beatSample(20 + 2 * i, 124, 1, 8000) + 5000, 230);
  const a = analyzeSamples(track.samples, SOURCE, { ...DEFAULT_CONFIG, focusWindows: [{ id: "w", start: "8.0s", end: "20.0s" }] }, META);
  const base = {
    schemaVersion: "1.0.0",
    sourceMediaId: SOURCE.mediaId,
    requiredEvents: [
      { id: "usr:drop", type: "structural_boundary", time: "00:00:15.000", label: "drop" },
      { id: "usr:end", type: "end_boundary", time: "20.0s", label: "end" },
    ],
    requiredPatterns: [
      { id: "usr:word", label: "word", window: { start: "8.0s", end: "20.0s" }, matchEventTypes: ["vocal_attack"], requirement: "every_occurrence_mandatory" },
    ],
    eventOverrides: [] as unknown[],
  };

  it("user events are exact, mandatory and top tier; raw analysis stays untouched", () => {
    const before = JSON.stringify(a);
    const r = resolveEvents(a, parseSync(base));
    const sw = r.events.find((e) => e.id === "usr:drop")!;
    assert.deepEqual(sw.time, rational(15));
    assert.equal(sw.tier, "USER_REQUIRED");
    assert.equal(sw.mandatory, true);
    assert.equal(sw.identityStatus, "CONFIRMED");
    assert.equal(JSON.stringify(a), before);
    const pat = r.events.filter((e) => e.patternId === "usr:word");
    assert.ok(pat.length >= 6);
    assert.ok(pat.every((e) => e.mandatory && e.tier === "USER_REQUIRED" && e.identityStatus !== "CONFIRMED"));
    // resolved events are time-ordered
    for (let i = 1; i < r.events.length; i++) assert.ok(compare(r.events[i - 1]!.time, r.events[i]!.time) <= 0);
  });

  it("confirm / exclude / retime / relabel apply without touching detections", () => {
    const r0 = resolveEvents(a, parseSync(base));
    const [c1, c2, c3] = r0.events.filter((e) => e.patternId === "usr:word");
    const sync = parseSync({
      ...base,
      eventOverrides: [
        { id: "usr:ok", targetEventId: c1!.id, action: "confirm" },
        { id: "usr:no", targetEventId: c2!.id, action: "exclude", note: "second syllable" },
        { id: "usr:move", targetEventId: c3!.id, action: "retime", time: "00:00:12.345" },
        { id: "usr:name", targetEventId: "usr:end", action: "relabel", label: "outro end" },
        { id: "usr:ghost", targetEventId: "vocal:1", action: "confirm" },
      ],
    });
    const r = resolveEvents(a, sync);
    assert.equal(r.events.find((e) => e.id === c1!.id)!.identityStatus, "CONFIRMED");
    assert.equal(r.events.find((e) => e.id === c2!.id), undefined);
    assert.deepEqual(r.excluded, [{ detectedEventId: c2!.id, overrideId: "usr:no", note: "second syllable" }]);
    const moved = r.events.find((e) => e.id === c3!.id)!;
    assert.deepEqual(moved.time, rational(12345, 1000));
    assert.equal(moved.origin, "user");
    assert.deepEqual(moved.overrideIds, ["usr:move"]);
    assert.equal(r.events.find((e) => e.id === "usr:end")!.label, "outro end");
    assert.ok(r.warnings.some((w) => w.code === "OVERRIDE_TARGET_MISSING"));
  });

  it("rejects ambiguous or invalid sync input", () => {
    assert.throws(() => parseSync({ ...base, requiredEvents: [{ id: "usr:x", type: "custom", time: "15", label: "x" }] }), /ambiguous/);
    assert.throws(() => parseSync({ ...base, requiredEvents: [{ id: "usr:x", type: "custom", time: "450f", label: "x" }] }), /seconds or clock/);
    assert.throws(() => parseSync({ ...base, requiredEvents: [...base.requiredEvents, base.requiredEvents[0]] }), /duplicate/);
    assert.throws(() => parseSync({ ...base, eventOverrides: [{ id: "usr:r", targetEventId: "x", action: "retime" }] }));
    assert.throws(() => resolveEvents(a, parseSync({ ...base, sourceMediaId: "m_1111111111111111" })), /sync file is for/);
  });
});
