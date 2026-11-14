/**
 * Deterministic 8 ball pool physics, shared by the server (authoritative) and the browsers (playback).
 *
 * Pure and dependency free. Only + - * / and sqrt are used inside the simulation (no sin/cos/pow), so every
 * JavaScript engine produces bit identical results for the same input.
 *
 * Units: millimetres and seconds. The playing surface is L x W (2:1), x runs along the long side, the head
 * (break) end is x = 0. Ball centres live in [R, L-R] x [R, W-R]. Ball ids: 0 = cue ball, 1-7 solids,
 * 8 = the eight ball, 9-15 stripes.
 *
 * Positions are exchanged as an array of 16 entries: [x, y] for a ball on the table, null for a pocketed ball.
 */

export const L = 2540;
export const W = 1270;
export const R = 28.575;
export const HEAD_X = L / 4;
export const FOOT_X = (L * 3) / 4;
export const TICK_RATE = 120;
export const TICK = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_TICKS = TICK_RATE * 90;

export const G = 9810;
export const SLIDE_MU = 0.2;          // cloth sliding friction
export const ROLL_DECEL = 300;        // mm/s^2, rolling resistance
export const SPIN_DECAY = 50;         // rad/s^2, side spin decay
export const RAIL_E = 0.75;           // rail restitution
export const RAIL_MU = 0.2;           // rail friction (side spin)
export const BALL_E = 0.96;           // ball to ball restitution
export const V_MAX = 7000;            // cue ball speed at full power, mm/s
export const SPIN_RANGE = 0.6;        // strike offset at full spin, in ball radii
const SLIP_EPS = 1;                   // mm/s
const STOP_EPS = 2;                   // mm/s

/** Pocket centres and capture radii. Corner pockets are more forgiving than side pockets. */
const CORNER_R = 80;
const SIDE_R = 66;
export const POCKETS = [
  { x: 0, y: 0, r: CORNER_R, corner: true },
  { x: L / 2, y: -10, r: SIDE_R, corner: false },
  { x: L, y: 0, r: CORNER_R, corner: true },
  { x: 0, y: W, r: CORNER_R, corner: true },
  { x: L / 2, y: W + 10, r: SIDE_R, corner: false },
  { x: L, y: W, r: CORNER_R, corner: true }
];

const I_FACTOR = 0.2 * R * R; // half of the moment of inertia (m = 1)

/* ------------------------------------------------------------ helpers */

/** Deterministic sine and cosine (Taylor series): identical on every engine, unlike Math.sin. */
export function sincos(a) {
  const TWO = 2 * Math.PI;
  a -= TWO * Math.round(a / TWO);
  const a2 = a * a;
  let s = a;
  let c = 1;
  let ts = a;
  let tc = 1;
  for (let i = 1; i < 16; i++) {
    tc *= -a2 / ((2 * i - 1) * (2 * i));
    ts *= -a2 / ((2 * i) * (2 * i + 1));
    c += tc;
    s += ts;
  }
  return { s, c };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, k) => Math.round(v * k) / k;

/** Validate and quantise a raw shot from the network. Returns null when it is unusable. */
export function sanitizeShot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { angle, power } = raw;
  if (!num(angle) || !num(power) || power <= 0) return null;
  let sx = 0;
  let sy = 0;
  if (raw.spin !== undefined && raw.spin !== null) {
    if (typeof raw.spin !== 'object' || !num(raw.spin.x) || !num(raw.spin.y)) return null;
    sx = raw.spin.x;
    sy = raw.spin.y;
  }
  const len = Math.sqrt(sx * sx + sy * sy);
  if (len > 1) { sx /= len; sy /= len; }
  const TWO = 2 * Math.PI;
  const a = angle - TWO * Math.floor(angle / TWO);
  return {
    angle: round(a, 10000) % TWO,
    power: round(clamp(power, 0.01, 1), 1000),
    spin: { x: round(sx, 100) + 0, y: round(sy, 100) + 0 }
  };
}

