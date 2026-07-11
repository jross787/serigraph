// moveNode: re-nesting with the edge re-homing policy (see FORMAT.md).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

const BASE = `# move test map — top comment
name: Move
nodes:
  - id: intake
    type: process
    label: Intake
  - id: uw
    type: process
    label: Underwriting # a container
    children:
      nodes:
        - id: credit
          type: process
          label: Credit check
        - id: fraud
          type: process
          label: Fraud check
          position: { x: 300, y: 40 }
      edges:
        - from: credit
          to: fraud
          label: then
  - id: fund
    type: process
    label: Funding
  - id: notes
    type: artifact
    label: Notes file

edges:
  - from: intake
    to: uw
  - from: uw
    to: fund
    label: approved
  - from: intake
    to: fund
    label: fast lane
`;

function load(src = BASE) {
  const { doc, model, errors } = parseMap(src);
  assert.deepEqual(errors, []);
  state.doc = doc;
  state.model = model;
  state.source = src;
  state.standalone = false;
}

function reserialize() {
  const out = state.doc.toString({ lineWidth: 0 });
  const { model, errors } = parseMap(out);
  assert.deepEqual(errors, [], `move must keep the file valid, got:\n${out}`);
  return { out, model };
}

beforeEach(() => load());

test('move a root node into a container: nesting rewritten, nothing else', () => {
  const r = edit.moveNode('notes', 'uw');
  assert.equal(r.moved, true);
  const { out, model } = reserialize();
  assert.equal(model.byId.get('notes').ownerId, 'uw');
  assert.equal(model.root.nodes.length, 3);
  assert.ok(out.includes('# move test map — top comment'), 'comments intact');
  assert.ok(out.includes('# a container'), 'inline comment intact');
});

test('move into container lifts edges to the container (endpoint rewrite in place)', () => {
  edit.moveNode('fund', 'uw');
  const { model } = reserialize();
  assert.equal(model.byId.get('fund').ownerId, 'uw');
  // uw→fund (approved) becomes self-loop uw→uw → dropped;
  // intake→fund (fast lane) becomes intake→uw, label kept
  const rootEdges = model.root.edges.map((e) => `${e.from}>${e.to}:${e.label}`);
  assert.deepEqual(rootEdges.sort(), ['intake>uw:', 'intake>uw:fast lane'].sort());
});

test('move out of a container lifts inner edges up to the parent scope', () => {
  edit.moveNode('fraud', null);
  const { out, model } = reserialize();
  assert.equal(model.byId.get('fraud').ownerId, null);
  // credit→fraud (then) lived inside uw; now lifts to root as uw→fraud, label kept
  const rootEdges = model.root.edges.map((e) => `${e.from}>${e.to}:${e.label}`);
  assert.ok(rootEdges.includes('uw>fraud:then'), `lifted edge present: ${rootEdges}`);
  assert.equal(model.byId.get('uw').children.edges.length, 0, 'inner edge moved out');
  assert.equal(model.byId.get('fraud').position, null, 'pinned position cleared on move');
  assert.ok(!out.includes('position:'), 'position field gone from the file');
});

test('moved container keeps its subtree and inner edges', () => {
  edit.moveNode('uw', null); // no-op: already at root
  const r = edit.moveNode('intake', 'uw');
  assert.equal(r.moved, true);
  // now move the container uw (with intake inside) — wait, move fund in first
  const { model } = reserialize();
  assert.equal(model.byId.get('intake').ownerId, 'uw');
  assert.equal(model.byId.get('uw').children.edges.length, 1, 'inner edge kept');
  assert.deepEqual(
    model.byId.get('uw').children.nodes.map((n) => n.id).sort(),
    ['credit', 'fraud', 'intake'].sort(),
  );
});

