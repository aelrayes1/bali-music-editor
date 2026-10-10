/**
 * Build the canonical media-manifest.json.
 *
 * Deterministic: entries are ordered by (source root id, relative path) in codepoint order,
 * every object is built with a fixed key order, and `generatedAt` is the only field that
 * changes between identical runs. Originals are opened read-only.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type FfprobeJson,
  type MediaTools,
  probeFile,
  probePacketPts,
  sampledDecodeCheck,
} from "./ffmpeg.ts";
import {
  FINGERPRINT_ALGORITHM,
  duplicateMediaId,
  fullSha256,
  mediaIdFromFingerprint,
  sampledFingerprint,
} from "./fingerprint.ts";
import {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  WarningList,
  checkDurations,
  deriveStatus,
  normalizeAttachedPicture,
  normalizeAudioStream,
  normalizeContainer,
  normalizeCreation,
  normalizeVideoStream,
  pickPrimary,
  summarizeStreams,
} from "./normalize.ts";
import {
  MANIFEST_SCHEMA_VERSION,
  type MediaEntry,
  type MediaManifest,
  MediaManifestSchema,
} from "./schema.ts";
import { type DiscoveredFile, type SourcesConfig, compareCodepoints, discoverFiles, expandHome } from "./sources.ts";

export const GENERATOR_VERSION = "0.1.0";

export interface IngestOptions {
  /** Sampled decode check of the primary stream (default true). */
  decodeCheck?: boolean;
  /** Full-file SHA-256 in addition to the sampled fingerprint (default false). */
  fullHash?: boolean;
  /** Parallel file probes (default 4). */
  concurrency?: number;
  /** Injected for tests; defaults to new Date().toISOString(). */
  now?: () => string;
}

const PLACEHOLDER_FINGERPRINT = "0".repeat(64);

type Obj = Record<string, unknown>;

function emptyCreation(): MediaEntry["creation"] {
  return { time: null, timeSource: null, make: null, model: null, software: null, encoder: null };
}

function baseEntry(file: DiscoveredFile, extension: string): MediaEntry {
  return {
    mediaId: mediaIdFromFingerprint(PLACEHOLDER_FINGERPRINT),
    contentFingerprint: { algorithm: FINGERPRINT_ALGORITHM, value: PLACEHOLDER_FINGERPRINT },
    fullSha256: null,
    duplicateOf: null,
    source: {
      rootId: file.rootId,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      fileName: path.basename(file.relativePath),
      extension,
      sizeBytes: 0,
      modifiedAt: null,
    },
    kind: "unknown",
    status: "READ_FAILED",
    statusDetail: null,
    warnings: [],
    container: null,
    creation: emptyCreation(),
    streams: [],
    video: null,
    audio: null,
    attachedPictures: [],
    hasAudio: false,
    isPlayableVideoFootage: false,
    decodeCheck: { mode: "skipped", ok: null, messages: [] },
  };
}

/** Ingest one file into a manifest entry. Never throws for media problems: they become statuses. */
export async function ingestFile(
  tools: MediaTools,
  file: DiscoveredFile,
  options: IngestOptions = {},
): Promise<MediaEntry> {
  const extension = path.extname(file.relativePath).toLowerCase();
  const entry = baseEntry(file, extension);

  // Identity (read-only).
  try {
    if (!file.exists) throw new Error("listed file does not exist");
    const st = await stat(file.absolutePath);
    entry.source.sizeBytes = st.size;
    entry.source.modifiedAt = st.mtime.toISOString();
    const fingerprint = await sampledFingerprint(file.absolutePath);
    entry.contentFingerprint = { algorithm: FINGERPRINT_ALGORITHM, value: fingerprint };
    entry.mediaId = mediaIdFromFingerprint(fingerprint);
    if (options.fullHash) entry.fullSha256 = await fullSha256(file.absolutePath);
  } catch (err) {
    entry.status = "READ_FAILED";
    entry.statusDetail = (err as Error).message;
    // Deterministic placeholder identity from the location, so the entry is still addressable.
    const { createHash } = await import("node:crypto");
    const loc = createHash("sha256").update(`${file.rootId}\u0000${file.relativePath}`).digest("hex");
    entry.mediaId = mediaIdFromFingerprint(loc);
    entry.contentFingerprint = { algorithm: FINGERPRINT_ALGORITHM, value: loc };
    return entry;
  }

  if (!VIDEO_EXTENSIONS.has(extension) && !AUDIO_EXTENSIONS.has(extension)) {
    entry.status = "UNSUPPORTED";
    entry.statusDetail = `extension ${extension || "(none)"} is not supported`;
    return entry;
  }

  const probe = await probeFile(tools, file.absolutePath);
  if (!probe.ok) {
    entry.status = "MALFORMED";
    entry.statusDetail = probe.message;
    return entry;
  }
  return normalizeEntry(tools, entry, probe.json, options);
}

