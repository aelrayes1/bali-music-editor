/**
 * Pure normalization of ffprobe output into manifest entries.
 *
 * No I/O here: every function takes plain data so the rules (rotation, display dimensions,
 * VFR classification, stream roles, status) are unit-testable without media files.
 */

import {
  type Rational,
  abs,
  compare,
  div,
  equals,
  mul,
  parseDecimal,
  parseRatio,
  rational,
  roundHalfUp,
  sub,
  toDecimalString,
} from "../time/rational.ts";
import type {
  AttachedPicture,
  AudioStream,
  FrameRateMode,
  MediaKind,
  MediaStatus,
  Rotation,
  StreamSummary,
  VideoStream,
  Warning,
  WarningCode,
} from "./schema.ts";

type Obj = Record<string, unknown>;

export const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".mkv"]);
export const AUDIO_EXTENSIONS = new Set([".wav", ".mp3"]);
const IMAGE_CODECS = new Set(["mjpeg", "png", "bmp", "tiff", "webp", "gif", "jpegls", "jpeg2000"]);
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const INTERLACED_ORDERS = new Set(["tt", "bb", "tb", "bt"]);

/** Fraction of frame intervals allowed to deviate before a stream is called VFR. */
export const VFR_DEVIATION_THRESHOLD = rational(1, 200);
/** Nominal vs average rate difference that is reported (relative). */
export const RATE_MISMATCH_THRESHOLD = rational(1, 1000);

// ---------------------------------------------------------------------------
// Small typed accessors over untyped ffprobe JSON
// ---------------------------------------------------------------------------

function str(o: Obj | undefined, key: string): string | null {
  const v = o?.[key];
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === "" || s === "N/A" || s === "unknown" ? null : s;
}

