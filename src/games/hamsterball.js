/**
 * Hamsterball game logic (runs inside the GameRoom Durable Object).
 *
 * Server authoritative: a fixed 60 Hz simulation (independent of timer jitter) with snapshots
 * broadcast every ~40 ms. All game time is simulated time (advance(ms)), so the whole match can
 * be stepped deterministically in tests.
 *
 * Match: `rounds` rounds, each with `lives` lives per player. The last ball standing wins the round
 * (a point). If the last balls fall in the same tick the one that crossed the edge later wins; an
 * exact tie gives everybody involved a point. Ranking: round wins, then total lives left over all
 * rounds, then time survived.
 *
 * Client -> server: 'hamsterball-ready', 'hamsterball-move' { x, y, boost }
 * Server -> client: 'hb-init' (static info) and 'hb-state' (full snapshot, never a delta)
 */

export const PLATE_RADIUS = 200;
export const BALL_RADIUS = 20;

export const CFG = {
  STEP_MS: 1000 / 60,
  BROADCAST_MS: 40,
  COUNTDOWN_MS: 3000,
  ROUND_OVER_MS: 3600,
  READY_TIMEOUT_MS: 8000,
  RESULTS_DELAY_MS: 20000,

  ACCEL: 460, // units / s^2 at full input
  BOOST_ACCEL: 1.9, // acceleration multiplier while boosting
  BOOST_MASS: 1.6, // a boosting ball is heavier, so it hits harder
  FRICTION: 2.2, // exponential velocity damping per second
  MAX_SPEED: 560,
  RESTITUTION: 0.92,
  BUMP_MIN: 70, // impact speed that produces a bump event
  BUMP_SCALE: 420,

  STAMINA_DRAIN: 0.55, // per second while boosting (full bar lasts ~1.8 s)
  STAMINA_REGEN: 0.3,
  REGEN_DELAY: 0.4, // s after boosting stops before regen starts
  DEPLETED_COOLDOWN: 1.0, // s of lockout after the bar hits zero

  TILT_MAX: 0.16, // rad, visual
  TILT_ACCEL: 120, // units / s^2 downhill at full tilt
  TILT_EASE: 4,

  FALL_S: 0.9, // falling animation before respawn / removal
  INVULN_S: 1.5,

  SHRINK_START_S: 15,
  SUDDEN_DEATH_S: 120, // with shrinking off, the plate still shrinks after this
  SHRINK_DURATION_S: 60,
  SHRINK_TO: 0.45,

  INPUT_TTL_MS: 700 // heartbeat is 250 ms; older input is ignored
};

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Hamsterball {
  constructor(room, players, options = {}, env = {}) {
    this.room = room;
    this.now = env.now || (() => Date.now());
    this.rng = env.rng || Math.random;

    this.rounds = [1, 3, 5].includes(Number(options.rounds)) ? Number(options.rounds) : 3;
    this.livesPerRound = [1, 3, 5].includes(Number(options.lives)) ? Number(options.lives) : 3;
    this.shrink = options.shrink !== 'off';

    this.pl = {};
    this.order = [];
    Object.entries(players || {}).forEach(([odId, p], i) => {
      this.order.push(odId);
      this.pl[odId] = {
        id: odId, name: String(p?.name ?? 'Player'), ci: i,
        x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0,
        lives: this.livesPerRound, stamina: 1, regenIn: 0, lockout: 0,
        inv: 0, fall: 0, boosting: false,
        ix: 0, iy: 0, iboost: false, iage: 0,
        wins: 0, totalLives: 0, survived: 0, outAt: -1, left: false
      };
    });
    this.initialCount = this.order.length;

    this.phase = 'wait'; // wait | countdown | playing | roundover | over
    this.round = 0;
    this.phaseMs = 0;
    this.playT = 0; // seconds of play in the current round
    this.simMs = 0; // total simulated time, lets clients smooth out network jitter
    this.roundStartCount = 0;
    this.result = null;
    this.events = [];
    this.tv = { x: 0, y: 0 };
    this.radius = PLATE_RADIUS;
    this.pairCooldown = new Map();
    this.respawnCount = 0;

    this.ready = new Set();
    this.started = false;
    this.finished = false;
    this.acc = 0;
    this.lastTick = 0;
    this.sinceBroadcast = 0;
    this.loop = null;
    this.readyTimer = null;
  }

  // ------------------------------------------------------------------ messages

  handleMessage(odId, type, payload) {
    if (this.finished && type !== 'hamsterball-ready') return;
    if (!this.pl[odId] || this.pl[odId].left) return;
    if (type === 'hamsterball-ready') return this.handleReady(odId);
    if (type === 'hamsterball-move') return this.handleMove(odId, payload);
  }

  handleReady(odId) {
    if (this.started) return this.sendInit(odId); // reload / late joiner: resync
    this.ready.add(odId);
    if (this.activeIds().every((id) => this.ready.has(id))) return this.startGame();
    if (!this.readyTimer) this.readyTimer = setTimeout(() => this.startGame(), CFG.READY_TIMEOUT_MS);
  }

  handleMove(odId, payload) {
    const p = this.pl[odId];
    if (!p || !payload || typeof payload !== 'object') return;
    let x = Number(payload.x);
    let y = Number(payload.y);
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    p.ix = x;
    p.iy = y;
    p.iboost = payload.boost === true;
    p.iage = 0;
  }

  spectatorSync(odId) {
    this.sendInit(odId, true);
  }

  onPlayerLeft(odId) {
    const p = this.pl[odId];
    if (!p || p.left) return;
    p.left = true;
    this.ready.delete(odId);
    if (this.finished) return;
    if (this.phase === 'playing' && p.lives > 0 && p.outAt < 0) {
      p.lives = 0;
      p.outAt = this.playT;
      p.fall = 0;
      this.events.push({ t: 'out', id: odId });
    }
    p.lives = 0;
    if (this.activeIds().length < 2 && this.initialCount > 1) {
      if (this.phase === 'playing') this.checkRoundEnd();
      return this.finishMatch();
    }
    if (this.phase === 'playing') this.checkRoundEnd();
    if (!this.started && this.activeIds().every((id) => this.ready.has(id)) && this.activeIds().length) this.startGame();
  }

  cleanup() {
    this.finished = true;
    clearInterval(this.loop);
    clearTimeout(this.readyTimer);
    this.loop = null;
    this.readyTimer = null;
  }

  // ------------------------------------------------------------------ lifecycle

  activeIds() {
    return this.order.filter((id) => !this.pl[id].left);
  }

  startGame() {
    if (this.started || this.finished) return;
    this.started = true;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.startRound();
    for (const id of this.activeIds()) this.sendInit(id);
    this.lastTick = this.now();
    this.loop = setInterval(() => this.tick(), CFG.BROADCAST_MS);
  }

  /** Real-time driver. Tests call advance() directly instead. */
  tick() {
    const t = this.now();
    const dt = Math.max(0, t - this.lastTick);
    this.lastTick = t;
    this.advance(dt);
    this.broadcastState();
  }

  /** Advance simulated time by dtMs using fixed steps. */
  advance(dtMs) {
    if (this.finished && this.phase !== 'over') return;
    this.acc += Math.min(dtMs, 250);
    while (this.acc >= CFG.STEP_MS - 1e-6 && this.phase !== 'over') {
      this.acc -= CFG.STEP_MS;
      this.step(CFG.STEP_MS);
    }
    if (this.acc < 0) this.acc = 0;
  }

  startRound() {
    this.round += 1;
    const ids = this.activeIds();
    this.roundStartCount = ids.length;
    const n = ids.length;
    const ring = n <= 1 ? 0 : Math.max(40, (n * (BALL_RADIUS * 2 + 4)) / (2 * Math.PI) + 8);
    const off = this.rng() * Math.PI * 2;
    ids.forEach((id, i) => {
      const p = this.pl[id];
      const a = off + (i / Math.max(1, n)) * Math.PI * 2;
      p.x = Math.cos(a) * ring;
      p.y = Math.sin(a) * ring;
      p.px = p.x; p.py = p.y;
      p.vx = p.vy = 0;
      p.lives = this.livesPerRound;
      p.stamina = 1; p.regenIn = 0; p.lockout = 0;
      p.inv = 0; p.fall = 0; p.boosting = false;
      p.ix = p.iy = 0; p.iboost = false; p.iage = 0;
      p.outAt = -1;
    });
    this.phase = 'countdown';
    this.phaseMs = 0;
    this.playT = 0;
    this.radius = PLATE_RADIUS;
    this.result = null;
    this.tv = { x: 0, y: 0 };
    this.pairCooldown.clear();
  }

  radiusAt(t) {
    const start = this.shrink ? CFG.SHRINK_START_S : CFG.SUDDEN_DEATH_S;
    const f = clamp((t - start) / CFG.SHRINK_DURATION_S, 0, 1);
    return PLATE_RADIUS * (1 - (1 - CFG.SHRINK_TO) * f);
  }

  // ------------------------------------------------------------------ simulation

  step(dtMs) {
    this.simMs += dtMs;
    if (this.phase === 'countdown') {
      this.phaseMs += dtMs;
      if (this.phaseMs >= CFG.COUNTDOWN_MS) {
        this.phase = 'playing';
        this.phaseMs = 0;
        this.events.push({ t: 'go' });
      }
    } else if (this.phase === 'playing') {
      this.simulate(dtMs / 1000);
    } else if (this.phase === 'roundover') {
      this.phaseMs += dtMs;
      if (this.phaseMs >= CFG.ROUND_OVER_MS) {
        if (this.round >= this.rounds) this.finishMatch();
        else this.startRound();
      }
    }
  }

  simulate(dt) {
    this.playT += dt;
    this.radius = this.radiusAt(this.playT);
    const ids = this.activeIds();
    const live = []; // on the plate and in play

    for (const id of ids) {
      const p = this.pl[id];
      p.px = p.x; p.py = p.y;
      if (p.iage * 1000 > CFG.INPUT_TTL_MS) { p.ix = 0; p.iy = 0; p.iboost = false; }
      p.iage += dt;
      if (p.fall > 0) continue;
      if (p.lives > 0) live.push(p);
    }

    // Plate tilts toward the centre of mass of the balls that are still on it.
    let tx = 0, ty = 0;
    if (live.length >= 2) {
      let cx = 0, cy = 0;
      for (const p of live) { cx += p.x; cy += p.y; }
      cx /= live.length; cy /= live.length;
      tx = clamp(cx / this.radius, -1, 1);
      ty = clamp(cy / this.radius, -1, 1);
    }
    const k = 1 - Math.exp(-CFG.TILT_EASE * dt);
    this.tv.x += (tx - this.tv.x) * k;
    this.tv.y += (ty - this.tv.y) * k;

    const damp = Math.exp(-CFG.FRICTION * dt);
    for (const id of ids) {
      const p = this.pl[id];
      if (p.inv > 0) p.inv = Math.max(0, p.inv - dt);
      if (p.fall > 0) {
        // falling: keeps drifting outward, no control
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.fall -= dt;
        p.boosting = false;
        if (p.fall <= 0) {
          p.fall = 0;
          if (p.lives > 0) this.respawn(p);
        }
        continue;
      }
      if (p.lives <= 0) { p.boosting = false; continue; }

      const len = Math.hypot(p.ix, p.iy);
      const wantsBoost = p.iboost && len > 0.1 && p.stamina > 0 && p.lockout <= 0;
      p.boosting = wantsBoost;
      if (wantsBoost) {
        p.stamina -= CFG.STAMINA_DRAIN * dt;
        p.regenIn = CFG.REGEN_DELAY;
        if (p.stamina <= 0) { p.stamina = 0; p.lockout = CFG.DEPLETED_COOLDOWN; p.boosting = false; }
      } else {
        if (p.lockout > 0) p.lockout = Math.max(0, p.lockout - dt);
        if (p.regenIn > 0) p.regenIn -= dt;
        else p.stamina = Math.min(1, p.stamina + CFG.STAMINA_REGEN * dt);
      }

      const a = CFG.ACCEL * (p.boosting ? CFG.BOOST_ACCEL : 1);
      p.vx += (p.ix * a + this.tv.x * CFG.TILT_ACCEL) * dt;
      p.vy += (p.iy * a + this.tv.y * CFG.TILT_ACCEL) * dt;
      p.vx *= damp; p.vy *= damp;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > CFG.MAX_SPEED) { p.vx *= CFG.MAX_SPEED / sp; p.vy *= CFG.MAX_SPEED / sp; }
      p.x += p.vx * dt; p.y += p.vy * dt;
    }

    this.collide(live.filter((p) => p.fall <= 0 && p.lives > 0));
    this.edges(live.filter((p) => p.fall <= 0 && p.lives > 0), dt);
    this.checkRoundEnd();
  }

  collide(list) {
    const rr = BALL_RADIUS * 2;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= rr) continue;
        if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }
        const nx = dx / d, ny = dy / d;
        const ma = a.boosting ? CFG.BOOST_MASS : 1;
        const mb = b.boosting ? CFG.BOOST_MASS : 1;
        const overlap = rr - d;
        a.x -= nx * overlap * (mb / (ma + mb));
        a.y -= ny * overlap * (mb / (ma + mb));
        b.x += nx * overlap * (ma / (ma + mb));
        b.y += ny * overlap * (ma / (ma + mb));

        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn >= 0) continue; // separating
        const j2 = (-(1 + CFG.RESTITUTION) * vn) / (1 / ma + 1 / mb);
        a.vx -= (j2 / ma) * nx; a.vy -= (j2 / ma) * ny;
        b.vx += (j2 / mb) * nx; b.vy += (j2 / mb) * ny;

        const power = -vn;
        if (power >= CFG.BUMP_MIN) {
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          const last = this.pairCooldown.get(key);
          if (last === undefined || this.playT - last > 0.12) {
            this.pairCooldown.set(key, this.playT);
            if (this.events.length < 40) {
              this.events.push({
                t: 'bump', x: r2((a.x + b.x) / 2), y: r2((a.y + b.y) / 2),
                power: r2(Math.min(2, power / CFG.BUMP_SCALE))
              });
            }
          }
        }
      }
    }
  }

  edges(list, dt) {
    for (const p of list) {
      const d = Math.hypot(p.x, p.y);
      if (d <= this.radius) continue;
      if (p.inv > 0) {
        // invulnerable: held on the plate
        const nx = p.x / d, ny = p.y / d;
        p.x = nx * this.radius; p.y = ny * this.radius;
        const vn = p.vx * nx + p.vy * ny;
        if (vn > 0) { p.vx -= 1.5 * vn * nx; p.vy -= 1.5 * vn * ny; }
        continue;
      }
      const d0 = Math.hypot(p.px, p.py);
      const frac = d0 < this.radius && d > d0 ? clamp((this.radius - d0) / (d - d0), 0, 1) : 0;
      const fellAt = this.playT - dt + frac * dt;
      p.lives -= 1;
      p.fall = CFG.FALL_S;
      p.boosting = false;
      this.events.push({ t: 'fall', id: p.id, x: r2(p.x), y: r2(p.y) });
      if (p.lives <= 0) {
        p.outAt = fellAt;
        this.events.push({ t: 'out', id: p.id });
      }
    }
  }

  respawn(p) {
    // Best of a few candidate spots near the centre: the one farthest from other balls.
    const others = this.activeIds().map((id) => this.pl[id]).filter((o) => o !== p && o.lives > 0 && o.fall <= 0);
    const reach = Math.max(10, Math.min(70, this.radius * 0.35));
    const base = this.rng() * Math.PI * 2;
    let best = { x: 0, y: 0, score: -1 };
    for (let i = 0; i < 10; i++) {
      const ring = i === 0 ? 0 : reach * (0.4 + 0.6 * ((i % 3) / 2));
      const a = base + i * 2.399963;
      const x = Math.cos(a) * ring, y = Math.sin(a) * ring;
      let score = 1e9;
      for (const o of others) score = Math.min(score, Math.hypot(o.x - x, o.y - y));
      if (score > best.score) best = { x, y, score };
    }
    this.respawnCount += 1;
    p.x = best.x; p.y = best.y; p.px = p.x; p.py = p.y;
    p.vx = p.vy = 0;
    p.inv = CFG.INVULN_S;
    p.stamina = 1; p.regenIn = 0; p.lockout = 0;
    this.events.push({ t: 'respawn', id: p.id, x: r2(p.x), y: r2(p.y) });
  }

  checkRoundEnd() {
    if (this.phase !== 'playing') return;
    const ids = this.activeIds();
    const alive = ids.filter((id) => this.pl[id].lives > 0);
    const over = this.roundStartCount > 1 ? alive.length <= 1 : alive.length === 0;
    if (!over) return;

    let winners = [];
    if (alive.length === 1) winners = [alive[0]];
    else {
      // Everybody left fell in the same tick: the one who crossed the edge last wins; exact ties share.
      let latest = -Infinity;
      for (const id of ids) latest = Math.max(latest, this.pl[id].outAt);
      winners = ids.filter((id) => this.pl[id].outAt >= latest - 1e-6 && this.pl[id].outAt >= 0);
      if (this.roundStartCount <= 1) winners = [];
    }

    for (const id of ids) {
      const p = this.pl[id];
      p.totalLives += p.lives;
      p.survived += p.lives > 0 ? this.playT : Math.max(0, p.outAt);
    }
    for (const id of winners) this.pl[id].wins += 1;

    this.result = { winners, draw: winners.length > 1, round: this.round };
    this.phase = 'roundover';
    this.phaseMs = 0;
    for (const id of ids) { const p = this.pl[id]; p.ix = p.iy = 0; p.iboost = false; p.boosting = false; }
  }

  finishMatch() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    clearInterval(this.loop);
    clearTimeout(this.readyTimer);
    this.loop = null;
    this.readyTimer = null;

    const ids = this.activeIds();
    const sorted = [...ids].sort((a, b) => this.cmp(this.pl[b], this.pl[a]));
    const rows = [];
    sorted.forEach((id, i) => {
      const p = this.pl[id];
      const prev = i > 0 ? this.pl[sorted[i - 1]] : null;
      const rank = prev && this.cmp(prev, p) === 0 ? rows[i - 1].rank : i + 1;
      rows.push({
        id, name: p.name, score: p.wins, rank,
        note: `${p.wins} round win${p.wins === 1 ? '' : 's'}`
      });
    });
    const tiedTop = rows.length > 1 && rows[1].rank === 1;
    this.broadcastState();
    this.finished = true;
    this.room.finishGame({
      title: !rows.length ? 'Match over' : tiedTop ? 'Draw' : `${rows[0].name} wins`,
      subtitle: `${this.rounds} round${this.rounds === 1 ? '' : 's'}, ${this.livesPerRound} li${this.livesPerRound === 1 ? 'fe' : 'ves'} each`,
      rows,
      delayMs: CFG.RESULTS_DELAY_MS
    });
  }

  cmp(a, b) {
    return (a.wins - b.wins) || (a.totalLives - b.totalLives) || (Math.round(a.survived * 100) - Math.round(b.survived * 100));
  }

  // ------------------------------------------------------------------ output

  snapshot(withEvents = true) {
    const players = {};
    const wins = {};
    for (const id of this.activeIds()) {
      const p = this.pl[id];
      players[id] = {
        x: r2(p.x), y: r2(p.y), vx: r2(p.vx), vy: r2(p.vy),
        lives: p.lives, stamina: r2(p.stamina), alive: p.lives > 0,
        inv: r2(p.inv), fl: p.fall > 0 ? 1 : 0, b: p.boosting ? 1 : 0
      };
      wins[id] = p.wins;
    }
    const msg = {
      type: 'hb-state',
      phase: this.phase,
      round: this.round,
      rounds: this.rounds,
      cd: this.phase === 'countdown' ? Math.max(0, Math.round(CFG.COUNTDOWN_MS - this.phaseMs)) : 0,
      ts: Math.round(this.simMs),
      t: Math.round(this.playT * 1000),
      radius: r2(this.radius),
      plateTilt: { x: r2(this.tv.y * CFG.TILT_MAX), z: r2(-this.tv.x * CFG.TILT_MAX) },
      players,
      wins,
      events: withEvents ? this.events : []
    };
    if (this.result) msg.result = this.result;
    return msg;
  }

  broadcastState() {
    const msg = this.snapshot(true);
    this.events = [];
    this.room.broadcast(msg);
  }

  sendInit(odId, spectator = false) {
    const ws = this.room.getWsByUserId(odId);
    if (!ws) return;
    const players = {};
    for (const id of this.order) {
      const p = this.pl[id];
      players[id] = { name: p.name, ci: p.ci, left: p.left };
    }
    this.room.send(ws, {
      type: 'hb-init',
      id: spectator || !this.pl[odId] ? null : odId,
      spectator: spectator || !this.pl[odId],
      options: { rounds: this.rounds, lives: this.livesPerRound, shrink: this.shrink },
      plateRadius: PLATE_RADIUS,
      ballRadius: BALL_RADIUS,
      players
    });
    this.room.send(ws, this.snapshot(false));
  }
}
