/* Hamsterball client: renders server snapshots (interpolated ~110 ms in the past), sends input. */

const THREE = window.THREE;
const $ = (id) => document.getElementById(id);

const R0 = 200; // plate radius at the start of a round (server units)
const BR = 20; // ball radius (server units)
const MODEL_R = 15; // the hamster model is built at this radius and scaled to BR
const INTERP_MS = 100;
const HEARTBEAT_MS = 250;
const SEND_GAP_MS = 33;
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// One distinct colour per player, shared by the 3D ball, the labels and the HUD.
const COLORS = ['#ef4444', '#f59e0b', '#facc15', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#d946ef', '#f472b6', '#e2e8f0'];
const colorOf = (ci) => COLORS[ci % COLORS.length];

socketOff();
function socketOff() { for (const ev of ['hb-init', 'hb-state']) socket.off(ev); }

const cleanups = [];
WBG.onTeardown(() => { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } } });

WBG.setRules({
  title: 'Hamsterball',
  sections: [
    {
      title: 'Goal',
      items: [
        'Roll your hamster ball around the wooden plate and bump rivals over the edge.',
        'Every fall costs a life. With no lives left you are out for the round.',
        'The last ball standing wins the round and scores a point. If the final two fall together, whoever went over the edge later wins; an exact tie gives both a point.',
        'After the last round the player with the most round wins takes the match (ties are broken by lives left, then time survived).'
      ]
    },
    {
      title: 'Controls',
      items: [
        'Keyboard: W A S D or the arrow keys to roll, hold Space to boost.',
        'Touch: drag anywhere on the left side to steer (the stick appears under your thumb) and hold the Boost button on the right.',
        'Boost accelerates you and makes you heavier, so ramming someone while boosting hits much harder. The bar drains while boosting, refills when you stop, and locks briefly if you run it dry.'
      ]
    },
    {
      title: 'The plate',
      items: [
        'The plate tilts toward the middle of all the balls, so everybody slides downhill together. Watch the edge.',
        'After a fall you respawn near the centre and are protected for about 1.5 seconds.',
        'With the shrinking plate on, the edge starts closing in after 15 seconds until about 45 percent of the plate is left. Even with shrinking off, the plate closes in after 2 minutes so a round always ends.'
      ]
    }
  ]
});

boot();

