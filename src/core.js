/* ===== Gaitworks core: physics, brain, evolution (no DOM) ===== */
const Core = (() => {
'use strict';
const DT = 1 / 60, SUB = 4, ITER = 3, G = 9.81, DAMP = 0.9992;
const MUSCLE_RATE = 10, MUSCLE_SLEW = 0.2,  MUSCLE_F = 80, MUSCLE_MASS = 0.1;
const X0 = -30, X1 = 420;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * Math.random());
}
const nodeRadius = (m) => 0.06 + 0.04 * Math.sqrt(m);

/* ---------- Terrain: one-sided polyline, bucketed by metre ---------- */
function buildTerrain(kind) {
  const pts = [], obstacles = [];
  let fn;
  if (kind === 'hurdles') {
    pts.push([X0, 0]);
    let x = 6, i = 0;
    while (x < X1 - 12) {
      const h = Math.min(6.0, 0.3 + 0.35 * i), w = 1.0;   /* a ramp: 0.3 m, 0.65 m, 1.0 m, 1.35 m ... up to 6 m */
      pts.push([x, 0], [x, h], [x + w, h], [x + w, 0]);
      obstacles.push({ x0: x, x1: x + w, h });
      x += 8 + Math.min(i, 10) * 0.6;
      i++;
    }
    pts.push([X1, 0]);
    fn = (xx) => {
      for (let k = 0; k < obstacles.length; k++) {
        const o = obstacles[k];
        if (xx >= o.x0 && xx <= o.x1) return o.h;
        if (o.x0 > xx) break;
      }
      return 0;
    };
  } else if (kind.startsWith('hills')) {
    /* Deterministic rough terrain: steep ramps, sharp ridges, vertical steps, drops, sawteeth and pits. */
    let seed = 20261029 + 7919 * (+kind.slice(5) || 0);   /* hills, hills1, hills2 ... = different layouts */
    const rnd = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    pts.push([X0, 0], [6, 0]);
    let x = 6, y = 0;
    const add = (nx, ny) => { x = nx; y = ny; pts.push([x, y]); };
    while (x < X1 - 10) {
      const d = Math.min(1, (x - 6) / 100), amp = 0.3 + 1.2 * d, r = rnd();
      const up = y < -1.2 ? 1 : y > 3.0 ? -1 : (rnd() < 0.55 ? 1 : -1);
      if (r < 0.24) {                       /* steep ramp, up to about 50 degrees */
        add(x + 1.8 + rnd() * 2.4, y + up * (0.9 + rnd() * 1.2) * amp);
        add(x + 1.5 + rnd() * 3.0, y);
      } else if (r < 0.5) {                 /* vertical step */
        add(x, y + up * (0.54 + rnd() * 0.96) * amp);
        add(x + 2.4 + rnd() * 4.0, y);
      } else if (r < 0.68) {                /* sharp ridge */
        const base = y, hp = (0.9 + rnd() * 1.05) * amp;
        add(x + 1.3 + rnd() * 1.5, base + hp);
        add(x + 1.3 + rnd() * 1.5, base);
      } else if (r < 0.86) {                /* sawteeth: a ramp then a sheer drop */
        const base = y, n = 3 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) { add(x + 1.2, base + 0.72 * amp); add(x, base); }
        add(x + 1.8, base);
      } else {                              /* pit with vertical walls */
        const base = y;
        add(x, base - 0.9 * amp); add(x + 1.5 + rnd() * 1.5, base - 0.9 * amp); add(x, base);
        add(x + 2.4, base);
      }
    }
    pts.push([X1, y]);
    fn = (xx) => {
      const Pp = pts;
      let lo = 0, hi = Pp.length - 1;
      if (xx <= Pp[0][0]) return Pp[0][1];
      if (xx >= Pp[hi][0]) return Pp[hi][1];
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Pp[mid][0] <= xx) lo = mid; else hi = mid; }
      const a = Pp[lo], b = Pp[hi], dx = b[0] - a[0];
      return dx < 1e-9 ? b[1] : a[1] + ((b[1] - a[1]) * (xx - a[0])) / dx;
    };
  } else if (kind === 'stairs') {
    /* A staircase that keeps rising; each riser is taller than the last (0.18 m, 0.225 m, ... up to 1 m). */
    pts.push([X0, 0], [6, 0]);
    let x = 6, y = 0, i = 0;
    while (x < X1 - 12) {
      const rise = Math.min(1.0, 0.18 + 0.045 * i), tread = 2.2;
      y += rise; pts.push([x, y]); x += tread; pts.push([x, y]);
      i++;
    }
    pts.push([X1, y]);
    fn = (xx) => {
      const Pp = pts;
      let lo = 0, hi = Pp.length - 1;
      if (xx <= Pp[0][0]) return Pp[0][1];
      if (xx >= Pp[hi][0]) return Pp[hi][1];
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Pp[mid][0] <= xx) lo = mid; else hi = mid; }
      const A = Pp[lo], B = Pp[hi], dx = B[0] - A[0];
      return dx < 1e-9 ? B[1] : A[1] + ((B[1] - A[1]) * (xx - A[0])) / dx;
    };
  } else {
    pts.push([X0, 0], [X1, 0]);
    fn = () => 0;
  }
  const n = pts.length - 1;
  const segs = {
    ax: new Float64Array(n), ay: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n),
    nx: new Float64Array(n), ny: new Float64Array(n), inv2: new Float64Array(n),
  };
  const bOff = Math.floor(X0) - 2, nb = Math.ceil(X1) - Math.floor(X0) + 6;
  const buckets = Array.from({ length: nb }, () => []);
  let ns = 0, maxY = -1e9;
  for (let i = 0; i < n; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    segs.ax[ns] = ax; segs.ay[ns] = ay; segs.bx[ns] = bx; segs.by[ns] = by;
    segs.nx[ns] = -dy / len; segs.ny[ns] = dx / len; segs.inv2[ns] = 1 / (len * len);
    const lo = Math.floor(Math.min(ax, bx) - 0.5) - bOff, hi = Math.floor(Math.max(ax, bx) + 0.5) - bOff;
    for (let b = Math.max(0, lo); b <= Math.min(nb - 1, hi); b++) buckets[b].push(ns);
    maxY = Math.max(maxY, ay, by);
    ns++;
  }
  return { kind, pts, segs, ns, buckets, bOff, nb, maxY, fn, obstacles };
}
const terrainCache = {};
const getTerrain = (kind) => terrainCache[kind] || (terrainCache[kind] = buildTerrain(kind));

