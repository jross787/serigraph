import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, NODE_TYPES, EDGE_MEANINGS } from '../shared/model.js';
import { NODE_VISUALS, CONNECTION_MEANINGS, connectionPresentation } from '../shared/visual-language.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';
import { routeDirect } from '../app/layout.js';
import { buildFlowScene, enumerateFlows } from '../app/flow-core.js';

const SOURCE = `# Synthetic decision example
name: Studio
nodes:
  - {id: start, type: event, label: Request received}
  - {id: decide, type: decision, label: Ready?}
  - {id: finish, type: process, label: Fulfill request}
  - {id: team, type: role, label: Service team}
edges:
  - {from: start, to: decide, meaning: flow}
  # Keep this branch and its route
  - {from: decide, to: finish, label: Ready, via: {x: 410, y: 240}, toSide: bottom}
  - {from: decide, to: start, label: Needs detail, meaning: flow}
  - {from: decide, to: team, label: owned by, meaning: association}
  - {from: decide, to: finish, label: Decision record, meaning: data, kind: api}
`;
function load(source = SOURCE) {
  const parsed = parseMap(source);
  assert.deepEqual(parsed.errors, []);
  Object.assign(state, { doc: parsed.doc, model: parsed.model, source, standalone: false });
  return parsed.model;
}
function roundtrip() {
  const source = state.doc.toString();
  return { source, model: load(source) };
}

test('the authoring vocabulary covers every valid shape and connection meaning', () => {
  assert.deepEqual(Object.keys(NODE_VISUALS).sort(), [...NODE_TYPES].sort());
  assert.deepEqual(Object.keys(CONNECTION_MEANINGS).sort(), [...EDGE_MEANINGS].sort());
  for (const type of NODE_TYPES) {
    const source = `name: Types\nmode: freeform\nelements: [{id: example, type: ${type}, label: Example}]\nnodes: [{id: group, type: item, label: Group, children: {nodes: [{use: example}]}}]\n`;
    assert.deepEqual(parseMap(source).errors, [], `${type} is also valid as a shared element`);
  }
  for (const meaning of EDGE_MEANINGS) {
    const model = load(SOURCE.replace('meaning: association', `meaning: ${meaning}`));
    assert.equal(model.root.edges[3].meaning, meaning);
  }
  assert.ok(parseMap(SOURCE.replace('meaning: association', 'meaning: healthy')).errors.some(e => /meaning/.test(e.message)));
  const legacy = load().root.edges[1];
  assert.equal(legacy.meaning, null);
  assert.equal(connectionPresentation(legacy).arrow, true);
  assert.match(connectionPresentation({ label: 'Data transfer', kind: 'api' }).label, /unspecified/);
  assert.equal(connectionPresentation({ meaning: 'association' }).arrow, false);
  assert.equal(connectionPresentation({ meaning: 'data' }).stroke, 'dashed');
});

