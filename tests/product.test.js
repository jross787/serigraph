import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';
import {
  auditProductPlan,
  buildRoadmap,
  calculateRice,
  formatRice,
  planningInventory,
  productDocumentMarkdown,
} from '../app/product.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseOk(source) {
  const { model, errors } = parseMap(source);
  assert.deepEqual(errors, [], 'fixture must satisfy the public map contract');
  return model;
}

const COMPLETE_PRODUCT = `
name: Complete Product
description: A graph-backed release contract.
document:
  kind: prd
  version: "1.0"
  summary: A complete product brief with an inspectable release contract.
  owner: Product
  status: planned
  updated: "2026-07-18"
  audience: [Product, Engineering]
  goals: [Create one source of product truth]
  nonGoals: [Replace the delivery tracker]
  successMetrics: [Every requirement is traceable to an objective]
nodes:
  - id: problem
    type: artifact
    label: Fragmented product truth
    planning:
      type: problem
      status: validated
      evidence: [Research interviews]
  - id: objective
    type: process
    label: One source of truth
    planning:
      type: objective
      status: validated
    relations:
      - to: metric
        type: measured-by
  - id: requirement
    type: artifact
    label: Living brief
    description: Render the PRD from the graph.
    owner: Product Design
    planning:
      type: requirement
      status: shipped
      priority: must
      phase: now
      target: v1
      acceptance: [The brief renders from YAML]
      evidence: [Browser verification]
      risks: [Dense documents need strong hierarchy]
      rice: { reach: 100, impact: 3, confidence: 90, effort: 3 }
    relations:
      - to: objective
        type: supports
      - to: risk
        type: mitigates
  - id: metric
    type: system
    label: Traceability coverage
    planning:
      type: metric
      status: planned
  - id: risk
    type: decision
    label: False certainty
    description: A structural score could be mistaken for customer proof.
    planning:
      type: risk
      status: discovery
`;

const ROADMAP_FIXTURE = `
name: Roadmap Fixture
document:
  kind: roadmap
nodes:
  - id: now-low
    type: process
    label: Alpha foundation
    owner: Platform
    description: Core model work
    planning:
      type: requirement
      status: planned
      priority: must
      phase: now
      rice: { reach: 20, impact: 1, confidence: 100, effort: 4 }
  - id: now-high
    type: process
    label: Beta accelerator
    owner: Platform
    description: Faster model work
    planning:
      type: requirement
      status: planned
      priority: should
      phase: now
      rice: { reach: 100, impact: 2, confidence: 100, effort: 4 }
  - id: next-blocked
    type: system
    label: Delivery integration
    owner: Integrations
    description: Connect delivery systems
    planning:
      type: requirement
      status: blocked
      priority: must
      phase: next
      rice: { reach: 50, impact: 2, confidence: 50, effort: 5 }
  - id: custom-target
    type: artifact
    label: Research package
    owner: Research
    description: Customer discovery
    planning:
      type: research
      status: discovery
      priority: could
      target: q4
  - id: backlog
    type: process
    label: Unscheduled capability
    owner: Product
    planning:
      type: requirement
      status: draft
      priority: could
`;

test('RICE calculation is transparent, precise, and rejects incomplete or unsafe inputs', () => {
  assert.equal(calculateRice({ reach: 100, impact: 3, confidence: 80, effort: 4 }), 60);
  assert.equal(calculateRice({ rice: { reach: 10, impact: 2, confidence: 50, effort: 2 } }), 5);
  assert.equal(calculateRice({ reach: 1, impact: 1, confidence: 33, effort: 3 }), 0.11);
  assert.equal(calculateRice({ reach: '100', impact: '3', confidence: '80', effort: '4' }), 60);

  for (const value of [
    null,
    {},
    { reach: null, impact: 1, confidence: 50, effort: 1 },
    { reach: '', impact: 1, confidence: 50, effort: 1 },
    { reach: '   ', impact: 1, confidence: 50, effort: 1 },
    { reach: false, impact: 1, confidence: 50, effort: 1 },
    { reach: [], impact: 1, confidence: 50, effort: 1 },
    { reach: -1, impact: 1, confidence: 50, effort: 1 },
    { reach: 1, impact: -1, confidence: 50, effort: 1 },
    { reach: 1, impact: 1, confidence: 101, effort: 1 },
    { reach: 1, impact: 1, confidence: 50, effort: 0 },
    { reach: 'many', impact: 1, confidence: 50, effort: 1 },
    { reach: Number.MAX_VALUE, impact: 2, confidence: 100, effort: 1 },
  ]) assert.equal(calculateRice(value), null, JSON.stringify(value));
});

