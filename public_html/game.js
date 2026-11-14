/* Room page: lobby, game catalogue, roles, chat, invites (QR), translations and game loading. */
(async () => {
  await WBG.i18n.ready;

  const $ = (id) => document.getElementById(id);
  const { esc, icon, t, tr } = WBG;

  const CODE = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  if (!CODE) { location.replace('/'); return; }
  document.title = t('room.title', { code: CODE });

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
    kicked: false,
    cat: 'all',
    sort: WBG.store.get('wbg.catalog.sort', 'featured'),
    query: '',
    fit: false,
    allOpen: false
  };

  WBG.onTeardown = (fn) => S.teardown.push(fn);

  const socket = io();
  window.socket = socket;

  /* ------------------------------------------------------------ connection */
  const connEl = $('conn');
  function setConn(state) {
    const map = {
      online: ['wifi', 'text-emerald-400', 'conn.online'],
      connecting: ['wifi', 'text-amber-400', 'conn.connecting'],
      offline: ['wifi-off', 'text-rose-400', 'conn.offline']
    };
    const [name, color, key] = map[state];
    const label = t(key);
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
  socket.on('disconnect', () => { setConn('offline'); banner(t('conn.lost')); });
  socket.on('reconnecting', ({ attempt }) => { setConn('connecting'); banner(t('conn.attempt', { n: attempt })); });
  socket.on('reconnect_failed', () => { setConn('offline'); banner(t('conn.failed'), { retry: true, spin: false }); });
  $('banner-retry').addEventListener('click', () => { banner(t('conn.reconnecting')); socket.forceReconnect(); });
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
    err.textContent = taken ? t('name.taken') : '';
    WBG.openModal('name-modal');
  }

  const nameProblem = (name) => (WBG.NAME_RE.test(name) ? null : (name.length < 3 ? t('name.short') : t('name.invalid')));

  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('name-input').value.trim();
    const err = $('name-error');
    const problem = nameProblem(name);
    if (problem) { err.hidden = false; err.textContent = problem; return; }
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
    S.room = rs;
    S.joined = true;
    S.optimisticReady = null;
    S.optimisticGame = null;
    WBG.isSpectator = me.spectator;
    WBG.role = me.spectator ? 'spectator' : 'player';

    if (rs.game) ensureGameDict(rs.game);
    if (!rs.started && S.inGame) leaveGameUi();
    render();
    if (rs.game && !rs.started) prefetchGame(rs.game);
  });

  const me = () => S.room?.players.find((p) => p.id === S.myId);
  const isHost = () => !!me()?.host;
  const activePlayers = () => (S.room ? S.room.players.filter((p) => !p.spectator) : []);

  /** A game's own dictionary (option labels, rules, results) loads when the game is selected. */
  const dictLoading = new Set();
  function ensureGameDict(id) {
    if (dictLoading.has(id)) return;
    dictLoading.add(id);
    WBG.i18n.load(id).then(() => { if (S.room) { renderOptions(); renderSelected(); } });
  }

  /* ------------------------------------------------------------- game names */
  const gameName = (id) => t(`games.${id}.name`, { fallback: S.games?.[id]?.name || id });
  const gameDesc = (id) => t(`games.${id}.desc`, { fallback: '' });
  const catName = (c) => t(`cat.${c}`, { fallback: c });

  function playersText(g) {
    return g.min === g.max ? t('catalog.playersExact', { n: g.min }) : t('catalog.playersRange', { min: g.min, max: g.max });
  }

  /* ----------------------------------------------------------------- render */
  function render() {
    const rs = S.room;
    if (!rs) return;
    const m = me();
    const actives = activePlayers();

    $('lobby-title').textContent = rs.game ? gameName(rs.game) : t('lobby.chooseGame');
    $('lobby-sub').textContent = t(rs.players.length > actives.length ? 'lobby.subWatching' : 'lobby.sub', { n: actives.length, code: CODE });
    $('players-count').textContent = String(rs.players.length);
    $('role-chip').hidden = !m.spectator;
    $('hostview-row').hidden = !(m.host && !rs.started);
    $('hostview-switch').checked = m.spectator;
    $('host-controls').hidden = !(m.host && rs.started);

    renderPlayers();
    renderGames();
    renderOptions();
    renderActions();
  }

  /** Host-editable settings of the selected game (read-only for everyone else). */
  function renderOptions() {
    const panel = $('options-panel');
    const rs = S.room;
    const id = S.optimisticGame || rs.game;
    const g = S.games && id ? S.games[id] : null;
    if (!g || !g.options?.length) { panel.hidden = true; return; }
    const values = S.optimisticGame && S.optimisticGame !== rs.game ? {} : (rs.options || {});
    const host = isHost();
    panel.hidden = false;
    panel.replaceChildren(...g.options.map((opt) => {
      const label = t(`${id}.opt.${opt.key}`, { fallback: opt.label });
      const hint = opt.hint ? t(`${id}.opt.${opt.key}.hint`, { fallback: opt.hint }) : '';
      const current = values[opt.key] ?? opt.default;
      const wrap = document.createElement('div');
      wrap.innerHTML = `<p class="mb-1.5 flex items-baseline justify-between gap-3"><span class="text-xs font-semibold tracking-wide text-slate-300 uppercase">${esc(label)}</span>${hint ? `<span class="text-right text-[11px] text-slate-500">${esc(hint)}</span>` : ''}</p>`;
      const row = document.createElement('div');
      row.className = 'flex flex-wrap gap-1.5';
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', label);
      for (const choice of opt.choices) {
        const on = choice.value === current;
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(on));
        b.disabled = !host && !on;
        b.className = `rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${on ? 'border-brand-400 bg-brand-500/20 text-white' : 'border-white/10 bg-white/4 text-slate-300 hover:bg-white/10'} ${host ? '' : 'cursor-default'}`;
        b.textContent = t(`${id}.opt.${opt.key}.${choice.value}`, { fallback: choice.label });
        b.addEventListener('click', () => {
          if (!host || on) return;
          WBG.sound.play('click');
          (S.room.options ||= {})[opt.key] = choice.value; // optimistic
          renderOptions();
          socket.emit('set-options', { game: rs.game, options: { [opt.key]: choice.value } });
        });
        row.appendChild(b);
      }
      wrap.appendChild(row);
      return wrap;
    }));
  }

  function badges(p) {
    const out = [];
    if (p.host) out.push(`<span class="inline-flex items-center gap-1 text-amber-300">${icon('shield', 'size-3.5')}${esc(t('badge.host'))}</span>`);
    if (p.spectator) out.push(`<span class="inline-flex items-center gap-1 text-brand-300">${icon('eye', 'size-3.5')}${esc(t('badge.watching'))}</span>`);
    if (!p.online) out.push(`<span class="inline-flex items-center gap-1 text-rose-300">${icon('wifi-off', 'size-3.5')}${esc(t('badge.offline'))}</span>`);
    if (!out.length) out.push(`<span>${esc(t('badge.player'))}</span>`);
    return out.join('<span class="text-slate-600">&middot;</span>');
  }

  function playerRow(p) {
    const li = document.createElement('li');
    const started = S.room.started;
    const ready = !started && !p.spectator && p.ready;
    li.className = `relative flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition ${ready ? 'border-emerald-400/40 bg-emerald-500/8' : 'border-white/8 bg-white/4'}`;
    const right = p.spectator || started ? ''
      : ready ? `<span class="text-emerald-300" title="${esc(t('lobby.isReady'))}">${icon('check-circle', 'size-6')}</span>`
        : `<span class="size-5 rounded-full border-2 border-white/15" title="${esc(t('lobby.notReady'))}"></span>`;
    const canManage = isHost() && p.id !== S.myId;
    li.innerHTML = `${WBG.avatar(p.name)}
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5 text-sm font-semibold text-white"><span class="truncate">${esc(p.name)}</span>${p.id === S.myId ? `<span class="chip shrink-0">${esc(t('common.you'))}</span>` : ''}</p>
        <p class="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">${badges(p)}</p>
      </div>
      ${right}
      ${canManage ? `<button class="btn btn-ghost btn-icon btn-sm" data-menu="${esc(p.id)}" aria-label="${esc(t('menu.manage', { name: p.name }))}" aria-haspopup="menu">${icon('more', 'size-5')}</button>` : ''}`;
    return li;
  }

  function renderPlayers() {
    const sorted = [...S.room.players].sort((a, b) => Number(b.host) - Number(a.host));
    for (const list of [$('player-list'), $('drawer-players')]) {
      list.replaceChildren(...sorted.map(playerRow));
    }
  }

  /* ---------------------------------------------------------- game catalogue */
  const norm = (s) => String(s).toLocaleLowerCase(WBG.locale).replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');

  function tile(id, g, selected) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(selected));
    b.dataset.game = id;
    b.disabled = !g.available;
    const fits = fitsRoom(g);
    b.className = `group relative flex flex-col items-start gap-3 rounded-2xl border p-3.5 text-left transition duration-150 active:scale-[0.98] disabled:opacity-40 ${
      selected ? 'border-brand-400 bg-brand-500/15 shadow-lg shadow-brand-500/10' : 'border-white/8 bg-white/4 hover:border-white/20 hover:bg-white/8'} ${isHost() ? '' : 'cursor-default'}`;
    b.innerHTML = `
      <span class="grid size-11 place-items-center rounded-xl ${selected ? 'bg-brand-500 text-white' : 'bg-white/8 text-brand-300'} transition">${icon(g.icon, 'size-6')}</span>
      <span class="min-w-0">
        <span class="block truncate text-sm font-semibold text-white">${esc(gameName(id))}</span>
        <span class="mt-0.5 block text-xs ${selected && !fits ? 'text-amber-300' : 'text-slate-400'}">${esc(playersText(g))}</span>
      </span>
      ${selected ? `<span class="absolute top-2.5 right-2.5 text-brand-300">${icon('check-circle', 'size-5')}</span>` : ''}
      ${!g.available ? `<span class="chip absolute top-2.5 right-2.5">${esc(t('catalog.soon'))}</span>` : ''}`;
    return b;
  }

  function fitsRoom(g) {
    const n = activePlayers().length;
    return n >= g.min && n <= g.max;
  }

  function row(id, g, selected) {
    const n = activePlayers().length;
    const fits = fitsRoom(g);
    const b = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.game = id;
    btn.disabled = !g.available;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(selected));
    btn.className = `flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition active:scale-[0.99] disabled:opacity-40 ${selected ? 'border-brand-400 bg-brand-500/15' : 'border-white/8 bg-white/4 hover:border-white/20 hover:bg-white/8'} ${isHost() ? '' : 'cursor-default'}`;
    const warn = !g.available ? t('catalog.soon') : n < g.min ? t('catalog.needMore', { n: g.min }) : n > g.max ? t('catalog.tooMany', { n: g.max }) : '';
    btn.innerHTML = `
      <span class="grid size-10 shrink-0 place-items-center rounded-xl ${selected ? 'bg-brand-500 text-white' : 'bg-white/8 text-brand-300'}">${icon(g.icon, 'size-5')}</span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5"><span class="truncate text-sm font-semibold text-white">${esc(gameName(id))}</span>${g.featured ? `<span class="text-amber-300" title="${esc(t('catalog.featured'))}">${icon('star', 'size-3.5')}</span>` : ''}${g.solo ? `<span class="chip chip-success">${esc(t('catalog.solo'))}</span>` : ''}</span>
        <span class="block truncate text-xs text-slate-400">${esc(gameDesc(id))}</span>
        <span class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          <span class="chip">${icon('users', 'size-3')}${esc(playersText(g))}</span>
          <span class="chip">${icon('clock', 'size-3')}${esc(t('catalog.minutes', { n: g.minutes }))}</span>
          <span class="chip">${esc(catName(g.category))}</span>
          ${warn ? `<span class="chip ${fits ? '' : 'chip-warn'}">${esc(warn)}</span>` : ''}
        </span>
      </span>
      ${selected ? `<span class="shrink-0 text-brand-300">${icon('check-circle', 'size-5')}</span>` : ''}`;
    b.appendChild(btn);
    return b;
  }

  function sortedGames() {
    const entries = Object.entries(S.games || {});
    const byName = (a, b) => gameName(a[0]).localeCompare(gameName(b[0]), WBG.locale);
    const cmp = {
      featured: (a, b) => Number(b[1].featured) - Number(a[1].featured) || byName(a, b),
      az: byName,
      players: (a, b) => b[1].max - a[1].max || byName(a, b),
      length: (a, b) => a[1].minutes - b[1].minutes || byName(a, b),
      newest: (a, b) => b[1].added - a[1].added || byName(a, b)
    }[S.sort] || byName;
    return entries.sort(cmp);
  }

  function renderGames() {
    const rs = S.room;
    const selected = S.optimisticGame || rs.game;
    $('games-hint').textContent = isHost() ? t('catalog.hintHost') : t('catalog.hintGuest');

    const grid = $('game-grid');
    if (!S.games) {
      grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton h-28"></div>').join('');
      return;
    }

    const all = Object.entries(S.games);
    $('all-toggle-label').textContent = t('catalog.allGames', { n: all.length });
    grid.replaceChildren(...all.filter(([, g]) => g.featured).map(([id, g]) => tile(id, g, id === selected)));
    renderSelected();
    renderAllPanel();
  }

  function renderSelected() {
    const box = $('selected-game');
    const rs = S.room;
    const id = S.optimisticGame || rs?.game;
    const g = S.games && id ? S.games[id] : null;
    if (!g) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="flex items-center gap-3 rounded-2xl border border-brand-400/50 bg-brand-500/10 p-3">
      <span class="grid size-12 shrink-0 place-items-center rounded-xl bg-brand-500 text-white">${icon(g.icon, 'size-6')}</span>
      <div class="min-w-0 flex-1">
        <p class="truncate text-base font-bold text-white">${esc(gameName(id))}</p>
        <p class="text-xs leading-snug text-slate-300">${esc(gameDesc(id))}</p>
        <p class="mt-1.5 flex flex-wrap gap-1.5"><span class="chip">${icon('users', 'size-3')}${esc(playersText(g))}</span><span class="chip">${icon('clock', 'size-3')}${esc(t('catalog.minutes', { n: g.minutes }))}</span>${g.solo ? `<span class="chip chip-success">${esc(t('catalog.solo'))}</span>` : ''}</p>
      </div>
    </div>`;
  }

  function renderAllPanel() {
    $('all-chevron').style.transform = S.allOpen ? 'rotate(180deg)' : '';
    $('all-toggle').setAttribute('aria-expanded', String(S.allOpen));
    $('all-panel').hidden = !S.allOpen;
    $('catalog-fit-label').textContent = t('catalog.fit');
    if (!S.allOpen) return;

    // category chips
    const counts = { all: 0 };
    for (const g of Object.values(S.games || {})) { counts.all++; counts[g.category] = (counts[g.category] || 0) + 1; }
    $('catalog-cats').replaceChildren(...['all', ...Object.keys(counts).filter((c) => c !== 'all')].map((c) => {
      const on = S.cat === c;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.cat = c;
      b.setAttribute('aria-pressed', String(on));
      b.className = `rounded-full border px-3 py-1.5 text-xs font-semibold transition ${on ? 'border-brand-400 bg-brand-500/25 text-white' : 'border-white/10 bg-white/4 text-slate-300 hover:bg-white/10'}`;
      b.textContent = `${c === 'all' ? t('catalog.catAll') : catName(c)} ${counts[c]}`;
      return b;
    }));

    const selected = S.optimisticGame || S.room.game;
    const q = norm(S.query.trim());
    const list = sortedGames().filter(([id, g]) => {
      if (S.cat !== 'all' && g.category !== S.cat) return false;
      if (S.fit && !fitsRoom(g)) return false;
      if (!q) return true;
      const hay = norm([gameName(id), g.name, gameDesc(id), t(`games.${id}.tags`, { fallback: '' }), catName(g.category)].join(' '));
      return q.split(/\s+/).every((word) => hay.includes(word));
    });
    $('all-list').replaceChildren(...(list.length
      ? list.map(([id, g]) => row(id, g, id === selected))
      : [Object.assign(document.createElement('li'), {
        className: 'rounded-2xl border border-dashed border-white/12 p-6 text-center text-sm text-slate-400',
        textContent: t('catalog.empty')
      })]));
  }

  function pickGame(id) {
    if (!isHost()) return WBG.toast(t('toast.hostPick'), { icon: 'crown' });
    S.optimisticGame = id;
    WBG.haptic();
    WBG.sound.play('click');
    ensureGameDict(id);
    renderGames();
    renderOptions();
    socket.emit('select-game', { game: id });
  }

  $('game-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (btn) pickGame(btn.dataset.game);
  });

  $('all-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (!btn) return;
    pickGame(btn.dataset.game);
    if (isHost()) {
      S.allOpen = false;
      renderAllPanel();
      $('selected-game').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  $('all-toggle').addEventListener('click', () => {
    S.allOpen = !S.allOpen;
    WBG.sound.play('click');
    renderAllPanel();
    if (S.allOpen && matchMedia('(pointer: fine)').matches) $('catalog-search').focus({ preventScroll: true });
  });
  $('catalog-search').addEventListener('input', (e) => { S.query = e.target.value; renderAllPanel(); });
  $('catalog-sort').value = S.sort;
  $('catalog-sort').addEventListener('change', (e) => { S.sort = e.target.value; WBG.store.set('wbg.catalog.sort', S.sort); renderAllPanel(); });
  $('catalog-fit').addEventListener('change', (e) => { S.fit = e.target.checked; renderAllPanel(); });
  $('catalog-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) { S.cat = b.dataset.cat; renderAllPanel(); }
  });

  /* ---------------------------------------------------------------- actions */
  function renderActions() {
    const rs = S.room;
    const m = me();
    const actives = activePlayers();
    const ready = actives.filter((p) => (p.id === S.myId && S.optimisticReady !== null ? S.optimisticReady : p.ready)).length;

    let text, tone = 'neutral', bar = 0;
    if (!rs.game) {
      text = t(m.host ? 'status.pick' : 'status.waitHost');
    } else if (rs.blocker) {
      text = tr(rs.blocker); tone = 'warn';
    } else {
      text = t('status.ready', { ready, n: actives.length });
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
    readyBtn.innerHTML = `${icon(amReady ? 'check-circle' : 'check', 'size-5')}<span>${esc(t(amReady ? 'lobby.readyCancel' : 'lobby.ready'))}</span>`;

    const startBtn = $('start-btn');
    startBtn.hidden = !m.host;
    startBtn.disabled = !rs.game || !!rs.blocker || rs.started;
    startBtn.className = `btn btn-lg ${m.spectator ? 'btn-primary flex-1' : 'btn-secondary'}`;
  }

  $('ready-btn').addEventListener('click', () => {
    const m = me();
    if (!m || m.spectator) return;
    S.optimisticReady = !(S.optimisticReady !== null ? S.optimisticReady : m.ready);
    WBG.haptic();
    WBG.sound.play(S.optimisticReady ? 'pop' : 'click');
    renderActions();
    socket.emit('toggle-ready');
  });

  $('start-btn').addEventListener('click', () => socket.emit('start-game'));

  $('hostview-switch').addEventListener('change', (e) => {
    socket.emit('set-role', { spectator: e.target.checked });
  });

  $('ctl-restart').addEventListener('click', async () => {
    if (await confirmDialog({ title: t('confirm.restartTitle'), text: t('confirm.restartText'), ok: t('confirm.restart'), icon: 'refresh', tone: 'brand' })) {
      WBG.closeModal('drawer');
      socket.emit('restart-game');
    }
  });
  $('ctl-end').addEventListener('click', async () => {
    if (await confirmDialog({ title: t('confirm.endTitle'), text: t('confirm.endText'), ok: t('confirm.end'), icon: 'flag' })) {
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
      <button class="menu-item" role="menuitem" data-act="host">${icon('crown', 'size-4')}${esc(t('menu.makeHost'))}</button>
      <button class="menu-item menu-item-danger" role="menuitem" data-act="kick">${icon('user-x', 'size-4')}${esc(t('menu.remove'))}</button>`;
    menu.addEventListener('click', async (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      closeMenu();
      if (act === 'host') {
        if (await confirmDialog({ title: t('confirm.hostTitle', { name: p.name }), text: t('confirm.hostText'), ok: t('menu.makeHost'), icon: 'crown', tone: 'brand' })) {
          socket.emit('transfer-host', { id: p.id });
        }
      } else if (act === 'kick') {
        if (await confirmDialog({ title: t('confirm.removeTitle', { name: p.name }), text: t('confirm.removeText'), ok: t('confirm.remove'), icon: 'user-x' })) {
          socket.emit('kick-player', { kickedUserId: p.id });
        }
      }
    });
    btn.parentElement.appendChild(menu);
    openMenuEl = menu;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  /* ---------------------------------------------------------------- confirm */
  function confirmDialog({ title, text, ok, icon: iconName = 'alert', tone = 'danger' }) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text || '';
      $('confirm-icon').innerHTML = icon(iconName, 'size-7');
      $('confirm-icon').className = `mx-auto mb-3 grid size-14 place-items-center rounded-2xl ${tone === 'danger' ? 'bg-rose-500/15 text-rose-300' : 'bg-brand-500/20 text-brand-300'}`;
      const okBtn = $('confirm-ok');
      okBtn.textContent = ok || t('common.confirm');
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
    if (S.inGame && !(await confirmDialog({ title: t('confirm.leaveTitle'), text: t('confirm.leaveText'), ok: t('confirm.leave'), icon: 'logout' }))) return;
    socket.emit('leave-room');
    setTimeout(goHome, 120);
  });

  socket.on('you-got-kicked', () => {
    S.kicked = true;
    WBG.toast(t('toast.removed'), { type: 'error' });
    setTimeout(() => { location.href = '/'; }, 1600);
  });

  socket.on('join-failed', () => setTimeout(() => { location.href = '/'; }, 2200));

  socket.on('error', (data) => WBG.toast((data && tr(data.message)) || t('err.generic'), { type: 'error' }));

  /* ------------------------------------------------------------ people/chat */
  const drawer = $('drawer');
  function openDrawer(tab = S.tab) {
    setTab(tab);
    WBG.openModal('drawer');
  }
  function setTab(tab) {
    S.tab = tab;
    for (const name of ['people', 'chat']) {
      const on = name === tab;
      $(`tab-${name}-btn`).setAttribute('aria-selected', String(on));
      $(`tab-${name}`).hidden = !on;
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
    const time = new Date(at || Date.now()).toLocaleTimeString(WBG.locale, { hour: '2-digit', minute: '2-digit' });
    wrap.innerHTML = `<span class="mb-0.5 px-1 text-[11px] text-slate-500">${own ? '' : `${esc(name)} &middot; `}${time}</span>
      <span class="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words ${own ? 'rounded-br-md bg-brand-500 text-white' : 'rounded-bl-md bg-white/10 text-slate-100'}">${esc(message)}</span>`;
    addMessage(wrap, { counts: !own });
    if (!own && !(drawerOpen() && S.tab === 'chat')) WBG.sound.play('notify');
  });

  socket.on('system-message', ({ message }) => systemLine(tr(message)));
  // Alerts only in the lobby (they would cover the game) and never for yourself.
  const notify = (text, iconName, name) => {
    systemLine(text);
    if (WBG.prefs.notify && !S.inGame && name !== S.myName) WBG.toast(text, { icon: iconName });
  };
  socket.on('player-joined', ({ name }) => notify(t('chat.joined', { name }), 'user', name));
  socket.on('player-left', ({ name }) => notify(t('chat.left', { name }), 'logout', name));
  socket.on('player-kicked', ({ name }) => systemLine(t('chat.removed', { name })));

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
  const share = () => WBG.share({ title: t('share.nativeTitle'), text: t('share.nativeText', { code: CODE }), url: roomLink });
  $('invite-share').addEventListener('click', share);
  $('share-native').addEventListener('click', share);
  $('invite-copy').addEventListener('click', () => WBG.copy(roomLink, t('toast.linkCopied')));
  $('share-copy').addEventListener('click', () => WBG.copy(roomLink, t('toast.linkCopied')));
  $('share-code-copy').addEventListener('click', () => WBG.copy(CODE, t('toast.codeCopied')));

  /* --------------------------------------------------------------- settings */
  function paintLanguages() {
    $('lang-switch').replaceChildren(...WBG.i18n.langs.map((l) => {
      const on = l.code === WBG.lang;
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.lang = l.code;
      b.className = `flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${on ? 'border-brand-400 bg-brand-500/20 text-white' : 'border-white/10 bg-white/4 text-slate-300 hover:bg-white/10'}`;
      b.innerHTML = `${icon('globe', 'size-4')}${esc(l.name)}`;
      b.addEventListener('click', () => WBG.i18n.setLang(l.code));
      return b;
    }));
  }

  $('settings-btn').addEventListener('click', () => {
    $('rename-input').value = S.myName || '';
    $('rename-error').hidden = true;
    $('set-notify').checked = WBG.prefs.notify;
    $('set-motion').checked = WBG.prefs.reduceMotion;
    $('set-sound').checked = WBG.prefs.sound;
    paintLanguages();
    WBG.openModal('settings-modal');
  });
  $('set-notify').addEventListener('change', (e) => { WBG.prefs.notify = e.target.checked; });
  $('set-motion').addEventListener('change', (e) => { WBG.prefs.reduceMotion = e.target.checked; });
  $('set-sound').addEventListener('change', (e) => { WBG.prefs.sound = e.target.checked; paintSound(); WBG.sound.play('click'); });
  $('rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('rename-input').value.trim();
    const err = $('rename-error');
    const problem = nameProblem(name);
    if (problem) { err.hidden = false; err.textContent = problem; return; }
    if (name === S.myName) return WBG.closeModal('settings-modal');
    S.myName = name;
    WBG.store.set('userName', name);
    socket.emit('submit-name', { name, isInGame: false });
    WBG.closeModal('settings-modal');
    WBG.toast(t('toast.nameUpdated'), { type: 'success' });
  });

  /* ------------------------------------------------------------ sound + help */
  const soundBtn = $('sound-btn');
  function paintSound() {
    const on = WBG.prefs.sound;
    soundBtn.innerHTML = icon(on ? 'volume' : 'volume-off', 'size-5');
    soundBtn.setAttribute('aria-label', t(on ? 'room.mute' : 'room.unmute'));
    soundBtn.setAttribute('aria-pressed', String(!on));
  }
  soundBtn.addEventListener('click', () => {
    WBG.prefs.sound = !WBG.prefs.sound;
    paintSound();
    WBG.sound.play('click');
  });
  paintSound();

  const helpBtn = $('help-btn');
  function updateHelp() {
    helpBtn.hidden = !WBG.rules;
    if (!WBG.rules) return;
    const key = `wbg.rulesSeen.${S.room?.game || ''}`;
    if (S.room?.game && !WBG.store.get(key)) {
      WBG.store.set(key, '1');
      helpBtn.classList.add('animate-pulse-soft', 'ring-2', 'ring-brand-400');
      setTimeout(() => helpBtn.classList.remove('animate-pulse-soft', 'ring-2', 'ring-brand-400'), 9000);
    }
  }
  window.addEventListener('wbg-rules', updateHelp);
  helpBtn.addEventListener('click', () => {
    const r = WBG.rules;
    if (!r) return;
    $('rules-title').textContent = tr(r.title) || t('rules.title');
    $('rules-body').innerHTML = (r.sections || []).map((s) => `<section>
      ${s.title ? `<h3 class="mb-1.5 font-semibold text-white">${esc(tr(s.title))}</h3>` : ''}
      <ul class="list-disc space-y-1 pl-5 marker:text-brand-400">${(s.items || []).map((i) => `<li>${esc(tr(i))}</li>`).join('')}</ul>
    </section>`).join('');
    WBG.openModal('rules-modal');
  });

  /* ---------------------------------------------------------------- results */
  let resultsTimer = 0;
  function hideResults() {
    clearInterval(resultsTimer);
    $('results').hidden = true;
  }
  function showResults(r) {
    const mine = r.rows.find((x) => x.id === S.myId);
    $('results-title').textContent = tr(r.title) || t('room.gameOver');
    $('results-sub').textContent = tr(r.subtitle);
    $('results-rows').replaceChildren(...r.rows.map((row) => {
      const li = document.createElement('li');
      const you = row.id === S.myId;
      li.className = `flex items-center gap-3 rounded-2xl border px-3 py-2.5 ${row.rank === 1 ? 'border-amber-400/50 bg-amber-500/10' : you ? 'border-brand-400/50 bg-brand-500/10' : 'border-white/8 bg-white/4'}`;
      li.innerHTML = `<span class="grid size-8 shrink-0 place-items-center rounded-full ${row.rank === 1 ? 'bg-amber-500/20 text-amber-300' : 'bg-white/8 text-slate-300'} text-sm font-bold">${row.rank === 1 ? icon('trophy', 'size-4') : row.rank}</span>
        ${WBG.avatar(row.name, 'size-8 text-xs')}
        <span class="min-w-0 flex-1"><span class="block truncate text-sm font-semibold text-white">${esc(row.name)}${you ? ` <span class="chip ml-1">${esc(t('common.you'))}</span>` : ''}</span>${row.note ? `<span class="block text-xs leading-snug text-slate-400">${esc(tr(row.note))}</span>` : ''}</span>
        ${row.score !== undefined && row.score !== null ? `<span class="text-lg font-bold text-brand-300 tabular-nums">${esc(tr(row.score))}</span>` : ''}`;
      return li;
    }));
    $('results-host').hidden = !isHost();
    $('results').hidden = false;
    clearInterval(resultsTimer);
    const tick = () => {
      const s = Math.max(0, Math.ceil((r.returnAt - Date.now()) / 1000));
      $('results-timer').textContent = s > 0 ? t('results.backIn', { n: s }) : t('results.returning');
    };
    tick();
    resultsTimer = setInterval(tick, 500);
    if (mine) WBG.sound.play(mine.rank === 1 ? 'win' : 'lose');
  }
  socket.on('game-over', async (r) => {
    if (r.game) await WBG.i18n.load(r.game); // the game's own result texts
    showResults(r);
  });
  $('results-hide').addEventListener('click', hideResults);
  $('results-again').addEventListener('click', () => { hideResults(); socket.emit('restart-game'); });
  $('results-lobby').addEventListener('click', () => { hideResults(); socket.emit('end-game'); });

  /* ------------------------------------------------------------------ games */
  fetch('/api/games').then((r) => r.json()).then((g) => { S.games = g; if (S.room) render(); }).catch(() => {
    WBG.toast(t('toast.gamesFailed'), { type: 'error' });
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
    WBG.rules = null;
    helpBtn.hidden = true;
    hideResults();
    $('game-script')?.remove();
    $('game-board').replaceChildren();
    for (const key of [...socket.eventHandlers.keys()]) {
      if (!lobbyEvents.has(key)) socket.eventHandlers.delete(key);
    }
  }

  function showLoading(game) {
    const g = S.games?.[game];
    $('loading-icon').innerHTML = icon(g?.icon || 'dice', 'size-8');
    $('loading-title').textContent = t('game.starting', { game: gameName(game) });
    $('loading-sub').textContent = t(WBG.isSpectator ? 'game.loadingHostView' : 'game.loading');
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
      await WBG.i18n.load(game);
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
        title: t('game.failTitle'),
        text: t('game.failText'),
        ok: t('game.retry'), icon: 'wifi-off', tone: 'brand'
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

  socket.on('game-started', ({ game }) => { WBG.sound.play('go'); WBG.clearToasts(); loadGame(game); });
  socket.on('back-to-lobby', () => {
    if (!S.inGame) return;
    leaveGameUi();
    WBG.toast(t('toast.backLobby'), { icon: 'home' });
    if (S.room) render();
  });

  $('banner-icon').classList.remove('hidden');
  snapshotLobbyEvents();
})();