test('decision Apply preserves incoming/other relationships and comments while editing one branch list', () => {
  const before = load();
  const unrelated = [0, 3, 4].map(i => before.root.edges[i]);
  edit.setDecisionOutcomes(null, 'decide', [
    { index: 1, label: 'Approved', to: 'finish' },
    { label: 'Return to intake', to: 'start' },
  ]);
  const { source, model } = roundtrip();
  const kept = model.root.edges.find(e => e.label === 'Approved');
  assert.equal(kept.meaning, 'flow');
  assert.deepEqual(kept.via, { x: 410, y: 240 });
  assert.equal(kept.toSide, 'bottom');
  assert.match(source, /# Keep this branch and its route/);
  assert.match(source, /# Synthetic decision example/);
  assert.ok(!model.root.edges.some(e => e.label === 'Needs detail'));
  assert.ok(model.root.edges.some(e => e.label === 'Return to intake' && e.to === 'start'));
  for (const edge of unrelated) assert.ok(model.root.edges.some(e => e.from === edge.from && e.to === edge.to && e.label === edge.label && e.meaning === edge.meaning && e.kind === edge.kind));
});

test('invalid outcome lists fail before mutating the YAML; an empty applied list only removes branches', () => {
  load();
  const original = state.doc.toString();
  for (const rows of [
    [{ label: '', to: 'finish' }],
    [{ label: 'Ready', to: 'elsewhere' }],
    [{ label: 'Ready', to: 'finish' }, { label: 'ready', to: 'start' }],
    [{ index: 3, label: 'Ready', to: 'finish' }],
    [{ index: 1, label: 'Ready', to: 'finish' }, { index: 1, label: 'Again', to: 'start' }],
  ]) {
    assert.throws(() => edit.setDecisionOutcomes(null, 'decide', rows));
    assert.equal(state.doc.toString(), original);
  }
  edit.setDecisionOutcomes(null, 'decide', []);
  assert.deepEqual(roundtrip().model.root.edges.map(e => e.meaning), ['flow', 'association', 'data']);
});

test('Freeform decision outcomes belong to the placement scope, not every occurrence of the decision', () => {
  load(`name: Shared process\nmode: freeform\nelements:\n  - {id: decision, type: decision, label: Ready?}\n  - {id: end, type: event, label: Complete}\nnodes:\n  - id: first\n    type: item\n    label: First group\n    children:\n      nodes: [{use: decision}, {use: end}]\n      edges: []\n  - id: second\n    type: item\n    label: Second group\n    children:\n      nodes: [{use: decision}, {use: end}]\n      edges: [{from: decision, to: end, label: Existing}]\n`);
  edit.setDecisionOutcomes('first', 'decision', [{ label: 'Ready', to: 'end' }]);
  const { model } = roundtrip();
  assert.equal(model.byId.get('first').children.edges[0].meaning, 'flow');
  assert.equal(model.byId.get('second').children.edges[0].label, 'Existing');
  assert.equal(model.byId.get('second').children.edges[0].meaning, null);
  assert.equal(model.elementById.size, 2);
});

test('connection meaning and transfer method remain independent and removable', () => {
  load();
  const ref = { scopeId: null, index: 1 };
  edit.setEdgeMeaning(ref, 'data'); edit.setEdgeKind(ref, 'file');
  let edge = roundtrip().model.root.edges[1];
  assert.equal(edge.meaning, 'data'); assert.equal(edge.kind, 'file');
  assert.deepEqual(edge.via, { x: 410, y: 240 });
  edit.setEdgeMeaning(ref, null); edit.setEdgeKind(ref, null);
  edge = roundtrip().model.root.edges[1];
  assert.equal(edge.meaning, null); assert.equal(edge.kind, null);
  assert.throws(() => edit.setEdgeMeaning(ref, 'healthy'));
  assert.throws(() => edit.setEdgeKind(ref, 'flow'));
  edit.addEdge(null, { from: 'start', to: 'decide', meaning: 'association' });
  roundtrip();
  assert.throws(() => edit.addEdge(null, { from: 'start', to: 'decide', meaning: 'association' }), /already exists/);
  assert.equal(state.model.root.edges.filter(e => e.from === 'start' && e.to === 'decide').length, 2, 'a different relationship is not a duplicate');
});

test('events can start work paths; structural associations and reporting lines do not become flow', () => {
  const model = load();
  model.root.edges = model.root.edges.filter(edge => edge.label !== 'Needs detail');
  model.root.edges.push({ from: 'finish', to: 'team', meaning: 'reports-to' });
  const scene = buildFlowScene(model.root);
  assert.ok(scene.entries.includes('start'));
  assert.ok(scene.edges.every(({ edge }) => !['association', 'reports-to'].includes(edge.meaning)));
  assert.ok(enumerateFlows(model.root).every(path => !path.nodeIds.includes('team')));
});

test('shape-aware endpoints clip to circles, capsule ends, cylinder caps, hexagons and document folds', () => {
  const box = (type, w = 200, h = 64) => ({ x: 0, y: 0, w, h, node: { type } });
  const target = { x: 420, y: -240, w: 200, h: 64, node: { type: 'process' } };
  const circle = box('event', 112, 112);
  const c = routeDirect(circle, target).points[0];
  assert.ok(Math.abs(Math.hypot(c.x - 56, c.y - 56) - 56) < 1e-8);
  for (const type of ['role', 'database', 'api', 'artifact']) {
    const n = box(type);
    for (const b of [target, { ...target, x: 450, y: -50 }, { ...target, x: -450, y: 90 }]) {
      const p = routeDirect(n, b).points[0];
      assert.ok(p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 64, `${type} in footprint`);
      if (type === 'api') assert.ok(Math.abs(Math.abs(p.x - 100) + 16 * Math.abs(p.y - 32) / 32 - 100) < 1e-7 || Math.abs(p.y - 32) === 32);
      if (type === 'role' && (p.x < 32 || p.x > 168)) assert.ok(Math.abs(Math.hypot(p.x - (p.x < 100 ? 32 : 168), p.y - 32) - 32) < 1e-7);
      if (type === 'database' && (p.y < 10 || p.y > 54)) assert.ok(Math.abs(((p.x - 100) / 100) ** 2 + ((p.y - (p.y < 32 ? 10 : 54)) / 10) ** 2 - 1) < 1e-7);
      if (type === 'artifact') assert.ok(p.x - p.y <= 187 + 1e-7);
    }
    assert.deepEqual(routeDirect(n, target, { fromSide: 'bottom' }).points[0], { x: 100, y: 64 });
  }
});
