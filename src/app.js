/* ===== Gaitworks app: editor, evolution loop, rendering, persistence ===== */
(() => {
'use strict';
const { clamp, TASKS, PRESETS } = Core;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";
const MAX_NODES = 16, MAX_BONES = 30, MAX_MUSCLES = 24;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------------- state ---------------- */
const S = {
  task: 'run', tab: 'body', preset: 'crawler',
  def: clone(PRESETS.crawler.def),
  brain: { hidden: [12, 8], act: 'tanh', clock: true, hz: 1.5, memory: false, stuck: true },
  dur: {}, phys: { mdamp: 0 },
  evo: { pop: 48, elite: 4, mut: 0.08, sigma: 0.3, cross: 0.5, fresh: 4, tourney: 3, adapt: true, opt: 'cma', restart: true },
};
let net = null, dimsNow = null, lastSig = '';
const DUR0 = {};
for (const k of Object.keys(TASKS)) DUR0[k] = TASKS[k].duration;
function applyPhys() { Core.PHYS.mdamp = S.phys ? S.phys.mdamp : 0; }
function applyDurations() { for (const k of Object.keys(TASKS)) TASKS[k].duration = (S.dur && S.dur[k]) || DUR0[k]; }
let cmaWanted = null;
const Evo = {
  cma: null,
  gen: 0, pop: [], scores: new Float64Array(0), metrics: new Float64Array(0), idx: 0,
  running: false, until: Infinity, turbo: false, history: [], best: null, top: [],
  statsDirty: true, chartDirty: true,
  arch: Core.archiveNew(), descs: [], restarts: 0, runStart: 0,
};
const Replay = { sims: [], labels: [], mode: 'top', speed: 1, acc: 0, holdT: 0, camX: 0, refresh: true, random: true };
const Ed = { tool: 'select', sel: null, pending: null, hover: null, drag: null, undo: [], ptr: [0, 0] };
const canEvolve = () => S.def.muscles.length >= 1 && S.def.nodes.length >= 2;
const mode = () => (S.tab === 'body' ? 'edit' : 'sim');

/* ---------------- palette & canvas ---------------- */
let P = {};
function hex(c) {
  c = (c || '').trim();
  if (c[0] !== '#') return [128, 128, 128];
  if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  P = {
    stage: g('--stage'), grid: g('--grid'), grid2: g('--grid-2'), ground: g('--ground'), groundTop: g('--ground-top'),
    bone: g('--bone'), joint: g('--joint'), muscle: g('--muscle'), muscleLo: g('--muscle-lo'), ink: g('--ink'), ink2: g('--ink-2'),
    accent: g('--accent'), pos: g('--pos'), neg: g('--neg'), line: g('--line'),
    mC: hex(g('--muscle')), mL: hex(g('--muscle-lo')),
  };
}
const mix = (a, b, t) => `rgb(${(a[0] + (b[0] - a[0]) * t) | 0},${(a[1] + (b[1] - a[1]) * t) | 0},${(a[2] + (b[2] - a[2]) * t) | 0})`;

const cv = $('#cv'), ctx = cv.getContext('2d');
let W = 300, H = 300, dpr = 1;
function resize() {
  const r = $('#wrap').getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = Math.max(100, Math.floor(r.width)); H = Math.max(100, Math.floor(r.height));
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
}
function fitCanvas(c) {
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  const d = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
  const g = c.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  return { g, w, h };
}

/* ---------------- toast ---------------- */
let toastT = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------------- population & evolution ---------------- */
function rebuildNet() { dimsNow = Core.dims(S.def, S.brain); net = Core.makeNet(S.brain, dimsNow); }
function resetPopulation() {
  rebuildNet();
  const n = S.evo.pop;
  Evo.cma = null;
  if (S.evo.opt === 'cma') { Evo.cma = Core.cmaInit(net, n, null, 0.3); Evo.pop = Core.cmaSample(Evo.cma); }
  else Evo.pop = Array.from({ length: n }, () => Core.randomGenome(net));
  Evo.scores = new Float64Array(n); Evo.metrics = new Float64Array(n); Evo.idx = 0;
  Evo.gen = 0; Evo.history = []; Evo.best = null; Evo.top = []; Evo.lastGain = null; Evo.stall = 0; Evo.boost = 1;
  Evo.arch = Core.archiveNew(); Evo.descs = []; Evo.restarts = 0; Evo.runStart = 0; Replay.pick = null;
  Evo.running = false; Evo.until = Infinity;
  Replay.refresh = true; Evo.statsDirty = Evo.chartDirty = true;
}
function fillFromTops(tops) {
  const n = S.evo.pop, pop = tops.slice(0, n);
  while (pop.length < n) {
    const c = Float32Array.from(tops[Math.floor(Math.random() * tops.length)]);
    Core.mutate(c, S.evo.mut, S.evo.sigma);
    pop.push(c);
  }
  return pop;
}
function invalidateScores() { Evo.lastGain = Evo.gen; Evo.gainScore = -Infinity; Evo.stall = 0; Evo.idx = 0; Replay.refresh = true; Evo.statsDirty = true; }

function evoTick(budget) {
  if (!Evo.running || !canEvolve()) return;
  const t0 = performance.now();
  while (Evo.running && performance.now() - t0 < budget) {
    const r = Core.evaluate(S.def, S.task, Evo.pop[Evo.idx], net);
    Evo.scores[Evo.idx] = Number.isFinite(r.score) ? r.score : -5;
    Evo.metrics[Evo.idx] = Number.isFinite(r.metric) ? r.metric : 0;
    Evo.descs[Evo.idx] = r.desc;
    Evo.idx++;
    if (Evo.idx >= Evo.pop.length) {
      finishGeneration();
      if (Evo.gen >= Evo.until) { Evo.running = false; Evo.until = Infinity; updateRunBtn(); }
    }
  }
  Evo.statsDirty = true;
}
const RESTART_STALL = 20, RESTART_MIN = 25;
/* Alternating restarts: odd ones start from a random brain with a larger population (IPOP) to find a new basin;
   even ones branch from a random elite in the gait archive with a small step to refine a different style. Returns the new population. */
function autoRestart() {
  Evo.restarts++;
  const n = S.evo.pop, fromArch = Evo.restarts % 2 === 0 ? Core.archivePick(Evo.arch) : null;
  const lam = fromArch ? n : Math.min(n * 3, Math.round(n * Math.pow(1.5, Math.ceil(Evo.restarts / 2))));
  Evo.cma = Core.cmaInit(net, lam, fromArch ? fromArch.g : null, fromArch ? 0.15 : 0.3);
  Evo.lastGain = Evo.gen + 1; Evo.gainScore = -Infinity; Evo.stall = 0; Evo.boost = Evo.cma.sig; Evo.runStart = Evo.gen + 1;
  toast('Restart ' + Evo.restarts + ': ' + (fromArch ? 'branching from a stored gait' : 'fresh random brain, ' + lam + ' creatures') + '. Old champions stay in the gallery.');
  return Core.cmaSample(Evo.cma);
}
function finishGeneration() {
  const n = Evo.pop.length;
  if (Evo.lastGain == null) { Evo.lastGain = Evo.gen; Evo.gainScore = -Infinity; }
  let hi = -Infinity, bi0 = 0;
  for (let i = 0; i < n; i++) if (Evo.scores[i] > hi) { hi = Evo.scores[i]; bi0 = i; }
  if (hi > Evo.gainScore + 0.01 * Math.max(1, Math.abs(Evo.gainScore)) || !Number.isFinite(Evo.gainScore)) { Evo.gainScore = hi; Evo.lastGain = Evo.gen; }
  Evo.stall = Evo.gen - Evo.lastGain;
  for (let i = 0; i < n; i++) Core.archiveAdd(Evo.arch, Evo.pop[i], Evo.scores[i], Evo.metrics[i], Evo.descs[i], Evo.gen);
  let next, order;
  if (Evo.cma && S.evo.opt === 'cma') {
    order = Core.cmaUpdate(Evo.cma, Evo.scores); next = Core.cmaSample(Evo.cma); Evo.boost = Evo.cma.sig;
    /* a single Gaussian collapses onto one gait: when it stalls or its step size dies, start a new run */
    const age = Evo.gen - Evo.runStart;
    if (S.evo.restart !== false && ((Evo.stall >= RESTART_STALL && age >= RESTART_MIN) || (Evo.cma.sig < 0.004 && age >= 15))) next = autoRestart();
  } else {
    const br = Core.breed(Evo.pop, Evo.scores, { ...S.evo, stall: Evo.stall }, net);
    next = br.next; order = br.order; Evo.boost = br.boost;
  }
  const bi = order[0];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Evo.scores[i];
  Evo.history.push({ g: Evo.gen, b: Evo.scores[bi], m: sum / n, mt: Evo.metrics[bi] });
  if (Evo.history.length > 600) Evo.history.splice(0, Evo.history.length - 600);
  if (!Evo.best || Evo.scores[bi] > Evo.best.score) {
    Evo.best = { score: Evo.scores[bi], metric: Evo.metrics[bi], gen: Evo.gen, g: Float32Array.from(Evo.pop[bi]) };
  }
  Evo.top = order.slice(0, 16).map((i) => Evo.pop[i]);
  Evo.pop = next;
  Evo.scores = new Float64Array(next.length); Evo.metrics = new Float64Array(next.length);
  Evo.idx = 0; Evo.gen++;
  if (Replay.random) startReplay(); else Replay.refresh = true;
  Evo.statsDirty = Evo.chartDirty = true;
  saveSoon();
}

/* ---------------- replay ---------------- */
function startReplay() {
  Replay.refresh = false; Replay.acc = 0; Replay.holdT = 0; Replay.camX = 0; Replay.camY = 0;
  if (!canEvolve() || !Evo.pop.length) { Replay.sims = []; Replay.labels = []; updateSimInfo(); return; }
  let list;
  const champ = Replay.mode === 'champ' && Evo.best;
  if (Replay.pick) list = [Replay.pick];
  else if (champ) list = [{ g: Evo.best.g, label: 'champion · gen ' + Evo.best.gen }];
  else if (Evo.top.length) list = Evo.top.slice(0, 10).map((g, i) => ({ g, label: '#' + (i + 1) }));
  else list = Evo.pop.slice(0, 3).map((g) => ({ g, label: 'untrained' }));
  Replay.random = !(Replay.pick || champ || Evo.top.length);
  Replay.variant = (Replay.variant || 0) + 1;
  Replay.sims = list.map((o) => Core.makeSim(S.def, S.task, o.g, S.brain, dimsNow, Replay.variant));
  Replay.labels = list.map((o) => o.label);
  updateSimInfo();
}
function stepReplay(dt) {
  if (!Replay.sims.length) return;
  Replay.acc += dt * Replay.speed;
  let guard = 0;
  while (Replay.acc >= Core.DT && guard++ < 40) {
    Replay.acc -= Core.DT;
    let any = false;
    for (const s of Replay.sims) if (!s.done) { Core.stepSim(s, net); any = true; }
    if (!any) {
      Replay.holdT += Core.DT;
      if (Replay.holdT > 1.1) { startReplay(); return; }
    }
  }
  if (Replay.refresh && Replay.sims.every((s) => s.done) && Replay.holdT > 0.6) startReplay();
  let tx = 0;
  if (S.task === 'jump') tx = Replay.sims[0].cx;
  else for (const s of Replay.sims) tx = Math.max(tx, s.cx);
  Replay.camX += (tx - Replay.camX) * Math.min(1, dt * 4);
  let ty = 0;
  if (S.task === 'stairs') { let bx = -1e9; for (const s of Replay.sims) if (s.cx > bx) { bx = s.cx; ty = s.cy; } }
  Replay.camY = (Replay.camY || 0) + (Math.max(0, ty - 2.0) - (Replay.camY || 0)) * Math.min(1, dt * 3);
}
function updateSimInfo() {
  const e = $('#simInfo');
  if (!canEvolve()) e.textContent = 'Add a muscle on the Body tab';
  else if (Replay.random) e.textContent = 'Untrained brains. Press Evolve.';
  else if (Replay.mode === 'champ') e.textContent = 'Best of all generations';
  else e.textContent = 'Top ten of generation ' + Evo.gen;
}

/* ---------------- editor ---------------- */
const snap = (v) => Math.round(v / 0.05) * 0.05;
const round2 = (v) => Math.round(v * 100) / 100;
const ptOf = (d, i, k) => {
  if (!k) return [d.nodes[i].x, d.nodes[i].y];
  const b = d.bones[i], p = d.nodes[b.a], q = d.nodes[b.b];
  return [(p.x + q.x) / 2, (p.y + q.y) / 2];
};
const muscleSeg = (d, m) => { const p = ptOf(d, m.a, m.ak), q = ptOf(d, m.b, m.bk); return [p[0], p[1], q[0], q[1]]; };
const EPT = new Float64Array(4);
function edView() {
  const sc = Math.min(W / 4.6, (H * 0.84) / 2.4);
  return { sc, ox: W / 2, gy: H * 0.88 };
}
const e2s = (v, x, y) => [v.ox + x * v.sc, v.gy - y * v.sc];
const s2e = (v, px, py) => [(px - v.ox) / v.sc, (v.gy - py) / v.sc];
function pushUndo() { Ed.undo.push(JSON.stringify(S.def)); if (Ed.undo.length > 60) Ed.undo.shift(); }
function doUndo() {
  const s = Ed.undo.pop();
  if (!s) { toast('Nothing to undo.'); return; }
  S.def = JSON.parse(s); Ed.sel = null; Ed.pending = null; bodyChanged();
}
function bodyChanged() {
  S.preset = 'custom';
  const sig = Core.topoSig(S.def);
  if (sig !== lastSig) {
    lastSig = sig;
    const had = Evo.gen > 0 || Evo.best;
    resetPopulation(); updateRunBtn();
    if (had) toast('The body changed, so the brain starts over. Snapshots are untouched.');
  } else invalidateScores();
  paramChanged();
  renderInspector();
}
function paramChanged() {
  S.preset = 'custom';
  invalidateScores(); renderFacts(); syncPreset(); saveSoon();
}
function hitNode(px, py) {
  const v = edView();
  let best = -1, bd = 1e9;
  S.def.nodes.forEach((n, i) => {
    const [sx, sy] = e2s(v, n.x, n.y);
    const d = Math.hypot(sx - px, sy - py);
    const rad = Math.max(15, Core.nodeRadius(n.m) * v.sc + 6);
    if (d <= rad && d < bd) { bd = d; best = i; }
  });
  return best;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function hitLink(px, py) {
  const v = edView(), d = S.def;
  let best = null, bd = 10;
  d.muscles.forEach((m, i) => {
    const s = muscleSeg(d, m), p = e2s(v, s[0], s[1]), q = e2s(v, s[2], s[3]);
    const dist = segDist(px, py, p[0], p[1], q[0], q[1]);
    if (dist < bd) { bd = dist; best = { type: 'muscle', i }; }
  });
  d.bones.forEach((l, i) => {
    const p = e2s(v, d.nodes[l.a].x, d.nodes[l.a].y), q = e2s(v, d.nodes[l.b].x, d.nodes[l.b].y);
    const dist = segDist(px, py, p[0], p[1], q[0], q[1]);
    if (dist < bd) { bd = dist; best = { type: 'bone', i }; }
  });
  return best;
}
function hitBone(px, py) {
  const v = edView(), d = S.def;
  let best = -1, bd = 11;
  d.bones.forEach((l, i) => {
    const p = e2s(v, d.nodes[l.a].x, d.nodes[l.a].y), q = e2s(v, d.nodes[l.b].x, d.nodes[l.b].y);
    const dist = segDist(px, py, p[0], p[1], q[0], q[1]);
    if (dist < bd) { bd = dist; best = i; }
  });
  return best;
}
function addLink(type, A, B) {
  const d = S.def;
  if (type === 'bone') {
    const a = A.i, b = B.i, same = (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a);
    if (d.bones.some(same) || d.muscles.some((m) => !m.ak && !m.bk && same(m))) { toast('Those joints are already connected.'); return; }
    if (d.bones.length >= MAX_BONES) { toast('Bone limit reached (' + MAX_BONES + ').'); return; }
    pushUndo(); d.bones.push({ a, b, m: 1 }); Ed.sel = { type: 'bone', i: d.bones.length - 1 };
  } else {
    const own = (J, Bn) => !J.k && Bn.k && Core.endNodes(d, Bn.i, 1).includes(J.i);
    if ((A.k === B.k && A.i === B.i) || own(A, B) || own(B, A)) { toast('Pick two different anchors. A joint cannot pull on its own bone.'); return; }
    const same = (m, P1, P2) => m.a === P1.i && !!m.ak === !!P1.k && m.b === P2.i && !!m.bk === !!P2.k;
    if (d.muscles.some((m) => same(m, A, B) || same(m, B, A))) { toast('That muscle already exists.'); return; }
    if (!A.k && !B.k && d.bones.some((l) => (l.a === A.i && l.b === B.i) || (l.a === B.i && l.b === A.i))) { toast('Those joints are already connected.'); return; }
    if (d.muscles.length >= MAX_MUSCLES) { toast('Muscle limit reached (' + MAX_MUSCLES + ').'); return; }
    pushUndo(); d.muscles.push({ a: A.i, b: B.i, ak: A.k, bk: B.k, s: 0.55, r: 0.3 });
    Ed.sel = { type: 'muscle', i: d.muscles.length - 1 };
  }
  bodyChanged();
}
function remapMuscles(d, keep, mapNode, mapBone) {
  d.muscles = d.muscles.filter(keep).map((m) => ({ ...m, a: m.ak ? mapBone(m.a) : mapNode(m.a), b: m.bk ? mapBone(m.b) : mapNode(m.b) }));
}
function eraseNode(i) {
  pushUndo();
  const d = S.def, nm = (n) => (n > i ? n - 1 : n), boneMap = [];
  let c = 0;
  d.bones.forEach((b, bi) => { boneMap[bi] = b.a === i || b.b === i ? -1 : c++; });
  d.nodes.splice(i, 1);
  d.bones = d.bones.filter((b, bi) => boneMap[bi] >= 0).map((b) => ({ ...b, a: nm(b.a), b: nm(b.b) }));
  remapMuscles(d, (m) => (m.ak ? boneMap[m.a] >= 0 : m.a !== i) && (m.bk ? boneMap[m.b] >= 0 : m.b !== i), nm, (bi) => boneMap[bi]);
  Ed.sel = null; Ed.pending = null; bodyChanged();
}
function eraseLink(L) {
  pushUndo();
  const d = S.def;
  if (L.type === 'muscle') d.muscles.splice(L.i, 1);
  else {
    const i = L.i;
    d.bones.splice(i, 1);
    remapMuscles(d, (m) => !(m.ak && m.a === i) && !(m.bk && m.b === i), (n) => n, (bi) => (bi > i ? bi - 1 : bi));
  }
  Ed.sel = null; Ed.pending = null; bodyChanged();
}
function deleteSelection() {
  if (!Ed.sel) return;
  if (Ed.sel.type === 'node') eraseNode(Ed.sel.i); else eraseLink(Ed.sel);
}
const HINTS = {
  select: 'Drag joints · click to inspect',
  joint: 'Click empty space to add a joint',
  bone: 'Click two joints to join them with a rigid bone',
  muscle: 'Click a joint or a bone (its midpoint), then a second anchor',
  erase: 'Click a joint, bone or muscle to remove it',
};
function setTool(t) {
  Ed.tool = t; Ed.pending = null;
  $$('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  $('#hint').textContent = HINTS[t];
}
function ptr(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

cv.addEventListener('pointerdown', (e) => {
  if (mode() !== 'edit') return;
  cv.setPointerCapture(e.pointerId);
  const [px, py] = ptr(e); Ed.ptr = [px, py];
  const v = edView(), ni = hitNode(px, py), tool = Ed.tool;
  if (tool === 'select') {
    if (ni >= 0) { Ed.sel = { type: 'node', i: ni }; pushUndo(); Ed.drag = { i: ni, moved: false }; }
    else Ed.sel = hitLink(px, py);
    renderInspector();
  } else if (tool === 'joint') {
    if (ni >= 0) Ed.sel = { type: 'node', i: ni };
    else if (S.def.nodes.length >= MAX_NODES) toast('Joint limit reached (' + MAX_NODES + ').');
    else {
      pushUndo();
      const [wx, wy] = s2e(v, px, py);
      S.def.nodes.push({ x: round2(clamp(snap(wx), -2.2, 2.2)), y: round2(clamp(snap(wy), 0.06, 2.3)), m: 0.4, g: 0.8 });
      Ed.sel = { type: 'node', i: S.def.nodes.length - 1 };
      bodyChanged();
    }
    renderInspector();
  } else if (tool === 'bone' || tool === 'muscle') {
    let hit = ni >= 0 ? { k: 0, i: ni } : null;
    if (!hit && tool === 'muscle') { const bi = hitBone(px, py); if (bi >= 0) hit = { k: 1, i: bi }; }
    if (!hit) Ed.pending = null;
    else if (!Ed.pending) Ed.pending = hit;
    else if (Ed.pending.k === hit.k && Ed.pending.i === hit.i) Ed.pending = null;
    else { addLink(tool, Ed.pending, hit); Ed.pending = hit; }
  } else if (tool === 'erase') {
    if (ni >= 0) eraseNode(ni);
    else { const L = hitLink(px, py); if (L) eraseLink(L); }
  }
});
cv.addEventListener('pointermove', (e) => {
  if (mode() !== 'edit') return;
  const [px, py] = ptr(e); Ed.ptr = [px, py];
  if (Ed.drag) {
    const v = edView(), n = S.def.nodes[Ed.drag.i], [wx, wy] = s2e(v, px, py);
    const nx = round2(clamp(snap(wx), -2.2, 2.2)), ny = round2(clamp(snap(wy), 0.06, 2.3));
    if (nx !== n.x || ny !== n.y) { n.x = nx; n.y = ny; Ed.drag.moved = true; paramChanged(); renderInspector(); }
    return;
  }
  const ni = hitNode(px, py);
  Ed.hover = ni >= 0 ? { type: 'node', i: ni } : hitLink(px, py);
  cv.style.cursor = Ed.hover ? (Ed.tool === 'erase' ? 'not-allowed' : 'pointer') : (Ed.tool === 'joint' ? 'copy' : 'default');
});
function endDrag() {
  if (Ed.drag && !Ed.drag.moved) Ed.undo.pop();
  Ed.drag = null;
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('pointerleave', () => { Ed.hover = null; });
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (S.tab !== 'body') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); doUndo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { v: 'select', j: 'joint', b: 'bone', m: 'muscle', x: 'erase' };
  if (map[k]) setTool(map[k]);
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); }
  else if (k === 'escape') { Ed.pending = null; Ed.sel = null; renderInspector(); }
});

/* ---------------- form helpers ---------------- */
function mkRange(label, min, max, step, val, fmtv, onInput, onStart) {
  const row = el('label', 'rng');
  const top = el('div', 'rng-top');
  const out = el('output', 'mono', fmtv(val));
  top.append(el('span', '', label), out);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); out.textContent = fmtv(v); onInput(v); });
  if (onStart) inp.addEventListener('pointerdown', onStart);
  row.append(top, inp);
  return row;
}
function mkCheck(label, val, onChange) {
  const row = el('label', 'check');
  const inp = document.createElement('input');
  inp.type = 'checkbox'; inp.checked = val;
  inp.addEventListener('change', () => onChange(inp.checked));
  row.append(inp, el('span', '', label));
  return row;
}
function twoStep(btn, armedLabel, action) {
  let armed = false, t = 0;
  const orig = btn.textContent;
  btn.addEventListener('click', () => {
    if (!armed) { armed = true; btn.textContent = armedLabel; t = setTimeout(() => { armed = false; btn.textContent = orig; }, 3000); }
    else { clearTimeout(t); armed = false; btn.textContent = orig; action(); }
  });
}

