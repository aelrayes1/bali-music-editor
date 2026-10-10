/**
 * Phase 12 hardening, pure units: diagnostics formatting, resource preflight (injected statfs), atomic
 * writes and interruption leftovers, exact frame timing, audio sync primitives, frame alignment,
 * content orientation, colour level shifts and the shared conform cache key.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { commitPartial, partialPath, staleTemps, writeFileAtomic, writeJsonAtomic } from "../../src/hardening/atomic.ts";
import { compareAudio, estimateLag, silenceRuns } from "../../src/hardening/audio.ts";
import { checkLevelShift, checkSocialMasterConsistency, SDR_709 } from "../../src/hardening/colour.ts";
import { BaliError, assertNoErrors, formatIssue, resolveFalse, toolFailure } from "../../src/hardening/errors.ts";
import { contentRotation, displaySize } from "../../src/hardening/orientation.ts";
import { alignFrames } from "../../src/hardening/render-qc.ts";
import { assertMediaHeadroom, DEFAULT_POLICY, loadPolicy, preflight, type StatFs } from "../../src/hardening/resource.ts";
import { checkFrameTiming } from "../../src/hardening/timing.ts";
import { cacheKey } from "../../src/common/cache-identity.ts";
import { maskCacheKey, type MaskIdentity } from "../../src/fx/subject/pipeline.ts";
import { musicCacheIdentity, type MusicAnalysisConfig } from "../../src/music/analyze.ts";
import { rational } from "../../src/time/rational.ts";
import { asrCacheKey } from "../../src/vocal/whisper.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "bali-hardening-"));
const GiB = 2 ** 30;
const disk = (gib: number): StatFs => () => ({ bavail: (gib * GiB) / 4096, bsize: 4096 });

describe("diagnostics: what / where / expected vs actual / next", () => {
  it("formats an issue with every field it has", () => {
    const t = formatIssue({ code: "TIMELINE_GAP", severity: "BLOCKING", what: "gap between clip:01 and clip:02", clipId: "clip:02", frame: 105, expected: 105, actual: 110, next: "close the gap" });
    assert.equal(t, "[BLOCKING] TIMELINE_GAP: gap between clip:01 and clip:02 — clip clip:02, frame 105 (expected 105, actual 110). Next: close the gap");
  });
  it("BaliError carries the issue and code; assertNoErrors throws only for non-warnings", () => {
    const e = new BaliError({ code: "X_FAILED", what: "x", next: "y" });
    assert.equal(e.code, "X_FAILED");
    assert.equal(e.issue.severity, "BLOCKING");
    assert.doesNotThrow(() => assertNoErrors([{ code: "W", severity: "WARNING", what: "w", next: "n" }], "ctx"));
    assert.throws(() => assertNoErrors([{ code: "W", severity: "WARNING", what: "w", next: "n" }, { code: "E1", severity: "ERROR", what: "first", next: "fix it" }, { code: "E2", severity: "BLOCKING", what: "second", next: "n" }], "render"), (err: BaliError) => err.code === "E1" && /render: 2 problem\(s\); first: first/.test(err.message));
  });
  it("tool failures name the tool, operation, exit code, file and the tail of stderr (no bare 'failed')", () => {
    const e = toolFailure({ tool: "ffmpeg", operation: "conform clip:03", file: "/x/clip.mov", exitCode: 1, stderr: "line1\nline2\nInvalid data found\nError opening input" });
    assert.equal(e.code, "FFMPEG_FAILED");
    assert.match(e.message, /ffmpeg conform clip:03 failed \(exit 1\): line2 \| Invalid data found \| Error opening input — file \/x\/clip.mov\. Next: /);
    const r = resolveFalse("SetLUT", "clip:05 node 3", "Color page not active");
    assert.equal(r.code, "RESOLVE_API_FALSE");
    assert.match(r.message, /SetLUT returned False on clip:05 node 3 \(known cause: Color page not active\)/);
  });
});

describe("resource policy and preflight", () => {
  const policy = DEFAULT_POLICY;
  it("media work is blocked when it would cross the floor; metadata work never is", () => {
    assert.equal(preflight("media", 0, { statfs: disk(40), policy }).status, "OK");
    assert.equal(preflight("media", 0, { statfs: disk(31), policy }).status, "WARN");
    assert.equal(preflight("media", 2 * GiB, { statfs: disk(31), policy }).status, "BLOCK");
    assert.equal(preflight("media", 0, { statfs: disk(16), policy }).status, "BLOCK");
    assert.equal(preflight("metadata", 0, { statfs: disk(16), policy }).status, "WARN");
  });
  it("assertMediaHeadroom throws DISK_FLOOR with the numbers and a safe next action", () => {
    assert.throws(() => assertMediaHeadroom("render social", 0.5 * GiB, { statfs: disk(30.2), policy }), (e: BaliError) => e.code === "DISK_FLOOR" && /render social refused/.test(e.message) && /29\.7 GiB/.test(e.message) && /never approved artifacts/.test(e.message));
    assert.equal(assertMediaHeadroom("probe", 0, { statfs: disk(45), policy }).status, "OK");
  });
  it("the policy file is validated; the checked-in policy is the 30 GiB floor", () => {
    assert.deepEqual(loadPolicy(), { mediaFloorGiB: 30, warnGiB: 32, cacheReportGiB: 5 });
    const d = tmp();
    writeFileSync(path.join(d, "p.json"), JSON.stringify({ mediaFloorGiB: 40, warnGiB: 35 }));
    assert.throws(() => loadPolicy(path.join(d, "p.json")), (e: BaliError) => e.code === "RESOURCE_POLICY_INVALID");
    assert.deepEqual(loadPolicy(path.join(d, "missing.json")), DEFAULT_POLICY);
  });
});

describe("interruption safety", () => {
  it("atomic write replaces the file whole and leaves no temp", async () => {
    const d = tmp();
    const f = path.join(d, "sub", "record.json");
    await writeJsonAtomic(f, { a: 1 });
    await writeJsonAtomic(f, { a: 2 });
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: 2 });
    assert.deepEqual(readdirSync(path.dirname(f)), ["record.json"]);
  });
  it("a failed write keeps the previous file intact and removes its temp", async () => {
    const d = tmp();
    const f = path.join(d, "record.json");
    await writeFileAtomic(f, "approved\n");
    // a directory in the way of the rename target makes the rename fail after the temp was written
    const blocked = path.join(d, "blocked");
    await writeFileAtomic(path.join(blocked, "x"), "x");
    await assert.rejects(writeFileAtomic(blocked, "new"));
    assert.equal(readFileSync(f, "utf8"), "approved\n");
    assert.deepEqual(readdirSync(d).sort(), ["blocked", "record.json"]);
  });
  it("leftovers of an interrupted step (temps, .partial media) are found for a cleanup report, never trusted", () => {
    const d = tmp();
    const now = Date.now();
    writeFileSync(path.join(d, "plan.json.tmp-123-abcd"), "{");
    writeFileSync(path.join(d, "social.mp4.partial"), "half");
    writeFileSync(path.join(d, "fresh.json.tmp-9-ffff"), "{");
    writeFileSync(path.join(d, "approved.json"), "{}");
    const old = (now - 3_600_000) / 1000;
    utimesSync(path.join(d, "plan.json.tmp-123-abcd"), old, old);
    utimesSync(path.join(d, "social.mp4.partial"), old, old);
    assert.deepEqual(staleTemps(d, 60_000, now).map((f) => path.basename(f)).sort(), ["plan.json.tmp-123-abcd", "social.mp4.partial"]);
  });
  it("a media output becomes visible only when committed", () => {
    const d = tmp();
    const out = path.join(d, "render.mov");
    writeFileSync(partialPath(out), "frames");
    assert.equal(existsSync(out), false);
    commitPartial(out);
    assert.equal(readFileSync(out, "utf8"), "frames");
    assert.equal(existsSync(partialPath(out)), false);
  });
});

describe("exact frame timing", () => {
  const cfr = (n: number, tpf: number, start = 0) => Array.from({ length: n }, (_, i) => ({ pts: start + i * tpf, duration: tpf }));
  it("every frame at n/fps passes (integer and 1/1000 ms-rounded time bases)", () => {
    assert.deepEqual(checkFrameTiming(cfr(450, 512), { num: 1, den: 15360 }, { num: 30, den: 1 }, { expectedFrames: 450 }).issues, []);
    const ms = Array.from({ length: 30 }, (_, i) => ({ pts: Math.round((i * 1001) / 30), duration: null }));
    assert.deepEqual(checkFrameTiming(ms, { num: 1, den: 1000 }, { num: 30000, den: 1001 }).issues, []);
  });
  it("the half-frame join: right count and total, frames after the join shifted -0.5", () => {
    const p = cfr(450, 1000).map((x, i) => (i >= 290 ? { pts: x.pts - 500, duration: 1000 } : i === 289 ? { pts: x.pts, duration: 500 } : x));
    const r = checkFrameTiming(p, { num: 1, den: 30000 }, { num: 30, den: 1 }, { expectedFrames: 450 });
    assert.equal(r.frames, 450);
    assert.deepEqual(r.issues.map((i) => i.code), ["TIMING_FRAME_SHIFT", "TIMING_FRAME_DURATION"]);
    assert.equal(r.shifted.length, 160);
    assert.deepEqual([r.shifted[0]!.frame, r.shifted[0]!.offsetFrames], [290, -0.5]);
  });
  it("a start offset, a dropped frame and a wrong count are each named", () => {
    assert.deepEqual(checkFrameTiming(cfr(30, 1000, 1000), { num: 1, den: 30000 }, { num: 30, den: 1 }).issues.map((i) => i.code), ["TIMING_START_OFFSET"]);
    const dropped = cfr(31, 1000).filter((_, i) => i !== 10);
    assert.deepEqual(checkFrameTiming(dropped, { num: 1, den: 30000 }, { num: 30, den: 1 }, { expectedFrames: 31 }).issues.map((i) => i.code), ["TIMING_FRAME_SHIFT", "TIMING_FRAME_COUNT"]);
  });
});

describe("audio sync primitives", () => {
  const noise = (n: number, seed: number) => {
    let s = seed >>> 0;
    return Float32Array.from({ length: n }, () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.6);
  };
  const rate = 48000;
  const ref = noise(rate, 3);
  const shift = (x: Float32Array, k: number) => Float32Array.from(x, (_, i) => x[i - k] ?? 0);
  it("estimates the exact lag (late = positive)", () => {
    assert.equal(estimateLag(ref, ref, 2000).lag, 0);
    assert.equal(estimateLag(ref, shift(ref, 480), 2000).lag, 480);
    assert.equal(estimateLag(ref, shift(ref, -96), 2000).lag, -96);
  });
  it("silence runs: only real gaps of at least minMs", () => {
    const x = Float32Array.from(ref);
    x.fill(0, 10_000, 20_000);
    x.fill(0, 30_000, 31_000);
    // window-quantised (10 ms windows fully inside the gap); the 1000-sample gap is below minMs
    const runs = silenceRuns(x, rate);
    assert.equal(runs.length, 1);
    assert.ok(runs[0]![0] >= 10_000 && runs[0]![1] <= 20_000 && runs[0]![1] - runs[0]![0] >= 9_000, JSON.stringify(runs));
  });
  it("in sync / declared padding / drift / gain", () => {
    assert.equal(compareAudio(ref, ref, rate).verdict, "IN_SYNC");
    assert.equal(compareAudio(ref, shift(ref, 1024), rate, { containerOffsetSamples: 1024 }).verdict, "CODEC_PADDING");
    assert.equal(compareAudio(ref, shift(ref, 1024), rate).verdict, "SYNC_DRIFT");
    const loud = Float32Array.from(ref, (v) => v * 2);
    assert.deepEqual(compareAudio(ref, loud, rate).issues.map((i) => i.code), ["AUDIO_GAIN_CHANGED"]);
  });
});

describe("frame alignment and orientation (pure)", () => {
  const frame = (k: number) => Uint8Array.from({ length: 48 }, (_, i) => (k * 37 + i * 11) % 251);
  const ref = Array.from({ length: 20 }, (_, k) => frame(k));
  it("aligns exact, dropped, duplicated and shifted sequences", () => {
    assert.deepEqual(alignFrames(ref, ref), { map: ref.map((_, i) => i), dropped: [], duplicated: [], shifted: [] });
    assert.deepEqual(alignFrames(ref, ref.filter((_, i) => i !== 5)).dropped, [5]);
    assert.deepEqual(alignFrames(ref, [...ref.slice(0, 6), ref[5]!, ...ref.slice(6, 19)]).duplicated, [6]);
  });
  it("display size swaps only for quarter turns; content rotation is recovered for all four", () => {
    assert.deepEqual(displaySize(1920, 1080, 90), { w: 1080, h: 1920 });
    assert.deepEqual(displaySize(1920, 1080, 180), { w: 1920, h: 1080 });
    assert.deepEqual(displaySize(1920, 1080, -90), { w: 1080, h: 1920 });
    const w = 32, h = 48;
    const luma = Float32Array.from({ length: w * h }, (_, i) => ((i % w) * 3 + Math.floor(i / w) * 7 + ((i % w) > 20 && Math.floor(i / w) < 10 ? 120 : 0)) % 256);
    const rot = (l: Float32Array, W: number, H: number, q: 90 | 180 | 270) => {
      const ow = q === 180 ? W : H, oh = q === 180 ? H : W;
      const o = new Float32Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const [nx, ny] = q === 90 ? [H - 1 - y, x] : q === 180 ? [W - 1 - x, H - 1 - y] : [y, W - 1 - x];
          o[ny * ow + nx] = l[y * W + x]!;
        }
      return { luma: o, w: ow, h: oh };
    };
    const ref0 = { luma, w, h };
    assert.equal(contentRotation(ref0, ref0).rotation, 0);
    for (const q of [90, 180, 270] as const) assert.equal(contentRotation(ref0, rot(luma, w, h, q)).rotation, q);
  });
});

describe("colour consistency", () => {
  it("social and master must share tags; a range applied twice shows as a level shift", () => {
    assert.deepEqual(checkSocialMasterConsistency(SDR_709, SDR_709), []);
    assert.deepEqual(checkSocialMasterConsistency({ ...SDR_709, range: "pc" }, SDR_709).map((i) => i.code), ["COLOUR_SOCIAL_MASTER_MISMATCH"]);
    assert.deepEqual(checkLevelShift({ p01: 16, p99: 235 }, { p01: 18, p99: 233 }), []);
    assert.deepEqual(checkLevelShift({ p01: 16, p99: 235 }, { p01: 0, p99: 255 }).map((i) => i.code), ["COLOUR_LEVEL_SHIFT"]);
  });
});

describe("analysis cache identities: same inputs hit, any material change misses", () => {
  const distinct = (keys: string[]) => assert.equal(new Set(keys).size, keys.length, JSON.stringify(keys));
  it("music analysis: input, config, tool version, analyzer version, implementation", () => {
    const cfg = { tempo: { minBpm: 70, maxBpm: 180, priorBpm: 95 }, beatsPerBar: 4, phraseBars: 8 } as unknown as MusicAnalysisConfig;
    const k = (fp: string, c = cfg, ff = "9.0.2", o = {}) => cacheKey(musicCacheIdentity(fp, c, ff, o));
    assert.equal(k("fp-song"), k("fp-song", structuredClone(cfg)));
    distinct([k("fp-song"), k("fp-other"), k("fp-song", { ...cfg, beatsPerBar: 3 } as MusicAnalysisConfig), k("fp-song", cfg, "8.1"), k("fp-song", cfg, "9.0.2", { analyzerVersion: "9.9.9" }), k("fp-song", cfg, "9.0.2", { implementation: "changed-code" })]);
  });
  it("ASR: audio, range, windows, windowing config, model, engine, analyzer", () => {
    const base = { fp: "fp", range: { start: rational(90), end: rational(105) }, windows: [{ startSample16k: 0, endSample16k: 48000 }], cfg: { windowBars: 2, stepBars: 1 }, engine: { modelSha256: "m1", version: "1.7", commit: "abc" }, analysis: { analyzer: { version: "1.0.0", configHash: "c1" } } };
    type B = typeof base;
    const k = (b: B) => asrCacheKey(b.fp, b.range, b.windows as never, b.cfg as never, b.engine as never, b.analysis as never);
    assert.equal(k(base), k(structuredClone(base)));
    distinct([k(base), k({ ...base, fp: "fp2" }), k({ ...base, range: { ...base.range, end: rational(106) } }), k({ ...base, windows: [{ startSample16k: 0, endSample16k: 48001 }] }), k({ ...base, cfg: { windowBars: 4, stepBars: 1 } }), k({ ...base, engine: { ...base.engine, modelSha256: "m2" } }), k({ ...base, engine: { ...base.engine, commit: "def" } }), k({ ...base, analysis: { analyzer: { version: "1.0.0", configHash: "c2" } } })]);
  });
  it("subject masks: source, range, size, tool binary / source / OS, params, code", () => {
    const id: MaskIdentity = { kind: "PHASE_6B_SUBJECT_MASKS", source: { fingerprint: "fp", range: [0, 30], size: [270, 480] }, tool: { binarySha256: "b", sourceSha256: "s", macosBuild: "25A1", requests: ["person"] }, params: { downscale: 4, segmentation: true, computeDevice: "cpu" }, code: "c" };
    const v = (f: (x: MaskIdentity) => void) => {
      const x = structuredClone(id);
      f(x);
      return maskCacheKey(x);
    };
    assert.equal(maskCacheKey(id), maskCacheKey(structuredClone(id)));
    distinct([maskCacheKey(id), v((x) => (x.source.fingerprint = "fp2")), v((x) => (x.source.range = [0, 31])), v((x) => (x.source.size = [540, 960])), v((x) => (x.tool.binarySha256 = "b2")), v((x) => (x.tool.macosBuild = "25B1")), v((x) => (x.params.downscale = 2)), v((x) => (x.code = "c2"))]);
  });
});
