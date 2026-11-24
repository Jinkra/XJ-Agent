// Xiaojin's on-screen body: one Live2D model (WebGL, #rig) for every state — standing, hanging from a
// rope while dragged, and peeking from bars at the four screen edges — plus 2D extras (#rig-overlay: the
// rope, the bars, sparkles). Parameters are animated here: idle breathing/blinking/glancing, cursor
// following, rope physics, expressions, tap/pinch/wave reactions and speech.
const canvas = document.getElementById('rig');
const overlay = document.getElementById('rig-overlay');
const artwork = document.getElementById('character');
const octx = overlay.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const MODEL_URL = 'live2d/xiaojin/xiaojin.model3.json';
const S = 310 / 1536; // model canvas px -> logical px (the window is 300x450 logical)
// Where features sit on the model canvas (after the chibi proportion warp); refined from xiaojin.layout.json.
const LAYOUT = { head: [512, 470], cheekL: [377, 585], cheekR: [627, 572], sparkA: [804, 324], sparkB: [248, 384], top: [512, 40], feet: [512, 1530] };
const CENTER = [512, 800]; // reference point every placement is expressed in
const ROPE_TOP_Y = 13; // where the cursor sits while dragging (main process anchors the window there)
const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
const smooth = (actual, target, speed) => actual + (target - actual) * speed;
const ease = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

class Spring {
  constructor(stiffness, damping) { this.x = 0; this.v = 0; this.k = stiffness; this.c = damping; }
  step(target, dt) {
    this.v += ((target - this.x) * this.k - this.v * this.c) * dt;
    this.x += this.v * dt;
    return this.x;
  }
  settle(value) { this.x = value; this.v = 0; return value; }
}

let puppet = null, puppetError = null;
let motion = { edge: 'free', dragging: false, vx: 0, vy: 0, shakeSpeed: 0 };
let interactionAt = -10000, last = 0, frameCount = 0;
let nextBlink = 1.5, blinkStart = -10, doubleBlink = false;
let talkUntil = 0, moodUntil = 0, mood = '';
// Expression faces (painted overlays in the model) and the interactions that trigger them.
const expr = { startled: 0, sulky: 0, dizzy: 0, sleepy: 0, wince: 0 };
const timers = { startled: 0, sulky: 0, dizzy: 0 };
let dragStartAt = 0, lastActivity = performance.now(), clicks = [], swings = [], lastSwingSign = 0, dozing = false;
let waveUntil = 0, waveStart = 0, waveSide = 'L';
// User preferences (工作台 → 偏好设置 → 小金的互动); updated by pet.js from the app state.
const prefs = { sleep: true, sleepMinutes: 15, wave: true, pinch: true, dizzy: true, sulky: true, follow: true, swing: 1 };
function petConfigure(settings = {}) {
  const pick = (key, fallback) => settings[key] ?? fallback;
  prefs.sleep = pick('petSleep', true) !== false;
  prefs.sleepMinutes = clamp(Number(pick('petSleepMinutes', 15)) || 15, 1, 240);
  prefs.wave = pick('petWave', true) !== false;
  prefs.pinch = pick('petPinch', true) !== false;
  prefs.dizzy = pick('petDizzy', true) !== false;
  prefs.sulky = pick('petSulky', true) !== false;
  prefs.follow = pick('petFollow', true) !== false;
  prefs.swing = clamp(Number(pick('petSwing', 1)) || 1, .3, 1.5);
  if (!prefs.sleep) dozing = false;
}
const pinch = { side: null, x: 0, y: 0, springX: new Spring(140, 9), springY: new Spring(140, 9), last: null };
const focus = { x: 0, y: 0, at: -10000 };
const view = { ax: 0, ay: 0, eyeX: 0, eyeY: 0 };
const spring = {
  hairFront: new Spring(58, 7.5), hairBack: new Spring(34, 5.2), ahoge: new Spring(95, 6.5),
  earL: new Spring(70, 8), earR: new Spring(78, 8.5), lean: new Spring(105, 15), arms: new Spring(60, 8),
  legL: new Spring(46, 3.6), legR: new Spring(40, 3.4), cloth: new Spring(52, 4.5), dangle: new Spring(26, 6),
  land: new Spring(260, 16), peek: new Spring(70, 11), headLag: new Spring(90, 9),
};
// Rope: the cursor holds the top, Xiaojin hangs from the back of the hood at the other end.
const rope = { top: [150, ROPE_TOP_Y], end: [150, 80], len: 60, r: 60, rv: 0, theta: 0, omega: 0, phi: 0, phiV: 0, vel: [0, 0],
  winV: [0, 0], winA: [0, 0], alpha: 0 };
// Placement blending between states (free / hang / dock): a snapshot eased into the live target.
const place = { state: 'free', from: null, t: 1, current: { r: 0, x: 150, y: 0, sx: 1, sy: 1 }, landPending: false };
let xform = [S, 0, 0, S, 0, 0]; // current canvas -> logical affine (a, b, c, d, e, f)

