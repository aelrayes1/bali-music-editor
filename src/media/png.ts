/**
 * Minimal lossless PNG codec (node:zlib only) for 8-bit, non-interlaced gray / RGB / RGBA images:
 * enough for masks written by the local Vision tools and for mask/QC visualisations, without
 * spawning FFmpeg per file. Encoding is deterministic (filter 0 on every row, fixed zlib level).
 */

import { deflateSync, inflateSync } from "node:zlib";

export interface Image8 {
  w: number;
  h: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function decodePng(buf: Uint8Array): Image8 {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let pos = 8;
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const kind = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  const channels = type === 0 ? 1 : type === 2 ? 3 : type === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels]! : 0;
      const up = y > 0 ? out[dst - stride + x]! : 0;
      const c = y > 0 && x >= channels ? out[dst - stride + x - channels]! : 0;
      const v = raw[src + x]!;
      let p: number;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + up;
      else if (f === 3) p = v + ((a + up) >> 1);
      else if (f === 4) {
        const q = a + up - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      } else throw new Error(`bad PNG filter ${f}`);
      out[dst + x] = p & 0xff;
    }
  }
  return { w, h, channels: channels as 1 | 3 | 4, data: out };
}

export function encodePng(img: Image8): Buffer {
  const { w, h, channels, data } = img;
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
