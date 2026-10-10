import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
} from "../../src/time/rational.ts";

describe("rational", () => {
  it("normalizes sign and gcd", () => {
    assert.deepEqual(rational(60000, 2002), { num: 30000, den: 1001 });
    assert.deepEqual(rational(3, -6), { num: -1, den: 2 });
    assert.deepEqual(rational(0, 5), { num: 0, den: 1 });
  });

  it("rejects zero denominators and unsafe integers", () => {
    assert.throws(() => rational(1, 0), RangeError);
    assert.throws(() => rational(2 ** 60), RangeError);
    assert.throws(() => rational(1.5), RangeError);
  });

  it("does exact arithmetic without float drift", () => {
    const tenth = rational(1, 10);
    let acc = rational(0);
    for (let i = 0; i < 10; i++) acc = add(acc, tenth);
    assert.deepEqual(acc, rational(1)); // 0.1 * 10 === 1 exactly
    assert.deepEqual(sub(rational(1), rational(1, 3)), rational(2, 3));
    assert.deepEqual(mul(rational(30000, 1001), rational(1001, 1000)), rational(30));
    assert.deepEqual(div(rational(1), rational(30000, 1001)), rational(1001, 30000));
  });

  it("throws instead of overflowing", () => {
    const big = rational(Number.MAX_SAFE_INTEGER - 1);
    assert.throws(() => mul(big, rational(3)), RangeError);
  });

  it("parses ffprobe ratios, keeping 30000/1001 exact", () => {
    assert.deepEqual(parseRatio("30000/1001"), { num: 30000, den: 1001 });
    assert.deepEqual(parseRatio("9048/331"), { num: 9048, den: 331 });
    assert.deepEqual(parseRatio("1:1"), { num: 1, den: 1 });
    assert.deepEqual(parseRatio("32:27"), { num: 32, den: 27 });
    for (const unknown of ["0/0", "0:1", "N/A", "", undefined, null]) assert.equal(parseRatio(unknown), null);
    assert.throws(() => parseRatio("29.97"), SyntaxError);
  });

  it("parses plain decimals exactly", () => {
    assert.deepEqual(parseDecimal("13.791678"), rational(13791678, 1000000));
    assert.deepEqual(parseDecimal("-0.021333"), rational(-21333, 1000000));
    assert.deepEqual(parseDecimal("2"), rational(2));
    assert.throws(() => parseDecimal("1e3"), SyntaxError);
    assert.throws(() => parseDecimal("12.5s"), SyntaxError);
  });

  it("rounds deterministically", () => {
    assert.equal(floor(rational(-1, 2)), -1);
    assert.equal(ceil(rational(-1, 2)), 0);
    assert.equal(roundHalfUp(rational(5, 2)), 3);
    assert.equal(roundHalfUp(rational(-5, 2)), -2);
    assert.equal(toDecimalString(rational(1001, 30000), 6), "0.033367");
    assert.equal(toDecimalString(rational(-1, 3), 3), "-0.333");
  });

  it("compares exactly", () => {
    assert.equal(compare(rational(30000, 1001), rational(30)), -1);
    assert.equal(compare(rational(2, 4), rational(1, 2)), 0);
  });
});