/* ---------- Tasks ---------- */
const TASKS = {
  run: { id: 'run', label: 'Run', terrain: 'flat', duration: 12, unit: 'm', blurb: 'Farthest distance in {s} s' },
  jump: { id: 'jump', label: 'Jump', terrain: 'flat', duration: 8, unit: 'm', blurb: 'Height of the lowest joint above ground, within {s} s' },
  hurdles: { id: 'hurdles', label: 'Hurdles', terrain: 'hurdles', duration: 30, unit: 'm', blurb: 'Distance over walls growing from 0.3 m up to 6 m, in {s} s' },
  stairs: { id: 'stairs', label: 'Stairs', terrain: 'stairs', duration: 30, unit: 'm', blurb: 'Distance up a staircase whose steps keep getting taller, in {s} s' },
  hills: { id: 'hills', label: 'Hills', terrain: 'hills', variants: ['hills', 'hills1', 'hills2'], duration: 20, unit: 'm', blurb: 'Distance over slopes, steps, drops and pits that grow from small bumps to towering cliffs, in {s} s (scored on 3 different layouts)' },
};
const IDLE_PEN = 0.3;   /* score lost per second spent barely moving (after the first second) */
function taskResult(S) {
  if (S.dead) return { score: -5, metric: 0 };
  if (S.task.id === 'jump') {
    const c = Math.max(0, S.maxClear), r = Math.max(0, S.maxRise);
    return { score: 3 * c + r, metric: c };
  }
  return { score: S.cx - IDLE_PEN * S.idle, metric: S.cx };
}
function liveMetric(S) {
  if (S.task.id === 'jump') return Math.max(0, S.maxClear);
  return S.cx;
}
function hurdlesCleared(S) {
  let c = 0;
  for (const o of S.T.obstacles) if (o.x1 < S.cx) c++;
  return c;
}

/* ---------- Brain ---------- */
const ACTS = {
  tanh: Math.tanh,
  relu: (x) => (x > 0 ? x : 0.05 * x),
  sine: Math.sin,
};
function dims(def, cfg) {
  const N = def.nodes.length, M = def.muscles.length;
  return { nIn: M + (cfg.clock ? 2 : 0) + 5 * N + 6 + (cfg.memory ? M : 0) + (cfg.stuck ? 2 : 0) + 1, nOut: M };
}
function makeNet(cfg, d) {
  const sizes = [d.nIn, ...cfg.hidden, d.nOut];
  let nW = 0;
  for (let l = 0; l < sizes.length - 1; l++) nW += sizes[l + 1] * sizes[l] + sizes[l + 1];
  const bufs = sizes.map((s) => new Float64Array(s));
  const actf = ACTS[cfg.act] || Math.tanh;
  const L = sizes.length - 1;
  function forward(w, inp, out) {
    bufs[0].set(inp);
    let off = 0;
    for (let l = 0; l < L; l++) {
      const nI = sizes[l], nO = sizes[l + 1], src = bufs[l], dst = bufs[l + 1], last = l === L - 1;
      const boff = off + nO * nI;
      for (let o = 0; o < nO; o++) {
        let s = w[boff + o];
        const base = off + o * nI;
        for (let i = 0; i < nI; i++) s += w[base + i] * src[i];
        dst[o] = last ? Math.tanh(s) : actf(s);
      }
      off = boff + nO;
    }
    for (let k = 0; k < d.nOut; k++) out[k] = bufs[L][k];
  }
  return { sizes, nW, bufs, forward, cfg, d };
}
function randomGenome(net) {
  const w = new Float32Array(net.nW), s = net.sizes;
  let off = 0;
  for (let l = 0; l < s.length - 1; l++) {
    const nI = s[l], nO = s[l + 1], sd = 1.3 / Math.sqrt(nI);
    for (let j = 0; j < nI * nO; j++) w[off + j] = gauss() * sd;
    off += nI * nO + nO;
  }
  return w;
}
function mutate(w, rate, sigma) {
  for (let j = 0; j < w.length; j++) if (Math.random() < rate) w[j] += gauss() * sigma;
}
function crossover(a, b) {
  const c = new Float32Array(a.length);
  for (let j = 0; j < c.length; j++) c[j] = Math.random() < 0.5 ? a[j] : b[j];
  return c;
}
function breed(pop, scores, cfg, net) {
  const P = cfg.pop, idx = pop.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const next = [];
  const E = Math.min(cfg.elite, P, pop.length);
  for (let e = 0; e < E; e++) next.push(pop[idx[e]]);
  const pick = () => {
    let r = idx.length;
    for (let k = 0; k < cfg.tourney; k++) r = Math.min(r, Math.floor(Math.random() * idx.length));
    return pop[idx[r]];
  };
  /* Stagnation response: after ~5 generations without real progress, mutation grows step by step
     (rate, strength, fresh blood) and relaxes again as soon as the record moves. */
  const lvl = cfg.adapt ? Math.max(0, (cfg.stall || 0) - 5) : 0;
  const boost = Math.min(4, Math.pow(1.22, lvl));
  const rate = Math.min(0.4, cfg.mut * boost), sig = Math.min(1.2, cfg.sigma * Math.min(3, boost));
  const nF = Math.min(Math.round((P * Math.min(30, cfg.fresh + Math.min(6, lvl * 0.4))) / 100), P - E);
  while (next.length < P - nF) {
    const child = Float32Array.from(pick());
    const c2 = Math.random() < cfg.cross ? crossover(child, pick()) : child;
    /* every child gets its own step size (x0.3 .. x3) so both fine-tuning and big jumps are always tried */
    mutate(c2, rate, sig * Math.exp((Math.random() * 2 - 1) * 1.1));
    next.push(c2);
  }
  while (next.length < P) next.push(randomGenome(net));
  return { next, order: idx, boost };
}


