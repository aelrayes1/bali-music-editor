/**
 * Deterministic synthetic music fixtures with exactly known event times (test oracles).
 * Pure TypeScript: every sample is computed, nothing depends on external tools or randomness
 * beyond a fixed-seed LCG.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SR = 44100;

export class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 0x100000000 - 0.5; // [-0.5, 0.5)
  }
}

export class Track {
  readonly samples: Float32Array;
  readonly seconds: number;
  private readonly rng = new Lcg(12345);
  constructor(seconds: number) {
    this.seconds = seconds;
    this.samples = new Float32Array(Math.round(seconds * SR));
  }

  private addAt(sample: number, n: number, fn: (i: number) => number): void {
    for (let i = 0; i < n; i++) {
      const s = sample + i;
      if (s >= 0 && s < this.samples.length) this.samples[s] = this.samples[s]! + fn(i);
    }
  }

  /** Kick: 60 Hz body with pitch drop + 2 ms broadband click. Attack exactly at `sample`. */
  kick(sample: number, gain = 0.6): void {
    this.addAt(sample, Math.round(0.25 * SR), (i) => {
      const t = i / SR;
      const f = 55 + 90 * Math.exp(-t / 0.02);
      return gain * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.08);
    });
    this.addAt(sample, Math.round(0.002 * SR), () => gain * 0.8 * this.rng.next());
  }

  /** Closed hat: short high noise burst. */
  hat(sample: number, gain = 0.12): void {
    let prev = 0;
    this.addAt(sample, Math.round(0.04 * SR), (i) => {
      const n = this.rng.next();
      const hp = n - prev; // crude high-pass
      prev = n;
      return gain * hp * Math.exp(-(i / SR) / 0.012);
    });
  }

  /** Crash: long bright noise. */
  crash(sample: number, gain = 0.25): void {
    let prev = 0;
    this.addAt(sample, Math.round(1.2 * SR), (i) => {
      const n = this.rng.next();
      const hp = n - prev;
      prev = n;
      return gain * hp * Math.exp(-(i / SR) / 0.35);
    });
  }

  /** Snare-ish burst (for fills). */
  snare(sample: number, gain = 0.3): void {
    this.addAt(sample, Math.round(0.08 * SR), (i) => {
      const t = i / SR;
      return gain * (0.6 * this.rng.next() + 0.4 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.03);
    });
  }

  /** Sustained bass note (for energy/section tests). */
  bass(sample: number, seconds: number, hz = 55, gain = 0.3): void {
    const n = Math.round(seconds * SR);
    this.addAt(sample, n, (i) => {
      const edge = Math.min(1, i / 441, (n - i) / 441);
      return gain * edge * Math.sin((2 * Math.PI * hz * i) / SR);
    });
  }

  /** House-style sidechained bass: ducks to silence under the kick and swells back over ~120 ms. */
  duckedBass(sample: number, seconds: number, hz = 55, gain = 0.3): void {
    const n = Math.round(seconds * SR);
    this.addAt(sample, n, (i) => {
      const duck = Math.min(1, i / (0.12 * SR)) ** 2;
      const edge = Math.min(1, (n - i) / 441);
      return gain * duck * edge * Math.sin((2 * Math.PI * hz * i) / SR);
    });
  }

  /** Rising noise riser from `sample` for `seconds` (build). */
  riser(sample: number, seconds: number, gain = 0.2): void {
    const n = Math.round(seconds * SR);
    let prev = 0;
    this.addAt(sample, n, (i) => {
      const x = this.rng.next();
      const hp = x - prev;
      prev = x;
      return gain * (i / n) ** 2 * hp;
    });
  }

  /**
   * Tonal "vocal chop": harmonic tone with formant-like emphasis and a fast attack at `sample`.
   * Used as a stand-in for a repeated sung word.
   */
  chop(sample: number, f0 = 220, seconds = 0.28, gain = 0.25): void {
    const n = Math.round(seconds * SR);
    this.addAt(sample, n, (i) => {
      const t = i / SR;
      const env = Math.min(1, i / 88) * Math.exp(-t / 0.18);
      let v = 0;
      for (let h = 1; h <= 12; h++) {
        const fh = f0 * h * (1 + 0.04 * t); // slight upward glide
        const formant = Math.exp(-(((fh - 800) / 500) ** 2)) + 0.6 * Math.exp(-(((fh - 1500) / 400) ** 2));
        v += (formant / h) * Math.sin(2 * Math.PI * fh * t);
      }
      return gain * env * v;
    });
  }

  silence(fromSample: number, toSample: number): void {
    this.samples.fill(0, Math.max(0, fromSample), Math.min(this.samples.length, toSample));
  }
}

/** Exact sample index of beat i at a rational tempo, first beat at `firstBeatSample`. */
export function beatSample(i: number, bpmNum: number, bpmDen: number, firstBeatSample: number): number {
  // i * 60 / (bpmNum / bpmDen) seconds, rounded to the nearest sample
  return firstBeatSample + Math.round((i * 60 * SR * bpmDen) / bpmNum);
}

export async function writeWav16(file: string, samples: Float32Array): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0.99 ? 0.99 / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]! * scale * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(file, Buffer.concat([header, data]));
  return file;
}

/** House-style groove: kick every beat, hat on every off-beat. */
export function groove(seconds: number, bpmNum: number, bpmDen: number, firstBeatSample: number): { track: Track; beats: number[] } {
  const track = new Track(seconds);
  const beats: number[] = [];
  for (let i = 0; ; i++) {
    const s = beatSample(i, bpmNum, bpmDen, firstBeatSample);
    if (s >= track.samples.length - SR / 4) break;
    beats.push(s);
    track.kick(s);
    const off = beatSample(i, bpmNum, bpmDen, firstBeatSample) + Math.round((30 * SR * bpmDen) / bpmNum);
    track.hat(off);
  }
  return { track, beats };
}
