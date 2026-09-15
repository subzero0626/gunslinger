// 카드 몸통만 기준으로 번 프레임 위치를 고정 (연기는 정렬에 안 씀)
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

function cardBody(f) {
  const { w, h, data } = f;
  const dark = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i + 3] > 120 && data[i] + data[i + 1] + data[i + 2] < 280
      && !(data[i] > 150 && data[i] > data[i + 2] + 50);
  };
  const rows = [];
  for (let y = 0; y < h; y++) {
    let c = 0, x0 = w, x1 = 0;
    for (let x = 0; x < w; x++) if (dark(x, y)) { c++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    rows.push({ c, x0, x1 });
  }
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h; y++) if (rows[y].c > 90) { if (y0 < 0) y0 = y; y1 = y; }
  let x0 = w, x1 = 0;
  for (let y = y0; y <= y1; y++) if (rows[y].c > 90) {
    if (rows[y].x0 < x0) x0 = rows[y].x0;
    if (rows[y].x1 > x1) x1 = rows[y].x1;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const frames = [];
for (let i = 0; i < 16; i++) frames.push(decodePng(fs.readFileSync(path.join(DIR, 'burn' + i + '.png'))));
const target = cardBody(frames[0]);
console.log('target', target);

frames.forEach((f, i) => {
  const b = cardBody(f);
  const dx = target.x - b.x;
  const dy = target.y - b.y;
  const out = Buffer.alloc(f.w * f.h * 4);
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue;
      const si = (sy * f.w + sx) * 4, di = (y * f.w + x) * 4;
      out[di] = f.data[si]; out[di + 1] = f.data[si + 1];
      out[di + 2] = f.data[si + 2]; out[di + 3] = f.data[si + 3];
    }
  }
  fs.writeFileSync(path.join(DIR, 'burn' + i + '.png'), encodePng(f.w, f.h, out));
  console.log('burn' + i, 'shift', dx, dy, 'from', JSON.stringify(b));
});

fs.writeFileSync(path.join(DIR, 'burn-meta.json'), JSON.stringify({
  w: frames[0].w, h: frames[0].h, body: target,
}, null, 2));
