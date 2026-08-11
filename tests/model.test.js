import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMap,
  ancestryOf,
  scopeOf,
  placementInScope,
  placementsOf,
  NODE_TYPES,
  MAP_MODES,
  DOCUMENT_KINDS,
  PLANNING_TYPES,
  PLAN_STATUSES,
  PLAN_PRIORITIES,
  RELATION_TYPES,
  HIERARCHY_RELATION_TYPES,
  OWNER_ROLES,
} from '../shared/model.js';

const MINI = `
name: Espresso Cart
nodes:
  - id: take-order
    type: process
    label: Take order
    children:
      nodes:
        - id: barista
          type: role
          label: Barista
        - id: pos
          type: system
          label: Square POS
      edges:
        - from: barista
          to: pos
          label: keys order into
  - id: paid
    type: decision
    label: Paid?
  - id: receipt
    type: artifact
    label: Receipt
edges:
  - from: take-order
    to: paid
  - from: paid
    to: receipt
    label: "yes"
`;

test('parses the FORMAT.md example', () => {
  const { model, errors } = parseMap(MINI);
  assert.equal(errors.length, 0);
  assert.equal(model.name, 'Espresso Cart');
  assert.equal(model.mode, 'process');
  assert.equal(model.nodeCount, 5);
  assert.equal(model.root.nodes.length, 3);
  assert.equal(model.root.edges.length, 2);
  const takeOrder = model.byId.get('take-order');
  assert.equal(takeOrder.stats.childCount, 2);
  assert.deepEqual(ancestryOf(model, 'pos'), ['take-order', 'pos']);
  assert.equal(scopeOf(model, 'take-order').edges[0].label, 'keys order into');
});

test('accepts children as a plain list (lenient form)', () => {
  const { model, errors } = parseMap(`
name: T
nodes:
  - id: a
    type: process
    label: A
    children:
      - id: b
        type: process
        label: B
`);
  assert.equal(errors.length, 0);
  assert.equal(model.byId.get('a').stats.childCount, 1);
});

test('all node types are accepted, others rejected with a hint', () => {
  for (const t of NODE_TYPES) {
    const { errors } = parseMap(`name: X\nnodes:\n  - id: n\n    type: ${t}\n    label: L`);
    assert.equal(errors.length, 0, t);
  }
  const { errors } = parseMap(`name: X\nnodes:\n  - id: n\n    type: tool\n    label: L`);
  assert.match(errors[0].message, /did you mean "system"/);
  assert.ok(errors[0].line, 'error carries a line number');
});

test('freeform mode uses shared elements with group-specific placements', () => {
  const { model, errors } = parseMap(`
name: Shared systems
mode: freeform
elements:
  - id: data-team
    type: role
    label: Data Team
  - id: looker
    type: system
    label: Looker
    owners:
      - to: data-team
        role: technical
  - id: looker-api
    type: api
    label: Looker API
    relations:
      - to: looker
        type: part-of
nodes:
  - id: analytics
    type: item
    label: Analytics
    children:
      nodes:
        - use: looker
          note: Shared semantic layer
          position: { x: 120, y: 80 }
        - use: looker-api
      edges:
        - from: looker
          to: looker-api
  - id: controls
    type: item
    label: Controls
    children:
      nodes:
        - use: looker
          note: Approved control views
      edges: []
edges: []
`);
  assert.equal(errors.length, 0);
  assert.equal(model.mode, 'freeform');
  assert.deepEqual(MAP_MODES, ['process', 'freeform']);
  assert.deepEqual(HIERARCHY_RELATION_TYPES, ['part-of', 'member-of', 'variant-of']);
  assert.deepEqual(OWNER_ROLES, ['owner', 'business', 'technical', 'data-steward']);
  assert.equal(model.nodeCount, 5);
  assert.equal(model.placementCount, 3);
  assert.equal(model.elementById.get('looker'), model.byId.get('looker'));
  assert.equal(placementsOf(model, 'looker').length, 2);
  assert.equal(placementInScope(model, 'analytics', 'looker').note, 'Shared semantic layer');
  assert.equal(placementInScope(model, 'controls', 'looker').note, 'Approved control views');
  assert.deepEqual(placementInScope(model, 'analytics', 'looker').position, { x: 120, y: 80 });
  assert.deepEqual(model.byId.get('looker').owners, [{ to: 'data-team', role: 'technical' }]);
  assert.deepEqual(model.byId.get('looker-api').relations, [{ to: 'looker', type: 'part-of' }]);

  const invalid = parseMap('name: X\nmode: diagram\nnodes: []\n');
  assert.equal(invalid.model, null);
  assert.match(invalid.errors[0].message, /must be one of: process, freeform/);
});