test('exact duplicate after lift is dropped, near-duplicate (different label) kept', () => {
  load(`
name: Dup
nodes:
  - id: a
    type: process
    label: A
  - id: c
    type: process
    label: C
    children:
      nodes:
        - id: k
          type: process
          label: K
      edges: []
  - id: x
    type: process
    label: X
edges:
  - from: a
    to: c
    label: go
  - from: a
    to: x
    label: go
  - from: a
    to: x
    label: other
`);
  // move x INTO c: a→x(go) lifts to a→c(go) = exact dup of existing → dropped;
  // a→x(other) lifts to a→c(other) → kept
  const r = edit.moveNode('x', 'c');
  assert.equal(r.moved, true);
  assert.equal(r.dropped, 1);
  assert.equal(r.lifted, 1);
  const { model } = reserialize();
  const edges = model.root.edges.map((e) => `${e.from}>${e.to}:${e.label}`).sort();
  assert.deepEqual(edges, ['a>c:go', 'a>c:other'].sort());
});

test('two identical edges lifting to the same edge collapse to one', () => {
  load(`
name: Twin
nodes:
  - id: a
    type: process
    label: A
  - id: c
    type: process
    label: C
    children:
      nodes:
        - id: k
          type: process
          label: K
      edges: []
  - id: x
    type: process
    label: X
edges:
  - from: a
    to: x
  - from: a
    to: x
`);
  edit.moveNode('x', 'c');
  const { model } = reserialize();
  const edges = model.root.edges.map((e) => `${e.from}>${e.to}`);
  assert.deepEqual(edges, ['a>c'], 'twin edges collapsed to one lifted edge');
});

test('guards: cannot move into itself or its own subtree; no-op keeps file identical', () => {
  assert.throws(() => edit.moveNode('uw', 'uw'), /into itself/);
  assert.throws(() => edit.moveNode('uw', 'credit'), /own sub-map/);
  const before = state.doc.toString({ lineWidth: 0 });
  const r = edit.moveNode('credit', 'uw'); // already there
  assert.equal(r.moved, false);
  assert.equal(state.doc.toString({ lineWidth: 0 }), before, 'no-op left the doc untouched');
});

test('moving the last child cleans up the empty children container', () => {
  edit.moveNode('fraud', null);
  edit.moveNode('credit', null);
  const { out, model } = reserialize();
  assert.ok(!model.byId.get('uw').children, 'container became a leaf');
  assert.ok(!out.includes('children:'), 'children key gone');
});

test('move works on LIST-form children (regression guard)', () => {
  load(`
name: L
nodes:
  - id: a
    type: process
    label: A
    children:
      - id: b
        type: process
        label: B
      - id: c
        type: process
        label: C
  - id: z
    type: process
    label: Z
`);
  edit.moveNode('b', null);
  const { model } = reserialize();
  assert.equal(model.byId.get('b').ownerId, null);
  assert.equal(model.byId.get('a').stats.childCount, 1);
  // and INTO a list-form container
  state.model = model;
  edit.moveNode('z', 'a');
  const { model: m2 } = reserialize();
  assert.equal(m2.byId.get('z').ownerId, 'a');
});

test('deep move: out of a nested-nested scope lifts edge to nearest common scope', () => {
  load(`
name: Deep
nodes:
  - id: top
    type: process
    label: Top
    children:
      nodes:
        - id: mid
          type: process
          label: Mid
          children:
            nodes:
              - id: leafA
                type: process
                label: Leaf A
              - id: leafB
                type: process
                label: Leaf B
            edges:
              - from: leafA
                to: leafB
                label: inner
      edges: []
  - id: other
    type: process
    label: Other
`);
  // move leafB two levels up to root: edge leafA→leafB lifts to nearest common
  // scope of (leafA under top/mid) and (leafB at root) = root, endpoints top→leafB
  edit.moveNode('leafB', null);
  const { model } = reserialize();
  const rootEdges = model.root.edges.map((e) => `${e.from}>${e.to}:${e.label}`);
  assert.ok(rootEdges.includes('top>leafB:inner'), `lifted to root: ${rootEdges}`);
  assert.equal(model.byId.get('mid').children.edges.length, 0);
});
