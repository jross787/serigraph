// Cost model: parsing, pure math, roll-ups, and the edit operations.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { nodeCost, rollupCost, formatMoney, formatPayback } from '../shared/cost.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

const BASE = `# cost test map — top comment
name: Costs
description: test
costModel: { currency: USD, defaultRate: 60 }

nodes:
  # the fully-costed step
  - id: intake
    type: process
    label: Intake # inline comment
    cost:
      runs: 120
      human: { minutes: 15, rate: 65 }
      agent: { perRun: 0.4, setup: 1200 }
  - id: review
    type: process
    label: Review
    cost:
      runs: 200
      human: { minutes: 30 }
      agent: { perRun: 1.5 }
  - id: partial
    type: process
    label: Partial
    cost:
      human: { minutes: 10, rate: 50 }
  - id: uncosted
    type: process
    label: Uncosted
  - id: crm
    type: system
    label: CRM
    cost:
      runs: 10
      human: { minutes: 6, rate: 100 }
      agent: { perRun: 0 }
    children:
      nodes:
        - id: deep
          type: process
          label: Deep step
          cost:
            runs: 50
            human: { minutes: 12, rate: 90 }
            agent: { perRun: 2, setup: 300 }
      edges: []

edges:
  - from: intake
    to: review
`;

function load(src = BASE) {
  const { doc, model, errors } = parseMap(src);
  assert.deepEqual(errors, [], `fixture must parse: ${JSON.stringify(errors)}`);
  state.doc = doc;
  state.model = model;
  state.source = src;
  state.standalone = false;
  return model;
}

function reserialize() {
  const out = state.doc.toString({ lineWidth: 0 });
  const { model, errors } = parseMap(out);
  assert.deepEqual(errors, [], `edit must keep the file valid, got:\n${out}`);
  return { out, model };
}

beforeEach(() => load());

// ── pure math ────────────────────────────────────────────────────────
test('nodeCost computes per-run and monthly figures', () => {
  const m = state.model;
  const r = nodeCost(m.byId.get('intake'), m.costModel);
  assert.equal(r.humanPerRun, 16.25);           // 15/60 * 65
  assert.equal(r.agentPerRun, 0.4);
  assert.equal(r.humanMonthly, 1950);           // 16.25 * 120
  assert.equal(r.agentMonthly, 48);             // 0.4 * 120
  assert.equal(r.savingsMonthly, 1902);
  assert.equal(r.setup, 1200);
  assert.equal(r.complete, true);
});

test('defaultRate fills a missing human.rate; explicit rate wins', () => {
  const m = state.model;
  const review = nodeCost(m.byId.get('review'), m.costModel);
  assert.equal(review.rate, 60);                // from costModel.defaultRate
  assert.equal(review.humanPerRun, 30);         // 30/60 * 60
  assert.equal(review.complete, true);
  const intake = nodeCost(m.byId.get('intake'), m.costModel);
  assert.equal(intake.rate, 65);                // node value beats default
});

test('partial data is unknown, never zero', () => {
  const m = state.model;
  const r = nodeCost(m.byId.get('partial'), m.costModel);
  assert.equal(r.complete, false);
  assert.ok(Math.abs(r.humanPerRun - 10 / 60 * 50) < 1e-9); // per-run still computable
  assert.equal(r.humanMonthly, null);           // no runs → unknown
  assert.equal(r.agentMonthly, null);
  assert.equal(r.savingsMonthly, null);
  assert.ok(r.missing.includes('runs'));
  assert.ok(r.missing.includes('agent.perRun'));
  assert.equal(nodeCost(m.byId.get('uncosted'), m.costModel), null);
});

test('zero runs and zero perRun are valid inputs, not unknowns', () => {
  const m = load(`
name: Z
nodes:
  - id: a
    type: process
    label: A
    cost:
      runs: 0
      human: { minutes: 10, rate: 60 }
      agent: { perRun: 0 }
`);
  const r = nodeCost(m.byId.get('a'), m.costModel);
  assert.equal(r.complete, true);
  assert.equal(r.humanMonthly, 0);
  assert.equal(r.agentMonthly, 0);
  assert.equal(r.savingsMonthly, 0);
});

