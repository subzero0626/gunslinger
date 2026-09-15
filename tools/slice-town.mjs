// 콘셉트 시트 → 게임용 건물 스프라이트
//   1) 종이 배경 누끼 (부분 알파 + 종이색 언멀티플라이로 흰 테두리 제거)
//   2) 채도·명암 보정 (시트 원본은 너무 흐려서 반투명해 보인다)
//   3) Catmull-Rom 3배 확대 + 잉크 외곽선 + 언샵 → 확대해도 선명하게
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3];
const MODE = process.argv[4] || 'report';

const SCALE = Number(process.env.TOWN_SCALE || 3);
const KEY_TH = Number(process.env.TOWN_KEY || 24);      // 종이 배경으로 볼 색 거리(보수적으로)
const OUTLINE = Number(process.env.TOWN_OUTLINE || 0);  // 외곽 잉크 선 세기 (원본에 이미 선이 있어 기본 꺼둠)
const SHARPEN = Number(process.env.TOWN_SHARPEN || 0.4);

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  let plte = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported depth=${depth} interlace=${interlace}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!chan) throw new Error('color type ' + color);
  const stride = w * chan;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
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
      else if (color === 4) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]; }
      else if (color === 3) {
        const idx = line[s];
        out[d] = plte[idx * 3]; out[d + 1] = plte[idx * 3 + 1]; out[d + 2] = plte[idx * 3 + 2];
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
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
const at = (x, y) => (y * W + x) * 4;
const bg = [data[at(3, 3)], data[at(3, 3) + 1], data[at(3, 3) + 2]];
const dist = (r, g, b) => Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
const TH = 30;
const ink = (x, y) => {
  const i = at(x, y);
  return data[i + 3] >= 8 && dist(data[i], data[i + 1], data[i + 2]) > TH;
};

// ---------- 시트에서 스프라이트 위치 찾기 ----------
function runs(count, len, minLen, gap) {
  const out = [];
  let s = -1, blank = 0;
  for (let i = 0; i < len; i++) {
    if (count(i)) {
      if (s < 0) s = i;
      blank = 0;
    } else if (s >= 0) {
      blank++;
      if (blank > gap) {
        if (i - blank - s + 1 >= minLen) out.push([s, i - blank]);
        s = -1; blank = 0;
      }
    }
  }
  if (s >= 0 && len - blank - s >= minLen) out.push([s, len - blank - 1]);
  return out;
}

const rowHas = y => { for (let x = 0; x < W; x++) if (ink(x, y)) return true; return false; };
const bands = runs(rowHas, H, 25, 12);

console.log(`size ${W}x${H} bg=${bg.join(',')}`);
console.log('bands:', JSON.stringify(bands));

// 바닥 풀·점선 같은 얕은 장식은 건물로 보지 않도록 열마다 최소 두께를 요구
const TUNE = JSON.parse(process.env.TOWN_TUNE || '[]');
const tuneFor = bi => TUNE[bi] || { minCol: 14, gap: 10, minH: 24 };

const sprites = [];
bands.forEach(([by0, by1], bi) => {
  const { minCol, gap, minH } = tuneFor(bi);
  const colCount = x => { let n = 0; for (let y = by0; y <= by1; y++) if (ink(x, y)) n++; return n; };
  const cols = runs(x => colCount(x) >= minCol, W, 14, gap);
  cols.forEach(([cx0, cx1]) => {
    // 라벨(위쪽 작은 글자)을 버리고 아래쪽 큰 덩어리만 사용
    const rHas = y => { for (let x = cx0; x <= cx1; x++) if (ink(x, y)) return true; return false; };
    const vr = runs(rHas, H, 6, 6).filter(([a, b]) => a >= by0 - 4 && b <= by1 + 4);
    const main = vr.filter(([a, b]) => b - a >= minH).pop() || vr.pop();
    if (!main) return;
    let [y0, y1] = main;
    let x0 = cx1, x1 = cx0;
    for (let y = y0; y <= y1; y++) {
      for (let x = cx0; x <= cx1; x++) if (ink(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    sprites.push({ band: bi, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  });
});

sprites.forEach((s, i) => console.log(`#${i} band=${s.band} x=${s.x} y=${s.y} w=${s.w} h=${s.h}`));

if (MODE === 'report') process.exit(0);

// ---------- 이미지 가공 ----------
function crop(s, pad = 3) {
  const x0 = Math.max(0, s.x - pad), y0 = Math.max(0, s.y - pad);
  const x1 = Math.min(W - 1, s.x + s.w - 1 + pad), y1 = Math.min(H - 1, s.y + s.h - 1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = at(x0 + x, y0 + y), di = (y * w + x) * 4;
      buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2]; buf[di + 3] = data[si + 3];
    }
  }
  return { w, h, buf };
}

const HAS_ALPHA = data[at(3, 3) + 3] < 8;

// 바깥에서 flood fill 로 종이 배경을 찾고, 경계는 종이색을 빼내(언멀티플라이) 흰 테두리를 없앤다
function keyOut(im) {
  const { w, h, buf } = im;
  const near = i => dist(buf[i], buf[i + 1], buf[i + 2]) <= KEY_TH;
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const k = stack.pop();
    if (outside[k] || !near(k * 4)) continue;
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
    const d = dist(buf[i], buf[i + 1], buf[i + 2]);
    buf[i + 3] = Math.round(Math.max(0, Math.min(1, (d - 8) / (KEY_TH - 2))) * 255);
  }
  // 경계에는 종이색이 섞여 밝은 실선으로 남는다.
  // 반투명 픽셀 + 배경과 맞닿은 불투명 픽셀의 색을 안쪽 색으로 덮어 그 테두리를 없앤다.
  const src = Buffer.from(buf);
  const dirty = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!src[k * 4 + 3]) continue;
      if (src[k * 4 + 3] <= 235) { dirty[k] = 1; continue; }
      for (let dy = -1; dy <= 1 && !dirty[k]; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (src[(ny * w + nx) * 4 + 3] < 60) { dirty[k] = 1; break; }
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x, i = k * 4;
      if (!dirty[k]) continue;
      let bestD = 1e9, bj = -1;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (dirty[nk] || src[nk * 4 + 3] < 236) continue;
          const dd = dx * dx + dy * dy;
          if (dd < bestD) { bestD = dd; bj = nk * 4; }
        }
      }
      if (bj < 0) continue;
      buf[i] = src[bj]; buf[i + 1] = src[bj + 1]; buf[i + 2] = src[bj + 2];
    }
  }
}

