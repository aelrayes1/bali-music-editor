/**
 * Phase 12 media hardening (tier FAST, synthetic only): the ~30-case corpus through ingest, the source
 * policies (colour, orientation, timing), the known-bad render fixtures through content QC, the
 * half-frame concat join, audio sync / gain / silence, delivery tags and decode errors.
 * Everything is generated tiny into .cache/hardening-fixtures (gitignored, ~3 MB).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import { interpretSourceColour, checkDeliveryColour, SDR_709, type ColourTags } from "../../src/hardening/colour.ts";
import { checkContentOrientation, checkDeliveryOrientation, sourceOrientationWarnings } from "../../src/hardening/orientation.ts";
import { qcAgainstReference, type Frames } from "../../src/hardening/render-qc.ts";
import { verifyFrameTiming } from "../../src/hardening/timing.ts";
import { compareAudio } from "../../src/hardening/audio.ts";
import { resolveMediaTools, type MediaTools } from "../../src/media/ffmpeg.ts";
import { buildManifest } from "../../src/media/manifest.ts";
import type { MediaEntry, MediaManifest } from "../../src/media/schema.ts";
import { SourcesConfigSchema } from "../../src/media/sources.ts";
import { QC_SIZE, audioMono, decodeErrors, probe, qcFrames } from "../../src/render/qc.ts";
import { CASES, HARDENING_DIR, generateHardeningFixtures } from "../helpers/hardening-fixtures.ts";

const exec = promisify(execFile);
let tools: MediaTools;
let manifest: MediaManifest;
const R = path.join(HARDENING_DIR, "render");
const ff = (...a: string[]) => exec(tools.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...a], { maxBuffer: 64 << 20 });
const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);
const byName = (n: string): MediaEntry => {
  const e = manifest.media.find((m) => m.source.relativePath === n);
  assert.ok(e, `missing ${n}`);
  return e;
};
const tagsOf = (e: MediaEntry): ColourTags => ({ primaries: e.video!.color.primaries, transfer: e.video!.color.transfer, matrix: e.video!.color.space, range: e.video!.color.range });

before(async () => {
  tools = await resolveMediaTools();
  await generateHardeningFixtures();
  manifest = await buildManifest(tools, SourcesConfigSchema.parse({ schemaVersion: 1, sourceRoots: [{ id: "hardening", path: HARDENING_DIR, include: ["*"] }] }), { now: () => "2026-01-01T00:00:00.000Z" });
  await mkdir(R, { recursive: true });
});

describe("media corpus: every case ingests to its expected facts", () => {
  it("ingests every case, none silently dropped", () => {
    assert.ok(CASES.length >= 30, `corpus has ${CASES.length} cases`);
    assert.equal(manifest.media.length, CASES.length);
  });
  for (const c of CASES) {
    it(`${c.name}: ${c.why}`, () => {
      const e = byName(c.name);
      const x = c.expect;
      assert.equal(e.status, x.status, `${c.name} status`);
      if (x.kind) assert.equal(e.kind, x.kind);
      const w = codes(e.warnings);
      for (const k of x.warnings ?? []) assert.ok(w.includes(k), `${c.name}: expected warning ${k}, got ${w.join(",")}`);
      for (const k of x.notWarnings ?? []) assert.ok(!w.includes(k), `${c.name}: unexpected warning ${k}`);
      if (x.playable !== undefined) assert.equal(e.isPlayableVideoFootage, x.playable);
      const v = e.video;
      if (x.display) assert.deepEqual([v!.displayWidth, v!.displayHeight], x.display);
      if (x.stored) assert.deepEqual([v!.storedWidth, v!.storedHeight], x.stored);
      if (x.rotationCw !== undefined) assert.equal(v!.rotation.clockwiseToDisplay, x.rotationCw);
      if (x.orientation) assert.equal(v!.orientation, x.orientation);
      if (x.frameRateMode) assert.equal(v!.frameRateMode.classification, x.frameRateMode);
      if (x.frames !== undefined) assert.equal(v!.frameCount.value, x.frames);
      if (x.fps) assert.equal(`${v!.nominalFrameRate!.num}/${v!.nominalFrameRate!.den}`, x.fps);
      if (x.codec) assert.equal(v!.codec, x.codec);
      if (x.startSeconds !== undefined) assert.equal(v!.startTimeSeconds!.num / v!.startTimeSeconds!.den, x.startSeconds);
      if (x.hasAudio !== undefined) assert.equal(e.hasAudio, x.hasAudio);
      if (x.sampleRate) assert.equal(e.audio!.sampleRate, x.sampleRate);
      if (x.channels) assert.equal(e.audio!.channels, x.channels);
      for (const [k, val] of Object.entries(x.colour ?? {})) assert.equal((v!.color as Record<string, unknown>)[k], val, `${c.name} colour.${k}`);
      if (x.duplicateOf) assert.equal(e.duplicateOf, byName(x.duplicateOf).mediaId);
    });
  }
});

describe("source policies on the corpus", () => {
  it("colour: tagged BT.709 is taken as tagged; untagged is BLOCKING until a recorded human decision; HDR is flagged", () => {
    assert.deepEqual(interpretSourceColour(tagsOf(byName("cfr_30.mp4")), { decision: "REQUIRE_EXPLICIT" }).issues, []);
    const un = interpretSourceColour(tagsOf(byName("untagged.mp4")), { decision: "REQUIRE_EXPLICIT" }, "untagged.mp4");
    assert.deepEqual(codes(un.issues), ["COLOUR_TAGS_MISSING"]);
    assert.equal(un.issues[0]!.severity, "BLOCKING");
    const assumed = interpretSourceColour(tagsOf(byName("untagged.mp4")), { decision: "ASSUME", assume: SDR_709, reason: "phone SDR capture", decidedBy: "human", record: "colour-decision.json" });
    assert.equal(assumed.assumed, true);
    assert.deepEqual(assumed.tags, SDR_709);
    assert.deepEqual(codes(assumed.issues), ["COLOUR_TAGS_ASSUMED"]);
    for (const n of ["hevc_10bit_pq.mp4", "hlg_tagged.mov"]) assert.ok(codes(interpretSourceColour(tagsOf(byName(n)), { decision: "REQUIRE_EXPLICIT" }).issues).includes("COLOUR_HDR_SOURCE"), n);
  });
  it("orientation: rotation metadata is applied once; the double-rotation trap is surfaced, not guessed", () => {
    const o = (n: string, want?: "portrait" | "landscape") => {
      const v = byName(n).video!;
      return codes(sourceOrientationWarnings({ w: v.storedWidth, h: v.storedHeight }, v.rotation.clockwiseToDisplay, want, n));
    };
    assert.deepEqual(o("rot_cw90.mov", "portrait"), []);
    assert.deepEqual(o("rot_cw270.mov", "portrait"), []);
    assert.deepEqual(o("portrait_native.mp4", "portrait"), []);
    assert.deepEqual(o("vfr_rotated_cw90.mov", "portrait"), []);
    assert.deepEqual(o("portrait_tagged_rot90.mov", "portrait"), ["ORIENTATION_DOUBLE_ROTATION_RISK", "ORIENTATION_UNEXPECTED"]);
  });
  it("timing: CFR sources are exact at n/fps (also 30000/1001); a start offset and VFR are reported", async () => {
    assert.deepEqual((await verifyFrameTiming(tools, path.join(HARDENING_DIR, "cfr_30.mp4"), { num: 30, den: 1 }, 30)).issues, []);
    assert.deepEqual((await verifyFrameTiming(tools, path.join(HARDENING_DIR, "cfr_2997.mp4"), { num: 30000, den: 1001 }, 30)).issues, []);
    assert.deepEqual((await verifyFrameTiming(tools, path.join(HARDENING_DIR, "prores_hq.mov"), { num: 30, den: 1 }, 30)).issues, []);
    assert.ok(codes((await verifyFrameTiming(tools, path.join(HARDENING_DIR, "start_offset.mp4"), { num: 30, den: 1 })).issues).includes("TIMING_START_OFFSET"));
    const vfr = await verifyFrameTiming(tools, path.join(HARDENING_DIR, "vfr_30_15.mp4"), { num: 30, den: 1 });
    assert.ok(codes(vfr.issues).includes("TIMING_FRAME_SHIFT"));
  });
});

describe("timing: the half-frame concat join", () => {
  it("a join with the right frame count can still shift every later frame by half a frame; setts fixes it", async () => {
    await ff("-f", "lavfi", "-i", "testsrc2=s=160x96:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "3", "-video_track_timescale", "30000", path.join(R, "join-a.mov"));
    await ff("-f", "lavfi", "-i", "testsrc2=s=160x96:r=30:d=0.5", "-vf", "hflip", "-c:v", "prores_ks", "-profile:v", "3", "-video_track_timescale", "30000", path.join(R, "join-b.mov"));
    await writeFile(path.join(R, "join.txt"), `ffconcat version 1.0\nfile '${path.join(R, "join-a.mov")}'\noutpoint ${((15 - 0.5) / 30).toFixed(6)}\nfile '${path.join(R, "join-b.mov")}'\n`);
    await ff("-f", "concat", "-safe", "0", "-i", path.join(R, "join.txt"), "-c", "copy", path.join(R, "join-bad.mov"));
    await ff("-f", "concat", "-safe", "0", "-i", path.join(R, "join.txt"), "-c", "copy", "-bsf:v", "setts=pts=N/(30*TB):dts=N/(30*TB):duration=1/(30*TB)", path.join(R, "join-good.mov"));
    const bad = await verifyFrameTiming(tools, path.join(R, "join-bad.mov"), { num: 30, den: 1 }, 30);
    assert.equal(bad.frames, 30, "frame count looks right");
    assert.ok(codes(bad.issues).includes("TIMING_FRAME_SHIFT"));
    assert.equal(bad.shifted[0]!.frame, 15);
    assert.equal(bad.shifted[0]!.offsetFrames, -0.5);
    assert.deepEqual((await verifyFrameTiming(tools, path.join(R, "join-good.mov"), { num: 30, den: 1 }, 30)).issues, []);
  });
});

describe("known-bad renders: content QC against the approved reference", () => {
  // reference: 30 distinct frames (moving test pattern), clean reset at frame 15 (a different picture)
  let ref: Frames;
  const W = 160, H = 96;
  const raw = (frames: Uint8Array[]) => Buffer.concat(frames.map((f) => Buffer.from(f)));
  const encode = async (name: string, frames: Uint8Array[], extra: string[] = []) => {
    const f = path.join(R, name);
    await writeFile(`${f}.rgb`, raw(frames));
    await ff("-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", "30", "-i", `${f}.rgb`, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", ...extra, f);
    await rm(`${f}.rgb`);
    return f;
  };
  let src: Uint8Array[];
  const decode = async (f: string): Promise<Frames> => ({ ...QC_SIZE, frames: await qcFrames(tools, f) });
  before(async () => {
    await ff("-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=30:d=0.5`, "-f", "lavfi", "-i", `testsrc=s=${W}x${H}:r=30:d=0.5`, "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-pix_fmt", "rgb24", "-f", "rawvideo", path.join(R, "src.rgb"));
    const b = await readFile(path.join(R, "src.rgb"));
    const n = W * H * 3;
    src = Array.from({ length: b.length / n }, (_, i) => new Uint8Array(b.subarray(i * n, (i + 1) * n)));
    await rm(path.join(R, "src.rgb"));
    ref = await decode(await encode("ref.mp4", src));
  });
  const qc = async (name: string, frames: Uint8Array[]) => qcAgainstReference(ref, await decode(await encode(name, frames)), { resetFrames: [15], file: name });
  const map = (fn: (f: Uint8Array, i: number) => Uint8Array) => src.map(fn);
  const tweak = (f: Uint8Array, g: (v: number, c: number) => number) => Uint8Array.from(f, (v, i) => Math.max(0, Math.min(255, Math.round(g(v, i % 3)))));

  it("an exact re-render passes", async () => {
    assert.deepEqual((await qc("good.mp4", src)).issues, []);
  });
  it("dropped frame", async () => {
    const r = await qc("drop.mp4", src.filter((_, i) => i !== 10));
    assert.ok(codes(r.issues).includes("FRAME_COUNT") && codes(r.issues).includes("FRAME_DROPPED"), JSON.stringify(codes(r.issues)));
  });
  it("duplicated frame (count preserved)", async () => {
    const r = await qc("dup.mp4", [...src.slice(0, 11), src[10]!, ...src.slice(11, 29)]);
    assert.ok(codes(r.issues).includes("FRAME_DUPLICATED"), JSON.stringify(codes(r.issues)));
    assert.ok(!codes(r.issues).includes("FRAME_COUNT"));
  });
  it("one-frame timing shift (count preserved)", async () => {
    const r = await qc("shift.mp4", [src[0]!, ...src.slice(0, 29)]);
    assert.ok(codes(r.issues).some((c) => c === "FRAME_DUPLICATED" || c === "FRAME_TIMING_SHIFT"), JSON.stringify(codes(r.issues)));
  });
  it("black frame", async () => {
    const r = await qc("black.mp4", map((f, i) => (i === 7 ? new Uint8Array(f.length) : f)));
    assert.ok(codes(r.issues).includes("BLACK_FRAME"));
    assert.equal(r.issues.find((x) => x.code === "BLACK_FRAME")!.frame, 7);
  });
  it("brightness spike", async () => {
    const r = await qc("flash.mp4", map((f, i) => (i === 20 ? tweak(f, (v) => v + 60) : f)));
    assert.ok(codes(r.issues).includes("BRIGHTNESS_SPIKE"));
  });
  it("clipping increase", async () => {
    const r = await qc("clip.mp4", map((f) => tweak(f, (v) => (v - 128) * 1.8 + 150)));
    assert.ok(codes(r.issues).includes("CLIPPING_INCREASE"), JSON.stringify(codes(r.issues)));
  });
  it("proxy / low-resolution substitution (needs a native-resolution decode: the 1/10 QC size hides it)", async () => {
    const native = async (f: string): Promise<Frames> => {
      const { stdout } = await exec(tools.ffmpeg, ["-v", "error", "-i", f, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
      const n = W * H * 3;
      return { w: W, h: H, frames: Array.from({ length: stdout.length / n }, (_, i) => new Uint8Array(stdout.subarray(i * n, (i + 1) * n))) };
    };
    const lo = path.join(R, "lowres.mp4");
    const base = await encode("lowres-src.mp4", src);
    await ff("-i", base, "-vf", `scale=40:24,scale=${W}:${H}:flags=bilinear`, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", lo);
    const r = qcAgainstReference(await native(base), await native(lo), { file: "lowres.mp4" });
    assert.ok(codes(r.issues).includes("PROXY_OR_LOWRES_SUBSTITUTION"), JSON.stringify(r.measures));
    assert.deepEqual(qcAgainstReference(await native(base), await native(base)).issues, []);
  });
  it("effect tail leaking across the clean reset", async () => {
    const r = await qc("tail.mp4", map((f, i) => (i >= 15 && i <= 17 ? Uint8Array.from(f, (v, k) => Math.round(0.6 * v + 0.4 * src[14]![k]!)) : f)));
    assert.ok(codes(r.issues).includes("EFFECT_TAIL_ACROSS_RESET"));
    assert.equal(r.issues.find((x) => x.code === "EFFECT_TAIL_ACROSS_RESET")!.frame, 15);
  });
  it("sideways and inverted pictures are caught on content, not metadata", async () => {
    const lumaOf = (fr: Frames) => ({ w: fr.w, h: fr.h, luma: Float32Array.from({ length: fr.w * fr.h }, (_, i) => 0.2126 * fr.frames[3]![i * 3]! + 0.7152 * fr.frames[3]![i * 3 + 1]! + 0.0722 * fr.frames[3]![i * 3 + 2]!) });
    const base = await encode("orient-src.mp4", src);
    await ff("-i", base, "-vf", "transpose=1", "-c:v", "libx264", "-qp", "0", path.join(R, "sideways.mp4"));
    await ff("-i", base, "-vf", "hflip,vflip", "-c:v", "libx264", "-qp", "0", path.join(R, "inverted.mp4"));
    assert.deepEqual(checkContentOrientation(lumaOf(ref), lumaOf(ref)), []);
    assert.deepEqual(codes(checkContentOrientation(lumaOf(ref), lumaOf(await decode(path.join(R, "sideways.mp4"))))), ["ORIENTATION_SIDEWAYS"]);
    assert.deepEqual(codes(checkContentOrientation(lumaOf(ref), lumaOf(await decode(path.join(R, "inverted.mp4"))))), ["ORIENTATION_INVERTED"]);
  });
});

describe("known-bad deliveries: tags, rotation, decode", () => {
  const facts = async (f: string) => {
    const s = (await probe(tools, f)).streams.find((x) => x.codec_type === "video")!;
    const rot = (s.side_data_list ?? []).find((d) => "rotation" in d)?.rotation;
    const t = (k: string) => (s[k] && s[k] !== "unknown" ? String(s[k]) : null);
    return { width: Number(s.width), height: Number(s.height), rotation: Number(rot ?? 0), tags: { primaries: t("color_primaries"), transfer: t("color_transfer"), matrix: t("color_space"), range: t("color_range") } };
  };
  const want = { width: 160, height: 90 };
  it("a correctly tagged delivery passes", async () => {
    const f = await facts(path.join(HARDENING_DIR, "cfr_30.mp4"));
    assert.deepEqual([...checkDeliveryColour(f.tags), ...checkDeliveryOrientation(f, want)], []);
  });
  it("HDR / wide-gamut tags, missing tags, full range and BT.601 are each rejected with their own code", async () => {
    assert.ok(codes(checkDeliveryColour((await facts(path.join(HARDENING_DIR, "hevc_10bit_pq.mp4"))).tags)).includes("COLOUR_HDR_TAG"));
    assert.ok(codes(checkDeliveryColour((await facts(path.join(HARDENING_DIR, "hlg_tagged.mov"))).tags)).includes("COLOUR_WIDE_GAMUT_TAG"));
    assert.ok(codes(checkDeliveryColour((await facts(path.join(HARDENING_DIR, "untagged.mp4"))).tags)).includes("COLOUR_TAG_MISSING"));
    assert.deepEqual(codes(checkDeliveryColour((await facts(path.join(HARDENING_DIR, "full_range.mp4"))).tags)), ["COLOUR_RANGE"]);
    assert.ok(codes(checkDeliveryColour((await facts(path.join(HARDENING_DIR, "bt601.mp4"))).tags)).includes("COLOUR_TAG_MISMATCH"));
  });
  it("rotation metadata, swapped dimensions and wrong size are rejected", async () => {
    assert.ok(codes(checkDeliveryOrientation(await facts(path.join(HARDENING_DIR, "rot_cw90.mov")), want)).includes("ORIENTATION_ROTATION_METADATA"));
    assert.deepEqual(codes(checkDeliveryOrientation(await facts(path.join(HARDENING_DIR, "portrait_native.mp4")), want)), ["ORIENTATION_SWAPPED"]);
    assert.deepEqual(codes(checkDeliveryOrientation(await facts(path.join(HARDENING_DIR, "square.mp4")), want)), ["DELIVERY_RESOLUTION"]);
  });
  it("a corrupted or truncated delivery reports decode errors", async () => {
    const whole = await readFile(path.join(HARDENING_DIR, "prores_hq.mov"));
    const bad = Buffer.from(whole);
    for (let i = Math.floor(bad.length * 0.3); i < Math.floor(bad.length * 0.6); i += 7) bad[i] = 0xff;
    await writeFile(path.join(R, "corrupt.mov"), bad);
    assert.ok((await decodeErrors(tools, path.join(R, "corrupt.mov"))).length > 0);
    assert.ok((await decodeErrors(tools, path.join(HARDENING_DIR, "truncated.mp4"))).length > 0);
    assert.deepEqual(await decodeErrors(tools, path.join(HARDENING_DIR, "cfr_30.mp4")), []);
  });
});

describe("known-bad audio against the approved stream", () => {
  const rate = 48000;
  let ref: Float32Array;
  const variant = async (name: string, filter: string | null, input = "anoisesrc=d=1.5:c=pink:r=48000:a=0.3:seed=7") => {
    const f = path.join(R, name);
    await ff("-f", "lavfi", "-i", input, ...(filter ? ["-af", filter] : []), "-c:a", name.endsWith(".mp4") ? "aac" : "pcm_s16le", ...(name.endsWith(".mp4") ? ["-b:a", "256k"] : []), f);
    return audioMono(tools, f, rate);
  };
  before(async () => {
    ref = await variant("a-ref.wav", null);
  });
  it("identical PCM is in sync; an AAC encode in MP4 (priming handled by the edit list) is still in sync", async () => {
    assert.equal(compareAudio(ref, await variant("a-same.wav", null), rate).verdict, "IN_SYNC");
    const aac = compareAudio(ref, await variant("a-aac.mp4", null), rate, { gainToleranceDb: 0.5 });
    assert.equal(aac.verdict, "IN_SYNC");
    assert.ok(!codes(aac.issues).includes("AUDIO_SYNC_DRIFT"));
  });
  it("a 40 ms offset is drift unless the container declares it", async () => {
    const late = await variant("a-late.wav", "adelay=40:all=1,atrim=0:1.5");
    const r = compareAudio(ref, late, rate);
    assert.equal(r.verdict, "SYNC_DRIFT");
    assert.equal(r.lagSamples, 1920);
    assert.equal(compareAudio(ref, late, rate, { containerOffsetSamples: 1920 }).verdict, "CODEC_PADDING");
  });
  it("gain change, inserted silence and replaced content are each reported", async () => {
    assert.ok(codes(compareAudio(ref, await variant("a-quiet.wav", "volume=-6dB"), rate).issues).includes("AUDIO_GAIN_CHANGED"));
    assert.ok(codes(compareAudio(ref, await variant("a-mute.wav", "volume=enable='between(t,0.6,0.9)':volume=0"), rate).issues).includes("AUDIO_SILENCE_ADDED"));
    assert.ok(codes(compareAudio(ref, await variant("a-other.wav", null, "anoisesrc=d=1.5:c=pink:r=48000:a=0.3:seed=99"), rate).issues).some((c) => c === "AUDIO_CONTENT_CHANGED" || c === "AUDIO_SYNC_DRIFT"));
  });
});

describe("single-pass decode (the decode hotspot fix)", () => {
  it("decodeFrames returns exactly the frames a full decode returns, for the whole file and for a range", async () => {
    const { decodeFrames } = await import("../../src/hardening/decode.ts");
    const f = path.join(HARDENING_DIR, "cfr_30.mp4");
    const { stdout } = await exec(tools.ffmpeg, ["-v", "error", "-i", f, "-map", "0:v:0", "-vf", "scale=80:45:flags=area,format=rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
    const n = 80 * 45 * 3;
    const all = await decodeFrames(tools, f, { width: 80, height: 45 });
    assert.equal(all.length, 30);
    assert.ok(all.every((fr, i) => Buffer.from(fr).equals(stdout.subarray(i * n, (i + 1) * n))));
    const part = await decodeFrames(tools, f, { from: 12, to: 20, width: 80, height: 45 });
    assert.equal(part.length, 8);
    assert.ok(part.every((fr, i) => Buffer.from(fr).equals(Buffer.from(all[12 + i]!))));
    await assert.rejects(decodeFrames(tools, path.join(HARDENING_DIR, "truncated.mp4"), { width: 80, height: 45 }), /FFMPEG_FAILED|ffmpeg decode frames/);
  });
});
