// Sanity tests for the physics core: scoring is deterministic, the physics never produces non-finite numbers,
// the speed cap holds, and a short CMA-ES run improves on its first generation.
const assert = require('assert');
const Core = require('../src/core.js');

const cfg = { hidden: [8], act: 'tanh', clock: true, hz: 1.5, memory: false, stuck: true };
const def = JSON.parse(JSON.stringify(Core.PRESETS.strider.def));
const net = Core.makeNet(cfg, Core.dims(def, cfg));

// Deterministic scoring: the same brain always gets the same score.
const g = Core.randomGenome(net);
assert.strictEqual(Core.evaluate(def, 'run', g, net).score, Core.evaluate(def, 'run', g, net).score);

// Every task runs to completion with finite scores.
for (const task of Object.keys(Core.TASKS)) {
  const r = Core.evaluate(def, task, Core.randomGenome(net), net);
  assert.ok(Number.isFinite(r.score) && Number.isFinite(r.metric), 'finite score for ' + task);
}

// No node may exceed the speed cap (0.04 m per substep).
const S = Core.makeSim(def, 'run', g, net.cfg, net.d, 0);
let vmax = 0;
while (!S.done) {
  Core.stepSim(S, net);
  for (let i = 0; i < S.n; i++) vmax = Math.max(vmax, Math.hypot(S.x[i] - S.px[i], S.y[i] - S.py[i]));
}
assert.ok(vmax <= 0.0401, 'speed cap holds, saw ' + vmax);

// CMA-ES improves over its first generation.
const st = Core.cmaInit(net, 24, null, 0.3);
let first = null, best = -Infinity;
for (let gen = 0; gen < 12; gen++) {
  const pop = Core.cmaSample(st), scores = pop.map((p) => Core.evaluate(def, 'run', p, net).score);
  if (first === null) first = Math.max(...scores);
  best = Math.max(best, ...scores);
  Core.cmaUpdate(st, scores);
}
assert.ok(best > first, 'CMA-ES improved: ' + first.toFixed(2) + ' -> ' + best.toFixed(2));
// Gait archive: descriptors are in range, better brains replace worse ones in a cell, dead scores are rejected.
const ev = Core.evaluate(def, 'run', g, net);
assert.ok(ev.desc.every((v) => v >= 0 && v <= 1), 'descriptor in range');
const arch = Core.archiveNew();
assert.ok(Core.archiveAdd(arch, g, 1, 1, [0.3, 0.3], 0));
assert.ok(!Core.archiveAdd(arch, g, 0.5, 0.5, [0.3, 0.3], 1), 'worse brain does not replace');
assert.ok(Core.archiveAdd(arch, g, 2, 2, [0.3, 0.3], 2), 'better brain replaces');
assert.ok(!Core.archiveAdd(arch, g, -5, 0, [0.9, 0.9], 3), 'dead creature rejected');
assert.ok(Core.archiveAdd(arch, g, 1, 1, [0.9, 0.1], 4));
assert.strictEqual(Core.archiveCount(arch), 2);
assert.ok(Core.archivePick(arch));
console.log('core tests passed (first gen best ' + first.toFixed(2) + ', after 12 gens ' + best.toFixed(2) + ')');
