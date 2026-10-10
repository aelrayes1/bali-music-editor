import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { mediaIdFromFingerprint, sampledFingerprint } from "../../src/media/fingerprint.ts";
import { resolveDuplicates } from "../../src/media/manifest.ts";
import { MediaEntrySchema, MediaManifestSchema } from "../../src/media/schema.ts";
import { SourcesConfigSchema, compareCodepoints, discoverFiles } from "../../src/media/sources.ts";
import { frameIndexOfPts, framePtsAt, sampleTimes } from "../../src/media/frames.ts";
import { rational } from "../../src/time/rational.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bali-unit-"));
  await writeFile(path.join(dir, "a.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  await writeFile(path.join(dir, "b.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  const c = Buffer.alloc(3 * 1024 * 1024, 7);
  c[c.length - 1] = 8;
  await writeFile(path.join(dir, "c.bin"), c);
});
after(async () => rm(dir, { recursive: true, force: true }));

describe("stable content IDs", () => {
  it("same content -> same ID regardless of name or location", async () => {
    const a = await sampledFingerprint(path.join(dir, "a.bin"));
    const b = await sampledFingerprint(path.join(dir, "b.bin"));
    assert.equal(a, b);
    assert.match(mediaIdFromFingerprint(a), /^m_[0-9a-f]{16}$/);
  });

  it("different content -> different ID", async () => {
    const a = await sampledFingerprint(path.join(dir, "a.bin"));
    const c = await sampledFingerprint(path.join(dir, "c.bin"));
    assert.notEqual(a, c);
  });
});

describe("source discovery", () => {
  it("orders deterministically and reports missing listed files instead of dropping them", async () => {
    const cfg = SourcesConfigSchema.parse({
      schemaVersion: 1,
      sourceRoots: [
        { id: "z-root", path: dir, include: ["*.bin"] },
        { id: "a-root", path: dir, files: ["c.bin", "missing (1).mov"] },
      ],
    });
    const files = await discoverFiles(cfg);
    assert.deepEqual(
      files.map((f) => `${f.rootId}/${f.relativePath}:${f.exists}`),
      ["a-root/c.bin:true", "a-root/missing (1).mov:false", "z-root/a.bin:true", "z-root/b.bin:true", "z-root/c.bin:true"],
    );
  });

  it("rejects configs with duplicate ids or no selection", () => {
    assert.throws(() =>
      SourcesConfigSchema.parse({ schemaVersion: 1, sourceRoots: [{ id: "x", path: "/", include: ["*"] }, { id: "x", path: "/", include: ["*"] }] }),
    );
    assert.throws(() => SourcesConfigSchema.parse({ schemaVersion: 1, sourceRoots: [{ id: "x", path: "/" }] }));
  });

  it("uses codepoint (locale-independent) ordering", () => {
    assert.deepEqual(["b", "B", "a", "_"].sort(compareCodepoints), ["B", "_", "a", "b"]);
  });
});

function entry(id: string, rel: string) {
  return MediaEntrySchema.parse({
    mediaId: id,
    contentFingerprint: { algorithm: "sha256-sampled-v1", value: "a".repeat(64) },
    fullSha256: null,
    duplicateOf: null,
    source: { rootId: "r", relativePath: rel, absolutePath: `/x/${rel}`, fileName: rel, extension: ".wav", sizeBytes: 1, modifiedAt: null },
    kind: "audio",
    status: "OK",
    statusDetail: null,
    warnings: [],
    container: null,
    creation: { time: null, timeSource: null, make: null, model: null, software: null, encoder: null },
    streams: [],
    video: null,
    audio: null,
    attachedPictures: [],
    hasAudio: true,
    isPlayableVideoFootage: false,
    decodeCheck: { mode: "skipped", ok: null, messages: [] },
  });
}

describe("manifest schema", () => {
  it("gives duplicates unique deterministic IDs that point at the first copy", () => {
    const es = [entry("m_0123456789abcdef", "a.wav"), entry("m_0123456789abcdef", "b.wav")];
    resolveDuplicates(es);
    assert.equal(es[0]!.duplicateOf, null);
    assert.equal(es[1]!.duplicateOf, "m_0123456789abcdef");
    assert.match(es[1]!.mediaId, /^m_0123456789abcdef-dup-[0-9a-f]{8}$/);
    assert.equal(es[1]!.warnings[0]!.code, "DUPLICATE_CONTENT");
  });

  it("rejects float seconds and unknown fields", () => {
    const e = entry("m_0123456789abcdef", "a.wav");
    assert.throws(() => MediaEntrySchema.parse({ ...e, container: { formatName: "wav", formatLongName: null, durationSeconds: 1.5, startTimeSeconds: null, bitRate: null } }));
    assert.throws(() => MediaEntrySchema.parse({ ...e, extra: true }));
    assert.throws(() => MediaEntrySchema.parse({ ...e, status: "FINE" }));
  });

  it("validates a whole manifest", () => {
    const m = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-09-27T00:00:00.000Z",
      generator: { name: "bali-media-foundation", version: "0.1.0", ffprobe: { path: "/opt/local/bin/ffprobe", version: "9.0.2" } },
      sourceRoots: [{ id: "r", path: "/x" }],
      summary: { total: 1, byStatus: { OK: 1 }, byKind: { audio: 1 } },
      media: [entry("m_0123456789abcdef", "a.wav")],
    };
    assert.doesNotThrow(() => MediaManifestSchema.parse(m));
    assert.throws(() => MediaManifestSchema.parse({ ...m, schemaVersion: "0.9.0" }));
  });
});

describe("frame-grid helpers", () => {
  it("samples slice centres exactly", () => {
    assert.deepEqual(sampleTimes(rational(0), rational(12), 4), [rational(3, 2), rational(9, 2), rational(15, 2), rational(21, 2)]);
    assert.throws(() => sampleTimes(rational(0), rational(1), 0), RangeError);
  });

  it("picks the frame on screen at a time (last frame starting at or before it)", () => {
    const pts = [0, 512, 1024, 15360, 16384]; // 1/15360 time base
    const tb = rational(1, 15360);
    assert.equal(framePtsAt(pts, tb, rational(0)), 0);
    assert.equal(framePtsAt(pts, tb, rational(600, 15360)), 512); // between frames -> earlier frame
    assert.equal(framePtsAt(pts, tb, rational(1024, 15360)), 1024); // exactly on a frame start
    assert.equal(framePtsAt(pts, tb, rational(1)), 15360);
    assert.equal(framePtsAt(pts, tb, rational(-1)), 0); // before the first frame -> first frame
    assert.equal(framePtsAt(pts, tb, rational(99)), 16384);
  });

  it("finds a frame's presentation index by pts", () => {
    const pts = [0, 20, 40, 80, 100];
    assert.equal(frameIndexOfPts(pts, 80), 3);
    assert.equal(frameIndexOfPts(pts, 60), null);
  });
});