test('freeform placements reject root use, overrides, and duplicate use in one group', () => {
  const { errors } = parseMap(`
name: Invalid placements
mode: freeform
elements:
  - id: db
    type: database
    label: Database
    note: Shared note
    position: { x: 10, y: 20 }
    children: { nodes: [], edges: [] }
nodes:
  - use: db
  - id: group
    type: item
    label: Group
    children:
      nodes:
        - use: db
          label: Local override
        - use: db
      edges: []
edges: []
`);
  assert.ok(errors.some((error) => /must be inside a group/.test(error.message)));
  assert.ok(errors.some((error) => /cannot override "label"/.test(error.message)));
  assert.ok(errors.some((error) => /already placed in this group/.test(error.message)));
  assert.ok(errors.some((error) => /cannot have a shared note/.test(error.message)));
  assert.ok(errors.some((error) => /cannot have a shared position/.test(error.message)));
  assert.ok(errors.some((error) => /cannot contain a group/.test(error.message)));
});

test('duplicate ids across nesting levels are caught', () => {
  const { errors } = parseMap(`
name: X
nodes:
  - id: a
    type: process
    label: A
    children:
      nodes:
        - id: a
          type: process
          label: Nested dup
`);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Duplicate id "a"/);
});

test('edge endpoints must be siblings; cross-scope explained', () => {
  const { errors } = parseMap(`
name: X
nodes:
  - id: a
    type: process
    label: A
    children:
      nodes:
        - id: inner
          type: process
          label: Inner
  - id: b
    type: process
    label: B
edges:
  - from: b
    to: inner
`);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exists but not in this scope/);
});

test('edge to unknown id names the scope', () => {
  const { errors } = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\nedges:\n  - from: a\n    to: ghost`);
  assert.match(errors[0].message, /no node with id "ghost" at the top level/);
});

test('missing required fields produce useful errors', () => {
  const { errors } = parseMap(`name: X\nnodes:\n  - type: process\n    label: NoId\n  - id: no-label\n    type: process\n  - id: no-type\n    label: L`);
  assert.equal(errors.length, 3);
  assert.match(errors[0].message, /missing its "id:"/);
  assert.match(errors[1].message, /missing its "label:"/);
  assert.match(errors[2].message, /missing its "type:"/);
});

test('YAML syntax errors surface with line numbers, model is null', () => {
  const { model, errors } = parseMap('name: [broken\n  yaml here\n');
  assert.equal(model, null);
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /YAML syntax/);
});

test('ids with spaces are rejected', () => {
  const { errors } = parseMap(`name: X\nnodes:\n  - id: has space\n    type: process\n    label: L`);
  assert.match(errors[0].message, /kebab-case/);
});

test('unicode labels, emoji, and RTL text parse fine', () => {
  const { model, errors } = parseMap(`
name: "Unicode 🌍 test — café"
nodes:
  - id: n1
    type: process
    label: "受付 📥 مرحبا"
    description: "Ünïcödé: works, naïvely — 100%"
`);
  assert.equal(errors.length, 0);
  assert.equal(model.byId.get('n1').label, '受付 📥 مرحبا');
});

test('links: bare strings and {label,url} both accepted', () => {
  const { model, errors } = parseMap(`
name: X
nodes:
  - id: a
    type: process
    label: A
    links:
      - https://example.com/bare
      - label: Named
        url: https://example.com/named
`);
  assert.equal(errors.length, 0);
  assert.deepEqual(model.byId.get('a').links.map((l) => l.label), ['https://example.com/bare', 'Named']);
});

test('automation context is normalized and invalid states are rejected', () => {
  const { model, errors } = parseMap(`
name: X
nodes:
  - id: a
    type: process
    label: A
    owner: RevOps
    trigger: New lead
    sla: 15 minutes
    automation: assisted
    systems: [Salesforce, Plaid]
`);
  assert.equal(errors.length, 0);
  assert.deepEqual(model.byId.get('a').systems, ['Salesforce', 'Plaid']);
  assert.equal(model.byId.get('a').automation, 'assisted');

  const invalid = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\n    automation: magical`);
  assert.match(invalid.errors[0].message, /manual, assisted, automated, at-risk/);
});

test('review notes are normalized and malformed notes are explained', () => {
  const { model, errors } = parseMap(`
name: X
nodes:
  - id: a
    type: process
    label: A
    review:
      - body: Confirm the legal owner
        author: Maya
        createdAt: 2026-07-18T09:30:00.000Z
      - id: resolved-risk
        body: Legacy access removed
        resolved: true
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.byId.get('a').review, [
    { id: 'note-1', body: 'Confirm the legal owner', author: 'Maya', createdAt: '2026-07-18T09:30:00.000Z', resolved: false },
    { id: 'resolved-risk', body: 'Legacy access removed', author: 'Reviewer', createdAt: '', resolved: true },
  ]);

  const invalid = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\n    review:\n      - author: Missing body`);
  assert.match(invalid.errors[0].message, /needs a "body:"/);
});

