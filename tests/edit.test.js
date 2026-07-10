import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';

const BASE = `# Acme map — hand comment at top
name: Acme
description: test map

nodes:
  # first stage
  - id: intake
    type: process
    label: Intake # inline comment
    children:
      nodes:
        - id: parse
          type: process
          label: Parse
      edges: []
  - id: qualify
    type: decision
    label: Qualified?

edges:
  - from: intake
    to: qualify
`;

function load(src = BASE) {
  const { doc, model, errors } = parseMap(src);
  assert.equal(errors.length, 0);
  state.doc = doc;
  state.model = model;
  state.source = src;
  state.standalone = false;
}

function reserialize() {
  const out = state.doc.toString();
  const { model, errors } = parseMap(out);
  assert.deepEqual(errors, [], 'edit must keep the file valid');
  return { out, model };
}

beforeEach(() => load());

test('addNode at root and nested keeps comments', () => {
  edit.addNode(null, { id: 'fund', type: 'process', label: 'Funding', description: 'wires money' });
  edit.addNode('intake', { id: 'dedupe', type: 'process', label: 'Dedupe' });
  const { out, model } = reserialize();
  assert.ok(model.byId.get('fund'));
  assert.equal(model.byId.get('dedupe').ownerId, 'intake');
  for (const c of ['# Acme map — hand comment at top', '# first stage', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }
});

test('addNode creates children container on leaf nodes', () => {
  edit.addNode('qualify', { id: 'sub', type: 'process', label: 'Sub' });
  const { model } = reserialize();
  assert.equal(model.byId.get('sub').ownerId, 'qualify');
  assert.equal(model.byId.get('qualify').stats.childCount, 1);
});

test('updateNode edits fields and manages links', () => {
  edit.updateNode('parse', {
    label: 'Parse & extract',
    description: 'regex + LLM fallback',
    links: [{ label: 'Repo', url: 'https://github.com/acme/parse-agent' }],
  });
  const { model } = reserialize();
  const n = model.byId.get('parse');
  assert.equal(n.label, 'Parse & extract');
  assert.equal(n.links[0].url, 'https://github.com/acme/parse-agent');

  edit.updateNode('parse', { links: [] });
  const { model: m2 } = reserialize();
  assert.equal(m2.byId.get('parse').links.length, 0);
});

test('deleteNode removes node, its edges, and empty children container', () => {
  edit.deleteNode('qualify');
  const { out, model } = reserialize();
  assert.ok(!model.byId.has('qualify'));
  assert.equal(model.root.edges.length, 0, 'edge referencing deleted node removed');

  load(out);
  edit.deleteNode('parse');
  const { out: out2, model: m2 } = reserialize();
  assert.ok(!m2.byId.get('intake').children, 'empty children container cleaned up');
  assert.ok(!out2.includes('children:'), 'children key gone from file');
});

test('addEdge / updateEdge / deleteEdge', () => {
  edit.addNode(null, { id: 'fund', type: 'process', label: 'Funding' });
  edit.addEdge(null, { from: 'qualify', to: 'fund', label: 'yes' });
  let { model } = reserialize();
  assert.equal(model.root.edges.length, 2);
  assert.equal(model.root.edges[1].label, 'yes');

  state.model = model;
  edit.updateEdge(null, 1, { label: 'approved' });
  ({ model } = reserialize());
  assert.equal(model.root.edges[1].label, 'approved');

  state.model = model;
  edit.deleteEdge(null, 1);
  ({ model } = reserialize());
  assert.equal(model.root.edges.length, 1);
});

test('insertTemplate renames colliding ids everywhere (nodes + edges)', () => {
  const tpl = parseMap(`
name: Tpl
nodes:
  - id: intake
    type: process
    label: Tpl Intake
  - id: route
    type: process
    label: Route
edges:
  - from: intake
    to: route
`);
  const inserted = edit.insertTemplate(null, tpl.model);
  const { model } = reserialize();
  assert.deepEqual(inserted, ['intake-2', 'route']);
  assert.ok(model.byId.get('intake-2'), 'colliding id renamed');
  const e = model.root.edges.find((x) => x.to === 'route');
  assert.equal(e.from, 'intake-2', 'edge endpoint follows the rename');
});

test('slugify and uniqueId', () => {
  assert.equal(edit.slugify('Verify Bank Statements!'), 'verify-bank-statements');
  assert.equal(edit.slugify('Café — Zürich'), 'cafe-zurich');
  load();
  assert.equal(edit.uniqueId(state.model, 'intake'), 'intake-2');
  assert.equal(edit.uniqueId(state.model, 'fresh'), 'fresh');
});
