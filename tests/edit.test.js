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

test('duplicateNode copies a subtree and rewrites only its internal references', () => {
  load(`
name: Duplicate process
nodes:
  - id: group
    type: process
    label: Group
    cost:
      runs: 8
      human: { minutes: 5, rate: 70 }
    planning:
      type: requirement
      dependsOn: [child-a]
    relations:
      - { to: child-b, type: supports }
    children:
      nodes:
        - id: child-a
          type: process
          label: Child A
        - id: child-b
          type: process
          label: Child B
      edges:
        - { from: child-a, to: child-b, label: hands off }
  - id: outside
    type: process
    label: Outside
edges:
  - { from: group, to: outside, label: leaves group }
`);

  const duplicateId = edit.duplicateNode('group', { position: { x: 200, y: 150 } });
  const { out, model } = reserialize();
  const original = model.byId.get('group');
  const copy = model.byId.get(duplicateId);

  assert.equal(duplicateId, 'group-copy');
  assert.equal(copy.label, 'Group copy');
  assert.deepEqual(copy.position, { x: 200, y: 150 });
  assert.deepEqual(copy.cost, original.cost);
  assert.deepEqual(copy.planning.dependsOn, ['child-a-copy']);
  assert.deepEqual(copy.relations, [{ to: 'child-b-copy', type: 'supports' }]);
  assert.ok(model.byId.has('child-a-copy'));
  assert.ok(model.byId.has('child-b-copy'));
  assert.deepEqual(copy.children.edges.map(({ from, to, label }) => ({ from, to, label })),
    [{ from: 'child-a-copy', to: 'child-b-copy', label: 'hands off' }]);
  assert.equal(model.root.edges.length, 1, 'external connection is not duplicated');
  for (const derived of ['ownerId:', 'isElement:', 'isPlacement:', 'stats:']) {
    assert.ok(!out.includes(derived), `derived field omitted: ${derived}`);
  }
});

test('duplicateElement copies its definition and one placement without derived fields', () => {
  load(`
name: Duplicate freeform item
mode: freeform
elements:
  - id: data-team
    type: role
    label: Data Team
  - id: looker
    type: system
    label: Looker
    owners:
      - { to: data-team, role: technical }
nodes:
  - id: analytics
    type: item
    label: Analytics
    children:
      nodes:
        - use: looker
          note: Interactive dashboards
          position: { x: 20, y: 30 }
      edges: []
edges: []
`);

  const duplicateId = edit.duplicateElement('looker', 'analytics', { position: { x: 90, y: 110 } });
  const { out, model } = reserialize();

  assert.equal(duplicateId, 'looker-copy');
  assert.equal(model.elementById.get(duplicateId).label, 'Looker copy');
  assert.deepEqual(model.elementById.get(duplicateId).owners, [{ to: 'data-team', role: 'technical' }]);
  assert.equal(model.placementByKey.get(`analytics\u0000${duplicateId}`).note, 'Interactive dashboards');
  assert.deepEqual(model.placementByKey.get(`analytics\u0000${duplicateId}`).position, { x: 90, y: 110 });
  assert.equal(model.placementsByElement.get('looker').length, 1);
  assert.equal(model.placementsByElement.get(duplicateId).length, 1);
  for (const derived of ['ownerId:', 'isElement:', 'isPlacement:', 'placementKey:', 'stats:']) {
    assert.ok(!out.includes(derived), `derived field omitted: ${derived}`);
  }
});

test('reverseEdge swaps endpoints and keeps label, kind, and comments', () => {
  load(`
name: Edge ops
nodes:
  - id: a
    type: process
    label: A
  - id: b
    type: process
    label: B
  - id: box
    type: process
    label: Box
    children:
      nodes:
        - id: inner-a
          type: process
          label: Inner A
        - id: inner-b
          type: process
          label: Inner B
      edges:
        # route inside the box
        - from: inner-a
          to: inner-b
          label: internal
edges:
  # cross the boundary
  - from: a
    to: b
    label: forward
    kind: manual
`);
  edit.reverseEdge({ scopeId: null, index: 0 });
  edit.reverseEdge({ scopeId: 'box', index: 0 });
  const { out, model } = reserialize();
  assert.deepEqual(model.root.edges.map(({ from, to, label, kind }) => ({ from, to, label, kind })),
    [{ from: 'b', to: 'a', label: 'forward', kind: 'manual' }]);
  assert.deepEqual(
    model.byId.get('box').children.edges.map(({ from, to, label }) => ({ from, to, label })),
    [{ from: 'inner-b', to: 'inner-a', label: 'internal' }]);
  assert.ok(out.includes('# cross the boundary'), 'root edge comment survived');
  assert.ok(out.includes('# route inside the box'), 'nested edge comment survived');
});

