/* Home page: nickname, create / join / rejoin a room, QR scanning. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  const ROOM_RE = /^[A-Z0-9]{4,16}$/;

  const nameForm = $('name-form');
  const roomPanel = $('room-panel');
  const nicknameInput = $('nickname');
  let userName = WBG.store.get('userName');
  if (userName && !WBG.NAME_RE.test(userName)) userName = null;

  /* ---------------------------------------------------------------- panels */
  function show(panel) {
    $('entry-skeleton').hidden = true;
    for (const p of [nameForm, roomPanel]) {
      const on = p === panel;
      p.hidden = !on;
      if (on) p.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    }
  }

  function showRoomPanel() {
    $('hello-name').textContent = userName;
    $('hello-avatar').innerHTML = WBG.avatar(userName, 'size-10');
    show(roomPanel);
    checkRejoin();
  }

  function showNamePanel() {
    nicknameInput.value = userName || '';
    $('char-count').textContent = `${nicknameInput.value.length}/16`;
    show(nameForm);
    nicknameInput.focus({ preventScroll: true });
  }

  /* -------------------------------------------------------------- nickname */
  nicknameInput.addEventListener('input', () => {
    $('char-count').textContent = `${nicknameInput.value.length}/16`;
    nicknameInput.removeAttribute('aria-invalid');
    $('name-error').hidden = true;
  });

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nicknameInput.value.trim();
    const error = $('name-error');
    if (!WBG.NAME_RE.test(name)) {
      error.textContent = name.length < 3
        ? 'Nickname must be at least 3 characters.'
        : 'Use 3-16 letters, numbers, spaces, "_", "-" or ".".';
      error.hidden = false;
      nicknameInput.setAttribute('aria-invalid', 'true');
      nicknameInput.focus();
      return;
    }
    userName = name;
    WBG.store.set('userName', name);
    showRoomPanel();
  });

  $('change-name').addEventListener('click', showNamePanel);

  /* ----------------------------------------------------------------- rooms */
  function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  }

  function enterRoom(code, { spectate = false } = {}) {
    WBG.store.set('wbg.lastRoom', code);
    try {
      if (spectate) sessionStorage.setItem(`wbg.spectate.${code}`, '1');
      else sessionStorage.removeItem(`wbg.spectate.${code}`);
    } catch { /* storage blocked */ }
    location.href = `/game?room=${code}`;
  }

  $('create-room').addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    enterRoom(randomCode(), { spectate: $('host-only').checked });
  });

  /** Accepts a bare code, a full room link, or pasted text containing either. */
  function extractCode(text) {
    const raw = String(text || '').trim();
    try {
      const room = new URL(raw).searchParams.get('room');
      if (room) return room.toUpperCase();
    } catch { /* not a URL */ }
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  }

  const codeInput = $('room-code');
  const joinError = $('join-error');

  function setJoinError(message) {
    joinError.textContent = message || '';
    joinError.hidden = !message;
    if (message) codeInput.setAttribute('aria-invalid', 'true');
    else codeInput.removeAttribute('aria-invalid');
  }

  codeInput.addEventListener('input', () => {
    codeInput.value = extractCode(codeInput.value).slice(0, 6);
    setJoinError('');
  });

  async function joinRoom(code) {
    if (!ROOM_RE.test(code)) return setJoinError('Enter the 4-16 character room code.');
    const btn = $('join-btn');
    btn.disabled = true;
    btn.innerHTML = WBG.icon('spinner', 'size-4 animate-spin') + 'Checking...';
    try {
      const res = await fetch(`/api/room/check?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
      const info = await res.json();
      if (!info.exists) throw new Error('No room with that code. Check it, or create a new room.');
      if (info.started) throw new Error('That room has already started a game.');
      enterRoom(code);
    } catch (err) {
      setJoinError(err instanceof SyntaxError ? 'Could not reach the server. Try again.' : err.message);
      btn.disabled = false;
      btn.textContent = 'Join room';
    }
  }

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom(extractCode(codeInput.value));
  });

  /* ---------------------------------------------------------------- rejoin */
  async function checkRejoin() {
    const last = WBG.store.get('wbg.lastRoom');
    if (!last || !ROOM_RE.test(last)) return;
    try {
      const info = await (await fetch(`/api/room/check?code=${last}`, { cache: 'no-store' })).json();
      if (!info.exists) return WBG.store.remove('wbg.lastRoom');
      $('rejoin-code').textContent = last;
      $('rejoin').hidden = false;
      $('rejoin').onclick = () => enterRoom(last);
    } catch { /* offline: no rejoin chip */ }
  }

  /* ----------------------------------------------------------- QR scanning */
  const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  let stream = null;
  let scanning = false;

  async function startScan() {
    const status = $('scan-status');
    WBG.openModal('scan-modal');
    status.textContent = 'Starting camera...';
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = $('scan-video');
      video.srcObject = stream;
      await video.play();
      status.textContent = "Point your camera at the QR code on the host's screen.";
      scanning = true;
      const tick = async () => {
        if (!scanning) return;
        try {
          const found = await detector.detect(video);
          const code = found.length && extractCode(found[0].rawValue);
          if (code && ROOM_RE.test(code)) {
            scanning = false;
            WBG.haptic(30);
            status.textContent = `Found room ${code}...`;
            return enterRoom(code);
          }
        } catch { /* frame not ready */ }
        setTimeout(tick, 180);
      };
      tick();
    } catch {
      status.textContent = 'Camera unavailable. Allow camera access, or type the room code instead.';
    }
  }

  function stopScan() {
    scanning = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  if (canScan) {
    $('scan-btn').hidden = false;
    $('scan-btn').addEventListener('click', startScan);
    $('scan-modal').addEventListener('modal-close', stopScan);
  }

  /* ------------------------------------------------------------------ boot */
  // A shared link like /?join=ABC123 (or a pasted room URL) pre-fills the code.
  const joinParam = new URLSearchParams(location.search).get('join');
  if (userName) {
    showRoomPanel();
    if (joinParam) codeInput.value = extractCode(joinParam).slice(0, 6);
  } else {
    showNamePanel();
  }
})();
