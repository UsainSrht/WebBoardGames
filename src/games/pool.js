/**
 * 8 Ball Pool (exactly 2 players). Server authoritative: the client sends a shot (angle, power, spin and, with
 * ball in hand, the cue ball position); the server validates it, simulates it to rest with the shared physics
 * module, judges it and broadcasts the shot so every client can replay the same simulation. The result (turn,
 * groups, fouls) is only published when the replay is over.
 *
 * Options (see config.js):
 *   shotClock   seconds per shot (0 = off). Running out of time is a foul: the opponent gets ball in hand.
 *               Three timeouts in a row lose the game.
 *   callPocket  'on': the 8 ball must be called (pocket chosen with the shot) and pocketed there.
 *
 * Rules (standard American 8 ball, with these choices):
 *  - 15 object balls racked in a triangle (8 in the centre, one solid and one stripe in the back corners);
 *    the break is from behind the head string. A legal break pockets a ball or drives at least four object
 *    balls to a rail. Otherwise the opponent chooses: accept the table as it lies and shoot, or have the balls
 *    re-racked and break themselves. A scratch on the break is a plain foul (ball in hand anywhere, no re-rack).
 *  - The 8 ball pocketed on the break is re-spotted (never a win or a loss). The table is open after the break.
 *  - While the table is open any ball but the 8 may be hit first. The group (solids 1-7 or stripes 9-15) is
 *    given by the first ball legally pocketed on a shot; the opponent takes the other group.
 *  - A shot is legal when the cue ball first hits a ball of the shooter's group (the 8 once the group is
 *    cleared) and a ball is pocketed or any ball reaches a rail after that contact.
 *  - Fouls: scratch, no contact, wrong first contact, no rail, a ball off the table, shot clock timeout. The
 *    opponent gets ball in hand anywhere on the table. Balls pocketed on a foul stay down (the 8 excepted: see
 *    below); balls off the table are re-spotted on the foot spot line.
 *  - Pocketing a ball of your group continues your turn.
 *  - The 8 ball: legally pocketing it after clearing your group wins. Pocketing it earlier, on a foul (also a
 *    scratch), in the same shot as your last group ball, or outside the called pocket (callPocket on) loses.
 *  - A player who leaves forfeits.
 */
import {
  W, HEAD_X, TICK_MS, POCKETS, rack, sanitizeShot, simulateShot, validCue, nearestCue, freeSpot
} from '../../public_html/shared/pool-physics.js';

const START_FALLBACK_MS = 6000;
const SETTLE_PAD_MS = 650;
const RESULT_MS = 20000;
const AIM_MIN_GAP_MS = 60;
const MAX_TIMEOUTS = 3;
const CLOCKS = [0, 30, 45, 60];

const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
const STRIPES = [9, 10, 11, 12, 13, 14, 15];
const GROUPS = { solid: SOLIDS, stripe: STRIPES };

export const groupOf = (id) => (id >= 1 && id <= 7 ? 'solid' : id >= 9 && id <= 15 ? 'stripe' : null);

/**
 * Judge a finished shot. Pure: no I/O.
 * ctx: { breakShot, group (shooter's group or null), down (object balls pocketed earlier), events,
 *        call (called pocket or null), callPocket (rule on/off) }
 * Returns { outcome: 'continue' | 'pass' | 'rerack' | 'win' | 'lose', reason, fouls: [keys], foul, potted,
 *           cueDown, off, assign (group of the shooter if newly assigned), respot8, firstContact }
 * 'win' and 'lose' are from the shooter's point of view.
 */
