// 원본 시트 → 카드 몸통(오른쪽·아래)을 고정한 16컷
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC = process.argv[2] || 'image/ChatGPT Image 2026년 9월 13일 오후 09_54_00.png';
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

function isFire(r, g, b, a) {
  return a > 40 && r > 145 && r > b + 40 && r >= g - 10;
}
function isBg(r, g, b, a) {
  if (a < 12) return true;
  const L = (r + g + b) / 3;
  return L < 14;
}
function isCard(r, g, b, a) {
  if (a < 90 || isFire(r, g, b, a) || isBg(r, g, b, a)) return false;
  const L = (r + g + b) / 3;
  const C = Math.max(r, g, b) - Math.min(r, g, b);
  if (L < 62 && C < 55) return true;
  if (r > 85 && g > 50 && b < g * 0.95 && L < 150 && C > 18) return true;
  return false;
}

function longestRun(rowHas, w) {
  let best = 0, bs = 0, s = -1;
  for (let x = 0; x <= w; x++) {
    if (x < w && rowHas(x)) {
      if (s < 0) s = x;
    } else if (s >= 0) {
      if (x - s > best) { best = x - s; bs = s; }
      s = -1;
    }
  }
  return { len: best, x0: bs, x1: bs + best - 1 };
}

function cardBody(data, w, h) {
  const runs = [];
  for (let y = 0; y < h; y++) {
    const r = longestRun(x => {
      const i = (y * w + x) * 4;
      return isCard(data[i], data[i + 1], data[i + 2], data[i + 3]);
    }, w);
    runs.push(r);
  }
  const lens = runs.map(r => r.len).filter(n => n > 40).sort((a, b) => a - b);
  const mid = lens.length ? lens[(lens.length * 0.55) | 0] : 80;
  const minRun = Math.max(70, mid * 0.72);
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h; y++) if (runs[y].len >= minRun) { if (y0 < 0) y0 = y; y1 = y; }
  if (y0 < 0) return null;
  let x0 = w, x1 = 0;
  for (let y = y0; y <= y1; y++) {
    if (runs[y].len < minRun * 0.55) continue;
    if (runs[y].x0 < x0) x0 = runs[y].x0;
    if (runs[y].x1 > x1) x1 = runs[y].x1;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, x1, y1 };
}

function opaqueBox(data, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 16) continue;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return n ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

function keyBg(data, w, h) {
  for (let i = 0; i < data.length; i += 4) {
    if (isBg(data[i], data[i + 1], data[i + 2], data[i + 3])) data[i + 3] = 0;
  }
}

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

const img = decodePng(fs.readFileSync(SRC));
const { w: W, h: H, data } = img;
const solid = (x, y) => {
  const i = (y * W + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
  if (a < 40) return false;
  return !isBg(r, g, b, a);
};
const bands = runs(y => { for (let x = 0; x < W; x++) if (solid(x, y)) return true; return false; }, H, 40, 24);
const boxes = [];
bands.forEach(([y0, y1], bi) => {
  const prev = bands[bi - 1], next = bands[bi + 1];
  const clipY0 = prev ? ((prev[1] + y0) >> 1) : 0;
  const clipY1 = next ? ((y1 + next[0]) >> 1) : H - 1;
  const cols = runs(x => { for (let y = y0; y <= y1; y++) if (solid(x, y)) return true; return false; }, W, 30, 24);
  cols.forEach(([x0, x1]) => boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, clipY0, clipY1 }));
});
console.log('sheet', W + 'x' + H, 'boxes', boxes.length, boxes.map((c, i) => i + ':' + c.w + 'x' + c.h + '@' + c.x + ',' + c.y).join(' | '));
if (boxes.length !== 8) throw new Error('expected 8 burn frames, got ' + boxes.length);

const raw = boxes.map((box, idx) => {
  const padX = 70, padY = 140;
  const x0 = Math.max(0, box.x - padX);
  const y0 = Math.max(box.clipY0, box.y - padY);
  const x1 = Math.min(W - 1, box.x + box.w - 1 + padX);
  const y1 = Math.min(box.clipY1, box.y + box.h - 1 + 40);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * w + x) * 4;
      buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2]; buf[di + 3] = data[si + 3];
    }
  }
  keyBg(buf, w, h);
  const body = cardBody(buf, w, h);
  if (!body) throw new Error('no card body in frame ' + idx);
  console.log('src', idx, 'body', body.x + ',' + body.y, body.w + 'x' + body.h, 'BR', body.x1 + ',' + body.y1);
  return { w, h, buf, body, opaque: opaqueBox(buf, w, h) };
});

const t = raw[0].body;
raw.forEach(f => {
  f.dx = t.x1 - f.body.x1;
  f.dy = t.y1 - f.body.y1;
});
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
raw.forEach(f => {
  minX = Math.min(minX, f.opaque.x0 + f.dx);
  minY = Math.min(minY, f.opaque.y0 + f.dy);
  maxX = Math.max(maxX, f.opaque.x1 + f.dx);
  maxY = Math.max(maxY, f.opaque.y1 + f.dy);
});
const pad = 12;
const originX = minX - pad, originY = minY - pad;
const outW = maxX - minX + 1 + pad * 2;
const outH = maxY - minY + 1 + pad * 2;
const body = {
  x: t.x + raw[0].dx - originX,
  y: t.y + raw[0].dy - originY,
  w: t.w,
  h: t.h,
};
console.log('canvas', outW + 'x' + outH, 'body', body);

const eight = raw.map((f, i) => {
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const si = (y * f.w + x) * 4;
      if (f.buf[si + 3] < 8) continue;
      const xx = x + f.dx - originX, yy = y + f.dy - originY;
      if (xx < 0 || yy < 0 || xx >= outW || yy >= outH) continue;
      const di = (yy * outW + xx) * 4;
      out[di] = f.buf[si]; out[di + 1] = f.buf[si + 1];
      out[di + 2] = f.buf[si + 2]; out[di + 3] = f.buf[si + 3];
    }
  }
  console.log('aligned', i, 'shift', f.dx, f.dy);
  return out;
});

fs.mkdirSync(OUT, { recursive: true });
const N = 16;
for (let i = 0; i < N; i++) {
  const p = (i / (N - 1)) * (eight.length - 1);
  const i0 = Math.floor(p), i1 = Math.min(eight.length - 1, i0 + 1);
  const tmix = p - i0;
  const dataOut = tmix < 0.001 ? eight[i0] : (tmix > 0.999 ? eight[i1] : mix(eight[i0], eight[i1], tmix));
  fs.writeFileSync(path.join(OUT, 'burn' + i + '.png'), encodePng(outW, outH, dataOut));
  console.log('wrote burn' + i);
}
fs.writeFileSync(path.join(OUT, 'burn-meta.json'), JSON.stringify({ w: outW, h: outH, body }, null, 2));
console.log('meta', { w: outW, h: outH, body });
