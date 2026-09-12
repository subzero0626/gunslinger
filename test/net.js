// PeerJS 온라인 PVP (방장/게스트)
window.GunNet = (() => {
  const PREFIX = 'gunslinger-pvp-';
  let peer = null, conn = null;
  let role = null; // 'host' | 'guest'
  let roomCode = '';
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

  function wireConn(c) {
    conn = c;
    c.on('data', data => onMessage(data));
    c.on('close', () => onStatus('연결 끊김'));
    c.on('error', err => onStatus('연결 오류: ' + (err.message || err)));
    if (c.open) onReady(role, roomCode);
    else c.on('open', () => onReady(role, roomCode));
  }

  function host() {
    role = 'host';
    roomCode = makeCode();
    onStatus('수배 게시 중…');
    peer = new Peer(PREFIX + roomCode, { debug: 0 });
    peer.on('open', id => {
      roomCode = codeFromId(id) || roomCode;
      onStatus('수배 번호: ' + roomCode + '\n(현상금 사냥꾼 대기 중)');
    });
    peer.on('connection', c => {
      onStatus('사냥꾼이 수락했습니다');
      wireConn(c);
    });
    peer.on('error', err => {
      if (err && err.type === 'unavailable-id') {
        try { peer.destroy(); } catch (_) {}
        roomCode = makeCode();
        peer = new Peer(PREFIX + roomCode, { debug: 0 });
        peer.on('open', id => {
          roomCode = codeFromId(id) || roomCode;
          onStatus('수배 번호: ' + roomCode + '\n(현상금 사냥꾼 대기 중)');
        });
        peer.on('connection', c => {
          onStatus('사냥꾼이 수락했습니다');
          wireConn(c);
        });
        peer.on('error', e2 => onStatus('오류: ' + (e2.type || e2.message || e2)));
        return;
      }
      onStatus('오류: ' + (err.type || err.message || err));
    });
  }

  function join(code) {
    role = 'guest';
    roomCode = normalizeCode(code);
    if (roomCode.length !== 4) { onStatus('숫자 4자리 수배 번호를 입력하세요'); return; }
    onStatus('수배 확인 중…');
    peer = new Peer({ debug: 0 });
    peer.on('open', () => {
      const c = peer.connect(PREFIX + roomCode, { reliable: true });
      wireConn(c);
      onStatus('현상금 수락 요청 중…');
    });
    peer.on('error', err => onStatus('오류: ' + (err.type || err.message || err)));
  }

  function send(data) {
    if (conn && conn.open) conn.send(data);
  }

  function cancel() {
    try { if (conn) conn.close(); } catch (_) {}
    try { if (peer) peer.destroy(); } catch (_) {}
    peer = null;
    conn = null;
    role = null;
    roomCode = '';
    onStatus('');
  }

  function getRole() { return role; }
  function getCode() { return roomCode; }
  function isReady() { return !!(conn && conn.open); }

  return { setHandlers, host, join, send, cancel, getRole, getCode, isReady };
})();