function boot() {
  const root = $('hb-root');
  const canvas = $('canvas');
  const loadingText = $('hb-loading-text');

  if (!THREE) {
    loadingText.textContent = 'Could not load the 3D engine. Check your connection and reload.';
    return;
  }

  const S = {
    id: null, spectator: WBG.isSpectator, names: null, order: [], opts: { rounds: 3, lives: 3, shrink: true },
    last: null, hasState: false
  };
  const snaps = [];
  const eventQueue = [];
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  cleanups.push(() => { timers.forEach(clearTimeout); timers.clear(); });

  /* ------------------------------------------------------------- renderer */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    loadingText.textContent = 'Your browser could not start WebGL, so Hamsterball cannot be shown.';
    return;
  }
  renderer.setClearColor(0x0b1020, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 100, 4000);
  const camBase = new THREE.Vector3();
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const sun = new THREE.DirectionalLight(0xfff1dd, 0.85);
  sun.position.set(220, 520, 260);
  scene.add(sun);
  const rimLight = new THREE.DirectionalLight(0x8aa4ff, 0.35);
  rimLight.position.set(-300, 200, -240);
  scene.add(rimLight);

  const tiltGroup = new THREE.Group(); // plate + everything on it tilts together
  scene.add(tiltGroup);

  /* ----------------------------------------------------------- shared assets */
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  const canvasTex = (w, h, draw) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = track(new THREE.CanvasTexture(c));
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  };

  const woodTex = (() => {
    const t = canvasTex(1024, 1024, (g, w, h) => {
      const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0, '#c98a4b'); grad.addColorStop(0.55, '#a8693a'); grad.addColorStop(1, '#7b4a28');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.lineWidth = 2;
      for (let i = 0; i < 90; i++) {
        g.strokeStyle = `rgba(70,40,18,${0.05 + (i % 5) * 0.025})`;
        g.beginPath();
        const y = (i / 90) * h;
        g.moveTo(0, y);
        for (let x = 0; x <= w; x += 64) g.lineTo(x, y + Math.sin(x * 0.011 + i) * 7 + Math.sin(i * 2.1) * 4);
        g.stroke();
      }
      g.strokeStyle = 'rgba(255,225,170,0.22)'; g.lineWidth = 3;
      for (const r of [0.32, 0.64, 0.92]) { g.beginPath(); g.arc(w / 2, h / 2, r * w / 2, 0, Math.PI * 2); g.stroke(); }
      g.strokeStyle = 'rgba(40,20,8,0.35)'; g.lineWidth = 2;
      for (let a = 0; a < 8; a++) {
        g.beginPath(); g.moveTo(w / 2, h / 2);
        g.lineTo(w / 2 + Math.cos(a * Math.PI / 4) * w * 0.14, h / 2 + Math.sin(a * Math.PI / 4) * w * 0.14); g.stroke();
      }
    });
    t.anisotropy = 4;
    return t;
  })();

  const blobTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
  const puffTex = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });

  const sphereGeo = track(new THREE.SphereGeometry(1, 14, 10));
  const shellGeo = track(new THREE.SphereGeometry(MODEL_R, 28, 18));
  const bandGeo = track(new THREE.TorusGeometry(MODEL_R + 0.15, 0.85, 6, 40));
  const planeGeo = track(new THREE.PlaneGeometry(1, 1));
  const ringGeo = track(new THREE.RingGeometry(0.82, 1, 48));
  const thinRingGeo = track(new THREE.RingGeometry(0.955, 1, 96));
  const ownRingGeo = track(new THREE.RingGeometry(BR + 5, BR + 8, 48));

  const mat = (opts) => track(new THREE.MeshPhongMaterial(opts));
  const eyeMat = mat({ color: 0x15121c, shininess: 90 });
  const noseMat = mat({ color: 0xff8fa8 });
  const earMat = mat({ color: 0xffb3c1 });
  const creamMat = mat({ color: 0xfff1d6 });

  /* ------------------------------------------------------------------ plate */
  const plate = new THREE.Group();
  tiltGroup.add(plate);
  const plateTop = new THREE.Mesh(
    track(new THREE.CylinderGeometry(R0, R0, 24, 72)),
    [mat({ color: 0x6a3f20, shininess: 10 }), mat({ map: woodTex, shininess: 28, specular: 0x332211 }), mat({ color: 0x3a2312 })]
  );
  plateTop.position.y = -12;
  plate.add(plateTop);
  const rim = new THREE.Mesh(track(new THREE.TorusGeometry(R0 - 1, 4.5, 10, 96)), mat({ color: 0x4a2c18, shininess: 50, specular: 0x554433 }));
  rim.rotation.x = Math.PI / 2;
  plate.add(rim);
  const studGeo = track(new THREE.CylinderGeometry(4, 4, 2, 10));
  const studMat = mat({ color: 0xd9b36a, shininess: 80 });
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(studGeo, studMat);
    const a = (i / 12) * Math.PI * 2;
    m.position.set(Math.cos(a) * (R0 - 16), 0.8, Math.sin(a) * (R0 - 16));
    plate.add(m);
  }
  // A dim marker at the original edge plus a pulsing danger ring at the current one.
  const outline = new THREE.Mesh(thinRingGeo, track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })));
  outline.rotation.x = -Math.PI / 2; outline.position.y = -3; outline.scale.set(R0 + 6, R0 + 6, 1);
  tiltGroup.add(outline);
  const dangerMat = track(new THREE.MeshBasicMaterial({ color: 0xff3b55, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  const danger = new THREE.Mesh(thinRingGeo, dangerMat);
  danger.rotation.x = -Math.PI / 2; danger.position.y = 1.2; danger.visible = false;
  tiltGroup.add(danger);

  /* ------------------------------------------------------------------- balls */
  const balls = {};

  function makeLabel(name, color, mine) {
    const text = name.length > 14 ? `${name.slice(0, 13)}.` : name;
    const font = '700 34px system-ui, "Segoe UI", sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const tw = Math.ceil(probe.measureText(text).width);
    const w = tw + 76, h = 56;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(10,14,32,0.86)';
    g.beginPath(); g.roundRect ? g.roundRect(2, 2, w - 4, h - 4, 26) : g.rect(2, 2, w - 4, h - 4); g.fill();
    g.lineWidth = mine ? 4 : 3; g.strokeStyle = mine ? '#ffffff' : color; g.stroke();
    g.fillStyle = color; g.beginPath(); g.arc(30, h / 2, 11, 0, Math.PI * 2); g.fill();
    g.font = font; g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, 52, h / 2 + 2);
    const tex = track(new THREE.CanvasTexture(c));
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const m = track(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    const sprite = new THREE.Sprite(m);
    sprite.renderOrder = 10;
    sprite.userData.aspect = w / h;
    return sprite;
  }

  function createBall(id) {
    const info = S.names[id];
    const color = colorOf(info.ci);
    const mine = id === S.id;
    const root = new THREE.Group();

    const furMat = track(new THREE.MeshPhongMaterial({ color, shininess: 18, specular: 0x222222 }));
    const ham = new THREE.Group();
    const part = (geo, material, sx, sy, sz, x, y, z) => {
      const m = new THREE.Mesh(geo, material);
      m.scale.set(sx, sy, sz); m.position.set(x, y, z); ham.add(m); return m;
    };
    part(sphereGeo, furMat, 7.2, 6.2, 8.2, 0, -6.5, 0);
    part(sphereGeo, furMat, 5.2, 4.8, 5, 0, -3.6, 6.2);
    part(sphereGeo, creamMat, 5.2, 3.6, 5.2, 0, -8.6, 1.5);
    part(sphereGeo, creamMat, 2.5, 2.4, 2.5, -3.4, -5.2, 9);
    part(sphereGeo, creamMat, 2.5, 2.4, 2.5, 3.4, -5.2, 9);
    part(sphereGeo, earMat, 1.9, 2.3, 1, -3.4, 0.2, 5);
    part(sphereGeo, earMat, 1.9, 2.3, 1, 3.4, 0.2, 5);
    part(sphereGeo, eyeMat, 0.95, 0.95, 0.95, -2.1, -2.4, 10.4);
    part(sphereGeo, eyeMat, 0.95, 0.95, 0.95, 2.1, -2.4, 10.4);
    part(sphereGeo, noseMat, 0.9, 0.8, 0.8, 0, -4, 11.3);
    const feet = [
      part(sphereGeo, earMat, 1.8, 1.2, 2.6, -3.2, -12.3, 3.5),
      part(sphereGeo, earMat, 1.8, 1.2, 2.6, 3.2, -12.3, -3.5),
      part(sphereGeo, earMat, 1.8, 1.2, 2.6, 3.2, -12.3, 3.5),
      part(sphereGeo, earMat, 1.8, 1.2, 2.6, -3.2, -12.3, -3.5)
    ];
    const model = new THREE.Group();
    model.scale.setScalar(BR / MODEL_R);
    model.add(ham);
    root.add(model);

    const shell = new THREE.Group();
    const shellMat = track(new THREE.MeshPhongMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.26, shininess: 140, specular: 0xffffff, depthWrite: false }));
    const glass = new THREE.Mesh(shellGeo, shellMat);
    glass.renderOrder = 2;
    shell.add(glass);
    const bandMat = track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    for (const [rx, ry] of [[Math.PI / 2, 0], [0, Math.PI / 2], [Math.PI / 4, Math.PI / 3]]) {
      const b = new THREE.Mesh(bandGeo, bandMat);
      b.rotation.set(rx, ry, 0);
      shell.add(b);
    }
    model.add(shell);

    const label = makeLabel(info.name, color, mine);
    label.position.y = BR + 20;
    root.add(label);

    const shadowMat = track(new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
    const shadow = new THREE.Mesh(planeGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2; shadow.scale.set(BR * 3, BR * 3, 1); shadow.position.y = 0.5;
    tiltGroup.add(shadow);

    let ownRing = null;
    if (mine) {
      ownRing = new THREE.Mesh(ownRingGeo, track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })));
      ownRing.rotation.x = -Math.PI / 2; ownRing.position.y = 0.9;
      tiltGroup.add(ownRing);
    }
    tiltGroup.add(root);

    const rec = {
      id, color, mine, root, ham, shell, shellMat, bandMat, label, shadow, shadowMat, ownRing, feet,
      x: 0, y: 0, hasPos: false, yaw: 0, falling: false, fallT: 0, spawnT: 1, legPhase: 0, trailT: 0, wasBoost: false
    };
    balls[id] = rec;
    return rec;
  }

  function removeBall(rec) {
    tiltGroup.remove(rec.root, rec.shadow);
    if (rec.ownRing) tiltGroup.remove(rec.ownRing);
    delete balls[rec.id];
  }

  /* --------------------------------------------------------------- particles */
  const puffs = [];
  for (let i = 0; i < 70; i++) {
    const m = track(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0 }));
    const s = new THREE.Sprite(m);
    s.visible = false;
    tiltGroup.add(s);
    puffs.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 6, s1: 20, a0: 0.6 });
  }
  let puffCursor = 0;
  function emitPuff(x, y, z, vx, vy, vz, max, s0, s1, color, a0 = 0.6) {
    const p = puffs[puffCursor++ % puffs.length];
    p.life = p.max = max; p.vx = vx; p.vy = vy; p.vz = vz; p.s0 = s0; p.s1 = s1; p.a0 = a0;
    p.s.position.set(x, y, z);
    p.s.material.color.set(color);
    p.s.visible = true;
    return p;
  }
  function burst(x, y, n, speed, color, size = 14) {
    if (REDUCED) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.6);
      emitPuff(x, 8 + Math.random() * 6, y, Math.cos(a) * v, 20 + Math.random() * 40, Math.sin(a) * v, 0.45 + Math.random() * 0.25, size * 0.5, size * 1.5, color);
    }
  }

  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    const r = new THREE.Mesh(ringGeo, m);
    r.rotation.x = -Math.PI / 2; r.visible = false;
    tiltGroup.add(r);
    rings.push({ r, life: 0, max: 0.5, r0: 10, r1: 60 });
  }
  let ringCursor = 0;
  function emitRing(x, y, color, r0, r1, max = 0.55) {
    const e = rings[ringCursor++ % rings.length];
    e.life = e.max = max; e.r0 = r0; e.r1 = r1;
    e.r.position.set(x, 1.5, y);
    e.r.material.color.set(color);
    e.r.visible = true;
  }

  let shake = 0;
  function updateFx(dt) {
    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.vx *= 0.94; p.vz *= 0.94; p.vy *= 0.95;
      const sc = p.s0 + (p.s1 - p.s0) * k;
      p.s.scale.set(sc, sc, 1);
      p.s.material.opacity = p.a0 * (1 - k);
    }
    for (const e of rings) {
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) { e.r.visible = false; continue; }
      const k = 1 - e.life / e.max;
      const rad = e.r0 + (e.r1 - e.r0) * (1 - (1 - k) * (1 - k));
      e.r.scale.set(rad, rad, 1);
      e.r.material.opacity = 0.8 * (1 - k);
    }
    shake *= Math.pow(0.001, dt); // decays within ~0.4 s
    if (shake < 0.05) shake = 0;
  }

  /* ------------------------------------------------------------------ layout */
  let pxPerUnit = 1;
  let LABEL_PX = 22;
  function layout() {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tv = Math.tan((camera.fov * Math.PI) / 360);
    const th = tv * camera.aspect;
    const el = ((camera.aspect < 0.8 ? 64 : 55) * Math.PI) / 180;
    const dist = Math.max(240 / th, (camera.aspect < 0.8 ? 268 : 256) / tv);
    camBase.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    camera.position.copy(camBase);
    camera.lookAt(0, 0, 0);
    pxPerUnit = h / (2 * dist * tv);
    LABEL_PX = w < 600 ? (S.order.length > 6 ? 15 : 19) : 22;
    for (const b of Object.values(balls)) sizeLabel(b);
  }
  function sizeLabel(b) {
    const hh = LABEL_PX / pxPerUnit;
    b.label.scale.set(hh * b.label.userData.aspect, hh, 1);
  }
  const ro = new ResizeObserver(layout);
  ro.observe(root);
  window.addEventListener('resize', layout);
  cleanups.push(() => { ro.disconnect(); window.removeEventListener('resize', layout); });

  /* ----------------------------------------------------------- snapshot view */
  const view = { phase: 'wait', radius: R0, tx: 0, tz: 0, players: {} };
  const lerp = (a, b, t) => a + (b - a) * t;

  // Map server time (ts) to the local clock: follow the fastest packets so bursts do not cause stutter.
  let clockOff = null;
  function trackClock(now, ts) {
    const d = now - ts;
    if (clockOff === null || d < clockOff) clockOff = d;
    else clockOff += (d - clockOff) * 0.01;
  }
  const serverNow = (now) => now - (clockOff ?? now);

  function sample(rt) {
    const n = snaps.length;
    if (!n) return null;
    let a = snaps[0], b = null;
    for (let i = n - 1; i >= 0; i--) {
      if (snaps[i].at <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    const sa = a.s;
    let f = 0, ext = 0;
    if (b) f = Math.min(1, Math.max(0, (rt - a.at) / Math.max(1, b.at - a.at)));
    else ext = Math.min(0.12, Math.max(0, (rt - a.at) / 1000));
    const sb = b ? b.s : sa;
    view.phase = sb.phase;
    view.radius = lerp(sa.radius, sb.radius, f);
    view.tx = lerp(sa.plateTilt.x, sb.plateTilt.x, f);
    view.tz = lerp(sa.plateTilt.z, sb.plateTilt.z, f);
    for (const id in view.players) if (!(id in sb.players) && !(id in sa.players)) delete view.players[id];
    for (const id in sb.players) {
      const pb = sb.players[id], pa = sa.players[id] || pb;
      const v = view.players[id] || (view.players[id] = {});
      const jump = Math.hypot(pb.x - pa.x, pb.y - pa.y) > 60;
      if (jump) { v.x = pb.x; v.y = pb.y; }
      else if (b) { v.x = lerp(pa.x, pb.x, f); v.y = lerp(pa.y, pb.y, f); }
      else { v.x = pa.x + pa.vx * ext; v.y = pa.y + pa.vy * ext; }
      v.vx = lerp(pa.vx, pb.vx, f); v.vy = lerp(pa.vy, pb.vy, f);
      v.fl = pa.fl; v.alive = pa.alive; v.inv = lerp(pa.inv, pb.inv, f); v.b = pa.b;
    }
    return view;
  }

  /* ------------------------------------------------------------------- audio */
  let lastBumpSound = 0, lastBoostSound = 0, lastFallSound = 0;
  function playEvent(e, now) {
    const me = balls[S.id];
    if (e.t === 'bump') {
      const col = '#ffffff';
      burst(e.x, e.y, 4 + Math.round(e.power * 6), 60 + e.power * 80, col, 12 + e.power * 8);
      if (e.power >= 0.55) shake = Math.max(shake, Math.min(14, 4 + e.power * 6));
      if (now - lastBumpSound > 70) {
        lastBumpSound = now;
        WBG.sound.play(e.power >= 0.3 ? 'bump' : 'click');
      }
      if (me && Math.hypot(me.x - e.x, me.y - e.y) < BR * 3) WBG.haptic(Math.round(10 + Math.min(e.power, 1.5) * 25));
    } else if (e.t === 'fall') {
      if (now - lastFallSound > 120) { lastFallSound = now; WBG.sound.play('fall'); }
      if (e.id === S.id) { WBG.haptic(60); shake = Math.max(shake, 8); }
      const b = balls[e.id];
      if (b) burst(e.x, e.y, 8, 90, b.color, 14);
    } else if (e.t === 'out') {
      if (e.id === S.id) { WBG.sound.later('lose', 350); WBG.haptic(120); }
    } else if (e.t === 'respawn') {
      const b = balls[e.id];
      if (b) { emitRing(e.x, e.y, b.color, 14, 56, 0.6); b.spawnT = 0; }
    }
  }
  function drainEvents(rt, now) {
    while (eventQueue.length && eventQueue[0].due <= rt) playEvent(eventQueue.shift().e, now);
  }

  /* ------------------------------------------------------------------- input */
  const keys = {};
  const touch = { active: false, x: 0, y: 0, boost: false };
  const touchUI = !!window.matchMedia?.('(pointer: coarse)').matches && !S.spectator;
  let lastSent = { x: 0, y: 0, boost: false }, lastSendAt = 0;

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const onKeyDown = (e) => {
    if (isTyping(e.target)) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    keys[e.code] = true;
  };
  const onKeyUp = (e) => { keys[e.code] = false; };
  const clearKeys = () => { for (const k in keys) keys[k] = false; touch.boost = false; };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  cleanups.push(() => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', clearKeys);
  });

  function canControl() {
    if (S.spectator || !S.last || document.hidden) return false;
    const me = S.last.players[S.id];
    return !!me && me.alive && (S.last.phase === 'countdown' || S.last.phase === 'playing');
  }

  function readInput() {
    let x = 0, y = 0;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyW || keys.ArrowUp) y -= 1;
    if (keys.KeyS || keys.ArrowDown) y += 1;
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
    if (touch.active) { x = touch.x; y = touch.y; }
    return { x: Math.round(x * 50) / 50, y: Math.round(y * 50) / 50, boost: !!(keys.Space || touch.boost) };
  }

  function pump(now, force = false) {
    if (!canControl()) {
      if (lastSent.x || lastSent.y || lastSent.boost) { sendInput({ x: 0, y: 0, boost: false }, now); }
      return;
    }
    const cur = readInput();
    const changed = cur.x !== lastSent.x || cur.y !== lastSent.y || cur.boost !== lastSent.boost;
    if ((changed && now - lastSendAt >= SEND_GAP_MS) || force || now - lastSendAt >= HEARTBEAT_MS) sendInput(cur, now);
  }
  function sendInput(cur, now) {
    lastSent = cur;
    lastSendAt = now;
    socket.emit('hamsterball-move', cur);
  }
  const heartbeat = setInterval(() => pump(performance.now()), 100);
  cleanups.push(() => clearInterval(heartbeat));

  if (touchUI) setupTouch();
  $('hb-touch').hidden = !touchUI;
  $('hb-keys').hidden = touchUI || S.spectator;
  if (!touchUI && !S.spectator) $('hb-keys').classList.add('sm:block');

  function setupTouch() {
    const zone = $('hb-zone'), stick = $('hb-stick'), knob = $('hb-knob'), boostBtn = $('hb-boost');
    zone.classList.add('pointer-events-auto', 'touch-none');
    boostBtn.classList.add('pointer-events-auto');
    const RADIUS = 56;
    let pid = null, cx = 0, cy = 0;
    const base = () => root.getBoundingClientRect();
    const placeBase = () => {
      const r = base();
      stick.style.left = `${cx - r.left - 60}px`;
      stick.style.top = `${cy - r.top - 60}px`;
      stick.style.bottom = 'auto';
    };
    const update = (e) => {
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) { // the stick follows the thumb when it is dragged past the edge
        const k = (len - RADIUS) / len;
        cx += dx * k; cy += dy * k;
        placeBase();
        dx = e.clientX - cx; dy = e.clientY - cy;
      }
      const mag = Math.min(1, Math.hypot(dx, dy) / RADIUS);
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      if (mag < 0.12) { touch.x = touch.y = 0; return; }
      const s = (mag - 0.12) / 0.88 / mag;
      touch.x = (dx / RADIUS) * s;
      touch.y = (dy / RADIUS) * s;
    };
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      touch.active = false; touch.x = touch.y = 0;
      knob.style.transform = 'translate(-50%, -50%)';
      stick.style.left = '1.25rem'; stick.style.top = 'auto'; stick.style.bottom = '2.25rem';
      stick.classList.add('opacity-60'); stick.classList.remove('opacity-100');
    };
    zone.addEventListener('pointerdown', (e) => {
      if (pid !== null) return;
      pid = e.pointerId;
      zone.setPointerCapture(pid);
      cx = e.clientX; cy = e.clientY;
      touch.active = true;
      placeBase();
      stick.classList.remove('opacity-60'); stick.classList.add('opacity-100');
      update(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === pid) update(e); });
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    let bid = null;
    boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); bid = e.pointerId; boostBtn.setPointerCapture(bid); touch.boost = true; });
    const boostEnd = (e) => { if (e.pointerId === bid) { bid = null; touch.boost = false; } };
    boostBtn.addEventListener('pointerup', boostEnd);
    boostBtn.addEventListener('pointercancel', boostEnd);
    boostBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------------- HUD */
  const strip = $('hb-strip'), list = $('hb-list');
  let hudSig = '';
  function hearts(n, cls) {
    let out = '';
    for (let i = 0; i < S.opts.lives; i++) out += WBG.icon('heart', `${cls} shrink-0 ${i < n ? 'fill-rose-500 text-rose-500' : 'text-white/25'}`);
    return out;
  }
  function renderPlayers(snap) {
    const ids = S.order.filter((id) => snap.players[id]);
    let sig = `${S.id}|`;
    for (const id of ids) { const p = snap.players[id]; sig += `${id}:${p.lives}:${snap.wins[id]};`; }
    if (sig === hudSig) return;
    hudSig = sig;
    const showWins = S.opts.rounds > 1;
    const row = (id, compact) => {
      const p = snap.players[id], info = S.names[id], color = colorOf(info.ci);
      const mine = id === S.id;
      const wins = showWins ? `<span class="flex shrink-0 items-center gap-0.5 text-amber-300">${WBG.icon('trophy', compact ? 'size-3' : 'size-3.5')}<span class="font-semibold tabular-nums">${snap.wins[id] || 0}</span></span>` : '';
      const base = compact
        ? 'inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[11px] leading-none backdrop-blur-sm'
        : 'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm';
      const tone = mine ? 'bg-brand-500/35 ring-1 ring-brand-300/60' : compact ? 'bg-slate-950/70' : 'bg-white/5';
      return `<li class="${base} ${tone} ${p.alive ? '' : 'opacity-45'}"><span class="size-2.5 shrink-0 rounded-full" style="background:${color}"></span><span class="${compact ? 'max-w-[5.2rem]' : 'flex-1'} truncate text-white">${WBG.esc(info.name)}</span>${wins}<span class="flex shrink-0 gap-px">${hearts(p.lives, compact ? 'size-3' : 'size-4')}</span></li>`;
    };
    strip.innerHTML = ids.map((id) => row(id, true)).join('');
    list.innerHTML = ids.map((id) => row(id, false)).join('');
  }

  const roundChip = $('hb-round'), dangerChip = $('hb-danger');
  const countEl = $('hb-count'), banner = $('hb-banner');
  const staminaWrap = $('hb-stamina'), staminaFill = $('hb-stamina-fill'), outChip = $('hb-out');
  const boostRing = $('hb-boost-ring');
  let lastDigit = 0, lastPhase = '', bannerRound = 0, lastStamina = -1, lastRoundTxt = '', goTimer = null;

  function showCount(text) {
    countEl.textContent = text;
    countEl.classList.remove('hb-count-anim');
    void countEl.offsetWidth;
    countEl.classList.add('hb-count-anim');
  }

  function showBanner(snap) {
    const res = snap.result;
    if (!res) return;
    const names = res.winners.map((id) => S.names[id]?.name || '?');
    const mineWon = res.winners.includes(S.id);
    $('hb-banner-title').textContent = !names.length ? 'Round over' : res.draw ? 'Draw' : mineWon ? 'You win the round' : `${names[0]} wins the round`;
    $('hb-banner-sub').textContent = (res.draw ? `${names.join(' and ')} share the point. ` : '') + (snap.round < snap.rounds ? `Round ${snap.round} of ${snap.rounds} done. Next round is coming up.` : 'That was the final round.');
    $('hb-banner-icon').innerHTML = WBG.icon(res.draw ? 'draw' : 'trophy', 'size-6');
    banner.hidden = false;
    banner.classList.remove('hb-banner-anim');
    void banner.offsetWidth;
    banner.classList.add('hb-banner-anim');
    WBG.sound.play(mineWon ? 'coin' : 'notify');
    if (mineWon) WBG.haptic(40);
  }

  function updatePhaseUi(snap) {
    const ph = snap.phase;
    if (ph !== lastPhase) {
      if (ph === 'countdown') { lastDigit = 0; banner.hidden = true; }
      if (lastPhase === 'countdown' && ph === 'playing') {
        showCount('GO!');
        WBG.sound.play('go');
        clearTimeout(goTimer);
        goTimer = later(() => { if (lastPhase === 'playing') countEl.textContent = ''; }, 900);
      }
      if (ph === 'roundover' && bannerRound !== snap.round) { bannerRound = snap.round; showBanner(snap); }
      if (ph === 'playing' || ph === 'over') { if (ph === 'over') banner.hidden = true; }
      if (ph === 'playing' && lastPhase === 'roundover') banner.hidden = true;
      lastPhase = ph;
    }
    if (ph === 'countdown') {
      const d = Math.max(1, Math.ceil(snap.cd / 1000));
      if (d !== lastDigit) { lastDigit = d; showCount(String(d)); WBG.sound.play('countdown'); WBG.haptic(8); }
    } else if (ph !== 'playing' && countEl.textContent) countEl.textContent = '';
    if (ph === 'roundover' && banner.hidden && snap.result && bannerRound === snap.round) banner.hidden = false; // resync

    const started = ph !== 'wait';
    const rtxt = started ? `Round ${snap.round} of ${snap.rounds}` : '';
    if (rtxt !== lastRoundTxt) { lastRoundTxt = rtxt; roundChip.textContent = rtxt; roundChip.hidden = !rtxt; }
    dangerChip.hidden = !(ph === 'playing' && snap.radius < R0 - 1);

    const me = snap.players[S.id];
    const out = !S.spectator && !!me && !me.alive && (ph === 'playing');
    outChip.hidden = !out;
    staminaWrap.hidden = S.spectator || !me || out || touchUI;
    $('hb-spectator').hidden = !S.spectator;
    if (me && me.stamina !== lastStamina) {
      lastStamina = me.stamina;
      staminaFill.style.transform = `scaleX(${me.stamina})`;
      staminaFill.style.opacity = me.stamina < 0.15 ? '0.55' : '1';
      boostRing.style.strokeDashoffset = String(289 * (1 - me.stamina));
    }
  }

  /* ----------------------------------------------------------------- frame */
  let raf = 0, lastFrame = 0;
  const tmpQ = new THREE.Quaternion(), tmpAxis = new THREE.Vector3();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    pump(now);
    const rt = serverNow(now) - INTERP_MS;
    drainEvents(rt, now);
    const v = sample(rt);
    if (v) {
      const s = Math.max(0.2, v.radius / R0);
      plate.scale.set(s, 1, s);
      tiltGroup.rotation.x = v.tx;
      tiltGroup.rotation.z = v.tz;
      if (v.radius < R0 - 1) {
        danger.visible = true;
        danger.scale.set(v.radius + 3, v.radius + 3, 1);
        dangerMat.opacity = 0.55 + 0.35 * Math.sin(now * 0.008);
      } else danger.visible = false;
      outline.visible = S.opts.shrink;

      for (const id in v.players) {
        if (!balls[id] && S.names?.[id]) { const b = createBall(id); sizeLabel(b); }
      }
      for (const id in balls) updateBall(balls[id], v.players[id], dt, now);
    }
    updateFx(dt);
    if (shake > 0 && !REDUCED) {
      camera.position.set(camBase.x + (Math.random() - 0.5) * shake, camBase.y + (Math.random() - 0.5) * shake, camBase.z + (Math.random() - 0.5) * shake);
    } else camera.position.copy(camBase);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  function updateBall(b, p, dt, now) {
    if (!p || (!p.alive && !p.fl) || (p.fl && b.fallT > 1.1)) { b.root.visible = b.shadow.visible = false; if (b.ownRing) b.ownRing.visible = false; b.falling = false; return; }
    b.root.visible = true;
    if (p.fl) {
      if (!b.falling) { b.falling = true; b.fallT = 0; }
      b.fallT += dt;
    } else if (b.falling) {
      b.falling = false; b.fallT = 0; b.spawnT = 0;
    }
    const dx = p.x - b.x, dz = p.y - b.y;
    const dist = Math.hypot(dx, dz);
    if (b.hasPos && dist > 0.001 && dist < 40) {
      tmpAxis.set(dz, 0, -dx).normalize();
      tmpQ.setFromAxisAngle(tmpAxis, dist / BR);
      b.shell.quaternion.premultiply(tmpQ);
    }
    b.x = p.x; b.y = p.y; b.hasPos = true;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 25) {
      const target = Math.atan2(p.vx, p.vy);
      let d = target - b.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      b.yaw += d * Math.min(1, dt * 9);
    }
    b.ham.rotation.y = b.yaw;
    b.legPhase += speed * dt * 0.09;
    const sw = Math.sin(b.legPhase) * Math.min(1, speed / 120);
    b.feet[0].position.y = -12.3 + Math.max(0, sw) * 2.2;
    b.feet[1].position.y = -12.3 + Math.max(0, sw) * 2.2;
    b.feet[2].position.y = -12.3 + Math.max(0, -sw) * 2.2;
    b.feet[3].position.y = -12.3 + Math.max(0, -sw) * 2.2;
    b.ham.position.y = Math.abs(sw) * 0.8;

    let y = BR, alpha = 1, scale = 1;
    if (b.falling) {
      const t = b.fallT;
      y = BR - t * t * 520 - t * 20;
      alpha = Math.max(0, 1 - t / 0.85);
      scale = 1 - 0.3 * Math.min(1, t / 0.85);
      b.label.visible = t < 0.15;
      b.shadow.visible = false;
    } else {
      b.label.visible = true;
      b.shadow.visible = true;
      if (b.spawnT < 1) {
        b.spawnT = Math.min(1, b.spawnT + dt / 0.4);
        const k = b.spawnT - 1;
        scale = Math.max(0.2, 1 + 2.7 * k * k * k + 1.7 * k * k); // ease out back
      }
    }
    if (p.inv > 0) alpha *= 0.65 + 0.35 * Math.sin(now * 0.025);
    b.root.position.set(p.x, y, p.y);
    b.root.scale.setScalar(scale);
    b.shellMat.opacity = 0.26 * alpha + (p.inv > 0 ? 0.18 : 0);
    b.bandMat.opacity = 0.9 * alpha;
    b.label.material.opacity = alpha;
    b.shadow.position.set(p.x, 0.5, p.y);
    b.shadow.scale.setScalar(BR * 3 * (1 + (y - BR) / 120) * scale);
    if (b.ownRing) {
      b.ownRing.visible = !b.falling;
      b.ownRing.position.set(p.x, 0.9, p.y);
      b.ownRing.material.opacity = 0.55 + 0.3 * Math.sin(now * 0.006);
    }

    // boost feedback
    if (p.b && !b.falling) {
      b.trailT -= dt;
      if (b.trailT <= 0) {
        b.trailT = 0.04;
        const m = Math.max(1, speed);
        if (!REDUCED) emitPuff(p.x - (p.vx / m) * 14, 5, p.y - (p.vy / m) * 14, -p.vx * 0.12, 8, -p.vy * 0.12, 0.4, 7, 16, '#fbbf24', 0.55);
      }
    }
    if (b.mine && p.b && !b.wasBoost && now - lastBoostSound > 250) { lastBoostSound = now; WBG.sound.play('boost'); WBG.haptic(10); }
    b.wasBoost = !!p.b;
  }

  /* ---------------------------------------------------------------- network */
  function disposeBalls() {
    for (const b of Object.values(balls)) removeBall(b);
  }

  socket.on('hb-init', (m) => {
    S.id = m.id;
    S.spectator = !!m.spectator || WBG.isSpectator;
    S.names = m.players;
    S.order = Object.keys(m.players);
    S.opts = { rounds: m.options.rounds, lives: m.options.lives, shrink: !!m.options.shrink };
    snaps.length = 0;
    clockOff = null;
    eventQueue.length = 0;
    S.last = null;
    hudSig = '';
    lastStamina = -1;
    disposeBalls();
    layout();
    $('hb-loading').hidden = true;
    $('hb-spectator').hidden = !S.spectator;
  });

  socket.on('hb-state', (m) => {
    if (!S.names) return;
    const now = performance.now();
    trackClock(now, m.ts);
    snaps.push({ at: m.ts, s: m });
    if (snaps.length > 16) snaps.shift();
    S.last = m;
    for (const e of m.events || []) eventQueue.push({ due: m.ts, e });
    renderPlayers(m);
    updatePhaseUi(m);
  });

  // After a dropped connection the room page re-identifies us, then we ask for a resync.
  let dropped = false;
  const onDisconnect = () => { dropped = true; };
  const onRoomState = () => { if (dropped) { dropped = false; WBG.gameReady('hamsterball-ready'); } };
  socket.on('disconnect', onDisconnect);
  socket.on('room-state', onRoomState);
  cleanups.push(() => { socket.off('disconnect', onDisconnect); socket.off('room-state', onRoomState); socketOff(); });

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      pump(performance.now(), true);
    } else if (!raf) {
      lastFrame = performance.now();
      clockOff = null;
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  /* -------------------------------------------------------------- start/stop */
  layout();
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
  cleanups.push(() => {
    cancelAnimationFrame(raf);
    raf = 0;
    disposeBalls();
    for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
    renderer.dispose();
    renderer.forceContextLoss?.();
  });

  WBG.gameReady('hamsterball-ready');
}
