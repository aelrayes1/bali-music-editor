/**
 * Phase 12 media hardening corpus: ~30 tiny deterministic cases (well under 1 MB each, ~2 MB total),
 * generated with the verified system FFmpeg into .cache/hardening-fixtures (gitignored). Each case carries
 * the properties ingest must report for it. No real or copyrighted media.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.BALI_FFMPEG ?? "/opt/local/bin/ffmpeg";
export const HARDENING_DIR = path.resolve(".cache/hardening-fixtures");

async function ff(...args: string[]): Promise<void> {
  await run(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args]);
}
const x264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-threads", "1"];
const src = (s: string, r: string, d = 1) => ["-f", "lavfi", "-i", `testsrc2=s=${s}:r=${r}:d=${d}`];
const tone = (d = 1, f = 440, rate = 48000) => ["-f", "lavfi", "-i", `sine=f=${f}:sample_rate=${rate}:d=${d}`];
const aac = ["-c:a", "aac", "-b:a", "64k"];

export interface CaseExpect {
  status: string;
  kind?: string;
  /** warning codes that must be present */
  warnings?: string[];
  /** warning codes that must NOT be present */
  notWarnings?: string[];
  display?: [number, number];
  stored?: [number, number];
  rotationCw?: 0 | 90 | 180 | 270;
  orientation?: "landscape" | "portrait" | "square";
  frameRateMode?: "CFR" | "VFR";
  frames?: number;
  /** nominal fps as "num/den" */
  fps?: string;
  hasAudio?: boolean;
  sampleRate?: number;
  channels?: number;
  colour?: { range?: string | null; space?: string | null; transfer?: string | null; primaries?: string | null; hdrTransfer?: boolean };
  startSeconds?: number;
  playable?: boolean;
  duplicateOf?: string;
  codec?: string;
}

export interface FixtureCase {
  name: string;
  /** what the case exercises */
  why: string;
  make: (out: string, part: (n: string) => string) => Promise<void>;
  expect: CaseExpect;
}

// libx264 writes primaries / transfer into the VUI only via -x264-params (container flags alone are dropped:
// ffprobe then reports "unknown"), exactly as the production deliveries do it
const vui = (p: string, t: string, m: string) => ["-x264-params", `colorprim=${p}:transfer=${t}:colormatrix=${m}`];
const tags709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];

