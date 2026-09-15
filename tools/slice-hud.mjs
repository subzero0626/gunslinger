// 총알·마름모 시트 → assets/ui/*.png
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC = process.argv[2] || 'image/ChatGPT Image 2026년 9월 14일 오후 09_08_02.png';
const OUT = process.argv[3] || 'assets/ui';
const NAMES = ['bullet0', 'bullet1', 'bullet2', 'bullet3', 'bullet4', 'gem-blue', 'gem-red'];

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

const img = decodePng(fs.readFileSync(SRC));
const { w: W, h: H, data } = img;
console.log('sheet', W + 'x' + H);

function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function chroma(r, g, b) { return Math.max(r, g, b) - Math.min(r, g, b); }

function isSprite(r, g, b, a) {
  if (a < 8) return false;
  const L = luma(r, g, b);
  const C = chroma(r, g, b);
  if (L < 14) return false;
  if (C < 16 && L > 70) return false;
  if (C < 12) return false;
  if (r > 70 && g > 45 && b < g * 0.92 && L < 210) return true;
  return C >= 22;
}

const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (isSprite(data[i], data[i + 1], data[i + 2], data[i + 3])) mask[y * W + x] = 1;
  }
}

const DILATE = 10;
const dil = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (let dy = -DILATE; dy <= DILATE; dy++) {
      for (let dx = -DILATE; dx <= DILATE; dx++) {
        if (dx * dx + dy * dy > DILATE * DILATE) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        dil[yy * W + xx] = 1;
      }
    }
  }
}

const seen = new Uint8Array(W * H);
const blobs = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = y * W + x;
    if (!dil[s] || seen[s]) continue;
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const p = q.pop();
      const px = p % W, py = (p - px) / W;
      n++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let k = 0; k < 4; k++) {
        const nx = px + [1, -1, 0, 0][k];
        const ny = py + [0, 0, 1, -1][k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!dil[ni] || seen[ni]) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    if (n > 400) blobs.push({ x0, y0, x1, y1, n });
  }
}

blobs.sort((a, b) => a.x0 - b.x0);
console.log('raw', blobs.length, blobs.map((b, i) =>
  `#${i} ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1} @${b.x0},${b.y0} n=${b.n}`
).join(' | '));

function boxDist(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}
const large = blobs.filter(b => b.n >= 8000);
const small = blobs.filter(b => b.n < 8000);
small.forEach(s => {
  let best = null, bestD = 90;
  large.forEach(L => {
    const d = boxDist(s, L);
    if (d < bestD) { bestD = d; best = L; }
  });
  if (!best) return;
  best.x0 = Math.min(best.x0, s.x0);
  best.y0 = Math.min(best.y0, s.y0);
  best.x1 = Math.max(best.x1, s.x1);
  best.y1 = Math.max(best.y1, s.y1);
  best.n += s.n;
});
large.sort((a, b) => a.x0 - b.x0);
console.log('merged', large.length, large.map((b, i) =>
  `#${i} ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1} @${b.x0},${b.y0} n=${b.n}`
).join(' | '));
if (large.length !== NAMES.length) {
  throw new Error('expected ' + NAMES.length + ' sprites, got ' + large.length);
}

fs.mkdirSync(OUT, { recursive: true });
large.forEach((b, i) => {
  const pad = 2;
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
  const x1 = Math.min(W - 1, b.x1 + pad), y1 = Math.min(H - 1, b.y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  const fg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      if (isSprite(data[si], data[si + 1], data[si + 2], data[si + 3])) fg[y * w + x] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      const r = data[si], g = data[si + 1], bl = data[si + 2];
      let a = 0;
      if (fg[y * w + x]) a = 255;
      else {
        let near = false;
        for (let k = 0; k < 8; k++) {
          const nx = x + [-1, 0, 1, -1, 1, -1, 0, 1][k];
          const ny = y + [-1, -1, -1, 0, 0, 1, 1, 1][k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (fg[ny * w + nx]) { near = true; break; }
        }
        if (near) {
          const C = chroma(r, g, bl);
          a = Math.round(Math.min(1, Math.max(0, (C - 10) / 28)) * 180);
        }
      }
      buf[di] = r; buf[di + 1] = g; buf[di + 2] = bl; buf[di + 3] = a;
    }
  }
  let tx0 = w, ty0 = h, tx1 = 0, ty1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] < 12) continue;
      if (x < tx0) tx0 = x;
      if (y < ty0) ty0 = y;
      if (x > tx1) tx1 = x;
      if (y > ty1) ty1 = y;
    }
  }
  const tw = tx1 - tx0 + 1, th = ty1 - ty0 + 1;
  const trimmed = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const si = ((ty0 + y) * w + (tx0 + x)) * 4;
      const di = (y * tw + x) * 4;
      trimmed[di] = buf[si]; trimmed[di + 1] = buf[si + 1];
      trimmed[di + 2] = buf[si + 2]; trimmed[di + 3] = buf[si + 3];
    }
  }
  const name = NAMES[i];
  fs.writeFileSync(path.join(OUT, name + '.png'), encodePng(tw, th, trimmed));
  console.log('wrote', name, tw + 'x' + th);
});
