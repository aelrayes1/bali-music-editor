/**
 * Phase 11.5 grading math (pure, deterministic): shot statistics, the ASC CDL transform, and a
 * RESTRAINED per-shot solver for technical normalization + adjacent-shot matching.
 *
 * Values are normalized full-range RGB in [0, 1] (8-bit decode / 255 — what Resolve's YRGB
 * pipeline works on after mapping video levels to full). The CDL is the ASC CDL v1.2:
 *   out = clamp((in * slope + offset), 0, 1) ^ power;  then saturation around Rec.709 luma.
 * Nothing here is a creative look: every correction is capped, most are half-corrections toward a
 * target, and the payoff (a different camera, intentional club light) keeps its own character.
 */

export interface CdlValues {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  saturation: number;
}
export const IDENTITY_CDL: CdlValues = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/** ASC CDL on one normalized RGB triplet. */
export function cdlPixel(c: CdlValues, r: number, g: number, b: number): [number, number, number] {
  const ch = (v: number, i: number) => Math.pow(Math.min(1, Math.max(0, v * c.slope[i]! + c.offset[i]!)), c.power[i]!);
  let R = ch(r, 0);
  let G = ch(g, 1);
  let B = ch(b, 2);
  if (c.saturation !== 1) {
    const l = LR * R + LG * G + LB * B;
    R = l + c.saturation * (R - l);
    G = l + c.saturation * (G - l);
    B = l + c.saturation * (B - l);
  }
  return [Math.min(1, Math.max(0, R)), Math.min(1, Math.max(0, G)), Math.min(1, Math.max(0, B))];
}

/** ASC CDL on an 8-bit RGB buffer (new buffer). */
export function applyCdl(c: CdlValues, rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const [r, g, b] = cdlPixel(c, rgb[i]! / 255, rgb[i + 1]! / 255, rgb[i + 2]! / 255);
    out[i] = Math.round(r * 255);
    out[i + 1] = Math.round(g * 255);
    out[i + 2] = Math.round(b * 255);
  }
  return out;
}

export interface FrameStats {
  lumaP005: number;
  lumaP05: number;
  lumaP50: number;
  lumaP95: number;
  lumaP995: number;
  lumaMean: number;
  /** mean chroma (max - min of RGB): a saturation proxy */
  chroma: number;
  /** mean R, G, B of near-neutral midtone pixels (chroma < 0.06, luma 0.15-0.85): the white-balance probe */
  neutral: [number, number, number] | null;
  neutralShare: number;
  /** share of pixels with any channel >= 0.98 */
  clip: number;
  /** share of pixels with luma <= 0.02 */
  crush: number;
  /** median luma of the subject band (the face/subject region), or null */
  subjectLuma: number | null;
  /** skin-like pixels inside the subject band: share of the band, median luma, median chroma, median hue (deg) */
  skinShare: number;
  skinLuma: number | null;
  skinChroma: number | null;
  skinHue: number | null;
}