test('RICE formatting keeps roadmap labels compact without hiding ordering precision', () => {
  assert.equal(formatRice(null), 'Needs inputs');
  assert.equal(formatRice(Number.NaN), 'Needs inputs');
  assert.equal(formatRice(240.4), '240');
  assert.equal(formatRice(18.349), '18.3');
  assert.equal(formatRice(2.345), '2.35');
});

test('planning inventory indexes product nodes by type and status', () => {
  const inventory = planningInventory(parseOk(COMPLETE_PRODUCT));
  assert.equal(inventory.all.length, 5);
  assert.equal(inventory.items.length, 5);
  assert.deepEqual(inventory.byType.get('requirement').map((node) => node.id), ['requirement']);
  assert.deepEqual(inventory.byStatus.get('validated').map((node) => node.id), ['problem', 'objective']);
});

test('roadmap groups horizons, preserves empty standard lanes, and sorts by full RICE score', () => {
  const roadmap = buildRoadmap(parseOk(ROADMAP_FIXTURE));
  assert.equal(roadmap.total, 5);
  assert.equal(roadmap.filtered, 5);
  assert.deepEqual(roadmap.columns.map((column) => column.id), ['now', 'next', 'later', 'q4', 'backlog']);
  assert.deepEqual(roadmap.columns.find((column) => column.id === 'now').items.map((item) => item.id), ['now-high', 'now-low']);
  assert.deepEqual(roadmap.columns.find((column) => column.id === 'later').items, []);
  assert.equal(roadmap.columns.find((column) => column.id === 'backlog').label, 'Unscheduled');
  assert.deepEqual(roadmap.priorities, ['must', 'should', 'could']);
  assert.deepEqual(roadmap.owners, ['Integrations', 'Platform', 'Product', 'Research']);
});

test('roadmap filters combine status, priority, owner, and free-text query', () => {
  const model = parseOk(ROADMAP_FIXTURE);
  const blocked = buildRoadmap(model, {
    status: 'blocked',
    priority: 'must',
    owner: 'Integrations',
    query: 'delivery systems',
  });
  assert.equal(blocked.total, 5, 'total reports the unfiltered eligible inventory');
  assert.equal(blocked.filtered, 1);
  assert.deepEqual(blocked.columns.map((column) => column.id), ['now', 'next', 'later', 'q4', 'backlog']);
  assert.deepEqual(blocked.columns.flatMap((column) => column.items).map((item) => item.id), ['next-blocked']);

  const none = buildRoadmap(model, { query: 'not in this plan' });
  assert.equal(none.filtered, 0);
  assert.deepEqual(none.columns.map((column) => column.id), ['now', 'next', 'later', 'q4', 'backlog']);
  assert.ok(none.columns.every((column) => column.items.length === 0));
});

test('a complete product plan is Ready while legacy process maps are excluded', () => {
  const complete = auditProductPlan(parseOk(COMPLETE_PRODUCT));
  assert.equal(complete.applicable, true);
  assert.equal(complete.state, 'Ready');
  assert.equal(complete.score, 100);
  assert.deepEqual(complete.issues, []);

  const process = auditProductPlan(parseOk(`name: Legacy\nnodes:\n  - id: a\n    type: process\n    label: A\n`));
  assert.deepEqual(process, {
    applicable: false,
    score: null,
    state: 'Process map',
    issues: [],
    passed: 0,
    checks: 0,
  });
});

