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
    owner: 'Automation team',
    trigger: 'New email',
    sla: '10 minutes',
    automation: 'assisted',
    systems: ['Outlook', 'Salesforce'],
    links: [{ label: 'Repo', url: 'https://github.com/acme/parse-agent' }],
  });
  const { model } = reserialize();
  const n = model.byId.get('parse');
  assert.equal(n.label, 'Parse & extract');
  assert.equal(n.links[0].url, 'https://github.com/acme/parse-agent');
  assert.equal(n.owner, 'Automation team');
  assert.equal(n.automation, 'assisted');
  assert.deepEqual(n.systems, ['Outlook', 'Salesforce']);

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

test('deleteNode removes cross-scope relations and dependencies to the deleted subtree', () => {
  load(`
name: Product deletion
document: { kind: prd }
nodes:
  - id: group
    type: process
    label: Group
    children:
      nodes:
        - id: target
          type: artifact
          label: Target
          children:
            - id: nested-target
              type: artifact
              label: Nested target
  - id: keeper
    type: process
    label: Keeper
    planning:
      type: requirement
      dependsOn: [target, nested-target]
    relations:
      - { to: target, type: supports }
      - { to: nested-target, type: validated-by }
edges: []
`);
  edit.deleteNode('group');
  const { out, model } = reserialize();
  assert.ok(!model.byId.has('group'));
  assert.ok(!model.byId.has('target'));
  assert.ok(!model.byId.has('nested-target'));
  assert.deepEqual(model.byId.get('keeper').planning.dependsOn, []);
  assert.deepEqual(model.byId.get('keeper').relations, []);
  assert.ok(!out.includes('dependsOn:'), 'empty dependency list is removed');
  assert.ok(!out.includes('relations:'), 'empty relation list is removed');
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

test('deleteNode works on LIST-form children (regression)', () => {
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
`);
  edit.deleteNode('b');
  const { model } = reserialize();
  assert.ok(!model.byId.has('b'), 'b really deleted');
  assert.ok(model.byId.has('c'), 'sibling kept');
  assert.equal(model.byId.get('a').stats.childCount, 1);
});

test('updateNode keeps key order: description/links before children (regression)', () => {
  edit.updateNode('intake', {
    description: 'container description',
    links: [{ label: 'Doc', url: 'https://example.com' }],
  });
  const { out } = reserialize();
  const block = out.slice(out.indexOf('- id: intake'), out.indexOf('- id: qualify'));
  const order = ['id:', 'type:', 'label:', 'description:', 'links:', 'children:']
    .map((k) => block.indexOf(k));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `key #${i} in order (${order.join(',')})`);
  }
});

test('review notes persist, resolve, and stay in the predictable YAML order', () => {
  const id = edit.addReviewComment('qualify', {
    body: 'Confirm the decline path before implementation.',
    author: 'Sam',
    createdAt: '2026-07-18T10:00:00.000Z',
  });
  let { out, model } = reserialize();
  assert.deepEqual(model.byId.get('qualify').review, [{
    id,
    body: 'Confirm the decline path before implementation.',
    author: 'Sam',
    createdAt: '2026-07-18T10:00:00.000Z',
    resolved: false,
  }]);
  const block = out.slice(out.indexOf('- id: qualify'));
  assert.ok(block.indexOf('review:') < block.indexOf('edges:'), 'review stays with the node');

  state.model = model;
  edit.setReviewResolved('qualify', id, true);
  ({ model } = reserialize());
  assert.equal(model.byId.get('qualify').review[0].resolved, true);
});

test('updateDocument creates, normalizes, and clears product-document metadata', () => {
  edit.updateDocument({
    kind: 'prd',
    version: ' 1.2 ',
    summary: ' A living release contract ',
    owner: ' Product Ops ',
    status: 'in-progress',
    updated: '2026-07-18',
    audience: [' Product ', '', 'Engineering'],
    goals: ['One graph for product truth'],
    nonGoals: [' Replace delivery tracking '],
    successMetrics: ['Every requirement has proof'],
  });
  let { out, model } = reserialize();
  assert.deepEqual(model.document, {
    kind: 'prd',
    version: '1.2',
    summary: 'A living release contract',
    owner: 'Product Ops',
    status: 'in-progress',
    updated: '2026-07-18',
    audience: ['Product', 'Engineering'],
    goals: ['One graph for product truth'],
    nonGoals: ['Replace delivery tracking'],
    successMetrics: ['Every requirement has proof'],
  });
  assert.match(out, /^document:/m, 'metadata is written as a top-level YAML field');

  edit.updateDocument({
    kind: '', version: '', summary: '', owner: '', status: '', updated: '',
    audience: [], goals: [], nonGoals: [], successMetrics: [],
  });
  ({ out, model } = reserialize());
  assert.equal(model.document.kind, 'process', 'removing kind returns to the legacy default');
  assert.equal(model.document.summary, '');
  assert.deepEqual(model.document.audience, []);
  assert.match(out, /document:\s*\{\}/, 'an empty metadata map remains valid and explicit');
});

test('updateNode round-trips planning, dependencies, RICE, and typed relations', () => {
  edit.updateNode('qualify', {
    owner: 'Product',
    planning: {
      type: 'requirement',
      status: 'planned',
      priority: 'must',
      phase: 'now',
      target: 'v1.2',
      acceptance: [' Approval is visible ', 'Decision is traceable'],
      evidence: ['Design partner review'],
      risks: ['Policy ambiguity'],
      dependsOn: ['intake'],
      rice: { reach: '100', impact: 3, confidence: 85, effort: 5 },
    },
    relations: [
      { to: 'intake', type: 'supports' },
      { to: '', type: 'measured-by' },
    ],
  });
  let { out, model } = reserialize();
  const node = model.byId.get('qualify');
  assert.deepEqual(node.planning, {
    type: 'requirement',
    status: 'planned',
    priority: 'must',
    phase: 'now',
    target: 'v1.2',
    acceptance: ['Approval is visible', 'Decision is traceable'],
    evidence: ['Design partner review'],
    risks: ['Policy ambiguity'],
    dependsOn: ['intake'],
    rice: { reach: 100, impact: 3, confidence: 85, effort: 5 },
  });
  assert.deepEqual(node.relations, [{ to: 'intake', type: 'supports' }]);
  const block = out.slice(out.indexOf('- id: qualify'), out.indexOf('\nedges:'));
  const planningIndex = block.indexOf('planning:');
  const relationsIndex = block.indexOf('relations:');
  assert.ok(planningIndex > block.indexOf('owner:'));
  assert.ok(relationsIndex > planningIndex);

  edit.updateNode('qualify', { planning: null, relations: [] });
  ({ out, model } = reserialize());
  assert.equal(model.byId.get('qualify').planning, null);
  assert.deepEqual(model.byId.get('qualify').relations, []);
  assert.ok(!out.slice(out.indexOf('- id: qualify'), out.indexOf('\nedges:')).includes('planning:'));
});

test('updateNode rejects invalid RICE values before they can be serialized', () => {
  assert.throws(() => edit.updateNode('qualify', {
    planning: { type: 'requirement', rice: { reach: 10, impact: 2, confidence: 101, effort: 0 } },
  }), /planning\.rice\.(confidence|effort) has an invalid value/);
});

test('insertTemplate preserves rich metadata and rewrites dependencies, relations, and edges after collisions', () => {
  const template = parseMap(`
name: Product slice
nodes:
  - id: intake
    type: artifact
    label: Template requirement
    description: A reusable requirement slice.
    owner: Product Design
    trigger: Approved brief
    sla: This quarter
    automation: assisted
    systems: [Linear, GitHub]
    links:
      - label: Source
        url: https://example.com/source
    planning:
      type: requirement
      status: planned
      priority: must
      phase: next
      target: v2
      acceptance: [The capability ships]
      evidence: [Customer evidence]
      risks: [Scope growth]
      dependsOn: [parse]
      rice: { reach: 80, impact: 3, confidence: 75, effort: 6 }
    relations:
      - to: parse
        type: supports
    review:
      - id: product-review
        body: Confirm the release boundary
        author: PM
  - id: parse
    type: process
    label: Template objective
    planning:
      type: objective
      status: validated
edges:
  - from: parse
    to: intake
    label: enables
`);
  assert.deepEqual(template.errors, []);

  const inserted = edit.insertTemplate(null, template.model);
  const { model } = reserialize();
  assert.deepEqual(inserted, ['intake-2', 'parse-2']);
  const requirement = model.byId.get('intake-2');
  assert.equal(requirement.description, 'A reusable requirement slice.');
  assert.equal(requirement.owner, 'Product Design');
  assert.equal(requirement.trigger, 'Approved brief');
  assert.equal(requirement.sla, 'This quarter');
  assert.equal(requirement.automation, 'assisted');
  assert.deepEqual(requirement.systems, ['Linear', 'GitHub']);
  assert.equal(requirement.links[0].url, 'https://example.com/source');
  assert.equal(requirement.review[0].id, 'product-review');
  assert.deepEqual(requirement.planning.dependsOn, ['parse-2']);
  assert.deepEqual(requirement.planning.rice, { reach: 80, impact: 3, confidence: 75, effort: 6 });
  assert.deepEqual(requirement.relations, [{ to: 'parse-2', type: 'supports' }]);
  assert.ok(model.byId.get('parse-2'));
  assert.ok(model.root.edges.some((edge) => edge.from === 'parse-2' && edge.to === 'intake-2' && edge.label === 'enables'));
});

test('freeform edits keep one shared definition and separate placement notes', () => {
  load(`
name: Shared map
mode: freeform
elements:
  - id: data-team
    type: role
    label: Data Team
  - id: looker
    type: system
    label: Looker
nodes:
  - id: analytics
    type: item
    label: Analytics
    children:
      nodes:
        - use: looker
      edges: []
  - id: controls
    type: item
    label: Controls
    children:
      nodes:
        - use: looker
      edges: []
edges: []
`);

  edit.addElement({
    id: 'looker-api',
    type: 'api',
    label: 'Looker API',
    owners: [{ to: 'data-team', role: 'technical' }],
    relations: [{ to: 'looker', type: 'part-of' }],
  });
  edit.addPlacement('analytics', 'looker-api', {
    note: 'Interactive dashboards',
    position: { x: 220, y: 140 },
  });
  edit.addPlacement('controls', 'looker-api', { note: 'Approved control views' });
  edit.addEdge('analytics', { from: 'looker', to: 'looker-api', label: 'exposes' });

  let { out, model } = reserialize();
  assert.equal(model.elementById.get('looker-api').label, 'Looker API');
  assert.deepEqual(model.elementById.get('looker-api').owners, [{ to: 'data-team', role: 'technical' }]);
  assert.deepEqual(model.elementById.get('looker-api').relations, [{ to: 'looker', type: 'part-of' }]);
  assert.equal(model.placementsByElement.get('looker-api').length, 2);
  assert.equal(model.placementByKey.get('analytics\u0000looker-api').note, 'Interactive dashboards');
  assert.deepEqual(model.placementByKey.get('analytics\u0000looker-api').position, { x: 220, y: 140 });
  assert.equal(model.placementByKey.get('controls\u0000looker-api').note, 'Approved control views');

  load(out);
  const removal = edit.removePlacement('analytics', 'looker-api');
  assert.equal(removal.dropped, 1);
  ({ out, model } = reserialize());
  assert.ok(model.elementById.has('looker-api'), 'shared definition remains');
  assert.equal(model.placementsByElement.get('looker-api').length, 1);
  assert.equal(model.byId.get('analytics').children.edges.length, 0);
  assert.ok(model.byId.get('analytics').children, 'empty Freeform group stays a group');

  load(out);
  edit.deleteElement('looker-api');
  ({ model } = reserialize());
  assert.ok(!model.elementById.has('looker-api'));
  assert.equal(model.placementsByElement.has('looker-api'), false);
});

test('freeform template insertion adds definitions and placement groups together', () => {
  load(`
name: Target
mode: freeform
elements:
  - id: shared
    type: system
    label: Existing
nodes: []
edges: []
`);
  const template = parseMap(`
name: Reusable systems
mode: freeform
elements:
  - id: shared
    type: system
    label: Template system
nodes:
  - id: landscape
    type: item
    label: Landscape
    children:
      nodes:
        - use: shared
          note: Template placement
      edges: []
edges: []
`).model;

  const inserted = edit.insertTemplate(null, template);
  const { out, model } = reserialize();
  assert.deepEqual(inserted, ['landscape']);
  assert.equal(model.elementById.get('shared-2').label, 'Template system');
  assert.equal(model.placementByKey.get('landscape\u0000shared-2').note, 'Template placement');
  assert.match(out, /elements:\n\s+- id: shared/);
  assert.match(out, /nodes:\n\s+- id: landscape/);
});
