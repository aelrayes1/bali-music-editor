/**
 * Representative-frame sampling for semantic analysis (deterministic, from Phase 3 shots).
 * Short shots get one frame (the Phase 3 representative); longer shots get evenly placed frames
 * so subject movement, entries/exits, framing and camera-direction changes can be seen.
 */

import type { FootageAnalysis } from "../footage/schema.ts";
import { toNumberApprox } from "../time/rational.ts";

export interface SamplePlan {
  shotId: string;
  frameIndex: number;
  /** position within the shot, 0..1 (representative marked separately) */
  position: number;
  representative: boolean;
}

export function samplesPerShot(seconds: number): number {
  if (seconds < 0.6) return 1;
  if (seconds < 2) return 3;
  if (seconds < 6) return 5;
  return Math.min(12, 5 + Math.floor((seconds - 6) / 4) + 1);
}

export function planSamples(fa: FootageAnalysis): SamplePlan[] {
  const out: SamplePlan[] = [];
  for (const s of fa.shots) {
    const first = s.frames.first;
    const last = s.frames.last;
    const n = samplesPerShot(toNumberApprox(s.duration));
    const rep = s.representative.frameIndex;
    const idx = new Set<number>([rep]);
    if (n > 1) {
      for (let k = 0; k < n; k++) {
        const pos = n === 1 ? 0.5 : 0.05 + (0.9 * k) / (n - 1);
        idx.add(Math.min(last, Math.max(first, first + Math.round(pos * (last - first)))));
      }
    }
    for (const f of [...idx].sort((a, b) => a - b)) {
      out.push({ shotId: s.shotId, frameIndex: f, position: last > first ? Math.round(((f - first) / (last - first)) * 1000) / 1000 : 0.5, representative: f === rep });
    }
  }
  return out;
}
