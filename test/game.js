(() => {
  const A = window.ASSETS;
  const PR = window.PROPS;
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cvs.width = W * DPR; cvs.height = H * DPR;
    cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
  }
  addEventListener('resize', resize);
  resize();

  const QUERY = new URLSearchParams(location.search);
  const PREVIEW = QUERY.has('preview');       // index.html?preview → 모든 프레임 정렬 확인용
  const START_X = Number(QUERY.get('x')) || 0; // index.html?x=1500 → 시작 위치 지정
  const groundY = () => Math.round(H * 0.78);
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
  const BODY_H = 125;                       // 화면에서 캐릭터 키(px)
  const BODY_K = BODY_H / A.meta.walk[0].h;
  const ARM_K = BODY_K * 0.62;
  const GUN_K = BODY_K * 0.55;
  const ARM_FRAME = 2;                      // 팔을 앞으로 뻗은 프레임
  const AMMO = 6, RELOAD_TIME = 1.1, DODGE_TIME = 0.5;
  const RUN_SPEED = 300, DODGE_SPEED = 520, JUMP_V = 880;
  const RUN_STRIDE = 26;                    // 프레임 1장당 이동 거리(px) → 발 미끄러짐 방지
  // 시트마다 캐릭터가 그려진 크기가 달라서 모자 폭 기준으로 맞춤 (walk = 1)
  const ANIM_SCALE = { walk: 1, run: 1.26, jump: 1.13, dodge: 1.17 };
  // 구르기 시트는 첫 프레임보다 마지막 프레임이 크게 그려져 있어서 프레임마다 보간
  const frameScale = (anim, i) => anim === 'dodge' ? lerp(1.25, 1.09, i / (A.meta.dodge.length - 1)) : ANIM_SCALE[anim];
  const SHOULDER_BACK = 7, SHOULDER_DOWN = 2; // 어깨를 몸 안쪽으로 (화면 px)
  const CAPE_OVER_R = 24;                     // 팔 위로 망토를 다시 덮는 반경 (화면 px)

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

  const IMG = {};
  const sources = { ...A.images, props: PR.image };
  let pending = Object.keys(sources).length;
  for (const [name, src] of Object.entries(sources)) {
    const im = new Image();
    im.onload = () => { if (--pending === 0) start(); };
    im.src = src;
    IMG[name] = im;
  }

  let GG = null;   // 팔/총 기하 정보
  let idle = null; // 가만히 있을 때 망토 흔들림용
  const SPR = {}, TINT_MID = {}, TINT_FG = {};
  let mesas = [], pebbles = [], grass = [];

  function start() {
    const a = A.meta.arm[ARM_FRAME], g = A.meta.gun[0];
    const fistX = (a.fx - a.px) * ARM_K, fistY = (a.fy - a.py) * ARM_K;
    GG = { fistX, fistY, barrelY: fistY + (g.my - g.gy) * GUN_K };
    setupIdle();
    buildCapeOverlays();
    buildWorld();
    layoutTargets();
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
  const CAPE = {};
  function buildCapeOverlays() {
    for (const name of Object.keys(ANIM_SCALE)) {
      const im = IMG[name];
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const L = (p[i] + p[i + 1] + p[i + 2]) / 3;
        p[i + 3] *= smooth((p[i] - p[i + 2] - 18) / 12) * smooth((L - 85) / 20) * (1 - smooth((L - 150) / 25));
      }
      g.putImageData(d, 0, 0);
      CAPE[name] = c;
    }
  }

  const capeTmp = document.createElement('canvas');
  const capeTmpCtx = capeTmp.getContext('2d');
  function drawCapeOver(S, f, k) {
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
    g.drawImage(CAPE[S.anim], f.x, f.y, f.w, f.h, -f.ax * k, -f.ay * k, f.w * k, f.h * k);
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
  function setupIdle() {
    const f = A.meta.walk[0], pad = 16;
    const c = document.createElement('canvas');
    c.width = f.w + pad; c.height = f.h;
    const g = c.getContext('2d');
    g.drawImage(IMG.walk, f.x, f.y, f.w, f.h, pad, 0, f.w, f.h);
    const src = g.getImageData(0, 0, c.width, c.height).data.slice();
    const wt = new Float32Array(c.width * c.height);
    const x0 = f.ax - 40, x1 = 10;
    for (let y = 0; y < c.height; y++) {
      const fy = smooth((y - f.h * 0.35) / (f.h * 0.35));
      for (let x = 0; x < c.width; x++) {
        wt[y * c.width + x] = fy * smooth((x0 - (x - pad)) / (x0 - x1));
      }
    }
    idle = { canvas: c, ctx: g, src, wt, out: g.createImageData(c.width, c.height), pad, xMax: Math.ceil(x0 + pad) };
  }

  function warpIdle(t) {
    const { canvas: c, src, wt, out, xMax } = idle;
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
    idle.ctx.putImageData(out, 0, 0);
  }

  // ---------- 입력 ----------
  const keys = {};
  const mouse = { x: W * 0.7, y: H * 0.6, down: false };
  let jumpQueued = 0;
  addEventListener('keydown', e => {
    if (e.repeat) return;
    keys[e.code] = true;
    if (['Space', 'KeyW', 'ArrowUp'].includes(e.code)) { jumpQueued = 0.12; e.preventDefault(); }
    if (e.code === 'KeyR') startReload();
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') startDodge();
  });
  addEventListener('keyup', e => { keys[e.code] = false; });
  cvs.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  cvs.addEventListener('mousedown', e => { if (e.button === 0) { mouse.down = true; tryFire(); } });
  addEventListener('mouseup', () => { mouse.down = false; });
  cvs.addEventListener('contextmenu', e => e.preventDefault());

  // ---------- 플레이어 ----------
  const P = {
    x: 0, y: 0, vx: 0, vy: 0, onGround: true, init: false,
    facing: 1, aim: 0,
    runPhase: 0, airT: 0, landT: 0,
    squash: 0, squashV: 0, kick: 0, kickV: 0,
    ammo: AMMO, reloadT: 0, autoReload: 0, cooldown: 0, flashT: 0,
    dodgeT: 0, dodgeDir: 1, dodgeCD: 0,
    shoulder: { x: 0, y: 0 }, muzzle: { x: 0, y: 0 },
  };

  const bullets = [], particles = [], flashes = [], targets = [];
  const tumble = { active: false, x: 0, vx: 0, rot: 0, t: 0, timer: 2 };
  let shake = 0, camX = 0;

  function layoutTargets() {
    targets.length = 0;
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
    if (P.onGround) P.y = groundY();
  });

  function startReload() {
    if (P.reloadT > 0 || P.ammo === AMMO) return;
    P.reloadT = RELOAD_TIME;
  }

  function startDodge() {
    if (P.dodgeT > 0 || P.dodgeCD > 0 || !P.onGround) return;
    const dir = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
    P.dodgeDir = dir || P.facing;
    P.dodgeT = DODGE_TIME;
    P.dodgeCD = DODGE_TIME + 0.15;
    P.vx = P.dodgeDir * DODGE_SPEED;
    dust(P.x, P.y, 6);
  }

  function tryFire() {
    if (P.reloadT > 0 || P.cooldown > 0 || P.dodgeT > 0) return;
    if (P.ammo <= 0) { startReload(); return; }
    P.ammo--;
    P.cooldown = 0.17;
    P.kickV += 26;
    P.flashT = 0.06;
    shake = Math.min(shake + 4, 8);
    const a = P.facing === 1 ? P.aim : Math.PI - P.aim;
    const { x, y } = P.muzzle;
    bullets.push({ x, y, vx: Math.cos(a) * 2000, vy: Math.sin(a) * 2000, life: 1.2 });
    flashes.push({ x, y, t: 0 });
    for (let i = 0; i < 4; i++) {
      particles.push({
        type: 'smoke', x, y, vx: Math.cos(a) * rand(20, 60) + rand(-15, 15), vy: Math.sin(a) * rand(20, 60) - rand(15, 35),
        life: 0, max: rand(0.45, 0.8), size: rand(3, 6),
      });
    }
    P.vx -= Math.cos(a) * 40;
    if (P.ammo === 0) P.autoReload = 0.35;
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
  function update(dt) {
    const gy = groundY();
    if (!P.init) {
      P.x = clamp(START_X || W * 0.3, 30, WORLD_W - 30); P.y = gy; P.init = true;
      camX = clamp(P.x - W * 0.42, 0, Math.max(0, WORLD_W - W));
    }
    const mouseWX = mouse.x + camX;

    const dir = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
    const prevFacing = P.facing;

    if (P.dodgeT > 0) {
      P.dodgeT -= dt;
      P.facing = P.dodgeDir;
      P.vx = P.dodgeDir * DODGE_SPEED * lerp(0.35, 1, P.dodgeT / DODGE_TIME);
    } else {
      // 이동 키를 누르고 있으면 이동 방향 우선, 손을 떼면 마우스 쪽으로 돌아섬
      if (dir !== 0) P.facing = dir;
      else if (mouseWX > P.x + 6) P.facing = 1;
      else if (mouseWX < P.x - 6) P.facing = -1;
      P.vx = approach(P.vx, dir * RUN_SPEED, (P.onGround ? 2200 : 1300) * dt);
    }
    P.dodgeCD -= dt;
    P.x = clamp(P.x + P.vx * dt, 30, WORLD_W - 30);

    jumpQueued -= dt;
    if (jumpQueued > 0 && P.onGround && P.dodgeT <= 0) {
      P.vy = -JUMP_V; P.onGround = false; P.airT = 0; P.squashV -= 2.6; jumpQueued = 0;
      dust(P.x, gy, 5);
    }
    P.vy += 2300 * dt;
    P.y += P.vy * dt;
    if (P.y >= gy) {
      if (!P.onGround) {
        P.squashV += clamp(P.vy / 900, 0.5, 1.5) * 2.6;
        P.landT = 0.1;
        dust(P.x, gy, 8);
      }
      P.y = gy; P.vy = 0; P.onGround = true;
    } else {
      P.onGround = false;
      P.airT += dt;
    }
    P.landT -= dt;

    if (P.onGround) P.runPhase += Math.abs(P.vx) * dt / RUN_STRIDE;

    // 카메라: 플레이어를 따라가되 마우스 쪽을 살짝 더 보여줌
    const camTarget = clamp(P.x - W * 0.5 + (mouse.x - W * 0.5) * 0.15, 0, Math.max(0, WORLD_W - W));
    camX = lerp(camX, camTarget, 1 - Math.exp(-dt * 6));

    P.squashV += (-300 * P.squash - 18 * P.squashV) * dt;
    P.squash += P.squashV * dt;
    P.kickV += (-260 * P.kick - 22 * P.kickV) * dt;
    P.kick += P.kickV * dt;

    const target = aimRotation(P.shoulder.x, P.shoulder.y, P.facing, mouseWX, mouse.y);
    if (prevFacing !== P.facing) P.aim = target;
    else P.aim += angDiff(target, P.aim) * Math.min(1, dt * 30);

    P.cooldown -= dt;
    P.flashT -= dt;
    if (P.autoReload > 0) { P.autoReload -= dt; if (P.autoReload <= 0) startReload(); }
    if (P.reloadT > 0) {
      P.reloadT -= dt;
      if (P.reloadT <= 0) { P.reloadT = 0; P.ammo = AMMO; }
    }
    if (mouse.down) tryFire();

    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      let dead = false;
      for (let s = 0; s < 4 && !dead; s++) {
        b.x += b.vx * dt / 4; b.y += b.vy * dt / 4;
        for (const t of targets) {
          if (t.alive && Math.abs(b.x - t.x) < 6 && b.y < t.y && b.y > t.y - 24) {
            t.alive = false; t.respawn = 1.6; shatter(t); dead = true; break;
          }
        }
        if (!dead && b.y >= gy) { impact(b.x, gy - 4); sparks(b.x, gy, 5, true); dust(b.x, gy, 3); dead = true; }
      }
      b.life -= dt;
      if (dead || b.life <= 0 || b.x < -50 || b.x > WORLD_W + 50 || b.y < -50) bullets.splice(i, 1);
    }

    for (const t of targets) {
      if (!t.alive) { t.respawn -= dt; if (t.respawn <= 0) { t.alive = true; t.pop = 0; } }
      t.pop = Math.min(1, t.pop + dt * 5);
    }

    // 모닥불 불씨
    for (const [name, x, h] of LAYOUT.back) {
      if (name !== 'campfire' || x < camX - 100 || x > camX + W + 100) continue;
      if (Math.random() < dt * 12) {
        particles.push({
          type: 'ember', x: x + rand(-8, 8), y: gy - 4 - h * 0.45, vx: rand(-15, 15), vy: rand(-80, -40),
          life: 0, max: rand(0.6, 1.2), size: rand(1, 2),
        });
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
        if (p.y > gy) { p.y = gy; p.vy *= -0.35; p.vx *= 0.6; p.vr *= 0.5; }
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }

    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].t += dt;
      if (flashes[i].t > 0.08) flashes.splice(i, 1);
    }

    shake = Math.max(0, shake - dt * 40);
  }

  // 현재 상태 → 그릴 애니메이션/프레임
  function playerState(t) {
    let anim = 'walk', i = 0, isIdle = false;
    if (P.dodgeT > 0) {
      anim = 'dodge';
      const n = A.meta.dodge.length;
      i = Math.min(n - 1, Math.floor((1 - P.dodgeT / DODGE_TIME) * n));
    } else if (!P.onGround) {
      anim = 'jump';
      i = P.airT < 0.08 ? 1 : P.vy < -280 ? 2 : P.vy < 280 ? 3 : 4;
    } else if (P.landT > 0) {
      anim = 'jump'; i = 5;
    } else if (Math.abs(P.vx) > 60) {
      anim = 'run'; i = Math.floor(P.runPhase) % 6;
    } else {
      isIdle = true;
    }
    const breath = isIdle ? Math.sin(t * 2.4) : 0;
    return {
      x: P.x, y: P.y, facing: P.facing, anim, i, idle: isIdle,
      sx: 1 + P.squash * 0.7 - breath * 0.006,
      sy: 1 - P.squash + breath * 0.014,
      R: P.aim, kick: P.kick,
      reload: P.reloadT > 0 ? 1 - P.reloadT / RELOAD_TIME : 0,
      flashT: P.flashT, showArm: anim !== 'dodge',
    };
  }

  // ---------- 그리기 ----------
  let last = 0, shakeX = 0, shakeY = 0, offX = 0, offY = 0; // off = 월드 → 화면 이동량

  function drawFrame(name, i, ax, ay, k) {
    const f = A.meta[name][i];
    ctx.drawImage(IMG[name], f.x, f.y, f.w, f.h, -ax * k, -ay * k, f.w * k, f.h * k);
  }

  // 소품: (cx, 바닥 y) 기준, 높이 h로
  function drawSprite(spr, name, cx, by, h) {
    const w = spr.w * h / spr.h;
    ctx.drawImage(spr.img, spr.sx, spr.sy, spr.w, spr.h, cx - w / 2, by - h + (SINK[name] || 0) * h, w, h);
  }

  function drawCharacter(S) {
    const f = A.meta[S.anim][S.i];
    const gy = groundY();
    const hgt = clamp((gy - S.y) / 250, 0, 1);
    ctx.fillStyle = `rgba(20,12,10,${0.3 * (1 - hgt * 0.7)})`;
    ctx.beginPath();
    ctx.ellipse(S.x, Math.max(S.y, gy) + 1, 30 * (1 - hgt * 0.4), 5 * (1 - hgt * 0.4), 0, 0, Math.PI * 2);
    ctx.fill();

    const k = BODY_K * frameScale(S.anim, S.i);
    ctx.save();
    ctx.translate(S.x, S.y);
    ctx.scale(S.facing * S.sx, S.sy);
    if (S.idle) {
      ctx.drawImage(idle.canvas, -(f.ax + idle.pad) * k, -f.ay * k, idle.canvas.width * k, idle.canvas.height * k);
    } else {
      drawFrame(S.anim, S.i, f.ax, f.ay, k);
    }
    ctx.restore();

    S.shoulder = {
      x: S.x + S.facing * ((f.sx - f.ax) * k - SHOULDER_BACK) * S.sx,
      y: S.y + ((f.sy - f.ay) * k + SHOULDER_DOWN) * S.sy,
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
      rot = lerp(S.R, 1.15, smooth(Math.min(p * 5, (1 - p) * 5)));
      if (p > 0.15 && p < 0.7) gunFrame = 4;                 // 실린더 열린 프레임
      spin = smooth((p - 0.7) / 0.3) * Math.PI * 2;          // 닫고 한 바퀴 돌리기
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

  // 하늘 · 먼 산 · 먼 실루엣 (화면 좌표, 카메라보다 느리게)
  function drawSky(gy) {
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
    for (const [name, x, h] of LAYOUT.fg) {
      const sx = x - camX * 1.15 + shakeX;
      if (sx < -200 || sx > W + 200) continue;
      drawSprite(TINT_FG[name], name, sx, H + h * 0.3, h);
    }
  }

  function drawEffects() {
    ctx.lineCap = 'round';
    for (const b of bullets) {
      ctx.strokeStyle = 'rgba(255,120,60,0.5)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = '#ffe2b0';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.008, b.y - b.vy * 0.008); ctx.lineTo(b.x, b.y); ctx.stroke();
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

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(20,8,6,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawHUD() {
    ctx.fillStyle = 'rgba(245,230,210,0.85)';
    ctx.font = '14px "Malgun Gothic", sans-serif';
    ctx.fillText('A/D 이동 · W/Space 점프 · Shift 구르기 · 마우스 조준 · 클릭 사격 · R 재장전', 20, 30);

    const shown = P.reloadT > 0 ? Math.floor((1 - P.reloadT / RELOAD_TIME) * (AMMO + 1)) : P.ammo;
    for (let i = 0; i < AMMO; i++) {
      const x = 24 + i * 18, y = H - 30;
      ctx.fillStyle = i < shown ? '#e8c27a' : 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 10); ctx.lineTo(x - 4, y - 4);
      ctx.quadraticCurveTo(x, y - 12, x + 4, y - 4);
      ctx.lineTo(x + 4, y + 10);
      ctx.closePath(); ctx.fill();
    }
    if (P.reloadT > 0) {
      ctx.fillStyle = 'rgba(245,230,210,0.9)';
      ctx.fillText('재장전 중...', 24 + AMMO * 18 + 8, H - 26);
    }

    const r = 8 + Math.max(0, P.kick) * 6;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#f4e6d0';
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f4e6d0';
    ctx.fillRect(mouse.x - 1, mouse.y - 1, 2, 2);
  }

  // 정렬 확인용: 모든 애니메이션 프레임 + 조준 각도 + 재장전 단계를 한 화면에
  function drawPreview(t) {
    ctx.fillStyle = '#d8cbb8';
    ctx.fillRect(0, 0, W, H);
    const dot = (x, y, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); };
    const base = { facing: 1, sx: 1, sy: 1, kick: 0, reload: 0, flashT: 0, idle: false };
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
    warpIdle(t);
    extra.forEach((e, i) => {
      const S = { ...base, anim: 'walk', i: 0, idle: true, x: 80 + i * 150, y: 750, showArm: true, ...e };
      drawCharacter(S);
      dot(S.shoulder.x, S.shoulder.y, 'red');
    });
  }

  // ---------- 루프 ----------
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    if (PREVIEW) {
      drawPreview(t);
      requestAnimationFrame(loop);
      return;
    }

    update(dt);

    const gy = groundY();
    shakeX = rand(-1, 1) * shake;
    shakeY = rand(-1, 1) * shake;
    offX = shakeX - camX;
    offY = shakeY;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(shakeX * 0.5, shakeY * 0.5);
    drawSky(gy);
    ctx.restore();

    ctx.save();
    ctx.translate(offX, offY);
    drawGround(gy);
    drawBackProps(gy, t);
    drawTargets();
    const S = playerState(t);
    if (S.idle) warpIdle(t);
    drawCharacter(S);
    P.shoulder = S.shoulder;
    if (S.muzzle) P.muzzle = S.muzzle;
    drawEffects();
    ctx.restore();

    drawForeground();
    drawVignette();
    drawHUD();

    requestAnimationFrame(loop);
  }
})();