/* ---------------- Body pane ---------------- */
function renderInspector() {
  const box = $('#inspector');
  box.textContent = '';
  const sel = Ed.sel, d = S.def;
  const item = sel && (sel.type === 'node' ? d.nodes[sel.i] : sel.type === 'bone' ? d.bones[sel.i] : d.muscles[sel.i]);
  if (!sel || !item) {
    Ed.sel = null;
    box.append(el('p', 'muted', 'Click a joint, bone or muscle to tune it. Lengths come from where you place the joints.'));
    return;
  }
  if (sel.type === 'node') {
    box.append(el('div', 'sel-title', 'Joint ' + (sel.i + 1)));
    box.append(mkRange('Weight', 0.1, 4, 0.05, item.m, (v) => v.toFixed(2) + ' kg', (v) => { item.m = v; paramChanged(); }, pushUndo));
    box.append(mkRange('Grip on the ground', 0, 1.5, 0.05, item.g, (v) => v.toFixed(2), (v) => { item.g = v; paramChanged(); }, pushUndo));
  } else if (sel.type === 'bone') {
    const len = Math.hypot(d.nodes[item.b].x - d.nodes[item.a].x, d.nodes[item.b].y - d.nodes[item.a].y);
    box.append(el('div', 'sel-title', 'Bone · ' + len.toFixed(2) + ' m, rigid'));
    box.append(mkRange('Weight', 0.1, 6, 0.1, item.m, (v) => v.toFixed(1) + ' kg', (v) => { item.m = v; paramChanged(); }, pushUndo));
  } else {
    const sg = muscleSeg(d, item), len = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]);
    box.append(el('div', 'sel-title', 'Muscle · rests at ' + len.toFixed(2) + ' m'));
    box.append(mkRange('Strength', 0, 1, 0.05, item.s, (v) => Math.round(250 * Math.pow(12, v)) + ' N/m, max ' + Math.round(80 * Math.pow(12, v)) + ' N', (v) => { item.s = v; paramChanged(); }, pushUndo));
    box.append(mkRange('Stroke (contract and extend)', 0.1, 0.6, 0.05, item.r, (v) => '±' + Math.round(v * 100) + '%', (v) => { item.r = v; paramChanged(); }, pushUndo));
  }
  const del = el('button', 'btn sm danger', 'Delete');
  del.addEventListener('click', deleteSelection);
  box.append(del);
}
function renderFacts() {
  const d = S.def, dm = Core.dims(d, S.brain);
  const rows = [
    ['Joints', d.nodes.length], ['Bones', d.bones.length], ['Muscles', d.muscles.length],
    ['Mass', Core.totalMass(d).toFixed(1) + ' kg'],
    ['Brain', dm.nIn + ' → ' + (S.brain.hidden.length ? S.brain.hidden.join(' → ') + ' → ' : '') + dm.nOut],
  ];
  const dl = $('#facts');
  dl.textContent = '';
  rows.forEach(([k, v]) => { dl.append(el('dt', '', k), el('dd', '', String(v))); });
  const w = $('#bodyWarn');
  w.hidden = canEvolve();
  w.textContent = d.nodes.length < 2 ? 'Add at least two joints.' : 'Add at least one muscle (M) so the creature has something to move.';
  $('#toEvolve').disabled = !canEvolve();
}
function syncPreset() {
  const sel = $('#presetSel');
  if (sel.value !== S.preset) sel.value = S.preset;
  $('#presetNote').textContent = PRESETS[S.preset] ? PRESETS[S.preset].note : 'Your own design.';
}
function loadPreset(id) {
  pushUndo();
  S.def = clone(PRESETS[id].def);
  Ed.sel = null; Ed.pending = null;
  bodyChanged();
  S.preset = id; syncPreset();
}