/* ---------- Separable CMA-ES: adapts a step size per weight; the population is a set of samples around a moving mean ---------- */
function cmaInit(net, lam, mean, sig, prev) {
  const n = net.nW, mu = Math.max(2, lam >> 1);
  let w = [];
  for (let i = 0; i < mu; i++) w.push(Math.log(mu + 0.5) - Math.log(i + 1));
  const sw = w.reduce((p, q) => p + q, 0); w = w.map((x) => x / sw);
  const mueff = 1 / w.reduce((p, q) => p + q * q, 0);
  const cs = (mueff + 2) / (n + mueff + 5), ds = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  const cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n);
  const c1 = (2 / ((n + 1.3) * (n + 1.3) + mueff)) * (n + 2) / 3;
  const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff) / ((n + 2) * (n + 2) + mueff)) * (n + 2) / 3);
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  const keep = prev && prev.Cd && prev.Cd.length === n;
  return {
    n, lam, mu, w, mueff, cs, ds, cc, c1, cmu, chiN,
    m: Float64Array.from(mean || randomGenome(net)), sig: sig || 0.3,
    Cd: keep ? Float64Array.from(prev.Cd) : new Float64Array(n).fill(1),
    ps: keep && prev.ps ? Float64Array.from(prev.ps) : new Float64Array(n),
    pc: keep && prev.pc ? Float64Array.from(prev.pc) : new Float64Array(n),
    zs: null, ys: null,
  };
}
function cmaSample(st) {
  const { n, lam, m, sig, Cd } = st, out = [];
  st.zs = []; st.ys = [];
  for (let i = 0; i < lam; i++) {
    const z = new Float64Array(n), y = new Float64Array(n), x = new Float32Array(n);
    for (let k = 0; k < n; k++) { z[k] = gauss(); y[k] = Math.sqrt(Cd[k]) * z[k]; x[k] = m[k] + sig * y[k]; }
    st.zs.push(z); st.ys.push(y); out.push(x);
  }
  return out;
}
function cmaUpdate(st, scores) {
  const { n, mu, w, mueff, cs, ds, cc, c1, cmu, chiN, m, Cd, ps, pc } = st;
  const order = Array.from({ length: scores.length }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);   /* plain Array: scores may be a typed array */
  if (!st.zs || st.zs.length !== scores.length) return order;
  const zw = new Float64Array(n), yw = new Float64Array(n);
  for (let i = 0; i < mu; i++) { const z = st.zs[order[i]], y = st.ys[order[i]]; for (let k = 0; k < n; k++) { zw[k] += w[i] * z[k]; yw[k] += w[i] * y[k]; } }
  let pn = 0;
  for (let k = 0; k < n; k++) {
    m[k] += st.sig * yw[k];
    ps[k] = (1 - cs) * ps[k] + Math.sqrt(cs * (2 - cs) * mueff) * zw[k];
    pc[k] = (1 - cc) * pc[k] + Math.sqrt(cc * (2 - cc) * mueff) * yw[k];
    pn += ps[k] * ps[k];
  }
  pn = Math.sqrt(pn);
  for (let k = 0; k < n; k++) {
    let s2 = 0;
    for (let i = 0; i < mu; i++) { const yy = st.ys[order[i]][k]; s2 += w[i] * yy * yy; }
    Cd[k] = Math.min(25, Math.max(1e-4, (1 - c1 - cmu) * Cd[k] + c1 * pc[k] * pc[k] + cmu * s2));
  }
  st.sig = Math.min(1.5, Math.max(1e-3, st.sig * Math.exp((cs / ds) * (pn / chiN - 1))));
  st.zs = null; st.ys = null;
  return order;
}

/* ---------- Creature definition helpers ---------- */
function topoSig(def) {
  return def.nodes.length + '|' + def.bones.map((b) => b.a + '-' + b.b).join(',') + '|' + def.muscles.map((m) => (m.ak ? 'B' : 'N') + m.a + '-' + (m.bk ? 'B' : 'N') + m.b).join(',');
}
function totalMass(def) {
  let m = 0;
  def.nodes.forEach((n) => (m += n.m));
  def.bones.forEach((b) => (m += b.m));
  m += def.muscles.length * MUSCLE_MASS;
  return m;
}

