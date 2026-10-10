import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";
import { resolveMediaTools, type MediaTools } from "../../src/media/ffmpeg.ts";
import { NotFootageError, contactSheet } from "../../src/media/frames.ts";
import { buildManifest, deterministicView } from "../../src/media/manifest.ts";
import type { MediaEntry, MediaManifest } from "../../src/media/schema.ts";
import { SourcesConfigSchema } from "../../src/media/sources.ts";
import { compare, mul, rational } from "../../src/time/rational.ts";
import { generateFixtures } from "../helpers/fixtures.ts";

const exec = promisify(execFile);
async function decodedFrameCount(file: string): Promise<number> {
  const { stdout } = await exec("/opt/local/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}
async function packetTimes(file: string): Promise<number[]> {
  const { stdout } = await exec("/opt/local/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-of", "csv=p=0", file]);
  return stdout.trim().split("\n").map(Number).sort((a, b) => a - b);
}

let tools: MediaTools;
let manifest: MediaManifest;
let fixtureDir: string;

const config = () =>
  SourcesConfigSchema.parse({
    schemaVersion: 1,
    sourceRoots: [{ id: "fixtures", path: fixtureDir, include: ["*"], files: ["not-there (1).mov"] }],
  });

function byName(name: string): MediaEntry {
  const e = manifest.media.find((m) => m.source.relativePath === name);
  assert.ok(e, `missing ${name}`);
  return e;
}

const codes = (e: MediaEntry) => e.warnings.map((w) => w.code);

before(async () => {
  tools = await resolveMediaTools();
  fixtureDir = await generateFixtures();
  manifest = await buildManifest(tools, config(), { now: () => "2026-01-01T00:00:00.000Z" });
});

describe("synthetic media acceptance", () => {
  it("ingests every file without silently dropping any", () => {
    assert.equal(manifest.media.length, 14); // 13 fixture files + 1 listed-but-missing file
    assert.deepEqual(manifest.summary.byStatus, {
      AUDIO_ONLY: 1,
      MALFORMED: 1,
      OK: 10,
      READ_FAILED: 1,
      UNSUPPORTED: 1,
    });
  });

  it("CFR landscape keeps the exact 30000/1001 rate", async () => {
    const e = byName("cfr_landscape.mp4");
    const v = e.video!;
    assert.deepEqual(v.nominalFrameRate, rational(30000, 1001));
    assert.deepEqual(v.averageFrameRate, rational(30000, 1001));
    assert.equal(v.frameRateMode.classification, "CFR");
    assert.equal(v.orientation, "landscape");
    assert.equal(v.frameCount.value, await decodedFrameCount(e.source.absolutePath)); // independent oracle
    assert.equal(v.frameCount.reliable, true);
  });

  it("stored-portrait clip is portrait without rotation", () => {
    const v = byName("portrait_stored.mov").video!;
    assert.deepEqual([v.displayWidth, v.displayHeight, v.orientation, v.rotation.clockwiseToDisplay], [360, 640, "portrait", 0]);
  });

  it("rotated clip reports stored AND displayed dimensions", () => {
    const e = byName("rotated_cw90.mov");
    const v = e.video!;
    assert.deepEqual([v.storedWidth, v.storedHeight], [640, 360]);
    assert.deepEqual([v.displayWidth, v.displayHeight], [360, 640]);
    assert.equal(v.orientation, "portrait");
    assert.equal(v.rotation.displayMatrixDegrees, -90);
    assert.equal(v.rotation.clockwiseToDisplay, 90);
    assert.ok(codes(e).includes("ROTATION_METADATA"));
  });

  it("VFR clip is classified VFR, with nominal and average rates kept separately", () => {
    const e = byName("vfr.mp4");
    const v = e.video!;
    assert.equal(v.frameRateMode.classification, "VFR");
    assert.equal(v.frameCount.value, 45);
    assert.ok(v.nominalFrameRate && v.averageFrameRate);
    assert.notDeepEqual(v.nominalFrameRate, v.averageFrameRate);
    assert.ok(codes(e).includes("VARIABLE_FRAME_RATE"));
  });

  it("rotation and VFR together", () => {
    const v = byName("vfr_rotated.mov").video!;
    assert.equal(v.frameRateMode.classification, "VFR");
    assert.equal(v.orientation, "portrait");
    assert.equal(v.rotation.clockwiseToDisplay, 90);
  });

  it("MP3 cover art is detected and never treated as footage", () => {
    const e = byName("song_with_cover.mp3");
    assert.equal(e.status, "OK");
    assert.equal(e.kind, "audio");
    assert.equal(e.video, null);
    assert.equal(e.isPlayableVideoFootage, false);
    assert.equal(e.attachedPictures.length, 1);
    assert.equal(e.attachedPictures[0]!.role, "attachedPicture");
    assert.ok(e.streams.some((s) => s.codecType === "video" && s.role === "attachedPicture"));
    assert.ok(codes(e).includes("ATTACHED_PICTURE_PRESENT"));
  });

  it("audio-only WAV", () => {
    const e = byName("tone.wav");
    assert.deepEqual([e.status, e.kind, e.audio!.sampleRate, e.audio!.channels], ["OK", "audio", 48000, 2]);
    assert.equal(e.video, null);
  });

  it("MKV archive source", () => {
    const e = byName("archive_25.mkv");
    assert.equal(e.status, "OK");
    assert.deepEqual(e.video!.nominalFrameRate, rational(25));
    assert.equal(e.video!.frameRateMode.classification, "CFR");
    assert.equal(e.container!.formatName, "matroska,webm");
  });

  it("non-square pixels change the displayed width", () => {
    const v = byName("anamorphic.mp4").video!;
    assert.deepEqual(v.sampleAspectRatio, rational(32, 27));
    assert.deepEqual([v.storedWidth, v.displayWidth, v.displayHeight], [720, 853, 480]);
  });

  it("explicit error states instead of crashes", () => {
    assert.equal(byName("audio_only.mov").status, "AUDIO_ONLY");
    assert.equal(byName("broken.mp4").status, "MALFORMED");
    assert.equal(byName("notes.txt").status, "UNSUPPORTED");
    const missing = byName("not-there (1).mov");
    assert.equal(missing.status, "READ_FAILED");
  });

  it("identical content gets a deterministic duplicate ID", () => {
    const dup = byName("zz_duplicate_of_cfr.mp4");
    assert.equal(dup.duplicateOf, byName("cfr_landscape.mp4").mediaId);
    assert.ok(dup.mediaId.startsWith(`${dup.duplicateOf}-dup-`));
  });

  it("repeated runs are identical apart from generatedAt", async () => {
    const again = await buildManifest(tools, config(), { now: () => "2099-12-31T23:59:59.999Z" });
    assert.equal(deterministicView(again), deterministicView(manifest));
    assert.notEqual(again.generatedAt, manifest.generatedAt);
  });
});

describe("frame grids on synthetic media", () => {
  it("rotated clip produces portrait cells mapped to real frames", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "bali-sheet-"));
    try {
      const r = await contactSheet(tools, byName("rotated_cw90.mov"), { cols: 3, rows: 2, cellWidth: 120, outDir: out });
      assert.equal(r.cells.length, 6);
      const { stdout } = await promisify(execFile)("/opt/local/bin/ffprobe", [
        "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", r.cells[0]!.file,
      ]);
      const [w, h] = stdout.trim().split(",").map(Number);
      assert.ok(h! > w!, `cell should be portrait, got ${w}x${h}`);
      const idx = r.cells.map((c) => c.frameIndex);
      assert.ok(idx.every((i) => i !== null));
      assert.deepEqual([...idx].sort((a, b) => a! - b!), idx, "cells in time order");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("refuses to sample cover art", async () => {
    await assert.rejects(
      contactSheet(tools, byName("song_with_cover.mp3"), { cols: 2, rows: 1, cellWidth: 100, outDir: tmpdir() }),
      NotFootageError,
    );
  });

  it("VFR clip maps each cell to the frame actually on screen at its time", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "bali-sheet-"));
    try {
      const e = byName("vfr.mp4");
      const r = await contactSheet(tools, e, { cols: 4, rows: 1, cellWidth: 96, outDir: out });
      // Independent oracle: packet times straight from ffprobe.
      const times = (await packetTimes(e.source.absolutePath)).map((pts) => mul(rational(pts), e.video!.timeBase));
      for (const c of r.cells) {
        const i = c.frameIndex!;
        assert.equal(compare(times[i]!, c.frameSeconds), 0, "index and time agree");
        assert.ok(compare(c.frameSeconds, c.requestedSeconds) <= 0, "frame starts at or before the request");
        if (i + 1 < times.length) assert.ok(compare(c.requestedSeconds, times[i + 1]!) < 0, "next frame starts after it");
      }
      // Frames 0-29: the 30 fps second; 30-44: the 15 fps second.
      assert.deepEqual(r.cells.map((c) => c.frameIndex), [7, 21, 33, 40]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