/** Cue ball launch velocity and angular velocity for a sanitised shot. */
export function strike(shot) {
  const { s, c } = sincos(shot.angle);
  const p = shot.power;
  // power curve: fine control at the soft end
  const v0 = 120 + (V_MAX - 120) * p * Math.sqrt(p);
  const h = shot.spin.y * SPIN_RANGE * R;    // vertical offset (top positive)
  const side = shot.spin.x * SPIN_RANGE * R; // horizontal offset (right positive)
  const wPerp = (2.5 * v0 * h) / (R * R);
  return {
    vx: v0 * c,
    vy: v0 * s,
    wx: -s * wPerp,
    wy: c * wPerp,
    wz: (-2.5 * v0 * side) / (R * R)
  };
}

/* --------------------------------------------------------------- rack */

/**
 * A fresh rack: positions of all 16 balls. The eight ball is in the centre, the two back corners are one
 * solid and one stripe, the rest is shuffled with the given rng.
 */
export function rack(rng = Math.random) {
  const slots = [];
  const dx = Math.sqrt(3) * R + 0.004;
  const dy = 2 * R + 0.004;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) slots.push([FOOT_X + row * dx, W / 2 + (j - row / 2) * dy]);
  }
  // slot indices: row r starts at r(r+1)/2. Back corners: 10 and 14. Centre of the third row: 4.
  const solids = [1, 2, 3, 4, 5, 6, 7];
  const stripes = [9, 10, 11, 12, 13, 14, 15];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  shuffle(solids);
  shuffle(stripes);
  const first = rng() < 0.5 ? [solids, stripes] : [stripes, solids];
  const placement = new Array(15);
  placement[10] = first[0].pop();
  placement[14] = first[1].pop();
  placement[4] = 8;
  const rest = shuffle([...solids, ...stripes]);
  for (let i = 0; i < 15; i++) if (placement[i] === undefined) placement[i] = rest.pop();
  const out = new Array(16).fill(null);
  out[0] = [HEAD_X, W / 2];
  for (let i = 0; i < 15; i++) out[placement[i]] = [slots[i][0], slots[i][1]];
  return out;
}

/* ----------------------------------------------------- simulation core */

/** Build a simulation from resting positions, optionally striking the cue ball with a sanitised shot. */
export function createSim(positions, shot = null) {
  const balls = [];
  for (let i = 0; i < 16; i++) {
    const p = positions[i];
    const on = Array.isArray(p) && num(p[0]) && num(p[1]);
    balls.push({ id: i, on, x: on ? p[0] : 0, y: on ? p[1] : 0, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 });
  }
  const sim = { balls, events: [], tick: 0, done: false, shot };
  if (shot && balls[0].on) Object.assign(balls[0], strike(shot));
  sim.done = !anyMoving(balls);
  return sim;
}

function anyMoving(balls) {
  for (const b of balls) {
    if (!b.on) continue;
    if (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0) return true;
  }
  return false;
}

/** Advance one tick (1/120 s). Pushes events onto sim.events. */
export function stepSim(sim) {
  if (sim.done) return;
  const { balls } = sim;
  let vmax = 0;
  for (const b of balls) {
    if (!b.on) continue;
    const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (v > vmax) vmax = v;
  }
  const n = clamp(Math.ceil((vmax * TICK) / (R * 0.3)), 1, 32);
  const h = TICK / n;
  for (let s = 0; s < n; s++) substep(sim, h);
  sim.tick++;
  if (!anyMoving(balls) || sim.tick >= MAX_TICKS) {
    if (sim.tick >= MAX_TICKS) for (const b of balls) { b.vx = b.vy = b.wx = b.wy = b.wz = 0; }
    settleOverlaps(balls);
    sim.done = true;
  }
}

function substep(sim, h) {
  const { balls } = sim;
  for (const b of balls) if (b.on) advance(b, h);
  // pockets (before the cushions, so a ball heading into the mouth is not bounced away)
  for (const b of balls) {
    if (!b.on) continue;
    if (!num(b.x) || !num(b.y) || b.x < -R * 4 || b.x > L + R * 4 || b.y < -R * 4 || b.y > W + R * 4) {
      b.on = false; b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      sim.events.push({ type: 'off', ball: b.id, t: sim.tick });
      continue;
    }
    for (let k = 0; k < 6; k++) {
      const p = POCKETS[k];
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      if (dx * dx + dy * dy < p.r * p.r) {
        b.on = false; b.vx = b.vy = b.wx = b.wy = b.wz = 0;
        sim.events.push({ type: 'pocket', ball: b.id, pocket: k, t: sim.tick });
        break;
      }
    }
  }
  for (const b of balls) if (b.on) cushions(sim, b);
  for (let pass = 0; pass < 2; pass++) collide(sim, balls);
  for (const b of balls) if (b.on) cushions(sim, b);
}

