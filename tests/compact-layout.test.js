import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseMap } from '../shared/model.js';
import { layoutScope, invalidateLayouts, routeEdge, edgeLabelBubble, placeEdgeLabels, labelClearancePath } from '../app/layout.js';
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

function pointOnSegment(p, a, b) {
  const length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))) < 1e-6;
}

test('labels stay on their own paths and clear branches, returns and shared endpoints in both layouts', () => {
  for (const mode of ['linear', 'compact']) {
    const { model } = parse(processSource());
    model.root.layout = mode;
    const result = layout(model);
    for (const e of result.edges.filter(e => e.edge.label)) {
      const bubble = edgeLabelBubble(e.edge.label);
      assert.ok(e.points.slice(1).some((p, i) => pointOnSegment(e.labelPos, e.points[i], p)), `${mode}: ${e.edge.label} belongs to its own route`);
      for (const other of result.edges) {
        if (other === e) continue; // own line is expected behind its bubble
        for (let i = 1; i < other.points.length; i++) {
          const a = other.points[i - 1], b = other.points[i];
          const samples = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
          for (let j = 0; j <= samples; j++) {
            const t = samples ? j / samples : 0;
            const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
            assert.ok(Math.abs(x - e.labelPos.x) > bubble.w / 2 + 3 || Math.abs(y - e.labelPos.y) > bubble.h / 2 + 3,
              `${mode}: ${other.edge.label} crosses ${e.edge.label}`);
          }
        }
      }
    }
    const handoff6 = result.edges.find(e => e.edge.label === 'Handoff 6');
    const handoff7 = result.edges.find(e => e.edge.label === 'Handoff 7');
    if (mode === 'compact') {
      assert.ok(handoff6.labelPos.y < handoff7.labelPos.y - 28, 'the incoming label clears both gutter tracks');
      assert.ok(handoff7.labelPos.x > handoff6.labelPos.x + edgeLabelBubble(handoff7.edge.label).w / 2 + 8, 'the outgoing label leaves the shared vertical corridor');
    }
  }
});

test('curved label avoidance follows the rendered quadratic and preserves manual route controls', () => {
  const curve = { edge: { from: 'a', to: 'b', label: 'Curve', route: 'curved', via: { x: 100, y: 100 } }, smooth: true,
    points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }], labelPos: { x: 60, y: 84 } };
  const crossing = { edge: { from: 'a', to: 'c' }, points: [{ x: 60, y: -100 }, { x: 60, y: 200 }], labelPos: { x: 60, y: 50 } };
  const before = structuredClone(curve);
  assert.ok(placeEdgeLabels([], [curve, crossing]).has(curve));
  assert.ok(Math.abs(curve.labelPos.y - (2 * curve.labelPos.x - curve.labelPos.x ** 2 / 100)) < 1e-8, 'point is on the quadratic, not its control polygon');
  assert.ok(curve.labelPos.x - edgeLabelBubble('Curve').w / 2 > 60);
  assert.deepEqual(curve.edge, before.edge);
  assert.deepEqual(curve.points, before.points);
  assert.equal(placeEdgeLabels([], [curve, crossing]).size, 0, 'already-clear placement is stable');
});

test('overlapping fallback label cutouts form a union and do not reopen strokes or hit targets', () => {
  const bounds = { x: 0, y: 0, w: 200, h: 200 };
  const boxes = [{ x: 10, y: 10, w: 80, h: 80 }, { x: 50, y: 50, w: 80, h: 80 }];
  const d = labelClearancePath(bounds, boxes);
  const visible = [...d.matchAll(/M(-?[\d.]+),(-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h-?[\d.]+Z/g)]
    .map(([, x, y, w, h]) => ({ x: Number(x), y: Number(y), w: Number(w), h: Number(h) }));
  const contains = (b, x, y) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
  for (let x = 2.5; x < 200; x += 5) for (let y = 2.5; y < 200; y += 5) {
    assert.equal(visible.some(b => contains(b, x, y)), !boxes.some(b => contains(b, x, y)), `clip at ${x}, ${y}`);
  }
  const first = { edge: { from: 'a', to: 'b', label: 'Fallback label', route: 'straight' }, points: [{ x: 0, y: 0 }, { x: 500, y: 0 }], labelPos: { x: 250, y: 0 } };
  const reverse = { edge: { from: 'b', to: 'a', route: 'straight' }, points: [...first.points].reverse(), labelPos: { x: 250, y: 0 } };
  const original = structuredClone([first, reverse]);
  assert.equal(placeEdgeLabels([], [first, reverse]).size, 0, 'no invented off-route label when every candidate overlaps');
  assert.deepEqual([first, reverse], original, 'drawing cutouts handle fallback without changing authored routes');
});

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