// 원본은 연한 수채 스케치라서 벽 너머 선이 비쳐 보인다.
// 감마로 눌러 어둡게 + 채도·온도를 올리고 계단식으로 색을 뭉쳐 '칠한 판자'처럼 만든다.
const GAMMA = Number(process.env.TOWN_GAMMA ?? 1.24);    // 밀도(어둡게) — 이게 반투명해 보이는 걸 잡아준다
const SAT = Number(process.env.TOWN_SAT ?? 1.18);        // 과하게 올리면 초록·분홍으로 튄다
const WARM = Number(process.env.TOWN_WARM ?? 0.05);
const POSTER = Number(process.env.TOWN_POSTER ?? 0);     // 계단식 색 뭉치기(기본 끔 — 얼룩이 생긴다)
const CONTRAST = Number(process.env.TOWN_CONTRAST ?? 1.1);

function grade(im) {
  const { buf } = im;
  const step = POSTER > 1 ? 255 / (POSTER - 1) : 0;
  const clamp = v => Math.max(0, Math.min(255, v));
  for (let i = 0; i < buf.length; i += 4) {
    if (!buf[i + 3]) continue;
    let r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const l2 = 255 * Math.pow(l / 255, GAMMA);
    const k = l > 1 ? l2 / l : 0;
    r *= k; g *= k; b *= k;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * SAT; g = lum + (g - lum) * SAT; b = lum + (b - lum) * SAT;
    r *= 1 + WARM; b *= 1 - WARM;
    r = (r - 128) * CONTRAST + 128; g = (g - 128) * CONTRAST + 128; b = (b - 128) * CONTRAST + 128;
    if (step) {
      r = Math.round(r / step) * step; g = Math.round(g / step) * step; b = Math.round(b / step) * step;
    }
    buf[i] = clamp(Math.round(r)); buf[i + 1] = clamp(Math.round(g)); buf[i + 2] = clamp(Math.round(b));
  }
}