function int(o: Obj | undefined, key: string): number | null {
  const s = str(o, key);
  if (s === null) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function dec(o: Obj | undefined, key: string): Rational | null {
  const s = str(o, key);
  if (s === null) return null;
  try {
    return parseDecimal(s);
  } catch {
    return null;
  }
}

function ratio(o: Obj | undefined, key: string): Rational | null {
  try {
    return parseRatio(str(o, key));
  } catch {
    return null;
  }
}

function obj(o: Obj | undefined, key: string): Obj | undefined {
  const v = o?.[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}

function tagLookup(tags: Obj | undefined, ...keys: string[]): string | null {
  if (!tags) return null;
  const lower = new Map(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower.get(k.toLowerCase());
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rotation and display geometry
// ---------------------------------------------------------------------------

export function normalizeRotation(stream: Obj): Rotation {
  let displayMatrixDegrees: number | null = null;
  const sideData = stream.side_data_list;
  if (Array.isArray(sideData)) {
    for (const item of sideData as Obj[]) {
      const type = String(item.side_data_type ?? "").replace(/\s+/g, "").toLowerCase();
      if (type === "displaymatrix" && item.rotation !== undefined && item.rotation !== null) {
        const n = Number(item.rotation);
        if (Number.isFinite(n)) displayMatrixDegrees = n;
      }
    }
  }
  const tag = tagLookup(obj(stream, "tags"), "rotate");
  const tagDegrees = tag !== null && Number.isFinite(Number(tag)) ? Number(tag) : null;

  // ffprobe reports the display matrix rotation counter-clockwise; the legacy `rotate`
  // tag is clockwise. Both are converted to the clockwise turn a player applies.
  let clockwise = 0;
  let source: Rotation["source"] = "none";
  if (displayMatrixDegrees !== null) {
    clockwise = -displayMatrixDegrees;
    source = "displayMatrix";
  } else if (tagDegrees !== null) {
    clockwise = tagDegrees;
    source = "tag";
  }
  const quarter = ((Math.round(clockwise / 90) * 90) % 360 + 360) % 360;
  return {
    displayMatrixDegrees,
    tagDegrees,
    clockwiseToDisplay: quarter as 0 | 90 | 180 | 270,
    source,
  };
}

export interface DisplayGeometry {
  displayWidth: number;
  displayHeight: number;
  displayAspectRatio: Rational;
  orientation: "landscape" | "portrait" | "square";
}

/** Apply the sample aspect ratio (to width), then the rotation (swap for 90/270). */
export function displayGeometry(
  storedWidth: number,
  storedHeight: number,
  sar: Rational,
  clockwiseToDisplay: 0 | 90 | 180 | 270,
): DisplayGeometry {
  const sarWidth = roundHalfUp(mul(rational(storedWidth), sar));
  const swap = clockwiseToDisplay === 90 || clockwiseToDisplay === 270;
  const displayWidth = swap ? storedHeight : sarWidth;
  const displayHeight = swap ? sarWidth : storedHeight;
  const orientation =
    displayWidth > displayHeight ? "landscape" : displayWidth < displayHeight ? "portrait" : "square";
  return {
    displayWidth,
    displayHeight,
    displayAspectRatio: rational(displayWidth, displayHeight),
    orientation,
  };
}

// ---------------------------------------------------------------------------
// Frame-rate mode (CFR / VFR) from packet timestamps
// ---------------------------------------------------------------------------

export interface FrameTimingAnalysis {
  mode: FrameRateMode;
  measuredFrameRate: Rational | null;
}

/**
 * Classify CFR/VFR from presentation timestamps.
 *
 * Intervals are measured between consecutive presentation times (pts sorted, so B-frame
 * reordering does not matter). An interval "deviates" when it differs from the mean
 * interval by more than max(1 tick, 1% of the mean) — one tick absorbs timestamp rounding
 * in coarse time bases (e.g. 29.97 fps in a 1/1000 Matroska time base alternates 33/34).
 * The stream is VFR when more than 1/200 of intervals deviate.
 */
export function analyzeFrameTiming(ptsTicks: readonly number[], timeBase: Rational): FrameTimingAnalysis {
  const sorted = [...ptsTicks].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 3) {
    return {
      mode: {
        classification: "UNKNOWN",
        method: n === 0 ? "none" : "packetTimestamps",
        packetCount: n,
        minFrameDurationTicks: null,
        maxFrameDurationTicks: null,
        meanFrameDurationTicks: null,
        distinctFrameDurations: 0,
        deviatingIntervalFraction: null,
        toleranceTicks: null,
      },
      measuredFrameRate: null,
    };
  }
  const first = sorted[0]!;
  const last = sorted[n - 1]!;
  const span = last - first;
  const mean = rational(span, n - 1);
  const onePercent = mul(mean, rational(1, 100));
  const tolerance = compare(onePercent, rational(1)) > 0 ? onePercent : rational(1);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const distinct = new Set<number>();
  let deviating = 0;
  for (let i = 1; i < n; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d < min) min = d;
    if (d > max) max = d;
    distinct.add(d);
    if (compare(abs(sub(rational(d), mean)), tolerance) > 0) deviating++;
  }
  const deviatingFraction = rational(deviating, n - 1);
  const classification = span <= 0 ? "UNKNOWN" : compare(deviatingFraction, VFR_DEVIATION_THRESHOLD) > 0 ? "VFR" : "CFR";
  const measuredFrameRate = span > 0 ? div(rational(n - 1), mul(rational(span), timeBase)) : null;
  return {
    mode: {
      classification,
      method: "packetTimestamps",
      packetCount: n,
      minFrameDurationTicks: min,
      maxFrameDurationTicks: max,
      meanFrameDurationTicks: mean,
      distinctFrameDurations: distinct.size,
      deviatingIntervalFraction: deviatingFraction,
      toleranceTicks: tolerance,
    },
    measuredFrameRate,
  };
}

// ---------------------------------------------------------------------------
// Stream roles
// ---------------------------------------------------------------------------

export function streamRole(stream: Obj): StreamSummary["role"] {
  const type = str(stream, "codec_type");
  const disposition = obj(stream, "disposition");
  switch (type) {
    case "video": {
      if (Number(disposition?.attached_pic ?? 0) === 1) return "attachedPicture";
      const codec = str(stream, "codec_name") ?? "";
      const frames = int(stream, "nb_frames");
      const avg = ratio(stream, "avg_frame_rate");
      if (IMAGE_CODECS.has(codec) && (frames === 1 || avg === null)) return "stillImage";
      return "footage";
    }
    case "audio":
      return "audio";
    case "subtitle":
      return "subtitle";
    case "data":
      return "data";
    case "attachment":
      return "attachment";
    default:
      return "unknown";
  }
}

export function summarizeStreams(streams: readonly Obj[]): StreamSummary[] {
  return streams
    .map((s) => ({
      index: int(s, "index") ?? 0,
      codecType: str(s, "codec_type") ?? "unknown",
      codecName: str(s, "codec_name"),
      role: streamRole(s),
      isDefault: Number(obj(s, "disposition")?.default ?? 0) === 1,
    }))
    .sort((a, b) => a.index - b.index);
}

/** Lowest-index stream of a role, preferring one marked default. */
export function pickPrimary(summaries: readonly StreamSummary[], role: StreamSummary["role"]): number | null {
  const candidates = summaries.filter((s) => s.role === role);
  if (candidates.length === 0) return null;
  return (candidates.find((s) => s.isDefault) ?? candidates[0]!).index;
}

// ---------------------------------------------------------------------------
// Stream normalization
// ---------------------------------------------------------------------------

export class WarningList {
  readonly items: Warning[] = [];
  add(code: WarningCode, message: string, streamIndex: number | null = null): void {
    this.items.push({ code, message, streamIndex });
  }
}

export function normalizeVideoStream(
  stream: Obj,
  packetPts: readonly number[] | null,
  warnings: WarningList,
): VideoStream | null {
  const index = int(stream, "index") ?? 0;
  const width = int(stream, "width");
  const height = int(stream, "height");
  const timeBase = ratio(stream, "time_base");
  const codec = str(stream, "codec_name");
  if (!width || !height || !timeBase || !codec) return null;

  const sarRaw = ratio(stream, "sample_aspect_ratio");
  const sar = sarRaw ?? rational(1);
  if (!sarRaw) {
    warnings.add("UNKNOWN_SAMPLE_ASPECT_RATIO", "sample aspect ratio not reported; assuming 1:1", index);
  } else if (!equals(sar, rational(1))) {
    warnings.add("NON_SQUARE_PIXELS", `sample aspect ratio ${sar.num}:${sar.den}`, index);
  }

  const rotation = normalizeRotation(stream);
  if (rotation.clockwiseToDisplay !== 0) {
    warnings.add(
      "ROTATION_METADATA",
      `stored ${width}x${height}; displayed after ${rotation.clockwiseToDisplay}° clockwise rotation`,
      index,
    );
  }
  const geometry = displayGeometry(width, height, sar, rotation.clockwiseToDisplay);

  const nominal = ratio(stream, "r_frame_rate");
  const average = ratio(stream, "avg_frame_rate");
  const timing = analyzeFrameTiming(packetPts ?? [], timeBase);
  const mode =
    packetPts === null
      ? { ...timing.mode, method: nominal || average ? ("rateFieldsOnly" as const) : ("none" as const) }
      : timing.mode;

  if (!nominal && !average && !timing.measuredFrameRate) {
    warnings.add("FRAME_RATE_UNKNOWN", "no frame rate could be determined", index);
  }
  if (mode.classification === "VFR") {
    warnings.add(
      "VARIABLE_FRAME_RATE",
      `frame intervals vary (${mode.minFrameDurationTicks}–${mode.maxFrameDurationTicks} ticks of ${timeBase.num}/${timeBase.den} s)`,
      index,
    );
  }
  if (nominal && average && compare(abs(sub(div(nominal, average), rational(1))), RATE_MISMATCH_THRESHOLD) > 0) {
    warnings.add(
      "NOMINAL_AVERAGE_RATE_MISMATCH",
      `nominal ${nominal.num}/${nominal.den} vs average ${average.num}/${average.den} fps`,
      index,
    );
  }

  const containerNbFrames = int(stream, "nb_frames");
  let frameCount: VideoStream["frameCount"];
  if (packetPts && packetPts.length > 0) {
    const mismatch = containerNbFrames !== null && containerNbFrames !== packetPts.length;
    if (mismatch) {
      warnings.add(
        "FRAME_COUNT_MISMATCH",
        `container reports ${containerNbFrames} frames, packets count ${packetPts.length}`,
        index,
      );
    }
    frameCount = { value: packetPts.length, source: "packetCount", reliable: !mismatch, containerNbFrames };
  } else if (containerNbFrames !== null) {
    frameCount = { value: containerNbFrames, source: "containerNbFrames", reliable: false, containerNbFrames };
  } else {
    warnings.add("FRAME_COUNT_UNAVAILABLE", "frame count could not be determined", index);
    frameCount = { value: null, source: "unavailable", reliable: false, containerNbFrames: null };
  }

  const fieldOrder = str(stream, "field_order");
  if (fieldOrder && INTERLACED_ORDERS.has(fieldOrder)) {
    warnings.add("INTERLACED", `field order ${fieldOrder}`, index);
  }
  const transfer = str(stream, "color_transfer");
  const hdrTransfer = transfer !== null && HDR_TRANSFERS.has(transfer);
  if (hdrTransfer) warnings.add("HDR_TRANSFER", `transfer ${transfer}`, index);

  return {
    streamIndex: index,
    codec,
    codecLongName: str(stream, "codec_long_name"),
    codecProfile: str(stream, "profile"),
    pixelFormat: str(stream, "pix_fmt"),
    bitsPerRawSample: int(stream, "bits_per_raw_sample"),
    fieldOrder,
    storedWidth: width,
    storedHeight: height,
    codedWidth: int(stream, "coded_width"),
    codedHeight: int(stream, "coded_height"),
    sampleAspectRatio: sar,
    sampleAspectRatioKnown: sarRaw !== null,
    rotation,
    displayWidth: geometry.displayWidth,
    displayHeight: geometry.displayHeight,
    displayAspectRatio: geometry.displayAspectRatio,
    orientation: geometry.orientation,
    timeBase,
    startTimeSeconds: dec(stream, "start_time"),
    durationSeconds: dec(stream, "duration"),
    nominalFrameRate: nominal,
    averageFrameRate: average,
    measuredFrameRate: timing.measuredFrameRate,
    frameRateMode: mode,
    frameCount,
    bitRate: int(stream, "bit_rate"),
    color: {
      range: str(stream, "color_range"),
      space: str(stream, "color_space"),
      transfer,
      primaries: str(stream, "color_primaries"),
      chromaLocation: str(stream, "chroma_location"),
      hdrTransfer,
    },
    isAttachedPicture: false,
    isFootage: true,
  };
}

export function normalizeAudioStream(stream: Obj): AudioStream | null {
  const codec = str(stream, "codec_name");
  if (!codec) return null;
  return {
    streamIndex: int(stream, "index") ?? 0,
    codec,
    codecLongName: str(stream, "codec_long_name"),
    codecProfile: str(stream, "profile"),
    sampleRate: int(stream, "sample_rate"),
    channels: int(stream, "channels"),
    channelLayout: str(stream, "channel_layout"),
    sampleFormat: str(stream, "sample_fmt"),
    bitsPerSample: int(stream, "bits_per_sample") || int(stream, "bits_per_raw_sample"),
    bitRate: int(stream, "bit_rate"),
    timeBase: ratio(stream, "time_base"),
    startTimeSeconds: dec(stream, "start_time"),
    durationSeconds: dec(stream, "duration"),
  };
}

export function normalizeAttachedPicture(stream: Obj, role: "attachedPicture" | "stillImage"): AttachedPicture {
  return {
    streamIndex: int(stream, "index") ?? 0,
    codec: str(stream, "codec_name"),
    width: int(stream, "width"),
    height: int(stream, "height"),
    role,
  };
}

export function normalizeContainer(format: Obj) {
  return {
    formatName: str(format, "format_name"),
    formatLongName: str(format, "format_long_name"),
    durationSeconds: dec(format, "duration"),
    startTimeSeconds: dec(format, "start_time"),
    bitRate: int(format, "bit_rate"),
  };
}

export function normalizeCreation(format: Obj | undefined, streams: readonly Obj[]) {
  const ftags = obj(format, "tags");
  const appleDate = tagLookup(ftags, "com.apple.quicktime.creationdate");
  const formatTime = tagLookup(ftags, "creation_time");
  let streamTime: string | null = null;
  for (const s of streams) {
    streamTime = tagLookup(obj(s, "tags"), "creation_time");
    if (streamTime) break;
  }
  const time = appleDate ?? formatTime ?? streamTime;
  const timeSource = appleDate
    ? "format.tags.com.apple.quicktime.creationdate"
    : formatTime
      ? "format.tags.creation_time"
      : streamTime
        ? "stream.tags.creation_time"
        : null;
  return {
    time,
    timeSource,
    make: tagLookup(ftags, "com.apple.quicktime.make", "make"),
    model: tagLookup(ftags, "com.apple.quicktime.model", "model"),
    software: tagLookup(ftags, "com.apple.quicktime.software", "software"),
    encoder: tagLookup(ftags, "encoder"),
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusInput {
  extension: string;
  footage: VideoStream | null;
  audio: AudioStream | null;
  attachedPictureCount: number;
  decodeOk: boolean | null;
  containerDuration: Rational | null;
}

export function deriveStatus(input: StatusInput): { status: MediaStatus; kind: MediaKind; detail: string | null } {
  const { extension, footage, audio, attachedPictureCount, decodeOk } = input;
  const kind: MediaKind = footage ? "video" : audio ? "audio" : "unknown";
  const decodeFailed = decodeOk === false;

  if (VIDEO_EXTENSIONS.has(extension)) {
    if (footage) {
      if (decodeFailed) return { status: "DECODE_FAILED", kind, detail: "sampled decode of the video stream failed" };
      const duration = footage.durationSeconds ?? input.containerDuration;
      const hasRate = footage.averageFrameRate ?? footage.nominalFrameRate ?? footage.measuredFrameRate;
      if (!duration || !hasRate) {
        return { status: "METADATA_INCONSISTENT", kind, detail: "video duration or frame rate unavailable" };
      }
      return { status: "OK", kind, detail: null };
    }
    if (audio) return { status: "AUDIO_ONLY", kind, detail: "video container holds audio but no playable video" };
    if (attachedPictureCount > 0) {
      return { status: "ATTACHED_PICTURE_ONLY", kind, detail: "only cover art / still image streams" };
    }
    return { status: "NO_VIDEO_STREAM", kind, detail: "no video or audio streams" };
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    if (audio) {
      if (decodeFailed) return { status: "DECODE_FAILED", kind, detail: "sampled decode of the audio stream failed" };
      if (!(audio.durationSeconds ?? input.containerDuration)) {
        return { status: "METADATA_INCONSISTENT", kind, detail: "audio duration unavailable" };
      }
      return { status: "OK", kind, detail: null };
    }
    if (attachedPictureCount > 0) {
      return { status: "ATTACHED_PICTURE_ONLY", kind, detail: "only cover art, no audio stream" };
    }
    return { status: "NO_AUDIO_STREAM", kind, detail: "audio file without an audio stream" };
  }

  return { status: "UNSUPPORTED", kind: "unknown", detail: `extension ${extension || "(none)"} is not supported` };
}

/** Warn when stream and container durations disagree by more than half a second. */
export function checkDurations(
  warnings: WarningList,
  container: Rational | null,
  stream: Rational | null,
  streamIndex: number,
): void {
  if (!container && !stream) {
    warnings.add("DURATION_UNKNOWN", "neither stream nor container reports a duration", streamIndex);
    return;
  }
  if (container && stream && compare(abs(sub(container, stream)), rational(1, 2)) > 0) {
    warnings.add(
      "DURATION_MISMATCH",
      `container ${toDecimalString(container, 3)}s vs stream ${toDecimalString(stream, 3)}s`,
      streamIndex,
    );
  }
}