/** A conservative skin-tone test on normalized RGB (all skin tones: R > G > B, moderate chroma, not black / not clipped). */
export function isSkin(r: number, g: number, b: number): boolean {
  const l = LR * r + LG * g + LB * b;
  const c = Math.max(r, g, b) - Math.min(r, g, b);
  return r > g && g > b && r - b > 0.05 && r - g > 0.015 && l > 0.04 && l < 0.85 && c > 0.04 && c < 0.45;
}
/** hue in degrees (0-360) of a normalized RGB triplet */
export function hueDeg(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d <= 0) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Statistics of one 8-bit RGB frame; `subject` = rectangle (fractions of w/h) of the subject band. */
export function frameStats(rgb: Uint8Array, w: number, h: number, subject: { x0: number; x1: number; y0: number; y1: number } | null = null): FrameStats {
  const n = w * h;
  const hist = new Uint32Array(1024);
  const shist = new Uint32Array(1024);
  let sn = 0;
  const skinL: number[] = [];
  const skinC: number[] = [];
  const skinH: number[] = [];
  let sum = 0;
  let chroma = 0;
  let nr = 0;
  let ng = 0;
  let nb = 0;
  let nn = 0;
  let clip = 0;
  let crush = 0;
  for (let p = 0; p < n; p++) {
    const r = rgb[p * 3]! / 255;
    const g = rgb[p * 3 + 1]! / 255;
    const b = rgb[p * 3 + 2]! / 255;
    const l = LR * r + LG * g + LB * b;
    hist[Math.min(1023, Math.floor(l * 1023))]!++;
    sum += l;
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    chroma += c;
    if (c < 0.06 && l >= 0.15 && l <= 0.85) {
      nr += r;
      ng += g;
      nb += b;
      nn++;
    }
    if (r >= 0.98 || g >= 0.98 || b >= 0.98) clip++;
    if (l <= 0.02) crush++;
    if (subject) {
      const x = (p % w) / w;
      const y = Math.floor(p / w) / h;
      if (x >= subject.x0 && x < subject.x1 && y >= subject.y0 && y < subject.y1) {
        shist[Math.min(1023, Math.floor(l * 1023))]!++;
        sn++;
        if (isSkin(r, g, b)) {
          skinL.push(l);
          skinC.push(c);
          skinH.push(hueDeg(r, g, b));
        }
      }
    }
  }
  const pct = (hh: Uint32Array, total: number, q: number) => {
    const target = q * total;
    let acc = 0;
    for (let i = 0; i < 1024; i++) {
      acc += hh[i]!;
      if (acc >= target) return i / 1023;
    }
    return 1;
  };
  return {
    lumaP005: pct(hist, n, 0.005),
    lumaP05: pct(hist, n, 0.05),
    lumaP50: pct(hist, n, 0.5),
    lumaP95: pct(hist, n, 0.95),
    lumaP995: pct(hist, n, 0.995),
    lumaMean: sum / n,
    chroma: chroma / n,
    neutral: nn >= n * 0.01 ? [nr / nn, ng / nn, nb / nn] : null,
    neutralShare: nn / n,
    clip: clip / n,
    crush: crush / n,
    subjectLuma: subject && sn ? pct(shist, sn, 0.5) : null,
    skinShare: sn ? skinL.length / sn : 0,
    skinLuma: skinL.length ? median(skinL) : null,
    skinChroma: skinC.length ? median(skinC) : null,
    skinHue: skinH.length ? median(skinH) : null,
  };
}

/** Per-shot aggregate: the median of every per-frame statistic (robust to single-frame spikes). */
export function shotStats(frames: FrameStats[]): FrameStats {
  const m = (k: keyof FrameStats) => median(frames.map((f) => f[k] as number));
  const neutrals = frames.map((f) => f.neutral).filter((x): x is [number, number, number] => !!x);
  const subj = frames.map((f) => f.subjectLuma).filter((x): x is number => x !== null);
  const nn = <K extends "skinLuma" | "skinChroma" | "skinHue">(k: K) => frames.filter((f) => f.skinShare >= MIN_SKIN_SHARE && f[k] !== null).map((f) => f[k] as number);
  return {
    lumaP005: m("lumaP005"),
    lumaP05: m("lumaP05"),
    lumaP50: m("lumaP50"),
    lumaP95: m("lumaP95"),
    lumaP995: m("lumaP995"),
    lumaMean: m("lumaMean"),
    chroma: m("chroma"),
    neutral: neutrals.length ? [median(neutrals.map((x) => x[0])), median(neutrals.map((x) => x[1])), median(neutrals.map((x) => x[2]))] : null,
    neutralShare: m("neutralShare"),
    clip: m("clip"),
    crush: m("crush"),
    subjectLuma: subj.length ? median(subj) : null,
    skinShare: median(frames.map((f) => f.skinShare)),
    skinLuma: nn("skinLuma").length ? median(nn("skinLuma")) : null,
    skinChroma: nn("skinChroma").length ? median(nn("skinChroma")) : null,
    skinHue: nn("skinHue").length ? median(nn("skinHue")) : null,
  };
}

/** a frame's skin statistics count only when skin covers at least this share of the subject band */
export const MIN_SKIN_SHARE = 0.01;
/** white balance is only estimated when near-neutral midtones cover at least this share of the frame */
export const MIN_NEUTRAL_SHARE = 0.03;

export interface SolveLimits {
  /** exposure factor range for matching (subject luma toward the group target) */
  exposure: [number, number];
  /** fraction of the log-distance to the target that is corrected (0.5 = half) */
  exposureStrength: number;
  /** ignore exposure differences smaller than this (log ratio) */
  exposureDeadband: number;
  /** black point: lower milky blacks when p0.5 luma exceeds this; aim for blackTarget */
  blackThreshold: number;
  blackTarget: number;
  blackStrength: number;
  maxBlackOffset: number;
  /** white balance: per-channel gain range, cast deadband, and strength (half-correction) */
  wbGain: [number, number];
  wbDeadband: number;
  wbStrength: number;
  saturation: [number, number];
  saturationDeadband: number;
  saturationStrength: number;
}
export const DEFAULT_LIMITS: SolveLimits = { exposure: [0.93, 1.07], exposureStrength: 0.5, exposureDeadband: 0.02, blackThreshold: 0.07, blackTarget: 0.045, blackStrength: 0.6, maxBlackOffset: 0.03, wbGain: [0.97, 1.03], wbDeadband: 0.015, wbStrength: 0.5, saturation: [0.94, 1.06], saturationDeadband: 0.03, saturationStrength: 0.5 };