canvas.dataset.rig = 'live2d';
(() => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', MODEL_URL.replace('.model3.json', '.layout.json'));
  xhr.responseType = 'json';
  xhr.onload = () => { if (xhr.response) Object.assign(LAYOUT, xhr.response); };
  xhr.send();
})();
let figureBox = [150, -170, 875, 1540]; // model-canvas extent of the figure (measured once loaded)
Live2DLite.load(canvas, MODEL_URL).then(model => {
  puppet = model;
  const [x0, y0, x1, y1] = model.bounds();
  if (Number.isFinite(x0)) figureBox = [x0 - 70, y0 - 30, x1 + 70, y1 + 30]; // margin for swinging arms, hair and legs
  canvas.dataset.modelReady = 'true';
}).catch(error => {
  puppetError = error;
  canvas.dataset.modelError = String(error.message || error);
  console.error(error);
});

const toLogical = ([x, y]) => [xform[0] * x + xform[2] * y + xform[4], xform[1] * x + xform[3] * y + xform[5]];
const attachCanvas = () => [LAYOUT.top[0], LAYOUT.top[1] + 26];
const freeAttachY = () => 100 + attachCanvas()[1] * S;

document.addEventListener('mousemove', event => {
  wake();
  const [hx, hy] = toLogical(LAYOUT.head);
  focus.x = clamp((event.clientX / innerWidth * 300 - hx) / 85, -1, 1);
  focus.y = clamp((hy - event.clientY / innerHeight * 450) / 95, -1, 1);
  focus.at = performance.now();
});
document.addEventListener('pointermove', event => {
  if (!motion.dragging) return;
  rope.top = ropeTopAt(event.clientX, event.clientY);
});

function drawSpark(x, y, size, alpha, lineWidth = 1.8) {
  octx.save(); octx.translate(x, y); octx.globalAlpha *= alpha; octx.strokeStyle = '#e5b24f'; octx.lineWidth = lineWidth; octx.lineCap = 'round';
  octx.beginPath(); octx.moveTo(-size, 0); octx.lineTo(size, 0); octx.moveTo(0, -size); octx.lineTo(0, size); octx.stroke(); octx.restore();
}

// ---------------------------------------------------------------------------------------------------
// Placements: rotation r about CENTER, CENTER drawn at logical (x, y), scaled (sx, sy) in model space.
// ---------------------------------------------------------------------------------------------------
function affine({ r, x, y, sx = 1, sy = 1 }) {
  const cos = Math.cos(r), sin = Math.sin(r);
  const a = cos * S * sx, b = sin * S * sx, c = -sin * S * sy, d = cos * S * sy;
  return [a, b, c, d, x - (a * CENTER[0] + c * CENTER[1]), y - (b * CENTER[0] + d * CENTER[1])];
}
function centerFrom(r, pivotCanvas, pivotLogical, sx = 1, sy = 1) {
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = (CENTER[0] - pivotCanvas[0]) * S * sx, dy = (CENTER[1] - pivotCanvas[1]) * S * sy;
  return { r, x: pivotLogical[0] + cos * dx - sin * dy, y: pivotLogical[1] + sin * dx + cos * dy, sx, sy };
}
function toClip([a, b, c, d, e, f]) { return [a / 150, -b / 225, c / 150, -d / 225, e / 150 - 1, 1 - f / 225]; }

