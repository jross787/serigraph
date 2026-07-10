import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, ancestryOf, scopeOf, NODE_TYPES } from '../shared/model.js';

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

test('all five node types are accepted, others rejected with hint', () => {
  for (const t of NODE_TYPES) {
    const { errors } = parseMap(`name: X\nnodes:\n  - id: n\n    type: ${t}\n    label: L`);
    assert.equal(errors.length, 0, t);
  }
  const { errors } = parseMap(`name: X\nnodes:\n  - id: n\n    type: tool\n    label: L`);
  assert.match(errors[0].message, /did you mean "system"/);
  assert.ok(errors[0].line, 'error carries a line number');
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