test('readiness honors relation meaning and direction instead of any nearby link', () => {
  const model = parseOk(`
name: Semantic relations
document:
  kind: prd
  summary: Test semantic relation handling.
  audience: [Product]
  goals: [Keep traceability precise]
  nonGoals: [Infer relation meaning]
  successMetrics: [Every semantic gap is reported]
nodes:
  - id: problem
    type: artifact
    label: Problem
    planning: { type: problem }
  - id: objective
    type: process
    label: Objective
    planning: { type: objective }
    relations:
      - { to: metric, type: supports }
  - id: requirement
    type: artifact
    label: Requirement
    owner: Product
    planning:
      type: requirement
      status: blocked
      priority: must
      phase: now
      acceptance: [Works]
      evidence: [Observed]
      dependsOn: [blocker]
      rice: { reach: 10, impact: 2, confidence: 80, effort: 1 }
    relations:
      - { to: objective, type: blocks }
  - id: blocker
    type: system
    label: Blocker
    planning: { type: decision }
    relations:
      - { to: requirement, type: blocks }
  - id: metric
    type: system
    label: Metric
    planning: { type: metric }
  - id: risk
    type: decision
    label: Risk
    planning: { type: risk }
    relations:
      - { to: requirement, type: mitigates }
`);
  const audit = auditProductPlan(model);
  const codes = audit.issues.map((issue) => issue.code);
  assert.ok(codes.includes('requirement-trace'), 'blocks does not count as supporting an objective');
  assert.ok(codes.includes('objective-metric'), 'only measured-by links an objective to its metric');
  assert.ok(codes.includes('risk-mitigation'), 'mitigation points from the mitigator to the risk');
  assert.ok(!codes.includes('blocked-dependency'), 'an explicit dependency names the blocker');
  assert.ok(!codes.includes('dependency-cycle'), 'inverse blocks + depends-on encodes one dependency, not a cycle');
});

test('readiness audit produces stable, locatable issues and detects dependency cycles', () => {
  const model = parseOk(`
name: Incomplete
document:
  kind: prd
nodes:
  - id: objective
    type: process
    label: Unmeasured objective
    planning: { type: objective }
  - id: req-a
    type: artifact
    label: Requirement A
    planning:
      type: requirement
      status: blocked
      dependsOn: [req-b]
  - id: req-b
    type: artifact
    label: Requirement B
    planning:
      type: requirement
      dependsOn: [req-a]
  - id: req-c
    type: artifact
    label: Requirement C
    planning:
      type: requirement
      status: blocked
  - id: risk
    type: decision
    label: Unmitigated risk
    planning: { type: risk }
`);
  const audit = auditProductPlan(model);
  const codes = new Set(audit.issues.map((issue) => issue.code));
  for (const code of [
    'document-summary', 'document-audience', 'document-goals', 'document-metrics',
    'problem-missing', 'metric-missing', 'requirement-owner', 'requirement-acceptance',
    'requirement-trace', 'requirement-rice', 'objective-metric', 'risk-mitigation',
    'blocked-dependency', 'dependency-cycle',
  ]) assert.ok(codes.has(code), `audit includes ${code}`);
  assert.equal(audit.state, 'Draft');
  assert.ok(audit.score < 68);
  assert.deepEqual(
    new Set(audit.issues.filter((issue) => issue.code === 'dependency-cycle').map((issue) => issue.nodeId)),
    new Set(['req-a', 'req-b']),
  );
  assert.ok(audit.issues.filter((issue) => issue.nodeId).every((issue) => model.byId.has(issue.nodeId)));
});

