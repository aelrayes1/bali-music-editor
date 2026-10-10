/**
 * Phase 11.75 highlight-selective bloom (pure, deterministic). One parameter object drives both the
 * Resolve DCTL (`bloomDctl`, applied as the node LUT on the Payoff item's last node, i.e. post-grade)
 * and its offline twin (`bloomField` / `applyBloom`), so the shader and the verification cannot drift.
 *
 * - Highlight isolation: Rec.709 luma above `threshold`, smoothstep over `knee`. Nothing darker contributes.
 * - Spread: a two-lobe Gaussian (tight core + soft halo), tapered smoothly to zero at `radius`, sampled
 *   DENSELY (every pixel in the disc). The feasibility shader sampled a 4 px grid, and a thin bright line
 *   then bloomed as copies shifted by the grid step (grid ghosting); dense sampling has no lattice.
 * - Outside the frame counts as black (no edge streaks); the weights are normalised by the full disc.
 * - Screen blend at `strength`, under a HUE-PRESERVING HIGHLIGHT CEILING: the added light, the RGB vector
 *   inc = (1 - src) * min(1, strength * field), is scaled by ONE factor k = (1 - exp(-t)) / t, where t is
 *   the largest inc_c / (CEILING - src_c) over the channels. The most constrained channel approaches
 *   CEILING smoothly and never reaches it, the others keep the same proportion (the added light keeps its
 *   colour), and a pixel with any channel at or above CEILING is untouched (a light's own core keeps its
 *   colour; a bright wash cannot be pushed into clipping). Small additions are exactly the screen blend.
 *   Never darkens. Spatial only: no frame memory, so nothing can cross a cut.
 * Distances are in pixels at 1920 height (the timeline is 1080x1920; other sizes scale).
 */

export interface BloomParams {
  threshold: number;
  knee: number;
  strength: number;
  sigmaCore: number;
  sigmaHalo: number;
  /** share of the kernel energy in the halo lobe (0..1) */
  haloShare: number;
  radius: number;
}

/** the shared shape; D1-D3 differ only in `strength` */
/** the bloom never lifts a channel to or above this (0.955 = 243.5 / 255, below the 250 clip level) */
export const CEILING = 0.955;

export const BLOOM_SHAPE: Omit<BloomParams, "strength"> = { threshold: 0.8, knee: 0.12, sigmaCore: 3.5, sigmaHalo: 9, haloShare: 0.5, radius: 24 };

export class BloomParamError extends Error {}

export function validateBloomParams(p: BloomParams): BloomParams {
  const bad = (m: string) => {
    throw new BloomParamError(m);
  };
  if (!(p.threshold >= 0.6 && p.threshold <= 0.95)) bad(`threshold ${p.threshold} outside 0.6-0.95 (highlights only)`);
  if (!(p.knee > 0 && p.threshold + p.knee <= 1.0001)) bad(`knee ${p.knee} must be > 0 and end by 1.0`);
  if (!(p.strength >= 0 && p.strength <= 12)) bad(`strength ${p.strength} outside 0-12`);
  if (!(p.sigmaCore > 0 && p.sigmaHalo >= p.sigmaCore)) bad("sigmaCore > 0 and sigmaHalo >= sigmaCore");
  if (!(p.haloShare >= 0 && p.haloShare <= 1)) bad("haloShare outside 0-1");
  if (!(p.radius >= 2.5 * p.sigmaHalo && p.radius <= 64)) bad(`radius ${p.radius} must be >= 2.5 x sigmaHalo (no truncation step) and <= 64 (cost)`);
  return p;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
export const brightness = (r: number, g: number, b: number, p: Pick<BloomParams, "threshold" | "knee">) => smooth(Math.min(1, Math.max(0, (0.2126 * r + 0.7152 * g + 0.0722 * b - p.threshold) / p.knee)));

/** kernel weight at distance d (1920-height px), unnormalised; exactly the DCTL's expression */
export function kernelWeight(d: number, p: Omit<BloomParams, "strength">): number {
  const d2 = d * d;
  const core = ((1 - p.haloShare) / (p.sigmaCore * p.sigmaCore)) * Math.exp(-d2 / (2 * p.sigmaCore * p.sigmaCore));
  const halo = (p.haloShare / (p.sigmaHalo * p.sigmaHalo)) * Math.exp(-d2 / (2 * p.sigmaHalo * p.sigmaHalo));
  const t = Math.min(1, Math.max(0, (d - 0.75 * p.radius) / (0.25 * p.radius)));
  return (core + halo) * (1 - smooth(t));
}

export interface Tap {
  dx: number;
  dy: number;
  w: number;
}
/** every integer offset inside the disc (scale s = height / 1920), with its weight; and the weight sum */
export function denseTaps(p: Omit<BloomParams, "strength">, s = 1): { taps: Tap[]; wsum: number } {
  const R = Math.round(p.radius * s);
  const taps: Tap[] = [];
  let wsum = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy) / s;
      if (d > p.radius) continue;
      const w = kernelWeight(d, p);
      if (w <= 0) continue;
      taps.push({ dx, dy, w });
      wsum += w;
    }
  return { taps, wsum };
}