async function normalizeEntry(
  tools: MediaTools,
  entry: MediaEntry,
  json: FfprobeJson,
  options: IngestOptions,
): Promise<MediaEntry> {
  const streams = (json.streams ?? []) as Obj[];
  const format = (json.format ?? {}) as Obj;
  const warnings = new WarningList();
  const summaries = summarizeStreams(streams);
  const byIndex = new Map(streams.map((s) => [Number(s.index), s]));

  const videoIndex = pickPrimary(summaries, "footage");
  const audioIndex = pickPrimary(summaries, "audio");
  if (summaries.filter((s) => s.role === "footage").length > 1) {
    warnings.add("MULTIPLE_VIDEO_STREAMS", "more than one footage stream; the primary is used", videoIndex);
  }
  if (summaries.filter((s) => s.role === "audio").length > 1) {
    warnings.add("MULTIPLE_AUDIO_STREAMS", "more than one audio stream; the primary is used", audioIndex);
  }

  const container = normalizeContainer(format);
  let video = null;
  if (videoIndex !== null) {
    const pts = await probePacketPts(tools, entry.source.absolutePath, videoIndex).catch(() => null);
    video = normalizeVideoStream(byIndex.get(videoIndex)!, pts, warnings);
    if (video) checkDurations(warnings, container.durationSeconds, video.durationSeconds, video.streamIndex);
  }
  const audio = audioIndex !== null ? normalizeAudioStream(byIndex.get(audioIndex)!) : null;

  const attachedPictures = summaries
    .filter((s) => s.role === "attachedPicture" || s.role === "stillImage")
    .map((s) => normalizeAttachedPicture(byIndex.get(s.index)!, s.role as "attachedPicture" | "stillImage"));
  for (const pic of attachedPictures) {
    warnings.add(
      pic.role === "attachedPicture" ? "ATTACHED_PICTURE_PRESENT" : "STILL_IMAGE_STREAM",
      `${pic.codec ?? "image"} ${pic.width ?? "?"}x${pic.height ?? "?"} is ${pic.role === "attachedPicture" ? "embedded cover art" : "a still image"}, not footage`,
      pic.streamIndex,
    );
  }
  if (video && !audio) warnings.add("NO_AUDIO", "video has no audio stream", video.streamIndex);

  // Sampled decode check of the primary stream.
  let decodeCheck: MediaEntry["decodeCheck"] = { mode: "skipped", ok: null, messages: [] };
  const checkIndex = video?.streamIndex ?? audio?.streamIndex ?? null;
  if (options.decodeCheck !== false && checkIndex !== null) {
    const result = await sampledDecodeCheck(tools, entry.source.absolutePath, checkIndex);
    decodeCheck = { mode: "sampled", ok: result.ok, messages: result.messages };
    if (result.ok && result.messages.length > 0) {
      warnings.add("DECODE_WARNINGS", result.messages.slice(0, 3).join(" | "), checkIndex);
    }
  }

  const { status, kind, detail } = deriveStatus({
    extension: entry.source.extension,
    footage: video,
    audio,
    attachedPictureCount: attachedPictures.length,
    decodeOk: decodeCheck.ok,
    containerDuration: container.durationSeconds,
  });

  entry.kind = kind;
  entry.status = status;
  entry.statusDetail = detail;
  entry.container = container;
  entry.creation = normalizeCreation(format, streams);
  entry.streams = summaries;
  entry.video = video;
  entry.audio = audio;
  entry.attachedPictures = attachedPictures;
  entry.hasAudio = audio !== null;
  entry.isPlayableVideoFootage = video !== null && status === "OK";
  entry.decodeCheck = decodeCheck;
  entry.warnings = warnings.items;
  return entry;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Give later duplicates (same content) a unique, deterministic ID pointing at the first. */
export function resolveDuplicates(entries: MediaEntry[]): void {
  const firstById = new Map<string, MediaEntry>();
  for (const e of entries) {
    if (e.status === "READ_FAILED") continue;
    const first = firstById.get(e.mediaId);
    if (!first) {
      firstById.set(e.mediaId, e);
      continue;
    }
    e.duplicateOf = first.mediaId;
    e.mediaId = duplicateMediaId(first.mediaId, e.source.rootId, e.source.relativePath);
    e.warnings.push({
      code: "DUPLICATE_CONTENT",
      message: `same content as ${first.source.rootId}/${first.source.relativePath}`,
      streamIndex: null,
    });
  }
}

function countBy(entries: readonly MediaEntry[], key: (e: MediaEntry) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => compareCodepoints(a, b)));
}

export async function buildManifest(
  tools: MediaTools,
  config: SourcesConfig,
  options: IngestOptions = {},
): Promise<MediaManifest> {
  const files = await discoverFiles(config);
  const entries = await mapLimit(files, options.concurrency ?? 4, (f) => ingestFile(tools, f, options));
  resolveDuplicates(entries);
  const manifest: MediaManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    generator: {
      name: "bali-media-foundation",
      version: GENERATOR_VERSION,
      ffprobe: { path: tools.ffprobe, version: tools.ffprobeVersion },
    },
    sourceRoots: config.sourceRoots.map((r) => ({ id: r.id, path: path.resolve(expandHome(r.path)) })),
    summary: {
      total: entries.length,
      byStatus: countBy(entries, (e) => e.status),
      byKind: countBy(entries, (e) => e.kind),
    },
    media: entries,
  };
  return MediaManifestSchema.parse(manifest);
}

/** Serialize with stable formatting (keys are already in construction order). */
export function serializeManifest(manifest: MediaManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** The manifest minus its only non-deterministic field, for reproducibility checks. */
export function deterministicView(manifest: MediaManifest): string {
  return serializeManifest({ ...manifest, generatedAt: "<generatedAt>" });
}

export function findMedia(manifest: MediaManifest, mediaId: string): MediaEntry | undefined {
  return manifest.media.find((m) => m.mediaId === mediaId);
}
