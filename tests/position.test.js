// Pinned positions: parsing, validation, and the set/clear edit operations.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

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