/**
 * The feasibility probe's sparse kernel (15 x 15 taps at 4 px, sigma 14, normalised by its weights),
 * kept ONLY as the anti-ghosting regression's positive control. Never used for a render.
 */
export function sparseReferenceTaps(s = 1): { taps: Tap[]; wsum: number } {
  const taps: Tap[] = [];
  let wsum = 0;
  for (let j = -7; j <= 7; j++)
    for (let i = -7; i <= 7; i++) {
      const w = Math.exp(-((i * i + j * j) * 16) / (2 * 14 * 14));
      taps.push({ dx: Math.trunc(i * 4 * s), dy: Math.trunc(j * 4 * s), w });
      wsum += w;
    }
  return { taps, wsum };
}

/**
 * The bloom field at strength 1 (linear RGB 0..1 per pixel, Float32 x3): the weighted highlight colour
 * gathered from the disc. Computed by SCATTERING from highlight pixels, which is exactly the gather
 * (sum over taps of bright(p + o) * w(o) * c(p + o), outside = black) but costs only highlights x taps.
 */
export function bloomField(rgb: Uint8Array, w: number, h: number, p: Omit<BloomParams, "strength">, kernel = denseTaps(p, h / 1920)): Float32Array {
  const F = new Float32Array(w * h * 3);
  const inv = 1 / kernel.wsum;
  for (let qy = 0; qy < h; qy++)
    for (let qx = 0; qx < w; qx++) {
      const q = qy * w + qx;
      const r = rgb[q * 3]! / 255;
      const g = rgb[q * 3 + 1]! / 255;
      const b = rgb[q * 3 + 2]! / 255;
      const k = brightness(r, g, b, p);
      if (k <= 0) continue;
      const kr = k * r * inv;
      const kg = k * g * inv;
      const kb = k * b * inv;
      for (const t of kernel.taps) {
        // output pixel p with p + o = q
        const px = qx - t.dx;
        const py = qy - t.dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = (py * w + px) * 3;
        F[i] = F[i]! + kr * t.w;
        F[i + 1] = F[i + 1]! + kg * t.w;
        F[i + 2] = F[i + 2]! + kb * t.w;
      }
    }
  return F;
}

/** the common compression factor k(t) = (1 - exp(-t)) / t, with its series near 0 (exactly the DCTL's) */
export function ceilingFactor(t: number): number {
  if (t <= 0) return 1;
  if (t >= 1e8) return 0;
  return t < 1e-3 ? 1 - t / 2 + (t * t) / 6 : (1 - Math.exp(-t)) / t;
}
/** one pixel (0..1 RGB) plus the gathered bloom (0..1 per channel): the hue-preserving ceiling (exactly the DCTL's `liftRGB`) */
export function liftRGB(r: number, g: number, b: number, ar: number, ag: number, ab: number): [number, number, number] {
  const inc = [(1 - r) * ar, (1 - g) * ag, (1 - b) * ab];
  const src = [r, g, b];
  let t = 0;
  // any channel at or above the ceiling blocks the pixel (even a channel at exactly 1.0, whose own increment is 0)
  for (let c = 0; c < 3; c++) t = Math.max(t, src[c]! >= CEILING ? 1e9 : inc[c]! > 0 ? inc[c]! / (CEILING - src[c]!) : 0);
  const k = ceilingFactor(t);
  return [r + k * inc[0]!, g + k * inc[1]!, b + k * inc[2]!];
}