// Docked: a bar lies along the screen edge with Xiaojin's hands gripping it (pet-dock-bar.png); the model
// leans on it from behind, its chest on the bar line, the rest of the body beyond the screen edge.
const dockBar = new Image();
dockBar.src = 'pet-dock-bar.png';
const BAR = { width: 216, imgW: 1248, imgH: 209, barCenter: 154, barHalf: 9.2 };
// r: rotation of the bar art (hands point into the screen); lean: rotation of the model itself.
const DOCKS = {
  bottom: { r: 0, lean: 0, out: [0, -1] },
  top: { r: Math.PI, lean: Math.PI, out: [0, 1] },
  left: { r: Math.PI / 2, lean: .92, out: [1, 0] },
  right: { r: -Math.PI / 2, lean: -.92, out: [-1, 0] },
};
// Where the screen's work-area edge actually is, in logical px (window placement can be off by a
// device pixel or two after DPI rounding, which used to leave a sliver between the bar and the taskbar).
function edgeOffset(direction) {
  try {
    const sy = 450 / innerHeight, sx = 300 / innerWidth, sc = window.screen;
    if (direction === 'bottom') return ((sc.availTop + sc.availHeight) - (window.screenY + innerHeight)) * sy;
    if (direction === 'top') return (sc.availTop - window.screenY) * sy;
    if (direction === 'left') return (sc.availLeft - window.screenX) * sx;
    if (direction === 'right') return ((sc.availLeft + sc.availWidth) - (window.screenX + innerWidth)) * sx;
  } catch { /* screen info unavailable */ }
  return 0;
}
function barCenter(direction, corner) {
  // The bar's outer outline sits 1 px past the edge, so it always meets the taskbar / screen top.
  const h = BAR.barHalf - 1, off = clamp(edgeOffset(direction), -12, 12);
  if (direction === 'bottom') return [corner === 'left' ? 108 : corner === 'right' ? 192 : 150, 450 - h + off];
  if (direction === 'top') return [corner === 'left' ? 108 : corner === 'right' ? 192 : 150, h + off];
  return [direction === 'left' ? h : 300 - h, 300];
}
function dockTarget(direction, corner, peek, hop) {
  const dock = DOCKS[direction];
  const lift = 7 * peek + 12 * hop;
  if (direction === 'left' || direction === 'right') {
    // Side: stands upright behind the screen edge and leans out, so only the head and a shoulder show.
    const s = direction === 'left' ? 1 : -1;
    const head = [s > 0 ? 50 + clamp(edgeOffset(direction), -12, 12) : 250 + clamp(edgeOffset(direction), -12, 12), 206];
    return centerFrom(dock.lean, LAYOUT.head, [head[0] + s * lift * .7, head[1]]);
  }
  const [bx, by] = barCenter(direction, corner);
  return centerFrom(dock.r, [512, LAYOUT.bar ? LAYOUT.bar[1] : 700], [bx + dock.out[0] * lift, by + dock.out[1] * lift]);
}
function drawDockBar(direction, corner, alpha, peek) {
  const dock = DOCKS[direction];
  if (!dock || alpha < .02 || !dockBar.complete || !dockBar.naturalWidth) return;
  const k = BAR.width / BAR.imgW;
  const [bx, by] = barCenter(direction, corner);
  const slide = (1 - alpha) * 26; // slides in from beyond the edge
  octx.save();
  octx.globalAlpha = Math.min(1, alpha * 1.4);
  octx.translate(bx - dock.out[0] * slide, by - dock.out[1] * slide);
  octx.rotate(dock.r);
  const y0 = -BAR.barCenter * k, h = BAR.imgH * k, w = BAR.width;
  if (direction === 'left' || direction === 'right') {
    // Side: a bare pole along the edge (Xiaojin's own shoulder leans on it; no extra hands).
    const sw = BAR.imgW, cap = .14;
    octx.drawImage(dockBar, 0, 0, sw * cap, BAR.imgH, -w / 2, y0, w * cap, h);
    const plainX = sw * .5, plainW = sw * .1, endX = sw * .86;
    for (let x = -w / 2 + w * cap; x < w / 2 - w * .14; x += w * .1 - .5) {
      octx.drawImage(dockBar, plainX, 0, plainW, BAR.imgH, x, y0, Math.min(w * .1, w / 2 - w * .14 - x) + .5, h);
    }
    octx.drawImage(dockBar, endX, 0, sw - endX, BAR.imgH, w / 2 - w * .14, y0, w * .14, h);
  } else {
    // the hands tighten a little when Xiaojin pulls up to peek
    octx.drawImage(dockBar, -w / 2, y0, w, h);
  }
  octx.restore();
}