/* ---------------- Brain pane ---------------- */
let draft = null;
const ACT_LABELS = { tanh: 'Tanh (smooth)', relu: 'Leaky ReLU (sharp)', sine: 'Sine (rhythmic)' };
function brainDirty() {
  const dirty = JSON.stringify(draft) !== JSON.stringify(S.brain);
  $('#applyBrain').disabled = !dirty;
  $('#brainWarn').textContent = dirty
    ? (Evo.gen > 0 ? 'Applying starts a new random population. Generation ' + Evo.gen + ' stays in your archive only if you saved a snapshot.' : 'Applying rebuilds the random starting population.')
    : 'The diagram above shows the applied network. Change something to apply a new one.';
}
function renderBrainForm() {
  const f = $('#brainForm');
  f.textContent = '';
  if (!draft) draft = clone(S.brain);
  draft.hidden.forEach((n, i) => {
    const row = el('div', 'layer-row');
    row.append(mkRange('Hidden layer ' + (i + 1), 2, 32, 1, n, (v) => v + ' neurons', (v) => { draft.hidden[i] = v; brainDirty(); }));
    const rm = el('button', 'btn sm', 'Remove');
    rm.addEventListener('click', () => { draft.hidden.splice(i, 1); renderBrainForm(); });
    row.append(rm);
    f.append(row);
  });
  if (draft.hidden.length < 3) {
    const add = el('button', 'btn sm', 'Add hidden layer');
    add.style.marginBottom = '12px';
    add.addEventListener('click', () => { draft.hidden.push(8); renderBrainForm(); });
    f.append(add);
  }
  const lab = el('label', 'rng'), top = el('div', 'rng-top');
  top.append(el('span', '', 'Activation'));
  const sel = document.createElement('select');
  Object.keys(ACT_LABELS).forEach((k) => { const o = el('option', '', ACT_LABELS[k]); o.value = k; sel.append(o); });
  sel.value = draft.act;
  sel.addEventListener('change', () => { draft.act = sel.value; brainDirty(); });
  lab.append(top, sel);
  f.append(lab);
  f.append(mkCheck('Rhythm inputs (sine and cosine clock)', draft.clock, (v) => { draft.clock = v; renderBrainForm(); }));
  if (draft.clock) f.append(mkRange('Clock frequency', 0.3, 4, 0.1, draft.hz, (v) => v.toFixed(1) + ' Hz', (v) => { draft.hz = v; brainDirty(); }));
  f.append(mkCheck('Stuck sense (time since progress, average speed)', draft.stuck, (v) => { draft.stuck = v; brainDirty(); }));
  f.append(mkCheck('Memory (feed last outputs back in)', draft.memory, (v) => { draft.memory = v; brainDirty(); }));
  brainDirty();
}
function renderBrainSummary() {
  const d = dimsNow;
  $('#brainSummary').textContent = d.nIn + ' inputs · ' + (S.brain.hidden.join(' → ') || 'no hidden layers') + ' · ' + d.nOut + ' outputs · ' + net.nW + ' weights';
}
function drawBrain() {
  const f = fitCanvas($('#brainCv'));
  if (!f || !net) return;
  const { g, w, h } = f;
  g.clearRect(0, 0, w, h);
  const sizes = net.sizes, L = sizes.length;
  const fs = Replay.sims[0];
  const live = !!fs && fs.genome.length === net.nW && fs.inp.length === sizes[0];
  const genome = live ? fs.genome : Evo.pop[0];
  if (!genome || genome.length !== net.nW) return;
  const tmp = new Float64Array(sizes[L - 1]);
  if (live) net.forward(genome, fs.inp, tmp);
  const padX = 20, padY = 12;
  const cx = (l) => padX + ((w - 2 * padX) * l) / (L - 1);
  const cy = (l, i) => padY + (sizes[l] === 1 ? (h - 2 * padY) / 2 : ((h - 2 * padY) * i) / (sizes[l] - 1));
  let off = 0;
  g.lineWidth = 1;
  for (let l = 0; l < L - 1; l++) {
    const nI = sizes[l], nO = sizes[l + 1];
    for (let o = 0; o < nO; o++) {
      for (let i = 0; i < nI; i++) {
        const wv = genome[off + o * nI + i], a = Math.abs(wv);
        if (a < 0.25) continue;
        g.strokeStyle = wv > 0 ? P.pos : P.neg;
        g.globalAlpha = Math.min(0.55, a * 0.3);
        g.beginPath(); g.moveTo(cx(l), cy(l, i)); g.lineTo(cx(l + 1), cy(l + 1, o)); g.stroke();
      }
    }
    off += nI * nO + nO;
  }
  g.globalAlpha = 1;
  for (let l = 0; l < L; l++) {
    const n = sizes[l], r = clamp((h - 2 * padY) / (n * 2.6), 1.6, 5.5);
    for (let i = 0; i < n; i++) {
      const a = live ? clamp(net.bufs[l][i], -1, 1) : 0;
      g.fillStyle = mix(P.mL, P.mC, (a + 1) / 2);
      g.strokeStyle = P.ink2; g.lineWidth = 0.8;
      g.beginPath(); g.arc(cx(l), cy(l, i), r, 0, 6.2832); g.fill(); g.stroke();
    }
  }
  g.fillStyle = P.ink2; g.font = '10px ' + MONO; g.textAlign = 'center';
  g.fillText('senses', cx(0), h - 1); g.fillText('muscles', cx(L - 1), h - 1);
}