/** apply a field at `strength` to the frame (8-bit in, 8-bit out, rounded) */
export function applyBloom(rgb: Uint8Array, F: Float32Array, strength: number): Uint8Array {
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const o = liftRGB(rgb[i]! / 255, rgb[i + 1]! / 255, rgb[i + 2]! / 255, Math.min(1, strength * F[i]!), Math.min(1, strength * F[i + 1]!), Math.min(1, strength * F[i + 2]!));
    out[i] = Math.round(255 * o[0]);
    out[i + 1] = Math.round(255 * o[1]);
    out[i + 2] = Math.round(255 * o[2]);
  }
  return out;
}

export const bloom = (rgb: Uint8Array, w: number, h: number, p: BloomParams) => applyBloom(rgb, bloomField(rgb, w, h, p), p.strength);

const f = (x: number, d = 6) => `${x.toFixed(d)}f`;

/** The production DCTL, generated from the parameters (deterministic text). */
export function bloomDctl(name: string, p: BloomParams): string {
  validateBloomParams(p);
  const { wsum } = denseTaps(p, 1);
  return `// @mcp-dctl name=${name} kind=transform
// Bali Phase 11.75 — highlight-selective bloom (GENERATED by src/grade/bloom.ts bloomDctl; do not edit).
// Dense disc sampling (every pixel within RADIUS): no sampling lattice, so no grid ghosting.
// Spatial only (no frame memory). Screen blend under a hue-preserving highlight ceiling: never creates clipping,
// keeps the colour of lights and of the added glow, never darkens.
#define CEILING ${f(CEILING)}
#define THRESH ${f(p.threshold)}
#define KNEE ${f(p.knee)}
#define STRENGTH ${f(p.strength)}
#define SIGMA_CORE ${f(p.sigmaCore)}
#define SIGMA_HALO ${f(p.sigmaHalo)}
#define HALO_SHARE ${f(p.haloShare)}
#define RADIUS ${f(p.radius)}
#define WSUM_1920 ${f(wsum, 9)}

__DEVICE__ float smoothstep01(float t)
{
    t = _clampf(t, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

__DEVICE__ float ratio(float src, float inc)
{
    if (src >= CEILING) return 1e9f;
    return inc > 0.0f ? inc / (CEILING - src) : 0.0f;
}

__DEVICE__ float3 liftRGB(float r, float g, float b, float ar, float ag, float ab)
{
    float ir = (1.0f - r) * ar;
    float ig = (1.0f - g) * ag;
    float ib = (1.0f - b) * ab;
    float t = _fmaxf(ratio(r, ir), _fmaxf(ratio(g, ig), ratio(b, ib)));
    float k = 1.0f;
    if (t >= 1e8f) k = 0.0f;
    else if (t >= 1e-3f) k = (1.0f - _expf(-t)) / t;
    else if (t > 0.0f) k = 1.0f - t / 2.0f + t * t / 6.0f;
    return make_float3(r + k * ir, g + k * ig, b + k * ib);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB)
{
    float r0 = _tex2D(p_TexR, p_X, p_Y);
    float g0 = _tex2D(p_TexG, p_X, p_Y);
    float b0 = _tex2D(p_TexB, p_X, p_Y);
    float s = (float)p_Height / 1920.0f;
    int R = (int)(RADIUS * s + 0.5f);
    float nc = (1.0f - HALO_SHARE) / (SIGMA_CORE * SIGMA_CORE);
    float nh = HALO_SHARE / (SIGMA_HALO * SIGMA_HALO);
    float ic = 1.0f / (2.0f * SIGMA_CORE * SIGMA_CORE);
    float ih = 1.0f / (2.0f * SIGMA_HALO * SIGMA_HALO);
    float ar = 0.0f;
    float ag = 0.0f;
    float ab = 0.0f;
    for (int dy = -R; dy <= R; dy++)
    {
        int y = p_Y + dy;
        if (y < 0 || y >= p_Height) continue;
        for (int dx = -R; dx <= R; dx++)
        {
            int x = p_X + dx;
            if (x < 0 || x >= p_Width) continue;
            float d2 = (float)(dx * dx + dy * dy) / (s * s);
            if (d2 > RADIUS * RADIUS) continue;
            float r = _tex2D(p_TexR, x, y);
            float g = _tex2D(p_TexG, x, y);
            float b = _tex2D(p_TexB, x, y);
            float k = smoothstep01((0.2126f * r + 0.7152f * g + 0.0722f * b - THRESH) / KNEE);
            if (k <= 0.0f) continue;
            float d = _sqrtf(d2);
            float w = (nc * _expf(-d2 * ic) + nh * _expf(-d2 * ih)) * (1.0f - smoothstep01((d - 0.75f * RADIUS) / (0.25f * RADIUS)));
            ar += k * w * r;
            ag += k * w * g;
            ab += k * w * b;
        }
    }
    float inv = STRENGTH / (WSUM_1920 * s * s);
    ar = _fminf(1.0f, ar * inv);
    ag = _fminf(1.0f, ag * inv);
    ab = _fminf(1.0f, ab * inv);
    // Resolve's DCTL validator needs an explicit make_float3 in the main function's return
    float3 o = liftRGB(r0, g0, b0, ar, ag, ab);
    return make_float3(o.x, o.y, o.z);
}
`;
}