export function judgeShot({ breakShot, group, down = [], events, call = null, callPocket = false }) {
  const downSet = new Set(down);
  const potted = [];
  const off = [];
  const railBalls = new Set();
  let firstContact = null;
  let railAfterContact = false;
  let cueDown = false;
  let pocketOf8 = -1;

  for (const e of events) {
    if (e.type === 'hit') {
      if (firstContact === null && (e.a === 0 || e.b === 0)) firstContact = e.a === 0 ? e.b : e.a;
    } else if (e.type === 'rail') {
      if (firstContact !== null) railAfterContact = true;
      if (e.ball !== 0) railBalls.add(e.ball);
    } else if (e.type === 'pocket') {
      if (e.ball === 0) cueDown = true;
      else { potted.push(e.ball); if (e.ball === 8) pocketOf8 = e.pocket; }
    } else if (e.type === 'off') {
      off.push(e.ball);
      if (e.ball === 0) cueDown = true;
    }
  }

  const remaining = group ? GROUPS[group].filter((b) => !downSet.has(b)) : null;
  const fouls = [];
  if (firstContact === null) fouls.push('noContact');
  else if (!breakShot) {
    const ok = group ? (remaining.length ? groupOf(firstContact) === group : firstContact === 8) : firstContact !== 8;
    if (!ok) fouls.push('wrongFirst');
  }
  if (cueDown) fouls.push('scratch');
  if (off.length) fouls.push('offTable');
  if (!breakShot && firstContact !== null && potted.length === 0 && !railAfterContact && !fouls.length) fouls.push('noRail');

  const base = { fouls, foul: fouls.length > 0, potted, cueDown, off, assign: null, respot8: false, firstContact, reason: null };

  if (breakShot) {
    const respot8 = potted.includes(8);
    const legalBreak = potted.length > 0 || railBalls.size >= 4;
    const out = { ...base, respot8 };
    if (fouls.length) return { ...out, outcome: 'pass' };
    if (!legalBreak) return { ...out, outcome: 'rerack' };
    return { ...out, outcome: potted.some((b) => b !== 8) ? 'continue' : 'pass' };
  }

  if (potted.includes(8)) {
    let lose = null;
    if (fouls.length) lose = cueDown ? 'eightScratch' : 'eightFoul';
    else if (!group || remaining.length > 0) lose = 'eightEarly';
    else if (callPocket && call !== pocketOf8) lose = 'eightPocket';
    return lose ? { ...base, outcome: 'lose', reason: lose } : { ...base, outcome: 'win', reason: 'eightWin' };
  }

  if (fouls.length) return { ...base, outcome: 'pass' };

  let assign = null;
  if (!group && potted.length) assign = groupOf(potted[0]);
  const mine = group || assign;
  const keep = !!mine && potted.some((b) => groupOf(b) === mine);
  return { ...base, assign, outcome: keep ? 'continue' : 'pass' };
}

const cloneBalls = (p) => p.map((b) => (b ? [b[0], b[1]] : null));
const r2 = (v) => Math.round(v * 100) / 100;

export class Pool {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.now = extra.now || (() => Date.now());
    this.rng = extra.rng || Math.random;

    const clock = Number(options.shotClock);
    this.shotClock = CLOCKS.includes(clock) ? clock : 45;
    this.callPocket = options.callPocket === 'on';

    this.order = Object.keys(players);
    this.names = {};
    this.groups = {};
    this.timeouts = {};
    for (const id of this.order) { this.names[id] = players[id].name; this.groups[id] = null; this.timeouts[id] = 0; }

    this.positions = rack(this.rng);
    this.down = [];
    this.turn = this.order[this.rng() < 0.5 ? 0 : 1] || this.order[0];
    this.inHand = true;
    this.breakShot = true;
    this.phase = 'aim'; // aim | rolling | rerack | over
    this.chooser = null;
    this.seq = 0;
    this.shotInfo = null;
    this.pending = null;
    this.last = null;
    this.aim = null;
    this.winner = null;
    this.reason = null;
    this.deadline = 0;
    this.started = false;
    this.loaded = new Set();
    this.lastAimAt = {};
    this.clockTimer = null;
    this.settleTimer = null;
    this.startTimer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  other(id) { return this.order.find((x) => x !== id); }

