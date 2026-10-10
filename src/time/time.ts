/**
 * Canonical timing primitives.
 *
 * Rules (v5 Phase 1):
 *  - Every time value carries an explicit unit. There is no "bare number" time.
 *  - Seconds are exact rationals; frame rates are exact rationals (30000/1001 stays 30000/1001).
 *  - A frame index is only meaningful together with the frame rate of its grid.
 *  - Source time (position inside one media file) and timeline time (position in an edit)
 *    are different domains and cannot be mixed by accident.
 *  - Seconds -> frame conversion always names its rounding mode.
 */

import {
  type Rational,
  add,
  ceil,
  compare,
  div,
  floor,
  mul,
  parseDecimal,
  parseRatio,
  rational,
  roundHalfUp,
  sub,
  toDecimalString,
} from "./rational.ts";

export type FrameRate = Rational;

export interface SourceTime {
  readonly domain: "source";
  readonly mediaId: string;
  readonly seconds: Rational;
}

export interface TimelineTime {
  readonly domain: "timeline";
  readonly seconds: Rational;
}

export interface FrameIndex {
  readonly unit: "frame";
  readonly index: number;
  readonly rate: FrameRate;
}

export type Rounding = "floor" | "ceil" | "nearest";

export function frameRate(value: string | Rational): FrameRate {
  const r = typeof value === "string" ? parseRatio(value) : value;
  if (!r || r.num <= 0) throw new RangeError(`invalid frame rate: ${JSON.stringify(value)}`);
  return r;
}

export function sourceTime(mediaId: string, seconds: Rational): SourceTime {
  if (!mediaId) throw new TypeError("source time needs a mediaId");
  return { domain: "source", mediaId, seconds };
}

export function timelineTime(seconds: Rational): TimelineTime {
  return { domain: "timeline", seconds };
}

export function frameIndex(index: number, rate: FrameRate): FrameIndex {
  if (!Number.isSafeInteger(index)) {
    throw new TypeError(`frame index must be an integer, got ${index}`);
  }
  return { unit: "frame", index, rate: frameRate(rate) };
}

/** Exact start time of a frame on its grid: index * den / num. */
export function frameToSeconds(frame: FrameIndex): Rational {
  return div(rational(frame.index), frame.rate);
}

/**
 * Frame on `rate`'s grid for time `seconds`.
 *  - floor:   the frame whose interval contains the time (use for sampling / "what is on screen")
 *  - ceil:    the first frame starting at or after the time
 *  - nearest: nearest frame start; exact halves round up
 */
export function secondsToFrame(seconds: Rational, rate: FrameRate, rounding: Rounding): FrameIndex {
  const exact = mul(seconds, rate);
  const index = rounding === "floor" ? floor(exact) : rounding === "ceil" ? ceil(exact) : roundHalfUp(exact);
  return frameIndex(index, rate);
}

/** Move a frame index from one grid to another, naming the rounding. */
export function convertFrame(frame: FrameIndex, to: FrameRate, rounding: Rounding): FrameIndex {
  return secondsToFrame(frameToSeconds(frame), to, rounding);
}

/** True when the time lies exactly on a frame boundary of the grid. */
export function isOnFrameBoundary(seconds: Rational, rate: FrameRate): boolean {
  return mul(seconds, rate).den === 1;
}

export function addSourceTime(t: SourceTime, delta: Rational): SourceTime {
  return sourceTime(t.mediaId, add(t.seconds, delta));
}

export function addTimelineTime(t: TimelineTime, delta: Rational): TimelineTime {
  return timelineTime(add(t.seconds, delta));
}

/** Difference within one domain. Mixing domains (or media) throws. */
export function timeDifference(a: SourceTime | TimelineTime, b: SourceTime | TimelineTime): Rational {
  if (a.domain !== b.domain) {
    throw new TypeError(`cannot subtract ${b.domain} time from ${a.domain} time`);
  }
  if (a.domain === "source" && b.domain === "source" && a.mediaId !== b.mediaId) {
    throw new TypeError(`cannot subtract source times of different media (${a.mediaId} vs ${b.mediaId})`);
  }
  return sub(a.seconds, b.seconds);
}

export function compareTime(a: SourceTime | TimelineTime, b: SourceTime | TimelineTime): -1 | 0 | 1 {
  timeDifference(a, b); // domain checks
  return compare(a.seconds, b.seconds);
}

// ---------------------------------------------------------------------------
// Human-entered time literals — the unit is mandatory.
// ---------------------------------------------------------------------------

export type TimeLiteral =
  | { readonly unit: "seconds"; readonly seconds: Rational }
  | { readonly unit: "frame"; readonly index: number };

/**
 * Parse a time literal with an explicit unit:
 *   "12.5s"          -> seconds (exact)
 *   "120f"           -> frame 120 (caller supplies the grid's rate)
 *   "00:01:02.500"   -> HH:MM:SS[.fraction] seconds
 * Bare numbers ("120", "120.0", "12.5") are rejected: the unit would have to be guessed.
 */
export function parseTimeLiteral(text: string): TimeLiteral {
  const t = text.trim();
  let m = /^([+-]?\d+(?:\.\d+)?)s$/.exec(t);
  if (m) return { unit: "seconds", seconds: parseDecimal(m[1]!) };
  m = /^(\d+)f$/.exec(t);
  if (m) return { unit: "frame", index: Number(m[1]) };
  m = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(t);
  if (m) {
    const hours = rational(Number(m[1]));
    const minutes = rational(Number(m[2]));
    const secs = parseDecimal(m[3]!);
    return {
      unit: "seconds",
      seconds: add(add(mul(hours, rational(3600)), mul(minutes, rational(60))), secs),
    };
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(t)) {
    throw new SyntaxError(
      `ambiguous time ${JSON.stringify(text)}: add a unit ("${t}s" for seconds or "${t}f" for a frame)`,
    );
  }
  throw new SyntaxError(`unrecognised time literal ${JSON.stringify(text)}`);
}

/** Resolve a literal to exact seconds; frame literals need the rate of their grid. */
export function literalToSeconds(literal: TimeLiteral, rate?: FrameRate): Rational {
  if (literal.unit === "seconds") return literal.seconds;
  if (!rate) throw new TypeError("a frame literal needs the frame rate of its grid");
  return frameToSeconds(frameIndex(literal.index, rate));
}

export function formatSeconds(seconds: Rational, places = 3): string {
  return `${toDecimalString(seconds, places)}s`;
}