// ── roll-up ──────────────────────────────────────────────────────────
test('rollup sums only fully-costed nodes at every depth; identity holds', () => {
  const m = state.model;
  const r = rollupCost(m);
  // costed monthly (human/agent): intake 1950/48, review 6000/300, crm 100/0, deep 900/100
  assert.equal(r.costedCount, 4);
  assert.equal(r.humanMonthly, 1950 + 6000 + 100 + 900);   // 8950
  assert.equal(r.agentMonthly, 48 + 300 + 0 + 100);        // 448
  assert.equal(r.savingsMonthly, r.humanMonthly - r.agentMonthly); // 8502
  assert.equal(r.setupTotal, 1500);             // 1200 + 300
  assert.deepEqual(r.partialIds, ['partial']);
  // coverage counts process nodes: intake, review, partial, uncosted, deep = 5; costed process = 3
  assert.equal(r.processCount, 5);
  assert.equal(r.costedProcessCount, 3);
  assert.ok(Math.abs(r.paybackMonths - 1500 / 8502) < 1e-12);
  assert.ok(Math.abs(r.roiFirstYear - (8502 * 12 - 1500) / 1500) < 1e-9);
});

test('payback edge cases', () => {
  const mk = (cost) => load(`
name: P
nodes:
  - id: a
    type: process
    label: A
    cost:
${cost}
`);
  // savings 0, setup > 0 → never
  let r = rollupCost(mk('      runs: 10\n      human: { minutes: 6, rate: 10 }\n      agent: { perRun: 1, setup: 500 }'));
  assert.equal(r.savingsMonthly, 0);
  assert.equal(r.paybackMonths, Infinity);
  // agent costs MORE than human → never, even with no setup
  r = rollupCost(mk('      runs: 10\n      human: { minutes: 6, rate: 10 }\n      agent: { perRun: 5 }'));
  assert.ok(r.savingsMonthly < 0);
  assert.equal(r.paybackMonths, Infinity);
  // positive savings, no setup anywhere → immediate
  r = rollupCost(mk('      runs: 10\n      human: { minutes: 60, rate: 100 }\n      agent: { perRun: 1 }'));
  assert.equal(r.paybackMonths, 0);
  assert.equal(r.roiFirstYear, null);           // no setup → ROI undefined, not ∞
  // empty map → everything null
  r = rollupCost(load('name: E\nnodes:\n  - id: a\n    type: process\n    label: A\n'));
  assert.equal(r.costedCount, 0);
  assert.equal(r.humanMonthly, null);
  assert.equal(r.savingsMonthly, null);
  assert.equal(r.paybackMonths, null);
});

// ── formatting ───────────────────────────────────────────────────────
test('formatting helpers', () => {
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney(0), '$0');
  assert.equal(formatMoney(0.4), '$0.40');
  assert.equal(formatMoney(1902), '$1,902');
  assert.equal(formatMoney(1902, 'EUR'), '€1,902');
  assert.equal(formatPayback(null), '—');
  assert.equal(formatPayback(Infinity), 'never');
  assert.equal(formatPayback(0), 'immediate');
  assert.equal(formatPayback(0.5), '15 days');
  assert.equal(formatPayback(3.2), '3.2 mo');
  assert.equal(formatPayback(30), '2.5 yr');
});

// ── parsing/validation ───────────────────────────────────────────────
test('negative and non-numeric cost values are validation errors', () => {
  for (const bad of [
    'cost: { runs: -1 }',
    'cost: { human: { minutes: fast } }',
    'cost: { agent: { perRun: "0.4x" } }',
    'cost: [1, 2]',
    'cost: { human: [1] }',
  ]) {
    const { errors } = parseMap(`name: B\nnodes:\n  - id: a\n    type: process\n    label: A\n    ${bad}\n`);
    assert.ok(errors.length >= 1, `rejected: ${bad}`);
    assert.match(errors[0].message, /cost/i);
  }
  const { errors } = parseMap('name: B\ncostModel: { currency: DOLLARS }\nnodes: []\n');
  assert.ok(errors.length === 1 && /currency/.test(errors[0].message));
});