/** Chessboard distance (px, capped) from every pixel to the nearest highlight (luma > threshold). */
export function sourceDistance(rgb: Uint8Array, w: number, h: number, threshold: number, cap = 255): Uint8Array {
  const d = new Uint8Array(w * h).fill(cap);
  for (let i = 0; i < w * h; i++) if ((0.2126 * rgb[i * 3]! + 0.7152 * rgb[i * 3 + 1]! + 0.0722 * rgb[i * 3 + 2]!) / 255 > threshold) d[i] = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i]!;
      if (x) v = Math.min(v, d[i - 1]! + 1);
      if (y) v = Math.min(v, d[i - w]! + 1, x ? d[i - w - 1]! + 1 : cap, x < w - 1 ? d[i - w + 1]! + 1 : cap);
      d[i] = Math.min(cap, v);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i]!;
      if (x < w - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < h - 1) v = Math.min(v, d[i + w]! + 1, x < w - 1 ? d[i + w + 1]! + 1 : cap, x ? d[i + w - 1]! + 1 : cap);
      d[i] = Math.min(cap, v);
    }
  return d;
}

/**
 * Periodic-structure (ghosting) index of a scalar field over the pixels where it is at least `floor`:
 * the mean absolute 2-px second difference in x and y, relative to the mean field. A smooth glow scores
 * near 0; copies at a 4 px lattice score high (peaks at 0, 4, 8 and valleys at 2, 6).
 */
export function ghostIndex(field: Float32Array | Float64Array, w: number, h: number, floor: number): number {
  let num = 0;
  let den = 0;
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const v = field[i]!;
      if (v < floor) continue;
      num += Math.abs(v - (field[i - 2]! + field[i + 2]!) / 2) + Math.abs(v - (field[i - 2 * w]! + field[i + 2 * w]!) / 2);
      den += v;
    }
  return den ? num / den : 0;
}