/* ---------- Simulation ---------- */
function makeSim(def, taskId, genome, cfg, d, variant) {
  const task = TASKS[taskId], T = getTerrain(task.variants ? task.variants[(variant || 0) % task.variants.length] : task.terrain);
  const n = def.nodes.length, nb = def.bones.length, nm = def.muscles.length;
  const f = (k) => new Float64Array(k);
  const S = {
    task, T, variant: variant || 0, vEma: 0, recX: 0, since: 0, idle: 0, n, nb, nm, genome, cfg, t: 0, done: false, dead: false,
    x: f(n), y: f(n), px: f(n), py: f(n), im: f(n), r: f(n), mu: f(n), mass: f(n), cd: f(n), cnx: f(n), cny: f(n), touch: f(n),
    ba: new Int32Array(nb), bb: new Int32Array(nb), bl: f(nb), bm: f(nb),
    ma1: new Int32Array(nm), ma2: new Int32Array(nm), mb1: new Int32Array(nm), mb2: new Int32Array(nm), ml0: f(nm), mk: f(nm), mf: f(nm), mr: f(nm), act: f(nm), lam: f(nm), out: f(nm),
    pt: f(n), dSum: 0, tSum: 0, steps: 0,
    inp: new Float64Array(d.nIn), cx: 0, cy: 0, cvx: 0, cvy: 0, sz: 1, maxClear: 0, maxRise: 0, startCy: 0,
  };
  const nodeM = new Float64Array(n);
  for (let i = 0; i < n; i++) nodeM[i] = def.nodes[i].m;
  def.bones.forEach((b) => { nodeM[b.a] += b.m / 2; nodeM[b.b] += b.m / 2; });
  const addEnd = (i, kind) => {
    if (kind) { nodeM[def.bones[i].a] += MUSCLE_MASS / 4; nodeM[def.bones[i].b] += MUSCLE_MASS / 4; }
    else nodeM[i] += MUSCLE_MASS / 2;
  };
  def.muscles.forEach((m) => { addEnd(m.a, m.ak); addEnd(m.b, m.bk); });
  let minBot = 1e9, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, sx = 0, sm = 0;
  for (let i = 0; i < n; i++) {
    const nd = def.nodes[i], r = nodeRadius(nd.m);
    S.r[i] = r; S.mu[i] = nd.g; S.mass[i] = nodeM[i]; S.im[i] = 1 / nodeM[i];
    minBot = Math.min(minBot, nd.y - r);
    minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x);
    minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y);
    sx += nd.x * nodeM[i]; sm += nodeM[i];
  }
  const dx = -sx / sm, dy = 0.02 - minBot;
  for (let i = 0; i < n; i++) {
    S.x[i] = S.px[i] = def.nodes[i].x + dx;
    S.y[i] = S.py[i] = def.nodes[i].y + dy;
  }
  S.sz = Math.max(0.6, maxX - minX, maxY - minY);
  def.bones.forEach((b, k) => {
    S.ba[k] = b.a; S.bb[k] = b.b; S.bm[k] = b.m;
    S.bl[k] = Math.max(0.02, Math.hypot(def.nodes[b.b].x - def.nodes[b.a].x, def.nodes[b.b].y - def.nodes[b.a].y));
  });
  def.muscles.forEach((m, k) => {
    const ends = (i, kind) => (kind ? [def.bones[i].a, def.bones[i].b] : [i, -1]);
    const ea = ends(m.a, m.ak), eb = ends(m.b, m.bk);
    S.ma1[k] = ea[0]; S.ma2[k] = ea[1]; S.mb1[k] = eb[0]; S.mb2[k] = eb[1]; S.mr[k] = m.r;
    const pt = (e) => (e[1] < 0 ? [def.nodes[e[0]].x, def.nodes[e[0]].y]
      : [(def.nodes[e[0]].x + def.nodes[e[1]].x) / 2, (def.nodes[e[0]].y + def.nodes[e[1]].y) / 2]);
    const pa = pt(ea), pb = pt(eb);
    S.ml0[k] = Math.max(0.02, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
    S.mk[k] = 250 * Math.pow(12, m.s); S.mf[k] = MUSCLE_F * Math.pow(12, m.s);
  });
  /* Hinge guards: for every muscle, find joints J linked to both of its anchor joints and remember
     which side of the line J-p the joint q sits on at rest. The solver keeps it on that side. */
  const adj = Array.from({ length: n }, () => new Set());
  def.bones.forEach((b) => { adj[b.a].add(b.b); adj[b.b].add(b.a); });
  def.muscles.forEach((m) => { if (!m.ak && !m.bk) { adj[m.a].add(m.b); adj[m.b].add(m.a); } });
  const seen = new Set(), list = [];
  def.muscles.forEach((m) => {
    for (const p of endNodes(def, m.a, m.ak)) for (const q of endNodes(def, m.b, m.bk)) {
      if (p === q) continue;
      for (const J of adj[p]) {
        if (J === q || !adj[q].has(J)) continue;
        const key = J + ':' + Math.min(p, q) + ':' + Math.max(p, q);
        if (seen.has(key)) continue;
        const ax = def.nodes[p].x - def.nodes[J].x, ay = def.nodes[p].y - def.nodes[J].y;
        const bx = def.nodes[q].x - def.nodes[J].x, by = def.nodes[q].y - def.nodes[J].y;
        const sn = (ax * by - ay * bx) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
        if (Math.abs(sn) < 0.08 || list.length >= 48) continue;
        seen.add(key); list.push([J, p, q, sn > 0 ? 1 : -1]);
      }
    }
  });
  S.nh = list.length; S.hj = new Int32Array(list.length * 3); S.hs = new Float64Array(list.length);
  list.forEach((t, i) => { S.hj[3 * i] = t[0]; S.hj[3 * i + 1] = t[1]; S.hj[3 * i + 2] = t[2]; S.hs[i] = t[3]; });
  updateCom(S, true);
  S.startCy = S.cy;
  return S;
}