test('product documents normalize metadata, planning semantics, RICE, and cross-scope relations', () => {
  const { model, errors } = parseMap(`
name: Product Plan
document:
  kind: prd
  version: 1.2
  summary: "  One graph for product truth  "
  owner: " Product Ops "
  status: in-progress
  updated: "2026-07-18"
  audience: [" Product ", "", Engineering]
  goals: [Ship a living PRD]
  nonGoals: [Replace issue tracking]
  successMetrics: [Every requirement is traceable]
nodes:
  - id: objective
    type: process
    label: Shared truth
    children:
      nodes:
        - id: requirement
          type: artifact
          label: Living PRD
          planning:
            type: requirement
            status: planned
            priority: must
            phase: now
            target: v1.2
            acceptance: [Brief renders]
            evidence: [Browser verification]
            risks: [Information density]
            dependsOn: [objective]
            rice: { reach: 100, impact: 3, confidence: 85, effort: 5 }
          relations:
            - to: metric
              type: measured-by
      edges: []
  - id: metric
    type: system
    label: Traceability coverage
    planning:
      type: metric
      status: validated
    relations:
      - to: requirement
        type: validated-by
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.document, {
    kind: 'prd',
    version: '1.2',
    summary: 'One graph for product truth',
    owner: 'Product Ops',
    status: 'in-progress',
    updated: '2026-07-18',
    audience: ['Product', 'Engineering'],
    goals: ['Ship a living PRD'],
    nonGoals: ['Replace issue tracking'],
    successMetrics: ['Every requirement is traceable'],
  });
  assert.deepEqual(model.byId.get('requirement').planning, {
    type: 'requirement',
    status: 'planned',
    priority: 'must',
    phase: 'now',
    target: 'v1.2',
    acceptance: ['Brief renders'],
    evidence: ['Browser verification'],
    risks: ['Information density'],
    dependsOn: ['objective'],
    rice: { reach: 100, impact: 3, confidence: 85, effort: 5 },
  });
  assert.deepEqual(model.byId.get('requirement').relations, [{ to: 'metric', type: 'measured-by' }]);
  assert.deepEqual(model.byId.get('metric').relations, [{ to: 'requirement', type: 'validated-by' }]);
});

test('legacy maps get a stable process-document default without planning metadata', () => {
  const { model, errors } = parseMap(`
name: Legacy
nodes:
  - id: step
    type: process
    label: Step
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(model.document, {
    kind: 'process', version: '', summary: '', owner: '', status: '', updated: '',
    audience: [], goals: [], nonGoals: [], successMetrics: [],
  });
  assert.equal(model.byId.get('step').planning, null);
  assert.deepEqual(model.byId.get('step').relations, []);
});

test('product-document enum catalogs expose the supported authoring contract', () => {
  assert.deepEqual(DOCUMENT_KINDS, ['process', 'prd', 'roadmap']);
  assert.ok(PLANNING_TYPES.includes('requirement') && PLANNING_TYPES.includes('metric'));
  assert.ok(PLAN_STATUSES.includes('blocked') && PLAN_STATUSES.includes('shipped'));
  assert.deepEqual(PLAN_PRIORITIES, ['must', 'should', 'could', 'wont']);
  assert.ok(RELATION_TYPES.includes('supports') && RELATION_TYPES.includes('validated-by'));
});

test('invalid document, planning, relation, dependency, list, and RICE values are explained', () => {
  const { model, errors } = parseMap(`
name: Invalid Product
document:
  kind: whiteboard
  status: done
  audience: everyone
nodes:
  - id: bad
    type: process
    label: Bad requirement
    planning:
      type: feature
      status: done
      priority: urgent
      acceptance: ready
      dependsOn: [ghost]
      rice:
        reach: many
        impact: -1
        confidence: 101
        effort: 0
    relations:
      - to: ghost
        type: causes
      - to: ghost
        type: supports
`);
  assert.equal(model, null);
  const messages = errors.map((error) => error.message).join('\n');
  for (const pattern of [
    /document\.kind.*process, prd, roadmap/,
    /document\.status.*draft.*shipped/,
    /document\.audience.*list of text values/,
    /planning\.type.*objective.*requirement/,
    /planning\.status.*draft.*shipped/,
    /planning\.priority.*must.*wont/,
    /planning\.acceptance.*list of text values/,
    /planning\.rice\.reach.*non-negative number/,
    /planning\.rice\.impact.*non-negative number/,
    /planning\.rice\.confidence.*0 to 100/,
    /planning\.rice\.effort.*greater than zero/,
    /relation #1 "type:".*informed-by.*delivers/,
    /relation target "ghost" does not exist/,
    /dependency "ghost" does not exist/,
  ]) assert.match(messages, pattern);
  assert.ok(errors.every((error) => Number.isInteger(error.line) && error.line > 0), 'every validation error is locatable');
});

test('malformed planning and relation containers fail with targeted guidance', () => {
  const badPlanning = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\n    planning: planned`);
  assert.match(badPlanning.errors[0].message, /"planning:" must be a map/);

  const badRelations = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\n    relations: supports b`);
  assert.match(badRelations.errors[0].message, /"relations:" must be a list/);

  const badRice = parseMap(`name: X\nnodes:\n  - id: a\n    type: process\n    label: A\n    planning:\n      type: requirement\n      rice: [1, 2]`);
  assert.match(badRice.errors[0].message, /"planning\.rice:" must be a map/);
});