test('readiness validates every roadmap item without credit from unrelated planning nodes', () => {
  const complete = auditProductPlan(parseOk(COMPLETE_PRODUCT));
  const milestoneAudit = auditProductPlan(parseOk(`${COMPLETE_PRODUCT}  - id: milestone
    type: artifact
    label: Uncommitted milestone
    planning:
      type: milestone
`));
  const milestoneIssues = milestoneAudit.issues.filter((issue) => issue.nodeId === 'milestone');
  assert.deepEqual(new Set(milestoneIssues.map((issue) => issue.code)), new Set([
    'roadmap-owner',
    'roadmap-status',
    'roadmap-schedule',
    'roadmap-evidence',
    'roadmap-rice',
  ]));
  assert.equal(milestoneAudit.checks, complete.checks + 5, 'the five roadmap contract checks are counted once');
  assert.equal(milestoneAudit.checks - milestoneAudit.passed, 5, 'failed checks match the actual missing fields');
  assert.notEqual(milestoneAudit.state, 'Ready');

  const withUnrelatedDecision = auditProductPlan(parseOk(`${COMPLETE_PRODUCT}  - id: internal-decision
    type: decision
    label: Internal implementation decision
    planning:
      type: decision
      status: planned
`));
  assert.equal(withUnrelatedDecision.checks, complete.checks, 'a non-roadmap planning node does not inflate readiness');
  assert.equal(withUnrelatedDecision.score, 100);
  assert.equal(withUnrelatedDecision.state, 'Ready');
});

test('Markdown publishing renders the release contract and strips raw HTML brackets', () => {
  const model = parseOk(COMPLETE_PRODUCT
    .replace('name: Complete Product', 'name: "Complete <Product>"')
    .replace('A complete product brief', 'A <script>alert</script> complete product brief'));
  const markdown = productDocumentMarkdown(model);
  assert.match(markdown, /^# Complete Product/m);
  assert.match(markdown, /## Requirements/);
  assert.match(markdown, /### Living brief/);
  assert.match(markdown, /\*\*Horizon:\*\* now · \*\*Target:\*\* v1/);
  assert.match(markdown, /\*\*RICE:\*\* 90\.0/);
  assert.match(markdown, /\*\*Requirement risks\*\*\n\n- Dense documents need strong hierarchy/);
  assert.match(markdown, /\*\*Relations\*\*\n\n- \*\*supports\*\* → One source of truth \(`objective`\)/);
  assert.match(markdown, /- \*\*mitigates\*\* → False certainty \(`risk`\)/);
  assert.match(markdown, /## Risks/);
  assert.match(markdown, /\*\*Ready — 100\/100\*\*/);
  assert.match(markdown, /Generated from the Serigraph graph/);
  assert.ok(!markdown.includes('<'), 'no raw HTML opening bracket survives');
  assert.ok(!markdown.includes('>'), 'no raw HTML closing bracket survives');
});

test('dogfood PRD ships at least five traceable requirements from one valid graph', () => {
  const source = readFileSync(path.join(ROOT, 'maps/serigraph-prd.yaml'), 'utf8');
  const model = parseOk(source);
  const requirements = planningInventory(model).byType.get('requirement') ?? [];
  const shipped = requirements.filter((node) => node.planning.status === 'shipped');
  assert.equal(model.document.kind, 'prd');
  assert.ok(shipped.length >= 5, `expected >=5 shipped requirements, found ${shipped.length}`);
  for (const node of shipped) {
    assert.ok(node.owner, `${node.id} has an owner`);
    assert.ok(node.planning.acceptance.length, `${node.id} has acceptance criteria`);
    assert.ok(node.planning.evidence.length, `${node.id} has evidence`);
    assert.ok(node.relations.some((relation) => relation.type === 'supports'), `${node.id} supports an objective`);
  }
  const audit = auditProductPlan(model);
  assert.equal(audit.state, 'Ready');
  assert.deepEqual(audit.issues, []);
});

test('dogfood roadmap contains at least ten actionable capabilities across all horizons', () => {
  const source = readFileSync(path.join(ROOT, 'maps/serigraph-roadmap.yaml'), 'utf8');
  const model = parseOk(source);
  const requirements = planningInventory(model).byType.get('requirement') ?? [];
  const roadmap = buildRoadmap(model);
  assert.equal(model.document.kind, 'roadmap');
  assert.ok(requirements.length >= 10, `expected >=10 roadmap capabilities, found ${requirements.length}`);
  assert.ok(requirements.filter((node) => node.planning.status === 'shipped').length >= 5);
  for (const phase of ['now', 'next', 'later']) {
    assert.ok(roadmap.columns.find((column) => column.id === phase)?.items.length, `${phase} has roadmap work`);
  }
  assert.ok(roadmap.filtered >= requirements.length);
  assert.equal(auditProductPlan(model).state, 'Ready');
});
