import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rational } from "../../src/time/rational.ts";
import {
  WarningList,
  analyzeFrameTiming,
  deriveStatus,
  displayGeometry,
  normalizeAudioStream,
  normalizeCreation,
  normalizeRotation,
  normalizeVideoStream,
  pickPrimary,
  streamRole,
  summarizeStreams,
} from "../../src/media/normalize.ts";

const dm = (rotation: number, type = "Display Matrix") => ({ side_data_list: [{ side_data_type: type, rotation }] });

describe("rotation", () => {
  it("converts ffprobe's counter-clockwise display matrix to a clockwise display turn", () => {
    assert.equal(normalizeRotation(dm(-90)).clockwiseToDisplay, 90); // iPhone portrait
    assert.equal(normalizeRotation(dm(90)).clockwiseToDisplay, 270);
    assert.equal(normalizeRotation(dm(180)).clockwiseToDisplay, 180);
    assert.equal(normalizeRotation(dm(-180)).clockwiseToDisplay, 180);
    assert.equal(normalizeRotation(dm(-90, "DisplayMatrix")).source, "displayMatrix");
  });

  it("falls back to the legacy clockwise rotate tag", () => {
    const r = normalizeRotation({ tags: { rotate: "90" } });
    assert.equal(r.clockwiseToDisplay, 90);
    assert.equal(r.source, "tag");
  });

  it("reports no rotation when there is none", () => {
    assert.deepEqual(normalizeRotation({}), {
      displayMatrixDegrees: null,
      tagDegrees: null,
      clockwiseToDisplay: 0,
      source: "none",
    });
  });
});

describe("display geometry", () => {
  it("swaps stored dimensions for 90/270 rotations (Payoff: 1280x720 -> portrait 720x1280)", () => {
    const g = displayGeometry(1280, 720, rational(1), 90);
    assert.deepEqual([g.displayWidth, g.displayHeight, g.orientation], [720, 1280, "portrait"]);
    assert.deepEqual(g.displayAspectRatio, rational(9, 16));
  });

  it("does not swap for 0/180", () => {
    const g = displayGeometry(1280, 720, rational(1), 180);
    assert.equal(g.orientation, "landscape");
  });

  it("applies the sample aspect ratio before rotation", () => {
    const g = displayGeometry(720, 480, rational(32, 27), 0);
    assert.deepEqual([g.displayWidth, g.displayHeight], [853, 480]);
    const r = displayGeometry(720, 480, rational(32, 27), 90);
    assert.deepEqual([r.displayWidth, r.displayHeight, r.orientation], [480, 853, "portrait"]);
  });

  it("classifies square frames", () => {
    assert.equal(displayGeometry(1080, 1080, rational(1), 0).orientation, "square");
  });
});

describe("frame-rate mode", () => {
  it("CFR with exact ticks", () => {
    const pts = Array.from({ length: 300 }, (_, i) => i * 1001); // 30000/1001 in 1/30000 tb
    const a = analyzeFrameTiming(pts, rational(1, 30000));
    assert.equal(a.mode.classification, "CFR");
    assert.deepEqual(a.measuredFrameRate, rational(30000, 1001));
  });

  it("CFR despite 1 ms timestamp rounding (29.97 in Matroska alternates 33/34 ms)", () => {
    const pts = Array.from({ length: 600 }, (_, i) => Math.round((i * 1001) / 30)); // ms
    const a = analyzeFrameTiming(pts, rational(1, 1000));
    assert.equal(a.mode.classification, "CFR");
    assert.equal(a.mode.distinctFrameDurations, 2);
  });

  it("VFR when intervals genuinely vary (phone footage)", () => {
    const pts: number[] = [];
    let t = 0;
    for (let i = 0; i < 200; i++) {
      pts.push(t);
      t += i % 5 === 0 ? 40 : 20; // 1/600 time base: 30 fps with dropped frames
    }
    const a = analyzeFrameTiming(pts, rational(1, 600));
    assert.equal(a.mode.classification, "VFR");
    assert.equal(a.mode.minFrameDurationTicks, 20);
    assert.equal(a.mode.maxFrameDurationTicks, 40);
  });

  it("is independent of decode (B-frame) order", () => {
    const pts = [0, 3003, 1001, 2002, 6006, 4004, 5005];
    assert.equal(analyzeFrameTiming(pts, rational(1, 30000)).mode.classification, "CFR");
  });

  it("UNKNOWN with too few packets", () => {
    assert.equal(analyzeFrameTiming([0, 1], rational(1, 30)).mode.classification, "UNKNOWN");
    assert.equal(analyzeFrameTiming([], rational(1, 30)).mode.method, "none");
  });
});

describe("stream roles", () => {
  it("attached_pic video streams are cover art, not footage", () => {
    assert.equal(
      streamRole({ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }),
      "attachedPicture",
    );
  });

  it("single-frame image codecs without the flag are still images", () => {
    assert.equal(streamRole({ codec_type: "video", codec_name: "png", nb_frames: "1" }), "stillImage");
  });

  it("motion JPEG with a real frame rate is footage", () => {
    assert.equal(
      streamRole({ codec_type: "video", codec_name: "mjpeg", nb_frames: "250", avg_frame_rate: "25/1" }),
      "footage",
    );
  });

  it("picks the default-flagged stream, else the lowest index", () => {
    const s = summarizeStreams([
      { index: 2, codec_type: "audio", codec_name: "aac", disposition: { default: 1 } },
      { index: 1, codec_type: "audio", codec_name: "aac", disposition: { default: 0 } },
      { index: 0, codec_type: "video", codec_name: "h264", disposition: {} },
    ]);
    assert.deepEqual(s.map((x) => x.index), [0, 1, 2]);
    assert.equal(pickPrimary(s, "audio"), 2);
    assert.equal(pickPrimary(s, "footage"), 0);
    assert.equal(pickPrimary(s, "attachedPicture"), null);
  });
});

