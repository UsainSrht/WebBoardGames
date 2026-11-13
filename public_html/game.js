/* Room page: lobby, roles, chat, invites (QR) and game loading. */
(() => {
  const $ = (id) => document.getElementById(id);
  const { esc, icon } = WBG;

  const CODE = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!CODE) { location.replace('/'); return; }
  document.title = `Room ${CODE} - Web Board Games`;

  const S = {
    room: null,          // latest room-state
    myId: WBG.store.get('userId'),
    myName: WBG.store.get('userName'),
    games: null,         // catalogue from /api/games
    joined: false,
    inGame: false,
    loadToken: 0,
    unread: 0,
    tab: 'people',
    optimisticReady: null,
    optimisticGame: null,
    prefetched: new Set(),
    shownScripts: new Set(),
    teardown: [],
    kicked: false
  };

  WBG.onTeardown = (fn) => S.teardown.push(fn);

  const socket = io();
  window.socket = socket;

  /* ------------------------------------------------------------ connection */
  const connEl = $('conn');
  function setConn(state) {
    const map = {
      online: ['wifi', 'text-emerald-400', 'Connected'],
      connecting: ['wifi', 'text-amber-400', 'Connecting'],
      offline: ['wifi-off', 'text-rose-400', 'Disconnected']
    };
    const [name, color, label] = map[state];
    connEl.className = `grid size-9 place-items-center ${color}`;
    connEl.title = label;
    connEl.setAttribute('aria-label', label);
    connEl.innerHTML = icon(name, 'size-5');
  }
  function banner(text, { retry = false, spin = true } = {}) {
    $('banner').hidden = !text;
    if (!text) return;
    $('banner-text').textContent = text;
    $('banner-retry').hidden = !retry;
    $('banner-icon').classList.toggle('hidden', !spin);
  }

  socket.on('connecting', () => setConn('connecting'));
  socket.on('connect', () => { setConn('online'); banner(null); });
  socket.on('disconnect', () => { setConn('offline'); banner('Connection lost. Reconnecting...'); });
  socket.on('reconnecting', ({ attempt }) => { setConn('connecting'); banner(`Reconnecting... (attempt ${attempt})`); });
  socket.on('reconnect_failed', () => { setConn('offline'); banner('Could not reach the server.', { retry: true, spin: false }); });
  $('banner-retry').addEventListener('click', () => { banner('Reconnecting...'); socket.forceReconnect(); });
  setConn('connecting');

  /* -------------------------------------------------------------- identity */
  socket.on('request-user-id', () => {
    socket.emit('send-user-id', {
      odId: WBG.store.get('userId'),
      name: WBG.store.get('userName'),
      secret: window.getUserSecret()
    });
  });

  socket.on('connect-user', ({ odId, name, inRoom }) => {
    S.myId = odId;
    WBG.store.set('userId', odId);
    if (name) { S.myName = name; WBG.store.set('userName', name); }
    if (!name) return openNameModal();
    if (!S.joined || !inRoom) joinRoom();
  });

  function joinRoom() {
    let spectate = false;
    try { spectate = sessionStorage.getItem(`wbg.spectate.${CODE}`) === '1'; } catch { /* blocked */ }
    socket.emit('join-room', { spectate });
  }

  socket.on('request-nickname', (data) => openNameModal(data && data.taken));

  /* ---------------------------------------------------------- nickname modal */
  function openNameModal(taken = false) {
    $('name-input').value = S.myName || '';
    const err = $('name-error');
    err.hidden = !taken;
    err.textContent = taken ? 'That name is not available in this room. Please pick another.' : '';
    WBG.openModal('name-modal');
  }

  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name-input').value.trim();
    const err = $('name-error');
    if (!WBG.NAME_RE.test(name)) {
      err.hidden = false;
      err.textContent = name.length < 3 ? 'Nickname must be at least 3 characters.' : 'Use 3-16 letters, numbers, spaces, "_", "-" or ".".';
      return;
    }
    S.myName = name;
    WBG.store.set('userName', name);
    socket.emit('submit-name', { name, isInGame: true });
    WBG.closeModal('name-modal');
  });

  /* ------------------------------------------------------------ room state */
  socket.on('room-state', (rs) => {
    const me = rs.players.find((p) => p.id === S.myId);
    if (!me) {
      if (S.joined && !S.kicked) { S.joined = false; } // removed; the kick/leave events handle navigation
      return;
    }
    const firstState = !S.room;
    S.room = rs;
    S.joined = true;
    S.optimisticReady = null;
    S.optimisticGame = null;
    WBG.isSpectator = me.spectator;
    WBG.role = me.spectator ? 'spectator' : 'player';

    if (!rs.started && S.inGame) leaveGameUi();
    render(firstState);
    if (rs.game && !rs.started) prefetchGame(rs.game);
  });

  const me = () => S.room?.players.find((p) => p.id === S.myId);
  const isHost = () => !!me()?.host;
  const activePlayers = () => (S.room ? S.room.players.filter((p) => !p.spectator) : []);

  /* ----------------------------------------------------------------- render */
  function render() {
    const rs = S.room;
    if (!rs) return;
    const m = me();
    const actives = activePlayers();

    $('lobby-title').textContent = rs.game ? rs.gameName : 'Choose a game';
    $('lobby-sub').textContent = `${actives.length} player${actives.length === 1 ? '' : 's'}${rs.players.length > actives.length ? ' and a host watching' : ''} in room ${CODE}`;
    $('players-count').textContent = String(rs.players.length);
    $('role-chip').hidden = !m.spectator;
    $('hostview-row').hidden = !(m.host && !rs.started);
    $('hostview-switch').checked = m.spectator;
    $('host-controls').hidden = !(m.host && rs.started);

    renderPlayers();
    renderGames();
    renderActions();
  }

  function badges(p) {
    const out = [];
    if (p.host) out.push(`<span class="inline-flex items-center gap-1 text-amber-300">${icon('shield', 'size-3.5')}Host</span>`);
    if (p.spectator) out.push(`<span class="inline-flex items-center gap-1 text-brand-300">${icon('eye', 'size-3.5')}Watching</span>`);
    if (!p.online) out.push(`<span class="inline-flex items-center gap-1 text-rose-300">${icon('wifi-off', 'size-3.5')}Offline</span>`);
    if (!out.length) out.push('<span>Player</span>');
    return out.join('<span class="text-slate-600">&middot;</span>');
  }

  function playerRow(p) {
    const li = document.createElement('li');
    const started = S.room.started;
    const ready = !started && !p.spectator && p.ready;
    li.className = `relative flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition ${ready ? 'border-emerald-400/40 bg-emerald-500/8' : 'border-white/8 bg-white/4'}`;
    const right = p.spectator || started ? ''
      : ready ? `<span class="text-emerald-300" title="Ready">${icon('check-circle', 'size-6')}</span>`
        : '<span class="size-5 rounded-full border-2 border-white/15" title="Not ready"></span>';
    const canManage = isHost() && p.id !== S.myId;
    li.innerHTML = `${WBG.avatar(p.name)}
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5 text-sm font-semibold text-white"><span class="truncate">${esc(p.name)}</span>${p.id === S.myId ? '<span class="chip shrink-0">you</span>' : ''}</p>
        <p class="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">${badges(p)}</p>
      </div>
      ${right}
      ${canManage ? `<button class="btn btn-ghost btn-icon btn-sm" data-menu="${esc(p.id)}" aria-label="Manage ${esc(p.name)}" aria-haspopup="menu">${icon('more', 'size-5')}</button>` : ''}`;
    return li;
  }

  function renderPlayers() {
    const sorted = [...S.room.players].sort((a, b) => Number(b.host) - Number(a.host));
    for (const list of [$('player-list'), $('drawer-players')]) {
      list.replaceChildren(...sorted.map(playerRow));
    }
  }

  function renderGames() {
    const grid = $('game-grid');
    const rs = S.room;
    const selected = S.optimisticGame || rs.game;
    const host = isHost();
    const count = activePlayers().length;
    $('games-hint').textContent = host ? 'Tap a game to select it' : 'The host picks the game';

    if (!S.games) {
      grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton h-28"></div>').join('');
      return;
    }

    grid.replaceChildren(...Object.entries(S.games).map(([id, g]) => {
      const on = id === selected;
      const fits = count >= g.min && count <= g.max;
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.dataset.game = id;
      b.disabled = !g.available;
      b.className = `group relative flex flex-col items-start gap-3 rounded-2xl border p-3.5 text-left transition duration-150 active:scale-[0.98] disabled:opacity-40 ${
        on ? 'border-brand-400 bg-brand-500/15 shadow-lg shadow-brand-500/10' : 'border-white/8 bg-white/4 hover:border-white/20 hover:bg-white/8'} ${host ? '' : 'cursor-default'}`;
      b.innerHTML = `
        <span class="grid size-11 place-items-center rounded-xl ${on ? 'bg-brand-500 text-white' : 'bg-white/8 text-brand-300'} transition">${icon(g.icon, 'size-6')}</span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-semibold text-white">${esc(g.name)}</span>
          <span class="mt-0.5 block text-xs ${on && !fits ? 'text-amber-300' : 'text-slate-400'}">${g.min === g.max ? g.min : `${g.min}-${g.max}`} player${g.max === 1 ? '' : 's'}</span>
        </span>
        ${on ? `<span class="absolute top-2.5 right-2.5 text-brand-300">${icon('check-circle', 'size-5')}</span>` : ''}`;
      return b;
    }));
  }

  function renderActions() {
    const rs = S.room;
    const m = me();
    const actives = activePlayers();
    const ready = actives.filter((p) => (p.id === S.myId && S.optimisticReady !== null ? S.optimisticReady : p.ready)).length;

    let text, tone = 'neutral', bar = 0;
    if (!rs.game) {
      text = m.host ? 'Pick a game to get started' : 'Waiting for the host to pick a game';
    } else if (rs.blocker) {
      text = rs.blocker; tone = 'warn';
    } else {
      text = `${ready} of ${actives.length} ready`;
      bar = actives.length ? (ready / actives.length) * 100 : 0;
      tone = ready === actives.length && ready > 0 ? 'good' : 'neutral';
    }
    $('status-text').textContent = text;
    $('ready-bar').style.width = `${bar}%`;
    const tones = { neutral: ['bg-white/8 text-slate-300', 'info'], warn: ['bg-amber-500/15 text-amber-300', 'alert'], good: ['bg-emerald-500/15 text-emerald-300', 'check-circle'] };
    $('status-icon').className = `grid size-9 shrink-0 place-items-center rounded-xl ${tones[tone][0]}`;
    $('status-icon').innerHTML = icon(tones[tone][1], 'size-5');

    const readyBtn = $('ready-btn');
    const amReady = S.optimisticReady !== null ? S.optimisticReady : m.ready;
    readyBtn.hidden = m.spectator;
    readyBtn.disabled = !rs.game || rs.started;
    readyBtn.className = `btn btn-lg flex-1 ${amReady ? 'btn-success' : 'btn-primary'}`;
    readyBtn.innerHTML = `${icon(amReady ? 'check-circle' : 'check', 'size-5')}<span>${amReady ? 'Ready - tap to cancel' : 'Ready'}</span>`;

    const startBtn = $('start-btn');
    startBtn.hidden = !m.host;
    startBtn.disabled = !rs.game || !!rs.blocker || rs.started;
    startBtn.className = `btn btn-lg ${m.spectator ? 'btn-primary flex-1' : 'btn-secondary'}`;
  }

  /* -------------------------------------------------------------- actions */
  $('ready-btn').addEventListener('click', () => {
    const m = me();
    if (!m || m.spectator) return;
    S.optimisticReady = !(S.optimisticReady !== null ? S.optimisticReady : m.ready);
    WBG.haptic();
    renderActions();
    socket.emit('toggle-ready');
  });

  $('start-btn').addEventListener('click', () => socket.emit('start-game'));

  $('game-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (!btn) return;
    if (!isHost()) return WBG.toast('Only the host can pick the game', { icon: 'crown' });
    S.optimisticGame = btn.dataset.game;
    WBG.haptic();
    renderGames();
    socket.emit('select-game', { game: btn.dataset.game });
  });

  $('hostview-switch').addEventListener('change', (e) => {
    socket.emit('set-role', { spectator: e.target.checked });
  });

  $('ctl-restart').addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Restart the game?', text: 'Everyone starts over with the same players.', ok: 'Restart', icon: 'refresh', tone: 'brand' })) {
      WBG.closeModal('drawer');
      socket.emit('restart-game');
    }
  });
  $('ctl-end').addEventListener('click', async () => {
    if (await confirmDialog({ title: 'End the game?', text: 'Everyone returns to the lobby.', ok: 'End game', icon: 'flag' })) {
      WBG.closeModal('drawer');
      socket.emit('end-game');
    }
  });

  // Per-player menu (make host / remove)
  let openMenuEl = null;
  function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) { if (!e.target.closest('.menu')) closeMenu(); return; }
    e.stopPropagation();
    const same = openMenuEl && openMenuEl.dataset.for === btn.dataset.menu && openMenuEl.parentElement === btn.parentElement;
    closeMenu();
    if (same) return;
    const p = S.room.players.find((x) => x.id === btn.dataset.menu);
    if (!p) return;
    const menu = document.createElement('div');
    menu.className = 'menu top-full right-2 mt-1';
    menu.dataset.for = p.id;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button class="menu-item" role="menuitem" data-act="host">${icon('crown', 'size-4')}Make host</button>
      <button class="menu-item menu-item-danger" role="menuitem" data-act="kick">${icon('user-x', 'size-4')}Remove from room</button>`;
    menu.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      closeMenu();
      if (act === 'host') {
        if (await confirmDialog({ title: `Make ${p.name} the host?`, text: 'They will be able to manage the room and games.', ok: 'Make host', icon: 'crown', tone: 'brand' })) {
          socket.emit('transfer-host', { id: p.id });
        }
      } else if (act === 'kick') {
        if (await confirmDialog({ title: `Remove ${p.name}?`, text: 'They will not be able to rejoin this room.', ok: 'Remove', icon: 'user-x' })) {
          socket.emit('kick-player', { kickedUserId: p.id });
        }
      }
    });
    btn.parentElement.appendChild(menu);
    openMenuEl = menu;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  /* ---------------------------------------------------------------- confirm */
  function confirmDialog({ title, text, ok = 'Confirm', icon: iconName = 'alert', tone = 'danger' }) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text || '';
      $('confirm-icon').innerHTML = icon(iconName, 'size-7');
      $('confirm-icon').className = `mx-auto mb-3 grid size-14 place-items-center rounded-2xl ${tone === 'danger' ? 'bg-rose-500/15 text-rose-300' : 'bg-brand-500/20 text-brand-300'}`;
      const okBtn = $('confirm-ok');
      okBtn.textContent = ok;
      okBtn.className = `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;
      const modal = $('confirm-modal');
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        okBtn.onclick = null;
        $('confirm-cancel').onclick = null;
        modal.removeEventListener('modal-close', onClose);
        WBG.closeModal(modal);
        resolve(value);
      };
      const onClose = () => done(false);
      okBtn.onclick = () => done(true);
      $('confirm-cancel').onclick = () => done(false);
      modal.addEventListener('modal-close', onClose);
      WBG.openModal('confirm-modal');
    });
  }

  /* ----------------------------------------------------------- leave / kick */
  function goHome() {
    S.kicked = true; // stop reacting to room changes
    location.href = '/';
  }

  $('leave-btn').addEventListener('click', async () => {
    if (S.inGame && !(await confirmDialog({ title: 'Leave the room?', text: 'You will leave the game in progress.', ok: 'Leave', icon: 'logout' }))) return;
    socket.emit('leave-room');
    setTimeout(goHome, 120);
  });

  socket.on('you-got-kicked', () => {
    S.kicked = true;
    WBG.toast('You were removed from this room', { type: 'error' });
    setTimeout(() => { location.href = '/'; }, 1600);
  });

  socket.on('join-failed', () => setTimeout(() => { location.href = '/'; }, 2200));

  socket.on('error', (data) => WBG.toast((data && data.message) || 'Something went wrong', { type: 'error' }));

  /* ------------------------------------------------------------ people/chat */
  const drawer = $('drawer');
  function openDrawer(tab = S.tab) {
    setTab(tab);
    WBG.openModal('drawer');
  }
  function setTab(tab) {
    S.tab = tab;
    for (const t of ['people', 'chat']) {
      const on = t === tab;
      $(`tab-${t}-btn`).setAttribute('aria-selected', String(on));
      $(`tab-${t}`).hidden = !on;
    }
    if (tab === 'chat') {
      S.unread = 0;
      updateBadge();
      const box = $('messages');
      box.scrollTop = box.scrollHeight;
      setTimeout(() => $('chat-input').focus({ preventScroll: true }), 60);
    }
  }
  const drawerOpen = () => 'open' in drawer.dataset;

  $('people-btn').addEventListener('click', () => openDrawer(S.unread ? 'chat' : S.tab));
  $('tab-people-btn').addEventListener('click', () => setTab('people'));
  $('tab-chat-btn').addEventListener('click', () => setTab('chat'));

  function updateBadge() {
    const b = $('chat-badge');
    b.hidden = S.unread === 0;
    b.textContent = S.unread > 9 ? '9+' : String(S.unread);
    $('tab-chat-dot').hidden = S.unread === 0;
  }

  function addMessage(node, { counts = false } = {}) {
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(node);
    while (box.children.length > 200) box.firstChild.remove();
    if (atBottom || node.dataset.own) box.scrollTop = box.scrollHeight;
    if (counts && !(drawerOpen() && S.tab === 'chat')) { S.unread++; updateBadge(); }
  }

  function systemLine(text) {
    const el = document.createElement('p');
    el.className = 'py-1 text-center text-xs text-slate-500';
    el.textContent = text;
    addMessage(el);
  }

  socket.on('chat-message', ({ message, name, odId, at }) => {
    const own = odId === S.myId;
    const wrap = document.createElement('div');
    wrap.className = `flex flex-col ${own ? 'items-end' : 'items-start'}`;
    if (own) wrap.dataset.own = '1';
    const time = new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    wrap.innerHTML = `<span class="mb-0.5 px-1 text-[11px] text-slate-500">${own ? '' : `${esc(name)} &middot; `}${time}</span>
      <span class="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words ${own ? 'rounded-br-md bg-brand-500 text-white' : 'rounded-bl-md bg-white/10 text-slate-100'}">${esc(message)}</span>`;
    addMessage(wrap, { counts: !own });
  });

  socket.on('system-message', ({ message }) => systemLine(message));
  // Alerts only in the lobby (they would cover the game) and never for yourself.
  const notify = (text, iconName, name) => {
    systemLine(text);
    if (WBG.prefs.notify && !S.inGame && name !== S.myName) WBG.toast(text, { icon: iconName });
  };
  socket.on('player-joined', ({ name }) => notify(`${name} joined`, 'user', name));
  socket.on('player-left', ({ name }) => notify(`${name} left`, 'logout', name));
  socket.on('player-kicked', ({ name }) => systemLine(`${name} was removed`));

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat-message', { message: text.slice(0, 200) });
    input.value = '';
  });

  /* ------------------------------------------------------------ invite / QR */
  const roomLink = WBG.roomUrl(CODE);
  $('room-code').textContent = CODE;
  $('invite-code').textContent = CODE;
  $('share-code').textContent = CODE;
  if (WBG.canShare()) { $('invite-share').hidden = false; $('share-native').hidden = false; }

  const qrPromise = WBG.qrSvg(roomLink).catch(() => null);
  qrPromise.then((svg) => {
    $('invite-qr-skeleton').remove();
    if (svg) { $('invite-qr-svg').innerHTML = svg; $('share-qr').innerHTML = svg; }
    else $('invite-qr-svg').innerHTML = icon('qr', 'size-full text-ink-900');
  });

  const openShare = () => WBG.openModal('share-modal');
  $('room-chip').addEventListener('click', openShare);
  $('invite-qr').addEventListener('click', openShare);
  const share = () => WBG.share({ title: 'Join my game room', text: `Join my game room ${CODE}`, url: roomLink });
  $('invite-share').addEventListener('click', share);
  $('share-native').addEventListener('click', share);
  $('invite-copy').addEventListener('click', () => WBG.copy(roomLink, 'Invite link copied'));
  $('share-copy').addEventListener('click', () => WBG.copy(roomLink, 'Invite link copied'));
  $('share-code-copy').addEventListener('click', () => WBG.copy(CODE, 'Room code copied'));

  /* --------------------------------------------------------------- settings */
  $('settings-btn').addEventListener('click', () => {
    $('rename-input').value = S.myName || '';
    $('rename-error').hidden = true;
    $('set-notify').checked = WBG.prefs.notify;
    $('set-motion').checked = WBG.prefs.reduceMotion;
    WBG.openModal('settings-modal');
  });
  $('set-notify').addEventListener('change', (e) => { WBG.prefs.notify = e.target.checked; });
  $('set-motion').addEventListener('change', (e) => { WBG.prefs.reduceMotion = e.target.checked; });
  $('rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('rename-input').value.trim();
    const err = $('rename-error');
    if (!WBG.NAME_RE.test(name)) {
      err.hidden = false;
      err.textContent = 'Use 3-16 letters, numbers, spaces, "_", "-" or ".".';
      return;
    }
    if (name === S.myName) return WBG.closeModal('settings-modal');
    S.myName = name;
    WBG.store.set('userName', name);
    socket.emit('submit-name', { name, isInGame: false });
    WBG.closeModal('settings-modal');
    WBG.toast('Nickname updated', { type: 'success' });
  });

  /* ------------------------------------------------------------------ games */
  fetch('/api/games').then((r) => r.json()).then((g) => { S.games = g; if (S.room) renderGames(); }).catch(() => {
    WBG.toast('Could not load the game list. Reload the page.', { type: 'error' });
  });

  /** Warm the cache so the game starts instantly once everybody is ready. */
  async function prefetchGame(game) {
    if (S.prefetched.has(game)) return;
    S.prefetched.add(game);
    try {
      const html = await (await fetch(`/games/${game}.html`)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const urls = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).concat(`/games/${game}.js`);
      for (const href of urls) {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = 'script';
        link.href = href;
        document.head.appendChild(link);
      }
    } catch { S.prefetched.delete(game); }
  }

  async function fetchText(url, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
    throw last;
  }

  function loadClassicScript(src) {
    const abs = new URL(src, location.href).href;
    if (S.shownScripts.has(abs)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = abs;
      s.onload = () => { S.shownScripts.add(abs); resolve(); };
      s.onerror = () => { s.remove(); reject(new Error(`Failed to load ${abs}`)); };
      document.head.appendChild(s);
    });
  }

  const lobbyEvents = new Set();
  function snapshotLobbyEvents() {
    for (const k of socket.eventHandlers.keys()) lobbyEvents.add(k);
  }

  function teardownGame() {
    for (const fn of S.teardown.splice(0)) { try { fn(); } catch { /* ignore */ } }
    $('game-script')?.remove();
    $('game-board').replaceChildren();
    for (const key of [...socket.eventHandlers.keys()]) {
      if (!lobbyEvents.has(key)) socket.eventHandlers.delete(key);
    }
  }

  function showLoading(game) {
    const g = S.games?.[game];
    $('loading-icon').innerHTML = icon(g?.icon || 'dice', 'size-8');
    $('loading-title').textContent = g ? `Starting ${g.name}` : 'Starting game';
    $('loading-sub').textContent = WBG.isSpectator ? 'Loading host view...' : 'Loading...';
    $('game-loading').hidden = false;
  }

  async function loadGame(game) {
    const token = ++S.loadToken;
    teardownGame();
    closeMenu();
    S.inGame = true;
    showLoading(game);
    $('lobby').hidden = true;
    $('game-board').hidden = false;
    WBG.closeModal('drawer');

    try {
      const html = await fetchText(`/games/${game}.html`);
      if (token !== S.loadToken) return;
      $('game-board').innerHTML = html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const tag of doc.querySelectorAll('script[src]')) {
        await loadClassicScript(tag.getAttribute('src'));
        if (token !== S.loadToken) return;
      }
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'module';
        script.id = 'game-script';
        script.src = `/games/${game}.js?v=${Date.now()}`;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load the game script'));
        document.body.appendChild(script);
      });
      if (token !== S.loadToken) return;
      $('game-loading').hidden = true;
    } catch (err) {
      if (token !== S.loadToken) return;
      $('game-loading').hidden = true;
      const retry = await confirmDialog({
        title: 'Could not load the game',
        text: 'Check your connection and try again.',
        ok: 'Retry', icon: 'wifi-off', tone: 'brand'
      });
      if (retry) loadGame(game);
      else { leaveGameUi(); socket.emit('request-back-to-lobby'); }
    }
  }

  function leaveGameUi() {
    S.loadToken++;
    teardownGame();
    S.inGame = false;
    $('game-loading').hidden = true;
    $('game-board').hidden = true;
    $('lobby').hidden = false;
    window.scrollTo(0, 0);
  }

  socket.on('game-started', ({ game }) => loadGame(game));
  socket.on('back-to-lobby', () => {
    if (!S.inGame) return;
    leaveGameUi();
    WBG.toast('Back in the lobby', { icon: 'home' });
    if (S.room) render();
  });

  $('banner-icon').classList.remove('hidden');
  snapshotLobbyEvents();
})();