// ---------------------------------------------------------------------------------------------------
// Rope physics (window-local frame: gravity minus the window's own acceleration).
// ---------------------------------------------------------------------------------------------------
function startRope() {
  const [ax, ay] = toLogical(attachCanvas());
  rope.end = [ax, ay]; rope.vel = [0, 0];
  rope.len = Math.max(36, freeAttachY() - ROPE_TOP_Y);
  rope.r = rope.len; rope.rv = 0;
  rope.theta = clamp(-Math.atan2(ax - rope.top[0], ay - rope.top[1]), -.3, .3); rope.omega = 0;
  rope.phi = rope.theta; rope.phiV = 0;
}
function stepRope(dt, calm) {
  // Cursor/IPC samples arrive unevenly; low-pass the velocity first, then the acceleration, so the rope is
  // driven by the real motion of the hand rather than sampling noise (which made the figure twitch).
  const raw = [clamp(motion.vx, -4000, 4000), clamp(motion.vy, -4000, 4000)];
  const kv = 1 - Math.exp(-dt * 9), ka = 1 - Math.exp(-dt * 7);
  const v = [smooth(rope.winV[0], raw[0], kv), smooth(rope.winV[1], raw[1], kv)];
  const a = [(v[0] - rope.winV[0]) / Math.max(dt, .008), (v[1] - rope.winV[1]) / Math.max(dt, .008)];
  rope.winV = v;
  rope.winA = [smooth(rope.winA[0], clamp(a[0], -30000, 30000), ka), smooth(rope.winA[1], clamp(a[1], -30000, 30000), ka)];
  rope.alpha = smooth(rope.alpha, motion.dragging ? 1 : 0, 1 - Math.exp(-dt * (motion.dragging ? 30 : 14)));
  if (!motion.dragging) return;
  if (calm) { rope.theta = rope.omega = 0; rope.r = rope.len; }
  else {
    // The rope and the doll hanging from it swing together as one compound pendulum about the hand
    // (pivot to centre of mass ~ rope + half the body), driven by gravity and the window's acceleration.
    const g = 2600, leff = rope.len + 150;
    const ax = clamp(rope.winA[0] * prefs.swing, -.6 * g, .6 * g), ay = clamp(g - rope.winA[1] * .5 * prefs.swing, .45 * g, 1.6 * g);
    const alpha = -(ay / leff) * Math.sin(rope.theta) - (ax / leff) * Math.cos(rope.theta) - 1.5 * rope.omega;
    const prev = rope.theta;
    rope.omega += alpha * dt;
    const limit = .3 * Math.min(1, prefs.swing);
    rope.theta = clamp(rope.theta + rope.omega * dt, -limit, limit);
    if (rope.theta !== prev + rope.omega * dt) rope.omega = 0; // rest against the swing limit
    // The rope stretches a little when yanked up and sags when the hand drops fast.
    rope.rv += ((rope.len * clamp(ay / g, .8, 1.12) - rope.r) * 240 - rope.rv * 15) * dt;
    rope.r += rope.rv * dt;
  }
  // Never swing the figure out of the window: pull the angle back to the largest one that still fits.
  if (!fitsAt(rope.theta)) {
    let lo = 0, hi = rope.theta;
    for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (fitsAt(mid)) lo = mid; else hi = mid; }
    rope.theta = lo;
    if (rope.omega * lo > 0) rope.omega = 0; // rest against the window edge instead of bouncing
  }

  const prevEnd = rope.end;
  rope.end = [rope.top[0] - Math.sin(rope.theta) * rope.r, rope.top[1] + Math.cos(rope.theta) * rope.r];
  rope.vel = [(rope.end[0] - prevEnd[0]) / Math.max(dt, .008) + rope.winV[0] * .25, (rope.end[1] - prevEnd[1]) / Math.max(dt, .008) + rope.winV[1] * .25];
  // The body follows the rope with a slight lag of its own.
  rope.phiV += ((rope.theta - rope.phi) * 200 - rope.phiV * 24) * dt;
  rope.phi = rope.phi + rope.phiV * dt;
}
// Keep the rope top where the hanging figure can fit inside the window at all.
function ropeTopAt(clientX, clientY) {
  const left = (512 - figureBox[0]) * S, right = (figureBox[2] - 512) * S;
  const lo = Math.min(150, left + 1), hi = Math.max(150, 300 - right - 1);
  return [clamp(clientX / innerWidth * 300, lo, hi), clamp(clientY / innerHeight * 450, 4, ROPE_TOP_Y + 6)];
}
function fitsAt(theta) {
  const end = [rope.top[0] - Math.sin(theta) * rope.r, rope.top[1] + Math.cos(theta) * rope.r];
  const m = affine(centerFrom(theta, attachCanvas(), end));
  const [x0, y0, x1, y1] = figureBox;
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const lx = m[0] * x + m[2] * y + m[4], ly = m[1] * x + m[3] * y + m[5];
    if (lx < 0 || lx > 300 || ly > 450) return false;
  }
  return true;
}
function hangTarget() {
  return centerFrom(rope.phi, attachCanvas(), rope.end);
}
function drawRope() {
  if (rope.alpha < .02) return;
  const [tx, ty] = rope.top;
  const [ex, ey] = toLogical(attachCanvas());
  const dist = Math.hypot(ex - tx, ey - ty);
  const slack = Math.max(0, rope.len - dist) * 1.6;
  // control point: sags with slack, trails behind the motion
  const mx = (tx + ex) / 2 - rope.vel[0] * .012, my = (ty + ey) / 2 + slack * .9 - rope.vel[1] * .006;
  octx.save();
  octx.globalAlpha = rope.alpha;
  octx.lineCap = 'round';
  octx.strokeStyle = '#2d2a2e'; octx.lineWidth = 2.6;
  octx.beginPath(); octx.moveTo(tx, ty); octx.quadraticCurveTo(mx, my, ex, ey); octx.stroke();
  octx.strokeStyle = '#d9b46b'; octx.lineWidth = 1.1;
  octx.beginPath(); octx.moveTo(tx, ty); octx.quadraticCurveTo(mx, my, ex, ey); octx.stroke();
  octx.fillStyle = '#2d2a2e';
  octx.beginPath(); octx.arc(ex, ey, 2.4, 0, Math.PI * 2); octx.fill();
  octx.strokeStyle = '#2d2a2e'; octx.lineWidth = 1.8;
  octx.beginPath(); octx.arc(tx, ty, 3.6, 0, Math.PI * 2); octx.stroke();
  octx.restore();
}
function blinkAmount(time, calm) {
  if (time >= nextBlink) {
    blinkStart = time;
    doubleBlink = !doubleBlink && Math.random() < .18;
    nextBlink = time + (doubleBlink ? .32 : 2.4 + Math.random() * 3.8);
  }
  const t = time - blinkStart;
  if (t < 0 || t > .2) return 1;
  const closing = t < .07 ? t / .07 : 1 - (t - .07) / .13;
  return calm ? 1 - clamp(closing, 0, 1) : 1 - ease(clamp(closing, 0, 1));
}