/* ---------------- Evolve pane ---------------- */
function updateRunBtn() {
  const b = $('#runBtn');
  b.textContent = Evo.running ? 'Pause' : (Evo.gen > 0 ? 'Resume' : 'Evolve');
  b.disabled = !canEvolve();
  $('#stepBtn').disabled = !canEvolve();
  b.title = canEvolve() ? '' : 'Add a muscle on the Body tab first';
}
function renderEvoStats() {
  Evo.statsDirty = false;
  const T = TASKS[S.task], last = Evo.history[Evo.history.length - 1];
  const rows = [
    ['Generation', String(Evo.gen)],
    ['Latest best', last ? fmt(last.mt, 2) + ' ' + T.unit : '–'],
    ['Record', Evo.best ? fmt(Evo.best.metric, 2) + ' ' + T.unit + ' (gen ' + Evo.best.gen + ')' : '–'],
    ['Population mean', last ? fmt(last.m, 2) : '–'],
    ['Gaits found', Core.archiveCount(Evo.arch) + ' of ' + Core.ARCH_N * Core.ARCH_N + ' · restarts ' + Evo.restarts],
    ['Progress', !last ? '–' : (S.evo.opt === 'cma' && Evo.cma ? ((Evo.stall || 0) <= 5 ? 'improving' : 'stalled ' + Evo.stall + ' gens') + ', step size ' + Evo.cma.sig.toFixed(3) : (Evo.stall || 0) <= 5 ? 'improving (' + (Evo.stall || 0) + ' gens since gain)' : (S.evo.adapt ? 'stalled ' + Evo.stall + ' gens, mutation x' + (Evo.boost || 1).toFixed(1) : 'stalled ' + Evo.stall + ' gens'))],
  ];
  const dl = $('#evoFacts');
  dl.textContent = '';
  rows.forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));
  const n = Evo.pop.length || 1;
  $('#progBar').style.width = (100 * Evo.idx) / n + '%';
  $('#progText').textContent = canEvolve()
    ? (Evo.running ? 'Evaluating generation ' + Evo.gen + ': ' + Evo.idx + ' of ' + n + ' creatures' : 'Paused at generation ' + Evo.gen)
    : 'Add a muscle on the Body tab to start.';
}
function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
function drawChart() {
  const f = fitCanvas($('#chartCv'));
  if (!f) return;
  Evo.chartDirty = false;
  const { g, w, h } = f, hist = Evo.history;
  g.clearRect(0, 0, w, h);
  g.font = '10px ' + MONO;
  if (!hist.length) {
    g.fillStyle = P.ink2; g.textAlign = 'center';
    g.fillText('The curve appears after the first generation.', w / 2, h / 2);
    return;
  }
  const L = 40, R = 10, T = 10, B = 20, pw = w - L - R, ph = h - T - B;
  let ymax = 0, ymin = 0;
  hist.forEach((p) => { ymax = Math.max(ymax, p.b, p.m); ymin = Math.min(ymin, p.m, p.b); });
  if (ymax <= ymin) ymax = ymin + 1;
  const step = niceStep((ymax - ymin) / 4), top = Math.ceil(ymax / step) * step, bot = Math.floor(ymin / step) * step;
  const g0 = hist[0].g, g1 = hist[hist.length - 1].g;
  const xs = (gi) => L + (g1 === g0 ? pw / 2 : ((gi - g0) / (g1 - g0)) * pw);
  const ys = (v) => T + ph - ((v - bot) / (top - bot)) * ph;
  g.textAlign = 'right'; g.strokeStyle = P.grid2; g.fillStyle = P.ink2; g.lineWidth = 1;
  for (let v = bot; v <= top + step / 2; v += step) {
    const y = Math.round(ys(v)) + 0.5;
    g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
    g.fillText(String(+v.toFixed(2)), L - 6, y + 3);
  }
  g.textAlign = 'left'; g.fillText('gen ' + g0, L, h - 5);
  g.textAlign = 'right'; g.fillText('gen ' + g1, w - R, h - 5);
  const line = (key, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    hist.forEach((p, i) => { const x = xs(p.g), y = ys(p[key]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  };
  line('m', P.ink2, 1.5);
  line('b', P.accent, 2.2);
  const lp = hist[hist.length - 1];
  g.fillStyle = P.accent; g.beginPath(); g.arc(xs(lp.g), ys(lp.b), 3.5, 0, 6.2832); g.fill();
  g.textAlign = 'left'; g.fillStyle = P.accent; g.fillText('best', L + 6, T + 10);
  g.fillStyle = P.ink2; g.fillText('mean', L + 40, T + 10);
}
function archGeom(w, h) {
  const L = 22, B = 16, N = Core.ARCH_N, cw = (w - L - 4) / N, ch = (h - B - 4) / N;
  return { L, B, N, cw, ch, h };
}
function drawArch() {
  const f = fitCanvas($('#archCv'));
  if (!f) return;
  const { g, w, h } = f, G = archGeom(w, h), cells = Evo.arch.cells;
  g.clearRect(0, 0, w, h);
  let hi = 0;
  cells.forEach((c) => { if (c && c.score > hi) hi = c.score; });
  for (let k = 0; k < cells.length; k++) {
    const cx = k % G.N, cy = Math.floor(k / G.N), x = G.L + cx * G.cw, y = h - G.B - (cy + 1) * G.ch, c = cells[k];
    g.fillStyle = P.grid2; g.fillRect(x + 1, y + 1, G.cw - 2, G.ch - 2);
    if (!c) continue;
    g.globalAlpha = 0.25 + 0.75 * Math.max(0, c.score) / (hi || 1);
    g.fillStyle = P.accent; g.fillRect(x + 1, y + 1, G.cw - 2, G.ch - 2);
    g.globalAlpha = 1;
    if (Replay.pick && Replay.pick.cell === k) { g.strokeStyle = P.ink2; g.lineWidth = 2; g.strokeRect(x + 1.5, y + 1.5, G.cw - 3, G.ch - 3); }
  }
  g.font = '10px ' + MONO; g.fillStyle = P.ink2; g.textAlign = 'left';
  g.fillText('ground contact →', G.L, h - 3);
  g.save(); g.translate(10, h - G.B); g.rotate(-Math.PI / 2); g.fillText('step rate →', 0, 0); g.restore();
}
function pickArch(ev) {
  const cv = $('#archCv'), r = cv.getBoundingClientRect(), G = archGeom(r.width, r.height);
  const cx = Math.floor((ev.clientX - r.left - G.L) / G.cw), cy = Math.floor((r.height - G.B - (ev.clientY - r.top)) / G.ch);
  if (cx < 0 || cy < 0 || cx >= G.N || cy >= G.N) return;
  const k = cy * G.N + cx, c = Evo.arch.cells[k];
  if (!c) return;
  Replay.pick = { g: c.g, label: 'gait · ' + fmt(c.metric, 2) + ' ' + TASKS[S.task].unit + ' · gen ' + c.gen, cell: k };
  startReplay(); Evo.chartDirty = true;
}
function renderEvoForm() {
  const f = $('#evoForm'), e = S.evo;
  f.textContent = '';
  const set = (k) => (v) => { e[k] = v; saveSoon(); };
  const T = TASKS[S.task];
  f.append(mkRange('Muscle damping (0 = free, higher = smoother but slower)', 0, 0.3, 0.01, S.phys.mdamp, (v) => v === 0 ? 'off' : v.toFixed(2), (v) => {
    S.phys.mdamp = v; applyPhys(); invalidateScores(); saveSoon();
  }));
  f.append(mkRange('Seconds per simulation (' + T.label + ')', 3, 90, 1, T.duration, (v) => v + ' s', (v) => {
    S.dur[S.task] = v; applyDurations(); invalidateScores(); updateTaskUI(); saveSoon();
  }));
  const lab = el('label', 'rng'), top = el('div', 'rng-top');
  top.append(el('span', '', 'Optimizer'));
  const sel = document.createElement('select');
  [['cma', 'CMA-ES (adaptive, recommended)'], ['ga', 'Genetic algorithm']].forEach(([k, t]) => { const o = el('option', '', t); o.value = k; sel.append(o); });
  sel.value = e.opt;
  sel.addEventListener('change', () => setOptimizer(sel.value));
  lab.append(top, sel); f.append(lab);
  f.append(mkRange('Population', 12, 120, 2, e.pop, (v) => v + ' creatures', (v) => {
    e.pop = v; saveSoon();
    if (e.opt === 'cma' && Evo.cma) {
      const prev = Evo.cma; Evo.cma = Core.cmaInit(net, v, prev.m, prev.sig, prev);
      Evo.pop = Core.cmaSample(Evo.cma); Evo.scores = new Float64Array(v); Evo.metrics = new Float64Array(v); Evo.idx = 0; Replay.refresh = true;
    } else if (Evo.gen === 0 && Evo.idx === 0) {
      Evo.pop = Array.from({ length: v }, () => Core.randomGenome(net));
      Evo.scores = new Float64Array(v); Evo.metrics = new Float64Array(v); Replay.refresh = true;
    }
  }));
  if (e.opt === 'cma') {
    f.append(el('p', 'note small', 'CMA-ES keeps one moving centre brain and samples the whole population around it. It learns which weights matter and how big each step should be, so there are no mutation settings to tune. If progress stalls, use "Shake up".'));
    f.append(mkCheck('Auto-restart when stalled (new random run or branch from a stored gait)', e.restart !== false, (v) => { e.restart = v; saveSoon(); }));
  } else {
    f.append(mkRange('Elites kept unchanged', 0, 10, 1, e.elite, (v) => String(v), set('elite')));
    f.append(mkRange('Mutation rate', 0.01, 0.4, 0.01, e.mut, (v) => Math.round(v * 100) + '% of weights', set('mut')));
    f.append(mkRange('Mutation strength', 0.02, 1, 0.02, e.sigma, (v) => 'σ ' + v.toFixed(2), set('sigma')));
    f.append(mkRange('Crossover', 0, 1, 0.05, e.cross, (v) => Math.round(v * 100) + '% of children', set('cross')));
    f.append(mkRange('Selection pressure', 2, 8, 1, e.tourney, (v) => 'tournament of ' + v, set('tourney')));
    f.append(mkRange('Fresh random blood', 0, 20, 1, e.fresh, (v) => v + '% per generation', set('fresh')));
    f.append(mkCheck('Boost mutation when progress stalls', e.adapt, (v) => { e.adapt = v; saveSoon(); Evo.statsDirty = true; }));
  }
}
function setOptimizer(v) {
  S.evo.opt = v;
  const n = S.evo.pop, seed = Evo.best ? Evo.best.g : (Evo.top.length ? Evo.top[0] : null);
  if (v === 'cma') {
    Evo.cma = Core.cmaInit(net, n, seed, seed ? 0.12 : 0.3);
    Evo.pop = Core.cmaSample(Evo.cma);
  } else {
    Evo.cma = null;
    Evo.pop = Evo.top.length ? fillFromTops(Evo.top) : Array.from({ length: n }, () => Core.randomGenome(net));
  }
  Evo.scores = new Float64Array(Evo.pop.length); Evo.metrics = new Float64Array(Evo.pop.length); Evo.idx = 0;
  Evo.lastGain = Evo.gen; Evo.gainScore = -Infinity; Evo.stall = 0; Evo.boost = 1;
  Replay.refresh = true; Evo.statsDirty = true; renderEvoForm(); saveSoon();
  toast(v === 'cma' ? 'CMA-ES: sampling around your best brain.' : 'Genetic algorithm.');
}
function shakeUp() {
  if (S.evo.opt === 'cma' && Evo.cma) {
    const n = S.evo.pop, seed = Evo.best ? Evo.best.g : Evo.cma.m;
    Evo.cma = Core.cmaInit(net, n, seed, 0.25);
    Evo.pop = Core.cmaSample(Evo.cma); Evo.scores = new Float64Array(n); Evo.metrics = new Float64Array(n); Evo.idx = 0;
    Evo.lastGain = Evo.gen; Evo.gainScore = -Infinity; Evo.stall = 0;
    Replay.refresh = true; Evo.statsDirty = true; saveSoon();
    toast('Shook it up: re-centred on the champion with a wide, fresh search.');
    return;
  }
  const src = Evo.top.length ? Evo.top : Evo.pop;
  if (!src.length) return;
  const n = S.evo.pop, E = Math.min(2, src.length), pop = src.slice(0, E).map((g) => Float32Array.from(g));
  while (pop.length < n) {
    if (Math.random() < 0.2) { pop.push(Core.randomGenome(net)); continue; }
    const c = Float32Array.from(src[Math.floor(Math.random() * Math.min(src.length, 8))]);
    Core.mutate(c, 0.25, 0.4 + Math.random() * 0.8);
    pop.push(c);
  }
  Evo.pop = pop; Evo.scores = new Float64Array(n); Evo.metrics = new Float64Array(n); Evo.idx = 0;
  Evo.lastGain = Evo.gen; Evo.gainScore = -Infinity; Evo.stall = 0; Evo.boost = 1;
  Replay.refresh = true; Evo.statsDirty = true; saveSoon();
  toast('Shook it up: the best two kept, the rest heavily mutated.');
}

/* ---------------- drawing: shared ---------------- */
function drawBackdrop(cam, sc, gy) {
  for (const [par, amp, fr, al] of [[0.25, 0.9, 0.19, 0.35], [0.5, 0.55, 0.33, 0.55]]) {
    ctx.beginPath(); ctx.moveTo(0, gy);
    for (let sx = 0; sx <= W + 8; sx += 8) {
      const wx = (sx - W * 0.38) / sc + cam * par;
      const hg = (Math.sin(wx * fr) + 0.6 * Math.sin(wx * fr * 2.3 + 2)) * amp * sc * 0.5 + amp * sc * 0.9;
      ctx.lineTo(sx, gy - hg);
    }
    ctx.lineTo(W, gy); ctx.closePath();
    ctx.globalAlpha = al; ctx.fillStyle = P.grid2; ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawTerrain(T, xl, xr, x2s, y2s) {
  const pts = T.pts;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < xl) lo = mid + 1; else hi = mid; }
  const i0 = Math.max(0, lo - 1);
  ctx.beginPath(); ctx.moveTo(x2s(pts[i0][0]), H);
  let i = i0;
  for (; i < pts.length; i++) { ctx.lineTo(x2s(pts[i][0]), y2s(pts[i][1])); if (pts[i][0] > xr) break; }
  const last = pts[Math.min(i, pts.length - 1)];
  ctx.lineTo(x2s(last[0]), H); ctx.closePath();
  ctx.fillStyle = P.ground; ctx.fill();
  ctx.beginPath();
  for (let k = i0; k <= Math.min(i, pts.length - 1); k++) { const x = x2s(pts[k][0]), y = y2s(pts[k][1]); if (k === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.strokeStyle = P.groundTop; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
}

/* ---------------- drawing: simulation view ---------------- */
function drawSimCreature(s, sc, x2s, y2s, alpha) {
  ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let k = 0; k < s.nm; k++) {
    const t = (clamp(s.act[k], -1, 1) + 1) / 2;
    Core.muscleEndpoints(s, k, EPT);
    ctx.strokeStyle = mix(P.mC, P.mL, t); ctx.lineWidth = sc * (0.04 + 0.035 * (1 - t));
    ctx.beginPath(); ctx.moveTo(x2s(EPT[0]), y2s(EPT[1])); ctx.lineTo(x2s(EPT[2]), y2s(EPT[3])); ctx.stroke();
  }
  ctx.strokeStyle = P.bone;
  for (let k = 0; k < s.nb; k++) {
    const a = s.ba[k], b = s.bb[k];
    ctx.lineWidth = Math.max(3, (0.03 + 0.012 * s.bm[k]) * sc);
    ctx.beginPath(); ctx.moveTo(x2s(s.x[a]), y2s(s.y[a])); ctx.lineTo(x2s(s.x[b]), y2s(s.y[b])); ctx.stroke();
  }
  ctx.lineWidth = 1.5; ctx.fillStyle = P.muscle;
  for (let k = 0; k < s.nm; k++) {
    if (s.ma2[k] < 0 && s.mb2[k] < 0) continue;
    Core.muscleEndpoints(s, k, EPT);
    if (s.ma2[k] >= 0) { ctx.beginPath(); ctx.arc(x2s(EPT[0]), y2s(EPT[1]), 0.04 * sc, 0, 6.2832); ctx.fill(); ctx.stroke(); }
    if (s.mb2[k] >= 0) { ctx.beginPath(); ctx.arc(x2s(EPT[2]), y2s(EPT[3]), 0.04 * sc, 0, 6.2832); ctx.fill(); ctx.stroke(); }
  }
  ctx.lineWidth = 2;
  for (let i = 0; i < s.n; i++) {
    ctx.fillStyle = P.joint;
    ctx.beginPath(); ctx.arc(x2s(s.x[i]), y2s(s.y[i]), s.r[i] * sc, 0, 6.2832); ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function drawSim() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.stage; ctx.fillRect(0, 0, W, H);
  const rough = S.task === 'hurdles' || S.task === 'hills' || S.task === 'stairs';
  const sc = clamp(W / (rough ? 15 : 11), 26, 110), gy = H * (rough ? 0.76 : 0.7), cam = Replay.camX;
  const camY = Replay.camY || 0;
  const x2s = (x) => W * 0.38 + (x - cam) * sc, y2s = (y) => gy - (y - camY) * sc;
  const xl = cam - (W * 0.38) / sc - 1, xr = cam + (W * 0.62) / sc + 1;
  drawBackdrop(cam, sc, gy);
  ctx.lineWidth = 1;
  for (let m = Math.ceil(xl); m <= xr; m++) {
    ctx.strokeStyle = m % 5 === 0 ? P.grid2 : P.grid;
    const sx = Math.round(x2s(m)) + 0.5;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, camY > 0 ? H : gy); ctx.stroke();
  }
  for (let m = Math.max(1, Math.ceil(camY - (H - gy) / sc)); y2s(m) > 0; m++) {
    ctx.strokeStyle = P.grid; const y = Math.round(y2s(m)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const T = (Replay.sims[0] && Replay.sims[0].T) || Core.getTerrain(TASKS[S.task].terrain);
  drawTerrain(T, xl, xr, x2s, y2s);
  ctx.fillStyle = P.ink2; ctx.strokeStyle = P.groundTop; ctx.font = '10px ' + MONO; ctx.textAlign = 'center';
  ctx.lineWidth = 1;
  for (let m = Math.ceil(xl); m <= xr; m++) {
    const sx = Math.round(x2s(m)) + 0.5, big = m % 5 === 0;
    ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(sx, H - 4); ctx.lineTo(sx, H - (big ? 14 : 8)); ctx.stroke();
    ctx.globalAlpha = 1;
    if (big) ctx.fillText(m + ' m', sx, H - 19);
  }
  const sims = Replay.sims;
  if (!sims.length) {
    ctx.fillStyle = P.ink2; ctx.font = '13px ' + MONO; ctx.textAlign = 'center';
    ctx.fillText('Add a muscle on the Body tab to bring it to life.', W / 2, H * 0.4);
    return;
  }
  if (S.task === 'jump') {
    const peak = Math.max(0, sims[0].maxClear);
    ctx.setLineDash([5, 5]); ctx.strokeStyle = P.accent; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, y2s(peak)); ctx.lineTo(W, y2s(peak)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.accent; ctx.font = '11px ' + MONO; ctx.textAlign = 'left';
    ctx.fillText('peak ' + peak.toFixed(2) + ' m', 10, y2s(peak) - 6);
  }
  for (let i = sims.length - 1; i >= 0; i--) drawSimCreature(sims[i], sc, x2s, y2s, i === 0 ? 1 : 0.42);
  ctx.font = '11px ' + MONO; ctx.textAlign = 'center';
  sims.forEach((s, i) => {
    let top = -1e9;
    for (let k = 0; k < s.n; k++) top = Math.max(top, s.y[k]);
    ctx.globalAlpha = i === 0 ? 1 : 0.7; ctx.fillStyle = i === 0 ? P.accent : P.ink2;
    const txt = i === 0 ? Replay.labels[i] + ' · ' + fmt(Core.liveMetric(s), 1) + ' m' : Replay.labels[i];
    ctx.fillText(txt, x2s(s.cx), y2s(top) - 16 - (i === 0 ? 0 : 10 + (i % 3) * 11));
  });
  ctx.globalAlpha = 1;
  const lead = sims[0], T0 = TASKS[S.task];
  ctx.textAlign = 'left'; ctx.fillStyle = P.ink2; ctx.font = '11px ' + MONO;
  let hud = T0.label.toUpperCase() + '  ·  GEN ' + Evo.gen;
  if (S.task === 'hurdles') hud += '  ·  HURDLES ' + Core.hurdlesCleared(lead);
  if (S.task === 'stairs') hud += '  ·  CLIMBED ' + Math.max(0, Core.getTerrain('stairs').fn(lead.cx)).toFixed(1) + ' m';
  ctx.fillText(hud, 12, 20);
  ctx.textAlign = 'right';
  ctx.fillText(Math.min(lead.t, T0.duration).toFixed(1) + ' / ' + T0.duration + ' s', W - 12, 20);
  if (Replay.random) {
    ctx.textAlign = 'center'; ctx.fillStyle = P.ink2; ctx.font = '12px ' + MONO;
    ctx.fillText('Untrained brains. Press Evolve to train them.', W / 2, 44);
  }
}

/* ---------------- drawing: editor view ---------------- */
function drawEditor() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.stage; ctx.fillRect(0, 0, W, H);
  const v = edView(), d = S.def;
  const xa = -v.ox / v.sc, xb = (W - v.ox) / v.sc, yTop = v.gy / v.sc;
  ctx.lineWidth = 1; ctx.font = '10px ' + MONO; ctx.fillStyle = P.ink2;
  for (let x = Math.ceil(xa * 4) / 4; x <= xb; x += 0.25) {
    const major = Math.abs(x - Math.round(x)) < 1e-6, sx = Math.round(v.ox + x * v.sc) + 0.5;
    ctx.strokeStyle = major ? P.grid2 : P.grid;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, v.gy); ctx.stroke();
  }
  for (let y = 0.25; y <= yTop; y += 0.25) {
    const major = Math.abs(y - Math.round(y)) < 1e-6, sy = Math.round(v.gy - y * v.sc) + 0.5;
    ctx.strokeStyle = major ? P.grid2 : P.grid;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
  }
  ctx.fillStyle = P.ground; ctx.fillRect(0, v.gy, W, H - v.gy);
  ctx.strokeStyle = P.groundTop; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, v.gy); ctx.lineTo(W, v.gy); ctx.stroke();
  ctx.fillStyle = P.ink2; ctx.textAlign = 'center';
  for (let x = Math.ceil(xa); x <= xb; x++) ctx.fillText(x + ' m', v.ox + x * v.sc, v.gy + 15);
  ctx.textAlign = 'left';
  for (let y = 1; y <= yTop; y++) ctx.fillText(y + ' m', 6, v.gy - y * v.sc - 4);

  const P2 = (i) => e2s(v, d.nodes[i].x, d.nodes[i].y);
  const emph = (type, i, width, alpha, a, b) => {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = P.accent; ctx.lineCap = 'round'; ctx.lineWidth = width + 9;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore();
  };
  ctx.lineCap = 'round';
  d.muscles.forEach((m, i) => {
    const sg = muscleSeg(d, m), a = e2s(v, sg[0], sg[1]), b = e2s(v, sg[2], sg[3]), w = 0.05 * v.sc;
    if (Ed.sel && Ed.sel.type === 'muscle' && Ed.sel.i === i) emph('muscle', i, w, 0.3, a, b);
    else if (Ed.hover && Ed.hover.type === 'muscle' && Ed.hover.i === i) emph('muscle', i, w, 0.16, a, b);
    ctx.strokeStyle = P.muscle; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = P.joint; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore();
  });
  d.bones.forEach((bo, i) => {
    const a = P2(bo.a), b = P2(bo.b), w = Math.max(3, (0.03 + 0.012 * bo.m) * v.sc);
    if (Ed.sel && Ed.sel.type === 'bone' && Ed.sel.i === i) emph('bone', i, w, 0.3, a, b);
    else if (Ed.hover && Ed.hover.type === 'bone' && Ed.hover.i === i) emph('bone', i, w, 0.16, a, b);
    ctx.strokeStyle = P.bone; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  });
  d.muscles.forEach((m) => {
    const sg = muscleSeg(d, m);
    [[m.ak, sg[0], sg[1]], [m.bk, sg[2], sg[3]]].forEach(([k, wx, wy]) => {
      if (!k) return;
      const p = e2s(v, wx, wy);
      ctx.fillStyle = P.muscle; ctx.strokeStyle = P.bone; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 6.2832); ctx.fill(); ctx.stroke();
    });
  });
  if (Ed.tool === 'muscle') {
    d.bones.forEach((bo, i) => {
      const p = ptOf(d, i, 1), q = e2s(v, p[0], p[1]), hot = Ed.hover && Ed.hover.type === 'bone' && Ed.hover.i === i;
      ctx.fillStyle = hot ? P.accent : P.joint; ctx.strokeStyle = P.accent; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(q[0], q[1], hot ? 6 : 4, 0, 6.2832); ctx.fill(); ctx.stroke();
    });
  }
  d.nodes.forEach((n, i) => {
    const [sx, sy] = P2(i), r = Core.nodeRadius(n.m) * v.sc;
    const isPend = !!Ed.pending && Ed.pending.k === 0 && Ed.pending.i === i;
    const selected = Ed.sel && Ed.sel.type === 'node' && Ed.sel.i === i, hov = Ed.hover && Ed.hover.type === 'node' && Ed.hover.i === i;
    if (selected || hov || isPend) {
      ctx.save(); ctx.strokeStyle = P.accent; ctx.lineWidth = 2; ctx.globalAlpha = selected || isPend ? 1 : 0.5;
      if (isPend) ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(sx, sy, r + 6, 0, 6.2832); ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = P.joint; ctx.strokeStyle = P.bone; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.2832); ctx.fill(); ctx.stroke();
  });
  const pe = Ed.pending && (Ed.pending.k ? d.bones[Ed.pending.i] : d.nodes[Ed.pending.i]) ? ptOf(d, Ed.pending.i, Ed.pending.k) : null;
  if (pe && (Ed.tool === 'bone' || Ed.tool === 'muscle')) {
    const a = e2s(v, pe[0], pe[1]);
    ctx.save(); ctx.strokeStyle = P.accent; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    if (Ed.pending.k) { ctx.beginPath(); ctx.arc(a[0], a[1], 9, 0, 6.2832); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(Ed.ptr[0], Ed.ptr[1]); ctx.stroke(); ctx.restore();
  }
  if (Ed.sel && Ed.sel.type !== 'node') {
    const l = Ed.sel.type === 'bone' ? d.bones[Ed.sel.i] : d.muscles[Ed.sel.i];
    if (l) {
      const sg = Ed.sel.type === 'bone' ? [d.nodes[l.a].x, d.nodes[l.a].y, d.nodes[l.b].x, d.nodes[l.b].y] : muscleSeg(d, l);
      const a = e2s(v, sg[0], sg[1]), b = e2s(v, sg[2], sg[3]), len = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]);
      ctx.fillStyle = P.accent; ctx.font = '11px ' + MONO; ctx.textAlign = 'center';
      ctx.fillText(len.toFixed(2) + ' m', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14);
    }
  }
  if (!d.nodes.length) {
    ctx.fillStyle = P.ink2; ctx.font = '13px ' + MONO; ctx.textAlign = 'center';
    ctx.fillText('Pick the Joint tool and click to place the first joint.', W / 2, H * 0.4);
  }
}

/* ---------------- persistence ---------------- */
const KEY_SESSION = 'gaitworks.session.v1', KEY_SNAPS = 'gaitworks.snaps.v1';
let storageOK = false, lastSaved = '';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
function f32ToB64(f) {
  const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x4000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x4000));
  return btoa(s);
}
function b64ToF32(b) {
  const s = atob(b), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
}
function cmaPack() {
  const st = Evo.cma;
  if (!st || S.evo.opt !== 'cma') return null;
  const n = st.n, buf = new Float32Array(4 * n);
  buf.set(st.m, 0); buf.set(st.Cd, n); buf.set(st.ps, 2 * n); buf.set(st.pc, 3 * n);
  return { sig: st.sig, d: f32ToB64(buf) };
}
function serialize(topK) {
  const tops = (Evo.top.length ? Evo.top : Evo.pop).slice(0, topK);
  return {
    v: 1, app: 'gaitworks', ts: Date.now(), cma: cmaPack(), task: S.task, dur: S.dur, phys: S.phys, creature: S.def, brain: S.brain, evo: S.evo, gen: Evo.gen,
    history: Evo.history.slice(-600),
    best: Evo.best ? { score: Evo.best.score, metric: Evo.best.metric, gen: Evo.best.gen, g: f32ToB64(Evo.best.g) } : null,
    top: tops.map(f32ToB64),
    arch: Evo.arch.cells.map((c) => (c ? { s: c.score, m: c.metric, d: c.desc, gen: c.gen, g: f32ToB64(c.g) } : null)),
    restarts: Evo.restarts,
  };
}
function sanitizeDef(d) {
  const num = (v, a, b, dflt) => { v = +v; return Number.isFinite(v) ? clamp(v, a, b) : dflt; };
  const nodes = (d.nodes || []).slice(0, MAX_NODES).map((n) => ({ x: num(n.x, -3, 3, 0), y: num(n.y, 0.06, 3, 0.5), m: num(n.m, 0.1, 5, 0.4), g: num(n.g, 0, 1.5, 0.8) }));
  const ok = (l) => Number.isInteger(l.a) && Number.isInteger(l.b) && l.a !== l.b && l.a >= 0 && l.b >= 0 && l.a < nodes.length && l.b < nodes.length;
  const bones = (d.bones || []).filter(ok).slice(0, MAX_BONES).map((b) => ({ a: b.a, b: b.b, m: num(b.m, 0.1, 6, 1) }));
  const okEnd = (i, k) => Number.isInteger(i) && i >= 0 && i < (k ? bones.length : nodes.length);
  const muscles = (d.muscles || []).filter((m) => {
    if (!okEnd(m.a, m.ak) || !okEnd(m.b, m.bk)) return false;
    const ka = m.ak ? 1 : 0, kb = m.bk ? 1 : 0;
    const own = (i, bi) => bones[bi].a === i || bones[bi].b === i;
    if (ka === kb && m.a === m.b) return false;
    return !((!ka && kb && own(m.a, m.b)) || (ka && !kb && own(m.b, m.a)));
  }).slice(0, MAX_MUSCLES).map((m) => ({ a: m.a, b: m.b, ak: m.ak ? 1 : 0, bk: m.bk ? 1 : 0, s: num(m.s, 0, 1, 0.55), r: num(m.r, 0.1, 0.6, 0.3) }));
  if (!nodes.length) throw new Error('The creature has no joints.');
  return { nodes, bones, muscles };
}
function sanitizeBrain(b) {
  b = b || {};
  const hidden = (Array.isArray(b.hidden) ? b.hidden : [12, 8]).slice(0, 3).map((n) => clamp(Math.round(+n) || 8, 2, 32));
  return { hidden, act: Core.ACTS[b.act] ? b.act : 'tanh', clock: b.clock !== false, hz: clamp(+b.hz || 1.5, 0.3, 4), memory: !!b.memory, stuck: b.stuck === true };
}
function sanitizeEvo(e) {
  e = e || {};
  const n = (k, a, b, dflt) => { const v = +e[k]; return Number.isFinite(v) ? clamp(v, a, b) : dflt; };
  return { pop: Math.round(n('pop', 12, 120, 48)), elite: Math.round(n('elite', 0, 10, 4)), mut: n('mut', 0.01, 0.4, 0.08), sigma: n('sigma', 0.02, 1, 0.3), cross: n('cross', 0, 1, 0.5), fresh: Math.round(n('fresh', 0, 20, 4)), tourney: Math.round(n('tourney', 2, 8, 3)), adapt: e.adapt !== false, opt: e.opt === 'ga' ? 'ga' : 'cma', restart: e.restart !== false };
}
function applySession(o) {
  if (!o || o.v !== 1 || !o.creature) throw new Error('This is not a Gaitworks file.');
  S.def = sanitizeDef(o.creature); S.brain = sanitizeBrain(o.brain); S.evo = sanitizeEvo(o.evo);
  S.task = TASKS[o.task] ? o.task : 'run'; S.preset = 'custom';
  S.dur = {}; if (o.dur && typeof o.dur === 'object') for (const k of Object.keys(TASKS)) { const v = Math.round(+o.dur[k]); if (v >= 3 && v <= 120) S.dur[k] = v; }
  S.phys = { mdamp: o.phys && Number.isFinite(+o.phys.mdamp) ? clamp(+o.phys.mdamp, 0, 0.3) : 0 };
  applyPhys(); applyDurations();
  rebuildNet(); lastSig = Core.topoSig(S.def);
  const safe = (b) => { try { return b64ToF32(b); } catch (e) { return new Float32Array(0); } };
  const tops = (o.top || []).map(safe).filter((g) => g.length === net.nW);
  Evo.gen = Math.max(0, o.gen | 0); Evo.lastGain = null; Evo.stall = 0; Evo.boost = 1;
  Evo.history = Array.isArray(o.history) ? o.history.filter((h) => h && Number.isFinite(h.b) && Number.isFinite(h.m)).slice(-600) : [];
  Evo.best = null;
  if (o.best && o.best.g) { const g = safe(o.best.g); if (g.length === net.nW) Evo.best = { score: +o.best.score, metric: +o.best.metric, gen: o.best.gen | 0, g }; }
  Evo.running = false; Evo.until = Infinity; Evo.idx = 0;
  Evo.arch = Core.archiveNew(); Evo.descs = []; Evo.restarts = Math.max(0, o.restarts | 0); Evo.runStart = Evo.gen; Replay.pick = null;
  if (Array.isArray(o.arch)) o.arch.slice(0, Evo.arch.cells.length).forEach((c) => {
    if (!c || !c.g || !Array.isArray(c.d)) return;
    const g = safe(c.g);
    if (g.length === net.nW) Core.archiveAdd(Evo.arch, g, +c.s, +c.m, [+c.d[0], +c.d[1]], c.gen | 0);
  });
  Evo.cma = null;
  if (S.evo.opt === 'cma' && (tops.length || Evo.best)) {
    Evo.top = tops;
    const n = net.nW, seed = tops.length ? tops[0] : Evo.best.g;
    let prev = null, sig = 0.12, mean = seed;
    try {
      if (o.cma && o.cma.d) {
        const buf = b64ToF32(o.cma.d);
        if (buf.length === 4 * n && Number.isFinite(+o.cma.sig)) {
          mean = buf.slice(0, n); prev = { Cd: buf.slice(n, 2 * n), ps: buf.slice(2 * n, 3 * n), pc: buf.slice(3 * n, 4 * n) }; sig = clamp(+o.cma.sig, 1e-3, 1.5);
        }
      }
    } catch (e) { prev = null; }
    Evo.cma = Core.cmaInit(net, S.evo.pop, mean, sig, prev);
    Evo.pop = Core.cmaSample(Evo.cma);
  }
  else if (tops.length) { Evo.top = tops; Evo.pop = fillFromTops(tops); }
  else {
    Evo.top = []; Evo.gen = 0; Evo.history = []; Evo.best = null;
    if (S.evo.opt === 'cma') { Evo.cma = Core.cmaInit(net, S.evo.pop, null, 0.3); Evo.pop = Core.cmaSample(Evo.cma); }
    else Evo.pop = Array.from({ length: S.evo.pop }, () => Core.randomGenome(net));
  }
  Evo.scores = new Float64Array(Evo.pop.length); Evo.metrics = new Float64Array(Evo.pop.length);
  Ed.sel = null; Ed.pending = null; Ed.undo = []; draft = null;
  Replay.refresh = true;
  Evo.statsDirty = Evo.chartDirty = true;
  refreshAll();
}
let saveT = 0;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(saveNow, 800); }
function saveNow() {
  if (!net) return;
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (storageOK && lsSet(KEY_SESSION, JSON.stringify(serialize(16)))) { lastSaved = t; $('#saveState').textContent = 'Autosaved ' + t; }
  else { storageOK = false; $('#saveState').textContent = 'Not saving: browser storage is blocked. Use Archive to export.'; }
  if (S.tab === 'archive') renderAutoInfo();
}
function loadSnaps() {
  try { const a = JSON.parse(lsGet(KEY_SNAPS) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function renderAutoInfo() {
  $('#autoInfo').textContent = storageOK
    ? 'Your work saves itself in this browser after every generation' + (lastSaved ? ' (last at ' + lastSaved + ')' : '') + '. The population keeps its 16 best brains, so you resume where you left off.'
    : 'This view blocks browser storage, so nothing saves on its own. Export a file below to keep your work.';
}
function renderArchive() {
  renderAutoInfo();
  const list = $('#snapList'), snaps = loadSnaps();
  list.textContent = '';
  if (!snaps.length) { list.append(el('li', 'empty', 'No snapshots yet. Save one to keep a generation you like.')); return; }
  snaps.slice().reverse().forEach((sn) => {
    const li = el('li');
    li.append(el('strong', '', sn.name || 'Untitled'));
    const when = new Date(sn.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const rec = sn.best ? fmt(sn.best.metric, 1) + ' m' : 'untrained';
    li.append(el('span', 'meta mono small', (TASKS[sn.task] ? TASKS[sn.task].label : 'Run') + ' · gen ' + sn.gen + ' · ' + rec + ' · ' + when));
    const row = el('div', 'btnrow');
    const load = el('button', 'btn sm', 'Load'), exp = el('button', 'btn sm', 'Export'), del = el('button', 'btn sm danger', 'Delete');
    load.addEventListener('click', () => { try { applySession(sn); toast('Loaded “' + (sn.name || 'snapshot') + '”.'); } catch (e) { toast(e.message); } });
    exp.addEventListener('click', () => { $('#xfer').value = JSON.stringify(sn); toast('Snapshot written to the box below.'); });
    twoStep(del, 'Sure?', () => { const all = loadSnaps().filter((x) => x.id !== sn.id); lsSet(KEY_SNAPS, JSON.stringify(all)); renderArchive(); });
    row.append(load, exp, del);
    li.append(row);
    list.append(li);
  });
}
function saveSnapshot() {
  const name = $('#snapName').value.trim() || (TASKS[S.task].label + ' · gen ' + Evo.gen);
  const sn = Object.assign(serialize(24), { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name });
  const all = loadSnaps(); all.push(sn);
  if (!lsSet(KEY_SNAPS, JSON.stringify(all))) { toast('Storage is full or blocked. Export the snapshot instead.'); $('#xfer').value = JSON.stringify(sn); return; }
  $('#snapName').value = ''; renderArchive(); toast('Snapshot saved.');
}
async function saveFile() {
  const box = $('#xfer');
  if (!box.value) box.value = JSON.stringify(serialize(24));
  try {
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (!dl) { toast('File saving is not available here. Use Copy instead.'); return; }
    await dl.save({ filename: 'gaitworks-' + S.task + '-gen' + Evo.gen + '.json', data: box.value });
    toast('File ready.');
  } catch (e) {
    if (e && e.code === 'declined') return;
    toast('Could not save a file. Use Copy instead.');
  }
}
async function copyText() {
  const box = $('#xfer');
  if (!box.value) box.value = JSON.stringify(serialize(24));
  try { await navigator.clipboard.writeText(box.value); toast('Copied.'); }
  catch (e) { box.focus(); box.select(); toast('Select all and copy with Ctrl or Cmd + C.'); }
}
function importText(text) {
  try { applySession(JSON.parse(text)); toast('Imported generation ' + Evo.gen + '.'); }
  catch (e) { toast('Could not import: ' + (e.message || 'invalid JSON') + '.'); }
}

/* ---------------- UI wiring ---------------- */
function updateTaskUI() {
  $$('#taskSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.task === S.task)));
  $('#taskBlurb').textContent = TASKS[S.task].blurb.replace('{s}', TASKS[S.task].duration);
}
function setTask(t) {
  if (t === S.task) return;
  S.task = t;
  Evo.history = []; Evo.best = null; Evo.top = []; Evo.idx = 0;
  Evo.arch = Core.archiveNew(); Replay.pick = null;
  Replay.refresh = true; Evo.statsDirty = Evo.chartDirty = true;
  updateTaskUI(); renderEvoForm(); saveSoon();
  if (S.tab !== 'body') startReplay();
  toast('Task changed. The population keeps what it learned and adapts.');
}
function setTab(t) {
  S.tab = t;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.pane').forEach((p) => { p.hidden = p.id !== 'pane-' + t; });
  $('#barEdit').hidden = t !== 'body'; $('#barSim').hidden = t === 'body';
  cv.style.touchAction = t === 'body' ? 'none' : 'auto';
  if (t === 'body') { Evo.running = false; Evo.until = Infinity; updateRunBtn(); Ed.pending = null; }
  else if (Replay.refresh || !Replay.sims.length) startReplay();
  if (t === 'archive') renderArchive();
  if (t === 'brain') { renderBrainForm(); renderBrainSummary(); }
  if (t === 'evolve') { Evo.statsDirty = Evo.chartDirty = true; }
  resize();
}
function refreshAll() {
  updateTaskUI(); syncPreset(); renderInspector(); renderFacts(); renderEvoForm();
  renderBrainSummary(); if (S.tab === 'brain') renderBrainForm(); renderEvoStats(); updateRunBtn();
  $('#turbo').checked = Evo.turbo; updateSimInfo();
  if (S.tab !== 'body') startReplay();
  if (S.tab === 'archive') renderArchive();
}
function wire() {
  $$('#taskSeg button').forEach((b) => b.addEventListener('click', () => setTask(b.dataset.task)));
  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
    Replay.mode = b.dataset.mode; Replay.pick = null; Evo.chartDirty = true;
    $$('#modeSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    startReplay();
  }));
  $$('#speedSeg button').forEach((b) => b.addEventListener('click', () => {
    Replay.speed = +b.dataset.speed;
    $$('#speedSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  const ps = $('#presetSel');
  Object.keys(PRESETS).forEach((k) => { const o = el('option', '', PRESETS[k].label); o.value = k; ps.append(o); });
  const oc = el('option', '', 'Custom design'); oc.value = 'custom'; ps.append(oc);
  ps.addEventListener('change', () => { if (PRESETS[ps.value]) loadPreset(ps.value); });
  $('#undoBtn').addEventListener('click', doUndo);
  twoStep($('#clearBtn'), 'Remove everything?', () => { pushUndo(); S.def = { nodes: [], bones: [], muscles: [] }; Ed.sel = null; Ed.pending = null; bodyChanged(); });
  $('#toEvolve').addEventListener('click', () => { if (!canEvolve()) return; setTab('evolve'); Evo.running = true; updateRunBtn(); });
  $('#applyBrain').addEventListener('click', () => {
    S.brain = clone(draft); resetPopulation(); draft = null;
    renderBrainForm(); renderBrainSummary(); refreshAll(); saveSoon(); toast('New architecture applied with a fresh random population.');
  });
  $('#runBtn').addEventListener('click', () => {
    if (!canEvolve()) return;
    Evo.running = !Evo.running; Evo.until = Infinity; updateRunBtn(); Evo.statsDirty = true;
  });
  $('#stepBtn').addEventListener('click', () => {
    if (!canEvolve()) return;
    Evo.until = Evo.gen + 1; Evo.running = true; updateRunBtn();
  });
  $('#turbo').addEventListener('change', (e) => { Evo.turbo = e.target.checked; });
  $('#shakeBtn').addEventListener('click', shakeUp);
  $('#archCv').addEventListener('click', pickArch);
  twoStep($('#restartBtn'), 'Discard progress?', () => { resetPopulation(); refreshAll(); saveSoon(); toast('Fresh random brains.'); });
  $('#snapBtn').addEventListener('click', saveSnapshot);
  $('#snapName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSnapshot(); });
  $('#exportBtn').addEventListener('click', () => { $('#xfer').value = JSON.stringify(serialize(24)); toast('Current state written to the box.'); });
  $('#copyBtn').addEventListener('click', copyText);
  $('#fileBtn').addEventListener('click', saveFile);
  $('#importBtn').addEventListener('click', () => importText($('#xfer').value));
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => importText(String(rd.result));
    rd.readAsText(f);
    e.target.value = '';
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);
}

/* ---------------- main loop ---------------- */
let lastT = performance.now(), lastUI = 0, frameNo = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now; frameNo++;
  if (S.tab !== 'body') evoTick(Evo.turbo ? 45 : 9);
  if (mode() === 'edit') drawEditor();
  else { stepReplay(dt); drawSim(); }
  if (now - lastUI > 160) {
    lastUI = now;
    if (S.tab === 'evolve') {
      if (Evo.statsDirty) renderEvoStats();
      if (Evo.chartDirty) { drawChart(); drawArch(); }
    }
  }
  if (S.tab === 'brain' && frameNo % 2 === 0) drawBrain();
  requestAnimationFrame(frame);
}

/* ---------------- boot ---------------- */
function boot() {
  readPalette();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette);
  new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  new ResizeObserver(resize).observe($('#wrap'));
  resize(); wire();
  storageOK = lsSet('gaitworks.probe', '1');
  if (storageOK) { try { localStorage.removeItem('gaitworks.probe'); } catch (e) { /* ignore */ } }
  let restored = false;
  const raw = storageOK ? lsGet(KEY_SESSION) : null;
  if (raw) {
    try { applySession(JSON.parse(raw)); restored = true; }
    catch (e) { restored = false; }
  }
  if (!restored) { rebuildNet(); lastSig = Core.topoSig(S.def); resetPopulation(); refreshAll(); }
  setTool('select'); setTab('body');
  $('#saveState').textContent = storageOK ? (restored ? 'Restored generation ' + Evo.gen : 'Autosave on') : 'Not saving: browser storage is blocked. Use Archive to export.';
  if (restored && Evo.gen > 0) toast('Picked up where you left off: generation ' + Evo.gen + '.');
  requestAnimationFrame(frame);
}
boot();
})();