const catrom = t => {
  t = Math.abs(t);
  if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
  if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
  return 0;
};

function resample(im, scale) {
  const sw = im.w, sh = im.h;
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const src = new Float32Array(sw * sh * 4);
  for (let k = 0; k < sw * sh; k++) {
    const a = im.buf[k * 4 + 3] / 255;
    src[k * 4] = im.buf[k * 4] * a;
    src[k * 4 + 1] = im.buf[k * 4 + 1] * a;
    src[k * 4 + 2] = im.buf[k * 4 + 2] * a;
    src[k * 4 + 3] = im.buf[k * 4 + 3];
  }
  const axis = (inBuf, iw, ih, ow, horiz) => {
    const out = new Float32Array((horiz ? ow * ih : iw * ow) * 4);
    const ratio = (horiz ? iw : ih) / ow;
    const fs = Math.max(1, ratio), radius = 2 * fs;
    for (let d = 0; d < ow; d++) {
      const center = (d + 0.5) * ratio - 0.5;
      const taps = [];
      let sum = 0;
      for (let s = Math.ceil(center - radius); s <= Math.floor(center + radius); s++) {
        const wt = catrom((s - center) / fs);
        if (!wt) continue;
        taps.push([Math.max(0, Math.min((horiz ? iw : ih) - 1, s)), wt]);
        sum += wt;
      }
      const n = horiz ? ih : iw;
      for (let o = 0; o < n; o++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [s, wt] of taps) {
          const i = (horiz ? o * iw + s : s * iw + o) * 4;
          r += inBuf[i] * wt; g += inBuf[i + 1] * wt; b += inBuf[i + 2] * wt; a += inBuf[i + 3] * wt;
        }
        const j = (horiz ? o * ow + d : d * iw + o) * 4;
        out[j] = r / sum; out[j + 1] = g / sum; out[j + 2] = b / sum; out[j + 3] = a / sum;
      }
    }
    return out;
  };
  const tmp = axis(src, sw, sh, dw, true);
  const fin = axis(tmp, dw, sh, dh, false);
  const buf = Buffer.alloc(dw * dh * 4);
  for (let k = 0; k < dw * dh; k++) {
    const a = Math.max(0, Math.min(255, fin[k * 4 + 3]));
    const inv = a > 0.5 ? 255 / a : 0;
    for (let c = 0; c < 3; c++) buf[k * 4 + c] = Math.max(0, Math.min(255, Math.round(fin[k * 4 + c] * inv)));
    buf[k * 4 + 3] = Math.round(a);
  }
  return { w: dw, h: dh, buf };
}

// 실루엣 바깥선을 어두운 잉크로 눌러줘 하늘 앞에서도 형태가 또렷하게
function outline(im, strength, radius = 2, tint = [40, 25, 17]) {
  if (strength <= 0) return;
  const { w, h, buf } = im;
  const solid = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) solid[k] = buf[k * 4 + 3] > 140 ? 1 : 0;
  const edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!solid[k]) continue;
      let best = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          const out = nx < 0 || ny < 0 || nx >= w || ny >= h || !solid[ny * w + nx];
          if (!out) continue;
          const d = Math.hypot(dx, dy);
          best = Math.max(best, 1 - (d - 1) / radius);
        }
      }
      edge[k] = Math.max(0, Math.min(1, best));
    }
  }
  for (let k = 0; k < w * h; k++) {
    const e = edge[k] * strength;
    if (e <= 0) continue;
    for (let c = 0; c < 3; c++) buf[k * 4 + c] = Math.round(buf[k * 4 + c] * (1 - e) + tint[c] * e);
  }
}

