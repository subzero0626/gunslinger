(() => {
  const A = window.ASSETS;
  const PR = window.PROPS;
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const wipeEl = document.getElementById('wipeLayer');
  const wipeCtx = wipeEl ? wipeEl.getContext('2d') : null;
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cvs.width = W * DPR; cvs.height = H * DPR;
    cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
    cvs.style.touchAction = 'none';
    ctx.imageSmoothingQuality = 'high';
    if (wipeEl && wipeCtx) {
      wipeEl.width = W * DPR;
      wipeEl.height = H * DPR;
      wipeEl.style.width = W + 'px';
      wipeEl.style.height = H + 'px';
      wipeCtx.imageSmoothingEnabled = false;
    }
  }
  addEventListener('resize', resize);
  if (window.visualViewport) visualViewport.addEventListener('resize', resize);
  resize();

  const QUERY = new URLSearchParams(location.search);
  const PREVIEW = QUERY.has('preview');       // index.html?preview → 모든 프레임 정렬 확인용
  const START_X = Number(QUERY.get('x')) || 0; // index.html?x=1500 → 시작 위치 지정
  const IMG = {};
  const MAP_IDS = ['flat', 'hill', 'rise', 'drop'];
  const MAP_SRC = {
    flat: 'assets/bg.png',
    hill: 'assets/maps/hill.png',
    rise: 'assets/maps/rise.png',
    drop: 'assets/maps/drop.png',
  };
  let arenaMap = 'flat';
  let mapHeights = window.MAP_HEIGHTS || {};
  let awaitMap = false;
  let pendingArena = null;
  let pendingSeed = null;
  let obstacleSeed = 7;
  let netReady = false;
  const BG_GROUND = 0.777;

  function inMatch() {
    return !!netReady;
  }

  function activeMapId() {
    return inMatch() ? arenaMap : 'flat';
  }

  function playBg() {
    const id = activeMapId();
    if (id === 'flat') return IMG.bg;
    return IMG['map_' + id] || IMG.bg;
  }

  function bgLayout(bg) {
    if (!bg || !bg.width) return null;
    const scale = Math.max(W / bg.width, H / bg.height) * 1.04;
    const dw = bg.width * scale, dh = bg.height * scale;
    return { scale, dw, dh, dx: (W - dw) * 0.5, dy: (H - dh) * 0.5 };
  }

  function heightRatio(u) {
    const hm = mapHeights[activeMapId()];
    if (!hm || !hm.length) return BG_GROUND;
    u = Math.max(0, Math.min(1, u));
    if (typeof hm[0] === 'number') {
      const t = u * (hm.length - 1);
      const i = t | 0;
      const f = t - i;
      return hm[i] * (1 - f) + hm[Math.min(i + 1, hm.length - 1)] * f;
    }
    if (u <= hm[0].u) return hm[0].y;
    for (let i = 1; i < hm.length; i++) {
      if (u <= hm[i].u) {
        const a = hm[i - 1], b = hm[i];
        const t = (u - a.u) / ((b.u - a.u) || 1);
        return a.y + (b.y - a.y) * t;
      }
    }
    return hm[hm.length - 1].y;
  }

  function groundAt(x) {
    const bg = playBg();
    const lay = bgLayout(bg);
    if (!lay) return Math.round(H * 0.78);
    const u = (x - lay.dx) / lay.dw;
    return Math.round(lay.dy + heightRatio(u) * lay.dh);
  }

  function groundSlope(x) {
    const d = 12;
    return Math.atan2(groundAt(x + d) - groundAt(x - d), d * 2);
  }

  const groundY = () => groundAt(W * 0.5);

  function setArenaMap(id) {
    if (!MAP_IDS.includes(id)) return false;
    arenaMap = id;
    layoutObstacles();
    return true;
  }

  function pickArenaMap() {
    arenaMap = MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)];
    layoutObstacles();
    return arenaMap;
  }

  function useTownMap() {
    arenaMap = 'flat';
    obstacleSeed = (Math.random() * 0x7fffffff) | 1;
    layoutObstacles();
  }

  function snapToGround() {
    for (const pl of players) {
      if (!pl || !pl.onGround) continue;
      pl.y = groundAt(pl.x);
      pl.vy = 0;
    }
    if (board && board.x) board.y = groundAt(board.x);
    layoutObstacles();
  }

  function broadcastMap() {
    obstacleSeed = (Math.random() * 0x7fffffff) | 1;
    pickArenaMap();
    if (window.GunNet) GunNet.send({ t: 'map', id: arenaMap, seed: obstacleSeed });
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const approach = (v, target, step) => v < target ? Math.min(v + step, target) : Math.max(v - step, target);
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const rand = (a, b) => a + Math.random() * (b - a);
  function seeded(seed) {
    return () => {
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- 크기 / 수치 ----------
  const BODY_H = 99;                        // 화면에서 캐릭터 키(px)
  const BODY_K = BODY_H / A.meta.walk[0].h;
  const MAX_HP = 10;
  const DMG_BODY = 1, DMG_HEAD = 3;
  const ARM_K = BODY_K * 0.62 * 0.84;
  const GUN_K = BODY_K * 0.55 * 0.84;
  const ARM_FRAME = 2;                      // 팔을 앞으로 뻗은 프레임
  const AMMO = 6, RELOAD_TIME = 1.5, DODGE_TIME = 0.5, TWIN_GAP = 0.16, INVULN_TIME = 0.95;
  const RUN_SPEED = 375, BACK_SPEED = RUN_SPEED * 0.65, DODGE_SPEED = 720, JUMP_V = 880;
  const BULLET_SPEED = 3200;
  const RUN_STRIDE = 26;                    // 프레임 1장당 이동 거리(px) → 발 미끄러짐 방지
  // 시트마다 캐릭터가 그려진 크기가 달라서 모자 폭 기준으로 맞춤 (walk = 1)
  const ANIM_SCALE = { walk: 1, run: 1.26, jump: 1.13, dodge: 1.17 };
  const frameScale = (anim) => ANIM_SCALE[anim];
  const SHOULDER_BACK = 22, SHOULDER_DOWN = 4.4; // 어깨를 몸 안쪽·위쪽으로 (화면 px)
  const CAPE_OVER_R = 22;                     // 팔 위로 망토를 다시 덮는 반경 (화면 px)

  // ---------- 월드 / 소품 배치 ----------
  const WORLD_W = 2600;
  // [소품 이름, x, 화면 높이(px), 위로 띄우기(px), 특수]
  const LAYOUT = {
    // 먼 배경 실루엣 (카메라의 0.6배 속도로 움직임)
    mid: [
      ['cactus', 120, 58], ['lamppost', 480, 70], ['wheel', 860, 38], ['cactus', 1180, 48],
      ['wanted', 1460, 44], ['cactus', 1760, 62], ['fence', 2080, 32],
    ],
    // 플레이어 바로 뒤
    back: [
      ['signpost', 170, 72], ['deadbush', 330, 40], ['cactus', 480, 98],
      ['barrel', 700, 46], ['crate', 755, 42], ['lantern', 755, 26, 38],
      ['bench', 1000, 40, 0, 'bottles'], ['chest', 1160, 34], ['wheel', 1330, 62], ['rope', 1425, 22],
      ['wanted', 1590, 76], ['lamppost', 1770, 114], ['rocks', 1890, 30], ['bottle', 1950, 12],
      ['fence', 2040, 54], ['campfire', 2240, 42], ['bench', 2420, 40, 0, 'bottles'], ['cactus', 2560, 86],
    ],
    // 화면 앞쪽 (카메라의 1.15배 속도, 어둡게)
    fg: [
      ['rocks', 260, 56], ['deadbush', 880, 72], ['rocks', 1520, 46], ['deadbush', 2080, 64], ['rocks', 2760, 52],
    ],
  };
  // 흙더미가 그려진 소품은 바닥에 조금 파묻어야 떠 보이지 않음 (높이 비율)
  const SINK = { cactus: 0.06, signpost: 0.06, fence: 0.07, wheel: 0.06, rocks: 0.12, deadbush: 0.1, campfire: 0.08, lamppost: 0.05, wanted: 0.05, bottle: 0.25 };
  const BENCH_TOP = 0.86;  // 벤치 윗면 높이 (아래에서부터 비율)

  const OBJ_IDS = [
    'spire', 'boulders', 'logs', 'hay', 'cactus', 'fence',
    'windmill', 'gallows', 'crates', 'rail', 'shade', 'snag',
    'tank', 'tank_rust', 'lookout', 'deadtree', 'oak',
  ];
  const OBJ_TALL = { windmill: 1, tank: 1, tank_rust: 1, lookout: 1, gallows: 1 };
  const OBJ_H = {
    spire: 120, boulders: 86, logs: 72, hay: 68, cactus: 110, fence: 72,
    crates: 90, rail: 70, shade: 96, snag: 124, deadtree: 148, oak: 168,
  };
  const OBJ_SCALE = 1.2;
  const OBJ_PLANT = 3; // 발끝을 진한 흙 표면에 맞춤
  const OBJ_MASKS = {};
  const obstacles = [];
  const MASK_A = 40;

  function objImg(id) {
    return IMG['obj_' + id];
  }

  function objDrawH(id) {
    if (OBJ_TALL[id]) return BODY_H * 3 * OBJ_SCALE;
    if (id === 'shade') return BODY_H * 2 * OBJ_SCALE;
    const tree = id === 'oak' || id === 'deadtree' || id === 'snag' ? 1.5 : 1;
    return (OBJ_H[id] || 90) * OBJ_SCALE * tree;
  }

  function inflateMask(raw) {
    const w = raw.w, h = raw.h;
    const bits = new Uint8Array(w * h);
    const cols = raw.c || [];
    for (let x = 0; x < cols.length; x++) {
      const runs = cols[x];
      for (let i = 0; i < runs.length; i += 2) {
        const y0 = runs[i], y1 = runs[i + 1];
        for (let y = y0; y < y1; y++) bits[y * w + x] = 1;
      }
    }
    return { w, h, bits, foot: raw.foot == null ? h - 1 : raw.foot };
  }

  function silhouetteMask(img) {
    const w = img.width, h = img.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    let d;
    try {
      d = g.getImageData(0, 0, w, h).data;
    } catch (err) {
      console.warn('obj mask failed', err);
      return { w, h, bits: new Uint8Array(w * h), foot: h - 1 };
    }
    const bits = new Uint8Array(w * h);
    let foot = 0;
    for (let i = 0; i < w * h; i++) {
      if (d[i * 4 + 3] >= MASK_A) {
        bits[i] = 1;
        const y = (i / w) | 0;
        if (y > foot) foot = y;
      }
    }
    return { w, h, bits, foot };
  }

  function buildObjMasks() {
    const raw = window.OBJ_MASKS_RAW || {};
    for (const id of OBJ_IDS) {
      if (raw[id] && raw[id].c) {
        OBJ_MASKS[id] = inflateMask(raw[id]);
        continue;
      }
      const img = objImg(id);
      if (!img || !img.width) continue;
      OBJ_MASKS[id] = silhouetteMask(img);
    }
  }

  function plateauBands() {
    const pts = (mapHeights[activeMapId()] || [{ u: 0, y: 0 }, { u: 1, y: 0 }])
      .slice()
      .sort((a, b) => a.u - b.u);
    const bands = [];
    const EDGE = 0.045;
    for (let i = 0; i < pts.length - 1; i++) {
      if (Math.abs(pts[i].y - pts[i + 1].y) > 0.012) continue;
      const a = Math.max(EDGE, pts[i].u);
      const b = Math.min(1 - EDGE, pts[i + 1].u);
      if (b - a > 0.07) bands.push([a, b]);
    }
    if (!bands.length) bands.push([EDGE, 1 - EDGE]);
    return bands;
  }

  function uBlocked(u, half) {
    const spans = [[0.22 - 0.06, 0.22 + 0.06], [0.78 - 0.06, 0.78 + 0.06]];
    if (!netReady) spans.push([0.62 - 0.1, 0.62 + 0.1]);
    const lo = u - half, hi = u + half;
    for (let i = 0; i < spans.length; i++) {
      if (lo < spans[i][1] && hi > spans[i][0]) return true;
    }
    return false;
  }

  function maskSolid(mask, lx, ly) {
    const x = lx | 0, y = ly | 0;
    if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return false;
    return mask.bits[y * mask.w + x] !== 0;
  }

  function layoutObstacles() {
    obstacles.length = 0;
    if (!W || !H) return;
    const rng = seeded(obstacleSeed || 7);
    const pool = OBJ_IDS.filter(id => objImg(id) && OBJ_MASKS[id]);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const want = netReady ? 4 + (rng() < 0.55 ? 1 : 0) + (rng() < 0.35 ? 1 : 0) : 5;
    const bands = plateauBands();
    const placed = [];
    for (let p = 0; p < pool.length && obstacles.length < want; p++) {
      const id = pool[p];
      const img = objImg(id);
      const mask = OBJ_MASKS[id];
      const h = objDrawH(id);
      const dw = h * (img.width / img.height);
      const half = dw * 0.5 / W + 0.012;
      let put = false;
      for (let k = 0; k < 14 && !put; k++) {
        const band = bands[(rng() * bands.length) | 0];
        if (band[1] - band[0] < half * 2 + 0.02) continue;
        const u = band[0] + half + rng() * (band[1] - band[0] - half * 2);
        if (uBlocked(u, half)) continue;
        let hit = false;
        for (let i = 0; i < placed.length; i++) {
          if (Math.abs(placed[i].u - u) < placed[i].half + half + 0.02) { hit = true; break; }
        }
        if (hit) continue;
        placed.push({ u, half });
        const x = W * u;
        const gy = groundAt(x);
        const padB = Math.max(0, (mask.h - 1 - (mask.foot == null ? mask.h - 1 : mask.foot)) / mask.h);
        obstacles.push({
          id, img, mask, x,
          gy,
          y: gy + OBJ_PLANT + h * padB,
          w: dw,
          h,
          tall: !!OBJ_TALL[id],
        });
        put = true;
      }
    }
  }

  function obstacleSolid(wx, wy, walk) {
    for (let i = 0; i < obstacles.length; i++) {
      const b = obstacles[i];
      const left = b.x - b.w * 0.5;
      if (wx < left || wx > left + b.w || wy < b.y - b.h || wy > b.y + 2) continue;
      if (walk && b.tall && wy > b.gy - BODY_H * 1.22) continue;
      const lx = ((wx - left) / b.w) * b.mask.w;
      const ly = ((wy - (b.y - b.h)) / b.h) * b.mask.h;
      if (maskSolid(b.mask, lx, ly)) return true;
    }
    return false;
  }

  function obstacleRayHit(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(dist));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + dx * t, y = y0 + dy * t;
      if (obstacleSolid(x, y, false)) return { x, y };
    }
    return null;
  }

  function playerHitsObstacle(pl) {
    return false;
  }

  function resolveObstacleX(pl, prevX) {
    if (!playerHitsObstacle(pl)) return;
    const x1 = pl.x;
    pl.x = prevX;
    if (!playerHitsObstacle(pl)) {
      pl.vx = 0;
      return;
    }
    const dir = x1 >= prevX ? 1 : -1;
    for (let s = 2; s <= 72; s += 2) {
      pl.x = prevX - dir * s;
      if (pl.x < 40 || pl.x > W - 40) break;
      if (!playerHitsObstacle(pl)) {
        pl.vx = 0;
        return;
      }
    }
    pl.x = prevX;
    pl.vx = 0;
  }

  function drawObstacles() {
    if (!obstacles.length) return;
    for (let i = 0; i < obstacles.length; i++) {
      const b = obstacles[i];
      const left = b.x - b.w * 0.5;
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#1a100c';
      ctx.beginPath();
      ctx.ellipse(b.x, b.gy + 1, b.w * 0.38, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.drawImage(b.img, left, b.y - b.h, b.w, b.h);
    }
  }

  addEventListener('resize', () => {
    if (Object.keys(OBJ_MASKS).length) layoutObstacles();
  });

  const sources = {
    ...A.images,
    props: PR.image,
    bg: MAP_SRC.flat,
    map_hill: MAP_SRC.hill,
    map_rise: MAP_SRC.rise,
    map_drop: MAP_SRC.drop,
    wantedBoard: 'assets/wanted-sign.png?v=1',
    hudBullet0: 'assets/ui/bullet0.png',
    hudBullet1: 'assets/ui/bullet1.png',
    hudBullet2: 'assets/ui/bullet2.png',
    hudBullet3: 'assets/ui/bullet3.png',
    hudBullet4: 'assets/ui/bullet4.png',
    reload0: 'assets/ui/reload0.png',
    obj_spire: 'assets/obj/spire.png',
    obj_boulders: 'assets/obj/boulders.png',
    obj_logs: 'assets/obj/logs.png',
    obj_hay: 'assets/obj/hay.png',
    obj_cactus: 'assets/obj/cactus.png',
    obj_fence: 'assets/obj/fence.png',
    obj_windmill: 'assets/obj/windmill.png',
    obj_gallows: 'assets/obj/gallows.png',
    obj_crates: 'assets/obj/crates.png',
    obj_rail: 'assets/obj/rail.png',
    obj_shade: 'assets/obj/shade.png',
    obj_snag: 'assets/obj/snag.png',
    obj_tank: 'assets/obj/tank.png',
    obj_tank_rust: 'assets/obj/tank_rust.png',
    obj_lookout: 'assets/obj/lookout.png',
    obj_deadtree: 'assets/obj/deadtree.png',
    obj_oak: 'assets/obj/oak.png',
  };
  let pending = Object.keys(sources).length;

  let GG = null;   // 팔/총 기하 정보
  let idle = null; // 가만히 있을 때 망토 흔들림용 (host)
  let idleBlue = null; // guest 파란 망토 idle
  const IMG_BLUE = {};
  const SPR = {}, TINT_MID = {}, TINT_FG = {};
  let mesas = [], pebbles = [], grass = [];

  // 원래 먼지 낀 붉은 망토와 비슷한 채도·명도의 더스트 블루 (쨍한 파랑 X)
  function dustyCapeBlue(r, gv, b) {
    const L = (r + gv + b) / 3;
    const dirt = (r - L) * 0.18; // 원본 얼룩/대비 일부 유지
    return [
      clamp(L * 0.62 + dirt + 14, 0, 255),
      clamp(L * 0.66 + dirt * 0.4 + 16, 0, 255),
      clamp(L * 0.82 + 20, 0, 255),
    ];
  }

  // 망토 마스크만 재색 — 모자/옷 붉은 톤은 제외
  function recolorBodyCapeOnly(bodyImg, capeMask) {
    const c = document.createElement('canvas');
    c.width = bodyImg.width; c.height = bodyImg.height;
    const g = c.getContext('2d');
    g.drawImage(bodyImg, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const p = d.data;

    const mc = document.createElement('canvas');
    mc.width = capeMask.width; mc.height = capeMask.height;
    const mg = mc.getContext('2d');
    mg.drawImage(capeMask, 0, 0);
    const m = mg.getImageData(0, 0, mc.width, mc.height).data;

    for (let i = 0; i < p.length; i += 4) {
      const ma = m[i + 3];
      if (ma < 8 || p[i + 3] === 0) continue;
      const t = ma / 255;
      const r = p[i], gv = p[i + 1], b = p[i + 2];
      const [nr, ng, nb] = dustyCapeBlue(r, gv, b);
      p[i] = lerp(r, nr, t);
      p[i + 1] = lerp(gv, ng, t);
      p[i + 2] = lerp(b, nb, t);
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  function recolorCapeOverlayBlue(capeCanvas) {
    const c = document.createElement('canvas');
    c.width = capeCanvas.width; c.height = capeCanvas.height;
    const g = c.getContext('2d');
    g.drawImage(capeCanvas, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 8) continue;
      const [nr, ng, nb] = dustyCapeBlue(p[i], p[i + 1], p[i + 2]);
      p[i] = nr; p[i + 1] = ng; p[i + 2] = nb;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  function buildBlueBodies() {
    for (const name of Object.keys(ANIM_SCALE)) {
      IMG_BLUE[name] = recolorBodyCapeOnly(IMG[name], CAPE[name]);
    }
  }

  function start() {
    const a = A.meta.arm[ARM_FRAME], g = A.meta.gun[0];
    const fistX = (a.fx - a.px) * ARM_K, fistY = (a.fy - a.py) * ARM_K;
    GG = { fistX, fistY, barrelY: fistY + (g.my - g.gy) * GUN_K };
    buildCapeOverlays();
    buildCapeOverlaysBlue();
    buildBlueBodies();
    setupIdle();
    setupIdleBlue();
    buildWorld();
    try { buildObjMasks(); } catch (e) { console.warn('obj masks', e); }
    layoutTargets();
    useTownMap();
    snapViewRest();
    last = performance.now();
    requestAnimationFrame(loop);
  }

  function tinted(name, color) {
    const m = PR.meta[name];
    const c = document.createElement('canvas');
    c.width = m.w; c.height = m.h;
    const g = c.getContext('2d');
    g.drawImage(IMG.props, m.x, m.y, m.w, m.h, 0, 0, m.w, m.h);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = color;
    g.fillRect(0, 0, m.w, m.h);
    return { img: c, sx: 0, sy: 0, w: m.w, h: m.h };
  }

  function buildWorld() {
    for (const [name, m] of Object.entries(PR.meta)) SPR[name] = { img: IMG.props, sx: m.x, sy: m.y, w: m.w, h: m.h };
    for (const [name] of LAYOUT.mid) TINT_MID[name] ||= tinted(name, 'rgba(118,72,58,0.72)');
    for (const [name] of LAYOUT.fg) TINT_FG[name] ||= tinted(name, 'rgba(22,13,10,0.6)');

    const rng = seeded(7);
    let x = -150;
    while (x < 4200) {
      const gap = 60 + rng() * 160, wdt = 140 + rng() * 260, hgt = 40 + rng() * 80, slope = 20 + rng() * 40, hill = 8 + rng() * 22;
      mesas.push([x, hill], [x + gap, hill], [x + gap + slope, hgt], [x + gap + slope + wdt, hgt + (rng() - 0.5) * 10], [x + gap + slope * 2 + wdt, hill]);
      x += gap + slope * 2 + wdt;
    }
    for (let i = 0; i < 320; i++) pebbles.push({ x: rng() * WORLD_W, fy: rng(), r: 1 + rng() * 2.6, light: rng() < 0.4 });
    for (let i = 0; i < 110; i++) grass.push({ x: rng() * WORLD_W, fy: rng(), h: 4 + rng() * 7 });
  }

  // ---------- 팔 위에 덮을 망토 ----------
  // 몸 스프라이트에서 망토 색 픽셀만 남긴 사본 → 어깨 부근에만 팔 위로 다시 그려 "망토 안에서 나온" 느낌
  const CAPE = {}, CAPE_BLUE = {};
  // 프레임별: 망토 + 목도리. 모자(더 위쪽) 붉은 픽셀만 제외
  function buildCapeOverlaysFrom(srcMap, outMap) {
    for (const name of Object.keys(ANIM_SCALE)) {
      const im = srcMap[name];
      const frames = A.meta[name];
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      const p = d.data;
      const keep = new Float32Array(c.width * c.height);

      for (const f of frames) {
        const x0 = f.x | 0, y0 = f.y | 0, fw = f.w | 0, fh = f.h | 0;
        const ax = f.ax, sy = f.sy;
        for (let ly = 0; ly < fh; ly++) {
          // 목도리까지 포함 (어깨보다 조금 위). 모자·챙은 더 위라 잘림
          const belowHat = smooth((ly - (sy - 30)) / 12);
          if (belowHat <= 0.01) continue;
          for (let lx = 0; lx < fw; lx++) {
            const gx = x0 + lx, gy = y0 + ly;
            const i = gy * c.width + gx;
            const di = i * 4;
            if (p[di + 3] < 8) continue;
            const r = p[di], gv = p[di + 1], b = p[di + 2];
            const L = (r + gv + b) / 3;
            const redish = smooth((r - b - 18) / 12) * smooth((L - 85) / 20) * (1 - smooth((L - 150) / 25));
            if (redish <= 0.01) continue;
            // 모자 챙이 닿는 최상단만 등 쪽 제한. 목·목도리는 전방도 포함
            let spatial = 1;
            if (ly < sy - 22) spatial = smooth((ax - 8 - lx) / 16);
            keep[i] = Math.max(keep[i], belowHat * spatial * redish);
          }
        }
      }

      for (let i = 0; i < keep.length; i++) {
        const di = i * 4;
        p[di + 3] = Math.round(p[di + 3] * keep[i]);
      }
      g.putImageData(d, 0, 0);
      outMap[name] = c;
    }
  }
  function buildCapeOverlays() { buildCapeOverlaysFrom(IMG, CAPE); }
  function buildCapeOverlaysBlue() {
    for (const name of Object.keys(ANIM_SCALE)) {
      CAPE_BLUE[name] = recolorCapeOverlayBlue(CAPE[name]);
    }
  }

  const capeTmp = document.createElement('canvas');
  const capeTmpCtx = capeTmp.getContext('2d');
  function drawCapeOver(S, f, k) {
    const capeSrc = S.skin === 'guest' ? CAPE_BLUE : CAPE;
    const R = CAPE_OVER_R, size = Math.ceil(R * 2 * DPR);
    if (capeTmp.width !== size) { capeTmp.width = size; capeTmp.height = size; }
    const g = capeTmpCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, size, size);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.save();
    g.translate(R + S.x - S.shoulder.x, R + S.y - S.shoulder.y);
    g.scale(S.facing * S.sx, S.sy);
    g.drawImage(capeSrc[S.anim], f.x, f.y, f.w, f.h, -f.ax * k, -f.ay * k, f.w * k, f.h * k);
    g.restore();
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0.5, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
    ctx.drawImage(capeTmp, S.shoulder.x - R, S.shoulder.y - R, R * 2, R * 2);
  }

  // ---------- 가만히 있을 때 망토 ----------
  function makeIdle(srcImg) {
    const f = A.meta.walk[0], pad = 16;
    const c = document.createElement('canvas');
    c.width = f.w + pad; c.height = f.h;
    const g = c.getContext('2d');
    g.drawImage(srcImg, f.x, f.y, f.w, f.h, pad, 0, f.w, f.h);
    const src = g.getImageData(0, 0, c.width, c.height).data.slice();
    const wt = new Float32Array(c.width * c.height);
    const x0 = f.ax - 40, x1 = 10;
    for (let y = 0; y < c.height; y++) {
      const fy = smooth((y - f.h * 0.35) / (f.h * 0.35));
      for (let x = 0; x < c.width; x++) {
        wt[y * c.width + x] = fy * smooth((x0 - (x - pad)) / (x0 - x1));
      }
    }
    return { canvas: c, ctx: g, src, wt, out: g.createImageData(c.width, c.height), pad, xMax: Math.ceil(x0 + pad) };
  }
  function setupIdle() { idle = makeIdle(IMG.walk); }
  function setupIdleBlue() { idleBlue = makeIdle(IMG_BLUE.walk); }

  function warpIdle(t, idleObj) {
    const { canvas: c, src, wt, out, xMax } = idleObj;
    const o = out.data, w = c.width, h = c.height;
    o.set(src);
    for (let y = 0; y < h; y++) {
      const wave = Math.sin(t * 2.6 + y * 0.045) * 2.2 + Math.sin(t * 4.3 + y * 0.08) * 0.7;
      for (let x = 0; x < xMax; x++) {
        const i = y * w + x, k = wt[i];
        if (k <= 0) continue;
        const sx = Math.round(x - k * wave);
        const di = i * 4;
        if (sx < 0 || sx >= w) { o[di + 3] = 0; continue; }
        const si = (y * w + sx) * 4;
        o[di] = src[si]; o[di + 1] = src[si + 1]; o[di + 2] = src[si + 2]; o[di + 3] = src[si + 3];
      }
    }
    idleObj.ctx.putImageData(out, 0, 0);
  }

  // ---------- 온라인 (나 / 상대) + 현상수배 게시판 ----------
  let myRole = null; // 'host' | 'guest'
  let me = null, other = null;
  let netAcc = 0;
  let matchOver = false;
  let overOpen = false;
  let myRematch = false;
  let otherRematch = false;
  let lastOverWin = false;
  let lockT = 0;
  const START_LOCK = 1.5;
  const wipe = { t: 0, dur: 0.78, onMid: null, hitMid: true, active: false };

  function wiping() { return wipe.active; }

  function playWipe(onMid) {
    if (wipe.active && !wipe.hitMid) {
      wipe.onMid = onMid || null;
      return;
    }
    wipe.active = true;
    wipe.t = 0;
    wipe.hitMid = false;
    wipe.onMid = onMid || null;
    if (wipeEl) wipeEl.classList.add('is-on');
  }

  function updateWipe(dt) {
    if (!wipe.active) return;
    wipe.t += dt;
    if (!wipe.hitMid && wipe.t >= wipe.dur * 0.5) {
      wipe.hitMid = true;
      const fn = wipe.onMid;
      wipe.onMid = null;
      if (fn) fn();
    }
    if (wipe.t >= wipe.dur) {
      wipe.active = false;
      wipe.t = wipe.dur;
      if (wipeEl) wipeEl.classList.remove('is-on');
    }
  }

  function drawWipe() {
    if (!wipeCtx) return;
    wipeCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    wipeCtx.clearRect(0, 0, W, H);
    if (!wipe.active) return;
    const p = smooth(clamp(wipe.t / wipe.dur, 0, 1));
    const diag = Math.hypot(W, H) + 64;
    const band = diag * 1.72;
    const travel = diag + band;
    const lead = p * travel;
    const trail = lead - band;
    wipeCtx.save();
    wipeCtx.beginPath();
    wipeCtx.rect(0, 0, W, H);
    wipeCtx.clip();
    wipeCtx.rotate(Math.atan2(H, W));
    wipeCtx.fillStyle = '#0b0908';
    wipeCtx.fillRect(trail - 2, -diag, lead - trail + 4, diag * 2);
    wipeCtx.fillStyle = 'rgba(201,163,106,0.5)';
    wipeCtx.fillRect(lead - 3, -diag, 3, diag * 2);
    wipeCtx.restore();
  }
  const DRAFT_PICK = 7;
  const startGaugeEl = document.getElementById('startGauge');
  const startGaugeFill = document.getElementById('startGaugeFill');

  function startRoundCountdown() {
    lockT = START_LOCK;
    syncHudGauge();
  }

  function syncHudGauge() {
    if (!startGaugeEl) return;
    const picking = !!draft && !draft.burning && !draft.revealing;
    const starting = !draft && lockT > 0 && lockT <= START_LOCK + 0.05;
    const on = picking || starting;
    startGaugeEl.classList.toggle('hidden', !on);
    const mine = picking && draft.turn === myRole;
    startGaugeEl.classList.toggle('is-wait', picking && !mine);
    if (startGaugeFill) {
      const p = picking
        ? (draft.pickT > 0 ? draft.pickT / DRAFT_PICK : 0)
        : (starting ? 1 - lockT / START_LOCK : 0);
      const k = Math.max(0, Math.min(1, p));
      startGaugeFill.style.transform = 'scaleX(' + k + ')';
    }
  }

  function resetDraftPick() {
    if (draft) draft.pickT = DRAFT_PICK;
    syncHudGauge();
  }

  function autoBanDraft() {
    if (!draft || draft.burning || draft.revealing || draft.turn !== myRole) return;
    const left = draft.ids.filter(id => !draft.banned.includes(id));
    if (!left.length) return;
    banDraftCard(left[Math.floor(Math.random() * left.length)], true);
  }
  const series = { host: 0, guest: 0 };
  const SERIES_WINS = 3;
  let matchAge = 0;
  let currentLaw = null;
  let activeLaws = [];
  let lawPinsReady = true;
  let lawCardT = 0;
  let draft = null; // { ids, banned, turn }
  const LAWS = [
    { id: 'iron', title: '무쇠 심장', text: '체력이 두 배가 된다' },
    { id: 'hat', title: '날아간 모자', text: '구르거나 점프한 직후 조준이 크게 흔들린다' },
    { id: 'sniper', title: '저격수', text: '머리를 맞출 때만 피해가 들어간다' },
    { id: 'lastshot', title: '마지막 한 발', text: '모든 탄환이 적을 크게 밀친다' },
    { id: 'chalice', title: '성배', text: '장전을 마치면 체력을 3 회복한다' },
    { id: 'twin', title: '쌍권총', text: '두 발을 연달아 쏜다' },
    { id: 'hasty', title: '성급한 손', text: '연사가 빨라진다' },
    { id: 'shackle', title: '긴 구르기', text: '구르기가 더 멀리 나간다' },
    { id: 'clumsy', title: '어설픈 회피', text: '구르기가 50% 확률로만 총알을 피한다' },
    { id: 'wings', title: '날개', text: '더 높이 뛰어오른다' },
    { id: 'glass', title: '큰 탄환', text: '총알이 커지지만 느려진다' },
    { id: 'misfire', title: '기능 고장', text: '장전할 때 3~6발만 채워진다' },
    { id: 'fate', title: '운명', text: '이 카드를 제외한 랜덤한 2장의 카드가 선택된다' },
    { id: 'laurel', title: '월계관', text: '더 빨리 달린다' },
  ];
  const LAW_ART = { twin: 'shortcyl', fate: 'bell' };
  const lawCardEl = document.getElementById('lawCard');
  const draftEl = document.getElementById('draftTable');
  const draftCardsEl = document.getElementById('draftCards');
  const draftHintEl = document.getElementById('draftHint');

  function lawArt(id) { return `assets/tarot/${LAW_ART[id] || id}.png`; }
  function lawById(id) { return LAWS.find(l => l.id === id) || null; }
  function lawIs(id) { return activeLaws.some(l => l.id === id); }
  function drafting() { return !!draft; }
  function clearLaws() { activeLaws = []; currentLaw = null; }
  function lawsKey(ids) { return (ids || []).join(','); }
  function pickFateLaws() {
    const pool = LAWS.filter(l => l.id !== 'fate').map(l => l.id);
    const ids = [];
    while (ids.length < 2 && pool.length) {
      ids.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return ids;
  }
  const burnFrames = Array.from({ length: 16 }, (_, i) => {
    const im = new Image();
    im.src = `assets/tarot/burn${i}.png?v=6`;
    return im;
  });
  const burnMeta = { w: 272, h: 487, body: { x: 46, y: 135, w: 193, h: 279 } };
  function lawMaxHp() { return lawIs('iron') ? MAX_HP * 2 : MAX_HP; }
  function lawAmmo() { return AMMO; }
  function lawReloadTime() { return RELOAD_TIME; }
  function lawCooldown() { return lawIs('hasty') ? 0.35 : 0.7; }
  function lawJump() { return lawIs('wings') ? JUMP_V * 1.25 : JUMP_V; }
  function lawRun() { return lawIs('laurel') ? RUN_SPEED * 1.25 : RUN_SPEED; }
  function lawDodgeSpeed() { return lawIs('shackle') ? DODGE_SPEED * 1.5 : DODGE_SPEED; }
  function lawBulletSpeed() { return lawIs('glass') ? BULLET_SPEED * 0.5 : BULLET_SPEED; }
  function lawBulletFat() { return lawIs('glass') ? 3 : 1; }
  function lawAimShake() { return lawIs('hat') ? 0.18 : 0.045; }

  const matchHudEl = document.getElementById('matchHud');

  function syncMatchHud() {
    if (!matchHudEl) return;
    const on = !!netReady;
    matchHudEl.classList.toggle('hidden', !on);
    matchHudEl.classList.toggle('flex', on);
    const slots = matchHudEl.querySelectorAll('[data-slot]');
    const stampOn = (el, on) => {
      if (!el) return;
      const was = el.classList.contains('on');
      el.classList.toggle('on', on);
      if (on && !was) {
        el.classList.remove('is-stamp');
        void el.offsetWidth;
        el.classList.add('is-stamp');
      }
      if (!on) el.classList.remove('is-stamp');
    };
    stampOn(slots[0], series.host >= 1);
    stampOn(slots[1], series.host >= 2);
    if (slots[2]) {
      const hostOn = series.host >= SERIES_WINS;
      const guestOn = series.guest >= SERIES_WINS;
      const wasH = slots[2].classList.contains('on-host');
      const wasG = slots[2].classList.contains('on-guest');
      slots[2].classList.toggle('on-host', hostOn);
      slots[2].classList.toggle('on-guest', guestOn);
      if ((hostOn && !wasH) || (guestOn && !wasG)) {
        slots[2].classList.remove('is-stamp');
        void slots[2].offsetWidth;
        slots[2].classList.add('is-stamp');
      }
      if (!hostOn && !guestOn) slots[2].classList.remove('is-stamp');
    }
    stampOn(slots[3], series.guest >= 2);
    stampOn(slots[4], series.guest >= 1);
    matchHudEl.querySelectorAll('.law-pins').forEach(box => {
      const mine = box.dataset.side === myRole;
      box.innerHTML = '';
      if (!mine || !activeLaws.length) return;
      activeLaws.forEach(law => {
        const pin = document.createElement('div');
        pin.className = 'law-pin pointer-events-auto relative' + (lawPinsReady ? '' : ' is-await');
        pin.innerHTML = '<img alt=""><p class="law-tip"></p>';
        const img = pin.querySelector('img');
        const tip = pin.querySelector('.law-tip');
        if (img) img.src = lawArt(law.id);
        if (tip) tip.textContent = law.text;
        box.appendChild(pin);
      });
    });
  }

  function setLaws(ids) {
    activeLaws = (ids || []).map(lawById).filter(Boolean);
    currentLaw = activeLaws[0] || null;
    const max = lawMaxHp();
    for (const pl of players) {
      pl.hp = max;
      pl.hpShow = max;
    }
    if (lawCardEl && currentLaw) {
      const text = lawCardEl.querySelector('.law-text');
      const art = lawCardEl.querySelector('#lawArt');
      if (text) text.textContent = currentLaw.text;
      if (art) art.src = lawArt(currentLaw.id);
    }
    syncMatchHud();
  }

  function setLaw(id, extraIds) {
    if (!id) { clearLaws(); syncMatchHud(); return; }
    if (id === 'fate') {
      let ids = extraIds && extraIds.length ? extraIds.slice(0, 2) : null;
      if (!ids && myRole === 'host') {
        ids = pickFateLaws();
        if (window.GunNet) GunNet.send({ t: 'laws', ids });
      }
      if (ids) setLaws(ids);
      return;
    }
    setLaws([id]);
  }

  function showLawCard() {
    if (!currentLaw || !lawCardEl) return;
    lawCardT = 2.8;
    lawCardEl.classList.add('is-up');
  }

  function hideLawCard() {
    lawCardT = 0;
    if (!lawCardEl) return;
    lawCardEl.classList.remove('is-up');
  }

  function hideDraft() {
    if (!draftEl) return;
    draftEl.classList.add('hidden');
    draftEl.classList.remove('flex', 'is-wait', 'is-reveal', 'is-fly', 'is-rising');
    draftEl.classList.add('pointer-events-none');
    draftEl.style.backgroundColor = '';
    syncHudGauge();
  }

  function syncDraftHint() {
    if (!draft || !draftEl) return;
    const mine = !draft.burning && !draft.revealing && draft.turn === myRole;
    const rising = draftEl.classList.contains('is-rising');
    draftEl.classList.remove('pointer-events-none');
    draftEl.classList.toggle('is-wait', !mine && !rising);
    if (draftHintEl) {
      draftHintEl.textContent = draft.burning ? '' : (mine ? '버릴 카드를 고르시오' : '상대가 고르는 중…');
    }
    if (!draftCardsEl) return;
    draftCardsEl.querySelectorAll('button[data-id]').forEach(btn => {
      const banned = draft.banned.includes(btn.dataset.id);
      btn.classList.toggle('pointer-events-none', banned || !mine);
    });
    syncHudGauge();
  }

  function playBurn(btn, done) {
    const slot = btn.querySelector('.card-slot');
    const face = btn.querySelector('img.card-face');
    const text = btn.querySelector('.card-text');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done();
    };
    if (!slot || !face) { finish(); return; }
    const freeze = getComputedStyle(btn);
    btn.style.transition = 'none';
    if (freeze.transform && freeze.transform !== 'none') btn.style.transform = freeze.transform;
    btn.style.filter = freeze.filter;
    btn.classList.add('is-burnt');
    const w = face.clientWidth || 200, h = face.clientHeight || 310;
    const body = burnMeta.body;
    const sx = w / body.w, sy = h / body.h;
    const left = body.x * sx, top = body.y * sy;
    const cssW = burnMeta.w * sx, cssH = burnMeta.h * sy;
    if (text) text.style.opacity = '0';
    const cvs = document.createElement('canvas');
    cvs.width = Math.max(1, Math.round(cssW));
    cvs.height = Math.max(1, Math.round(cssH));
    cvs.className = 'card-burn pointer-events-none absolute';
    cvs.style.left = -left + 'px';
    cvs.style.top = -top + 'px';
    cvs.style.width = cssW + 'px';
    cvs.style.height = cssH + 'px';
    slot.appendChild(cvs);
    const g = cvs.getContext('2d');
    const paint = (i) => {
      const burn = burnFrames[Math.min(i, burnFrames.length - 1)];
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, cvs.width, cvs.height);
      if (!burn || !burn.naturalWidth) return;
      g.drawImage(burn, 0, 0, cvs.width, cvs.height);
    };
    let frame = 0;
    const tick = () => {
      if (finished) return;
      try { paint(frame); } catch (e) {}
      if (frame === 0) face.style.visibility = 'hidden';
      frame++;
      if (frame < burnFrames.length) setTimeout(tick, 18);
      else {
        btn.style.transition = 'opacity 0.18s ease';
        btn.style.opacity = '0';
        setTimeout(finish, 180);
      }
    };
    tick();
    setTimeout(finish, 900);
  }

  function renderDraft() {
    if (!draft || !draftEl || !draftCardsEl) return;
    draftEl.classList.remove('hidden');
    draftEl.classList.add('flex', 'is-rising');
    draftEl.classList.remove('is-wait');
    draftCardsEl.innerHTML = '';
    const tilt = ['tilt-l', 'tilt-c', 'tilt-r'];
    draft.ids.forEach((id, i) => {
      const btn = makeDraftCard(id, tilt[i]);
      btn.addEventListener('click', () => banDraftCard(id, true));
      btn.addEventListener('mouseenter', () => setDraftHover(id, true));
      btn.addEventListener('mouseleave', () => setDraftHover(id, false));
      riseCard(btn, i * 90);
      draftCardsEl.appendChild(btn);
    });
    syncDraftHint();
    clearTimeout(renderDraft.riseTimer);
    renderDraft.riseTimer = setTimeout(() => {
      if (!draftEl || !draft) return;
      draftEl.classList.remove('is-rising');
      syncDraftHint();
    }, (draft.ids.length - 1) * 90 + 640);
  }

  function setDraftHover(id, on, send) {
    if (!draft || draft.burning || draft.revealing || !draftCardsEl) return;
    if (send !== false) {
      if (draft.turn !== myRole) return;
      if (window.GunNet) GunNet.send({ t: 'hover', id: on ? id : '' });
    }
    draftCardsEl.querySelectorAll('.draft-card').forEach(el => {
      el.classList.toggle('is-hover', !!(on && el.dataset.id === id));
    });
  }

  function cardBaseRect(btn) {
    const prevT = btn.style.transform;
    const prevTr = btn.style.transition;
    btn.style.transition = 'none';
    btn.style.transform = 'none';
    const r = btn.getBoundingClientRect();
    btn.style.transform = prevT;
    btn.style.transition = prevTr;
    void btn.offsetWidth;
    return r;
  }

  function myLawPins() {
    if (!matchHudEl || !myRole) return [];
    return Array.from(matchHudEl.querySelectorAll('.law-pins[data-side="' + myRole + '"] .law-pin'));
  }

  function flyCardsToPins(btns, done) {
    if (draftEl) draftEl.classList.add('is-fly', 'is-reveal');
    syncMatchHud();
    requestAnimationFrame(() => {
      const pins = myLawPins();
      btns.forEach((btn, i) => {
        if (!btn) return;
        const from = btn.getBoundingClientRect();
        const pin = pins[i] || pins[0];
        const to = pin ? pin.getBoundingClientRect() : {
          left: myRole === 'guest' ? window.innerWidth - 66 : 20,
          top: 12, width: 46, height: 70,
        };
        btn.style.position = 'fixed';
        btn.style.left = from.left + 'px';
        btn.style.top = from.top + 'px';
        btn.style.width = from.width + 'px';
        btn.style.margin = '0';
        btn.style.zIndex = '50';
        btn.style.opacity = '1';
        btn.style.filter = 'none';
        btn.style.transformOrigin = 'top left';
        btn.style.transition = 'none';
        btn.style.transform = 'none';
        const text = btn.querySelector('.card-text');
        if (text) text.style.opacity = '0';
        void btn.offsetWidth;
        const sc = to.width / Math.max(8, from.width);
        const dx = to.left - from.left;
        const dy = to.top - from.top;
        requestAnimationFrame(() => {
          btn.style.transition = 'transform 0.72s cubic-bezier(0.22, 0.9, 0.28, 1)';
          btn.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sc + ')';
        });
      });
      setTimeout(done, 780);
    });
  }

  function centerGrowCard(btn) {
    btn.style.opacity = '1';
    btn.style.filter = 'none';
    btn.classList.remove('is-hover');
    const base = cardBaseRect(btn);
    const dx = window.innerWidth / 2 - (base.left + base.width / 2);
    const dy = window.innerHeight / 2 - (base.top + base.height / 2);
    btn.style.zIndex = '8';
    btn.style.transition = 'transform 0.55s ease';
    requestAnimationFrame(() => {
      btn.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) rotate(0deg) scale(1.32)';
    });
  }

  function closeDraftAndStart(token) {
    if (draft !== token) return;
    lawPinsReady = true;
    syncMatchHud();
    draft = null;
    hideDraft();
    resetMatchSpawn();
    matchAge = 0;
    lockT = 0;
    syncHudGauge();
  }

  function riseCard(btn, delay) {
    if (!btn) return;
    let done = false;
    btn.classList.add('is-enter');
    btn.style.animationDelay = (delay || 0) + 'ms';
    const finish = () => {
      if (done) return;
      done = true;
      btn.classList.remove('is-enter');
      btn.style.animationDelay = '';
    };
    btn.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, (delay || 0) + 750);
  }

  function makeDraftCard(id, extraClass) {
    const law = lawById(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = id;
    btn.className = 'draft-card relative w-[200px] origin-center border-0 bg-transparent p-0 text-center '
      + (extraClass || '');
    btn.innerHTML = '<span class="card-slot relative block w-full">'
      + '<img class="card-face block w-full rounded-[8px] shadow-[5px_8px_0_rgba(20,10,6,0.45)]" src="'
      + lawArt(id) + '" alt="">'
      + '<span class="card-text">' + (law ? law.text : '') + '</span></span>';
    return btn;
  }

  function revealFateCards(ids) {
    if (!draft || draft.fateShown || !ids || ids.length < 2 || !draftEl) return;
    draft.fateShown = true;
    draft.pendingFateReveal = false;
    setLaws(ids);
    if (draftHintEl) draftHintEl.textContent = '';
    if (draftCardsEl) draftCardsEl.innerHTML = '';
    const w = 200, gap = 28;
    const total = w * 2 + gap;
    const left0 = window.innerWidth / 2 - total / 2;
    const top = window.innerHeight / 2 - 160;
    const btns = ids.map((id, i) => {
      const btn = makeDraftCard(id, 'is-fate');
      btn.style.position = 'fixed';
      btn.style.left = (left0 + i * (w + gap)) + 'px';
      btn.style.top = top + 'px';
      btn.style.width = w + 'px';
      btn.style.margin = '0';
      btn.style.zIndex = '50';
      btn.style.opacity = '';
      btn.style.transform = '';
      riseCard(btn, 40 + i * 90);
      draftEl.appendChild(btn);
      return btn;
    });
    const token = draft;
    setTimeout(() => flyCardsToPins(btns, () => closeDraftAndStart(token)), 2200);
  }

  function finishDraft() {
    if (!draft || draft.revealing) return;
    const remain = draft.ids.find(x => !draft.banned.includes(x));
    draft.revealing = true;
    draft.burning = true;
    if (draftHintEl) draftHintEl.textContent = '';
    if (draftEl) draftEl.classList.add('is-wait', 'is-reveal');
    const btn = draftCardsEl && draftCardsEl.querySelector('[data-id="' + remain + '"]');
    const token = draft;

    if (remain === 'fate') {
      let ids = draft.fateIds;
      if (!ids && myRole === 'host') {
        ids = pickFateLaws();
        draft.fateIds = ids;
        if (window.GunNet) GunNet.send({ t: 'laws', ids });
      }
      const afterBurn = () => {
        if (draft !== token) return;
        if (draft.fateIds && draft.fateIds.length >= 2) revealFateCards(draft.fateIds);
        else draft.pendingFateReveal = true;
      };
      if (btn) {
        centerGrowCard(btn);
        setTimeout(() => {
          if (draft !== token) return;
          playBurn(btn, afterBurn);
        }, 1400);
      } else afterBurn();
      return;
    }

    setLaw(remain);
    if (btn) {
      centerGrowCard(btn);
      setTimeout(() => flyCardsToPins([btn], () => closeDraftAndStart(token)), 2000);
    } else {
      setTimeout(() => closeDraftAndStart(token), 400);
    }
  }

  function startDraft(ids, turn) {
    const picked = ids ? ids.slice() : [];
    if (!picked.length) {
      const pool = LAWS.map(l => l.id);
      while (picked.length < 3) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const first = turn === 'host' || turn === 'guest'
      ? turn
      : (ids ? 'host' : (Math.random() < 0.5 ? 'host' : 'guest'));
    draft = { ids: picked, banned: [], turn: first, burning: false, pickT: DRAFT_PICK };
    hideLawCard();
    clearLaws();
    lawPinsReady = false;
    syncMatchHud();
    renderDraft();
    if (!ids && window.GunNet) GunNet.send({ t: 'draft', ids: picked, turn: first });
  }

  function banDraftCard(id, send) {
    if (!draft || draft.burning || draft.banned.includes(id) || !draft.ids.includes(id)) return;
    if (send && draft.turn !== myRole) return;
    draft.banned.push(id);
    draft.burning = true;
    setDraftHover('', false, false);
    syncDraftHint();
    syncHudGauge();
    if (send && window.GunNet) GunNet.send({ t: 'ban', id });
    const btn = draftCardsEl && draftCardsEl.querySelector('[data-id="' + id + '"]');
    const after = () => {
      if (!draft) return;
      draft.burning = false;
      if (draft.banned.length >= 2) { finishDraft(); return; }
      draft.turn = draft.turn === 'host' ? 'guest' : 'host';
      resetDraftPick();
      syncDraftHint();
    };
    if (btn) playBurn(btn, after);
    else after();
  }
  const board = { x: 0, y: 0, open: false, near: false, status: '', h: 148, w: 228 };
  let viewZ = 1, viewZX = W * 0.5, viewZY = H * 0.5;
  const wantedStatusEl = document.getElementById('wantedStatus');
  const wantedBoardEl = document.getElementById('wantedBoard');
  const wantedNoticeEl = document.getElementById('wantedNotice');
  const swalWanted = {
    customClass: { popup: 'swal-wanted' },
    background: '#ead6b4',
    color: '#3d2a1c',
    buttonsStyling: true,
    showClass: { popup: 'swal2-show' },
    hideClass: { popup: 'swal2-hide' },
  };

  function setPortalStatus(msg) {
    board.status = msg || '';
    const m = board.status.match(/수배 번호:\s*(\d{4})/);
    const hosting = !!(m && !netReady);
    if (wantedBoardEl) wantedBoardEl.classList.toggle('is-hosting', hosting);
    const codeEl = document.getElementById('wantedCode');
    if (codeEl) codeEl.textContent = m ? m[1] : '';
    if (hosting) {
      const hostSub = wantedBoardEl && wantedBoardEl.querySelector('.wanted-wait .wanted-wait-sub');
      if (hostSub) hostSub.textContent = '현상금 사냥꾼 대기 중';
    }
    if (wantedBoardEl && wantedBoardEl.classList.contains('is-seeking')) {
      const sub = document.getElementById('wantedSeekSub');
      if (sub) {
        const fail = !!(msg && (msg.indexOf('찾을 수 없') >= 0 || msg === '연결 끊김'));
        sub.textContent = fail ? msg : '연결 중…';
      }
    }
    if (wantedStatusEl) {
      wantedStatusEl.classList.remove('show', 'update');
      wantedStatusEl.innerHTML = '';
    }
  }

  function cancelWantedLobby() {
    const fromMatch = netReady;
    const onBoard = viewingBoard();
    if (window.GunNet) GunNet.cancel();
    clearTimeout(nextRoundTimer);
    hideLawCard();
    hideDraft();
    if (window.Swal && Swal.isVisible()) Swal.close();
    setPortalStatus('');
    const finish = () => {
      hideWantedBoard();
      snapViewRest();
      myRole = null;
      other = null;
      netReady = false;
      matchOver = false;
      overOpen = false;
      myRematch = false;
      otherRematch = false;
      lockT = 0;
      matchAge = 0;
      clearLaws();
      draft = null;
      series.host = 0;
      series.guest = 0;
      syncMatchHud();
      syncHudGauge();
      me = players[0];
      if (fromMatch) {
        useTownMap();
        resetMatchSpawn();
        me.x = W * 0.28;
        me.y = groundAt(me.x);
        me.facing = 1;
      }
    };
    if (fromMatch || onBoard) playWipe(finish);
    else finish();
  }

  if (wantedStatusEl) {
    wantedStatusEl.addEventListener('click', e => {
      if (e.target && e.target.classList && e.target.classList.contains('close')) {
        cancelWantedLobby();
      }
    });
  }

  const titleEl = document.getElementById('titleCard');
  let titleShown = true;

  function syncTitle() {
    if (!titleEl) return;
    const show = !netReady && !board.status && !board.open;
    if (show === titleShown) return;
    titleShown = show;
    titleEl.classList.toggle('opacity-0', !show);
  }

  function placePortal() {
    board.x = W * 0.62;
    board.y = groundAt(board.x);
  }

  function viewingBoard() {
    return !!board.open;
  }

  function wantedLayout() {
    const gy = groundAt(board.x);
    const x = board.x;
    const boardImg = IMG.wantedBoard;
    const bw = board.w;
    const boardH = boardImg && boardImg.width
      ? boardImg.height * (bw / boardImg.width)
      : Math.round(bw * 0.65);
    const boardTop = gy - boardH;
    const posters = [
      { key: 'multi', l: 0.172, t: 0.175, w: 0.250, h: 0.485, rot: -10.5 },
      { key: 'ai', l: 0.400, t: 0.186, w: 0.208, h: 0.478, rot: 4.2 },
      { key: 'train', l: 0.606, t: 0.155, w: 0.212, h: 0.462, rot: 9.8 },
    ].map(p => ({
      key: p.key,
      x: x - bw / 2 + (p.l + p.w * 0.5) * bw,
      y: boardTop + (p.t + p.h * 0.5) * boardH,
      w: p.w * bw,
      h: p.h * boardH,
      rot: p.rot,
    }));
    return { x, y: boardTop + boardH * 0.42, top: boardTop, w: bw, h: boardH, posters };
  }

  function worldToScreen(wx, wy) {
    return {
      x: (wx - viewZX) * viewZ + W / 2,
      y: (wy - viewZY) * viewZ + H / 2,
    };
  }

  function layoutWantedHotspots() {
    if (!viewingBoard()) return;
    const lay = wantedLayout();
    const ready = boardZoomT() >= 0.88;
    if (wantedBoardEl) wantedBoardEl.classList.toggle('is-ready', ready);
    const boardTL = worldToScreen(lay.x - lay.w / 2, lay.top);
    const boardSW = lay.w * viewZ;
    const boardSH = lay.h * viewZ;
    wantedBoardEl.querySelectorAll('.wanted-blank').forEach(el => {
      el.style.left = boardTL.x + 'px';
      el.style.top = boardTL.y + 'px';
      el.style.width = boardSW + 'px';
      el.style.height = boardSH + 'px';
    });
    lay.posters.forEach(p => {
      const el = wantedBoardEl.querySelector('[data-sheet="' + p.key + '"]');
      if (!el) return;
      const c = worldToScreen(p.x, p.y);
      const pw = p.w * viewZ;
      const ph = p.h * viewZ;
      el.style.left = (c.x - pw / 2) + 'px';
      el.style.top = (c.y - ph / 2) + 'px';
      el.style.width = pw + 'px';
      el.style.height = ph + 'px';
      el.style.transform = 'rotate(' + (p.rot || 0) + 'deg)';
    });
    const hint = wantedBoardEl.querySelector('.wanted-hint');
    if (hint) {
      const c = worldToScreen(lay.x, lay.top + lay.h * 0.93);
      hint.style.left = c.x + 'px';
      hint.style.top = c.y + 'px';
    }
  }

  function syncViewCam(dt) {
    const restX = W * 0.5, restY = H * 0.5;
    if (!viewZX && !viewZY) { viewZX = restX; viewZY = restY; }
    const on = viewingBoard();
    const lay = wantedLayout();
    const zTo = on ? clamp(Math.min((W * 0.78) / lay.w, (H * 0.84) / lay.h), 2.2, 5.2) : 1;
    const xTo = on ? lay.x : restX;
    const yTo = on ? lay.y : restY;
    const k = 1 - Math.pow(0.004, dt);
    viewZ = lerp(viewZ, zTo, k);
    viewZX = lerp(viewZX, xTo, k);
    viewZY = lerp(viewZY, yTo, k);
    layoutWantedHotspots();
  }

  function snapViewRest() {
    viewZ = 1;
    viewZX = W * 0.5;
    viewZY = H * 0.5;
  }

  function boardZoomT() {
    const lay = wantedLayout();
    const zMax = clamp(Math.min((W * 0.78) / lay.w, (H * 0.84) / lay.h), 2.2, 5.2);
    return clamp((viewZ - 1) / Math.max(0.01, zMax - 1), 0, 1);
  }

  function hideWantedOverlay() {
    if (!wantedBoardEl) return;
    wantedBoardEl.classList.remove('is-on', 'is-ready', 'is-joining', 'is-seeking', 'is-hosting');
    wantedBoardEl.querySelectorAll('.wanted-sheet.is-open').forEach(el => el.classList.remove('is-open'));
  }

  function hideWantedBoard() {
    hideWantedOverlay();
    if (wantedNoticeEl) wantedNoticeEl.classList.remove('is-on');
    if (!window.Swal || !Swal.isVisible()) board.open = false;
    const joinInput = document.getElementById('wantedJoinCode');
    if (joinInput) joinInput.value = '';
    syncTitle();
  }

  function showBoardNotice(msg) {
    if (!wantedNoticeEl) return;
    wantedNoticeEl.textContent = msg;
    wantedNoticeEl.classList.add('is-on');
    clearTimeout(showBoardNotice.timer);
    showBoardNotice.timer = setTimeout(() => wantedNoticeEl.classList.remove('is-on'), 1800);
  }

  function showWantedBoard() {
    if (netReady) return;
    board.open = true;
    if (wantedNoticeEl) wantedNoticeEl.classList.remove('is-on');
    if (wantedBoardEl) wantedBoardEl.classList.add('is-on');
    syncTitle();
  }

  function closeJoinOnPaper() {
    if (wantedBoardEl) wantedBoardEl.classList.remove('is-joining', 'is-seeking');
    const input = document.getElementById('wantedJoinCode');
    if (input) input.value = '';
  }

  function cancelJoinSeek() {
    if (window.GunNet) GunNet.cancel();
    myRole = null;
    other = null;
    netReady = false;
    awaitMap = false;
    pendingArena = null;
    if (!wantedBoardEl) return;
    wantedBoardEl.classList.remove('is-seeking');
    wantedBoardEl.classList.add('is-joining');
    const sub = document.getElementById('wantedSeekSub');
    if (sub) sub.textContent = '연결 중…';
    const input = document.getElementById('wantedJoinCode');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 40);
    }
  }

  function tryJoinCode(raw) {
    if (netReady) return false;
    if (wantedBoardEl && wantedBoardEl.classList.contains('is-seeking')) return false;
    const n = String(raw || '').replace(/\D/g, '').slice(0, 4);
    if (n.length !== 4) return false;
    if (wantedBoardEl) {
      wantedBoardEl.classList.remove('is-joining');
      wantedBoardEl.classList.add('is-seeking');
    }
    const codeEl = document.getElementById('wantedSeekCode');
    if (codeEl) codeEl.textContent = n;
    const sub = document.getElementById('wantedSeekSub');
    if (sub) sub.textContent = '연결 중…';
    GunNet.join(n);
    return true;
  }

  function openJoinOnPaper() {
    if (netReady || !wantedBoardEl) return;
    wantedBoardEl.classList.add('is-joining');
    const input = document.getElementById('wantedJoinCode');
    if (!input) return;
    input.value = '';
    setTimeout(() => input.focus(), 40);
  }

  function openWantedMenu() {
    if (netReady) return;
    if (wantedBoardEl && wantedBoardEl.classList.contains('is-on')) {
      hideWantedBoard();
      return;
    }
    if (board.open) return;
    showWantedBoard();
  }

  if (wantedBoardEl) {
    wantedBoardEl.addEventListener('click', e => {
      const sheet = e.target && e.target.closest ? e.target.closest('.wanted-sheet') : null;
      if (sheet && !(e.target.closest && e.target.closest('[data-act], input, button'))) {
        wantedBoardEl.querySelectorAll('.wanted-sheet.is-open').forEach(el => {
          if (el !== sheet) el.classList.remove('is-open');
        });
        sheet.classList.add('is-open');
      }
      const act = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      const which = act && act.dataset ? act.dataset.act : (e.target.classList && e.target.classList.contains('wanted-dim') ? 'close' : '');
      if (which === 'close') {
        if (wantedBoardEl.classList.contains('is-seeking')) {
          if (window.GunNet) GunNet.cancel();
          myRole = null;
          other = null;
          netReady = false;
          awaitMap = false;
          pendingArena = null;
        }
        if (wantedBoardEl.classList.contains('is-hosting') || wantedBoardEl.classList.contains('is-seeking')) {
          cancelWantedLobby();
        } else {
          hideWantedBoard();
        }
      }
      else if (which === 'host') {
        bindRoles('host');
        GunNet.host();
      } else if (which === 'join') openJoinOnPaper();
      else if (which === 'join-back') closeJoinOnPaper();
      else if (which === 'join-cancel') cancelJoinSeek();
      else if (which === 'ai') showBoardNotice('아직 현상금이 붙지 않았소');
      else if (which === 'train') hideWantedBoard();
      else if (which === 'cancel') cancelWantedLobby();
    });
    const joinInput = document.getElementById('wantedJoinCode');
    if (joinInput) {
      const onType = () => {
        const digits = String(joinInput.value || '').replace(/\D/g, '').slice(0, 4);
        if (joinInput.value !== digits) joinInput.value = digits;
        if (digits.length === 4) tryJoinCode(digits);
      };
      joinInput.addEventListener('input', onType);
      joinInput.addEventListener('keyup', onType);
      joinInput.addEventListener('paste', () => setTimeout(onType, 0));
    }
  }

  function setPortalOpen(v) {
    if (v) showWantedBoard();
    else {
      if (window.Swal) Swal.close();
      hideWantedBoard();
    }
  }

  // ---------- 입력 ----------
  const keys = {};
  const mouse = { x: W * 0.7, y: H * 0.6, down: false };
  let usingTouch = false;
  const stick = { id: null, x0: 0, y0: 0, x: 0, y: 0, t0: 0, jumped: false };
  const firePtr = { id: null };

  addEventListener('keydown', e => {
    if (e.repeat || !me) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    usingTouch = false;
    keys[e.code] = true;
    if (e.code === 'Escape' && board.open) {
      if (wantedBoardEl && wantedBoardEl.classList.contains('is-seeking')) {
        cancelJoinSeek();
        return;
      }
      if (wantedBoardEl && wantedBoardEl.classList.contains('is-joining')) {
        closeJoinOnPaper();
        return;
      }
      if (wantedBoardEl && wantedBoardEl.classList.contains('is-hosting')) {
        cancelWantedLobby();
        return;
      }
      setPortalOpen(false);
      return;
    }
    if (e.code === 'KeyE' && board.near && !netReady) {
      openWantedMenu();
      e.preventDefault();
      return;
    }
    if (locked()) return;
    if (e.code === 'Space' || e.code === 'KeyW') {
      me.jumpQueued = 0.12;
      e.preventDefault();
    }
    if (e.code === 'KeyR') startReload(me);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') startDodge(me, moveDir());
  });
  addEventListener('keyup', e => { keys[e.code] = false; });

  function screenToWorld(sx, sy) {
    const z = viewZ || 1;
    return {
      x: (sx - W / 2) / z + viewZX,
      y: (sy - H / 2) / z + viewZY,
    };
  }

  function tapOnWanted(sx, sy) {
    if (netReady || board.open) return false;
    const w = screenToWorld(sx, sy);
    const lay = wantedLayout();
    return Math.abs(w.x - lay.x) < lay.w * 0.55 && w.y > lay.top - 40 && w.y < lay.top + lay.h + 24;
  }

  function snapAim(sx, sy) {
    mouse.x = sx;
    mouse.y = sy;
    if (!me) return;
    const ax = sx + camX, ay = sy;
    if (ax > me.x + 6) me.facing = 1;
    else if (ax < me.x - 6) me.facing = -1;
    if (me.shoulder) me.aim = aimRotation(me.shoulder.x, me.shoulder.y, me.facing, ax, ay);
  }

  function endStick(e) {
    if (stick.id == null || e.pointerId !== stick.id) return;
    const dt = (performance.now() - stick.t0) / 1000;
    const dx = (e.clientX != null ? e.clientX : stick.x) - stick.x0;
    const dy = (e.clientY != null ? e.clientY : stick.y) - stick.y0;
    const dist = Math.hypot(dx, dy);
    stick.id = null;
    if (!me) return;
    if (dist < 22 && dt < 0.32 && !netReady && board.near) {
      openWantedMenu();
      return;
    }
    if (locked()) return;
    if (dt < 0.28 && dist > 40) {
      if (dy < -40 && -dy >= Math.abs(dx) * 0.62) me.jumpQueued = 0.12;
      else if (Math.abs(dx) > 26) startDodge(me, dx > 0 ? 1 : -1);
      else if (dy < -28) me.jumpQueued = 0.12;
    }
  }

  cvs.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      usingTouch = true;
      if (board.open || drafting()) return;
      e.preventDefault();
      const x = e.clientX, y = e.clientY;
      if (x < W * 0.5 && stick.id == null) {
        stick.id = e.pointerId;
        stick.x0 = stick.x = x;
        stick.y0 = stick.y = y;
        stick.t0 = performance.now();
        stick.jumped = false;
        try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
        return;
      }
      if (x >= W * 0.5 && firePtr.id == null) {
        firePtr.id = e.pointerId;
        snapAim(x, y);
        try { cvs.setPointerCapture(e.pointerId); } catch (err) {}
        if (!netReady && (board.near && tapOnWanted(x, y))) {
          openWantedMenu();
          return;
        }
        if (me && !board.open && !locked()) tryFire(me);
      }
      return;
    }
    usingTouch = false;
    if (e.button === 0) {
      mouse.down = true;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      if (me && !board.open && !locked()) tryFire(me);
    }
  }, { passive: false });

  cvs.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      if (e.pointerId === firePtr.id) {
        snapAim(e.clientX, e.clientY);
        return;
      }
      if (e.pointerId !== stick.id) return;
      e.preventDefault();
      stick.x = e.clientX;
      stick.y = e.clientY;
      const dx = stick.x - stick.x0, dy = stick.y - stick.y0;
      if (!stick.jumped && dy < -72 && -dy > Math.abs(dx) * 0.75) {
        stick.jumped = true;
        if (me && !locked()) me.jumpQueued = 0.12;
      }
      return;
    }
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }, { passive: false });

  function onPtrEnd(e) {
    if (e.pointerId === firePtr.id) firePtr.id = null;
    endStick(e);
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') mouse.down = false;
  }
  cvs.addEventListener('pointerup', onPtrEnd);
  cvs.addEventListener('pointercancel', onPtrEnd);
  cvs.addEventListener('contextmenu', e => e.preventDefault());

  function moveDir() {
    const k = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    if (k) return k;
    if (stick.id != null) {
      const dx = stick.x - stick.x0;
      if (dx > 22) return 1;
      if (dx < -22) return -1;
    }
    return 0;
  }

  function playAim() {
    if (usingTouch && firePtr.id != null) return { x: mouse.x + camX, y: mouse.y };
    if (usingTouch && other && netReady) return { x: other.x, y: other.y - BODY_H * 0.55 };
    return { x: mouse.x + camX, y: mouse.y };
  }

  function locked() {
    return !me || lockT > 0 || me.hp <= 0 || drafting() || overOpen || wiping()
      || !!board.open;
  }

  function clearInputs() {
    for (const k of Object.keys(keys)) keys[k] = false;
    mouse.down = false;
    stick.id = null;
    firePtr.id = null;
    for (const pl of players) {
      pl.vx = 0; pl.vy = 0; pl.jumpQueued = 0; pl.dodgeT = 0;
    }
  }

  // ---------- 플레이어 ----------
  function makePlayer(id, skin) {
    return {
      id, skin,
      x: 0, y: 0, vx: 0, vy: 0, onGround: true, init: false,
      facing: 1, aim: 0,
      runPhase: 0, airT: 0, landT: 0,
      squash: 0, squashV: 0, kick: 0, kickV: 0,
      ammo: AMMO, reloadT: 0, autoReload: 0, cooldown: 0, flashT: 0, burstT: 0,
      dodgeT: 0, dodgeDir: 1, dodgeCD: 0,
      shoulder: { x: 0, y: 0 }, muzzle: { x: 0, y: 0 },
      hp: MAX_HP, hpShow: MAX_HP, hpDrain: 1, invuln: 0, jumpQueued: 0,
      hatT: 0, bellNext: false, dodgeSafe: true, reloadMax: RELOAD_TIME, reloadTo: AMMO,
    };
  }
  const players = [makePlayer(0, 'host'), makePlayer(1, 'guest')];
  me = players[0];

  function bindRoles(role) {
    myRole = role;
    me = role === 'host' ? players[0] : players[1];
    other = role === 'host' ? players[1] : players[0];
  }

  function spawnXs() {
    return [W * 0.22, W * 0.78];
  }

  function resetMatchSpawn() {
    const [sx0, sx1] = spawnXs();
    players[0].x = sx0;
    players[0].y = groundAt(sx0);
    players[0].vx = 0; players[0].vy = 0;
    players[0].facing = 1;
    players[0].onGround = true;
    players[0].init = true;
    players[0].hp = lawMaxHp(); players[0].hpShow = players[0].hp;
    players[0].ammo = lawAmmo(); players[0].reloadT = 0;
    players[0].invuln = 0; players[0].dodgeT = 0; players[0].burstT = 0;
    players[0].hatT = 0; players[0].bellNext = false;
    players[0].dodgeSafe = true; players[0].reloadMax = lawReloadTime();
    players[0].reloadTo = lawAmmo();
    players[0].net = null;

    players[1].x = sx1;
    players[1].y = groundAt(sx1);
    players[1].vx = 0; players[1].vy = 0;
    players[1].facing = -1;
    players[1].onGround = true;
    players[1].init = true;
    players[1].hp = lawMaxHp(); players[1].hpShow = players[1].hp;
    players[1].ammo = lawAmmo(); players[1].reloadT = 0;
    players[1].invuln = 0; players[1].dodgeT = 0; players[1].burstT = 0;
    players[1].hatT = 0; players[1].bellNext = false;
    players[1].dodgeSafe = true; players[1].reloadMax = lawReloadTime();
    players[1].reloadTo = lawAmmo();
    players[1].net = null;
    players[0].jumpQueued = 0;
    players[1].jumpQueued = 0;
    matchOver = false;
    overOpen = false;
    bullets.length = 0;
  }

  function packState(pl) {
    return {
      t: 'state',
      x: pl.x, y: pl.y, vx: pl.vx, vy: pl.vy,
      facing: pl.facing, aim: pl.aim, onGround: pl.onGround,
      runPhase: pl.runPhase, airT: pl.airT, landT: pl.landT,
      squash: pl.squash, kick: pl.kick,
      ammo: pl.ammo, reloadT: pl.reloadT, autoReload: pl.autoReload,
      cooldown: pl.cooldown, flashT: pl.flashT,
      dodgeT: pl.dodgeT, dodgeDir: pl.dodgeDir, dodgeCD: pl.dodgeCD,
      hp: pl.hp, invuln: pl.invuln, reloadMax: pl.reloadMax,
      law: currentLaw ? currentLaw.id : '',
      laws: activeLaws.map(l => l.id).join(','),
    };
  }

  function applyRemoteState(pl, s) {
    if (typeof s.hp === 'number' && pl.hpShow != null && pl.hpShow - s.hp >= DMG_HEAD - 0.1) {
      pl.hpDrain = 3;
    }
    if (typeof s.hp === 'number') pl.hp = s.hp;
    const remoteLaws = s.laws ? String(s.laws).split(',').filter(Boolean) : (s.law ? [s.law] : []);
    if (remoteLaws.length && lawsKey(remoteLaws) !== lawsKey(activeLaws.map(l => l.id))) {
      if (draft && draft.revealing) {
        draft.fateIds = remoteLaws;
        if (draft.pendingFateReveal) revealFateCards(remoteLaws);
      } else {
        setLaws(remoteLaws);
        if (lockT > 0) { resetMatchSpawn(); showLawCard(); }
      }
    }
    pl.net = {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      facing: s.facing, aim: s.aim, onGround: s.onGround,
      airT: s.airT, landT: s.landT,
      squash: s.squash, kick: s.kick,
      ammo: s.ammo, reloadT: s.reloadT, autoReload: s.autoReload,
      cooldown: s.cooldown, flashT: s.flashT,
      dodgeT: s.dodgeT, dodgeDir: s.dodgeDir, dodgeCD: s.dodgeCD,
      invuln: s.invuln, age: 0,
    };
    if (typeof s.reloadMax === 'number') pl.reloadMax = s.reloadMax;
    if (!pl.init) {
      pl.x = s.x; pl.y = s.y; pl.vx = s.vx; pl.vy = s.vy;
      pl.facing = s.facing; pl.aim = s.aim;
      pl.init = true;
    }
  }

  function updateRemote(pl, dt) {
    const s = pl.net;
    if (!s) return;
    s.age += dt;
    const look = Math.min(s.age, 0.14);
    const tx = s.x + (s.vx || 0) * look;
    const k = 1 - Math.pow(0.00035, dt);
    pl.x = lerp(pl.x, tx, k);
    pl.vx = lerp(pl.vx, s.vx || 0, k);
    pl.facing = s.facing;
    if (typeof s.aim === 'number') pl.aim += angDiff(s.aim, pl.aim) * Math.min(1, dt * 18);
    pl.dodgeDir = s.dodgeDir;
    pl.ammo = s.ammo;
    pl.reloadT = Math.max(0, (s.reloadT || 0) - s.age);
    pl.autoReload = s.autoReload;
    pl.cooldown = (s.cooldown || 0) - s.age;
    pl.flashT = (s.flashT || 0) - s.age;
    pl.dodgeT = Math.max(0, (s.dodgeT || 0) - s.age);
    pl.dodgeCD = (s.dodgeCD || 0) - s.age;
    pl.invuln = Math.max(0, (s.invuln || 0) - s.age);
    pl.kick = lerp(pl.kick, s.kick || 0, k);

    const gy = groundAt(pl.x);
    if (s.onGround) {
      if (pl.y < gy - 5) {
        pl.vy = Math.max(pl.vy + 2300 * dt, 520);
        pl.y += pl.vy * dt;
        if (pl.y >= gy) {
          pl.y = gy;
          pl.vy = 0;
          pl.onGround = true;
          pl.landT = 0.12;
          pl.squashV += 2.2;
        } else {
          pl.onGround = false;
          pl.airT += dt;
          pl.landT = 0;
        }
      } else {
        pl.y = gy;
        pl.vy = 0;
        pl.onGround = true;
        pl.landT = (s.landT || 0) - s.age;
      }
    } else {
      const ty = s.y + (s.vy || 0) * look + 0.5 * 2300 * look * look;
      const tvy = (s.vy || 0) + 2300 * look;
      if (pl.onGround) {
        pl.y = ty;
        pl.vy = tvy;
        pl.squashV -= 2.2;
        pl.airT = s.airT || 0;
      } else {
        pl.vy += 2300 * dt;
        pl.y += pl.vy * dt;
        const ck = 1 - Math.pow(0.012, dt);
        pl.y = lerp(pl.y, ty, ck);
        pl.vy = lerp(pl.vy, tvy, ck);
      }
      pl.onGround = false;
      pl.airT = (s.airT || 0) + s.age;
      pl.landT = 0;
    }
    pl.squashV += (-300 * pl.squash - 18 * pl.squashV) * dt;
    pl.squash += pl.squashV * dt;
    if (pl.onGround) pl.runPhase += Math.abs(pl.vx) * dt / RUN_STRIDE;
    if (pl.y > gy) { pl.y = gy; pl.onGround = true; }
  }

  function onNetMessage(data) {
    if (!data) return;
    if (data.t === 'map') {
      pendingArena = data.id;
      if (data.seed != null) pendingSeed = data.seed;
      if (wiping() && !wipe.hitMid) return;
      if (data.seed != null) obstacleSeed = data.seed;
      if (netReady && awaitMap) {
        awaitMap = false;
        beginRound(true);
      } else if (netReady) {
        awaitMap = false;
        setArenaMap(data.id);
        pendingArena = null;
        pendingSeed = null;
        snapToGround();
      }
      return;
    }
    if (!other) return;
    if (data.t === 'state') {
      applyRemoteState(other, data);
      maybeGameOver();
    } else if (data.t === 'fire') {
      bullets.push({
        x: data.x, y: data.y, vx: data.vx, vy: data.vy,
        life: 1.2, ownerId: data.ownerId, net: true, fat: data.fat || 1,
      });
      flashes.push({ x: data.x, y: data.y, t: 0 });
    } else if (data.t === 'hurt') {
      if (typeof data.hp === 'number') {
        if (other.hpShow != null && other.hpShow - data.hp >= DMG_HEAD - 0.1) other.hpDrain = 3;
        else if (data.head) other.hpDrain = 3;
        other.hp = data.hp;
        other.invuln = Math.max(other.invuln || 0, INVULN_TIME);
      }
      maybeGameOver();
    } else if (data.t === 'over') {
      if (other) other.hp = 0;
      maybeGameOver();
    } else if (data.t === 'nextround') {
      clearTimeout(nextRoundTimer);
      beginRound(false);
    } else if (data.t === 'rematch') {
      if (seriesOver()) return;
      otherRematch = true;
      if (myRematch) beginRound(seriesOver());
      else refreshOverDialog();
    } else if (data.t === 'law') {
      setLaw(data.id, data.ids);
      if (lockT > 0) resetMatchSpawn();
      showLawCard();
    } else if (data.t === 'laws') {
      if (draft && draft.revealing) {
        draft.fateIds = data.ids || [];
        if (draft.pendingFateReveal) revealFateCards(draft.fateIds);
      } else {
        setLaws(data.ids || []);
        if (lockT > 0) resetMatchSpawn();
      }
    } else if (data.t === 'draft') {
      startDraft(data.ids, data.turn);
    } else if (data.t === 'ban') {
      banDraftCard(data.id, false);
    } else if (data.t === 'hover') {
      setDraftHover(data.id, !!data.id, false);
    }
  }

  function maybeGameOver() {
    if (!netReady || matchOver) return;
    if (me.hp > 0 && (!other || other.hp > 0)) return;
    matchOver = true;
    myRematch = false;
    otherRematch = false;
    const win = me.hp > 0;
    lastOverWin = win;
    const winner = win ? myRole : (myRole === 'host' ? 'guest' : 'host');
    if (winner === 'host' || winner === 'guest') series[winner] += 1;
    syncMatchHud();
    if (me.hp <= 0 && window.GunNet) GunNet.send({ t: 'over', loser: me.id });
    if (seriesOver()) queueReturnTown();
    else queueNextRound();
  }

  function seriesOver() { return series.host >= SERIES_WINS || series.guest >= SERIES_WINS; }

  let nextRoundTimer = 0;
  function queueReturnTown() {
    clearTimeout(nextRoundTimer);
    nextRoundTimer = setTimeout(() => {
      if (!netReady || !seriesOver()) return;
      cancelWantedLobby();
    }, 1200);
  }
  function queueNextRound() {
    clearTimeout(nextRoundTimer);
    const host = myRole === 'host';
    nextRoundTimer = setTimeout(() => {
      if (!netReady || seriesOver() || !matchOver) return;
      if (host && window.GunNet) GunNet.send({ t: 'nextround' });
      beginRound(false);
    }, host ? 1500 : 2200);
  }

  function overCopy() {
    const score = series.host + ' — ' + series.guest;
    const done = seriesOver();
    const title = done
      ? (lastOverWin ? '결투 승리' : '게임 오버')
      : (lastOverWin ? '판 승리' : '판 패배');
    if (myRematch && !otherRematch) return { title, text: '상대의 동의를 기다리는 중…' };
    if (!myRematch && otherRematch) return { title, text: '상대가 다음 판을 기다립니다' };
    return { title, text: done ? '5판 3선  ' + score : score };
  }

  function refreshOverDialog() {
    if (!overOpen || !window.Swal || !Swal.isVisible()) return;
    const c = overCopy();
    Swal.update({
      title: c.title,
      text: c.text,
      showConfirmButton: !myRematch,
      confirmButtonText: '다시 결투',
      showDenyButton: true,
      denyButtonText: '마을로',
    });
  }

  function showGameOver(win) {
    lastOverWin = win;
    if (overOpen || !window.Swal || !matchOver) return;
    overOpen = true;
    const c = overCopy();
    Swal.fire({
      ...swalWanted,
      title: c.title,
      text: c.text,
      showDenyButton: true,
      showCancelButton: false,
      showConfirmButton: !myRematch,
      confirmButtonText: '다시 결투',
      denyButtonText: '마을로',
      allowOutsideClick: false,
      allowEscapeKey: false,
    }).then(res => {
      if (res.isConfirmed) requestRematch();
      else if (res.isDenied) cancelWantedLobby();
      else overOpen = false;
    });
  }

  function requestRematch() {
    myRematch = true;
    if (window.GunNet) GunNet.send({ t: 'rematch' });
    if (otherRematch) beginRound(seriesOver());
    else {
      overOpen = false;
      showGameOver(lastOverWin);
    }
  }

  function beginRound(fresh) {
    clearTimeout(nextRoundTimer);
    hideWantedOverlay();
    playWipe(() => applyBeginRound(fresh));
  }

  function applyBeginRound(fresh) {
    myRematch = false;
    otherRematch = false;
    matchOver = false;
    overOpen = false;
    if (fresh) {
      series.host = 0;
      series.guest = 0;
      clearLaws();
      hideLawCard();
    }
    if (window.Swal && Swal.isVisible()) Swal.close();
    hideWantedBoard();
    snapViewRest();
    if (myRole === 'host' && netReady) broadcastMap();
    else if (pendingArena) {
      if (pendingSeed != null) obstacleSeed = pendingSeed;
      setArenaMap(pendingArena);
      pendingArena = null;
      pendingSeed = null;
    }
    resetMatchSpawn();
    matchAge = 0;
    syncMatchHud();
    if (fresh || !activeLaws.length) {
      lockT = 99;
      if (myRole === 'host') startDraft();
    } else {
      startRoundCountdown();
    }
  }

  if (window.GunNet) {
    GunNet.setHandlers({
      status: setPortalStatus,
      ready: role => {
        bindRoles(role);
        netReady = true;
        beginRound(true);
        if (role !== 'host' && !pendingArena) awaitMap = true;
      },
      message: onNetMessage,
    });
  }

  const bullets = [], particles = [], flashes = [], targets = [];
  const tumble = { active: false, x: 0, vx: 0, rot: 0, t: 0, timer: 2 };
  let shake = 0, camX = 0, headFlash = 0;

  function layoutTargets() {
    targets.length = 0;
    if (IMG.bg && IMG.bg.width) return; // 고정 배경에선 유리병 히트박스 없음
    const gy = groundY(), m = PR.meta.bench;
    for (const [name, x, h, lift = 0, extra] of LAYOUT.back) {
      if (extra !== 'bottles') continue;
      const w = m.w * h / m.h, top = gy - 4 - lift - h * BENCH_TOP;
      [-0.28, 0, 0.28].forEach((f, i) => targets.push({
        x: x + f * w, y: top, alive: true, respawn: 0, pop: 1, color: i % 2 ? '#7a5234' : '#4f7a4a',
      }));
    }
  }
  addEventListener('resize', () => {
    if (!GG) return;
    layoutTargets();
    placePortal();
    snapToGround();
    if (viewingBoard()) {
      const lay = wantedLayout();
      viewZX = lay.x;
      viewZY = lay.y;
      viewZ = clamp(Math.min((W * 0.78) / lay.w, (H * 0.84) / lay.h), 2.2, 5.2);
    } else {
      viewZ = 1;
      viewZX = W * 0.5;
      viewZY = H * 0.5;
    }
  });

  function startReload(pl) {
    if (locked()) return;
    if (pl.reloadT > 0 || pl.ammo >= lawAmmo()) return;
    const full = lawAmmo();
    pl.reloadTo = lawIs('misfire') ? Math.min(full, 3 + Math.floor(Math.random() * 4)) : full;
    pl.reloadMax = lawReloadTime();
    pl.reloadT = pl.reloadMax;
  }

  function startDodge(pl, moveDir) {
    if (locked()) return;
    if (pl.dodgeT > 0 || pl.dodgeCD > 0 || !pl.onGround) return;
    pl.dodgeDir = moveDir || pl.facing;
    pl.dodgeT = DODGE_TIME;
    pl.dodgeCD = 1;
    pl.dodgeSafe = lawIs('clumsy') ? Math.random() < 0.5 : true;
    pl.vx = pl.dodgeDir * lawDodgeSpeed();
    dust(pl.x, pl.y, 6);
  }

  function fireShot(pl) {
    if (pl.ammo <= 0 || pl.reloadT > 0) return;
    pl.ammo -= 1;
    const airborne = !pl.onGround;
    pl.kickV += airborne ? 48 : 34;
    pl.flashT = 0.06;
    shake = Math.min(shake + (airborne ? 7 : 4), airborne ? 12 : 8);
    let a = pl.facing === 1 ? pl.aim : Math.PI - pl.aim;
    if (airborne) a += rand(-0.04, 0.04);
    if (pl.hatT > 0) a += rand(-lawAimShake(), lawAimShake());
    const spd = lawBulletSpeed();
    const fat = lawBulletFat();
    const { x, y } = pl.muzzle;
    const vx = Math.cos(a) * spd, vy = Math.sin(a) * spd;
    bullets.push({ x, y, vx, vy, life: 1.2, ownerId: pl.id, fat });
    flashes.push({ x, y, t: 0 });
    if (netReady && window.GunNet) GunNet.send({ t: 'fire', x, y, vx, vy, ownerId: pl.id, fat });
    for (let i = 0; i < 4; i++) {
      particles.push({
        type: 'smoke', x, y, vx: Math.cos(a) * rand(20, 60) + rand(-15, 15), vy: Math.sin(a) * rand(20, 60) - rand(15, 35),
        life: 0, max: rand(0.45, 0.8), size: rand(3, 6),
      });
    }
    pl.vx -= Math.cos(a) * (airborne ? 55 : 40);
    if (airborne) pl.vy -= Math.sin(a) * 35;
    if (pl.ammo === 0) pl.autoReload = 0.35;
  }

  function tryFire(pl) {
    if (!me || pl !== me || locked()) return;
    if (pl.reloadT > 0 || pl.cooldown > 0 || pl.dodgeT > 0 || pl.burstT > 0) return;
    if (pl.ammo <= 0) { startReload(pl); return; }
    const twin = lawIs('twin') && pl.ammo >= 2;
    fireShot(pl);
    pl.cooldown = lawCooldown();
    if (twin) pl.burstT = TWIN_GAP;
  }

  function dust(x, y, n) {
    for (let i = 0; i < n; i++) {
      particles.push({
        type: 'dust', x: x + rand(-12, 12), y: y - 2, vx: rand(-70, 70), vy: rand(-45, -8),
        life: 0, max: rand(0.3, 0.55), size: rand(3, 6),
      });
    }
  }

  function sparks(x, y, n, up) {
    for (let i = 0; i < n; i++) {
      const a = up ? rand(-Math.PI * 0.95, -Math.PI * 0.05) : rand(0, Math.PI * 2);
      const s = rand(120, 350);
      particles.push({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rand(0.1, 0.25) });
    }
  }

  function impact(x, y) {
    particles.push({ type: 'impact', x, y, vx: 0, vy: 0, life: 0, max: 0.14, rot: rand(0, Math.PI * 2) });
  }

  function shatter(t) {
    for (let i = 0; i < 12; i++) {
      particles.push({
        type: 'shard', x: t.x + rand(-4, 4), y: t.y - rand(3, 20), vx: rand(-200, 200), vy: rand(-380, -80),
        life: 0, max: rand(0.7, 1.2), size: rand(2, 4), rot: rand(0, 6), vr: rand(-12, 12), color: t.color,
      });
    }
    impact(t.x, t.y - 12);
    sparks(t.x, t.y - 10, 5, false);
  }

  // 총열 연장선이 마우스를 지나도록 어깨 회전각 계산 (총열이 어깨보다 위/아래에 있는 만큼 보정)
  // 바라보는 쪽 180도(바로 위 ~ 바로 아래)까지만 회전, 마우스가 뒤에 있으면 위/아래 끝에 멈춤
  function aimRotation(shX, shY, facing, tx, ty) {
    const dx = (tx - shX) * facing, dy = ty - shY;
    if (dx <= 0) return dy < 0 ? -Math.PI / 2 : Math.PI / 2;
    const D = Math.max(Math.hypot(dx, dy), Math.abs(GG.barrelY) + 1);
    return clamp(Math.atan2(dy, dx) - Math.asin(clamp(GG.barrelY / D, -1, 1)), -Math.PI / 2, Math.PI / 2);
  }

  // ---------- 업데이트 ----------
  function updatePlayer(pl, input, dt) {
    if (locked()) {
      pl.vx = approach(pl.vx, 0, 1600 * dt);
      const prevX = pl.x;
      pl.x = clamp(pl.x + pl.vx * dt, 40, W - 40);
      resolveObstacleX(pl, prevX);
      const gy = groundAt(pl.x);
      if (pl.onGround) {
        pl.y = gy; pl.vy = 0;
      } else {
        pl.vy += 2300 * dt;
        pl.y += pl.vy * dt;
        if (pl.y >= gy) { pl.y = gy; pl.vy = 0; pl.onGround = true; }
        else pl.onGround = false;
      }
      pl.dodgeT = 0;
      pl.invuln = Math.max(0, pl.invuln - dt);
      pl.flashT -= dt;
      pl.squashV += (-300 * pl.squash - 18 * pl.squashV) * dt;
      pl.squash += pl.squashV * dt;
      return;
    }
    const dir = input.dir;
    const prevFacing = pl.facing;

    if (pl.dodgeT > 0) {
      pl.dodgeT -= dt;
      pl.facing = pl.dodgeDir;
      pl.vx = pl.dodgeDir * lawDodgeSpeed() * lerp(0.35, 1, pl.dodgeT / DODGE_TIME);
      if (pl.dodgeT <= 0) { pl.dodgeT = 0; pl.hatT = 0.5; }
    } else {
      // 조준점 방향 우선, 캐릭터 근처(데드존)일 때만 이동 방향으로 돌아섬
      if (input.aimX > pl.x + 6) pl.facing = 1;
      else if (input.aimX < pl.x - 6) pl.facing = -1;
      else if (dir !== 0) pl.facing = dir;
      const backing = dir !== 0 && dir !== pl.facing;
      const walk = backing || pl.reloadT > 0;
      const speed = lawRun();
      pl.vx = approach(pl.vx, dir * (walk ? speed * 0.65 : speed), (pl.onGround ? 2200 : 1300) * dt);
    }
    pl.dodgeCD -= dt;
    {
      const prevX = pl.x;
      pl.x = clamp(pl.x + pl.vx * dt, 40, W - 40);
      resolveObstacleX(pl, prevX);
    }

    pl.jumpQueued -= dt;
    if (pl.jumpQueued > 0 && pl.onGround && pl.dodgeT <= 0) {
      pl.vy = -lawJump(); pl.onGround = false; pl.airT = 0; pl.squashV -= 2.6; pl.jumpQueued = 0;
      pl.hatT = 0.5;
      dust(pl.x, groundAt(pl.x), 5);
      if (netReady && window.GunNet) { netAcc = 0; GunNet.send(packState(pl)); }
    }
    const gy = groundAt(pl.x);
    if (pl.onGround) {
      pl.y = gy;
      pl.vy = 0;
    } else {
      pl.vy += 2300 * dt;
      pl.y += pl.vy * dt;
      if (pl.y >= gy) {
        if (!pl.onGround) {
          pl.squashV += clamp(pl.vy / 900, 0.5, 1.5) * 2.6;
          pl.landT = 0.1;
          dust(pl.x, gy, 8);
          if (netReady && window.GunNet) { netAcc = 0; GunNet.send(packState(pl)); }
        }
        pl.y = gy; pl.vy = 0; pl.onGround = true;
      } else {
        pl.onGround = false;
        pl.airT += dt;
      }
    }
    pl.landT -= dt;

    if (pl.onGround) pl.runPhase += Math.abs(pl.vx) * dt / RUN_STRIDE;

    pl.squashV += (-300 * pl.squash - 18 * pl.squashV) * dt;
    pl.squash += pl.squashV * dt;
    pl.kickV += (-260 * pl.kick - 22 * pl.kickV) * dt;
    pl.kick += pl.kickV * dt;

    const target = aimRotation(pl.shoulder.x, pl.shoulder.y, pl.facing, input.aimX, input.aimY);
    if (prevFacing !== pl.facing) pl.aim = target;
    else pl.aim += angDiff(target, pl.aim) * Math.min(1, dt * 30);
    if (pl.hatT > 0) pl.hatT -= dt;

    pl.cooldown -= dt;
    pl.flashT -= dt;
    if (pl.burstT > 0) {
      pl.burstT -= dt;
      if (pl.burstT <= 0) {
        pl.burstT = 0;
        if (!locked() && pl.hp > 0 && pl.reloadT <= 0 && pl.ammo > 0) fireShot(pl);
      }
    }
    pl.invuln = Math.max(0, pl.invuln - dt);
    if (pl.autoReload > 0) { pl.autoReload -= dt; if (pl.autoReload <= 0) startReload(pl); }
    if (pl.reloadT > 0) {
      pl.reloadT -= dt;
      if (pl.reloadT <= 0) {
        pl.reloadT = 0;
        pl.ammo = pl.reloadTo || lawAmmo();
        if (lawIs('chalice')) pl.hp = Math.min(lawMaxHp(), pl.hp + 3);
      }
    }
  }

  function hitBox(pl, b) {
    const pad = 8 * ((b.fat || 1) - 1);
    const hx = 20 + pad, top = pl.y - BODY_H * 0.95 - pad, bot = pl.y - 8 + pad;
    return Math.abs(b.x - pl.x) <= hx && b.y >= top && b.y <= bot;
  }

  // 머리(모자) 구간: 캐릭터 상단 ~35%
  function isHeadshot(pl, b) {
    const headBot = pl.y - BODY_H * 0.58;
    const headTop = pl.y - BODY_H * 0.98;
    return b.y >= headTop && b.y <= headBot;
  }

  function isProtected(pl) {
    if (!pl || pl.hp <= 0) return true;
    if (matchOver) return true;
    if (pl.invuln > 0) return true;
    if (pl.dodgeT > 0 && pl.dodgeSafe !== false) return true;
    return false;
  }

  function hitPlayer(pl, b) {
    if (isProtected(pl)) return false;
    if (!hitBox(pl, b)) return false;
    const head = isHeadshot(pl, b);
    // 저격수: 몸통은 스치기만 하고 피해가 없다
    if (lawIs('sniper') && !head) {
      impact(b.x, b.y);
      sparks(b.x, b.y, 4, false);
      return true;
    }
    let dmg = head ? DMG_HEAD : DMG_BODY;
    pl.hp = Math.max(0, pl.hp - dmg);
    pl.hpDrain = dmg >= DMG_HEAD ? 3 : 1;
    pl.invuln = INVULN_TIME;
    const kb = lawIs('lastshot') ? 2 : 1;
    pl.vx += Math.sign(b.vx || 1) * (head ? 420 : 320) * kb;
    pl.vy -= (head ? 280 : 220) * kb;
    pl.onGround = false;
    pl.squashV += head ? 3 : 2;
    impact(b.x, b.y);
    sparks(b.x, b.y, head ? 10 : 6, false);
    shake = Math.min(shake + (head ? 9 : 6), 14);
    if (head) headFlash = 0.22;
    if (netReady && window.GunNet) {
      GunNet.send({ t: 'hurt', hp: pl.hp, head: !!head });
      if (pl.hp <= 0) GunNet.send({ t: 'over', loser: pl.id });
    }
    maybeGameOver();
    return true;
  }

  function update(dt) {
    if (!me) return;
    if (!board.x) placePortal();
    else board.y = groundAt(board.x);

    if (!me.init) {
      me.x = W * 0.28; me.y = groundAt(me.x); me.facing = 1; me.init = true;
      camX = 0;
      placePortal();
    }

    if (lockT > 0 && lockT <= START_LOCK + 0.05) lockT = Math.max(0, lockT - dt);
    updateWipe(dt);
    if (draft && !draft.burning && !draft.revealing) {
      draft.pickT = Math.max(0, (draft.pickT || 0) - dt);
      if (draft.pickT <= 0) autoBanDraft();
    }
    syncHudGauge();
    if (lawCardT > 0) {
      lawCardT = Math.max(0, lawCardT - dt);
      if (lawCardT <= 0) hideLawCard();
    }
    if (netReady && !matchOver && lockT <= 0) matchAge += dt;
    syncViewCam(dt);

    const aim = playAim();
    updatePlayer(me, {
      dir: locked() ? 0 : moveDir(),
      aimX: aim.x,
      aimY: aim.y,
    }, dt);

    if (netReady && other) updateRemote(other, dt);
    syncTitle();

    // 체력바 표시값: 실제 HP를 향해 천천히 감소 (헤드샷이면 3배)
    for (const pl of players) {
      if (pl.hpShow == null) pl.hpShow = pl.hp;
      if (pl.hpDrain == null) pl.hpDrain = 1;
      if (pl.hpShow > pl.hp) {
        pl.hpShow = approach(pl.hpShow, pl.hp, dt * 1.35 * pl.hpDrain);
        if (pl.hpShow <= pl.hp + 0.02) { pl.hpShow = pl.hp; pl.hpDrain = 1; }
      } else {
        pl.hpShow = pl.hp;
        pl.hpDrain = 1;
      }
    }

    headFlash = Math.max(0, headFlash - dt);

    // 현상수배 게시판 근접
    if (!netReady) {
      board.near = Math.abs(me.x - board.x) < board.w * 0.55 && Math.abs(me.y - board.y) < 90;
      if (!board.near && board.open) setPortalOpen(false);
    } else {
      board.near = false;
    }

    camX = 0;

    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      let dead = false;
      for (let s = 0; s < 4 && !dead; s++) {
        const x0 = b.x, y0 = b.y;
        b.x += b.vx * dt / 4; b.y += b.vy * dt / 4;
        const cover = obstacleRayHit(x0, y0, b.x, b.y);
        if (cover) {
          b.x = cover.x; b.y = cover.y;
          impact(b.x, b.y); sparks(b.x, b.y, 5, false); dead = true;
          break;
        }
        for (const t of targets) {
          if (t.alive && Math.abs(b.x - t.x) < 6 * (b.fat || 1) && b.y < t.y && b.y > t.y - 24) {
            t.alive = false; t.respawn = 1.6; shatter(t); dead = true; break;
          }
        }
        if (netReady) {
          if (!dead && other && b.ownerId === me.id && other.hp > 0 && hitBox(other, b)) {
            if (isProtected(other)) {
              dead = true;
            } else {
              impact(b.x, b.y); sparks(b.x, b.y, 6, false);
              if (isHeadshot(other, b)) {
                headFlash = 0.18;
                shake = Math.min(shake + 7, 12);
                sparks(b.x, b.y, 8, false);
              }
              other.invuln = INVULN_TIME;
              dead = true;
            }
          }
          if (!dead && b.ownerId !== me.id && hitPlayer(me, b)) dead = true;
        }
        if (!dead && b.y >= groundAt(b.x)) {
          const hitY = groundAt(b.x);
          impact(b.x, hitY - 4); sparks(b.x, hitY, 5, true); dust(b.x, hitY, 3); dead = true;
        }
      }
      b.life -= dt;
      if (dead || b.life <= 0 || b.x < -50 || b.x > W + 50 || b.y < -50) bullets.splice(i, 1);
    }

    netAcc += dt;
    if (netReady && netAcc >= 1 / 20 && window.GunNet) {
      netAcc = 0;
      GunNet.send(packState(me));
    }

    for (const t of targets) {
      if (!t.alive) { t.respawn -= dt; if (t.respawn <= 0) { t.alive = true; t.pop = 0; } }
      t.pop = Math.min(1, t.pop + dt * 5);
    }

    // 모닥불 불씨
    if (!(playBg() && playBg().width)) {
    for (const [name, x, h] of LAYOUT.back) {
      if (name !== 'campfire' || x < camX - 100 || x > camX + W + 100) continue;
      if (Math.random() < dt * 12) {
        particles.push({
          type: 'ember', x: x + rand(-8, 8), y: groundAt(x) - 4 - h * 0.45, vx: rand(-15, 15), vy: rand(-80, -40),
          life: 0, max: rand(0.6, 1.2), size: rand(1, 2),
        });
      }
    }
    }

    // 굴러다니는 회전초
    if (!tumble.active) {
      tumble.timer -= dt;
      if (tumble.timer <= 0) {
        const d = Math.random() < 0.5 ? 1 : -1;
        tumble.active = true;
        tumble.x = d > 0 ? camX - 60 : camX + W + 60;
        tumble.vx = d * rand(120, 190);
        tumble.t = 0;
      }
    } else {
      tumble.x += tumble.vx * dt;
      tumble.rot += tumble.vx * dt / 17;
      tumble.t += dt;
      if (tumble.x < camX - 140 || tumble.x > camX + W + 140) { tumble.active = false; tumble.timer = rand(5, 10); }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      if (p.type === 'smoke') { p.vx *= 0.94; p.vy = p.vy * 0.94 - 15 * dt; }
      if (p.type === 'dust') { p.vx *= 0.9; p.vy *= 0.9; }
      if (p.type === 'spark') p.vy += 900 * dt;
      if (p.type === 'ember') p.vx += Math.sin(p.life * 6 + p.x) * 30 * dt;
      if (p.type === 'shard') {
        p.vy += 1400 * dt; p.rot += p.vr * dt;
        if (p.y > groundAt(p.x)) { p.y = groundAt(p.x); p.vy *= -0.35; p.vx *= 0.6; p.vr *= 0.5; }
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }

    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].t += dt;
      if (flashes[i].t > 0.08) flashes.splice(i, 1);
    }

    shake = Math.max(0, shake - dt * 40);
    if (shake > 0) {
      shakeX = rand(-1, 1) * shake;
      shakeY = rand(-1, 1) * shake;
    } else {
      shakeX = 0;
      shakeY = 0;
    }
  }

  // 현재 상태 → 그릴 애니메이션/프레임
  function playerState(pl, t) {
    let anim = 'walk', i = 0, isIdle = false;
    if (pl.hp <= 0) {
      anim = 'jump'; i = 5;
      return {
        x: pl.x, y: pl.y, facing: pl.facing, anim, i, idle: false,
        skin: pl.skin, invuln: 0,
        sx: 1, sy: 1, R: pl.aim, kick: 0,
        reload: 0, flashT: 0, showArm: false, dead: true,
      };
    }
    if (pl.dodgeT > 0) {
      anim = 'dodge';
      const n = A.meta.dodge.length;
      i = Math.min(n - 1, Math.floor((1 - pl.dodgeT / DODGE_TIME) * n));
    } else if (!pl.onGround) {
      anim = 'jump';
      i = pl.airT < 0.08 ? 1 : pl.vy < -280 ? 2 : pl.vy < 280 ? 3 : 4;
    } else if (pl.landT > 0) {
      anim = 'jump'; i = 5;
    } else if (Math.abs(pl.vx) > 60) {
      const backing = Math.sign(pl.vx) !== pl.facing;
      anim = (backing || pl.reloadT > 0) ? 'walk' : 'run';
      i = Math.floor(pl.runPhase) % A.meta[anim].length;
    } else {
      isIdle = true;
    }
    const breath = isIdle ? Math.sin(t * 2.4) : 0;
    return {
      x: pl.x, y: pl.y, facing: pl.facing, anim, i, idle: isIdle,
      skin: pl.skin, invuln: pl.invuln,
      sx: 1 + pl.squash * 0.7 - breath * 0.006,
      sy: 1 - pl.squash + breath * 0.014,
      R: pl.aim, kick: pl.kick,
      reload: pl.reloadT > 0 ? 1 - pl.reloadT / (pl.reloadMax || RELOAD_TIME) : 0,
      flashT: pl.flashT, showArm: anim !== 'dodge',
    };
  }

  // ---------- 그리기 ----------
  let last = 0, shakeX = 0, shakeY = 0, offX = 0, offY = 0; // off = 월드 → 화면 이동량

  function drawFrame(name, i, ax, ay, k, skin) {
    const f = A.meta[name][i];
    const body = skin === 'guest' && IMG_BLUE[name];
    const img = body || IMG[name];
    ctx.drawImage(img, f.x, f.y, f.w, f.h, -ax * k, -ay * k, f.w * k, f.h * k);
  }

  // 소품: (cx, 바닥 y) 기준, 높이 h로
  function drawSprite(spr, name, cx, by, h) {
    const w = spr.w * h / spr.h;
    ctx.drawImage(spr.img, spr.sx, spr.sy, spr.w, spr.h, cx - w / 2, by - h + (SINK[name] || 0) * h, w, h);
  }

  function drawCharacter(S) {
    const f = A.meta[S.anim][S.i];
    const gy = groundAt(S.x);
    const hgt = clamp((gy - S.y) / 250, 0, 1);
    const skin = S.skin || 'host';
    const idleObj = skin === 'guest' ? idleBlue : idle;
    const fade = S.viewFade == null ? 1 : S.viewFade;
    ctx.fillStyle = `rgba(20,12,10,${0.3 * (1 - hgt * 0.7) * fade})`;
    ctx.beginPath();
    ctx.ellipse(S.x, gy + 1, 30 * (1 - hgt * 0.4), 5 * (1 - hgt * 0.4), groundSlope(S.x), 0, Math.PI * 2);
    ctx.fill();

    const k = BODY_K * frameScale(S.anim);
    const recoil = Math.max(0, S.kick);
    const rx = -S.facing * recoil * 5 + (recoil > 0.08 ? (Math.random() - 0.5) * recoil * 4 : 0);
    const ry = -recoil * 2.5 + (recoil > 0.08 ? (Math.random() - 0.5) * recoil * 3 : 0);
    ctx.save();
    let alpha = 1;
    if (S.dead) alpha *= 0.72;
    if (S.invuln > 0 && Math.floor(S.invuln * 18) % 2 === 0) alpha *= 0.35;
    if (S.viewFade != null) alpha *= S.viewFade;
    if (S.anim === 'dodge') {
      alpha *= 0.75;
      ctx.filter = 'blur(0.8px)';
    }
    ctx.globalAlpha *= alpha;
    ctx.translate(S.x + rx, S.y + ry);
    ctx.scale(S.facing * S.sx, S.sy);
    if (S.idle && idleObj) {
      ctx.drawImage(idleObj.canvas, -(f.ax + idleObj.pad) * k, -f.ay * k, idleObj.canvas.width * k, idleObj.canvas.height * k);
    } else {
      drawFrame(S.anim, S.i, f.ax, f.ay, k, skin);
    }
    ctx.restore();

    S.shoulder = {
      x: S.x + rx + S.facing * ((f.sx - f.ax) * k - SHOULDER_BACK) * S.sx,
      y: S.y + ry + ((f.sy - f.ay) * k + SHOULDER_DOWN) * S.sy,
    };
    if (S.showArm) {
      drawArm(S);
      drawCapeOver(S, f, k);
    }
  }

  function drawArm(S) {
    const a = A.meta.arm[ARM_FRAME];
    let rot = S.R, gunFrame = 0, spin = 0;
    if (S.reload > 0) {
      const p = S.reload;
      rot = lerp(S.R, 0.95, smooth(Math.min(p * 5, (1 - p) * 5)));
      spin = smooth(Math.max(0, (p - 0.55) / 0.35)) * Math.PI * 4; // 2바퀴, 후반에 몰아 빠르게
    }
    const g = A.meta.gun[gunFrame];
    const kick = Math.max(0, S.kick);

    ctx.save();
    ctx.translate(S.shoulder.x, S.shoulder.y);
    ctx.scale(S.facing, 1);
    ctx.rotate(rot - kick * 0.45);
    ctx.translate(-kick * 4, 0);

    ctx.save();
    ctx.translate(GG.fistX, GG.fistY);
    ctx.rotate(-kick * 0.35 + spin);
    drawFrame('gun', gunFrame, g.gx, g.gy, GUN_K);
    const g0 = A.meta.gun[0];
    const mlx = (g0.mx - g0.gx) * GUN_K, mly = (g0.my - g0.gy) * GUN_K;
    const m = ctx.getTransform();
    S.muzzle = {
      x: (m.a * mlx + m.c * mly + m.e) / DPR - offX,
      y: (m.b * mlx + m.d * mly + m.f) / DPR - offY,
    };
    if (S.flashT > 0) {
      const fl = A.meta.flash[0];
      ctx.translate(mlx, mly);
      drawFrame('flash', 0, fl.ax, fl.ay, GUN_K * 1.3);
    }
    ctx.restore();

    drawFrame('arm', ARM_FRAME, a.px, a.py, ARM_K);
    ctx.restore();
  }

  function sketchPoly(pts, fill) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = 'rgba(30,20,16,0.85)';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function glow(x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 하늘 · 배경 전체 화면 고정
  function drawSky(gy) {
    const bg = playBg();
    if (bg && bg.width) {
      const scale = Math.max(W / bg.width, H / bg.height) * 1.04;
      const dw = bg.width * scale, dh = bg.height * scale;
      const dx = (W - dw) * 0.5;
      const dy = (H - dh) * 0.5;
      ctx.drawImage(bg, dx, dy, dw, dh);
      return;
    }

    const sky = ctx.createLinearGradient(0, 0, 0, gy);
    sky.addColorStop(0, '#2d2330');
    sky.addColorStop(0.55, '#8a5543');
    sky.addColorStop(1, '#d99a64');
    ctx.fillStyle = sky;
    ctx.fillRect(-20, -20, W + 40, gy + 20);

    ctx.fillStyle = 'rgba(255,220,170,0.55)';
    ctx.beginPath(); ctx.arc(W * 0.62 - camX * 0.05, gy - 50, 55, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#6b4136';
    ctx.beginPath();
    ctx.moveTo(-20, gy);
    for (const [x, h] of mesas) ctx.lineTo(x - camX * 0.25, gy - 22 - h);
    ctx.lineTo(W + 20, gy);
    ctx.fill();

    ctx.fillStyle = '#6a4838';
    ctx.fillRect(-20, gy - 22, W + 40, 24);

    for (const [name, x, h] of LAYOUT.mid) {
      const sx = x - camX * 0.6;
      if (sx < -150 || sx > W + 150) continue;
      drawSprite(TINT_MID[name], name, sx, gy - 16, h);
    }
  }

  // 땅 (월드 좌표)
  function drawGround(gy) {
    const x0 = camX - 60, x1 = camX + W + 60;
    // 손그림 배경이 지면까지 포함하고 있으면 덮어쓰지 않음
    if (IMG.bg && IMG.bg.width) return;

    ctx.fillStyle = '#4a3328';
    ctx.fillRect(x0, gy, x1 - x0, H - gy + 40);
    ctx.fillStyle = '#5e4232';
    ctx.fillRect(x0, gy, x1 - x0, 7);
    ctx.strokeStyle = 'rgba(30,20,16,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();

    for (const p of pebbles) {
      if (p.x < x0 || p.x > x1) continue;
      ctx.fillStyle = p.light ? 'rgba(140,105,80,0.45)' : 'rgba(25,15,10,0.35)';
      ctx.beginPath();
      ctx.ellipse(p.x, gy + 12 + p.fy * (H - gy - 12), p.r * 1.6, p.r, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(130,110,70,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const g of grass) {
      if (g.x < x0 || g.x > x1) continue;
      const y = gy - 1 + g.fy * 3;
      ctx.moveTo(g.x, y); ctx.lineTo(g.x - 2, y - g.h);
      ctx.moveTo(g.x + 2, y); ctx.lineTo(g.x + 3, y - g.h * 0.8);
      ctx.moveTo(g.x + 4, y); ctx.lineTo(g.x + 7, y - g.h * 0.6);
    }
    ctx.stroke();
  }

  function drawBackProps(gy, t) {
    if (IMG.bg && IMG.bg.width) return; // 고정 배경일 때는 소품 레이어 생략
    for (const [name, x, h, lift = 0] of LAYOUT.back) {
      if (x < camX - 250 || x > camX + W + 250) continue;
      if (!lift) {
        const w = SPR[name].w * h / SPR[name].h;
        ctx.fillStyle = 'rgba(20,12,10,0.22)';
        ctx.beginPath(); ctx.ellipse(x, gy - 2, w * 0.42, 4, 0, 0, Math.PI * 2); ctx.fill();
      }
      drawSprite(SPR[name], name, x, gy - 4 - lift, h);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const flicker = 0.85 + 0.15 * Math.sin(t * 17) * Math.sin(t * 7.3);
    for (const [name, x, h, lift = 0] of LAYOUT.back) {
      if (x < camX - 250 || x > camX + W + 250) continue;
      const by = gy - 4 - lift;
      if (name === 'campfire') glow(x, by - h * 0.45, 85 * flicker, 'rgba(255,140,60,0.35)');
      if (name === 'lantern') glow(x, by - h * 0.45, 40 * flicker, 'rgba(255,200,120,0.3)');
      if (name === 'lamppost') glow(x - SPR[name].w * h / SPR[name].h * 0.06, by - h * 0.55, 45 * flicker, 'rgba(255,200,120,0.3)');
    }
    ctx.restore();

    if (tumble.active) {
      const bounce = Math.abs(Math.sin(tumble.t * 5)) * 14;
      const h = 32;
      ctx.save();
      ctx.translate(tumble.x, gy - 4 - h / 2 - bounce);
      ctx.rotate(tumble.rot);
      const s = SPR.tumbleweed, w = s.w * h / s.h;
      ctx.drawImage(s.img, s.sx, s.sy, s.w, s.h, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  function drawTargets() {
    if (IMG.bg && IMG.bg.width) return;
    for (const t of targets) {
      if (!t.alive) continue;
      const k = smooth(t.pop);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(k, k);
      sketchPoly([-4.5, 0, 4.5, 0, 4.5, -15, 2, -18, 2, -24, -2, -24, -2, -18, -4.5, -15], t.color);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(-3, -13, 1.5, 10);
      ctx.restore();
    }
  }

  function drawForeground() {
    if (IMG.bg && IMG.bg.width) return;
    for (const [name, x, h] of LAYOUT.fg) {
      const sx = x - camX * 1.15 + shakeX;
      if (sx < -200 || sx > W + 200) continue;
      drawSprite(TINT_FG[name], name, sx, H + h * 0.3, h);
    }
  }

  function drawEffects() {
    ctx.lineCap = 'round';
    for (const b of bullets) {
      const spd = Math.hypot(b.vx, b.vy) || 1;
      const dx = b.vx / spd, dy = b.vy / spd;
      const fat = b.fat || 1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,140,70,0.25)';
      ctx.lineWidth = 7 * fat;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 55 * fat, b.y - dy * 55 * fat); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,190,110,0.45)';
      ctx.lineWidth = 4 * fat;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 32 * fat, b.y - dy * 32 * fat); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,240,200,0.9)';
      ctx.lineWidth = 2.2 * fat;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 14 * fat, b.y - dy * 14 * fat); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }

    for (const p of particles) {
      const k = p.life / p.max;
      if (p.type === 'smoke') {
        ctx.fillStyle = `rgba(190,180,170,${0.35 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + k * 1.5), 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'dust') {
        ctx.fillStyle = `rgba(160,120,90,${0.45 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + k), 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'spark') {
        ctx.strokeStyle = `rgba(255,200,120,${1 - k})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.022, p.y - p.vy * 0.022); ctx.stroke();
      } else if (p.type === 'ember') {
        ctx.fillStyle = `rgba(255,170,80,${1 - k})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      } else if (p.type === 'impact') {
        const s = SPR.fx_impact, h = 22 * (0.7 + k * 0.6), w = s.w * h / s.h;
        ctx.save();
        ctx.globalAlpha = 1 - k;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.drawImage(s.img, s.sx, s.sy, s.w, s.h, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else if (p.type === 'shard') {
        ctx.save();
        ctx.globalAlpha = 1 - k * k;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flashes) glow(f.x, f.y, 40, `rgba(255,170,90,${0.45 * (1 - f.t / 0.08)})`);
    ctx.restore();

  }

  function drawHeadFlash() {
    if (headFlash <= 0) return;
    const a = clamp(headFlash / 0.22, 0, 1);
    ctx.fillStyle = `rgba(180,30,20,${0.22 * a})`;
    ctx.fillRect(0, 0, W, H);
    // 가장자리 빨간 비네트
    const g = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.2, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(255,60,40,0)');
    g.addColorStop(1, `rgba(160,20,10,${0.35 * a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawVignette() {
    const z = boardZoomT();
    const a = 0.45 * (1 - smooth(z));
    if (a < 0.01) return;
    const g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(20,8,6,' + a.toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 손그림 느낌의 둥근 체력바 (머리 위)
  function sketchRoundRect(x, y, w, h, r, seed) {
    const n = 10;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = x + r + (w - 2 * r) * t;
      const wobble = Math.sin(seed * 12.7 + t * 9.1) * 0.55 + Math.sin(seed * 3.3 + t * 17) * 0.25;
      const py = y + wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    for (let i = 0; i <= 4; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / 4);
      const wobble = Math.sin(seed * 5 + i) * 0.35;
      ctx.lineTo(x + w - r + Math.cos(a) * (r + wobble), y + r + Math.sin(a) * (r + wobble));
    }
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = x + w - r - (w - 2 * r) * t;
      const wobble = Math.sin(seed * 8.2 + t * 11.4) * 0.55;
      ctx.lineTo(px, y + h + wobble);
    }
    for (let i = 0; i <= 4; i++) {
      const a = Math.PI / 2 + (Math.PI / 2) * (i / 4);
      const wobble = Math.sin(seed * 7 + i * 1.7) * 0.35;
      ctx.lineTo(x + r + Math.cos(a) * (r + wobble), y + h - r + Math.sin(a) * (r + wobble));
    }
    ctx.closePath();
  }

  function drawHeadHpBar(pl) {
    if (pl.hp <= 0 && (pl.hpShow == null || pl.hpShow <= 0.02)) return;
    const maxHp = lawMaxHp();
    const bw = 57 * (maxHp / MAX_HP), bh = 6.6, r = 3.3;
    const x = pl.x - bw / 2;
    const y = pl.y - BODY_H - 16;
    const shown = pl.hpShow == null ? pl.hp : pl.hpShow;
    const ratio = clamp(shown / maxHp, 0, 1);
    const fill = pl.skin === 'guest' ? '#6a8fb8' : '#c45a3a';
    const seed = pl.id * 17.3 + pl.x * 0.01;

    // 그림자/속지
    ctx.fillStyle = 'rgba(28,16,12,0.45)';
    sketchRoundRect(x + 1.2, y + 1.4, bw, bh, r, seed + 1);
    ctx.fill();

    // 빈 칸 (종이 톤)
    ctx.fillStyle = 'rgba(245,230,205,0.82)';
    sketchRoundRect(x, y, bw, bh, r, seed);
    ctx.fill();

    // 체력 채움 (라운드 클립)
    if (ratio > 0.02) {
      ctx.save();
      sketchRoundRect(x, y, bw, bh, r, seed);
      ctx.clip();
      const fw = Math.max(r * 2, bw * ratio);
      ctx.fillStyle = fill;
      sketchRoundRect(x, y, fw, bh, r, seed + 2);
      ctx.fill();
      // 살짝 손그림 하이라이트
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x + 3, y + 1.2, fw - 6, 2);
      ctx.restore();
    }

    // 연필 외곽선 (이중으로 살짝 어긋나게)
    ctx.strokeStyle = 'rgba(40,22,16,0.75)';
    ctx.lineWidth = 1.35;
    ctx.lineJoin = 'round';
    sketchRoundRect(x, y, bw, bh, r, seed);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40,22,16,0.28)';
    ctx.lineWidth = 1;
    sketchRoundRect(x + 0.6, y - 0.4, bw, bh, r, seed + 0.5);
    ctx.stroke();
  }

  function drawWantedBoard() {
    if (netReady) return;
    const lay = wantedLayout();
    const boardImg = IMG.wantedBoard;
    if (boardImg && boardImg.width) {
      ctx.drawImage(boardImg, lay.x - lay.w / 2, lay.top, lay.w, lay.h);
    } else {
      ctx.fillStyle = '#4a3224';
      ctx.fillRect(lay.x - lay.w / 2, lay.top, lay.w, lay.h);
    }

    if (board.near && !board.open) {
      const m = (board.status || '').match(/수배 번호:\s*(\d{4})/);
      const label = usingTouch
        ? (m ? '터치 · 수배 ' + m[1] : '터치 · 현상수배')
        : (m ? '[E] 수배 ' + m[1] : '[E] 현상수배');
      const ty = lay.top - 18;
      ctx.font = 'bold 15px "Malgun Gothic", sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(18, 10, 6, 0.78)';
      ctx.fillRect(lay.x - tw / 2 - 10, ty - 16, tw + 20, 26);
      ctx.strokeStyle = 'rgba(244, 230, 208, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lay.x - tw / 2 - 10, ty - 16, tw + 20, 26);
      ctx.fillStyle = '#fff6e0';
      ctx.fillText(label, lay.x, ty);
      ctx.textAlign = 'left';
    }
  }

  function drawReloadArrows(x, y, t) {
    const spin = ((t || 0) * 4.6) % (Math.PI * 2);
    const size = 30;
    const im = IMG.reload0;
    if (!im || !im.width) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.drawImage(im, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function drawHUD(t) {
    if (!me) return;

    // 내 탄약만
    const cyl = lawAmmo();
    const fillTo = me.reloadT > 0 ? (me.reloadTo || cyl) : me.ammo;
    const shown = me.reloadT > 0
      ? Math.min(fillTo, Math.floor((1 - me.reloadT / (me.reloadMax || RELOAD_TIME)) * (fillTo + 1)))
      : me.ammo;
    const ammoRight = me.skin === 'guest';
    const ammoH = 34;
    const ammoGap = 22;
    let ammoW = 16;
    for (let i = 0; i < cyl; i++) {
      const im = IMG['hudBullet' + (i % 5)];
      if (im && im.width) ammoW = im.width * ammoH / im.height;
      const x = ammoRight ? W - 18 - ammoW / 2 - i * ammoGap : 18 + ammoW / 2 + i * ammoGap;
      const y = H - 16 - ammoH / 2;
      ctx.save();
      if (i < shown) ctx.globalAlpha = 1;
      else {
        ctx.filter = 'grayscale(1)';
        ctx.globalAlpha = 0.2;
      }
      if (im && im.width) ctx.drawImage(im, x - ammoW / 2, y - ammoH / 2, ammoW, ammoH);
      ctx.restore();
    }
    if (me.reloadT > 0) {
      const cx = ammoRight
        ? W - 18 - cyl * ammoGap - 26
        : 18 + cyl * ammoGap + 28;
      const cy = H - 16 - ammoH / 2;
      drawReloadArrows(cx, cy, t);
    }

    // 조준점 (내 마우스) — 타로 고를 때는 오버레이가 커서 담당
    if (drafting() || viewingBoard() || usingTouch) return;
    const r = 10 + Math.max(0, me.kick) * 5;
    const mx = mouse.x, my = mouse.y;
    const gap = 4, arm = r + 4;
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(20,10,8,0.85)';
    ctx.beginPath();
    ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
    ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
    ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
    ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff6e0';
    ctx.beginPath();
    ctx.moveTo(mx - arm, my); ctx.lineTo(mx - gap, my);
    ctx.moveTo(mx + gap, my); ctx.lineTo(mx + arm, my);
    ctx.moveTo(mx, my - arm); ctx.lineTo(mx, my - gap);
    ctx.moveTo(mx, my + gap); ctx.lineTo(mx, my + arm);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath(); ctx.arc(mx, my, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // 정렬 확인용: 모든 애니메이션 프레임 + 조준 각도 + 재장전 단계를 한 화면에
  function drawPreview(t) {
    ctx.fillStyle = '#d8cbb8';
    ctx.fillRect(0, 0, W, H);
    const dot = (x, y, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); };
    const base = { facing: 1, sx: 1, sy: 1, kick: 0, reload: 0, flashT: 0, idle: false, skin: 'host' };
    ['walk', 'run', 'jump', 'dodge'].forEach((anim, r) => {
      for (let i = 0; i < A.meta[anim].length; i++) {
        const S = { ...base, anim, i, x: 80 + i * 120, y: 150 + r * 150, showArm: anim !== 'dodge', R: -0.1 };
        drawCharacter(S);
        dot(S.shoulder.x, S.shoulder.y, 'red');
        if (S.muzzle) dot(S.muzzle.x, S.muzzle.y, 'cyan');
      }
    });
    const extra = [
      { R: -1.2 }, { R: -0.6 }, { R: 0.5 }, { R: 1.2 },
      { R: 0, facing: -1 }, { R: 0, kick: 1, flashT: 1 },
      { R: 0, reload: 0.4 }, { R: 0, reload: 0.85 },
    ];
    if (idle) warpIdle(t, idle);
    if (idleBlue) warpIdle(t, idleBlue);
    extra.forEach((e, i) => {
      const S = { ...base, anim: 'walk', i: 0, idle: true, x: 80 + i * 150, y: 750, showArm: true, ...e };
      drawCharacter(S);
      dot(S.shoulder.x, S.shoulder.y, 'red');
    });
  }

  // ---------- 루프 (물리 60틱, 그리기는 화면 주사율) ----------
  const TICK = 1 / 60;
  let acc = 0;
  function loop(now) {
    const t = now / 1000;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (PREVIEW) {
      drawPreview(t);
      requestAnimationFrame(loop);
      return;
    }

    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let steps = 0;
    while (acc >= TICK && steps < 8) {
      update(TICK);
      acc -= TICK;
      steps++;
    }

    const gy = groundY();
    offX = shakeX - camX;
    offY = shakeY;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#4a3328';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(viewZ, viewZ);
    ctx.translate(-viewZX, -viewZY);

    ctx.save();
    ctx.translate(shakeX * 0.5, shakeY * 0.5);
    drawSky(gy);
    ctx.restore();

    ctx.save();
    ctx.translate(offX, offY);
    drawGround(gy);
    drawBackProps(gy, t);
    drawTargets();
    if (!netReady) drawWantedBoard();
    {
      const fade = 1 - smooth(clamp((boardZoomT() - 0.06) / 0.52, 0, 1));
      if (fade > 0.02) {
        ctx.save();
        ctx.globalAlpha *= fade;
        const list = netReady ? players : [me];
        const states = list.map(pl => playerState(pl, t));
        if (states.some(S => S.idle && S.skin !== 'guest') && idle) warpIdle(t, idle);
        if (states.some(S => S.idle && S.skin === 'guest') && idleBlue) warpIdle(t, idleBlue);
        states.forEach((S, i) => {
          const pl = list[i];
          drawCharacter(S);
          pl.shoulder = S.shoulder;
          if (S.muzzle) pl.muzzle = S.muzzle;
        });
        if (netReady) for (const pl of players) drawHeadHpBar(pl);
        ctx.restore();
      }
    }
    drawObstacles();
    drawEffects();
    ctx.restore();

    drawForeground();
    ctx.restore();

    drawVignette();
    drawHeadFlash();
    if (!viewingBoard()) drawHUD(t);
    drawWipe();

    requestAnimationFrame(loop);
  }

  for (const [name, src] of Object.entries(sources)) {
    const im = new Image();
    im.onload = () => { if (--pending === 0) start(); };
    im.onerror = () => { console.warn('failed to load', name); if (--pending === 0) start(); };
    im.src = src;
    IMG[name] = im;
  }
})();