describe("video stream normalization", () => {
  const payoff = {
    index: 1,
    codec_type: "video",
    codec_name: "h264",
    profile: "High",
    width: 1280,
    height: 720,
    sample_aspect_ratio: "1:1",
    r_frame_rate: "30/1",
    avg_frame_rate: "9048/331",
    time_base: "1/600",
    start_time: "0.000000",
    duration: "13.791667",
    nb_frames: "377",
    side_data_list: [{ side_data_type: "DisplayMatrix", rotation: -90 }],
  };

  it("keeps rotation, portrait display and both frame rates", () => {
    const pts: number[] = [];
    let t = 0;
    for (let i = 0; i < 377; i++) {
      pts.push(t);
      t += i % 4 === 0 ? 40 : 20;
    }
    const w = new WarningList();
    const v = normalizeVideoStream(payoff, pts, w)!;
    assert.deepEqual([v.storedWidth, v.storedHeight, v.displayWidth, v.displayHeight], [1280, 720, 720, 1280]);
    assert.equal(v.orientation, "portrait");
    assert.deepEqual(v.nominalFrameRate, rational(30));
    assert.deepEqual(v.averageFrameRate, rational(9048, 331));
    assert.equal(v.frameRateMode.classification, "VFR");
    assert.equal(v.frameCount.value, 377);
    assert.equal(v.frameCount.reliable, true);
    const codes = w.items.map((x) => x.code);
    for (const c of ["ROTATION_METADATA", "VARIABLE_FRAME_RATE", "NOMINAL_AVERAGE_RATE_MISMATCH"] as const) {
      assert.ok(codes.includes(c), `missing ${c}`);
    }
  });

  it("flags frame-count disagreement and unknown SAR", () => {
    const w = new WarningList();
    const v = normalizeVideoStream(
      { ...payoff, sample_aspect_ratio: "0:1", nb_frames: "380", side_data_list: [] },
      Array.from({ length: 377 }, (_, i) => i * 20),
      w,
    )!;
    assert.equal(v.frameCount.reliable, false);
    assert.equal(v.sampleAspectRatioKnown, false);
    const codes = w.items.map((x) => x.code);
    assert.ok(codes.includes("FRAME_COUNT_MISMATCH"));
    assert.ok(codes.includes("UNKNOWN_SAMPLE_ASPECT_RATIO"));
  });

  it("returns null for malformed streams instead of guessing", () => {
    assert.equal(normalizeVideoStream({ index: 0, codec_type: "video" }, null, new WarningList()), null);
  });
});

describe("audio, creation and status", () => {
  it("normalizes audio", () => {
    const a = normalizeAudioStream({
      index: 0,
      codec_name: "mp3",
      sample_rate: "44100",
      channels: 2,
      channel_layout: "stereo",
      bit_rate: "320000",
      time_base: "1/14112000",
    })!;
    assert.deepEqual([a.sampleRate, a.channels, a.channelLayout, a.bitRate], [44100, 2, "stereo", 320000]);
  });

  it("prefers the QuickTime creation date", () => {
    const c = normalizeCreation(
      { tags: { creation_time: "2024-10-21T01:00:22Z", "com.apple.quicktime.creationdate": "2024-10-20T18:00:22-0700" } },
      [],
    );
    assert.equal(c.time, "2024-10-20T18:00:22-0700");
    assert.equal(c.timeSource, "format.tags.com.apple.quicktime.creationdate");
  });

  const video = { durationSeconds: rational(2), averageFrameRate: rational(30), nominalFrameRate: rational(30) } as never;
  const audio = { durationSeconds: rational(2) } as never;
  const base = { attachedPictureCount: 0, decodeOk: true, containerDuration: rational(2) };

  it("maps each situation to an explicit status", () => {
    const cases: Array<[Parameters<typeof deriveStatus>[0], string, string]> = [
      [{ ...base, extension: ".mp4", footage: video, audio }, "OK", "video"],
      [{ ...base, extension: ".mov", footage: null, audio }, "AUDIO_ONLY", "audio"],
      [{ ...base, extension: ".mp4", footage: null, audio: null, attachedPictureCount: 1 }, "ATTACHED_PICTURE_ONLY", "unknown"],
      [{ ...base, extension: ".mkv", footage: null, audio: null }, "NO_VIDEO_STREAM", "unknown"],
      [{ ...base, extension: ".mp3", footage: null, audio, attachedPictureCount: 1 }, "OK", "audio"],
      [{ ...base, extension: ".mp3", footage: null, audio: null, attachedPictureCount: 1 }, "ATTACHED_PICTURE_ONLY", "unknown"],
      [{ ...base, extension: ".wav", footage: null, audio: null }, "NO_AUDIO_STREAM", "unknown"],
      [{ ...base, extension: ".mp4", footage: video, audio, decodeOk: false }, "DECODE_FAILED", "video"],
      [{ ...base, extension: ".mp4", footage: { ...(video as object), durationSeconds: null } as never, audio, containerDuration: null }, "METADATA_INCONSISTENT", "video"],
      [{ ...base, extension: ".txt", footage: null, audio: null }, "UNSUPPORTED", "unknown"],
    ];
    for (const [input, status, kind] of cases) {
      const r = deriveStatus(input);
      assert.equal(r.status, status, `${input.extension} -> ${status}`);
      assert.equal(r.kind, kind);
    }
  });
});