function unsharp(im, amount) {
  if (amount <= 0) return;
  const { w, h, buf } = im;
  const src = Buffer.from(buf);
  const px = (x, y, c) => src[((Math.max(0, Math.min(h - 1, y)) * w) + Math.max(0, Math.min(w - 1, x))) * 4 + c];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      if (!src[k + 3]) continue;
      for (let c = 0; c < 3; c++) {
        const blur = (px(x - 1, y - 1, c) + 2 * px(x, y - 1, c) + px(x + 1, y - 1, c)
          + 2 * px(x - 1, y, c) + 4 * px(x, y, c) + 2 * px(x + 1, y, c)
          + px(x - 1, y + 1, c) + 2 * px(x, y + 1, c) + px(x + 1, y + 1, c)) / 16;
        buf[k + c] = Math.max(0, Math.min(255, Math.round(src[k + c] + amount * (src[k + c] - blur))));
      }
    }
  }
}

const NAMES = JSON.parse(fs.readFileSync(path.join(path.dirname(SRC), '..', 'tools', 'town-names.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const meta = {};
// 게임이 쓰지 않는 소재(계단·물탱크 등)는 기본으로 건너뛴다. 필요하면 TOWN_ALL=1
NAMES.forEach(({ index, name, cutTop, unused }) => {
  if (unused && !process.env.TOWN_ALL) return;
  const s = sprites[index];
  if (!s) { console.log('skip', name, index); return; }
  if (cutTop) {
    // 굴뚝 연기가 라벨 글자와 붙어버린 경우처럼 위쪽을 더 잘라낸다
    s.y += cutTop; s.h -= cutTop;
    let x0 = s.x + s.w - 1, x1 = s.x;
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) if (ink(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    s.x = x0; s.w = x1 - x0 + 1;
  }
  const im = crop(s);
  if (HAS_ALPHA) {
    // 시트에 이미 알파가 있으면 색 거리 누끼는 어두운 선을 먹어버린다
    for (let i = 3; i < im.buf.length; i += 4) if (im.buf[i] < 8) im.buf[i] = 0;
  } else {
    keyOut(im);
  }
  grade(im);
  const big = resample(im, SCALE);
  outline(big, OUTLINE, Math.max(1, Math.round(SCALE * 0.7)));
  unsharp(big, SHARPEN);
  fs.writeFileSync(path.join(OUT, name + '.png'), encodePng(big.w, big.h, big.buf));
  meta[name] = { w: big.w, h: big.h, scale: SCALE };
  console.log('wrote', name, big.w + 'x' + big.h);
});
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

// 누끼 확인용: 하늘색 배경에 나란히 합성해 테두리 잔상을 눈으로 본다
if (process.env.TOWN_CHECK) {
  const files = Object.keys(meta);
  const pad = 20;
  const scale = 0.5;
  const cells = files.map(n => {
    const im = decodePng(fs.readFileSync(path.join(OUT, n + '.png')));
    return { n, im, w: Math.round(im.w * scale), h: Math.round(im.h * scale) };
  });
  const cw = Math.max(...cells.map(c => c.w)) + pad;
  const ch = Math.max(...cells.map(c => c.h)) + pad;
  const cols = 5, rows = Math.ceil(cells.length / cols);
  const CW = cw * cols, CH = ch * rows;
  const out = Buffer.alloc(CW * CH * 4);
  for (let k = 0; k < CW * CH; k++) {
    const y = Math.floor(k / CW);
    const t = y / CH;
    out[k * 4] = Math.round(236 - 60 * t);
    out[k * 4 + 1] = Math.round(140 + 30 * t);
    out[k * 4 + 2] = Math.round(78 + 60 * t);
    out[k * 4 + 3] = 255;
  }
  cells.forEach((c, idx) => {
    const ox = (idx % cols) * cw + pad / 2, oy = Math.floor(idx / cols) * ch + (ch - c.h);
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const sx = Math.min(c.im.w - 1, Math.round(x / scale)), sy = Math.min(c.im.h - 1, Math.round(y / scale));
        const si = (sy * c.im.w + sx) * 4;
        const a = c.im.data[si + 3] / 255;
        if (!a) continue;
        const di = ((oy + y) * CW + (ox + x)) * 4;
        for (let ci = 0; ci < 3; ci++) out[di + ci] = Math.round(c.im.data[si + ci] * a + out[di + ci] * (1 - a));
      }
    }
  });
  fs.writeFileSync(path.join(OUT, '..', '..', 'tools', 'check.png'), encodePng(CW, CH, out));
  console.log('check sheet written');
}
