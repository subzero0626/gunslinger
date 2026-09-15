// 불타는 카드 시트 → assets/tarot/burn*.png (흰 배경 누끼, 몸통 정렬)
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

function px(data, W, x, y) {
  const i = (y * W + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3], i };
}

function chroma(p) { return Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b); }
function lum(p) { return p.r + p.g + p.b; }
function isFire(p) { return p.r > 140 && p.r > p.b + 40 && (p.r + p.g) > p.b * 2; }
function isCard(p) { return lum(p) < 380 && chroma(p) < 90; }
function isWhite(p) { return lum(p) > 735 && chroma(p) < 28; }
function isSmoke(p) {
  const L = lum(p), c = chroma(p);
  return p.a > 16 && !isFire(p) && L > 420 && c < 50;
}

function alphaOf(p, dropSmoke) {
  if (p.a < 16) return 0;
  if (dropSmoke && isSmoke(p)) return 0;
  return p.a;
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

const img = decodePng(fs.readFileSync(SRC));
const { w: W, h: H, data } = img;
const sample = (x, y) => {
  const p = px(data, W, x, y);
  return x + ',' + y + ' rgb(' + p.r + ',' + p.g + ',' + p.b + ') L' + lum(p) + ' C' + chroma(p);
};
console.log('samples', [sample(2, 2), sample(W >> 1, 2), sample(W - 3, 2), sample(W >> 1, H >> 1), sample(200, 200)].join(' | '));

const solid = (x, y) => {
  const p = px(data, W, x, y);
  return p.a > 40 && lum(p) < 420;
};

const bands = runs(y => { for (let x = 0; x < W; x++) if (solid(x, y)) return true; return false; }, H, 40, 20);
const boxes = [];
bands.forEach(([y0, y1], bi) => {
  const prev = bands[bi - 1];
  const next = bands[bi + 1];
  const clipY0 = prev ? ((prev[1] + y0) >> 1) : 0;
  const clipY1 = next ? ((y1 + next[0]) >> 1) : H - 1;
  const cols = runs(x => { for (let y = y0; y <= y1; y++) if (solid(x, y)) return true; return false; }, W, 30, 20);
  cols.forEach(([x0, x1]) => boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, clipY0, clipY1 }));
});
console.log('sheet', W + 'x' + H, 'bands', bands, 'boxes', boxes.map((c, i) => i + ':' + c.w + 'x' + c.h + '@' + c.x + ',' + c.y).join(' | '));
if (boxes.length !== 8) throw new Error('expected 8 burn frames, got ' + boxes.length);

const frames = boxes.map((box, idx) => {
  const dropSmoke = idx === 7;
  const padX = 48, padY = 110;
  const x0 = Math.max(0, box.x - padX);
  const y0 = Math.max(box.clipY0, box.y - padY);
  const x1 = Math.min(W - 1, box.x + box.w - 1 + padX);
  const y1 = Math.min(box.clipY1, box.y + box.h - 1 + padY);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = px(data, W, x0 + x, y0 + y);
      const a = alphaOf(p, dropSmoke);
      const di = (y * w + x) * 4;
      buf[di] = p.r; buf[di + 1] = p.g; buf[di + 2] = p.b; buf[di + 3] = a;
      if (a > 180 && isCard(p)) {
        if (x < bx0) bx0 = x; if (y < by0) by0 = y;
        if (x > bx1) bx1 = x; if (y > by1) by1 = y;
      }
    }
  }
  if (dropSmoke && bx1 >= bx0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const di = (y * w + x) * 4;
        if (buf[di + 3] < 16) continue;
        const p = { r: buf[di], g: buf[di + 1], b: buf[di + 2], a: buf[di + 3] };
        if (y < by0 - 4 && !isFire(p)) buf[di + 3] = 0;
        else if (isSmoke(p)) buf[di + 3] = 0;
      }
    }
  }
  return {
    w, h, buf,
    boxW: box.w, boxH: box.h,
    offX: box.x - x0, offY: box.y - y0,
    body: { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 },
  };
});

const boxW = Math.max(...frames.map(f => f.boxW));
const boxH = Math.max(...frames.map(f => f.boxH));
let left = 0, right = 0, top = 0, bottom = 0;
frames.forEach(f => {
  left = Math.max(left, f.offX);
  top = Math.max(top, f.offY);
  right = Math.max(right, f.w - f.offX - f.boxW);
  bottom = Math.max(bottom, f.h - f.offY - f.boxH);
});
const outW = left + boxW + right;
const outH = top + boxH + bottom;
const destBox = { x: left, y: top, w: boxW, h: boxH };

fs.mkdirSync(OUT, { recursive: true });
frames.forEach((f, i) => {
  const out = Buffer.alloc(outW * outH * 4);
  const dx = destBox.x - f.offX;
  const dy = destBox.y + destBox.h - f.offY - f.boxH;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const si = (y * f.w + x) * 4;
      if (f.buf[si + 3] < 8) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= outW || yy >= outH) continue;
      const di = (yy * outW + xx) * 4;
      out[di] = f.buf[si]; out[di + 1] = f.buf[si + 1];
      out[di + 2] = f.buf[si + 2]; out[di + 3] = f.buf[si + 3];
    }
  }
  fs.writeFileSync(path.join(OUT, 'burn' + i + '.png'), encodePng(outW, outH, out));
  console.log('wrote burn' + i, outW + 'x' + outH);
});
const body = frames[0].body;
const meta = {
  w: outW,
  h: outH,
  body: { x: destBox.x - frames[0].offX + body.x, y: destBox.y + destBox.h - frames[0].offY - frames[0].boxH + body.y, w: body.w, h: body.h },
};
fs.writeFileSync(path.join(OUT, 'burn-meta.json'), JSON.stringify(meta, null, 2));
console.log('meta', meta);