/** Friction and motion of one ball for h seconds. */
function advance(b, h) {
  let left = h;
  const ux = b.vx - R * b.wy;
  const uy = b.vy + R * b.wx;
  const us = Math.sqrt(ux * ux + uy * uy);
  if (us > SLIP_EPS) {
    const decel = SLIDE_MU * G;
    const tslide = us / (3.5 * decel);
    const t1 = tslide < left ? tslide : left;
    const ex = ux / us;
    const ey = uy / us;
    const vx0 = b.vx;
    const vy0 = b.vy;
    b.vx -= decel * ex * t1;
    b.vy -= decel * ey * t1;
    b.wx -= ((5 * decel * ey) / (2 * R)) * t1;
    b.wy += ((5 * decel * ex) / (2 * R)) * t1;
    b.x += ((vx0 + b.vx) / 2) * t1;
    b.y += ((vy0 + b.vy) / 2) * t1;
    left -= t1;
    if (tslide <= t1) { b.wy = b.vx / R; b.wx = -b.vy / R; }
    else { spinDecay(b, h); return; }
  }
  if (left > 0) {
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 0) {
      const dv = ROLL_DECEL * left;
      if (speed <= dv || speed < STOP_EPS) {
        const tt = speed / ROLL_DECEL < left ? speed / ROLL_DECEL : left;
        b.x += (b.vx / 2) * tt;
        b.y += (b.vy / 2) * tt;
        b.vx = b.vy = b.wx = b.wy = 0;
      } else {
        const k = (speed - dv) / speed;
        const nvx = b.vx * k;
        const nvy = b.vy * k;
        b.x += ((b.vx + nvx) / 2) * left;
        b.y += ((b.vy + nvy) / 2) * left;
        b.vx = nvx;
        b.vy = nvy;
        b.wy = nvx / R;
        b.wx = -nvy / R;
      }
    } else {
      b.wx = b.wy = 0;
    }
  }
  spinDecay(b, h);
  if (b.vx === 0 && b.vy === 0 && b.wx === 0 && b.wy === 0) b.wz = 0;
}

function spinDecay(b, h) {
  if (b.wz !== 0) {
    const d = SPIN_DECAY * h;
    b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - (b.wz > 0 ? d : -d);
  }
}

/** Cushion contact for the four sides of the table. */
function cushions(sim, b) {
  if (b.x < R) { b.x = R; rail(sim, b, 1, 0); }
  else if (b.x > L - R) { b.x = L - R; rail(sim, b, -1, 0); }
  if (b.y < R) { b.y = R; rail(sim, b, 0, 1); }
  else if (b.y > W - R) { b.y = W - R; rail(sim, b, 0, -1); }
}

/** Rail impact. (nx, ny) points from the rail into the table. */
function rail(sim, b, nx, ny) {
  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;
  const speed = -vn;
  const e = speed < 30 ? 0 : RAIL_E;
  b.vx -= (1 + e) * vn * nx;
  b.vy -= (1 + e) * vn * ny;
  // friction against the rail turns side spin into a change of direction
  const tx = -ny;
  const ty = nx;
  const vtc = b.vx * tx + b.vy * ty - R * b.wz;
  if (vtc !== 0) {
    const limit = RAIL_MU * (1 + e) * speed;
    const need = Math.abs(vtc) / 3.5;
    const J = (vtc > 0 ? -1 : 1) * (limit < need ? limit : need);
    b.vx += J * tx;
    b.vy += J * ty;
    b.wz -= (2.5 * J) / R;
  }
  if (speed > 8) sim.events.push({ type: 'rail', ball: b.id, v: round(speed, 10), t: sim.tick });
}