test('rewireEdge validates endpoints against the scope and preserves other keys', () => {
  load(`
name: Edge ops
nodes:
  - id: a
    type: process
    label: A
  - id: b
    type: process
    label: B
  - id: box
    type: process
    label: Box
    children:
      nodes:
        - id: inner-a
          type: process
          label: Inner A
        - id: inner-b
          type: process
          label: Inner B
      edges:
        - from: inner-a
          to: inner-b
          label: internal
edges:
  - from: a
    to: b
    label: forward
    kind: manual
`);
  edit.rewireEdge({ scopeId: null, index: 0 }, { from: 'b', to: 'box' });
  let { model } = reserialize();
  assert.deepEqual(model.root.edges.map(({ from, to, label, kind }) => ({ from, to, label, kind })),
    [{ from: 'b', to: 'box', label: 'forward', kind: 'manual' }], 'label and kind kept');

  // inner-a lives inside box, so it is not a sibling at the root scope
  assert.throws(() => edit.rewireEdge({ scopeId: null, index: 0 }, { from: 'a', to: 'inner-a' }),
    /"inner-a" is not in this scope/);
  assert.throws(() => edit.rewireEdge({ scopeId: null, index: 0 }, { from: 'ghost', to: 'a' }),
    /"ghost" is not in this scope/);
  // a is a root node, so it is not a sibling inside box
  assert.throws(() => edit.rewireEdge({ scopeId: 'box', index: 0 }, { from: 'inner-a', to: 'a' }),
    /"a" is not in this scope/);

  ({ model } = reserialize());
  assert.deepEqual(model.root.edges.map(({ from, to }) => ({ from, to })),
    [{ from: 'b', to: 'box' }], 'rejected rewires leave the edge alone');
  assert.deepEqual(model.byId.get('box').children.edges.map(({ from, to }) => ({ from, to })),
    [{ from: 'inner-a', to: 'inner-b' }], 'rejected rewires leave the nested edge alone');
});