// ---------------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------------
function pose(time, dt, calm, interaction, idleLean, direction, peek) {
  const live = calm ? 0 : 1;
  const now = performance.now();
  const body = document.body.classList;
  const held = motion.dragging;
  if (now > moodUntil) mood = '';
  // Idle: slow glances, sway and breath.
  let ax = live * (6 * Math.sin(time * .37) + 3 * Math.sin(time * .91 + 1.3));
  let ay = live * (3 * Math.sin(time * .53 + .4) - 1);
  let az = live * (3 * Math.sin(time * .29 + 2) + 12 * idleLean);
  let bx = live * 1.6 * Math.sin(time * .31 + .7);
  let bz = live * (1.2 * Math.sin(time * .23) + 3 * idleLean);
  let by = 0;
  let eyeX = live * .25 * Math.sin(time * .41), eyeY = 0;
  const breath = calm ? 0 : .5 + .5 * Math.sin(time * Math.PI * 2 / (dozing ? 5.2 : 3.6));
  if (dozing && !held) { ax *= .1; ay *= .1; az *= .1; bx *= .1; bz *= .1; eyeX = 0; }
  // Docked: look into the screen, peek further out now and then.
  if (direction === 'bottom') { ay += 6 + 6 * peek; }
  else if (direction === 'left' || direction === 'right') {
    const s = direction === 'left' ? 1 : -1;
    ax = ax * .5 + 14 * s; eyeX = .5 * s; az += 4 * s;
  } else if (direction !== 'free') { ay += 4 * peek; }
  // Follow the cursor while it moves over the window, then drift back. The head turns a little;
  // the eyes do most of the looking.
  const engaged = clamp(1 - (now - focus.at - 1600) / 900, 0, 1) * live * (held || dozing || !prefs.follow ? 0 : 1);
  const flip = 1;
  if (engaged > 0) {
    // focus is in screen space; turn it into the (possibly rotated) model's own frame
    const rr = direction === 'free' ? 0 : DOCKS[direction].lean;
    const fx = focus.x * Math.cos(rr) - focus.y * Math.sin(rr), fy = focus.x * Math.sin(rr) + focus.y * Math.cos(rr);
    ax = ax * (1 - engaged) + 13 * fx * flip * engaged;
    ay = ay * (1 - engaged) + 11 * fy * flip * engaged;
    eyeX = eyeX * (1 - engaged) + .95 * fx * flip * engaged;
    eyeY = eyeY * (1 - engaged) + .8 * fy * flip * engaged;
    bx += 2 * focus.x * flip * engaged;
  }
  // Moods from the task state and recent reactions.
  let browY = 0, mouthForm = 0, mouthOpen = 1, eyeSmile = 0, eyeOpen = 1;
  if (body.contains('approval')) { browY = .75; az += 6 * live; }
  else if (body.contains('working')) { browY = -.25; eyeOpen = .9; }
  if (mood === 'happy') { eyeSmile = 1; eyeOpen = 0; mouthForm = 1; }
  if (mood === 'sad') { browY = -.8; mouthForm = -.8; mouthOpen = .25; az -= 5 * live; }
  // Expression face: one at a time, by priority.
  const busy = body.contains('working') || body.contains('approval');
  if (busy) lastActivity = Math.max(lastActivity, now - 1000);
  if (prefs.sleep && !held && !busy && now - lastActivity > prefs.sleepMinutes * 60000) dozing = true;
  if (dozing && (busy || held || !prefs.sleep)) dozing = false;
  const limp = false; // held still: stays awake, arms just dangle
  const active = pinch.side ? 'wince' : now < timers.dizzy ? 'dizzy' : now < timers.startled ? 'startled'
    : limp ? 'sleepy' : now < timers.sulky ? 'sulky' : dozing ? 'sleepy' : '';
  const fade = 1 - Math.exp(-dt * (active === 'startled' || active === 'wince' ? 34 : 18));
  for (const key of Object.keys(expr)) expr[key] = smooth(expr[key], key === active ? 1 : 0, calm ? 1 : fade);
  let armBias = 0, armBend = 0;
  if (active === 'startled') { by -= 4 * expr.startled; armBias += 7; ax *= .3; }
  if (active === 'sulky') { ax = -16 * expr.sulky + ax * (1 - expr.sulky); az -= 6 * expr.sulky; armBias -= 5; armBend += 7; eyeX = -.6; }
  if (active === 'dizzy') {
    const w = time * 4.6;
    az += 10 * Math.sin(w) * expr.dizzy * live; ax += 8 * Math.cos(w) * expr.dizzy * live; bz += 3 * Math.sin(w * .5) * live;
  }
  if (active === 'sleepy') {
    const z = expr.sleepy;
    if (limp) { ay = -14 * z + ay * (1 - z); az += 8 * z * live; armBias -= 9; armBend -= 6; }
    else {
      // Asleep: no glancing, swaying or cursor following; a slow nod in time with deep, slow breaths.
      const nod = .5 + .5 * Math.sin(time * Math.PI * 2 / 5.2);
      ax *= 1 - z; bx *= 1 - z; bz *= 1 - z; eyeX *= 1 - z; eyeY *= 1 - z;
      ay = -16 * z - 5 * nod * z * live + ay * (1 - z);
      az = 7 * z + az * (1 - z);
      armBias -= 2;
    }
  }
  const pinchSide = pinch.side || pinch.last;
  const px = calm ? 0 : pinch.springX.step(pinch.side ? pinch.x : 0, dt);
  const py = calm ? 0 : pinch.springY.step(pinch.side ? pinch.y : 0, dt);
  if (pinch.side) { az += (pinch.side === 'L' ? -6 : 6) * Math.min(1, Math.hypot(pinch.x, pinch.y)); }
  // Waving both hands after a few quick clicks (eases in and out).
  // One hand comes up beside the face (ease-out), waves from the elbow, then lowers; head and body lean in.
  const waveT = (now - waveStart) / 1000;
  const waveLeft = (waveUntil - now) / 1000;
  const waving = now < waveUntil && !held && direction === 'free' ? ease(clamp(Math.min(waveT / .32, waveLeft / .38), 0, 1)) : 0;
  const waveAmp = clamp((waveT - .22) / .2, 0, 1) * clamp(waveLeft / .5, 0, 1);
  const wavePhase = Math.sin((waveT - .22) * 14.5) * waveAmp;
  const waveDir = waveSide === 'L' ? 1 : -1; // L = image right hand
  if (waving > 0) {
    eyeSmile = Math.max(eyeSmile, waving); eyeOpen = Math.min(eyeOpen, 1 - waving); mouthForm = Math.max(mouthForm, waving);
    az += -7 * waveDir * waving + 2 * wavePhase * waving; bz += -2 * waveDir * waving; ax += 6 * waveDir * waving;
  }
  // Hanging from the rope: the head lags the body's swing, eyes follow the travel, limbs and clothes trail.
  const swingRate = held ? rope.omega : 0;
  const travel = held ? rope.vel : [0, 0];
  const headLag = calm ? spring.headLag.settle(0) : spring.headLag.step(clamp(-swingRate * 4, -12, 12), dt);
  if (held) {
    az += headLag;
    ax = ax * .4 + clamp(travel[0] / 90, -10, 10);
    eyeX = clamp(travel[0] / 700, -.9, .9) * (active === 'sleepy' ? 0 : 1);
    eyeY = clamp(-travel[1] / 900, -.6, .6);
  }
  const dangle = calm ? spring.dangle.settle(0) : spring.dangle.step(held ? 1 : 0, dt);
  const kickX = clamp(-travel[0] / 500 - swingRate * .35, -1.5, 1.5);
  const legL = calm ? spring.legL.settle(0) : spring.legL.step(held ? kickX * .9 + rope.phi * .5 : 0, dt);
  const legR = calm ? spring.legR.settle(0) : spring.legR.step(held ? kickX * .75 + rope.phi * .5 : 0, dt);
  const cloth = calm ? spring.cloth.settle(0) : spring.cloth.step((held ? kickX * .9 : 0) - spring.lean.x * .6, dt);
  // Window motion while not held (settling into a dock): lean against the movement.
  const vx = held ? 0 : clamp(motion.vx, -2600, 2600), vy = held ? 0 : clamp(motion.vy, -2600, 2600);
  const lean = calm ? spring.lean.settle(0) : spring.lean.step(clamp(-vx * .0042, -1, 1), dt);
  bz += 7 * lean; az += 10 * lean;
  const arms = calm ? spring.arms.settle(0) : spring.arms.step(clamp(Math.abs(vx) * .0035 + Math.abs(vy) * .002, 0, 1), dt);
  // Tap: a happy hop with smiling eyes.
  if (interaction > 0) {
    eyeSmile = Math.max(eyeSmile, interaction > .15 ? 1 : interaction / .15);
    eyeOpen = Math.min(eyeOpen, 1 - eyeSmile);
    mouthForm = Math.max(mouthForm, interaction);
    if (direction === 'free') by = -7 * Math.sin(interaction * Math.PI);
    az += 8 * interaction * live;
  }
  // Speech: lip flaps while a new bubble pops up.
  if (now < talkUntil && !calm) {
    const p = time * 13;
    mouthOpen = clamp(.2 + .8 * Math.abs(Math.sin(p) * Math.sin(p * .53 + 1.1)), .15, 1);
  }
  eyeOpen *= blinkAmount(time, calm);
  // Smooth the gaze so focus changes never snap.
  const k = calm ? 1 : 1 - Math.exp(-dt * 6);
  view.ax = smooth(view.ax, ax, k); view.ay = smooth(view.ay, ay, k);
  view.eyeX = smooth(view.eyeX, eyeX, 1 - Math.exp(-dt * 12)); view.eyeY = smooth(view.eyeY, eyeY, 1 - Math.exp(-dt * 12));
  // Secondary motion: hair and ears trail the body's swing and the travel through the air.
  const swing = (held ? rope.phi * 1.2 + swingRate * .35 + travel[0] / 900 : 0)
    + (az / 30) * .8 + (bz / 10) * .5 + (view.ax / 30) * .3 + bx / 10 * .25 + clamp(vx / 1100, -1, 1) * .9;
  const lift = clamp((held ? travel[1] : vy) / 1400, -1, 1);
  const hairFront = calm ? spring.hairFront.settle(0) : spring.hairFront.step(-swing * .8, dt);
  const hairBack = calm ? spring.hairBack.settle(0) : spring.hairBack.step(-swing * .7, dt);
  const ahoge = calm ? spring.ahoge.settle(0) : spring.ahoge.step(-swing * 1.1 + lift * .5, dt);
  const earL = calm ? spring.earL.settle(0) : spring.earL.step(-swing * .7 - lift * .3, dt);
  const earR = calm ? spring.earR.settle(0) : spring.earR.step(-swing * .7 + lift * .3, dt);
  const armSwing = held ? clamp(-swingRate * 2.2 - travel[0] / 260, -7, 7) : 0;
  return {
    ParamAngleX: view.ax, ParamAngleY: view.ay, ParamAngleZ: az,
    ParamBodyAngleX: bx, ParamBodyAngleY: by, ParamBodyAngleZ: bz, ParamBreath: breath,
    ParamEyeLOpen: eyeOpen, ParamEyeROpen: eyeOpen, ParamEyeLSmile: eyeSmile, ParamEyeRSmile: eyeSmile,
    ParamEyeBallX: view.eyeX, ParamEyeBallY: view.eyeY, ParamBrowLY: browY, ParamBrowRY: browY,
    ParamMouthOpenY: mouthOpen, ParamMouthForm: mouthForm,
    ParamArmLA: 6 * arms + 5 * interaction + armBias - 3 * dangle + armSwing,
    ParamArmRA: 6 * arms + 5 * interaction + armBias - 3 * dangle - armSwing,
    ParamArmLB: 3 * arms + armBend + 2 * dangle, ParamArmRB: 3 * arms + armBend + 2 * dangle,
    ParamArmLRaise: waveSide === 'L' ? waving : 0, ParamArmRRaise: waveSide === 'R' ? waving : 0,
    ParamArmLWave: waveSide === 'L' ? waving * wavePhase : 0, ParamArmRWave: waveSide === 'R' ? -waving * wavePhase : 0,
    ParamLegL: clamp(legL, -1, 1), ParamLegR: clamp(legR, -1, 1), ParamClothSway: clamp(cloth, -1, 1),
    ParamExpStartled: expr.startled, ParamExpSulky: expr.sulky, ParamExpDizzy: expr.dizzy,
    ParamExpSleepy: expr.sleepy, ParamExpWince: expr.wince,
    ParamPinchLX: pinchSide === 'L' ? clamp(px, -1, 1) : 0, ParamPinchLY: pinchSide === 'L' ? clamp(py, -1, 1) : 0,
    ParamPinchRX: pinchSide === 'R' ? clamp(px, -1, 1) : 0, ParamPinchRY: pinchSide === 'R' ? clamp(py, -1, 1) : 0,
    ParamHairFront: clamp(hairFront, -1, 1), ParamHairBack: clamp(hairBack, -1, 1), ParamHairAhoge: clamp(ahoge, -1, 1),
    ParamEarPandaL: clamp(earL, -1, 1), ParamEarPandaR: clamp(earR, -1, 1),
  };
}

