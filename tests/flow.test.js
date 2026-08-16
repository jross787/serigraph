import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap } from '../shared/model.js';
import {
  buildFlowScene,
  codeFor,
  entryPoints,
  enumerateFlows,
  makeIso,
  payloadCadence,
} from '../app/flow-core.js';

const load = (file) => parseMap(readFileSync(new URL(`../maps/${file}`, import.meta.url), 'utf8')).model;

test('entry points are steps with no incoming work, ignoring support edges', () => {
  const insurance = load('insurance.yaml');
  // producer → quote is a role handoff; prospect stays the only entrance.
  assert.deepEqual(entryPoints(insurance.root), ['prospect']);

  const brightside = load('brightside-demo.yaml');
  // marisol (role) feeds first-contact; it is still where work enters.
  assert.deepEqual(entryPoints(brightside.root), ['first-contact']);
});

test('scene ranks follow the work path and support hugs its neighbors', () => {
  const scene = buildFlowScene(load('insurance.yaml').root);
  const col = new Map(scene.nodes.map(({ node, col: c }) => [node.id, c]));

  // The spine is ordered downstream.
  assert.ok(col.get('prospect') < col.get('quote'));
  assert.ok(col.get('quote') < col.get('risk-decision'));
  assert.ok(col.get('risk-decision') < col.get('bind'));
  assert.ok(col.get('bind') < col.get('policy'));
  assert.ok(col.get('policy') < col.get('claim'));

  // Support stands next to what it touches, not at the entrance.
  assert.equal(col.get('ams'), col.get('quote') + 1); // quote → ams, ams has no outgoing
  assert.equal(col.get('adjuster'), col.get('claim') + 1);
  assert.equal(col.get('producer'), col.get('quote') - 1);

  // Every node lands on the grid exactly once.
  assert.equal(scene.nodes.length, 12);
  const seen = new Set(scene.nodes.map(({ col: c, row }) => `${c}:${row}`));
  assert.equal(seen.size, 12);
});

test('a stored flowPosition pin overrides automatic placement', () => {
  const model = parseMap([
    'name: Pinned',
    'nodes:',
    '  - {id: a, type: process, label: Start}',
    '  - {id: b, type: process, label: End, flowPosition: {col: 4.25, row: -1.5}}',
    'edges:',
    '  - {from: a, to: b}',
  ].join('\n')).model;
  const scene = buildFlowScene(model.root);
  const pinned = scene.nodes.find(({ node }) => node.id === 'b');
  assert.equal(pinned.col, 4.25);
  assert.equal(pinned.row, -1.5);
  const auto = scene.nodes.find(({ node }) => node.id === 'a');
  assert.equal(auto.col, 0);
});

test('cycles are marked as back edges and never stall layout', () => {
  const model = load('brightside-demo.yaml');
  const billing = model.byId.get('billing').children;
  const scene = buildFlowScene(billing);
  // claim-submission → denial-rework → claim-submission: exactly one edge
  // must be classified as the loop-back so layering terminates.
  const backs = scene.edges.filter(({ back }) => back);
  assert.equal(backs.length, 1);
  assert.equal(backs[0].edge.from, 'denial-rework');
  assert.equal(backs[0].edge.to, 'claim-submission');
});

test('flows walk entry to exit along the work path and survive loops', () => {
  const flows = enumerateFlows(load('insurance.yaml').root);
  assert.ok(flows.length >= 3);
  for (const flow of flows) {
    assert.equal(flow.nodeIds[0], 'prospect');
    assert.equal(flow.edgeIndexes.length, flow.nodeIds.length - 1);
  }
  // Flows end where the work path ends: claim → adjuster is a support
  // handoff, so the claims flow ends at the claim step itself.
  const ends = new Set(flows.map((flow) => flow.nodeIds[flow.nodeIds.length - 1]));
  assert.ok(ends.has('refer'));
  assert.ok(ends.has('claim'));
  assert.ok(ends.has('renewal'));
  assert.ok(ends.has('billing'));

  const billing = load('brightside-demo.yaml').byId.get('billing').children;
  const loopFlows = enumerateFlows(billing);
  assert.ok(loopFlows.length >= 1); // the denial loop terminates
  for (const flow of loopFlows) {
    assert.equal(new Set(flow.nodeIds).size, flow.nodeIds.length); // no revisit
  }
});

test('payload cadence scales with recorded volume and never fabricates', () => {
  const neutral = payloadCadence(null, 340);
  assert.equal(neutral, 0.05); // unknown volume: one slow neutral tick
  assert.equal(payloadCadence(120, 0), 0.05); // nothing recorded anywhere
  assert.equal(payloadCadence(0, 340), 0); // recorded zero: emits nothing
  const low = payloadCadence(20, 340);
  const high = payloadCadence(340, 340);
  assert.ok(low > neutral);
  assert.ok(high > low);
  assert.ok(high <= 0.35);
});

test('legend codes are readable and unique within a scope', () => {
  const taken = new Set();
  assert.equal(codeFor('Quote & rate', taken), 'QR');
  assert.equal(codeFor('Quick review', taken), 'QU'); // QR taken
  assert.equal(codeFor('Risk acceptable?', taken), 'RA');
  assert.notEqual(codeFor('Quiet room', taken), 'QR');
  assert.equal(taken.size, 4);
});

test('isometric basis projects both axes through the same diamond', () => {
  const iso = makeIso({ unitX: 74, unitY: 37 });
  assert.deepEqual(iso(0, 0), { x: 0, y: 0 });
  assert.deepEqual(iso(1, 0), { x: 74, y: 37 });
  assert.deepEqual(iso(0, 1), { x: -74, y: 37 });
  assert.deepEqual(iso(1, 1, 10), { x: 0, y: 64 });
});