function collide(sim, balls) {
  const D = 2 * R;
  for (let i = 0; i < 16; i++) {
    const a = balls[i];
    if (!a.on) continue;
    for (let j = i + 1; j < 16; j++) {
      const c = balls[j];
      if (!c.on) continue;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= D * D) continue;
      const d = Math.sqrt(d2);
      let nx = 1;
      let ny = 0;
      if (d > 1e-9) { nx = dx / d; ny = dy / d; }
      const push = (D - d) / 2 + 1e-7;
      a.x -= nx * push; a.y -= ny * push;
      c.x += nx * push; c.y += ny * push;
      const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
      if (vn < 0) {
        const jn = (-(1 + BALL_E) * vn) / 2;
        a.vx -= jn * nx; a.vy -= jn * ny;
        c.vx += jn * nx; c.vy += jn * ny;
        if (-vn > 1) sim.events.push({ type: 'hit', a: i, b: j, v: round(-vn, 10), t: sim.tick });
      }
    }
  }
}

/** Remove the tiny overlaps left at rest. */
function settleOverlaps(balls) {
  const D = 2 * R;
  for (let it = 0; it < 8; it++) {
    let moved = false;
    for (let i = 0; i < 16; i++) {
      const a = balls[i];
      if (!a.on) continue;
      for (let j = i + 1; j < 16; j++) {
        const c = balls[j];
        if (!c.on) continue;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= D * D) continue;
        const d = Math.sqrt(d2);
        const push = (D - d) / 2 + 0.001;
        const nx = d < 1e-6 ? 1 : dx / d;
        const ny = d < 1e-6 ? 0 : dy / d;
        a.x -= nx * push; a.y -= ny * push;
        c.x += nx * push; c.y += ny * push;
        moved = true;
      }
    }
    for (const b of balls) {
      if (!b.on) continue;
      b.x = clamp(b.x, R, L - R);
      b.y = clamp(b.y, R, W - R);
    }
    if (!moved) break;
  }
}

/** Total kinetic energy (translation + rotation) per unit mass; used by the tests. */
export function energy(sim) {
  let e = 0;
  for (const b of sim.balls) {
    if (!b.on) continue;
    e += 0.5 * (b.vx * b.vx + b.vy * b.vy) + I_FACTOR * (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
  }
  return e;
}

/** Resting positions (rounded to 0.01 mm) of a finished or running sim. */
export function snapshot(sim) {
  return sim.balls.map((b) => (b.on ? [round(b.x, 100), round(b.y, 100)] : null));
}

/**
 * Simulate a whole shot to rest. `positions` is the resting table with the cue ball already placed.
 * Returns { events, positions, ticks, pocketed } where pocketed lists { ball, pocket, t }.
 */
export function simulateShot(positions, rawShot) {
  const shot = sanitizeShot(rawShot);
  if (!shot) throw new Error('bad shot');
  const sim = createSim(positions, shot);
  while (!sim.done) stepSim(sim);
  return {
    shot,
    events: sim.events,
    positions: snapshot(sim),
    ticks: sim.tick,
    pocketed: sim.events.filter((e) => e.type === 'pocket' || e.type === 'off').map((e) => ({ ball: e.ball, pocket: e.pocket ?? -1, t: e.t }))
  };
}

/* ------------------------------------------------------ cue placement */

/** Is (x, y) a legal place for the cue ball? `breakShot` restricts it to behind the head string. */
export function validCue(positions, x, y, breakShot = false) {
  if (!num(x) || !num(y)) return false;
  if (x < R || x > L - R || y < R || y > W - R) return false;
  if (breakShot && x > HEAD_X) return false;
  for (let i = 1; i < 16; i++) {
    const p = positions[i];
    if (!p) continue;
    const dx = p[0] - x;
    const dy = p[1] - y;
    if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) return false;
  }
  for (const k of POCKETS) {
    const dx = x - k.x;
    const dy = y - k.y;
    if (dx * dx + dy * dy < k.r * k.r) return false;
  }
  return true;
}