// ---------------------------------------------------------------------------------------------------
// Interaction entry points (called from pet.js)
// ---------------------------------------------------------------------------------------------------
function wake(now = performance.now()) {
  if (dozing) { dozing = false; timers.startled = now + 650; }
  lastActivity = now;
}
function triggerPetInteraction() {
  const now = performance.now();
  wake(now);
  clicks = clicks.filter(t => now - t < 4000);
  clicks.push(now);
  if (prefs.sulky && clicks.length >= 7) { timers.sulky = now + 3600; waveUntil = 0; clicks = []; return; }  // too much: sulks
  if (prefs.wave && clicks.filter(t => now - t < 2000).length >= 3) {  // a few quick clicks: waves hello
    if (now > waveUntil) { waveStart = now; waveSide = Math.random() < .7 ? 'L' : 'R'; }
    waveUntil = Math.max(waveUntil, now + 2000);
  }
  if (now < timers.sulky) return;
  interactionAt = now;
}
function cheekAt(clientX, clientY) {
  if (!puppet || motion.dragging || !prefs.pinch) return null;
  const x = clientX / innerWidth * 300, y = clientY / innerHeight * 450;
  for (const side of ['L', 'R']) {
    const [lx, ly] = toLogical(LAYOUT[`cheek${side}`]);
    if (Math.hypot(x - lx, y - ly) < 12) return side;
  }
  return null;
}
function petGrab(clientX, clientY) {
  rope.top = ropeTopAt(clientX, clientY);
}
function petPinchStart(side) { pinch.side = side; pinch.x = pinch.y = 0; wake(); }
function petPinchMove(dx, dy) {
  if (!pinch.side) return;
  pinch.x = clamp(dx / innerWidth * 300 / 9, -1, 1);
  pinch.y = clamp(dy / innerHeight * 450 / 9, -1, 1);
}
function petPinchEnd() {
  if (!pinch.side) return;
  pinch.last = pinch.side; pinch.side = null;
  if (prefs.sulky) timers.sulky = Math.max(timers.sulky, performance.now() + 1800);  // pouts a little after a pinch
}
function petTalk(ms = 1300) { talkUntil = Math.max(talkUntil, performance.now() + ms); }
function petReact(kind) {
  const now = performance.now();
  wake(now);
  if (kind === 'completed') { mood = 'happy'; moodUntil = now + 1700; }
  else if (kind === 'failed' || kind === 'interrupted') { mood = 'sad'; moodUntil = now + 2600; }
  petTalk(kind === 'completed' ? 1500 : 1200);
}
function updatePetPose(next) {
  const now = performance.now();
  if (next.dragging && !motion.dragging) {
    dragStartAt = now; timers.startled = now + 700; swings = []; wake(now);
    startRope();
  }
  if (!next.dragging && motion.dragging) place.landPending = true;
  if (next.dragging) {
    lastActivity = now;
    const sign = Math.abs(next.vx) > 700 ? Math.sign(next.vx) : 0;
    if (sign && sign !== lastSwingSign) { swings.push(now); lastSwingSign = sign; }
    swings = swings.filter(t => now - t < 1400);
    if (prefs.dizzy && swings.length >= 4) timers.dizzy = now + 3200;  // shaken back and forth: dizzy
  }
  motion = next;
  const [dockDirection, corner] = next.edge.split('-');
  document.body.dataset.edge = dockDirection; document.body.dataset.corner = corner || '';
}

