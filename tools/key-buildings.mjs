// 생성한 건물 PNG에서 흰 배경을 따고, 아래 기초가 잘리지 않게 잘라 town/ 에 넣는다
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC_DIR = process.argv[2];
const OUT_DIR = process.argv[3];
const NAMES = ['shop', 'inn', 'smithy', 'church', 'warehouse', 'saloon', 'house'];

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  let plte = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
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
      if (color === 6) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
      else if (color === 2) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else if (color === 0) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
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

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function keyAndCrop(im) {
  const { w, h, data } = im;
  const outside = new Uint8Array(w * h);
  const stack = [];
  const nearWhite = i => data[i + 3] < 8 || (lum(data[i], data[i + 1], data[i + 2]) > 232 && data[i] > 220 && data[i + 1] > 220);
  for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const k = stack.pop();
    if (outside[k] || !nearWhite(k * 4)) continue;
    outside[k] = 1;
    const x = k % w, y = (k - x) / w;
    if (x > 0) stack.push(k - 1);
    if (x < w - 1) stack.push(k + 1);
    if (y > 0) stack.push(k - w);
    if (y < h - 1) stack.push(k + w);
  }
  for (let k = 0; k < w * h; k++) {
    if (!outside[k]) continue;
    const i = k * 4;
    const a = Math.max(0, Math.min(1, (240 - lum(data[i], data[i + 1], data[i + 2])) / 28));
    data[i + 3] = Math.round(a * 255);
  }
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 16) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  // 아래 기초가 잘리지 않게 2px만 여백
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2);
  x1 = Math.min(w - 1, x1 + 2); y1 = Math.min(h - 1, y1 + 2);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const buf = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * w + (x0 + x)) * 4, di = (y * cw + x) * 4;
      buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2]; buf[di + 3] = data[si + 3];
    }
  }
  return { w: cw, h: ch, buf };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const meta = {};
for (const name of NAMES) {
  const src = path.join(SRC_DIR, name + '.png');
  if (!fs.existsSync(src)) { console.log('missing', src); continue; }
  const keyed = keyAndCrop(decodePng(fs.readFileSync(src)));
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), encodePng(keyed.w, keyed.h, keyed.buf));
  meta[name] = { w: keyed.w, h: keyed.h };
  console.log('wrote', name, keyed.w + 'x' + keyed.h);
}
fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