/** Closest legal cue position to a wanted one (for dragging), or null. */
export function nearestCue(positions, x, y, breakShot = false) {
  if (!num(x) || !num(y)) return null;
  const maxX = breakShot ? HEAD_X : L - R;
  let cx = clamp(x, R, maxX);
  let cy = clamp(y, R, W - R);
  for (let it = 0; it < 8; it++) {
    if (validCue(positions, cx, cy, breakShot)) return { x: cx, y: cy };
    for (let i = 1; i < 16; i++) {
      const p = positions[i];
      if (!p) continue;
      const dx = cx - p[0];
      const dy = cy - p[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 2 * R + 1) {
        if (d < 1e-6) { cx = p[0] + 2 * R + 1; }
        else { const k = (2 * R + 1) / d; cx = p[0] + dx * k; cy = p[1] + dy * k; }
      }
    }
    for (const q of POCKETS) {
      const dx = cx - q.x;
      const dy = cy - q.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < q.r + 1) {
        if (d < 1e-6) { cx = q.x + q.r + 1; }
        else { const k = (q.r + 1) / d; cx = q.x + dx * k; cy = q.y + dy * k; }
      }
    }
    cx = clamp(cx, R, maxX);
    cy = clamp(cy, R, W - R);
  }
  return validCue(positions, cx, cy, breakShot) ? { x: cx, y: cy } : null;
}

/** A free spot for a re-spotted ball: the foot spot, or the nearest free place behind it. */
export function freeSpot(positions, ignore = -1) {
  const clear = (x, y) => {
    for (let i = 0; i < 16; i++) {
      if (i === ignore) continue;
      const p = positions[i];
      if (!p) continue;
      const dx = p[0] - x;
      const dy = p[1] - y;
      if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) return false;
    }
    return true;
  };
  for (let x = FOOT_X; x <= L - R; x += 1) if (clear(x, W / 2)) return [x, W / 2];
  for (let x = FOOT_X; x >= R; x -= 1) if (clear(x, W / 2)) return [x, W / 2];
  return [FOOT_X, W / 2];
}

/* ----------------------------------------------------------- aim guide */

/**
 * Geometric aim preview for the shooter: where the cue ball first touches something.
 * Returns { hit: ballId | null, point: {x,y} (cue ball centre at contact, or at the rail),
 * target: {x,y} | null (object ball centre), objDir, cueDir (unit vectors after impact, ignoring spin) }.
 */
export function aimPreview(positions, cue, angle) {
  const { s, c } = sincos(angle);
  let best = Infinity;
  let hit = null;
  const D2 = 4 * R * R;
  for (let i = 1; i < 16; i++) {
    const p = positions[i];
    if (!p) continue;
    const fx = p[0] - cue.x;
    const fy = p[1] - cue.y;
    const along = fx * c + fy * s;
    if (along <= 0) continue;
    const perp2 = fx * fx + fy * fy - along * along;
    if (perp2 >= D2) continue;
    const t = along - Math.sqrt(D2 - perp2);
    if (t < best) { best = t; hit = i; }
  }
  let rail = Infinity;
  if (c > 1e-9) rail = Math.min(rail, (L - R - cue.x) / c);
  else if (c < -1e-9) rail = Math.min(rail, (R - cue.x) / c);
  if (s > 1e-9) rail = Math.min(rail, (W - R - cue.y) / s);
  else if (s < -1e-9) rail = Math.min(rail, (R - cue.y) / s);
  if (hit === null || rail < best) {
    const t = Math.max(0, rail);
    return { hit: null, point: { x: cue.x + c * t, y: cue.y + s * t }, target: null, objDir: null, cueDir: null };
  }
  const point = { x: cue.x + c * best, y: cue.y + s * best };
  const tp = positions[hit];
  let nx = tp[0] - point.x;
  let ny = tp[1] - point.y;
  const nl = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= nl; ny /= nl;
  const dot = c * nx + s * ny;
  const cx = c - dot * nx;
  const cy = s - dot * ny;
  const cl = Math.sqrt(cx * cx + cy * cy);
  const cueDir = cl < 1e-6 ? { x: 0, y: 0 } : { x: cx / cl, y: cy / cl };
  return { hit, point, target: { x: tp[0], y: tp[1] }, objDir: { x: nx, y: ny }, cueDir, cueSpeed: cl };
}