function fit(target) {
  const width = Math.round(innerWidth * devicePixelRatio), height = Math.round(innerHeight * devicePixelRatio);
  if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
}

// Idle peeking rhythm while docked: every ~8 s lean out for a look around.
function dockPeek(time, now) {
  const cycle = time % 8.5;
  const idle = cycle > 5.2 && cycle < 7.4 ? Math.sin(Math.PI * (cycle - 5.2) / 2.2) : 0;
  const hover = clamp(1 - (now - focus.at - 900) / 600, 0, 1);
  return Math.max(idle * .8, hover);
}

function drawFrame(now) {
  const dt = Math.min(.035, (now - (last || now)) / 1000); last = now;
  const calm = reducedMotion.matches, time = calm ? 0 : now / 1000;
  const [direction, corner] = motion.edge.split('-');
  const docked = Boolean(DOCKS[direction]) && !motion.dragging;
  const elapsed = now - interactionAt;
  const interaction = elapsed < 1100 ? Math.max(0, Math.sin(Math.PI * elapsed / 1100)) : 0;
  const idlePhase = time % 18;
  const idleLean = calm || motion.dragging || docked ? 0 : idlePhase > 9.4 && idlePhase < 11.4 ? Math.sin(Math.PI * (idlePhase - 9.4) / 2) : 0;
  const peek = calm ? 0 : spring.peek.step(docked ? dockPeek(time, now) : 0, dt);
  fit(canvas); fit(overlay);
  octx.setTransform(overlay.width / 300, 0, 0, overlay.height / 450, 0, 0); octx.clearRect(0, 0, 300, 450);
  stepRope(dt, calm);

  // Target placement for the current state, eased in from the previous one.
  const state = motion.dragging ? 'hang' : docked ? `dock-${motion.edge}` : 'free';
  if (state !== place.state) { place.from = { ...place.current }; place.t = 0; place.state = state; }
  place.t = Math.min(1, place.t + dt / (state === 'hang' ? .18 : .26));
  const land = calm ? spring.land.settle(0) : spring.land.step(0, dt);
  let target;
  if (state === 'hang') target = hangTarget();
  else if (docked) target = dockTarget(direction, corner, peek, interaction);
  else {
    const tilt = calm ? 0 : clamp(spring.lean.x * .05, -.05, .05);
    const sy = 1 - land, sx = 1 + land * .6;
    target = centerFrom(tilt, [512, 1530], [150, 100 + 1530 * S - interaction * 8], sx, sy);
  }
  if (place.landPending && place.t > .7 && state === 'free') { spring.land.v += 1.5; place.landPending = false; }
  if (state !== 'free') place.landPending = place.landPending && state === 'hang';
  const e = ease(place.t), from = place.from || target;
  place.current = place.t >= 1 ? target : {
    r: from.r + wrapAngle(target.r - from.r) * e, x: lerp(from.x, target.x, e), y: lerp(from.y, target.y, e),
    sx: lerp(from.sx ?? 1, target.sx ?? 1, e), sy: lerp(from.sy ?? 1, target.sy ?? 1, e),
  };
  xform = affine(place.current);

  if (puppet) {
    const params = pose(now / 1000, dt, calm, interaction, idleLean, docked ? direction : 'free', peek);
    const gl = puppet.gl;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    for (const [id, value] of Object.entries(params)) puppet.set(id, value);
    puppet.draw(toClip(xform), 1);
    gl.disable(gl.SCISSOR_TEST);
    if (++frameCount % 6 === 0) {
      canvas.dataset.params = [params.ParamAngleX, params.ParamAngleZ, params.ParamHairFront, params.ParamBreath]
        .map(value => value.toFixed(3)).join(',');
      canvas.dataset.state = state;
    }
  } else if (puppetError && artwork.naturalWidth) {
    octx.drawImage(artwork, 47, 100, 206, 310);
  }
  if (docked && (direction === 'top' || direction === 'bottom')) drawDockBar(direction, corner, e, peek);
  drawRope();
  if (interaction > .05 && !motion.dragging) {
    const [ax1, ay1] = toLogical(LAYOUT.sparkA), [ax2, ay2] = toLogical(LAYOUT.sparkB);
    drawSpark(ax1, ay1, 4.8, interaction, 1.6);
    drawSpark(ax2, ay2, 3.4, interaction * .8, 1.4);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) { last = now; return; }
  drawFrame(now);
}
requestAnimationFrame(frame);

// Test/diagnostic hook: lowest painted row of the figure in CSS px (reads the WebGL buffer right after a draw).
window.__petRig = {
  paintedBottom() {
    if (!puppet) return null;
    drawFrame(performance.now());
    const gl = puppet.gl, w = canvas.width, h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let row = 0; row < h; row++) {  // readPixels rows start at the bottom
      for (let x = 0; x < w; x++) if (pixels[(row * w + x) * 4 + 3] > 12) return (h - row) * canvas.getBoundingClientRect().height / h;
    }
    return 0;
  },
};
