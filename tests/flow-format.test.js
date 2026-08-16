// Flow view fields: a node's flowPosition grid pin, and an edge's kind and
// issue. Parsing, validation, and the set/clear edit operations. Mirrors
// via.test.js — flowPosition is presentation metadata on a node, additive
// and removable, exactly like a node's position pin.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

const BASE = `# flow-format test map — top comment
name: Flow
nodes:
  # the first node
  - id: intake
    type: process
    label: Intake # inline comment
  - id: qualify
    type: decision
    label: Qualified?
    flowPosition: { col: 2, row: 1 }
  - id: bind
    type: process
    label: Bind

edges:
  - from: intake
    to: qualify
  - from: qualify
    to: bind
    label: approved
    kind: api
    issue: Times out under load.
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

test('parseMap reads flowPosition, kind, and issue as model fields', () => {
  const { model, errors } = parseMap(BASE);
  assert.equal(errors.length, 0);
  assert.deepEqual(model.root.nodes[1].flowPosition, { col: 2, row: 1 });
  assert.equal(model.root.nodes[0].flowPosition, null, 'unpinned nodes keep automatic Flow placement');
  assert.equal(model.root.edges[1].kind, 'api');
  assert.equal(model.root.edges[1].issue, 'Times out under load.');
  assert.equal(model.root.edges[0].kind, null, 'edges without a kind stay null');
  assert.equal(model.root.edges[0].issue, null, 'edges without an issue stay null');
});

test('parseMap trims issue and reads a blank issue as null', () => {
  const { model, errors } = parseMap(BASE.replace('issue: Times out under load.', 'issue: "   "'));
  assert.equal(errors.length, 0);
  assert.equal(model.root.edges[1].issue, null, 'whitespace-only issue means no known problem');
});

test('parseMap rejects malformed flowPosition values', () => {
  for (const bad of ['flowPosition: hello', 'flowPosition: [1, 2]', 'flowPosition: { col: 1 }', 'flowPosition: { col: a, row: 2 }']) {
    const { errors } = parseMap(BASE.replace('flowPosition: { col: 2, row: 1 }', bad));
    assert.ok(errors.some((e) => /"flowPosition:"/.test(e.message)), `flags: ${bad}`);
  }
});

test('parseMap rejects an unknown kind', () => {
  const { errors } = parseMap(BASE.replace('kind: api', 'kind: pigeon'));
  assert.ok(errors.some((e) => /"kind:" must be one of/.test(e.message)));
});

test('parseMap rejects a non-string issue', () => {
  const { errors } = parseMap(BASE.replace('issue: Times out under load.', 'issue: 42'));
  assert.ok(errors.some((e) => /"issue:" must be a string/.test(e.message)));
});

test('setNodeFlowPosition writes a one-line flow map, rounded, comments intact', () => {
  edit.setNodeFlowPosition('intake', { col: 1.234, row: 2.567 }, null);
  const { out, model } = reserialize();
  assert.deepEqual(model.root.nodes[0].flowPosition, { col: 1.23, row: 2.57 });
  assert.ok(out.includes('flowPosition: { col: 1.23, row: 2.57 }'), 'one-line flow map');
  for (const c of ['# flow-format test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }
});

test('setNodeFlowPosition updates an existing pin in place', () => {
  edit.setNodeFlowPosition('qualify', { col: 5, row: -1 }, null);
  const { out, model } = reserialize();
  assert.deepEqual(model.root.nodes[1].flowPosition, { col: 5, row: -1 });
  assert.equal((out.match(/flowPosition:/g) ?? []).length, 1, 'still exactly one flowPosition key');
});

test('clearNodeFlowPosition removes the field and is a no-op when absent', () => {
  edit.clearNodeFlowPosition('qualify', null);
  const { out, model } = reserialize();
  assert.equal(model.root.nodes[1].flowPosition, null);
  assert.ok(!out.includes('flowPosition:'), 'flowPosition key gone from the file');

  edit.clearNodeFlowPosition('intake', null); // never had one — must not throw
  reserialize();
});
