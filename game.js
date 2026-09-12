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
  const IMG = {};
  const BG_GROUND = 0.778; // bg.png 지면 라인 (이미지 높이 비율)
  const groundY = () => {
    const bg = IMG.bg;
    if (bg && bg.width) {
      const scale = Math.max(W / bg.width, H / bg.height);
      const dy = (H - bg.height * scale) * 0.5;
      return Math.round(dy + bg.height * BG_GROUND * scale);
    }
    return Math.round(H * 0.78);
  };
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
  const BODY_H = 110;                       // 화면에서 캐릭터 키(px)
  const BODY_K = BODY_H / A.meta.walk[0].h;
  const MAX_HP = 10;
  const DMG_BODY = 1, DMG_HEAD = 3;
  const ARM_K = BODY_K * 0.62 * 0.84;
  const GUN_K = BODY_K * 0.55 * 0.84;
  const ARM_FRAME = 2;                      // 팔을 앞으로 뻗은 프레임
  const AMMO = 6, RELOAD_TIME = 1.1, DODGE_TIME = 0.5;
  const RUN_SPEED = 375, BACK_SPEED = RUN_SPEED * 0.65, DODGE_SPEED = 720, JUMP_V = 880;
  const BULLET_SPEED = 3200;
  const RUN_STRIDE = 26;                    // 프레임 1장당 이동 거리(px) → 발 미끄러짐 방지
  // 시트마다 캐릭터가 그려진 크기가 달라서 모자 폭 기준으로 맞춤 (walk = 1)
  const ANIM_SCALE = { walk: 1, run: 1.26, jump: 1.13, dodge: 1.17 };
  const frameScale = (anim) => ANIM_SCALE[anim];
  const SHOULDER_BACK = 25, SHOULDER_DOWN = 5; // 어깨를 몸 안쪽·위쪽으로 (화면 px)
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

  const sources = {
    ...A.images,
    props: PR.image,
    bg: 'assets/bg.png',
    wantedBoard: 'assets/wanted-board.png',
    wantedPaper: 'assets/wanted-paper.png',
  };
  let pending = Object.keys(sources).length;
  for (const [name, src] of Object.entries(sources)) {
    const im = new Image();
    im.onload = () => { if (--pending === 0) start(); };
    im.onerror = () => { console.warn('failed to load', name); if (--pending === 0) start(); };
    im.src = src;
    IMG[name] = im;
  }

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
  let netReady = false;
  let myRole = null; // 'host' | 'guest'
  let me = null, other = null;
  let netAcc = 0;
  const board = { x: 0, y: 0, open: false, near: false, status: '', h: 160, w: 200 };
  const wantedStatusEl = document.getElementById('wantedStatus');
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
    if (!wantedStatusEl) return;
    if (!board.status || netReady) {
      wantedStatusEl.classList.remove('show', 'update');
      wantedStatusEl.innerHTML = '';
      return;
    }
    const m = board.status.match(/수배 번호:\s*(\d{4})/);
    const body = m
      ? '수배 번호<span class="code">' + m[1] + '</span>현상금 사냥꾼 대기 중'
      : board.status.replace(/</g, '&lt;');
    const already = wantedStatusEl.classList.contains('show');
    wantedStatusEl.innerHTML = '<button type="button" class="close" aria-label="닫기">×</button>' + body;

    if (!already) {
      wantedStatusEl.classList.remove('update');
      wantedStatusEl.classList.remove('show');
      void wantedStatusEl.offsetWidth;
      wantedStatusEl.classList.add('show');
    } else {
      wantedStatusEl.classList.remove('update');
      void wantedStatusEl.offsetWidth;
      wantedStatusEl.classList.add('update');
    }
  }

  function cancelWantedLobby() {
    if (window.GunNet) GunNet.cancel();
    myRole = null;
    me = players[0];
    other = null;
    netReady = false;
    setPortalStatus('');
  }

  if (wantedStatusEl) {
    wantedStatusEl.addEventListener('click', e => {
      if (e.target && e.target.classList && e.target.classList.contains('close')) {
        cancelWantedLobby();
      }
    });
  }

  function placePortal() {
    board.x = W * 0.62;
    board.y = groundY();
  }

  async function openWantedMenu() {
    if (!window.Swal || netReady || board.open) return;
    board.open = true;
    const result = await Swal.fire({
      ...swalWanted,
      title: '현상수배',
      text: '결투를 게시하거나 수락하시오',
      showDenyButton: true,
      showCancelButton: true,
      confirmButtonText: '수배지 붙이기 (생성)',
      denyButtonText: '현상금 수락 (참가)',
      cancelButtonText: '닫기',
      reverseButtons: true,
    });
    board.open = false;

    if (result.isConfirmed) {
      bindRoles('host');
      GunNet.host();
    } else if (result.isDenied) {
      let joined = false;
      const joinNow = code => {
        const n = String(code || '').replace(/\D/g, '').slice(0, 4);
        if (n.length !== 4 || joined) return false;
        joined = true;
        GunNet.join(n);
        if (Swal.isVisible()) Swal.close();
        return true;
      };
      await Swal.fire({
        ...swalWanted,
        title: '현상금 수락',
        html: '<p style="margin:0 0 8px;opacity:.75">수배 번호 4자리를 입력하면 바로 들어갑니다</p>',
        input: 'text',
        inputPlaceholder: '0000',
        inputAttributes: {
          maxlength: '4',
          inputmode: 'numeric',
          pattern: '[0-9]*',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: 'false',
        },
        showCancelButton: true,
        showConfirmButton: false,
        cancelButtonText: '취소',
        allowEnterKey: true,
        didOpen: () => {
          const input = Swal.getInput();
          if (!input) return;
          input.setAttribute('maxlength', '4');
          setTimeout(() => input.focus(), 30);
          const onType = () => {
            const digits = String(input.value || '').replace(/\D/g, '').slice(0, 4);
            if (input.value !== digits) input.value = digits;
            if (digits.length === 4) joinNow(digits);
          };
          input.addEventListener('input', onType);
          input.addEventListener('keyup', onType);
          input.addEventListener('paste', () => setTimeout(onType, 0));
        },
        preConfirm: () => {
          const input = Swal.getInput();
          const n = String(input?.value || '').replace(/\D/g, '').slice(0, 4);
          if (n.length !== 4) {
            Swal.showValidationMessage('숫자 4자리를 입력하세요');
            return false;
          }
          joinNow(n);
          return n;
        },
      });
    }
  }

  function setPortalOpen(v) {
    board.open = v;
    if (!v && window.Swal) Swal.close();
  }

  // ---------- 입력 ----------
  const keys = {};
  const mouse = { x: W * 0.7, y: H * 0.6, down: false };
  addEventListener('keydown', e => {
    if (e.repeat || !me) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    keys[e.code] = true;
    if (e.code === 'Space' || e.code === 'KeyW') { me.jumpQueued = 0.12; e.preventDefault(); }
    if (e.code === 'KeyR') startReload(me);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') startDodge(me, moveDir());
    if (e.code === 'KeyE' && board.near && !netReady) {
      openWantedMenu();
      e.preventDefault();
    }
    if (e.code === 'Escape' && board.open) setPortalOpen(false);
  });
  addEventListener('keyup', e => { keys[e.code] = false; });
  cvs.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  cvs.addEventListener('mousedown', e => {
    if (e.button === 0) { mouse.down = true; if (me && !board.open) tryFire(me); }
  });
  addEventListener('mouseup', () => { mouse.down = false; });
  cvs.addEventListener('contextmenu', e => e.preventDefault());

  function moveDir() {
    return (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  }

  // ---------- 플레이어 ----------
  function makePlayer(id, skin) {
    return {
      id, skin,
      x: 0, y: 0, vx: 0, vy: 0, onGround: true, init: false,
      facing: 1, aim: 0,
      runPhase: 0, airT: 0, landT: 0,
      squash: 0, squashV: 0, kick: 0, kickV: 0,
      ammo: AMMO, reloadT: 0, autoReload: 0, cooldown: 0, flashT: 0,
      dodgeT: 0, dodgeDir: 1, dodgeCD: 0,
      shoulder: { x: 0, y: 0 }, muzzle: { x: 0, y: 0 },
      hp: MAX_HP, hpShow: MAX_HP, hpDrain: 1, invuln: 0, jumpQueued: 0,
    };
  }
  const players = [makePlayer(0, 'host'), makePlayer(1, 'guest')];
  me = players[0];

  function bindRoles(role) {
    myRole = role;
    me = role === 'host' ? players[0] : players[1];
    other = role === 'host' ? players[1] : players[0];
  }

  function resetMatchSpawn() {
    const gy = groundY();
    players[0].x = W * 0.28;
    players[0].y = gy;
    players[0].vx = 0; players[0].vy = 0;
    players[0].facing = 1;
    players[0].onGround = true;
    players[0].init = true;
    players[0].hp = MAX_HP; players[0].hpShow = MAX_HP;
    players[0].ammo = AMMO; players[0].reloadT = 0;
    players[0].invuln = 0; players[0].dodgeT = 0;

    players[1].x = W * 0.72;
    players[1].y = gy;
    players[1].vx = 0; players[1].vy = 0;
    players[1].facing = -1;
    players[1].onGround = true;
    players[1].init = true;
    players[1].hp = MAX_HP; players[1].hpShow = MAX_HP;
    players[1].ammo = AMMO; players[1].reloadT = 0;
    players[1].invuln = 0; players[1].dodgeT = 0;
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
      hp: pl.hp, invuln: pl.invuln,
    };
  }

  function applyRemoteState(pl, s) {
    pl.x = lerp(pl.x, s.x, pl.init ? 0.55 : 1);
    pl.y = lerp(pl.y, s.y, pl.init ? 0.55 : 1);
    pl.vx = s.vx; pl.vy = s.vy;
    pl.facing = s.facing; pl.aim = s.aim; pl.onGround = s.onGround;
    pl.runPhase = s.runPhase; pl.airT = s.airT; pl.landT = s.landT;
    pl.squash = s.squash; pl.kick = s.kick;
    pl.ammo = s.ammo; pl.reloadT = s.reloadT; pl.autoReload = s.autoReload;
    pl.cooldown = s.cooldown; pl.flashT = s.flashT;
    pl.dodgeT = s.dodgeT; pl.dodgeDir = s.dodgeDir; pl.dodgeCD = s.dodgeCD;
    pl.hp = s.hp; pl.invuln = s.invuln;
    if (typeof s.hp === 'number' && pl.hpShow != null && pl.hpShow - s.hp >= DMG_HEAD - 0.1) {
      pl.hpDrain = 3;
    }
    pl.init = true;
  }

  function onNetMessage(data) {
    if (!data || !other) return;
    if (data.t === 'state') applyRemoteState(other, data);
    else if (data.t === 'fire') {
      bullets.push({
        x: data.x, y: data.y, vx: data.vx, vy: data.vy,
        life: 1.2, ownerId: data.ownerId, net: true,
      });
      flashes.push({ x: data.x, y: data.y, t: 0 });
    }
  }

  if (window.GunNet) {
    GunNet.setHandlers({
      status: setPortalStatus,
      ready: role => {
        bindRoles(role);
        resetMatchSpawn();
        netReady = true;
        setPortalOpen(false);
        setPortalStatus('');
        if (window.Swal) {
          Swal.fire({
            ...swalWanted,
            title: '결투 성사',
            text: role === 'host' ? '사냥꾼이 수락했습니다' : '결투장에 입장했습니다',
            timer: 1600,
            showConfirmButton: false,
          });
        }
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
    for (const pl of players) if (pl.onGround) pl.y = groundY();
  });

  function startReload(pl) {
    if (pl.reloadT > 0 || pl.ammo === AMMO) return;
    pl.reloadT = RELOAD_TIME;
  }

  function startDodge(pl, moveDir) {
    if (pl.dodgeT > 0 || pl.dodgeCD > 0 || !pl.onGround) return;
    pl.dodgeDir = moveDir || pl.facing;
    pl.dodgeT = DODGE_TIME;
    pl.dodgeCD = 1;
    pl.vx = pl.dodgeDir * DODGE_SPEED;
    dust(pl.x, pl.y, 6);
  }

  function tryFire(pl) {
    if (!me || pl !== me) return;
    if (pl.reloadT > 0 || pl.cooldown > 0 || pl.dodgeT > 0) return;
    if (pl.ammo <= 0) { startReload(pl); return; }
    pl.ammo--;
    pl.cooldown = 0.35;
    const airborne = !pl.onGround;
    pl.kickV += airborne ? 48 : 34;
    pl.flashT = 0.06;
    shake = Math.min(shake + (airborne ? 7 : 4), airborne ? 12 : 8);
    let a = pl.facing === 1 ? pl.aim : Math.PI - pl.aim;
    if (airborne) a += rand(-0.04, 0.04); // 공중 사격: 아주 약한 탄퍼짐
    const { x, y } = pl.muzzle;
    const vx = Math.cos(a) * BULLET_SPEED, vy = Math.sin(a) * BULLET_SPEED;
    bullets.push({ x, y, vx, vy, life: 1.2, ownerId: pl.id });
    flashes.push({ x, y, t: 0 });
    if (netReady && window.GunNet) GunNet.send({ t: 'fire', x, y, vx, vy, ownerId: pl.id });
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
  function updatePlayer(pl, input, dt, gy) {
    const dir = input.dir;
    const prevFacing = pl.facing;

    if (pl.dodgeT > 0) {
      pl.dodgeT -= dt;
      pl.facing = pl.dodgeDir;
      pl.vx = pl.dodgeDir * DODGE_SPEED * lerp(0.35, 1, pl.dodgeT / DODGE_TIME);
    } else {
      // 조준점 방향 우선, 캐릭터 근처(데드존)일 때만 이동 방향으로 돌아섬
      if (input.aimX > pl.x + 6) pl.facing = 1;
      else if (input.aimX < pl.x - 6) pl.facing = -1;
      else if (dir !== 0) pl.facing = dir;
      const backing = dir !== 0 && dir !== pl.facing;
      pl.vx = approach(pl.vx, dir * (backing ? BACK_SPEED : RUN_SPEED), (pl.onGround ? 2200 : 1300) * dt);
    }
    pl.dodgeCD -= dt;
    pl.x = clamp(pl.x + pl.vx * dt, 40, W - 40);

    pl.jumpQueued -= dt;
    if (pl.jumpQueued > 0 && pl.onGround && pl.dodgeT <= 0) {
      pl.vy = -JUMP_V; pl.onGround = false; pl.airT = 0; pl.squashV -= 2.6; pl.jumpQueued = 0;
      dust(pl.x, gy, 5);
    }
    pl.vy += 2300 * dt;
    pl.y += pl.vy * dt;
    if (pl.y >= gy) {
      if (!pl.onGround) {
        pl.squashV += clamp(pl.vy / 900, 0.5, 1.5) * 2.6;
        pl.landT = 0.1;
        dust(pl.x, gy, 8);
      }
      pl.y = gy; pl.vy = 0; pl.onGround = true;
    } else {
      pl.onGround = false;
      pl.airT += dt;
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

    pl.cooldown -= dt;
    pl.flashT -= dt;
    pl.invuln = Math.max(0, pl.invuln - dt);
    if (pl.autoReload > 0) { pl.autoReload -= dt; if (pl.autoReload <= 0) startReload(pl); }
    if (pl.reloadT > 0) {
      pl.reloadT -= dt;
      if (pl.reloadT <= 0) { pl.reloadT = 0; pl.ammo = AMMO; }
    }
  }

  function hitBox(pl, b) {
    const hx = 22, top = pl.y - BODY_H * 0.95, bot = pl.y - 8;
    return Math.abs(b.x - pl.x) <= hx && b.y >= top && b.y <= bot;
  }

  // 머리(모자) 구간: 캐릭터 상단 ~35%
  function isHeadshot(pl, b) {
    const headBot = pl.y - BODY_H * 0.58;
    const headTop = pl.y - BODY_H * 0.98;
    return b.y >= headTop && b.y <= headBot;
  }

  function hitPlayer(pl, b) {
    if (pl.invuln > 0 || pl.hp <= 0 || pl.dodgeT > 0) return false;
    if (!hitBox(pl, b)) return false;
    const head = isHeadshot(pl, b);
    const dmg = head ? DMG_HEAD : DMG_BODY;
    pl.hp = Math.max(0, pl.hp - dmg);
    pl.hpDrain = head ? 3 : 1; // 헤드샷이면 체력바도 3배 빠르게
    pl.invuln = 0.95;
    pl.vx += Math.sign(b.vx || 1) * (head ? 420 : 320);
    pl.vy -= head ? 280 : 220;
    pl.onGround = false;
    pl.squashV += head ? 3 : 2;
    impact(b.x, b.y);
    sparks(b.x, b.y, head ? 10 : 6, false);
    shake = Math.min(shake + (head ? 9 : 6), 14);
    if (head) headFlash = 0.22;
    return true;
  }

  function update(dt) {
    if (!me) return;
    const gy = groundY();
    if (!board.x) placePortal();
    else board.y = gy;

    if (!me.init) {
      me.x = W * 0.28; me.y = gy; me.facing = 1; me.init = true;
      camX = 0;
      placePortal();
    }

    updatePlayer(me, {
      dir: moveDir(),
      aimX: mouse.x + camX,
      aimY: mouse.y,
    }, dt, gy);

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
      board.near = Math.abs(me.x - board.x) < board.w * 0.55 && Math.abs(me.y - board.y) < 40;
      if (!board.near && board.open) setPortalOpen(false);
    } else {
      board.near = false;
    }

    camX = 0;

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
        if (netReady) {
          if (!dead && other && b.ownerId === me.id && other.hp > 0 && hitBox(other, b)) {
            impact(b.x, b.y); sparks(b.x, b.y, 6, false);
            if (isHeadshot(other, b)) {
              headFlash = 0.18;
              shake = Math.min(shake + 7, 12);
              sparks(b.x, b.y, 8, false);
            }
            dead = true;
          }
          if (!dead && b.ownerId !== me.id && hitPlayer(me, b)) dead = true;
        }
        if (!dead && b.y >= gy) { impact(b.x, gy - 4); sparks(b.x, gy, 5, true); dust(b.x, gy, 3); dead = true; }
      }
      b.life -= dt;
      if (dead || b.life <= 0 || b.x < -50 || b.x > W + 50 || b.y < -50) bullets.splice(i, 1);
    }

    netAcc += dt;
    if (netReady && netAcc >= 1 / 30 && window.GunNet) {
      netAcc = 0;
      GunNet.send(packState(me));
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
  function playerState(pl, t) {
    let anim = 'walk', i = 0, isIdle = false;
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
      anim = backing ? 'walk' : 'run';
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
      reload: pl.reloadT > 0 ? 1 - pl.reloadT / RELOAD_TIME : 0,
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
    const gy = groundY();
    const hgt = clamp((gy - S.y) / 250, 0, 1);
    const skin = S.skin || 'host';
    const idleObj = skin === 'guest' ? idleBlue : idle;
    ctx.fillStyle = `rgba(20,12,10,${0.3 * (1 - hgt * 0.7)})`;
    ctx.beginPath();
    ctx.ellipse(S.x, Math.max(S.y, gy) + 1, 30 * (1 - hgt * 0.4), 5 * (1 - hgt * 0.4), 0, 0, Math.PI * 2);
    ctx.fill();

    const k = BODY_K * frameScale(S.anim);
    const recoil = Math.max(0, S.kick);
    const rx = -S.facing * recoil * 5 + (recoil > 0.08 ? (Math.random() - 0.5) * recoil * 4 : 0);
    const ry = -recoil * 2.5 + (recoil > 0.08 ? (Math.random() - 0.5) * recoil * 3 : 0);
    ctx.save();
    let alpha = 1;
    if (S.invuln > 0 && Math.floor(S.invuln * 18) % 2 === 0) alpha *= 0.35;
    if (S.anim === 'dodge') {
      alpha *= 0.75;
      ctx.filter = 'blur(0.8px)';
    }
    ctx.globalAlpha = alpha;
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
    const bg = IMG.bg;
    if (bg && bg.width) {
      const scale = Math.max(W / bg.width, H / bg.height);
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
      const dx = b.vx / BULLET_SPEED, dy = b.vy / BULLET_SPEED;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,140,70,0.25)';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 55, b.y - dy * 55); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,190,110,0.45)';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 32, b.y - dy * 32); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,240,200,0.9)';
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(b.x - dx * 14, b.y - dy * 14); ctx.lineTo(b.x, b.y); ctx.stroke();
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
    const g = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(20,8,6,0.45)');
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
    const maxHp = MAX_HP;
    const bw = 62, bh = 7, r = 3.5;
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

  function drawWantedPosterSprite(cx, by, h, seed, rot = 0) {
    const spr = IMG.wantedPaper;
    if (!spr || !spr.width) return;
    const tilt = rot + Math.sin(seed * 7) * 0.03;
    const w = spr.width * h / spr.height;
    ctx.save();
    ctx.translate(cx, by - h * 0.5);
    ctx.rotate(tilt);
    ctx.drawImage(spr, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawWantedBoard(t) {
    if (netReady) return;
    const x = board.x, gy = board.y;
    const boardImg = IMG.wantedBoard;
    const bw = board.w, bh = Math.round(bw * 0.62);

    let boardTop, boardH;
    if (boardImg && boardImg.width) {
      boardH = boardImg.height * (bw / boardImg.width);
      boardTop = gy - boardH + 4 - 6;
      ctx.save();
      ctx.filter = 'brightness(0.78)';
      ctx.drawImage(boardImg, x - bw / 2, boardTop, bw, boardH);
      ctx.restore();
    } else {
      boardH = bh;
      boardTop = gy - board.h - 6;
      ctx.fillStyle = '#4a3224';
      ctx.fillRect(x - bw / 2, boardTop, bw, bh);
    }

    // 수배지 3장 — 조금 더 크게, 아래로
    const posters = [
      { dx: -48, dy: 78, h: 68, seed: 3.1, rot: -0.14 },
      { dx: 0, dy: 82, h: 72, seed: 5.7, rot: 0.08 },
      { dx: 48, dy: 76, h: 66, seed: 8.2, rot: 0.16 },
    ];
    for (const p of posters) {
      const sway = Math.sin(t * 1.4 + p.seed) * 0.4;
      drawWantedPosterSprite(x + p.dx + sway * 0.2, boardTop + p.dy, p.h, p.seed, p.rot);
    }

    if (board.near && !board.open) {
      const label = '[E] 현상수배';
      const ty = boardTop - 18;
      ctx.font = 'bold 15px "Malgun Gothic", sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(18, 10, 6, 0.78)';
      ctx.fillRect(x - tw / 2 - 10, ty - 16, tw + 20, 26);
      ctx.strokeStyle = 'rgba(244, 230, 208, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - tw / 2 - 10, ty - 16, tw + 20, 26);
      ctx.fillStyle = '#fff6e0';
      ctx.fillText(label, x, ty);
      ctx.textAlign = 'left';
    }
  }

  function drawHUD() {
    if (!me) return;

    // 내 탄약만 (게스트도 노란색)
    const shown = me.reloadT > 0 ? Math.floor((1 - me.reloadT / RELOAD_TIME) * (AMMO + 1)) : me.ammo;
    const ammoRight = me.skin === 'guest';
    for (let i = 0; i < AMMO; i++) {
      const x = ammoRight ? W - 24 - i * 18 : 24 + i * 18;
      const y = H - 30;
      ctx.fillStyle = i < shown ? '#e8c27a' : 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 10); ctx.lineTo(x - 4, y - 4);
      ctx.quadraticCurveTo(x, y - 12, x + 4, y - 4);
      ctx.lineTo(x + 4, y + 10);
      ctx.closePath(); ctx.fill();
    }
    if (me.reloadT > 0) {
      ctx.fillStyle = 'rgba(245,230,210,0.9)';
      ctx.font = '14px "Malgun Gothic", sans-serif';
      if (ammoRight) {
        ctx.textAlign = 'right';
        ctx.fillText('재장전 중...', W - 24 - AMMO * 18 - 4, H - 26);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText('재장전 중...', 24 + AMMO * 18 + 8, H - 26);
      }
    }

    // 조준점 (내 마우스)
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
    if (!netReady) drawWantedBoard(t);
    {
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
    }
    drawEffects();
    ctx.restore();

    drawForeground();
    drawVignette();
    drawHeadFlash();
    drawHUD();

    requestAnimationFrame(loop);
  }
})();