function updateCom(S, first) {
  let sx = 0, sy = 0, M = 0, minBot = 1e9;
  const jump = S.task.id === 'jump';
  for (let i = 0; i < S.n; i++) {
    const m = S.mass[i];
    sx += S.x[i] * m; sy += S.y[i] * m; M += m;
    if (jump) { const b = S.y[i] - S.r[i]; if (b < minBot) minBot = b; }
  }
  const ncx = sx / M, ncy = sy / M;
  if (!first) { S.cvx = (ncx - S.cx) / DT; S.cvy = (ncy - S.cy) / DT; }
  S.cx = ncx; S.cy = ncy;
  if (!(Math.abs(ncx) < 1e5 && Math.abs(ncy) < 1e3)) { S.dead = S.done = true; return; }
  if (jump) {
    if (minBot > S.maxClear) S.maxClear = minBot;
    if (ncy - S.startCy > S.maxRise) S.maxRise = ncy - S.startCy;
  }
}

const EP = new Float64Array(4);
function muscleEndpoints(S, k, o) {
  const a1 = S.ma1[k], a2 = S.ma2[k], b1 = S.mb1[k], b2 = S.mb2[k];
  if (a2 < 0) { o[0] = S.x[a1]; o[1] = S.y[a1]; } else { o[0] = (S.x[a1] + S.x[a2]) * 0.5; o[1] = (S.y[a1] + S.y[a2]) * 0.5; }
  if (b2 < 0) { o[2] = S.x[b1]; o[3] = S.y[b1]; } else { o[2] = (S.x[b1] + S.x[b2]) * 0.5; o[3] = (S.y[b1] + S.y[b2]) * 0.5; }
}
const endNodes = (def, i, kind) => (kind ? [def.bones[i].a, def.bones[i].b] : [i]);

function buildInputs(S) {
  const inp = S.inp, cfg = S.cfg, h = DT / SUB, T = S.T;
  let q = 0;
  for (let k = 0; k < S.nm; k++) {
    muscleEndpoints(S, k, EP);
    const d = Math.hypot(EP[2] - EP[0], EP[3] - EP[1]);
    inp[q++] = clamp((d / S.ml0[k] - 1) / S.mr[k], -1.5, 1.5);
  }
  if (cfg.clock) {
    const ph = 6.283185307179586 * cfg.hz * S.t;
    inp[q++] = Math.sin(ph); inp[q++] = Math.cos(ph);
  }
  const sz = S.sz, cx = S.cx, cy = S.cy;
  for (let i = 0; i < S.n; i++) {
    inp[q++] = clamp((S.x[i] - cx) / sz, -2, 2);
    inp[q++] = clamp((S.y[i] - cy) / sz, -2, 2);
    inp[q++] = clamp((S.x[i] - S.px[i]) / h / 6, -2, 2);
    inp[q++] = clamp((S.y[i] - S.py[i]) / h / 6, -2, 2);
    inp[q++] = S.touch[i];
  }
  const gh = T.fn(cx);
  inp[q++] = clamp((cy - gh) / sz, -1, 3);
  inp[q++] = clamp(S.cvx / 6, -2, 2);
  inp[q++] = clamp(S.cvy / 6, -2, 2);
  inp[q++] = clamp((T.fn(cx + 1.0) - gh) / 3.0, -2, 2);
  inp[q++] = clamp((T.fn(cx + 2.0) - gh) / 3.0, -2, 2);
  inp[q++] = clamp((T.fn(cx + 3.5) - gh) / 3.0, -2, 2);
  if (cfg.memory) for (let k = 0; k < S.nm; k++) inp[q++] = S.out[k];
  if (cfg.stuck) { inp[q++] = clamp(S.since / 2, 0, 2); inp[q++] = clamp(S.vEma / 6, -2, 2); }
  inp[q++] = 1;
}

function collideNode(S, i) {
  const T = S.T, r = S.r[i];
  let x = S.x[i], y = S.y[i];
  if (y - r > T.maxY) return;
  const bi = Math.floor(x) - T.bOff;
  if (bi < 0 || bi >= T.nb) return;
  const list = T.buckets[bi], sg = T.segs;
  for (let q = 0; q < list.length; q++) {
    const k = list[q];
    const ax = sg.ax[k], ay = sg.ay[k], abx = sg.bx[k] - ax, aby = sg.by[k] - ay;
    const t = ((x - ax) * abx + (y - ay) * aby) * sg.inv2[k];
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + abx * tc), dy = y - (ay + aby * tc);
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    let nx, ny, depth;
    if (t > 0 && t < 1) {
      nx = sg.nx[k]; ny = sg.ny[k];
      depth = r - (dx * nx + dy * ny);
    } else {
      const d = Math.sqrt(d2);
      if (d < 1e-9) { nx = sg.nx[k]; ny = sg.ny[k]; depth = r; }
      else { nx = dx / d; ny = dy / d; depth = r - d; }
    }
    x += nx * depth; y += ny * depth;
    S.cd[i] += depth; S.cnx[i] = nx; S.cny[i] = ny;
  }
  S.x[i] = x; S.y[i] = y;
}