  fail(odId, k, p) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'error', message: { k, ...(p ? { p } : {}) } });
  }

  // ---------------------------------------------------------------- lifecycle

  begin() {
    if (this.started || !this.isGameActive) return;
    this.started = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startClock();
    this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.startTimer);
    clearTimeout(this.clockTimer);
    clearTimeout(this.settleTimer);
    this.startTimer = this.clockTimer = this.settleTimer = null;
  }

  startClock() {
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.deadline = 0;
    if (!this.shotClock || (this.phase !== 'aim' && this.phase !== 'rerack')) return;
    const ms = this.shotClock * 1000;
    this.deadline = this.now() + ms;
    this.clockTimer = setTimeout(() => this.onClock(), ms);
  }

  onClock() {
    this.clockTimer = null;
    if (!this.isGameActive) return;
    if (this.phase === 'aim') this.timeoutTurn();
    else if (this.phase === 'rerack') this.resolveRerack(this.chooser, true);
  }

  // ----------------------------------------------------------------- messages

  handleMessage(odId, type, payload = {}) {
    if (!this.isGameActive || !this.players[odId]) return;
    if (!payload || typeof payload !== 'object') payload = {};
    switch (type) {
      case 'pool-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.started && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'pool-aim': return this.relayAim(odId, payload);
      case 'pool-shot': return this.shoot(odId, payload);
      case 'pool-rerack': return this.resolveRerack(odId, payload.accept !== false);
    }
  }

  relayAim(odId, p) {
    if (!this.started || this.phase !== 'aim' || this.turn !== odId) return;
    const now = this.now();
    if (now - (this.lastAimAt[odId] || 0) < AIM_MIN_GAP_MS) return;
    if (!Number.isFinite(p.angle) || !Number.isFinite(p.power)) return;
    const spin = p.spin && Number.isFinite(p.spin.x) && Number.isFinite(p.spin.y) ? { x: Math.max(-1, Math.min(1, p.spin.x)), y: Math.max(-1, Math.min(1, p.spin.y)) } : { x: 0, y: 0 };
    const aim = {
      by: odId,
      angle: Math.round(p.angle * 1000) / 1000,
      power: Math.max(0, Math.min(1, Math.round(p.power * 100) / 100)),
      spin: { x: Math.round(spin.x * 100) / 100, y: Math.round(spin.y * 100) / 100 }
    };
    if (this.inHand && p.cue && Number.isFinite(p.cue.x) && Number.isFinite(p.cue.y)) {
      const c = nearestCue(this.positions, p.cue.x, p.cue.y, this.breakShot);
      if (c) aim.cue = { x: r2(c.x), y: r2(c.y) };
    }
    if (Number.isInteger(p.call) && p.call >= 0 && p.call < POCKETS.length) aim.call = p.call;
    this.lastAimAt[odId] = now;
    this.aim = aim;
    const msg = { type: 'pool-aim', ...aim };
    this.sendTo(this.other(odId), msg);
    for (const id of this.room.spectatorIds()) this.sendTo(id, msg);
  }

  /** Does the shooter need to name a pocket? (callPocket on and only the 8 left in their group) */
  mustCall(id) {
    const g = this.groups[id];
    return this.callPocket && !!g && GROUPS[g].every((b) => this.down.includes(b));
  }

  shoot(odId, p) {
    if (!this.started || this.phase !== 'aim') return this.fail(odId, 'pool.err.busy');
    if (this.turn !== odId) return this.fail(odId, 'pool.err.notYourTurn');
    const shot = sanitizeShot(p);
    if (!shot) return this.fail(odId, 'pool.err.badShot');

    const from = cloneBalls(this.positions);
    if (this.inHand) {
      const c = p.cue && typeof p.cue === 'object' ? p.cue : (from[0] ? { x: from[0][0], y: from[0][1] } : null);
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return this.fail(odId, 'pool.err.badPlacement');
      const x = r2(c.x);
      const y = r2(c.y);
      if (!validCue(from, x, y, this.breakShot)) return this.fail(odId, 'pool.err.badPlacement');
      from[0] = [x, y];
    } else if (!from[0]) {
      return this.fail(odId, 'pool.err.badPlacement');
    }

    let call = null;
    if (this.mustCall(odId)) {
      call = p.call;
      if (!Number.isInteger(call) || call < 0 || call >= POCKETS.length) return this.fail(odId, 'pool.err.callRequired');
    }

    const sim = simulateShot(from, shot);
    const group = this.groups[odId];
    const verdict = judgeShot({ breakShot: this.breakShot, group, down: this.down, events: sim.events, call, callPocket: this.callPocket });

    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.deadline = 0;
    this.timeouts[odId] = 0;
    this.phase = 'rolling';
    this.seq++;
    this.aim = null;
    this.pending = { by: odId, verdict, final: sim.positions, call };
    this.shotInfo = { seq: this.seq, by: odId, shot: sim.shot, from, final: sim.positions, ticks: sim.ticks, startedAt: this.now(), call };

    this.room.broadcast({ type: 'pool-shot', ...this.shotPayload() });
    this.settleTimer = setTimeout(() => this.settle(), Math.ceil(sim.ticks * TICK_MS) + SETTLE_PAD_MS);
  }

  shotPayload() {
    const s = this.shotInfo;
    return { seq: s.seq, by: s.by, shot: s.shot, from: s.from, final: s.final, ticks: s.ticks, call: s.call, elapsed: this.now() - s.startedAt };
  }

  /** The replay is over: publish the outcome of the shot. */
  settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (!this.isGameActive || this.phase !== 'rolling' || !this.pending) return;
    const { by, verdict } = this.pending;
    const opp = this.other(by);
    const positions = cloneBalls(this.pending.final);
    this.pending = null;
    this.shotInfo = null;

    for (const b of verdict.potted) if (b !== 8 || !verdict.respot8) { if (!this.down.includes(b)) this.down.push(b); }
    const notes = [];
    const p = { name: this.names[by], other: this.names[opp] };

    // balls to bring back on the table
    if (verdict.respot8 && verdict.outcome !== 'win' && verdict.outcome !== 'lose') {
      positions[8] = freeSpot(positions, 8);
      notes.push({ k: 'pool.note.respot8' });
    }
    for (const b of verdict.off) {
      if (b === 0) continue;
      positions[b] = freeSpot(positions, b);
    }

    this.positions = positions;
    this.last = { by, notes, foul: verdict.foul };

    if (verdict.outcome === 'win' || verdict.outcome === 'lose') {
      const winner = verdict.outcome === 'win' ? by : opp;
      this.finishWith(winner, verdict.reason);
      return;
    }

    if (verdict.foul) notes.unshift({ k: `pool.note.${verdict.fouls[0]}`, p });

    if (verdict.assign) {
      this.groups[by] = verdict.assign;
      this.groups[opp] = verdict.assign === 'solid' ? 'stripe' : 'solid';
      notes.push({ k: 'pool.note.assigned', p: { ...p, group: { k: `pool.group.${verdict.assign}` }, otherGroup: { k: `pool.group.${this.groups[opp]}` } } });
    }

    if (verdict.outcome === 'rerack') {
      this.turn = opp;
      this.phase = 'rerack';
      this.chooser = opp;
      this.inHand = false;
      this.breakShot = false;
      notes.push({ k: 'pool.note.illegalBreak', p: { name: this.names[opp], other: this.names[by] } });
      this.last.notes = notes;
      this.startClock();
      this.broadcastState();
      return;
    }

    this.breakShot = false;
    if (verdict.outcome === 'pass') {
      this.turn = opp;
      this.inHand = verdict.foul;
    } else {
      this.inHand = false;
    }
    if (this.inHand) this.placeholderCue();
    this.last.notes = notes;
    this.phase = 'aim';
    this.startClock();
    this.broadcastState();
  }

  /** With ball in hand the cue ball always has a legal resting position the client can start dragging from. */
  placeholderCue() {
    const c = this.positions[0];
    if (c && validCue(this.positions, c[0], c[1], this.breakShot)) return;
    const n = nearestCue(this.positions, HEAD_X, W / 2, this.breakShot) || nearestCue(this.positions, 2 * HEAD_X, W / 2, false);
    this.positions[0] = n ? [r2(n.x), r2(n.y)] : [HEAD_X, W / 2];
  }

  resolveRerack(odId, accept) {
    if (this.phase !== 'rerack' || odId !== this.chooser) return;
    const breaker = this.other(odId);
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.chooser = null;
    this.timeouts[odId] = 0;
    if (accept) {
      this.phase = 'aim';
      this.inHand = false;
      this.breakShot = false;
      this.last = { by: odId, foul: false, notes: [{ k: 'pool.note.accepted', p: { name: this.names[odId], other: this.names[breaker] } }] };
    } else {
      this.positions = rack(this.rng);
      this.down = [];
      this.phase = 'aim';
      this.inHand = true;
      this.breakShot = true;
      this.last = { by: odId, foul: false, notes: [{ k: 'pool.note.rerack', p: { name: this.names[odId], other: this.names[breaker] } }] };
    }
    this.aim = null;
    this.startClock();
    this.broadcastState();
  }

  /** The shot clock ran out: foul, the opponent gets ball in hand (or the break). */
  timeoutTurn() {
    const id = this.turn;
    const opp = this.other(id);
    this.timeouts[id] = (this.timeouts[id] || 0) + 1;
    if (this.timeouts[id] >= MAX_TIMEOUTS) return this.finishWith(opp, 'timeouts');
    this.turn = opp;
    this.aim = null;
    this.inHand = true;
    this.placeholderCue();
    this.last = { by: id, foul: true, notes: [{ k: 'pool.note.timeout', p: { name: this.names[id], other: this.names[opp] } }] };
    this.startClock();
    this.broadcastState();
  }

  ownDown(id) {
    const g = this.groups[id];
    return g ? GROUPS[g].filter((b) => this.down.includes(b)).length : 0;
  }

  finishWith(winner, reason) {
    if (this.phase === 'over') return;
    const loser = this.other(winner);
    this.phase = 'over';
    this.winner = winner;
    this.pending = null;
    this.shotInfo = null;
    clearTimeout(this.clockTimer);
    clearTimeout(this.settleTimer);
    this.clockTimer = this.settleTimer = null;
    this.deadline = 0;
    this.reason = reason;
    const p = { name: this.names[winner], other: this.names[loser] };
    this.broadcastState();
    this.room.finishGame({
      title: { k: 'pool.result.title', p },
      subtitle: { k: `pool.result.${reason}`, p },
      rows: [
        { id: winner, name: this.names[winner], score: this.ownDown(winner), rank: 1, note: { k: 'pool.result.winner' } },
        { id: loser, name: this.names[loser], score: this.ownDown(loser), rank: 2 }
      ],
      delayMs: RESULT_MS
    });
  }

  onPlayerLeft(odId) {
    if (!this.players[odId] || this.phase === 'over' || !this.isGameActive) return;
    const opp = this.other(odId);
    if (!opp) return;
    this.finishWith(opp, 'forfeit');
  }

  // ------------------------------------------------------------------ views

  view() {
    const t = this.now();
    return {
      seq: this.seq,
      phase: this.phase,
      started: this.started,
      turn: this.turn,
      inHand: this.inHand,
      breakShot: this.breakShot,
      players: this.order.map((id) => ({ id, name: this.names[id], group: this.groups[id], count: this.ownDown(id) })),
      balls: this.positions,
      down: this.down,
      shotClock: this.shotClock,
      callPocket: this.callPocket,
      mustCall: this.phase === 'aim' && this.mustCall(this.turn),
      timeLeft: this.deadline ? Math.max(0, this.deadline - t) : null,
      chooser: this.chooser,
      winner: this.winner,
      reason: this.reason || null,
      shot: this.phase === 'rolling' && this.shotInfo ? this.shotPayload() : null,
      aim: this.phase === 'aim' ? this.aim : null,
      last: this.last
    };
  }

  sendTo(id, msg) {
    const ws = this.room.getWsByUserId(id);
    if (ws) this.room.send(ws, msg);
  }

  sendState(id) { this.sendTo(id, { type: 'pool-state', ...this.view() }); }

  broadcastState() { this.room.broadcast({ type: 'pool-state', ...this.view() }); }

  spectatorSync(odId) { this.sendState(odId); }
}
