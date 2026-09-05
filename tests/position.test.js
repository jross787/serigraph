// Pinned positions: parsing, validation, and the set/clear edit operations.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';
import { routeAutomaticEdges, routeDirect, EDGE_LABEL_SIZE } from '../app/layout.js';

const BASE = `# pinned-position test map — top comment
name: Pins
nodes:
  # the first node
  - id: intake
    type: process
    label: Intake # inline comment
    description: A deliberately long single-line description that would wrap if the serializer applied its default 80-column line width to untouched content.
    children:
      nodes:
        - id: parse
          type: process
          label: Parse
      edges: []
  - id: qualify
    type: decision
    label: Qualified?
    position: { x: 640, y: -120 }

edges:
  - from: intake
    to: qualify
`;

function load(src = BASE) {
  const { doc, model, errors } = parseMap(src);
  assert.deepEqual(errors, []);
  state.doc = doc;
  state.model = model;
  state.source = src;
  state.standalone = false;
}

// serialize the way the app does (controller.commit)
function reserialize() {
  const out = state.doc.toString({ lineWidth: 0 });
  const { model, errors } = parseMap(out);
  assert.deepEqual(errors, [], 'edit must keep the file valid');
  return { out, model };
}

beforeEach(() => load());

test('parseMap reads position as the node model field', () => {
  const n = state.model.byId.get('qualify');
  assert.deepEqual(n.position, { x: 640, y: -120 });
  assert.equal(state.model.byId.get('intake').position, null);
});

test('parseMap rejects malformed position values', () => {
  for (const bad of ['position: hello', 'position: [1, 2]', 'position: { x: 1 }', 'position: { x: a, y: 2 }']) {
    const { errors } = parseMap(`name: Bad\nnodes:\n  - id: a\n    type: process\n    label: A\n    ${bad}\n`);
    assert.ok(errors.length === 1, `rejected: ${bad}`);
    assert.match(errors[0].message, /position/);
  }
});

test('setNodePosition writes a one-line flow map, rounded, comments intact', () => {
  edit.setNodePosition('parse', { x: 120.7, y: 88.2 });
  const { out, model } = reserialize();
  assert.deepEqual(model.byId.get('parse').position, { x: 121, y: 88 });
  assert.ok(out.includes('position: { x: 121, y: 88 }'), 'one-line flow map');
  for (const c of ['# pinned-position test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }
});

test('setNodePosition never re-wraps long lines it did not touch', () => {
  edit.setNodePosition('parse', { x: 10, y: 20 });
  const { out } = reserialize();
  assert.ok(
    out.includes('description: A deliberately long single-line description that would wrap if the serializer applied its default 80-column line width to untouched content.'),
    'long description stayed on one line',
  );
});

test('setNodePosition updates an existing pin in place', () => {
  edit.setNodePosition('qualify', { x: 5, y: 6 });
  const { out, model } = reserialize();
  assert.deepEqual(model.byId.get('qualify').position, { x: 5, y: 6 });
  assert.equal((out.match(/position:/g) ?? []).length, 1);
});

test('position sits before children in key order', () => {
  edit.setNodePosition('intake', { x: 1, y: 2 });
  const { out } = reserialize();
  const block = out.slice(out.indexOf('- id: intake'), out.indexOf('- id: qualify'));
  const order = ['id:', 'type:', 'label:', 'description:', 'position:', 'children:'].map((k) => block.indexOf(k));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `key #${i} in order (${order.join(',')})`);
  }
});

test('clearNodePosition removes the field and is a no-op when absent', () => {
  edit.clearNodePosition('qualify');
  const { out, model } = reserialize();
  assert.equal(model.byId.get('qualify').position, null);
  assert.ok(!out.includes('position:'), 'field gone from the file');
  edit.clearNodePosition('qualify'); // second call must not throw
});

test('updateNode leaves an existing position untouched', () => {
  edit.updateNode('qualify', { label: 'Qualified??', description: 'now with words' });
  const { out, model } = reserialize();
  assert.deepEqual(model.byId.get('qualify').position, { x: 640, y: -120 });
  assert.ok(out.includes('position: { x: 640, y: -120 }'));
});

test('automatic fan-in aligns labels and square arrivals without moving pins or replacing explicit routes', () => {
  for (const direction of [1, -1]) {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `source-${i}`, x: direction > 0 ? 0 : 520, y: i * 96, w: 200, h: 64, pinned: true }));
    const target = { id: 'target', x: direction > 0 ? 520 : 0, y: 192, w: 200, h: 64, pinned: true };
    nodes.push(target);
    const before = structuredClone(nodes);
    const edges = nodes.slice(0, 6).map((n, i) => ({
      index: i, edge: { from: n.id, to: target.id, label: `Description ${i}` }, ...routeDirect(n, target),
    }));
    const fallback = structuredClone(edges);
    routeAutomaticEdges(nodes, edges);
    assert.deepEqual(nodes, before, 'routing never moves nodes or modifies pins');
    assert.equal(new Set(edges.map(e => e.labelPos.x)).size, 1, 'one label column');
    assert.equal(new Set(edges.map(e => e.points.at(-1).y)).size, edges.length, 'separate arrival ports');
    for (const [i, e] of edges.entries()) {
      assert.equal(e.labelPos.y, nodes[i].y + nodes[i].h / 2, 'label stays on its source row');
      assert.equal(e.points.at(-1).x, direction > 0 ? target.x : target.x + target.w);
      assert.equal(e.points.at(-1).y, e.points.at(-2).y, 'arrow enters horizontally');
      assert.ok(Math.abs(e.points[1].x - e.labelPos.x) >= EDGE_LABEL_SIZE.w / 2 + 12, 'label clears the turn');
      for (let j = 1; j < e.points.length; j++) {
        assert.ok(e.points[j].x === e.points[j - 1].x || e.points[j].y === e.points[j - 1].y, 'orthogonal segments');
      }
    }
    const repeat = structuredClone(edges);
    routeAutomaticEdges(nodes, edges);
    assert.deepEqual(edges, repeat, 'routing is deterministic');

    edges[0].edge.route = 'straight';
    edges[1].edge.via = { x: 380, y: -60 };
    const explicit = structuredClone(edges.slice(0, 2));
    routeAutomaticEdges(nodes, edges);
    assert.deepEqual(edges.slice(0, 2), explicit, 'explicit routes win');

    const obstacle = { id: 'obstacle', x: direction > 0 ? 260 : 360, y: 260, w: 60, h: 72 };
    const changed = routeAutomaticEdges([...nodes, obstacle], edges);
    assert.deepEqual(edges.slice(0, 2), explicit, 'obstructions do not replace explicit routes');
    for (let i = 2; i < edges.length; i++) {
      assert.deepEqual(edges[i].points, fallback[i].points, 'a newly obstructed corridor restores the fallback');
      assert.ok(changed.has(edges[i]), 'fallback restoration requests a redraw during dragging');
    }
  }
  const a = { id: 'a', x: 0, y: 0, w: 200, h: 64 };
  const b = { id: 'b', x: 248, y: 0, w: 200, h: 64 };
  const unlabeled = { index: 0, edge: { from: a.id, to: b.id }, points: [], labelPos: {} };
  routeAutomaticEdges([a, b], [unlabeled]);
  assert.ok(unlabeled.labelPos.x > a.x + a.w && unlabeled.labelPos.x < b.x, 'an unlabeled route seed stays between cards');
  assert.equal(unlabeled.labelPos.y, 32, 'seed lies on the horizontal route');
});