function substep(S, h) {
  const { n, nb, nm, x, y, px, py, im, ba, bb, bl, ma1, ma2, mb1, mb2, ml0, mk, mf, mr, act, lam } = S;
  const gh = G * h * h, MAXD = 0.04;
  for (let i = 0; i < n; i++) {
    let vx = (x[i] - px[i]) * DAMP, vy = (y[i] - py[i]) * DAMP;
    vx = vx < -MAXD ? -MAXD : vx > MAXD ? MAXD : vx;
    vy = vy < -MAXD ? -MAXD : vy > MAXD ? MAXD : vy;
    px[i] = x[i]; py[i] = y[i];
    x[i] += vx; y[i] += vy - gh;
    S.cd[i] = 0;
  }
  lam.fill(0);
  const ih2 = 1 / (h * h);
  for (let it = 0; it < ITER; it++) {
    for (let k = 0; k < nm; k++) {
      const a1 = ma1[k], a2 = ma2[k], b1 = mb1[k], b2 = mb2[k];
      let ax, ay, bx, by, wa, wb;
      if (a2 < 0) { ax = x[a1]; ay = y[a1]; wa = im[a1]; }
      else { ax = (x[a1] + x[a2]) * 0.5; ay = (y[a1] + y[a2]) * 0.5; wa = (im[a1] + im[a2]) * 0.25; }
      if (b2 < 0) { bx = x[b1]; by = y[b1]; wb = im[b1]; }
      else { bx = (x[b1] + x[b2]) * 0.5; by = (y[b1] + y[b2]) * 0.5; wb = (im[b1] + im[b2]) * 0.25; }
      const dx = bx - ax, dy = by - ay;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) d = 1e-9;
      const C = d - ml0[k] * (1 + mr[k] * act[k]);
      const alpha = ih2 / mk[k];
      let dl = (-C - alpha * lam[k]) / (wa + wb + alpha);
      /* force limit: a muscle can never pull or push harder than its maximum force (lam / h^2 is the force) */
      const fc = mf[k] * h * h;
      let nl = lam[k] + dl;
      nl = nl > fc ? fc : nl < -fc ? -fc : nl;
      dl = nl - lam[k];
      lam[k] = nl;
      const nx = dx / d, ny = dy / d;
      if (a2 < 0) { x[a1] -= im[a1] * dl * nx; y[a1] -= im[a1] * dl * ny; }
      else {
        x[a1] -= im[a1] * dl * nx * 0.5; y[a1] -= im[a1] * dl * ny * 0.5;
        x[a2] -= im[a2] * dl * nx * 0.5; y[a2] -= im[a2] * dl * ny * 0.5;
      }
      if (b2 < 0) { x[b1] += im[b1] * dl * nx; y[b1] += im[b1] * dl * ny; }
      else {
        x[b1] += im[b1] * dl * nx * 0.5; y[b1] += im[b1] * dl * ny * 0.5;
        x[b2] += im[b2] * dl * nx * 0.5; y[b2] += im[b2] * dl * ny * 0.5;
      }
    }
    for (let k = 0; k < nb; k++) {
      const a = ba[k], b = bb[k];
      const dx = x[b] - x[a], dy = y[b] - y[a];
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-9) d = 1e-9;
      const c = (d - bl[k]) / (d * (im[a] + im[b]));
      x[a] += dx * c * im[a]; y[a] += dy * c * im[a];
      x[b] -= dx * c * im[b]; y[b] -= dy * c * im[b];
    }
    for (let i = 0; i < n; i++) collideNode(S, i);
  }
  keepHinges(S);
  /* Muscle axial damping: remove a share of the relative velocity along each muscle (dashpot) */
  const MD = PHYS.mdamp;
  for (let k = 0; k < nm && MD > 0; k++) {
    const a1 = ma1[k], a2 = ma2[k], b1 = mb1[k], b2 = mb2[k];
    let ax, ay, bx, by, avx, avy, bvx, bvy, wa, wb;
    if (a2 < 0) { ax = x[a1]; ay = y[a1]; avx = x[a1] - px[a1]; avy = y[a1] - py[a1]; wa = im[a1]; }
    else { ax = (x[a1] + x[a2]) * 0.5; ay = (y[a1] + y[a2]) * 0.5; avx = (x[a1] - px[a1] + x[a2] - px[a2]) * 0.5; avy = (y[a1] - py[a1] + y[a2] - py[a2]) * 0.5; wa = (im[a1] + im[a2]) * 0.25; }
    if (b2 < 0) { bx = x[b1]; by = y[b1]; bvx = x[b1] - px[b1]; bvy = y[b1] - py[b1]; wb = im[b1]; }
    else { bx = (x[b1] + x[b2]) * 0.5; by = (y[b1] + y[b2]) * 0.5; bvx = (x[b1] - px[b1] + x[b2] - px[b2]) * 0.5; bvy = (y[b1] - py[b1] + y[b2] - py[b2]) * 0.5; wb = (im[b1] + im[b2]) * 0.25; }
    const dx = bx - ax, dy = by - ay, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9) continue;
    const nx = dx / d, ny = dy / d;
    const j = -((bvx - avx) * nx + (bvy - avy) * ny) * MD / (wa + wb);
    const sa = a2 < 0 ? 1 : 0.5, sb = b2 < 0 ? 1 : 0.5;
    px[a1] += im[a1] * j * nx * sa; py[a1] += im[a1] * j * ny * sa;
    if (a2 >= 0) { px[a2] += im[a2] * j * nx * sa; py[a2] += im[a2] * j * ny * sa; }
    px[b1] -= im[b1] * j * nx * sb; py[b1] -= im[b1] * j * ny * sb;
    if (b2 >= 0) { px[b2] -= im[b2] * j * nx * sb; py[b2] -= im[b2] * j * ny * sb; }
  }
  for (let i = 0; i < n; i++) {
    const d = S.cd[i];
    if (d > 0) {
      const nx = S.cnx[i], ny = S.cny[i];
      const dx = x[i] - px[i], dy = y[i] - py[i];
      const dn = dx * nx + dy * ny, tx = dx - dn * nx, ty = dy - dn * ny;
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl > 1e-12) {
        const f = Math.min(1, (S.mu[i] * d) / tl);
        x[i] -= tx * f; y[i] -= ty * f;
      }
      S.touch[i] = 1;
    } else S.touch[i] = 0;
  }
  /* the solver and terrain pushes may add speed: cap the final speed of every node (positions stay put) */
  for (let i = 0; i < n; i++) {
    const vx = x[i] - px[i], vy = y[i] - py[i], v2 = vx * vx + vy * vy;
    if (v2 > MAXD * MAXD) { const s = MAXD / Math.sqrt(v2); px[i] = x[i] - vx * s; py[i] = y[i] - vy * s; }
  }
}

