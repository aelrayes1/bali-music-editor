/**
 * Tiny synthetic fixtures for the vocal assist: a 120 BPM grid (beat = 0.5 s, bar = 2 s), a few
 * hand-placed Phase 2 events, and whisper.cpp-shaped JSON documents with known word timings.
 */

import type { MusicAnalysis, MusicEvent } from "../../src/music/schema.ts";
import { rational } from "../../src/time/rational.ts";
import type { AsrWindow } from "../../src/vocal/schema.ts";
import { type RawTranscript, type WhisperEngine, parseWhisperJson } from "../../src/vocal/whisper.ts";

const ms = (t: number) => rational(Math.round(t * 1000), 1000);

export function event(type: MusicEvent["type"], t: number, confidence: number, strength = confidence): MusicEvent {
  const sample = Math.round(t * 44100);
  return {
    id: `${type === "vocal_attack" ? "vocal" : type}:${sample}`,
    type,
    time: ms(t),
    sample,
    strength,
    confidence,
    method: "fixture",
    detail: null,
    nearestBeatId: null,
    beatOffsetMs: null,
    barIndex: null,
    beatInBar: null,
    vocal: null,
  };
}

/** Minimal analysis object: only the fields the vocal assist and the resolver read. */
export function fakeAnalysis(events: MusicEvent[], seconds = 16): MusicAnalysis {
  const beats = Array.from({ length: seconds * 2 }, (_, i) => ({
    id: `beat:${String(i).padStart(4, "0")}`,
    index: i,
    time: rational(i, 2),
    sample: i * 22050,
    isDownbeat: i % 4 === 0,
    barIndex: Math.floor(i / 4),
    beatInBar: (i % 4) + 1,
    supported: true,
    onsetOffsetMs: 0,
    kickAccent: 1,
    kickPulseDb: 10,
  }));
  const bars = Array.from({ length: seconds / 2 }, (_, j) => ({
    id: `bar:${String(j).padStart(3, "0")}`,
    index: j,
    time: rational(2 * j),
    sample: j * 88200,
    startBeatId: beats[j * 4]!.id,
    energyDb: -10,
    lowDb: -10,
    change: 0,
    energyLevel: "medium" as const,
    trend: "steady" as const,
  }));
  return {
    source: { mediaId: "m_00000000000000aa", fingerprint: "a".repeat(64), audioStreamIndex: 0, fileName: "fixture.wav" },
    analyzer: { name: "bali-music-intelligence", version: "1.0.0", configHash: "0123456789abcdef" },
    durationSeconds: rational(seconds),
    tempo: { bpmConfidence: 0.9 },
    beats,
    bars,
    phrases: [],
    regions: [],
    events: [...events].sort((a, b) => a.sample - b.sample),
    vocal: { clusters: [] },
  } as unknown as MusicAnalysis;
}

export type W = [text: string, fromMs: number, toMs: number, p: number];

/** A whisper.cpp `-ojf -ml 1` document (one word per segment, special tokens included). */
export function whisperDoc(words: W[]) {
  return {
    transcription: words.map(([text, from, to, p]) => ({
      text,
      offsets: { from, to },
      tokens: [
        { text: "[_BEG_]", p: 0.99, offsets: { from, to: from } },
        { text, p, offsets: { from, to } },
      ],
    })),
  };
}

export function fakeRaw(windows: AsrWindow[], docs: Record<string, W[]>): RawTranscript {
  return {
    cacheKey: "fixture",
    engineArgs: ["-l", "en"],
    windows,
    words: windows.flatMap((w) => parseWhisperJson(whisperDoc(docs[w.id] ?? []), w)),
  };
}

export const FAKE_ENGINE: WhisperEngine = {
  binary: "/fixture/whisper-cli",
  model: "/fixture/ggml-base.en.bin",
  modelName: "base.en",
  modelSizeBytes: 1,
  modelSha256: "b".repeat(64),
  version: "1.9.4",
  commit: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
  sandbox: "/usr/bin/sandbox-exec",
};
