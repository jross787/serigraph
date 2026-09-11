import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseMap } from '../shared/model.js';
import { layoutScope, invalidateLayouts, routeEdge } from '../app/layout.js';
import { state } from '../app/state.js';
import { setScopeLayout, setMapMode } from '../app/edit.js';

// Synthetic workflow: a long chain, a branch, a return path, a self-loop,
// a disconnected step and a nested level. No private map data.
export function processSource() {
  const nodes = Array.from({ length: 14 }, (_, i) => ({ id: `step-${i}`, type: i === 5 ? 'decision' : 'process', label: `Step ${i + 1}` }));
  nodes[0].children = { nodes: [{ id: 'detail', type: 'process', label: 'Detail' }], edges: [] };
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, label: `Handoff ${i + 1}` }));
  nodes.push({ id: 'branch', type: 'process', label: 'Optional review' }, { id: 'separate', type: 'process', label: 'Separate step' });
  edges.push({ from: 'step-5', to: 'branch', label: 'Review' }, { from: 'branch', to: 'step-7', label: 'Resume' },
    { from: 'step-10', to: 'step-3', label: 'Retry' }, { from: 'step-12', to: 'step-12', label: 'Repeat' });
  return JSON.stringify({ name: 'Synthetic long process', nodes, edges });
}

before(() => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../vendor/dagre.min.js', import.meta.url), 'utf8'), context);
  globalThis.dagre = context.dagre;
  globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) };
});

function parse(source) {
  const result = parseMap(source);
  assert.deepEqual(result.errors, []);
  return result;
}
function layout(model, ownerId = null) {
  invalidateLayouts();
  return layoutScope(model, ownerId);
}
function positions(value) { return value.nodes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })); }
function overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

// Check geometry, not just the arrangement's implementation: readable fit,
// card/route clearance, deterministic replay and unchanged graph semantics.
test('compact rows improve long-process fit with branches and returns without changing the graph', () => {
  const { model } = parse(processSource());
  const linear = layout(model);
  const before = structuredClone(model);
  model.root.layout = 'compact';
  const compact = layout(model);
  const fit = value => Math.min(1200 / value.w, 650 / value.h);
  assert.ok(fit(compact) > fit(linear) * 2, `${fit(compact)} vs ${fit(linear)}`);
  assert.deepEqual(positions(compact), positions(layout(model)), 'repeatable layout');
  for (const n of compact.nodes) {
    const old = linear.nodes.find(other => other.id === n.id);
    assert.deepEqual([n.w, n.h], [old.w, old.h], 'card dimensions stay stable');
    for (const other of compact.nodes) if (other !== n) assert.ok(!overlaps(n, other), `${n.id} overlaps ${other.id}`);
  }
  for (const e of compact.edges) {
    assert.equal(e.edge, model.root.edges[e.index], 'original edge identity and scope index');
    for (const n of compact.nodes) {
      if ([e.edge.from, e.edge.to].includes(n.id)) continue;
      for (let i = 1; i < e.points.length; i++) {
        const p = e.points[i - 1], q = e.points[i];
        const crossing = p.x === q.x
          ? p.x > n.x && p.x < n.x + n.w && Math.max(p.y, q.y) > n.y && Math.min(p.y, q.y) < n.y + n.h
          : p.y === q.y && p.y > n.y && p.y < n.y + n.h && Math.max(p.x, q.x) > n.x && Math.min(p.x, q.x) < n.x + n.w;
        assert.ok(!crossing, `${e.edge.from} → ${e.edge.to} crosses ${n.id}`);
      }
    }
  }
  model.root.layout = 'linear';
  assert.deepEqual(model, before, 'layout does not rewrite nodes, edges, hierarchy or pins');
  assert.deepEqual(positions(layout(model)), positions(linear), 'return to default is exact');
});

test('compact layout respects exact pins and explicit routes, with separate child layouts', () => {
  const { model } = parse(processSource());
  const child = positions(layout(model, 'step-0'));
  model.root.layout = 'compact';
  model.byId.get('step-2').position = { x: -300, y: 260 };
  model.root.edges[2].via = { x: -200, y: -180 };
  model.root.edges[2].route = 'stepped';
  const compact = layout(model);
  const pinned = compact.nodes.find(n => n.id === 'step-2');
  assert.deepEqual({ x: pinned.x + pinned.w / 2, y: pinned.y + pinned.h / 2 }, model.byId.get('step-2').position);
  assert.ok(pinned.pinned);
  const explicit = compact.edges.find(e => e.index === 2);
  const to = compact.nodes.find(n => n.id === explicit.edge.to);
  assert.deepEqual(explicit.points, routeEdge(pinned, to, explicit.edge).points);
  assert.deepEqual(positions(layout(model, 'step-0')), child, 'parent arrangement does not change the child level');
});

test('layout setting validates, round trips, preserves comments and pins, and is local to one level', () => {
  const source = '# keep this comment\nname: Example\nnodes:\n  - id: parent\n    type: process\n    label: Parent\n    position: { x: 10, y: -20 }\n    children:\n      - id: child\n        type: process\n        label: Child # inline comment\n';
  Object.assign(state, parse(source));
  assert.equal(state.model.root.layout, 'linear');
  setScopeLayout('parent', 'compact');
  let out = state.doc.toString({ lineWidth: 0 });
  let restored = parse(out).model;
  assert.equal(restored.root.layout, 'linear');
  assert.equal(restored.byId.get('parent').children.layout, 'compact');
  assert.deepEqual(restored.byId.get('parent').position, { x: 10, y: -20 });
  assert.ok(out.includes('# keep this comment') && out.includes('# inline comment'));
  setScopeLayout(null, 'compact');
  assert.equal(parse(state.doc.toString()).model.root.layout, 'compact');
  setScopeLayout('parent', 'linear');
  setScopeLayout(null, 'linear');
  out = state.doc.toString();
  assert.ok(!out.includes('layout:'));
  for (const invalid of ['sideways', 'null', '[compact]', '{rows: 3}']) {
    const result = parseMap(`name: Invalid\nlayout: ${invalid}\nnodes: []\n`);
    assert.equal(result.model, null);
    assert.match(result.errors[0].message, /layout/);
  }
  assert.throws(() => setScopeLayout(null, 'sideways'), /layout/);
  const emptyChild = parseMap('name: Empty child\nnodes:\n  - id: parent\n    type: process\n    label: Parent\n    children: {layout: sideways, nodes: [], edges: []}\n');
  assert.equal(emptyChild.model, null);
  assert.equal(emptyChild.errors[0].path, 'nodes.0.children.layout');
  Object.assign(state, parse('name: Empty\nlayout: compact\nnodes: []\n'));
  setMapMode('freeform');
  assert.equal(parse(state.doc.toString()).model.mode, 'freeform');
  assert.ok(!state.doc.toString().includes('layout:'));
  assert.equal(parseMap('name: Freeform\nmode: freeform\nlayout: compact\nelements: []\nnodes: []\n').model, null);
});