const PHYS = { mdamp: 0 };   /* muscle damping: share of relative muscle speed removed per physics step (0 = free) */
const SIN_MIN = 0.07, TH_MIN = 0.0701;
/* Hinge guard as a real constraint: when a hinge is about to fold through itself, the three joints are pushed
   apart along the angle gradient, weighted by inverse mass. The correction conserves momentum, so it cannot
   create motion from nothing (an earlier version moved a joint directly and could be exploited to skate). */
function keepHinges(S) {
  const { x, y, im, hj, hs } = S;
  for (let h = 0; h < S.nh; h++) {
    const J = hj[3 * h], p = hj[3 * h + 1], q = hj[3 * h + 2], s = hs[h];
    const ux = x[p] - x[J], uy = y[p] - y[J], vx = x[q] - x[J], vy = y[q] - y[J];
    const lu2 = ux * ux + uy * uy, lv2 = vx * vx + vy * vy;
    if (lu2 < 1e-10 || lv2 < 1e-10) continue;
    const cr = ux * vy - uy * vx, th = Math.atan2(cr, ux * vx + uy * vy);
    if ((s * cr) / Math.sqrt(lu2 * lv2) >= SIN_MIN) continue;
    const v = s * th;
    let target;
    if (v >= 0) target = v < Math.PI / 2 ? TH_MIN : Math.PI - TH_MIN;
    else target = TH_MIN - v < v + Math.PI + TH_MIN ? TH_MIN : Math.PI - TH_MIN;
    let C = th - s * target;
    C -= Math.round(C / 6.283185307179586) * 6.283185307179586;
    if (C > 0.6) C = 0.6; else if (C < -0.6) C = -0.6;
    const gpx = uy / lu2, gpy = -ux / lu2, gqx = -vy / lv2, gqy = vx / lv2;
    const gjx = -(gpx + gqx), gjy = -(gpy + gqy);
    const den = im[p] * (gpx * gpx + gpy * gpy) + im[q] * (gqx * gqx + gqy * gqy) + im[J] * (gjx * gjx + gjy * gjy);
    if (den < 1e-12) continue;
    const lam = -C / den;
    x[p] += im[p] * lam * gpx; y[p] += im[p] * lam * gpy;
    x[q] += im[q] * lam * gqx; y[q] += im[q] * lam * gqy;
    x[J] += im[J] * lam * gjx; y[J] += im[J] * lam * gjy;
  }
}

function stepSim(S, net) {
  if (S.done) return;
  buildInputs(S);
  net.forward(S.genome, S.inp, S.out);
  const k = Math.min(1, DT * MUSCLE_RATE);
  for (let m = 0; m < S.nm; m++) {
    let d = (S.out[m] - S.act[m]) * k;
    d = d > MUSCLE_SLEW ? MUSCLE_SLEW : d < -MUSCLE_SLEW ? -MUSCLE_SLEW : d;
    S.act[m] += d;
  }
  const h = DT / SUB;
  for (let s = 0; s < SUB; s++) substep(S, h);
  S.t += DT;
  /* behaviour statistics for the gait archive: share of joints on the ground, and how often contacts change */
  let tc = 0, tr = 0;
  for (let i = 0; i < S.n; i++) { const tt = S.touch[i]; tc += tt; if (tt !== S.pt[i]) tr++; S.pt[i] = tt; }
  S.dSum += tc / S.n; S.tSum += tr; S.steps++;
  updateCom(S, false);
  if (S.dead) return;
  /* progress tracking: seconds since the furthest point moved on by 0.2 m, and an averaged speed */
  S.vEma += (S.cvx - S.vEma) * (DT / 1.0);
  if (S.cx > S.recX + 0.2) { S.recX = S.cx; S.since = 0; } else S.since += DT;
  if (S.since > 1) S.idle += DT;
  for (let i = 0; i < S.n; i++) if (!(S.y[i] > -3)) { S.dead = S.done = true; return; }
  if (S.t >= S.task.duration - 1e-9 || S.cx > X1 - 8 || S.cx < X0 + 4) S.done = true;
}

