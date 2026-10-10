import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecimal, rational } from "../../src/time/rational.ts";
import {
  compareTime,
  convertFrame,
  frameIndex,
  frameRate,
  frameToSeconds,
  isOnFrameBoundary,
  literalToSeconds,
  parseTimeLiteral,
  secondsToFrame,
  sourceTime,
  timeDifference,
  timelineTime,
} from "../../src/time/time.ts";

const NTSC = frameRate("30000/1001");

describe("explicit time units", () => {
  it("rejects bare numbers instead of guessing the unit", () => {
    for (const ambiguous of ["120", "120.0", "12.5", "-3"]) {
      assert.throws(() => parseTimeLiteral(ambiguous), /ambiguous time/);
    }
  });

  it("parses seconds, frames and clock literals", () => {
    assert.deepEqual(parseTimeLiteral("12.5s"), { unit: "seconds", seconds: rational(25, 2) });
    assert.deepEqual(parseTimeLiteral("120f"), { unit: "frame", index: 120 });
    assert.deepEqual(parseTimeLiteral("00:01:02.500"), { unit: "seconds", seconds: rational(125, 2) });
    assert.throws(() => parseTimeLiteral("12.5 seconds"), SyntaxError);
  });

  it("needs a frame rate to turn a frame literal into seconds", () => {
    const lit = parseTimeLiteral("120f");
    assert.throws(() => literalToSeconds(lit), /frame rate/);
    assert.deepEqual(literalToSeconds(lit, frameRate("30/1")), rational(4));
    assert.deepEqual(literalToSeconds(lit, NTSC), rational(1001, 250));
  });

  it("frame index is an integer bound to a grid", () => {
    assert.throws(() => frameIndex(1.5, NTSC), TypeError);
    assert.throws(() => frameRate("0/0"), RangeError);
  });
});

describe("frame <-> seconds on rational grids", () => {
  it("keeps 29.97 exact", () => {
    assert.deepEqual(frameToSeconds(frameIndex(30, NTSC)), rational(1001, 1000));
    assert.deepEqual(frameToSeconds(frameIndex(30000, NTSC)), rational(1001));
  });

  it("names its rounding", () => {
    const t = parseDecimal("1.0");
    assert.equal(secondsToFrame(t, NTSC, "floor").index, 29); // 29.97 -> frame 29 is on screen
    assert.equal(secondsToFrame(t, NTSC, "ceil").index, 30);
    assert.equal(secondsToFrame(t, NTSC, "nearest").index, 30);
    // exact half rounds up
    assert.equal(secondsToFrame(rational(1, 60), frameRate("30/1"), "nearest").index, 1);
  });

  it("round-trips every frame of a minute at 30000/1001", () => {
    for (let i = 0; i < 1800; i++) {
      const s = frameToSeconds(frameIndex(i, NTSC));
      assert.equal(secondsToFrame(s, NTSC, "floor").index, i);
      assert.ok(isOnFrameBoundary(s, NTSC));
    }
  });

  it("converts between grids explicitly", () => {
    const f = convertFrame(frameIndex(100, frameRate("25/1")), NTSC, "floor");
    assert.equal(f.index, 119); // 4.0 s * 29.97 = 119.88
    assert.deepEqual(f.rate, NTSC);
  });
});

describe("source vs timeline domains", () => {
  it("refuses to mix domains or media", () => {
    const a = sourceTime("m_aaaaaaaaaaaaaaaa", rational(2));
    const b = sourceTime("m_bbbbbbbbbbbbbbbb", rational(1));
    const t = timelineTime(rational(1));
    assert.throws(() => timeDifference(a, t), /cannot subtract timeline time from source time/);
    assert.throws(() => timeDifference(a, b), /different media/);
    assert.deepEqual(timeDifference(a, sourceTime("m_aaaaaaaaaaaaaaaa", rational(1, 2))), rational(3, 2));
    assert.equal(compareTime(timelineTime(rational(1)), t), 0);
  });
});