export const CASES: FixtureCase[] = [
  { name: "cfr_30.mp4", why: "baseline CFR 30 fps with audio, BT.709 tagged", make: (o) => ff(...src("160x90", "30"), ...tone(), ...x264, ...tags709, ...vui("bt709", "bt709", "bt709"), ...aac, "-shortest", o), expect: { status: "OK", frameRateMode: "CFR", frames: 30, fps: "30/1", display: [160, 90], orientation: "landscape", hasAudio: true, colour: { primaries: "bt709", transfer: "bt709", space: "bt709", range: "tv", hdrTransfer: false } } },
  { name: "cfr_2997.mp4", why: "NTSC 30000/1001", make: (o) => ff(...src("160x90", "30000/1001"), ...x264, o), expect: { status: "OK", frameRateMode: "CFR", fps: "30000/1001", warnings: ["NO_AUDIO"] } },
  { name: "cfr_25.mkv", why: "PAL 25 fps in Matroska", make: (o) => ff(...src("160x90", "25"), ...tone(), ...x264, ...aac, "-shortest", o), expect: { status: "OK", frameRateMode: "CFR", fps: "25/1", frames: 25 } },
  { name: "cfr_24.mov", why: "cinema 24 fps", make: (o) => ff(...src("160x90", "24"), ...x264, o), expect: { status: "OK", frameRateMode: "CFR", fps: "24/1", frames: 24 } },
  { name: "cfr_60.mp4", why: "high frame rate 60 fps", make: (o) => ff(...src("160x90", "60"), ...x264, o), expect: { status: "OK", frameRateMode: "CFR", fps: "60/1", frames: 60 } },
  {
    name: "vfr_30_15.mp4",
    why: "variable frame rate: 30 fps then 15 fps",
    make: async (o, part) => {
      await ff(...src("160x90", "30", 0.5), ...x264, part("a30.mp4"));
      await ff(...src("160x90", "15", 0.5), ...x264, part("b15.mp4"));
      await writeFile(part("vfr.txt"), `file '${part("a30.mp4")}'\nfile '${part("b15.mp4")}'\n`);
      await ff("-f", "concat", "-safe", "0", "-i", part("vfr.txt"), "-c", "copy", o);
    },
    expect: { status: "OK", frameRateMode: "VFR", warnings: ["VARIABLE_FRAME_RATE"] },
  },
  { name: "vfr_rotated_cw90.mov", why: "VFR + rotation metadata together", make: (o, part) => ff("-display_rotation:v:0", "-90", "-i", part("../vfr_30_15.mp4"), "-c", "copy", o), expect: { status: "OK", frameRateMode: "VFR", rotationCw: 90, display: [90, 160], orientation: "portrait", warnings: ["VARIABLE_FRAME_RATE", "ROTATION_METADATA"] } },
  { name: "rot_cw90.mov", why: "iPhone-style: stored landscape, displayed portrait", make: async (o, part) => { await ff(...src("160x90", "30"), ...x264, part("land.mov")); await ff("-display_rotation:v:0", "-90", "-i", part("land.mov"), "-c", "copy", o); }, expect: { status: "OK", rotationCw: 90, stored: [160, 90], display: [90, 160], orientation: "portrait", warnings: ["ROTATION_METADATA"] } },
  { name: "rot_180.mov", why: "upside-down capture", make: (o, part) => ff("-display_rotation:v:0", "180", "-i", part("land.mov"), "-c", "copy", o), expect: { status: "OK", rotationCw: 180, display: [160, 90], orientation: "landscape", warnings: ["ROTATION_METADATA"] } },
  { name: "rot_cw270.mov", why: "rotated the other way", make: (o, part) => ff("-display_rotation:v:0", "90", "-i", part("land.mov"), "-c", "copy", o), expect: { status: "OK", rotationCw: 270, display: [90, 160], orientation: "portrait", warnings: ["ROTATION_METADATA"] } },
  { name: "portrait_native.mp4", why: "stored portrait, no rotation (must NOT be rotated again)", make: (o) => ff(...src("90x160", "30"), ...x264, o), expect: { status: "OK", rotationCw: 0, stored: [90, 160], display: [90, 160], orientation: "portrait", notWarnings: ["ROTATION_METADATA"] } },
  { name: "portrait_tagged_rot90.mov", why: "double-rotation trap: pixels already upright portrait AND tagged 90° (displays landscape)", make: async (o, part) => { await ff(...src("90x160", "30"), ...x264, part("port.mov")); await ff("-display_rotation:v:0", "-90", "-i", part("port.mov"), "-c", "copy", o); }, expect: { status: "OK", rotationCw: 90, stored: [90, 160], display: [160, 90], orientation: "landscape", warnings: ["ROTATION_METADATA"] } },
  { name: "square.mp4", why: "1:1 frame", make: (o) => ff(...src("128x128", "30"), ...x264, o), expect: { status: "OK", display: [128, 128], orientation: "square" } },
  { name: "anamorphic.mp4", why: "non-square pixels (SAR 32/27)", make: (o) => ff(...src("144x96", "30"), "-vf", "setsar=32/27", ...x264, o), expect: { status: "OK", warnings: ["NON_SQUARE_PIXELS"], stored: [144, 96], display: [171, 96] } },
  { name: "hevc_10bit_pq.mp4", why: "HEVC 10-bit HDR (PQ / BT.2020): must be flagged, never silently graded as SDR", make: (o) => ff(...src("160x96", "30"), "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-x265-params", "log-level=none:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-tag:v", "hvc1", o), expect: { status: "OK", codec: "hevc", warnings: ["HDR_TRANSFER"], colour: { transfer: "smpte2084", primaries: "bt2020", hdrTransfer: true } } },
  { name: "hlg_tagged.mov", why: "HLG transfer tag", make: (o) => ff(...src("160x90", "30"), ...x264, "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", ...vui("bt2020", "arib-std-b67", "bt2020nc"), o), expect: { status: "OK", warnings: ["HDR_TRANSFER"], colour: { transfer: "arib-std-b67", hdrTransfer: true } } },
  { name: "untagged.mp4", why: "no colour tags at all (must not be assumed silently)", make: (o) => ff(...src("160x90", "30"), ...x264, o), expect: { status: "OK", colour: { transfer: null, primaries: null, hdrTransfer: false } } },
  { name: "full_range.mp4", why: "full-range (pc) luma tagged", make: (o) => ff(...src("160x90", "30"), "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-preset", "ultrafast", "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", ...vui("bt709", "bt709", "bt709"), o), expect: { status: "OK", colour: { range: "pc", primaries: "bt709" } } },
  { name: "bt601.mp4", why: "SD BT.601 (smpte170m) tagged", make: (o) => ff(...src("160x90", "30"), ...x264, "-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-colorspace", "smpte170m", ...vui("smpte170m", "smpte170m", "smpte170m"), o), expect: { status: "OK", colour: { primaries: "smpte170m", transfer: "smpte170m", space: "smpte170m" } } },
  { name: "prores_hq.mov", why: "ProRes 422 HQ intermediate", make: (o) => ff(...src("160x90", "30"), "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", ...tags709, o), expect: { status: "OK", codec: "prores", frameRateMode: "CFR", frames: 30 } },
  { name: "interlaced.mp4", why: "interlaced (top field first) must be flagged", make: (o) => ff(...src("160x96", "30"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-flags", "+ildct+ilme", "-x264-params", "tff=1", o), expect: { status: "OK", warnings: ["INTERLACED"] } },
  { name: "start_offset.mp4", why: "non-zero start timestamp (2 s)", make: (o) => ff(...src("160x90", "30"), ...x264, "-output_ts_offset", "2", o), expect: { status: "OK", startSeconds: 2 } },
  { name: "av_length_mismatch.mov", why: "audio 2 s vs video 0.5 s in one container", make: (o) => ff(...src("160x90", "30", 0.5), ...tone(2), ...x264, ...aac, o), expect: { status: "OK", hasAudio: true, warnings: ["DURATION_MISMATCH"] } },
  { name: "multi_audio.mov", why: "two audio streams (primary picked, warned)", make: (o) => ff(...src("160x90", "30"), ...tone(1, 440), ...tone(1, 660), "-map", "0:v", "-map", "1:a", "-map", "2:a", ...x264, ...aac, o), expect: { status: "OK", warnings: ["MULTIPLE_AUDIO_STREAMS"], hasAudio: true } },
  { name: "audio_only.mov", why: "video container with only audio", make: (o) => ff(...tone(1, 550), ...aac, o), expect: { status: "AUDIO_ONLY", playable: false } },
  { name: "mono_44k.wav", why: "mono 44.1 kHz song file", make: (o) => ff(...tone(1, 440, 44100), "-ac", "1", "-c:a", "pcm_s16le", o), expect: { status: "OK", kind: "audio", sampleRate: 44100, channels: 1 } },
  { name: "stereo_96k.wav", why: "high sample rate song file", make: (o) => ff(...tone(1, 440, 96000), "-ac", "2", "-c:a", "pcm_s24le", o), expect: { status: "OK", kind: "audio", sampleRate: 96000, channels: 2 } },
  {
    name: "song_with_cover.mp3",
    why: "MP3 with embedded cover art (cover is not footage)",
    make: async (o, part) => {
      await ff(...src("64x64", "1"), "-frames:v", "1", part("cover.png"));
      await ff(...tone(1), "-i", part("cover.png"), "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-id3v2_version", "3", o);
    },
    expect: { status: "OK", kind: "audio", warnings: ["ATTACHED_PICTURE_PRESENT"], playable: false },
  },
  {
    name: "truncated.mp4",
    why: "interrupted copy: the first 40% of a file whose index (moov) is at the end",
    make: async (o, part) => {
      await ff(...src("160x90", "30"), ...x264, part("whole.mp4"));
      const b = await readFile(part("whole.mp4"));
      await writeFile(o, b.subarray(0, Math.floor(b.length * 0.4)));
    },
    expect: { status: "MALFORMED", playable: false },
  },
  { name: "zero_bytes.mov", why: "empty file", make: (o) => writeFile(o, Buffer.alloc(0)), expect: { status: "MALFORMED", playable: false } },
  { name: "notes.txt", why: "non-media file in a source folder", make: (o) => writeFile(o, "not media\n"), expect: { status: "UNSUPPORTED", playable: false } },
  { name: "zz_duplicate_of_cfr_30.mp4", why: "byte-identical copy of another source", make: (o) => copyFile(path.join(HARDENING_DIR, "cfr_30.mp4"), o), expect: { status: "OK", warnings: ["DUPLICATE_CONTENT"], duplicateOf: "cfr_30.mp4" } },
];

/** Generate every case (order matters: a few derive from earlier ones). Returns the directory. */
export async function generateHardeningFixtures(): Promise<string> {
  const d = HARDENING_DIR;
  await rm(d, { recursive: true, force: true });
  await mkdir(path.join(d, "_parts"), { recursive: true });
  const part = (n: string) => path.join(d, "_parts", n);
  for (const c of CASES) await c.make(path.join(d, c.name), part);
  await rm(path.join(d, "_parts"), { recursive: true, force: true });
  return d;
}