/* Behaviour descriptor, both axes in 0..1: [ground contact share, contact changes per joint per second / 3] */
function behaviour(S) {
  if (!S.steps || S.t <= 0) return [0, 0];
  return [clamp(S.dSum / S.steps, 0, 1), clamp(S.tSum / (S.n * S.t) / 3, 0, 1)];
}
function evaluate(def, taskId, genome, net) {
  const V = TASKS[taskId].variants ? TASKS[taskId].variants.length : 1;
  let sc = 0, me = 0, d0 = 0, d1 = 0;
  for (let v = 0; v < V; v++) {
    const S = makeSim(def, taskId, genome, net.cfg, net.d, v);
    while (!S.done) stepSim(S, net);
    const r = taskResult(S), b = behaviour(S);
    sc += r.score; me += r.metric; d0 += b[0]; d1 += b[1];
  }
  return { score: sc / V, metric: me / V, desc: [d0 / V, d1 / V] };
}

/* ---------- Gait archive (MAP-Elites): the best brain found for every distinct style of moving ---------- */
const ARCH_N = 8;
function archiveNew() { return { n: ARCH_N, cells: new Array(ARCH_N * ARCH_N).fill(null) }; }
function archiveCell(d) {
  const c = (v) => Math.min(ARCH_N - 1, Math.max(0, Math.floor(v * ARCH_N)));
  return c(d[1]) * ARCH_N + c(d[0]);
}
function archiveAdd(a, g, score, metric, desc, gen) {
  if (!Number.isFinite(score) || score <= -4.99 || !desc || !Number.isFinite(desc[0] + desc[1])) return false;
  const k = archiveCell(desc), c = a.cells[k];
  if (c && c.score >= score) return false;
  a.cells[k] = { score, metric, desc: [desc[0], desc[1]], gen, g: Float32Array.from(g) };
  return true;
}
function archiveCount(a) { let c = 0; for (const x of a.cells) if (x) c++; return c; }
/* a random elite from the better half of the archive (null when empty) */
function archivePick(a) {
  const f = a.cells.filter(Boolean);
  if (!f.length) return null;
  f.sort((p, q) => q.score - p.score);
  return f[Math.floor(Math.random() * Math.max(1, Math.ceil(f.length / 2)))];
}

/* ---------- Presets ---------- */
const nd = (x, y, m = 0.4, g = 0.8) => ({ x, y, m, g });
const bn = (a, b, m = 1) => ({ a, b, m });
const mu = (a, b, s = 0.55, r = 0.3) => ({ a, b, s, r });
const PRESETS = {
  crawler: {
    label: 'Crawler',
    note: 'A box with muscles for sides and diagonals. Learns fast.',
    def: {
      nodes: [nd(-0.4, 0.1, 0.5, 1), nd(0.4, 0.1, 0.5, 1), nd(-0.4, 0.8, 0.4, 0.6), nd(0.4, 0.8, 0.4, 0.6)],
      bones: [bn(0, 1, 1.2), bn(2, 3, 0.8)],
      muscles: [mu(0, 2), mu(1, 3), mu(0, 3), mu(1, 2)],
    },
  },
  strider: {
    label: 'Strider',
    note: 'An A-frame on two legs with a swinging torso.',
    def: {
      nodes: [nd(0, 0.95, 0.6, 0.8), nd(-0.45, 0.08, 0.5, 1.1), nd(0.45, 0.08, 0.5, 1.1), nd(0, 1.5, 0.5, 0.5)],
      bones: [bn(0, 1, 1), bn(0, 2, 1), bn(0, 3, 0.8)],
      muscles: [mu(3, 1), mu(3, 2), mu(1, 2)],
    },
  },
  biped: {
    label: 'Biped',
    note: 'Hips and knees. Hard to balance, rewarding when it works.',
    def: {
      nodes: [nd(0, 1.3, 0.5, 0.5), nd(0, 0.8, 0.6, 0.6), nd(-0.2, 0.45, 0.4, 0.6), nd(-0.3, 0.08, 0.5, 1.2), nd(0.2, 0.45, 0.4, 0.6), nd(0.3, 0.08, 0.5, 1.2)],
      bones: [bn(0, 1, 1.2), bn(1, 2, 0.9), bn(2, 3, 0.8), bn(1, 4, 0.9), bn(4, 5, 0.8)],
      muscles: [mu(0, 2), mu(0, 4), mu(1, 3), mu(1, 5)],
    },
  },
  inchworm: {
    label: 'Inchworm',
    note: 'Sticky feet, a springy arch. Wins by grip, not by speed.',
    def: {
      nodes: [nd(-0.6, 0.1, 0.6, 1.4), nd(-0.2, 0.5, 0.4, 0.3), nd(0.2, 0.5, 0.4, 0.3), nd(0.6, 0.1, 0.6, 1.4)],
      bones: [bn(0, 1, 0.8), bn(2, 3, 0.8)],
      muscles: [mu(1, 2, 0.6, 0.35), mu(0, 3, 0.6, 0.35), mu(0, 2, 0.6, 0.3), mu(1, 3, 0.6, 0.3)],
    },
  },
};

return {
  DT, SUB, X0, X1, TASKS, PRESETS, ACTS, MUSCLE_MASS, clamp, gauss, nodeRadius,
  getTerrain, dims, makeNet, randomGenome, mutate, breed, cmaInit, cmaSample, cmaUpdate, topoSig, totalMass,
  ARCH_N, archiveNew, archiveCell, archiveAdd, archiveCount, archivePick, behaviour,
  PHYS, makeSim, stepSim, evaluate, muscleEndpoints, endNodes, taskResult, liveMetric, hurdlesCleared,
};
})();
if (typeof module !== 'undefined') module.exports = Core;