export interface ShotSolution {
  cdl: CdlValues;
  normalization: { blackLift: number; wb: [number, number, number]; notes: string[] };
  matching: { exposure: number; saturation: number; notes: string[] };
  highlightGuard?: { clipBefore: number; clipRequested: number; clipAfter: number; notes: string[] };
}

/**
 * Solve one shot. `role` = "group" (matched to the group targets) or "payoff" (normalization only
 * where clearly needed; intentional light colour and the shot's own level are kept).
 */
export function solveShot(s: FrameStats, targets: { skinLuma: number | null; skinChroma: number | null }, role: "group" | "payoff", L: SolveLimits = DEFAULT_LIMITS): ShotSolution {
  const nNotes: string[] = [];
  const mNotes: string[] = [];
  // --- normalization: black level (lower milky blacks, black-pinned so whites stay put)
  let delta = 0;
  if (s.lumaP005 > L.blackThreshold) {
    delta = Math.min(L.maxBlackOffset, (s.lumaP005 - L.blackTarget) * L.blackStrength);
    nNotes.push(`black p0.5 ${s.lumaP005.toFixed(3)} > ${L.blackThreshold}: lowered by ${delta.toFixed(3)} (black-pinned)`);
  } else nNotes.push(`black p0.5 ${s.lumaP005.toFixed(3)}: no change`);
  // --- normalization: white balance from near-neutral midtones (never on the payoff's club light)
  let wb: [number, number, number] = [1, 1, 1];
  if (role === "group" && s.neutral && s.neutralShare >= MIN_NEUTRAL_SHARE) {
    const [r, g, b] = s.neutral;
    const avg = (r + g + b) / 3;
    const cast = Math.max(Math.abs(r / avg - 1), Math.abs(g / avg - 1), Math.abs(b / avg - 1));
    if (cast > L.wbDeadband) {
      const k = [r, g, b].map((c) => Math.min(L.wbGain[1], Math.max(L.wbGain[0], Math.pow(avg / c, L.wbStrength)))) as [number, number, number];
      const lum = LR * k[0] + LG * k[1] + LB * k[2];
      wb = k.map((x) => x / lum) as [number, number, number];
      nNotes.push(`neutral cast ${(cast * 100).toFixed(1)}% (share ${(s.neutralShare * 100).toFixed(1)}%): half-corrected, luma-preserving gains ${wb.map((x) => x.toFixed(3)).join("/")}`);
    } else nNotes.push(`neutral cast ${(cast * 100).toFixed(1)}%: within deadband`);
  } else nNotes.push(role === "payoff" ? "white balance kept (intentional club light)" : `too few near-neutral midtones (${(s.neutralShare * 100).toFixed(1)}% < ${MIN_NEUTRAL_SHARE * 100}%): white balance kept (no guessing)`);
  // --- matching: SKIN brightness toward the group target (half the log distance, capped)
  let e = 1;
  if (role === "group" && s.skinLuma !== null && targets.skinLuma !== null) {
    const ratio = Math.log(targets.skinLuma / s.skinLuma);
    if (Math.abs(ratio) > L.exposureDeadband) {
      e = Math.min(L.exposure[1], Math.max(L.exposure[0], Math.exp(ratio * L.exposureStrength)));
      mNotes.push(`skin luma ${s.skinLuma.toFixed(3)} vs target ${targets.skinLuma.toFixed(3)}: exposure x${e.toFixed(3)}`);
    } else mNotes.push(`skin luma ${s.skinLuma.toFixed(3)} within the deadband of the target ${targets.skinLuma.toFixed(3)}`);
  } else mNotes.push(role === "payoff" ? "payoff keeps its own exposure (deliberate contrast with the archive)" : "no reliable skin probe: exposure kept");
  // --- matching: SKIN saturation toward the group target (skin, not scene content, drives the match)
  let sat = 1;
  if (role === "group" && s.skinChroma !== null && targets.skinChroma !== null) {
    const ratio = Math.log(targets.skinChroma / s.skinChroma);
    if (Math.abs(ratio) > L.saturationDeadband) {
      sat = Math.min(L.saturation[1], Math.max(L.saturation[0], Math.exp(ratio * L.saturationStrength)));
      mNotes.push(`skin chroma ${s.skinChroma.toFixed(3)} vs target ${targets.skinChroma.toFixed(3)}: saturation x${sat.toFixed(3)}`);
    } else mNotes.push(`skin chroma ${s.skinChroma.toFixed(3)} within the deadband`);
  }
  // The exposure match is a midtone move (CDL power), anchored at black and white: the skin reaches
  // e x its level while nothing is pushed past white (a slope > 1 would clip the near-white
  // highlights, and a later highlight curve cannot recover values above 1.0).
  const k = 1 / (1 - delta);
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  let power = 1;
  if (e !== 1 && s.skinLuma !== null) {
    const at = Math.min(0.95, Math.max(0.01, (s.skinLuma - delta) * k));
    power = Math.log(Math.min(0.99, at * e)) / Math.log(at);
    mNotes.push(`realised as a midtone power ${power.toFixed(4)} (black and white anchored)`);
  }
  const cdl: CdlValues = { slope: wb.map((x) => r6(x * k)) as [number, number, number], offset: wb.map((x) => r6(-delta * x * k)) as [number, number, number], power: [r6(power), r6(power), r6(power)], saturation: r6(sat) };
  return { cdl, normalization: { blackLift: r6(-delta), wb: wb.map(r6) as [number, number, number], notes: nNotes }, matching: { exposure: r6(e), saturation: r6(sat), notes: mNotes } };
}