test('updateEdgeLabel sets a label and empty text removes the key', () => {
  load(`
name: Labels
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
  assert.equal(state.model.root.edges[0].label, '');
  edit.updateEdgeLabel({ scopeId: null, index: 0 }, 'approved');
  let { out, model } = reserialize();
  assert.equal(model.root.edges[0].label, 'approved');
  assert.ok(out.includes('label: approved'));

  state.model = model;
  edit.updateEdgeLabel({ scopeId: null, index: 0 }, '');
  ({ out, model } = reserialize());
  assert.equal(model.root.edges[0].label, '');
  const edgeBlock = out.slice(out.indexOf('\nedges:'));
  assert.ok(!edgeBlock.includes('label:'), 'empty text deletes the label key');
});

test('bulkRemoveNodes deletes subtrees once and cleans edges and dependencies', () => {
  load(`
name: Bulk remove
nodes:
  - id: group
    type: process
    label: Group
    children:
      nodes:
        - id: inner
          type: process
          label: Inner
      edges: []
  - id: keeper
    type: process
    label: Keeper
    planning:
      type: requirement
      dependsOn: [group, inner]
  - id: also-kept
    type: process
    label: Also kept
edges:
  - { from: group, to: keeper, label: hands off }
  - { from: keeper, to: also-kept }
`);
  // descendant listed first, unknown id mixed in: order and ghosts do not matter
  edit.bulkRemoveNodes(['inner', 'group', 'ghost']);
  const { out, model } = reserialize();
  assert.ok(!model.byId.has('group'));
  assert.ok(!model.byId.has('inner'), 'descendant removed with the ancestor, exactly once');
  assert.deepEqual(model.root.edges.map(({ from, to }) => ({ from, to })),
    [{ from: 'keeper', to: 'also-kept' }], 'edges touching the subtree removed, others kept');
  assert.deepEqual(model.byId.get('keeper').planning.dependsOn, []);
  assert.ok(!out.includes('dependsOn:'), 'emptied dependency list dropped from the file');
});

test('bulkRemoveNodes with no known ids is a no-op', () => {
  const before = state.doc.toString();
  edit.bulkRemoveNodes([]);
  edit.bulkRemoveNodes();
  edit.bulkRemoveNodes(['ghost']);
  assert.equal(state.doc.toString(), before);
  reserialize();
});

test('copyNodesPlain zeroes positions to the min corner and includes subtrees', () => {
  load(`
name: Copy
nodes:
  - id: cell
    type: process
    label: Cell
    position: { x: 300, y: 200 }
    children:
      nodes:
        - id: nucleus
          type: process
          label: Nucleus
      edges: []
  - id: loose
    type: process
    label: Loose
    position: { x: 40, y: 120 }
edges: []
`);
  const plain = edit.copyNodesPlain(['cell', 'nucleus', 'loose', 'ghost']);
  assert.equal(plain.length, 2, 'ancestor covers its descendant, unknown id ignored');
  const cell = plain.find((n) => n.id === 'cell');
  const loose = plain.find((n) => n.id === 'loose');
  assert.deepEqual(cell.position, { x: 260, y: 80 }, 'shifted so the selection min corner sits at 0,0');
  assert.deepEqual(loose.position, { x: 0, y: 0 });
  assert.equal(cell.children.nodes[0].id, 'nucleus', 'subtree copied with the root');

  const { model } = reserialize();
  assert.deepEqual(model.byId.get('cell').position, { x: 300, y: 200 }, 'copy does not move the source');
});

test('pasteNodesPlain remaps every internal id and never mutates its input', () => {
  load(`
name: Paste
nodes:
  - id: cell
    type: process
    label: Cell
    position: { x: 300, y: 200 }
    planning:
      type: requirement
      dependsOn: [nucleus]
    relations:
      - { to: nucleus, type: supports }
    children:
      nodes:
        - id: nucleus
          type: process
          label: Nucleus
        - id: membrane
          type: process
          label: Membrane
      edges:
        - { from: nucleus, to: membrane, label: transports }
  - id: host
    type: process
    label: Host
edges:
  - { from: cell, to: host, label: lives in }
`);
  const plain = edit.copyNodesPlain(['cell']);
  const snapshot = JSON.stringify(plain);

  const firstIds = edit.pasteNodesPlain(plain, null, { x: 50, y: 40 });
  assert.deepEqual(firstIds, ['cell-copy']);
  assert.equal(JSON.stringify(plain), snapshot, 'input clipboard is not mutated');

  let { model } = reserialize();
  const copy = model.byId.get('cell-copy');
  assert.ok(copy);
  assert.equal(copy.ownerId, null, 'pasted at the root scope');
  assert.deepEqual(copy.position, { x: 50, y: 40 }, 'zeroed position shifted by the paste offset');
  assert.deepEqual(copy.planning.dependsOn, ['nucleus-copy']);
  assert.deepEqual(copy.relations, [{ to: 'nucleus-copy', type: 'supports' }]);
  assert.deepEqual(copy.children.nodes.map((n) => n.id), ['nucleus-copy', 'membrane-copy']);
  assert.deepEqual(copy.children.edges.map(({ from, to, label }) => ({ from, to, label })),
    [{ from: 'nucleus-copy', to: 'membrane-copy', label: 'transports' }]);
  assert.deepEqual(model.byId.get('cell').planning.dependsOn, ['nucleus'], 'source subtree untouched');
  assert.equal(model.root.edges.length, 1, 'edge outside the copied subtree is not duplicated');

  // a second paste from the same clipboard mints fresh ids again
  state.model = model;
  const secondIds = edit.pasteNodesPlain(plain, null, { x: 5, y: 5 });
  assert.deepEqual(secondIds, ['cell-copy-2']);
  ({ model } = reserialize());
  assert.ok(model.byId.has('cell-copy-2'));
  assert.ok(model.byId.has('nucleus-copy-2'));
  assert.equal(model.byId.get('cell-copy-2').children.edges.length, 1);
});

test('pasteNodesPlain drops copies into a nested scope', () => {
  load(`
name: Nested paste
nodes:
  - id: cell
    type: process
    label: Cell
    position: { x: 10, y: 20 }
    children:
      nodes:
        - id: nucleus
          type: process
          label: Nucleus
      edges: []
  - id: host
    type: process
    label: Host
edges: []
`);
  const plain = edit.copyNodesPlain(['cell']);
  const ids = edit.pasteNodesPlain(plain, 'host', { x: 7, y: 3 });
  assert.deepEqual(ids, ['cell-copy']);
  const { model } = reserialize();
  assert.equal(model.byId.get('cell-copy').ownerId, 'host', 'pasted under the target container');
  assert.deepEqual(model.byId.get('cell-copy').position, { x: 7, y: 3 });
  assert.equal(model.byId.get('host').stats.childCount, 1);
  assert.equal(model.byId.get('nucleus-copy').ownerId, 'cell-copy', 'subtree pasted with the root');
});

test('collectCloneIds and remapCloneReferences are usable on their own', () => {
  const clone = {
    id: 'a', type: 'process', label: 'A',
    planning: { type: 'requirement', dependsOn: ['b', 'intake'] },
    relations: [{ to: 'b', type: 'supports' }],
    children: {
      nodes: [{ id: 'b', type: 'process', label: 'B' }],
      edges: [{ from: 'b', to: 'a', label: 'up' }],
    },
  };
  const ids = new Map();
  edit.collectCloneIds(clone, ids, new Set());
  assert.deepEqual([...ids.entries()], [['a', 'a-copy'], ['b', 'b-copy']]);

  edit.remapCloneReferences(clone, ids);
  assert.equal(clone.id, 'a-copy');
  assert.equal(clone.children.nodes[0].id, 'b-copy');
  assert.deepEqual(clone.children.edges[0], { from: 'b-copy', to: 'a-copy', label: 'up' });
  assert.deepEqual(clone.planning.dependsOn, ['b-copy', 'intake'], 'only internal ids remapped');
  assert.deepEqual(clone.relations, [{ to: 'b-copy', type: 'supports' }]);
});

test('alignNodes guards no-op without a rendered canvas', () => {
  // getLayout() only returns boxes after the browser canvas renders a scope,
  // so in Node every call hits the early-return guard. The unknown-mode throw
  // and the alignment math run only with a live layout and are not reachable
  // here — same canvas boundary the other tests already respect.
  const before = state.doc.toString();
  edit.alignNodes([], 'left');
  edit.alignNodes(['intake'], 'left');
  edit.alignNodes(['intake', 'qualify'], 'dist-h');
  assert.equal(state.doc.toString(), before);
  reserialize();
});
