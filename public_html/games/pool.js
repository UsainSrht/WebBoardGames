import * as P from '/shared/pool-physics.js';

await WBG.i18n.load('pool');
WBG.i18n.apply(document.getElementById('game-board'));

(() => {
  const t = WBG.t;
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const { L, W, R } = P;
  const M = 115;                      // wood frame width around the playing surface
  const TW = L + 2 * M;
  const TH = W + 2 * M;
  const CUSHION = 46;                 // rubber cushion drawn outside the playing surface
  const COLORS = { 1: '#f2c230', 2: '#1f55c9', 3: '#d9342b', 4: '#6a2c9a', 5: '#f07a1c', 6: '#1f9150', 7: '#8a2331', 8: '#17171c' };
  const colorOf = (id) => COLORS[id > 8 ? id - 8 : id];
  const reduce = () => WBG.prefs.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;

  let state = null;
  let first = true;
  let lastNotes = '';
  let deadlineLocal = 0;
  let lastTickSec = -1;

  // aiming (mine)
  const aim = { angle: 0, base: 0, power: 0.5, spin: { x: 0, y: 0 }, cue: null, call: null };
  let aimTurnKey = '';
  // the opponent's cue as received (and smoothed for display)
  const remote = { angle: 0, power: 0, cue: null, call: null, shown: { angle: 0, power: 0 }, on: false };

  // playback of a shot
  let play = null;
  let strike = null;
  const drops = [];
  let baseBalls = new Array(16).fill(null);

  // view
  const view = { w: 0, h: 0, rot: false, s: 1, ox: 0, oy: 0, dpr: 1 };
  const canvas = $('pool-canvas');
  const ctx = canvas.getContext('2d');
  let staticLayer = null;
  let sprites = [];
  let raf = 0;
  let drag = null;

  socket.off('pool-state');
  socket.off('pool-shot');
  socket.off('pool-aim');

  /* ------------------------------------------------------------- rules text */
  WBG.setRules({
    title: t('pool.rules.title'),
    sections: [
      { title: t('pool.rules.goal'), items: [t('pool.rules.goal1'), t('pool.rules.goal2')] },
      { title: t('pool.rules.break'), items: [t('pool.rules.break1'), t('pool.rules.break2'), t('pool.rules.break3')] },
      { title: t('pool.rules.play'), items: [t('pool.rules.play1'), t('pool.rules.play2'), t('pool.rules.play3')] },
      { title: t('pool.rules.fouls'), items: [t('pool.rules.fouls1'), t('pool.rules.fouls2')] },
      { title: t('pool.rules.eight'), items: [t('pool.rules.eight1'), t('pool.rules.eight2')] },
      { title: t('pool.rules.controls'), items: [t('pool.rules.controls1'), t('pool.rules.controls2'), t('pool.rules.controls3')] },
      { title: t('pool.rules.clock'), items: [t('pool.rules.clock1')] }
    ]
  });

  /* ----------------------------------------------------------------- helpers */
  const myTurn = () => !!state && !spectator && state.turn === myId && state.phase === 'aim';
  const nameOf = (id) => state?.players.find((p) => p.id === id)?.name || '';
  const wrap = (a) => { const T = Math.PI * 2; return a - T * Math.floor(a / T); };
  const angDiff = (a, b) => { let d = wrap(a) - wrap(b); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

  /** Resting positions for the aim logic: the table as the server knows it, with my own cue placement. */
  function tablePositions() {
    const p = state ? state.balls.map((b) => (b ? [b[0], b[1]] : null)) : new Array(16).fill(null);
    return p;
  }

  function cueNow() {
    if (!state) return null;
    if (myTurn() && state.inHand && aim.cue) return { x: aim.cue.x, y: aim.cue.y };
    if (!myTurn() && state.inHand && state.phase === 'aim' && remote.on && remote.cue) return { x: remote.cue.x, y: remote.cue.y };
    const c = state.balls[0];
    return c ? { x: c[0], y: c[1] } : null;
  }

  /* ---------------------------------------------------------------- geometry */
  const toScreen = (x, y) => (view.rot
    ? { x: view.ox + (W + M - y) * view.s, y: view.oy + (x + M) * view.s }
    : { x: view.ox + (x + M) * view.s, y: view.oy + (y + M) * view.s });
  const toWorld = (sx, sy) => (view.rot
    ? { x: (sy - view.oy) / view.s - M, y: W + M - (sx - view.ox) / view.s }
    : { x: (sx - view.ox) / view.s - M, y: (sy - view.oy) / view.s - M });

  function applyWorld(c, dpr, extraScale = 1) {
    const s = view.s * dpr * extraScale;
    if (view.rot) c.setTransform(0, s, -s, 0, (view.ox + (W + M) * view.s) * dpr, (view.oy + M * view.s) * dpr);
    else c.setTransform(s, 0, 0, s, (view.ox + M * view.s) * dpr, (view.oy + M * view.s) * dpr);
  }

  function resize() {
    const stage = $('pool-stage');
    const w = Math.max(100, stage.clientWidth - 8);
    const h = Math.max(100, stage.clientHeight - 4);
    const sUp = Math.min(w / TW, h / TH);
    const sRot = Math.min(w / TH, h / TW);
    view.rot = sRot > sUp * 1.12;
    view.s = view.rot ? sRot : sUp;
    const vw = (view.rot ? TH : TW) * view.s;
    const vh = (view.rot ? TW : TH) * view.s;
    view.w = w;
    view.h = h;
    view.ox = (stage.clientWidth - vw) / 2;
    view.oy = (stage.clientHeight - vh) / 2;
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(stage.clientWidth * view.dpr);
    canvas.height = Math.round(stage.clientHeight * view.dpr);
    buildStatic();
    buildSprites();
    invalidate();
  }

  /* ------------------------------------------------------------------ table art */
  function buildStatic() {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d');
    applyWorld(g, view.dpr);

    // frame
    const wood = g.createLinearGradient(-M, -M, TW, TH);
    wood.addColorStop(0, '#6b3a1e');
    wood.addColorStop(0.5, '#8a5028');
    wood.addColorStop(1, '#5a2f17');
    g.fillStyle = '#000';
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 30 * view.s * view.dpr;
    g.beginPath(); g.roundRect(-M, -M, TW, TH, 70); g.fill();
    g.shadowBlur = 0;
    g.fillStyle = wood;
    g.beginPath(); g.roundRect(-M, -M, TW, TH, 70); g.fill();
    // wood grain
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = 3;
    for (let i = 0; i < 26; i++) {
      const y = -M + (i * TH) / 26 + ((i * 37) % 11);
      g.beginPath(); g.moveTo(-M + 20, y); g.bezierCurveTo(L * 0.3, y + 14, L * 0.7, y - 14, L + M - 20, y); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 4;
    g.beginPath(); g.roundRect(-M + 3, -M + 3, TW - 6, TH - 6, 68); g.stroke();

    // cushions (rubber)
    g.fillStyle = '#0b5a38';
    g.beginPath(); g.roundRect(-CUSHION, -CUSHION, L + 2 * CUSHION, W + 2 * CUSHION, 26); g.fill();
    // felt
    const felt = g.createRadialGradient(L / 2, W / 2, 80, L / 2, W / 2, L * 0.62);
    felt.addColorStop(0, '#1a9a61');
    felt.addColorStop(1, '#0e7448');
    g.fillStyle = felt;
    g.fillRect(0, 0, L, W);
    g.strokeStyle = 'rgba(0,0,0,0.28)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, L, W);

    // table markings
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(P.HEAD_X, 0); g.lineTo(P.HEAD_X, W); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    for (const x of [P.HEAD_X, L / 2, P.FOOT_X]) { g.beginPath(); g.arc(x, W / 2, 7, 0, 7); g.fill(); }

    // diamonds
    g.fillStyle = '#efe6cf';
    const diamond = (x, y) => { g.beginPath(); g.moveTo(x, y - 13); g.lineTo(x + 9, y); g.lineTo(x, y + 13); g.lineTo(x - 9, y); g.closePath(); g.fill(); };
    for (const k of [1, 2, 3, 5, 6, 7]) {
      diamond((L * k) / 8, -(CUSHION + (M - CUSHION) / 2));
      diamond((L * k) / 8, W + CUSHION + (M - CUSHION) / 2);
    }
    for (const k of [1, 2, 3]) {
      diamond(-(CUSHION + (M - CUSHION) / 2), (W * k) / 4);
      diamond(L + CUSHION + (M - CUSHION) / 2, (W * k) / 4);
    }

    // pockets
    const holes = [[-22, -22, 64], [L / 2, -34, 54], [L + 22, -22, 64], [-22, W + 22, 64], [L / 2, W + 34, 54], [L + 22, W + 22, 64]];
    for (const [x, y, r] of holes) {
      g.fillStyle = '#2a2018';
      g.beginPath(); g.arc(x, y, r + 11, 0, 7); g.fill();
      const hole = g.createRadialGradient(x, y, 4, x, y, r);
      hole.addColorStop(0, '#000');
      hole.addColorStop(1, '#0a0a0a');
      g.fillStyle = hole;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      g.strokeStyle = 'rgba(205,170,110,0.55)';
      g.lineWidth = 5;
      g.beginPath(); g.arc(x, y, r + 8, 0, 7); g.stroke();
    }
    staticLayer = c;
  }

  /* ---------------------------------------------------------------- ball art */
  function paintBall(g, id, cx, cy, r, numberUpright = true) {
    const stripe = id > 8;
    const col = id === 0 ? '#f6f3ea' : colorOf(id);
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, 7); g.clip();
    g.fillStyle = stripe || id === 0 ? '#f6f3ea' : col;
    g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    if (stripe) {
      g.fillStyle = col;
      g.fillRect(cx - r, cy - r * 0.55, 2 * r, r * 1.1);
    }
    if (id > 0) {
      g.fillStyle = '#f6f3ea';
      g.beginPath(); g.arc(cx, cy, r * 0.46, 0, 7); g.fill();
      g.fillStyle = '#111';
      g.font = `800 ${r * (id > 9 ? 0.56 : 0.66)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(id), cx, cy + r * 0.04);
    } else {
      g.fillStyle = 'rgba(200,40,40,0.9)';
      g.beginPath(); g.arc(cx, cy - r * 0.55, r * 0.09, 0, 7); g.fill();
    }
    const shade = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    shade.addColorStop(0, 'rgba(255,255,255,0.0)');
    shade.addColorStop(0.65, 'rgba(0,0,0,0.0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = shade;
    g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    const gloss = g.createRadialGradient(cx - r * 0.38, cy - r * 0.42, 0, cx - r * 0.38, cy - r * 0.42, r * 0.5);
    gloss.addColorStop(0, 'rgba(255,255,255,0.85)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gloss;
    g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    g.restore();
  }

  function buildSprites() {
    sprites = [];
    const r = R * view.s * view.dpr;
    const size = Math.ceil(r * 2) + 2;
    for (let id = 0; id < 16; id++) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      paintBall(c.getContext('2d'), id, size / 2, size / 2, r);
      sprites.push(c);
    }
  }

  function ballSvg(id, size = 20) {
    const r = 10;
    const col = colorOf(id);
    const stripe = id > 8;
    const clip = `pc${id}`;
    return `<svg class="pool-mini" style="width:${size}px;height:${size}px" viewBox="0 0 20 20" aria-hidden="true"><defs><clipPath id="${clip}"><circle cx="10" cy="10" r="${r}"/></clipPath></defs>
      <g clip-path="url(#${clip})"><rect width="20" height="20" fill="${stripe ? '#f6f3ea' : col}"/>${stripe ? `<rect y="4.5" width="20" height="11" fill="${col}"/>` : ''}
      <circle cx="10" cy="10" r="4.8" fill="#f6f3ea"/><text x="10" y="13.2" text-anchor="middle" font-size="${id > 9 ? 6.6 : 7.6}" font-weight="800" font-family="system-ui,sans-serif" fill="#111">${id}</text>
      <circle cx="7" cy="6.5" r="3" fill="#fff" opacity=".28"/></g><circle cx="10" cy="10" r="9.6" fill="none" stroke="rgba(0,0,0,.35)"/></svg>`;
  }

  /* ----------------------------------------------------------------- drawing */
  function invalidate() { if (!raf) raf = requestAnimationFrame(frame); }

  function currentBalls() {
    const out = [];
    if (play) {
      for (const b of play.sim.balls) if (b.on) out.push({ id: b.id, x: b.x, y: b.y });
      return out;
    }
    const cue = cueNow();
    for (let i = 0; i < 16; i++) {
      const p = state?.balls[i];
      if (i === 0) { if (cue) out.push({ id: 0, x: cue.x, y: cue.y }); continue; }
      if (p) out.push({ id: i, x: p[0], y: p[1] });
    }
    return out;
  }

  function drawStick(g, cue, angle, pull, alpha = 1) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tip = R + 10 + pull;
    const len = 1500;
    const x0 = cue.x - dx * tip;
    const y0 = cue.y - dy * tip;
    const x1 = cue.x - dx * (tip + len);
    const y1 = cue.y - dy * (tip + len);
    const nx = -dy;
    const ny = dx;
    const w0 = 7;
    const w1 = 17;
    g.save();
    g.globalAlpha = alpha;
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.moveTo(x0 + nx * w0 + 10, y0 + ny * w0 + 14); g.lineTo(x1 + nx * w1 + 10, y1 + ny * w1 + 14);
    g.lineTo(x1 - nx * w1 + 10, y1 - ny * w1 + 14); g.lineTo(x0 - nx * w0 + 10, y0 - ny * w0 + 14);
    g.fill();
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, '#6fb6e8');
    grad.addColorStop(0.012, '#f1efe6');
    grad.addColorStop(0.04, '#e9d4a2');
    grad.addColorStop(0.55, '#d9b073');
    grad.addColorStop(0.58, '#2b1a12');
    grad.addColorStop(1, '#1b0f0a');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 + nx * w0, y0 + ny * w0); g.lineTo(x1 + nx * w1, y1 + ny * w1);
    g.lineTo(x1 - nx * w1, y1 - ny * w1); g.lineTo(x0 - nx * w0, y0 - ny * w0);
    g.closePath(); g.fill();
    g.restore();
  }

  function pocketRing(g, k, strong) {
    const p = P.POCKETS[k];
    const cx = p.x + (p.corner ? (p.x === 0 ? -14 : 14) : 0);
    const cy = p.y + (p.y <= 0 ? -22 : p.y >= W ? 22 : 0) * (p.corner ? 0.6 : 1);
    g.save();
    g.lineWidth = strong ? 12 : 7;
    g.strokeStyle = strong ? '#fbbf24' : 'rgba(251,191,36,0.55)';
    g.beginPath(); g.arc(cx, cy, p.r + 28, 0, 7); g.stroke();
    if (strong) { g.fillStyle = 'rgba(251,191,36,0.2)'; g.fill(); }
    g.restore();
  }

  function drawGuide(g, cue, angle, positions, strongAlpha) {
    const pr = P.aimPreview(positions, cue, angle);
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = `rgba(255,255,255,${0.75 * strongAlpha})`;
    g.lineWidth = 5;
    g.setLineDash([22, 16]);
    g.beginPath(); g.moveTo(cue.x, cue.y); g.lineTo(pr.point.x, pr.point.y); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = `rgba(255,255,255,${0.9 * strongAlpha})`;
    g.lineWidth = 4;
    g.beginPath(); g.arc(pr.point.x, pr.point.y, R, 0, 7); g.stroke();
    if (pr.hit !== null && strongAlpha > 0.9) {
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(pr.target.x, pr.target.y); g.lineTo(pr.target.x + pr.objDir.x * 520, pr.target.y + pr.objDir.y * 520); g.stroke();
      if (pr.cueSpeed > 0.05) {
        g.strokeStyle = 'rgba(147,197,253,0.9)';
        g.lineWidth = 4;
        g.beginPath(); g.moveTo(pr.point.x, pr.point.y); g.lineTo(pr.point.x + pr.cueDir.x * 260 * pr.cueSpeed, pr.point.y + pr.cueDir.y * 260 * pr.cueSpeed); g.stroke();
      }
    }
    g.restore();
  }

  function draw(now) {
    if (!state) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0);

    const balls = currentBalls();
    const mine = myTurn();
    const cue = cueNow();

    // world layer: markings under the balls
    applyWorld(ctx, view.dpr);
    if (state.inHand && state.breakShot && state.phase === 'aim') {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, 0, P.HEAD_X, W);
    }
    if (mine && state.mustCall) {
      for (let k = 0; k < 6; k++) pocketRing(ctx, k, aim.call === k);
    } else if (state.phase === 'aim' && !mine && remote.on && remote.call !== null && state.mustCall) {
      pocketRing(ctx, remote.call, true);
    }

    // shadows
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (const b of balls) {
      ctx.beginPath(); ctx.ellipse(b.x + 7, b.y + 10, R * 0.98, R * 0.9, 0, 0, 7); ctx.fill();
    }

    // balls (sprites are upright in screen space)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const half = sprites[0] ? sprites[0].width / 2 : 0;
    for (const b of balls) {
      const sp = toScreen(b.x, b.y);
      ctx.drawImage(sprites[b.id], sp.x * view.dpr - half, sp.y * view.dpr - half);
    }
    // balls dropping into a pocket
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const k = Math.min(1, (now - d.t0) / 260);
      if (k >= 1) { drops.splice(i, 1); continue; }
      const sp = toScreen(d.x + (d.tx - d.x) * k, d.y + (d.ty - d.y) * k);
      const sc = 1 - k * 0.7;
      ctx.globalAlpha = 1 - k * 0.6;
      ctx.drawImage(sprites[d.id], sp.x * view.dpr - half * sc, sp.y * view.dpr - half * sc, half * 2 * sc, half * 2 * sc);
      ctx.globalAlpha = 1;
    }

    // cue ball in hand marker
    applyWorld(ctx, view.dpr);
    if (state.inHand && state.phase === 'aim' && cue) {
      ctx.strokeStyle = mine ? 'rgba(251,191,36,0.95)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 9]);
      ctx.beginPath(); ctx.arc(cue.x, cue.y, R + 14, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }

    // cue and guides
    if (strike) {
      const k = Math.min(1, (now - strike.t0) / strike.dur);
      const e = k * k;
      drawStick(ctx, strike.cue, strike.angle, strike.pull * (1 - e) - 6 * e);
      if (k >= 1) strike = null;
    } else if (state.phase === 'aim' && cue) {
      if (mine) {
        drawGuide(ctx, cue, aim.angle, tablePositions().map((p, i) => (i === 0 ? [cue.x, cue.y] : p)), 1);
        drawStick(ctx, cue, aim.angle, 14 + aim.power * 360);
      } else if (remote.on) {
        drawGuide(ctx, cue, remote.shown.angle, tablePositions().map((p, i) => (i === 0 ? [cue.x, cue.y] : p)), 0.5);
        drawStick(ctx, cue, remote.shown.angle, 14 + remote.shown.power * 360, 0.95);
      }
    }
  }

  let lastFrame = 0;
  function frame(now) {
    raf = 0;
    let animating = false;
    if (play) { stepPlay(now); animating = !!play; }
    if (strike || drops.length) animating = true;
    if (remote.on && state && state.phase === 'aim' && !myTurn()) {
      const da = angDiff(remote.angle, remote.shown.angle);
      const dp = remote.power - remote.shown.power;
      if (Math.abs(da) > 0.0005 || Math.abs(dp) > 0.002) {
        const k = 1 - Math.pow(0.0005, (now - (lastFrame || now - 16)) / 1000);
        remote.shown.angle += da * Math.min(1, k + 0.1);
        remote.shown.power += dp * Math.min(1, k + 0.1);
        animating = true;
      } else { remote.shown.angle = remote.angle; remote.shown.power = remote.power; }
    }
    lastFrame = now;
    draw(now);
    if (animating) invalidate();
  }

  /* ------------------------------------------------------------------ playback */
  let soundBudget = 0;
  let lastSound = {};
  function clack(kind, v, now) {
    if (now - (lastSound[kind] || 0) < 28 || soundBudget <= 0) return;
    soundBudget--;
    lastSound[kind] = now;
    if (kind === 'hit') {
      if (v > 2200) { WBG.sound.play('bump'); WBG.haptic(18); }
      else if (v > 800) { WBG.sound.play('place'); WBG.haptic(10); }
      else if (v > 120) WBG.sound.play('click');
    } else if (kind === 'rail') {
      if (v > 1200) { WBG.sound.play('land'); WBG.haptic(8); }
      else if (v > 250) WBG.sound.play('click');
    } else if (kind === 'pocket') {
      WBG.sound.play('fall');
      WBG.haptic([25, 30, 15]);
    }
  }

  function startPlay(msg, restored) {
    endPlay(false);
    const sim = P.createSim(msg.from, msg.shot);
    const now = performance.now();
    const delay = restored || reduce() ? 0 : 150;
    play = { seq: msg.seq, sim, msg, t0: now + delay - (msg.elapsed || 0), evIdx: 0, silent: !!restored && (msg.elapsed || 0) > 400 };
    if (!restored && !reduce()) {
      const pull = 14 + (msg.shot.power) * 360;
      strike = { t0: now, dur: 150, cue: { x: msg.from[0][0], y: msg.from[0][1] }, angle: msg.shot.angle, pull };
      WBG.sound.later('place', 120);
    }
    invalidate();
  }

  function stepPlay(now) {
    if (!play) return;
    const target = Math.floor((now - play.t0) / P.TICK_MS);
    if (target < 0) return;
    const lag = target - play.sim.tick;
    let guard = lag > 60 ? 12000 : 24;
    soundBudget = 4;
    while (play.sim.tick < target && !play.sim.done && guard-- > 0) P.stepSim(play.sim);
    const evs = play.sim.events;
    const quiet = lag > 60;
    for (; play.evIdx < evs.length; play.evIdx++) {
      const e = evs[play.evIdx];
      if (e.type === 'pocket') {
        const b = play.sim.balls[e.ball];
        const pk = P.POCKETS[e.pocket];
        drops.push({ id: e.ball, x: b.x, y: b.y, tx: pk.x, ty: pk.y, t0: now });
        if (!quiet) clack('pocket', 0, now);
      } else if (!quiet && e.type === 'hit') clack('hit', e.v, now);
      else if (!quiet && e.type === 'rail') clack('rail', e.v, now);
    }
    if (play.sim.done) endPlay(true);
  }

  /** Stop the replay and show the authoritative resting positions. */
  function endPlay(snap) {
    if (!play) return;
    const final = play.msg.final;
    play = null;
    if (snap && state && state.phase === 'rolling') {
      baseBalls = final;
      state.balls = final;
    }
    invalidate();
  }

  /* --------------------------------------------------------------------- UI */
  function groupLabel(g) { return g ? t(`pool.group.${g}`) : t('pool.group.open'); }

  function renderPlayers() {
    const box = $('pool-players');
    box.replaceChildren(...state.players.map((p) => {
      const turn = state.turn === p.id && (state.phase === 'aim' || state.phase === 'rolling' || state.phase === 'rerack') && state.phase !== 'over';
      const div = document.createElement('div');
      const ids = p.group === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : p.group === 'stripe' ? [9, 10, 11, 12, 13, 14, 15] : [];
      const cleared = ids.length && ids.every((b) => state.down.includes(b));
      div.className = `flex min-w-0 flex-col gap-1 rounded-2xl border px-2.5 py-1.5 transition ${turn && state.phase !== 'over' ? 'border-emerald-400/70 bg-emerald-500/12' : 'border-white/8 bg-white/4'}`;
      const tray = ids.length
        ? ids.map((b) => `<span class="${state.down.includes(b) ? '' : 'opacity-25'}">${ballSvg(b, 17)}</span>`).join('')
        : '<span class="text-[11px] text-slate-500">&nbsp;</span>';
      div.innerHTML = `<div class="flex min-w-0 items-center gap-2">${WBG.avatar(p.name, 'size-7 text-xs')}
        <p class="min-w-0 flex-1 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}${p.id === myId ? ` <span class="text-xs font-normal text-slate-400">${WBG.esc(t('pool.you'))}</span>` : ''}</p></div>
        <div class="flex min-h-[22px] flex-wrap items-center gap-x-1.5 gap-y-0.5"><span class="chip ${p.group ? 'chip-brand' : ''} !px-2 !py-0.5">${WBG.esc(groupLabel(p.group))}</span><span class="flex items-center gap-0.5">${tray}</span>${cleared ? `<span class="flex items-center gap-1 text-[11px] font-bold text-amber-300">${ballSvg(8, 17)}<span>${WBG.esc(t('pool.onEight'))}</span></span>` : ''}</div>`;
      return div;
    }));
  }

  function statusText() {
    const s = state;
    const name = nameOf(s.turn);
    if (s.phase === 'over') {
      if (spectator) return t('pool.status.winnerIs', { name: nameOf(s.winner) });
      return s.winner === myId ? t('pool.status.won') : t('pool.status.lost', { name: nameOf(s.winner) });
    }
    if (!s.started) return t('pool.status.starting');
    if (s.phase === 'rolling') return t('pool.status.rolling');
    if (s.phase === 'rerack') return s.chooser === myId ? t('pool.status.chooseRerack') : t('pool.status.waitRerack', { name: nameOf(s.chooser) });
    if (myTurn()) {
      if (s.mustCall && aim.call === null) return t('pool.status.callPocket');
      if (s.inHand && s.breakShot) return t('pool.status.yourBreak');
      if (s.inHand) return t('pool.status.yourInHand');
      return t('pool.status.yourTurn');
    }
    if (s.inHand && !s.breakShot) return t('pool.status.theirInHand', { name });
    return t('pool.status.theirTurn', { name });
  }

  function renderUi() {
    renderPlayers();
    $('pool-status').textContent = statusText();
    const mine = myTurn();
    $('pool-controls').hidden = spectator || state.phase === 'over';
    for (const id of ['pool-shoot', 'pool-aim-minus', 'pool-aim-plus', 'pool-fine', 'pool-power']) $(id).disabled = !mine;
    $('pool-spin').style.opacity = mine ? '1' : '0.45';
    $('pool-shoot').disabled = !mine || (state.mustCall && aim.call === null);
    const hint = $('pool-hint');
    hint.textContent = mine ? (state.inHand ? t('pool.hint.inHand') : t('pool.hint.aim')) : '';
    // re-rack choice
    const rr = state.phase === 'rerack';
    $('pool-rerack').hidden = !rr;
    if (rr) {
      const me = state.chooser === myId;
      const breaker = state.players.find((p) => p.id !== state.chooser);
      $('pool-rerack-text').textContent = me ? t('pool.rerack.choose', { name: breaker?.name || '' }) : t('pool.rerack.waiting', { name: nameOf(state.chooser) });
      $('pool-rerack-btns').hidden = !me || spectator;
    }
    paintSpin();
    updateClock();
  }

  function updateClock() {
    if (!state) return;
    const has = state.timeLeft !== null && state.timeLeft !== undefined && deadlineLocal && (state.phase === 'aim' || state.phase === 'rerack');
    $('pool-clock').classList.toggle('invisible', !has);
    $('pool-bar-wrap').classList.toggle('invisible', !has);
    if (!has) return;
    const left = Math.max(0, deadlineLocal - performance.now());
    $('pool-clock-text').textContent = WBG.clock(left);
    $('pool-bar').style.width = `${Math.min(100, (left / (state.shotClock * 1000)) * 100)}%`;
    const s = Math.ceil(left / 1000);
    const urgent = s <= 10;
    $('pool-clock').classList.toggle('chip-danger', urgent);
    if (urgent && s <= 5 && s > 0 && s !== lastTickSec && (state.turn === myId || state.chooser === myId) && !spectator) { lastTickSec = s; WBG.sound.play('tick'); }
  }
  const clockTimer = setInterval(updateClock, 200);

  /* -------------------------------------------------------------- spin selector */
  const spinCv = $('pool-spin');
  function paintSpin() {
    const g = spinCv.getContext('2d');
    const S = spinCv.width;
    const c = S / 2;
    const r = S * 0.46;
    g.clearRect(0, 0, S, S);
    const grad = g.createRadialGradient(c - r * 0.3, c - r * 0.35, r * 0.1, c, c, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#c9c6bb');
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, r, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(c, c, r, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.moveTo(c, c - r); g.lineTo(c, c + r);
    g.setLineDash([6, 8]); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(c, c, r * 0.5, 0, 7); g.stroke();
    const x = c + aim.spin.x * r * 0.9;
    const y = c - aim.spin.y * r * 0.9;
    g.fillStyle = '#e11d48';
    g.beginPath(); g.arc(x, y, S * 0.065, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
    spinCv.setAttribute('aria-valuetext', `${Math.round(aim.spin.x * 100)}, ${Math.round(aim.spin.y * 100)}`);
  }
  function spinFromEvent(e) {
    const rect = spinCv.getBoundingClientRect();
    let x = ((e.clientX - rect.left) / rect.width - 0.5) / 0.46 / 0.9;
    let y = -((e.clientY - rect.top) / rect.height - 0.5) / 0.46 / 0.9;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (len < 0.12) { x = 0; y = 0; }
    aim.spin = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    paintSpin();
    sendAim();
  }
  let spinDown = false;
  spinCv.addEventListener('pointerdown', (e) => { if (!myTurn()) return; spinDown = true; spinCv.setPointerCapture(e.pointerId); spinFromEvent(e); });
  spinCv.addEventListener('pointermove', (e) => { if (spinDown) spinFromEvent(e); });
  spinCv.addEventListener('pointerup', () => { spinDown = false; });
  spinCv.addEventListener('pointercancel', () => { spinDown = false; });
  spinCv.addEventListener('keydown', (e) => {
    if (!myTurn()) return;
    const step = 0.1;
    if (e.key === 'ArrowLeft') aim.spin.x = Math.max(-1, aim.spin.x - step);
    else if (e.key === 'ArrowRight') aim.spin.x = Math.min(1, aim.spin.x + step);
    else if (e.key === 'ArrowUp') aim.spin.y = Math.min(1, aim.spin.y + step);
    else if (e.key === 'ArrowDown') aim.spin.y = Math.max(-1, aim.spin.y - step);
    else return;
    e.preventDefault();
    paintSpin();
    sendAim();
  });
  $('pool-spin-reset').addEventListener('click', () => { aim.spin = { x: 0, y: 0 }; paintSpin(); sendAim(); });

  /* ------------------------------------------------------------ aim controls */
  let sendTimer = 0;
  let lastSent = 0;
  function sendAim() {
    if (!myTurn()) return;
    invalidate();
    if (sendTimer) return;
    const wait = Math.max(0, 100 - (performance.now() - lastSent));
    sendTimer = setTimeout(() => {
      sendTimer = 0;
      if (!myTurn()) return;
      lastSent = performance.now();
      const msg = { angle: aim.angle, power: aim.power, spin: aim.spin };
      if (state.inHand && aim.cue) msg.cue = aim.cue;
      if (aim.call !== null) msg.call = aim.call;
      socket.emit('pool-aim', msg);
    }, wait);
  }

  function setAngle(a, fromPointer = false) {
    aim.angle = wrap(a);
    if (fromPointer) { aim.base = aim.angle; $('pool-fine').value = '0'; }
    sendAim();
  }
  $('pool-fine').addEventListener('input', () => {
    aim.angle = wrap(aim.base + (Number($('pool-fine').value) / 10) * (Math.PI / 180));
    sendAim();
  });
  function nudge(dir, big = false) {
    const step = (big ? 1 : 0.2) * (Math.PI / 180) * dir;
    aim.base = wrap(aim.base + step);
    aim.angle = wrap(aim.base + (Number($('pool-fine').value) / 10) * (Math.PI / 180));
    sendAim();
  }
  for (const [id, dir] of [['pool-aim-minus', -1], ['pool-aim-plus', 1]]) {
    const b = $(id);
    let hold = 0;
    let rep = 0;
    const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = 0; };
    b.addEventListener('pointerdown', (e) => {
      if (!myTurn()) return;
      e.preventDefault();
      nudge(dir);
      hold = setTimeout(() => { rep = setInterval(() => nudge(dir), 60); }, 350);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nudge(dir); } });
    WBG.onTeardown(stop);
  }

  $('pool-power').addEventListener('input', () => {
    aim.power = Number($('pool-power').value) / 100;
    $('pool-power-val').textContent = String(Math.round(aim.power * 100));
    sendAim();
  });

  function shoot() {
    if (!myTurn() || $('pool-shoot').disabled) return;
    const msg = { angle: aim.angle, power: Math.max(0.02, aim.power), spin: aim.spin };
    if (state.inHand) { const c = cueNow(); if (c) msg.cue = { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 }; }
    if (state.mustCall) msg.call = aim.call;
    WBG.haptic(15);
    socket.emit('pool-shot', msg);
  }
  $('pool-shoot').addEventListener('click', shoot);
  $('pool-accept').addEventListener('click', () => socket.emit('pool-rerack', { accept: true }));
  $('pool-redo').addEventListener('click', () => socket.emit('pool-rerack', { accept: false }));

  const onKey = (e) => {
    if (!myTurn() || e.target.closest?.('input, textarea, select, button, [contenteditable], canvas#pool-spin')) return;
    if (e.key === 'ArrowLeft') { nudge(-1, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { nudge(1, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      aim.power = Math.max(0, Math.min(1, aim.power + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
      $('pool-power').value = String(Math.round(aim.power * 100));
      $('pool-power-val').textContent = String(Math.round(aim.power * 100));
      sendAim();
      e.preventDefault();
    } else if (e.key === 'Enter') { shoot(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  /* ----------------------------------------------------------- table pointer */
  function pointerWorld(e) {
    const rect = canvas.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!myTurn()) return;
    const w = pointerWorld(e);
    const cue = cueNow();
    if (!cue) return;
    if (state.mustCall) {
      let best = -1;
      let bd = 170;
      P.POCKETS.forEach((p, k) => { const d = Math.hypot(p.x - w.x, p.y - w.y); if (d < bd) { bd = d; best = k; } });
      if (best >= 0) {
        aim.call = best;
        WBG.sound.play('click');
        renderUi();
        sendAim();
        invalidate();
        return;
      }
    }
    canvas.setPointerCapture(e.pointerId);
    const grab = 2.4 * R + 30 / view.s;
    if (state.inHand && Math.hypot(w.x - cue.x, w.y - cue.y) < grab) {
      drag = { mode: 'cue', dx: cue.x - w.x, dy: cue.y - w.y };
      if (!aim.cue) aim.cue = { x: cue.x, y: cue.y };
    } else {
      drag = { mode: 'aim' };
      setAngle(Math.atan2(w.y - cue.y, w.x - cue.x), true);
    }
    invalidate();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !myTurn()) return;
    const w = pointerWorld(e);
    if (drag.mode === 'aim') {
      const cue = cueNow();
      if (Math.hypot(w.x - cue.x, w.y - cue.y) > R * 0.6) setAngle(Math.atan2(w.y - cue.y, w.x - cue.x), true);
    } else {
      const n = P.nearestCue(tablePositions(), w.x + drag.dx, w.y + drag.dy, state.breakShot);
      if (n) { aim.cue = { x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100 }; sendAim(); }
    }
    invalidate();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* ------------------------------------------------------------------ socket */
  function initAimForTurn() {
    const cue = cueNow();
    const pos = tablePositions();
    let best = null;
    if (cue && !state.breakShot) {
      const mine = state.players.find((p) => p.id === myId)?.group;
      const own = mine ? (mine === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]).filter((b) => !state.down.includes(b)) : [];
      const targets = mine ? (own.length ? own : [8]) : [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
      let bd = Infinity;
      for (const i of targets) {
        if (!pos[i]) continue;
        const d = Math.hypot(pos[i][0] - cue.x, pos[i][1] - cue.y);
        if (d < bd) { bd = d; best = pos[i]; }
      }
    }
    aim.angle = best ? wrap(Math.atan2(best[1] - cue.y, best[0] - cue.x)) : 0;
    aim.base = aim.angle;
    aim.cue = null;
    aim.call = null;
    $('pool-fine').value = '0';
  }

  socket.on('pool-state', (s) => {
    const prev = state;
    state = s;
    deadlineLocal = s.timeLeft !== null && s.timeLeft !== undefined ? performance.now() + s.timeLeft : 0;

    if (s.phase === 'rolling' && s.shot) {
      if (!play || play.seq !== s.shot.seq) startPlay(s.shot, true);
    } else if (play) {
      const final = play.msg.final;
      play = null;
      void final;
    }
    baseBalls = s.balls;

    const key = `${s.seq}:${s.turn}:${s.phase}:${s.inHand}:${s.chooser || ''}`;
    if (s.phase === 'aim' && s.turn === myId && !spectator && key !== aimTurnKey) {
      aimTurnKey = key;
      initAimForTurn();
    }
    if (s.phase !== 'aim' || s.turn !== (prev?.turn)) remote.on = false;
    if (s.aim && s.aim.by !== myId) applyRemote(s.aim, true);

    // announcements
    const notesKey = JSON.stringify(s.last || null) + s.seq;
    if (!first && s.last && notesKey !== lastNotes && s.phase !== 'rolling') {
      for (const n of s.last.notes) WBG.toast(WBG.tr(n), { type: s.last.foul ? 'error' : 'info' });
      if (s.last.foul) WBG.sound.play('error');
    }
    lastNotes = notesKey;
    if (prev && s.phase === 'aim' && s.turn === myId && (prev.turn !== s.turn || prev.phase !== 'aim') && !spectator) { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
    first = false;
    renderUi();
    invalidate();
  });

  socket.on('pool-shot', (m) => {
    if (!state) return;
    state.phase = 'rolling';
    state.shot = m;
    remote.on = false;
    startPlay(m, false);
    renderUi();
  });

  function applyRemote(a, snap) {
    remote.angle = a.angle;
    remote.power = a.power;
    remote.cue = a.cue || null;
    remote.call = a.call ?? null;
    remote.on = true;
    if (snap) { remote.shown.angle = a.angle; remote.shown.power = a.power; }
    invalidate();
  }
  socket.on('pool-aim', (a) => {
    if (!state || state.phase !== 'aim' || a.by === myId || a.by !== state.turn) return;
    applyRemote(a, !remote.on);
  });

  /* ------------------------------------------------------------ lifecycle */
  const ro = new ResizeObserver(() => resize());
  ro.observe($('pool-stage'));
  const onWin = () => resize();
  window.addEventListener('orientationchange', onWin);
  WBG.onTeardown(() => {
    ro.disconnect();
    window.removeEventListener('orientationchange', onWin);
    document.removeEventListener('keydown', onKey);
    clearInterval(clockTimer);
    clearTimeout(sendTimer);
    cancelAnimationFrame(raf);
    socket.off('pool-state');
    socket.off('pool-shot');
    socket.off('pool-aim');
  });

  resize();
  paintSpin();
  WBG.gameReady('pool-page-loaded');
})();
