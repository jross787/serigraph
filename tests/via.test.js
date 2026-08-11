// Pinned edge routes (via points): parsing, validation, and the set/clear
// edit operations. Mirrors position.test.js — a via is presentation metadata
// on an edge, additive and removable, exactly like a node's position pin.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

const BASE = `# via test map — top comment
name: Routes
nodes:
  # the first node
  - id: intake
    type: process
    label: Intake # inline comment
  - id: qualify
    type: decision
    label: Qualified?
  - id: bind
    type: process
    label: Bind

edges:
  - from: intake
    to: qualify
  - from: qualify
    to: bind
    label: approved
    via: { x: 700, y: 40 }
`;

function load(src = BASE) {
  const { doc, model, errors } = parseMap(src);
  assert.equal(errors.length, 0);
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

test('parseMap reads via as the edge model field', () => {
  const { model, errors } = parseMap(BASE);
  assert.equal(errors.length, 0);
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[0].via, null, 'unpinned edges keep automatic routing');
});

test('parseMap rejects malformed via values', () => {
  for (const bad of ['via: hello', 'via: [1, 2]', 'via: { x: 1 }', 'via: { x: a, y: 2 }']) {
    const { errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', bad));
    assert.ok(errors.some((e) => /"via:"/.test(e.message)), `flags: ${bad}`);
  }
});

test('setEdgeVia writes a one-line flow map, rounded, comments intact', () => {
  edit.setEdgeVia(null, 0, { x: 260.4, y: 39.6 });
  const { out, model } = reserialize();
  assert.deepEqual(model.root.edges[0].via, { x: 260, y: 40 });
  assert.ok(out.includes('via: { x: 260, y: 40 }'), 'one-line flow map');
  for (const c of ['# via test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }
});

test('setEdgeVia updates an existing pin in place', () => {
  edit.setEdgeVia(null, 1, { x: 640, y: -120 });
  const { out, model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 640, y: -120 });
  assert.equal((out.match(/via:/g) ?? []).length, 1, 'still exactly one via key');
});

test('clearEdgeVia removes the field and is a no-op when absent', () => {
  edit.clearEdgeVia(null, 1);
  const { out, model } = reserialize();
  assert.equal(model.root.edges[1].via, null);
  assert.ok(!out.includes('via:'), 'via key gone from the file');

  edit.clearEdgeVia(null, 0); // never had one — must not throw
  reserialize();
});

test('updateEdge leaves an existing via untouched', () => {
  edit.updateEdge(null, 1, { label: 'approved by credit' });
  const { model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[1].label, 'approved by credit');
});

test('via survives on an edge inside a nested scope', () => {
  load(`
name: Nested routes
nodes:
  - id: wrap
    type: process
    label: Wrapper
    children:
      nodes:
        - id: a
          type: process
          label: A
        - id: b
          type: process
          label: B
      edges:
        - from: a
          to: b
`);
  edit.setEdgeVia('wrap', 0, { x: 100, y: 50 });
  const { model } = reserialize();
  assert.deepEqual(model.byId.get('wrap').children.edges[0].via, { x: 100, y: 50 });
});

test('parseMap reads route as the edge model field', () => {
  const { model, errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', 'via: { x: 700, y: 40 }\n    route: stepped'));
  assert.equal(errors.length, 0);
  assert.equal(model.root.edges[1].route, 'stepped');
  assert.equal(model.root.edges[0].route, null, 'unstyled edges keep automatic routing');
});

test('parseMap rejects an unknown route style', () => {
  const { errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', 'route: wiggly'));
  assert.ok(errors.some((e) => /"route:" must be one of/.test(e.message)));
});

test('setEdgeRoute writes and clears the style, comments intact', () => {
  edit.setEdgeRoute(null, 0, 'angled');
  const { out, model } = reserialize();
  assert.equal(model.root.edges[0].route, 'angled');
  assert.ok(out.includes('route: angled'));
  for (const c of ['# via test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }

  edit.setEdgeRoute(null, 0, null);
  const { out: out2, model: m2 } = reserialize();
  assert.equal(m2.root.edges[0].route, null);
  assert.ok(!out2.includes('route:'), 'route key gone from the file');
});

test('updateEdge leaves an existing via and route untouched', () => {
  load(BASE.replace('via: { x: 700, y: 40 }', 'via: { x: 700, y: 40 }\n    route: curved'));
  edit.updateEdge(null, 1, { label: 'approved by credit' });
  const { model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[1].route, 'curved');
  assert.equal(model.root.edges[1].label, 'approved by credit');
});