/** Group targets: the median skin luma and skin chroma of the matched shots that have a skin probe. */
export function groupTargets(stats: FrameStats[]): { skinLuma: number | null; skinChroma: number | null } {
  const l = stats.map((s) => s.skinLuma).filter((x): x is number => x !== null);
  const c = stats.map((s) => s.skinChroma).filter((x): x is number => x !== null);
  return { skinLuma: l.length ? median(l) : null, skinChroma: c.length ? median(c) : null };
}

/** Share of pixels with any channel at or above 250/255 (clipped or about to clip). */
export function clipShare(rgb: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! >= 250 || rgb[i + 1]! >= 250 || rgb[i + 2]! >= 250) c++;
  return c / (rgb.length / 3);
}

/**
 * Highlight guard. A grade may not add more than `tolerance` (a share of pixels) of clipping to a
 * shot's frames (all of them, CLEAN_TO_CHAOS windows included). A saturation above 1 is pulled toward
 * 1 first (it pushes coloured near-white highlights past the channel maximum), then a power below 1
 * (the midtone lift), in tenths. Darkening moves never add clipping and are left alone.
 */
export function guardHighlights(sol: ShotSolution, frames: Uint8Array[], tolerance = 0.005): ShotSolution {
  const mean = (c: CdlValues) => frames.reduce((t, f) => t + clipShare(applyCdl(c, f)), 0) / Math.max(1, frames.length);
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  const before = mean(IDENTITY_CDL);
  const requested = mean(sol.cdl);
  const notes: string[] = [];
  let cdl = sol.cdl;
  let after = requested;
  const sat0 = cdl.saturation;
  const pow0 = cdl.power;
  for (let step = 1; after - before > tolerance && step <= 20; step++) {
    const ts = Math.min(1, step / 10);
    const tp = Math.max(0, (step - 10) / 10);
    const sat = sat0 > 1 ? 1 + (sat0 - 1) * (1 - ts) : sat0;
    const power = pow0.map((p) => (p < 1 ? p + (1 - p) * tp : p)) as [number, number, number];
    cdl = { ...cdl, saturation: r6(sat), power: power.map(r6) as [number, number, number] };
    after = mean(cdl);
  }
  if (cdl.saturation !== sat0) notes.push(`saturation x${sat0.toFixed(3)} would clip ${((requested - before) * 100).toFixed(1)}% more pixels: reduced to x${cdl.saturation.toFixed(3)}`);
  if (cdl.power[1] !== pow0[1]) notes.push(`midtone power ${pow0[1].toFixed(4)} reduced to ${cdl.power[1].toFixed(4)} (highlight guard)`);
  if (!notes.length) notes.push(`adds ${((requested - before) * 100).toFixed(2)}% clipped pixels (within ${(tolerance * 100).toFixed(1)}%)`);
  return { ...sol, cdl, matching: { ...sol.matching, saturation: cdl.saturation }, highlightGuard: { clipBefore: r4(before), clipRequested: r4(requested), clipAfter: r4(after), notes } };
}
