/**
 * Audio decode + frame-level features.
 *
 * Analysis grid: 44100 Hz mono, 2048-sample Hann frames, hop 441 samples. Frame k is centred
 * on sample k * 441, i.e. exactly k / 100 s — a rational time with no rounding.
 */

import { spawn } from "node:child_process";
import type { MediaTools } from "../media/ffmpeg.ts";
import type { MediaEntry } from "../media/schema.ts";
import { FFT, db, hann } from "./dsp.ts";

export const SAMPLE_RATE = 44100;
export const FRAME_SIZE = 2048;
export const HOP = 441; // 10 ms exactly
export const FRAMES_PER_SECOND = SAMPLE_RATE / HOP; // 100
export const TIMBRE_BANDS = 24;
/** Vocal-band spectrogram bins (150 Hz .. 4 kHz). */
export const VOCAL_BIN_LO = Math.round((150 * FRAME_SIZE) / SAMPLE_RATE); // 7
export const VOCAL_BIN_HI = Math.round((4000 * FRAME_SIZE) / SAMPLE_RATE); // 186
export const VOCAL_BINS = VOCAL_BIN_HI - VOCAL_BIN_LO;

export class MusicInputError extends Error {
  readonly code: "NO_AUDIO_STREAM" | "MEDIA_NOT_OK" | "DECODE_FAILED" | "TOO_SHORT";
  constructor(code: MusicInputError["code"], message: string) {
    super(message);
    this.name = "MusicInputError";
    this.code = code;
  }
}

/** Decode the entry's primary audio stream (by explicit index: cover art is never touched). */
export async function decodeMono(tools: MediaTools, entry: MediaEntry): Promise<Float32Array> {
  if (entry.status !== "OK") {
    throw new MusicInputError("MEDIA_NOT_OK", `${entry.mediaId} has status ${entry.status}; only OK media is analysed`);
  }
  if (!entry.audio) throw new MusicInputError("NO_AUDIO_STREAM", `${entry.mediaId} has no audio stream`);
  const args = [
    "-hide_banner", "-nostdin", "-v", "error",
    "-i", entry.source.absolutePath,
    "-map", `0:${entry.audio.streamIndex}`,
    "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
  ];
  const chunks: Buffer[] = [];
  let stderr = "";
  const code = await new Promise<number>((resolve, reject) => {
    const p = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) throw new MusicInputError("DECODE_FAILED", `ffmpeg exited ${code}: ${stderr.trim().slice(-300)}`);
  const buf = Buffer.concat(chunks);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  if (samples.length < SAMPLE_RATE) throw new MusicInputError("TOO_SHORT", "audio shorter than 1 s");
  return Float32Array.from(samples); // own, aligned copy
}

export interface FrameFeatures {
  readonly frames: number;
  /** Time-domain RMS level in dBFS over the 10 ms hop centred on the frame. */
  readonly rmsDbfs: Float64Array;
  /** Band powers in dB (relative, per frame). */
  readonly totalDb: Float64Array;
  readonly lowDb: Float64Array; // < 150 Hz (kick / sub)
  readonly midDb: Float64Array; // 300 - 3400 Hz (vocal band)
  readonly highDb: Float64Array; // > 5 kHz (hats / noise)
  /** Log-compressed positive spectral flux. */
  readonly flux: Float64Array;
  readonly fluxLow: Float64Array;
  readonly fluxMid: Float64Array;
  readonly fluxHigh: Float64Array;
  /** frames x TIMBRE_BANDS log band energies (row-major). */
  readonly timbre: Float32Array;
  /** frames x VOCAL_BINS magnitudes (row-major), 150 Hz - 4 kHz. */
  readonly vocalSpec: Float32Array;
}

function bin(hz: number): number {
  return Math.min(FRAME_SIZE / 2, Math.max(1, Math.round((hz * FRAME_SIZE) / SAMPLE_RATE)));
}

export function computeFeatures(samples: Float32Array): FrameFeatures {
  const frames = Math.floor(samples.length / HOP) + 1;
  const half = FRAME_SIZE / 2;
  const fft = new FFT(FRAME_SIZE);
  const win = hann(FRAME_SIZE);
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  const logMag = new Float64Array(half + 1);
  const prevLog = new Float64Array(half + 1);

  const rmsDbfs = new Float64Array(frames);
  const totalDb = new Float64Array(frames);
  const lowDb = new Float64Array(frames);
  const midDb = new Float64Array(frames);
  const highDb = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const fluxLow = new Float64Array(frames);
  const fluxMid = new Float64Array(frames);
  const fluxHigh = new Float64Array(frames);
  const timbre = new Float32Array(frames * TIMBRE_BANDS);
  const vocalSpec = new Float32Array(frames * VOCAL_BINS);

  const lowHi = bin(150);
  const midLo = bin(300);
  const midHi = bin(3400);
  const highLo = bin(5000);
  const fluxLowHi = bin(215);
  const bandEdges: number[] = [];
  for (let b = 0; b <= TIMBRE_BANDS; b++) bandEdges.push(bin(40 * Math.pow(16000 / 40, b / TIMBRE_BANDS)));

  for (let k = 0; k < frames; k++) {
    const start = k * HOP - half;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s]! * win[i]! : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    let tot = 0;
    let lo = 0;
    let mid = 0;
    let hi = 0;
    let fAll = 0;
    let fLo = 0;
    let fMid = 0;
    let fHi = 0;
    for (let j = 1; j <= half; j++) {
      const p = re[j]! * re[j]! + im[j]! * im[j]!;
      const mag = Math.sqrt(p);
      tot += p;
      if (j < lowHi) lo += p;
      if (j >= midLo && j < midHi) mid += p;
      if (j >= highLo) hi += p;
      const lm = Math.log1p(100 * mag);
      logMag[j] = lm;
      const d = lm - prevLog[j]!;
      if (d > 0 && k > 0) {
        fAll += d;
        if (j < fluxLowHi) fLo += d;
        else if (j >= midLo && j < midHi) fMid += d;
        else if (j >= highLo) fHi += d;
      }
      if (j >= VOCAL_BIN_LO && j < VOCAL_BIN_HI) vocalSpec[k * VOCAL_BINS + (j - VOCAL_BIN_LO)] = mag;
    }
    for (let b = 0; b < TIMBRE_BANDS; b++) {
      let e = 0;
      for (let j = bandEdges[b]!; j < Math.max(bandEdges[b]! + 1, bandEdges[b + 1]!); j++) {
        e += re[j]! * re[j]! + im[j]! * im[j]!;
      }
      timbre[k * TIMBRE_BANDS + b] = db(e);
    }
    prevLog.set(logMag);
    let sq = 0;
    let n = 0;
    for (let s = Math.max(0, k * HOP - (HOP >> 1)); s < Math.min(samples.length, k * HOP + (HOP >> 1) + 1); s++) {
      sq += samples[s]! * samples[s]!;
      n++;
    }
    rmsDbfs[k] = db(n > 0 ? sq / n : 0, 1e-10);
    totalDb[k] = db(tot);
    lowDb[k] = db(lo);
    midDb[k] = db(mid);
    highDb[k] = db(hi);
    flux[k] = fAll;
    fluxLow[k] = fLo;
    fluxMid[k] = fMid;
    fluxHigh[k] = fHi;
  }
  return { frames, rmsDbfs, totalDb, lowDb, midDb, highDb, flux, fluxLow, fluxMid, fluxHigh, timbre, vocalSpec };
}

/** Frame index containing sample s (frame centres are k * HOP). */
export function frameOfSample(sample: number): number {
  return Math.round(sample / HOP);
}
