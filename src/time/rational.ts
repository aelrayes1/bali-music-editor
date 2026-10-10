/**
 * Exact rational numbers for all timing in the project.
 *
 * A Rational is always normalized: integer numerator, positive integer denominator,
 * gcd(num, den) = 1, and both within Number.MAX_SAFE_INTEGER so it serializes to JSON
 * losslessly. Arithmetic runs in BigInt and is re-checked on the way out, so an
 * overflow throws instead of silently losing precision.
 */

export interface Rational {
  readonly num: number;
  readonly den: number;
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fromBig(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("rational denominator must not be zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  num /= g;
  den /= g;
  if (num > MAX || -num > MAX || den > MAX) {
    throw new RangeError(`rational ${num}/${den} exceeds the safe integer range`);
  }
  return { num: Number(num), den: Number(den) };
}

function big(r: Rational): [bigint, bigint] {
  return [BigInt(r.num), BigInt(r.den)];
}

export function rational(num: number | bigint, den: number | bigint = 1): Rational {
  if (typeof num === "number" && !Number.isSafeInteger(num)) {
    throw new RangeError(`rational numerator must be a safe integer, got ${num}`);
  }
  if (typeof den === "number" && !Number.isSafeInteger(den)) {
    throw new RangeError(`rational denominator must be a safe integer, got ${den}`);
  }
  return fromBig(BigInt(num), BigInt(den));
}

export const ZERO: Rational = rational(0);
export const ONE: Rational = rational(1);

export function isRational(value: unknown): value is Rational {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(v.num) &&
    Number.isSafeInteger(v.den) &&
    (v.den as number) > 0
  );
}

export function add(a: Rational, b: Rational): Rational {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  return fromBig(an * bd + bn * ad, ad * bd);
}

export function sub(a: Rational, b: Rational): Rational {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  return fromBig(an * bd - bn * ad, ad * bd);
}

export function mul(a: Rational, b: Rational): Rational {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  return fromBig(an * bn, ad * bd);
}

export function div(a: Rational, b: Rational): Rational {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  if (bn === 0n) throw new RangeError("division by zero rational");
  return fromBig(an * bd, ad * bn);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const [an, ad] = big(a);
  const [bn, bd] = big(b);
  const l = an * bd;
  const r = bn * ad;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function equals(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den; // both are normalized
}

export function abs(a: Rational): Rational {
  return a.num < 0 ? { num: -a.num, den: a.den } : a;
}

/** Largest integer <= r. */
export function floor(r: Rational): number {
  const [n, d] = big(r);
  let q = n / d;
  if (n % d !== 0n && n < 0n) q -= 1n;
  return Number(q);
}

/** Smallest integer >= r. */
export function ceil(r: Rational): number {
  const [n, d] = big(r);
  let q = n / d;
  if (n % d !== 0n && n > 0n) q += 1n;
  return Number(q);
}

/** Nearest integer; exact halves round toward positive infinity (deterministic, documented). */
export function roundHalfUp(r: Rational): number {
  return floor(add(r, rational(1, 2)));
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a plain decimal string ("12.345678", "-0.5") exactly. No exponents, no units.
 * Used for ffprobe fields, which are decimal strings, never binary floats.
 */
export function parseDecimal(text: string): Rational {
  const m = DECIMAL_RE.exec(text.trim());
  if (!m) throw new SyntaxError(`not a plain decimal number: ${JSON.stringify(text)}`);
  const [, sign, intPart, frac = ""] = m;
  const digits = BigInt((intPart ?? "0") + frac);
  const scale = 10n ** BigInt(frac.length);
  return fromBig(sign === "-" ? -digits : digits, scale);
}

/**
 * Parse an ffprobe ratio such as "30000/1001", "30/1" or "1:1".
 * Returns null for the "unknown" forms ffprobe emits ("0/0", "0:1", "N/A", "").
 */
export function parseRatio(text: string | undefined | null): Rational | null {
  if (text === undefined || text === null) return null;
  const t = text.trim();
  if (t === "" || t === "N/A") return null;
  const m = /^(-?\d+)[/:](\d+)$/.exec(t);
  if (!m) throw new SyntaxError(`not a ratio: ${JSON.stringify(text)}`);
  const num = BigInt(m[1]!);
  const den = BigInt(m[2]!);
  if (den === 0n || num === 0n) return null;
  return fromBig(num, den);
}

/** Format with a fixed number of decimal places (round half up). Display only, never canonical. */
export function toDecimalString(r: Rational, places = 6): string {
  const scale = 10n ** BigInt(places);
  const scaled = roundHalfUpBig(BigInt(r.num) * scale, BigInt(r.den));
  const negative = scaled < 0n;
  const absScaled = negative ? -scaled : scaled;
  const intPart = absScaled / scale;
  const fracPart = (absScaled % scale).toString().padStart(places, "0");
  return `${negative ? "-" : ""}${intPart}${places > 0 ? "." + fracPart : ""}`;
}

function roundHalfUpBig(n: bigint, d: bigint): bigint {
  // floor((2n + d) / (2d)) for d > 0
  const num = 2n * n + d;
  const den = 2n * d;
  let q = num / den;
  if (num % den !== 0n && num < 0n) q -= 1n;
  return q;
}

/** Approximate float for logging and heuristics only. Never store the result. */
export function toNumberApprox(r: Rational): number {
  return r.num / r.den;
}

export function toString(r: Rational): string {
  return `${r.num}/${r.den}`;
}
