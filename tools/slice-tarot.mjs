// 14장 타로 시트 → assets/tarot/*.png
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'assets/tarot';

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

const NAMES = process.env.TOWN_BURN
  ? ['burn0', 'burn1', 'burn2', 'burn3', 'burn4', 'burn5', 'burn6', 'burn7']
  : [
    'iron', 'hat', 'sniper', 'lastshot', 'chalice', 'shortcyl', 'hasty',
    'shackle', 'clumsy', 'wings', 'glass', 'misfire', 'bell', 'laurel',
  ];

const img = decodePng(fs.readFileSync(SRC));
const { w: W, h: H, data } = img;
const dark = (x, y) => {
  const i = (y * W + x) * 4;
  return data[i + 3] > 8 && (data[i] + data[i + 1] + data[i + 2]) < 700;
};

function runs(has, len, minLen, gap) {
  const out = [];
  let s = -1, blank = 0;
  for (let i = 0; i < len; i++) {
    if (has(i)) {
      if (s < 0) s = i;
      blank = 0;
    } else if (s >= 0) {
      blank++;
      if (blank > gap) {
        if (i - blank - s >= minLen) out.push([s, i - blank - 1]);
        s = -1; blank = 0;
      }
    }
  }
  if (s >= 0 && len - s >= minLen) out.push([s, len - 1]);
  return out;
}

const bands = runs(y => { for (let x = 0; x < W; x++) if (dark(x, y)) return true; return false; }, H, 40, 8);
const cards = [];
bands.forEach(([y0, y1]) => {
  const cols = runs(x => { for (let y = y0; y <= y1; y++) if (dark(x, y)) return true; return false; }, W, 30, 8);
  cols.forEach(([x0, x1]) => cards.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }));
});

console.log('cards', cards.length, cards.map((c, i) => `#${i} ${c.w}x${c.h} @${c.x},${c.y}`).join(' | '));
const expect = NAMES.length;
if (cards.length !== expect) throw new Error('expected ' + expect + ' cards, got ' + cards.length);

fs.mkdirSync(OUT, { recursive: true });
cards.forEach((c, i) => {
  const pad = 1;
  const x0 = Math.max(0, c.x - pad), y0 = Math.max(0, c.y - pad);
  const x1 = Math.min(W - 1, c.x + c.w - 1 + pad), y1 = Math.min(H - 1, c.y + c.h - 1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * w + x) * 4;
      buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2];
      const lum = data[si] + data[si + 1] + data[si + 2];
      buf[di + 3] = process.env.TOWN_BURN && lum > 720 ? 0 : 255;
    }
  }
  const name = NAMES[i];
  fs.writeFileSync(path.join(OUT, name + '.png'), encodePng(w, h, buf));
  console.log('wrote', name, w + 'x' + h);
});