test('an empty cost block parses as no data', () => {
  const m = load('name: E\nnodes:\n  - id: a\n    type: process\n    label: A\n    cost: {}\n');
  assert.equal(m.byId.get('a').cost, null);
});

// ── edit operations ──────────────────────────────────────────────────
test('setNodeCost writes the block (flow sub-maps), merges, clears; comments survive', () => {
  edit.setNodeCost('uncosted', { runs: 40, minutes: 20, rate: 80, perRun: 0.25 });
  let { out, model } = reserialize();
  assert.ok(out.includes('human: { minutes: 20, rate: 80 }'), `flow style human:\n${out}`);
  assert.ok(out.includes('agent: { perRun: 0.25 }'), 'flow style agent');
  assert.equal(nodeCost(model.byId.get('uncosted'), model.costModel).humanMonthly, (20 / 60) * 80 * 40);
  assert.ok(out.includes('# cost test map — top comment'));
  assert.ok(out.includes('# inline comment'));

  // merge: update one field, keep the rest
  state.model = model;
  edit.setNodeCost('uncosted', { perRun: 0.5 });
  ({ out, model } = reserialize());
  assert.ok(out.includes('agent: { perRun: 0.5 }'));
  assert.ok(out.includes('human: { minutes: 20, rate: 80 }'), 'human untouched by merge');

  // clear a single field with null
  state.model = model;
  edit.setNodeCost('uncosted', { rate: null });
  ({ out, model } = reserialize());
  assert.ok(out.includes('human: { minutes: 20 }'), 'rate removed');

  // clear everything → block gone
  state.model = model;
  edit.setNodeCost('uncosted', { runs: null, minutes: null, perRun: null, setup: null });
  ({ out, model } = reserialize());
  const block = out.slice(out.indexOf('- id: uncosted'), out.indexOf('- id: crm'));
  assert.ok(!block.includes('cost:'), `cost block removed:\n${block}`);
});

test('setNodeCost rejects negatives with a useful error', () => {
  assert.throws(() => edit.setNodeCost('uncosted', { runs: -5 }), /must be a number ≥ 0/);
  assert.throws(() => edit.setNodeCost('uncosted', { minutes: 'abc' }), /must be a number ≥ 0/);
});

test('cost sits between links and position in key order', () => {
  edit.setNodePosition('uncosted', { x: 10, y: 20 });
  edit.setNodeCost('uncosted', { runs: 5, minutes: 5, rate: 50, perRun: 1 });
  const { out } = reserialize();
  const block = out.slice(out.indexOf('- id: uncosted'), out.indexOf('- id: crm'));
  const order = ['id:', 'type:', 'label:', 'cost:', 'position:'].map((k) => block.indexOf(k));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `key #${i} in order (${order.join(',')})`);
});

test('setMapCostModel writes a one-liner before nodes; clears when emptied', () => {
  load('name: CM\nnodes:\n  - id: a\n    type: process\n    label: A\n');
  edit.setMapCostModel({ currency: 'eur', defaultRate: 72.5 });
  let { out, model } = reserialize();
  assert.ok(out.includes('costModel: { currency: EUR, defaultRate: 72.5 }'), out);
  assert.ok(out.indexOf('costModel:') < out.indexOf('nodes:'), 'costModel above nodes');
  assert.equal(model.costModel.currency, 'EUR');

  state.model = model;
  edit.setMapCostModel({});
  ({ out, model } = reserialize());
  assert.ok(!out.includes('costModel:'));
  assert.equal(model.costModel, null);
});

test('setMapCostModel validates inputs', () => {
  assert.throws(() => edit.setMapCostModel({ currency: 'dollars' }), /3-letter/);
  assert.throws(() => edit.setMapCostModel({ defaultRate: -2 }), /≥ 0/);
});
