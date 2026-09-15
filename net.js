// PeerJS 온라인 PVP (방장/게스트)
window.GunNet = (() => {
  const PREFIX = 'gunslinger-pvp-';
  const NOT_FOUND = '수배 대상자를 찾을 수 없습니다';
  let peer = null, conn = null;
  let role = null; // 'host' | 'guest'
  let roomCode = '';
  let joinTimer = null;
  let gen = 0;
  let onStatus = () => {};
  let onReady = () => {};
  let onMessage = () => {};

  function setHandlers({ status, ready, message } = {}) {
    if (status) onStatus = status;
    if (ready) onReady = ready;
    if (message) onMessage = message;
  }

  function makeCode() {
    return String(Math.floor(1000 + Math.random() * 9000)); // 1000~9999
  }

  function normalizeCode(code) {
    return String(code || '').replace(/\D/g, '').slice(0, 4);
  }

  function codeFromId(id) {
    return normalizeCode(String(id || '').replace(PREFIX, ''));
  }

  function statusFromError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable' || type === 'network' || type === 'server-error') {
      return NOT_FOUND;
    }
    if (type === 'unavailable-id') return '수배 번호를 다시 게시합니다…';
    return NOT_FOUND;
  }

  function live(g) {
    return g === gen;
  }

  function teardown() {
    gen += 1;
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
    const oldConn = conn;
    const oldPeer = peer;
    conn = null;
    peer = null;
    role = null;
    roomCode = '';
    try { if (oldConn) oldConn.close(); } catch (_) {}
    try { if (oldPeer) oldPeer.destroy(); } catch (_) {}
  }

  function wireConn(c, g) {
    if (!live(g)) return;
    conn = c;
    c.on('data', data => { if (live(g)) onMessage(data); });
    c.on('close', () => { if (live(g)) onStatus('연결 끊김'); });
    c.on('error', () => { if (live(g)) onStatus(NOT_FOUND); });
    const ready = () => {
      if (!live(g)) return;
      if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
      onReady(role, roomCode);
    };
    if (c.open) ready();
    else {
      c.on('open', ready);
      if (role === 'guest') {
        joinTimer = setTimeout(() => {
          if (!live(g)) return;
          if (!conn || !conn.open) onStatus(NOT_FOUND);
        }, 4000);
      }
    }
  }

  function listenHost(p, g) {
    p.on('open', id => {
      if (!live(g) || peer !== p) return;
      roomCode = codeFromId(id) || roomCode;
      onStatus('수배 번호: ' + roomCode + '\n(현상금 사냥꾼 대기 중)');
    });
    p.on('connection', c => {
      if (!live(g) || peer !== p) return;
      onStatus('사냥꾼이 수락했습니다');
      wireConn(c, g);
    });
    p.on('error', err => {
      if (!live(g) || peer !== p) return;
      if (err && err.type === 'unavailable-id') {
        try { p.destroy(); } catch (_) {}
        if (!live(g)) return;
        roomCode = makeCode();
        onStatus('수배 번호를 다시 게시합니다…');
        peer = new Peer(PREFIX + roomCode, { debug: 0 });
        listenHost(peer, g);
        return;
      }
      onStatus(statusFromError(err));
    });
  }

  function host() {
    teardown();
    role = 'host';
    roomCode = makeCode();
    const g = gen;
    onStatus('수배 게시 중…');
    peer = new Peer(PREFIX + roomCode, { debug: 0 });
    listenHost(peer, g);
  }

  function join(code) {
    teardown();
    role = 'guest';
    roomCode = normalizeCode(code);
    const g = gen;
    if (roomCode.length !== 4) { onStatus('숫자 4자리 수배 번호를 입력하세요'); return; }
    onStatus('연결 중…');
    peer = new Peer({ debug: 0 });
    peer.on('open', () => {
      if (!live(g) || !peer) return;
      const c = peer.connect(PREFIX + roomCode, { reliable: true });
      wireConn(c, g);
      onStatus('연결 중…');
    });
    peer.on('error', err => {
      if (!live(g)) return;
      onStatus(statusFromError(err));
    });
  }

  function send(data) {
    if (conn && conn.open) conn.send(data);
  }

  function cancel() {
    teardown();
    onStatus('');
  }

  function getRole() { return role; }
  function getCode() { return roomCode; }
  function isReady() { return !!(conn && conn.open); }

  return { setHandlers, host, join, send, cancel, getRole, getCode, isReady };
})();