export interface BloomMeasures {
  /** max |delta| over frames 0-299 (must be exactly 0) */
  prePayoffMaxAbs: number;
  farMeanAbsDelta: number;
  faceMeanDelta: number | null;
  clipIncreasePts: number;
  darkMeanDelta: number;
  gradientRatioFar: number;
  chromaShiftFar: number;
  twinMinPsnr: number;
  /** ghost index of the float bloom field (twin) on the real rail frame; sparse probe kernel 0.49 */
  fieldGhostIndex: number;
  /** 2 px / 4 px difference ratio of the 8-bit render delta; sparse probe renders 0.98, smooth -> 0.5 */
  renderLatticeRatio: number;
  /** relative saturation change of coloured light-source pixels (sat >= 0.15) */
  lightSaturationChange: number;
  /** mean |hue shift| (degrees) of coloured pixels at and near the lights */
  lightHueShiftDeg: number;
}
export const BLOOM_GATES = { farMeanAbsDelta: 0.05, faceMeanDelta: 1, clipIncreasePts: 0.2, darkMeanDelta: 0.1, gradientRatioFar: [0.998, 1.002] as [number, number], chromaShiftFar: 0.05, twinMinPsnr: 50, fieldGhostIndex: 0.12, renderLatticeRatio: 0.8, lightSaturationChange: -0.05, lightHueShiftDeg: 2 };

/** The Phase 11.75 bloom safety gates (pure). */
export function evaluateBloomGates(m: BloomMeasures): { ok: boolean; failures: string[] } {
  const g = BLOOM_GATES;
  const failures: string[] = [];
  if (m.prePayoffMaxAbs !== 0) failures.push(`frames 0-299 changed (max |delta| ${m.prePayoffMaxAbs})`);
  if (m.farMeanAbsDelta > g.farMeanAbsDelta) failures.push(`change away from highlights ${m.farMeanAbsDelta} > ${g.farMeanAbsDelta}`);
  if (m.faceMeanDelta !== null && m.faceMeanDelta > g.faceMeanDelta) failures.push(`face mean change ${m.faceMeanDelta} > ${g.faceMeanDelta} level`);
  if (m.clipIncreasePts > g.clipIncreasePts) failures.push(`clipping +${m.clipIncreasePts} pt > +${g.clipIncreasePts}`);
  if (m.darkMeanDelta > g.darkMeanDelta) failures.push(`black lift ${m.darkMeanDelta} > ${g.darkMeanDelta}`);
  if (m.gradientRatioFar < g.gradientRatioFar[0] || m.gradientRatioFar > g.gradientRatioFar[1]) failures.push(`sharpness away from highlights changed (ratio ${m.gradientRatioFar})`);
  if (m.chromaShiftFar > g.chromaShiftFar) failures.push(`colour shift away from highlights ${m.chromaShiftFar}`);
  if (m.twinMinPsnr < g.twinMinPsnr) failures.push(`Resolve render not predicted (twin ${m.twinMinPsnr} dB < ${g.twinMinPsnr})`);
  if (m.fieldGhostIndex > g.fieldGhostIndex) failures.push(`periodic structure in the bloom field (ghost index ${m.fieldGhostIndex} > ${g.fieldGhostIndex})`);
  if (m.lightSaturationChange < g.lightSaturationChange) failures.push(`coloured lights lose saturation (${(m.lightSaturationChange * 100).toFixed(1)} % < ${g.lightSaturationChange * 100} %)`);
  if (m.lightHueShiftDeg > g.lightHueShiftDeg) failures.push(`hue shift at the lights ${m.lightHueShiftDeg} deg > ${g.lightHueShiftDeg}`);
  if (m.renderLatticeRatio > g.renderLatticeRatio) failures.push(`lattice structure in the render (2/4 px ratio ${m.renderLatticeRatio} > ${g.renderLatticeRatio})`);
  return { ok: failures.length === 0, failures };
}

/** 2 px / 4 px difference ratio over pixels where the delta is >= floor (both axes): a 4 px comb ~1+, noise ~1, a smooth falloff ~0.5 */
export function latticeRatio(delta: Float32Array, w: number, h: number, floor = 1): number {
  let a = 0;
  let b = 0;
  for (let y = 0; y < h - 4; y++)
    for (let x = 0; x < w - 4; x++) {
      const i = y * w + x;
      const v = delta[i]!;
      if (v < floor) continue;
      a += Math.abs(v - delta[i + 2 * w]!) + Math.abs(v - delta[i + 2]!);
      b += Math.abs(v - delta[i + 4 * w]!) + Math.abs(v - delta[i + 4]!);
    }
  return b ? a / b : a ? Number.POSITIVE_INFINITY : 0;
}

