/**
 * Phase 12: orientation. Distinguishes display-matrix rotation (metadata), physically rotated pixels,
 * already-upright media and the double-rotation trap, and catches sideways / inverted / swapped output.
 * Content checks compare decoded pictures, not just metadata.
 */

import { type Issue } from "./errors.ts";

export type Quarter = 0 | 90 | 180 | 270;

/** Display size after a clockwise display rotation (what a player shows). */
export const displaySize = (storedW: number, storedH: number, rotationCw: number) => (((rotationCw % 180) + 180) % 180 === 90 ? { w: storedH, h: storedW } : { w: storedW, h: storedH });

/** Delivery checks on probe facts: exact size, no rotation metadata, no swapped width / height. */
export function checkDeliveryOrientation(p: { width: number; height: number; rotation: number }, want: { width: number; height: number }, file?: string): Issue[] {
  const issues: Issue[] = [];
  if (p.rotation % 360 !== 0) issues.push({ code: "ORIENTATION_ROTATION_METADATA", severity: "BLOCKING", what: `delivery carries display rotation ${p.rotation}°`, file, expected: 0, actual: p.rotation, next: "render upright pixels and write no rotation metadata (players and platforms disagree on it)" });
  if (p.width === want.height && p.height === want.width && want.width !== want.height) issues.push({ code: "ORIENTATION_SWAPPED", severity: "BLOCKING", what: "width and height are swapped (landscape instead of portrait, or vice versa)", file, expected: `${want.width}x${want.height}`, actual: `${p.width}x${p.height}`, next: "check the source rotation and the reframe; the delivery must be stored upright" });
  else if (p.width !== want.width || p.height !== want.height) issues.push({ code: "DELIVERY_RESOLUTION", severity: "BLOCKING", what: "wrong resolution", file, expected: `${want.width}x${want.height}`, actual: `${p.width}x${p.height}`, next: "render at the delivery resolution" });
  return issues;
}

/** Downscale a luma plane (any size) to s x s by area averaging. */
function grid(l: Float32Array, w: number, h: number, s = 24): Float32Array {
  const o = new Float32Array(s * s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      let t = 0, n = 0;
      for (let yy = Math.floor((y * h) / s); yy < Math.floor(((y + 1) * h) / s); yy++)
        for (let xx = Math.floor((x * w) / s); xx < Math.floor(((x + 1) * w) / s); xx++) {
          t += l[yy * w + xx]!;
          n++;
        }
      o[y * s + x] = n ? t / n : 0;
    }
  return o;
}
function rotateGrid(g: Float32Array, s: number, q: Quarter): Float32Array {
  if (q === 0) return g;
  const o = new Float32Array(s * s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const [sx, sy] = q === 90 ? [y, s - 1 - x] : q === 180 ? [s - 1 - x, s - 1 - y] : [s - 1 - y, x];
      o[y * s + x] = g[sy * s + sx]!;
    }
  return o;
}
const corr = (a: Float32Array, b: Float32Array) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return sab / Math.sqrt(Math.max(1e-12, saa * sbb));
};

/**
 * Which clockwise rotation of the reference picture best explains the output picture (both luma, any
 * sizes)? 0 = upright; 90 / 270 = sideways; 180 = inverted. Aspect differences are normalised away by
 * comparing square grids, so a sideways frame squeezed into the right size is still caught.
 */
export function contentRotation(ref: { luma: Float32Array; w: number; h: number }, out: { luma: Float32Array; w: number; h: number }): { rotation: Quarter; scores: Record<Quarter, number>; margin: number } {
  const s = 24;
  const gr = grid(ref.luma, ref.w, ref.h, s);
  const go = grid(out.luma, out.w, out.h, s);
  const scores = {} as Record<Quarter, number>;
  for (const q of [0, 90, 180, 270] as Quarter[]) scores[q] = Math.round(corr(rotateGrid(gr, s, q), go) * 1000) / 1000;
  const sorted = (Object.entries(scores) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);
  return { rotation: Number(sorted[0]![0]) as Quarter, scores, margin: Math.round((sorted[0]![1] - sorted[1]![1]) * 1000) / 1000 };
}

export function checkContentOrientation(ref: { luma: Float32Array; w: number; h: number }, out: { luma: Float32Array; w: number; h: number }, file?: string): Issue[] {
  const r = contentRotation(ref, out);
  if (r.rotation === 0) return [];
  return [{ code: r.rotation === 180 ? "ORIENTATION_INVERTED" : "ORIENTATION_SIDEWAYS", severity: "BLOCKING", what: `the picture is rotated ${r.rotation}° clockwise relative to the approved reference (scores ${JSON.stringify(r.scores)})`, file, expected: 0, actual: r.rotation, next: "check for a double rotation (rotation metadata applied on top of already-rotated pixels) or a missing one" }];
}

/**
 * Source-side policy. A display rotation on a stream whose STORED pixels are already portrait is the
 * classic double-rotation trap (a phone file re-encoded upright but still tagged); it is not guessed away.
 */
export function sourceOrientationWarnings(stored: { w: number; h: number }, rotationCw: number, expectedDisplay?: "portrait" | "landscape", file?: string): Issue[] {
  const d = displaySize(stored.w, stored.h, rotationCw);
  const shown = d.h > d.w ? "portrait" : d.w > d.h ? "landscape" : "square";
  const issues: Issue[] = [];
  if (rotationCw % 180 !== 0 && stored.h > stored.w) issues.push({ code: "ORIENTATION_DOUBLE_ROTATION_RISK", severity: "WARNING", what: `rotation metadata ${rotationCw}° on pixels already stored portrait (${stored.w}x${stored.h}): applying it shows ${shown}`, file, next: "confirm the intended orientation on a decoded frame before planning; record a human orientation decision" });
  if (expectedDisplay && shown !== expectedDisplay) issues.push({ code: "ORIENTATION_UNEXPECTED", severity: "ERROR", what: `displays ${shown}, expected ${expectedDisplay}`, file, expected: expectedDisplay, actual: shown, next: "check the rotation metadata and the stored pixels" });
  return issues;
}
