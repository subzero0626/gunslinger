// burn0~7 → 같은 자리에 맞춘 16컷
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const DIR = process.argv[2] || 'assets/tarot';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const chan = { 2: 3, 6: 4 }[color];
  if (!chan || depth !== 8) throw new Error('unsupported png');
  const stride = w * chan;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= chan ? line[i - chan] : 0;
      const b = prev[i];
      const c = i >= chan ? prev[i - chan] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x++) {
      const s = x * chan, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = chan === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  const out = Buffer.alloc(a.length);
  const u = 1 - t;
  for (let i = 0; i < a.length; i += 4) {
    const a0 = a[i + 3] / 255, a1 = b[i + 3] / 255;
    const fire = (a[i] > a[i + 2] + 35 && a[i] > 120) || (b[i] > b[i + 2] + 35 && b[i] > 120);
    let aa = a0 * u + a1 * t;
    if (fire) aa = Math.max(aa, Math.max(a0, a1) * (0.55 + 0.45 * Math.max(t, u)));
    if (aa < 0.02) continue;
    const w0 = a0 * u, w1 = a1 * t, s = w0 + w1 || 1;
    out[i] = Math.round((a[i] * w0 + b[i] * w1) / s);
    out[i + 1] = Math.round((a[i + 1] * w0 + b[i + 1] * w1) / s);
    out[i + 2] = Math.round((a[i + 2] * w0 + b[i + 2] * w1) / s);
    out[i + 3] = Math.round(Math.min(1, aa) * 255);
  }
  return out;
}

const src = [];
for (let i = 0; i < 8; i++) {
  const f = decodePng(fs.readFileSync(path.join(DIR, 'burn' + i + '.png')));
  src.push(f);
  if (f.w !== src[0].w || f.h !== src[0].h) throw new Error('size mismatch ' + i);
}
const { w, h } = src[0];
const N = 16;
for (let i = 0; i < N; i++) {
  const p = (i / (N - 1)) * (src.length - 1);
  const i0 = Math.floor(p), i1 = Math.min(src.length - 1, i0 + 1);
  const t = p - i0;
  const data = t < 0.001 ? src[i0].data : (t > 0.999 ? src[i1].data : mix(src[i0].data, src[i1].data, t));
  fs.writeFileSync(path.join(DIR, 'burn' + i + '.png'), encodePng(w, h, data));
  console.log('wrote burn' + i, 'from', i0 + '+' + i1, 't=' + t.toFixed(2));
}
console.log('done', N, w + 'x' + h);
