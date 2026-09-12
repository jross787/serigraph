// Pinned edge routes (via points): parsing, validation, and the set/clear
// edit operations. Mirrors position.test.js — a via is presentation metadata
// on an edge, additive and removable, exactly like a node's position pin.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';
import { routeDragged, routeStyled, routeEdge, routeAutomaticEdges } from '../app/layout.js';

const BASE = `# via test map — top comment
name: Routes
nodes:
  # the first node
  - id: intake
    type: process
    label: Intake # inline comment
  - id: qualify
    type: decision
    label: Qualified?
  - id: bind
    type: process
    label: Bind

edges:
  - from: intake
    to: qualify
  - from: qualify
    to: bind
    label: approved
    via: { x: 700, y: 40 }
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

test('stepped detours never retrace the segment at an outside bend', () => {
  const a = { x: 0, y: 0, w: 200, h: 64, node: {} };
  const b = { x: 300, y: 0, w: 200, h: 64, node: {} };
  for (const sides of [{}, { fromSide: 'bottom', toSide: 'bottom' }, { fromSide: 'top', toSide: 'top' }]) {
    for (const point of [{ x: 600, y: 180 }, { x: -100, y: 180 }, { x: 600, y: -180 }, { x: -100, y: -180 }]) {
      const result = routeDragged(a, b, { route: 'stepped', ...sides }, point);
      assert.deepEqual(result.labelPos, point, 'the bend remains under the pointer');
      for (let i = 1; i < result.points.length - 1; i++) {
        const p = result.points[i - 1], q = result.points[i], r = result.points[i + 1];
        const sameLine = (p.x === q.x && q.x === r.x) || (p.y === q.y && q.y === r.y);
        const dot = (q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y);
        assert.ok(!sameLine || dot >= 0, `no retracing at ${JSON.stringify({ sides, point, q })}`);
      }
    }
  }
});

test('stepped connector dragging follows both pointer axes and survives serialization', () => {
  const a = { x: 0, y: 0, w: 200, h: 64, node: {} };
  for (const [b, sides, points] of [
    [{ x: 0, y: 300, w: 200, h: 64, node: {} }, { fromSide: 'bottom', toSide: 'top' },
      [{ x: -160, y: 180 }, { x: 340, y: 240 }]],
    [{ x: 600, y: 0, w: 200, h: 64, node: {} }, { fromSide: 'right', toSide: 'left' },
      [{ x: 320, y: -140 }, { x: 440, y: 200 }]],
  ]) for (const attachments of [sides, {}]) for (const point of points) {
    const edge = { route: 'stepped', ...attachments };
    const before = structuredClone([a, b]);
    const preview = routeDragged(a, b, edge, point);
    assert.deepEqual(preview.labelPos, point, 'the bubble follows both pointer axes');
    assert.ok(preview.points.some((p) => p.x === point.x && p.y === point.y), 'the route passes through the dragged point');
    assert.ok(preview.points.slice(1).every((p, i) => p.x === preview.points[i].x || p.y === preview.points[i].y));
    assert.deepEqual([a, b], before, 'dragging the connector never moves its cards');
    edit.setEdgeRoute(null, 0, preview.style);
    edit.setEdgeVia(null, 0, preview.via);
    edit.setEdgeSide({ scopeId: null, index: 0 }, 'from', edge.fromSide ?? null);
    edit.setEdgeSide({ scopeId: null, index: 0 }, 'to', edge.toSide ?? null);
    const restored = routeEdge(a, b, reserialize().model.root.edges[0]);
    assert.deepEqual(restored.points, preview.points);
    assert.deepEqual(restored.labelPos, point);
  }
});

test('attachment sides validate independently and default to Auto', () => {
  assert.equal(state.model.root.edges[0].fromSide, null);
  assert.equal(state.model.root.edges[0].toSide, null);
  for (const key of ['fromSide', 'toSide']) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const result = parseMap(BASE.replace('label: approved', `label: approved\n    ${key}: ${side}`));
      assert.deepEqual(result.errors, []);
      assert.equal(result.model.root.edges[1][key], side);
    }
    for (const bad of ['auto', 'middle', '3', '{}']) {
      const result = parseMap(BASE.replace('label: approved', `label: approved\n    ${key}: ${bad}`));
      assert.ok(result.errors.some((e) => e.message.includes(`"${key}:"`)));
    }
  }
});

test('attachment edits, reversal, rewiring and release preserve unrelated YAML', () => {
  const ref = { scopeId: null, index: 1 };
  edit.setEdgeSide(ref, 'from', 'top');
  edit.setEdgeSide(ref, 'to', 'left');
  edit.reverseEdge(ref);
  let saved = reserialize();
  assert.equal(saved.model.root.edges[1].fromSide, 'left');
  assert.equal(saved.model.root.edges[1].toSide, 'top');
  edit.rewireEdge(ref, { from: 'intake', to: 'bind' });
  edit.setEdgeSide(ref, 'from', null);
  edit.reverseEdge(ref);
  saved = reserialize();
  assert.equal(saved.model.root.edges[1].fromSide, 'top');
  assert.equal(saved.model.root.edges[1].toSide, null);
  assert.deepEqual(saved.model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(saved.model.root.edges[1].label, 'approved');
  assert.ok(saved.out.includes('# inline comment'));
  edit.setEdgeSide(ref, 'from', null);
  assert.doesNotMatch(reserialize().out, /fromSide:|toSide:/);
  assert.throws(() => edit.setEdgeSide(ref, 'from', 'middle'), /invalid attachment/);
  assert.throws(() => edit.setEdgeSide(ref, 'source', 'top'), /invalid edge endpoint/);
});

test('every route shape and drag preview retains chosen sides, including moved diamonds', () => {
  const a = { x: 0, y: 0, w: 200, h: 64, node: {} };
  const b = { x: 600, y: 200, w: 160, h: 100, node: { type: 'decision' } };
  const port = (n, side) => ({
    top: { x: n.x + n.w / 2, y: n.y }, right: { x: n.x + n.w, y: n.y + n.h / 2 },
    bottom: { x: n.x + n.w / 2, y: n.y + n.h }, left: { x: n.x, y: n.y + n.h / 2 },
  })[side];
  for (const moved of [false, true]) {
    if (moved) { a.x += 90; b.y -= 80; }
    for (const fromSide of ['top', 'right', 'bottom', 'left']) {
      for (const toSide of ['top', 'right', 'bottom', 'left']) {
        for (const route of [null, 'straight', 'curved', 'angled', 'stepped']) {
          const edge = { fromSide, toSide, route };
          const routes = [routeEdge(a, b, edge)];
          if (route !== 'straight') routes.push(routeDragged(a, b, edge, { x: 380, y: -60 }));
          for (const result of routes) {
            assert.deepEqual(result.points[0], port(a, fromSide));
            assert.deepEqual(result.points.at(-1), port(b, toSide));
            if (!route || route === 'stepped') assert.ok(result.points.slice(1).every((p, i) =>
              p.x === result.points[i].x || p.y === result.points[i].y));
          }
        }
      }
    }
  }
});

test('automatic routing leaves side attachments intact and same-side routes clear card borders', () => {
  const a = { id: 'a', x: 0, y: 0, w: 200, h: 64, node: {} };
  const b = { id: 'b', x: 600, y: 0, w: 200, h: 64, node: {} };
  const edge = { from: 'a', to: 'b', fromSide: 'top', toSide: 'top' };
  const routed = { index: 0, edge, ...routeEdge(a, b, edge) };
  const before = structuredClone(routed.points);
  assert.ok(before[1].y < a.y);
  routeAutomaticEdges([a, b], [routed]);
  assert.deepEqual(routed.points, before);
  const mixed = routeEdge(b, a, { fromSide: 'left', toSide: 'top' });
  assert.ok(mixed.points[1].x > a.x + a.w, 'mixed-side turn stays between the cards');
  assert.ok(mixed.points.at(-2).y < a.y, 'arrives from above the top side');
});

test('dragged routes keep their shape and serialize the exact preview', () => {
  const a = { x: 0, y: 0, w: 200, h: 64, node: {} };
  const b = { x: 600, y: 200, w: 200, h: 64, node: {} };
  const point = { x: 360.4, y: 109.7 };
  assert.equal(routeDragged(a, b, { route: 'straight' }, point), null, 'straight bend is a no-op');
  for (const [edge, expected] of [
    [{}, 'stepped'],
    [{ via: { x: 320, y: 100 } }, 'curved'],
    ...['angled', 'stepped', 'curved'].map(route => [{ route }, route]),
  ]) {
    const preview = routeDragged(a, b, edge, point);
    assert.equal(preview.style, expected);
    assert.deepEqual(preview.via, { x: 360, y: 110 });
    edit.setEdgeVia(null, 0, preview.via);
    edit.setEdgeRoute(null, 0, preview.style);
    const saved = reserialize().model.root.edges[0];
    const restored = routeStyled(a, b, saved.via, saved.route);
    assert.deepEqual(restored.points, preview.points);
    assert.deepEqual(restored.labelPos, preview.labelPos);
    if (expected === 'stepped') {
      assert.ok(preview.points.slice(1).every((p, i) => p.x === preview.points[i].x || p.y === preview.points[i].y));
    }
  }
});

test('parseMap reads via as the edge model field', () => {
  const { model, errors } = parseMap(BASE);
  assert.equal(errors.length, 0);
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[0].via, null, 'unpinned edges keep automatic routing');
});

test('parseMap rejects malformed via values', () => {
  for (const bad of ['via: hello', 'via: [1, 2]', 'via: { x: 1 }', 'via: { x: a, y: 2 }']) {
    const { errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', bad));
    assert.ok(errors.some((e) => /"via:"/.test(e.message)), `flags: ${bad}`);
  }
});

test('setEdgeVia writes a one-line flow map, rounded, comments intact', () => {
  edit.setEdgeVia(null, 0, { x: 260.4, y: 39.6 });
  const { out, model } = reserialize();
  assert.deepEqual(model.root.edges[0].via, { x: 260, y: 40 });
  assert.ok(out.includes('via: { x: 260, y: 40 }'), 'one-line flow map');
  for (const c of ['# via test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }
});

test('setEdgeVia updates an existing pin in place', () => {
  edit.setEdgeVia(null, 1, { x: 640, y: -120 });
  const { out, model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 640, y: -120 });
  assert.equal((out.match(/via:/g) ?? []).length, 1, 'still exactly one via key');
});

test('clearEdgeVia removes the field and is a no-op when absent', () => {
  edit.clearEdgeVia(null, 1);
  const { out, model } = reserialize();
  assert.equal(model.root.edges[1].via, null);
  assert.ok(!out.includes('via:'), 'via key gone from the file');

  edit.clearEdgeVia(null, 0); // never had one — must not throw
  reserialize();
});

test('updateEdge leaves an existing via untouched', () => {
  edit.updateEdge(null, 1, { label: 'approved by credit' });
  const { model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[1].label, 'approved by credit');
});

test('via survives on an edge inside a nested scope', () => {
  load(`
name: Nested routes
nodes:
  - id: wrap
    type: process
    label: Wrapper
    children:
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
  edit.setEdgeVia('wrap', 0, { x: 100, y: 50 });
  edit.setEdgeSide({ scopeId: 'wrap', index: 0 }, 'to', 'bottom');
  const { model } = reserialize();
  assert.deepEqual(model.byId.get('wrap').children.edges[0].via, { x: 100, y: 50 });
  assert.equal(model.byId.get('wrap').children.edges[0].toSide, 'bottom');
});

test('parseMap reads route as the edge model field', () => {
  const { model, errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', 'via: { x: 700, y: 40 }\n    route: stepped'));
  assert.equal(errors.length, 0);
  assert.equal(model.root.edges[1].route, 'stepped');
  assert.equal(model.root.edges[0].route, null, 'unstyled edges keep automatic routing');
});

test('parseMap rejects an unknown route style', () => {
  const { errors } = parseMap(BASE.replace('via: { x: 700, y: 40 }', 'route: wiggly'));
  assert.ok(errors.some((e) => /"route:" must be one of/.test(e.message)));
});

test('setEdgeRoute writes and clears the style, comments intact', () => {
  edit.setEdgeRoute(null, 0, 'angled');
  const { out, model } = reserialize();
  assert.equal(model.root.edges[0].route, 'angled');
  assert.ok(out.includes('route: angled'));
  for (const c of ['# via test map — top comment', '# the first node', '# inline comment']) {
    assert.ok(out.includes(c), `comment survived: ${c}`);
  }

  edit.setEdgeRoute(null, 0, null);
  const { out: out2, model: m2 } = reserialize();
  assert.equal(m2.root.edges[0].route, null);
  assert.ok(!out2.includes('route:'), 'route key gone from the file');
});

test('updateEdge leaves an existing via and route untouched', () => {
  load(BASE.replace('via: { x: 700, y: 40 }', 'via: { x: 700, y: 40 }\n    route: curved'));
  edit.updateEdge(null, 1, { label: 'approved by credit' });
  const { model } = reserialize();
  assert.deepEqual(model.root.edges[1].via, { x: 700, y: 40 });
  assert.equal(model.root.edges[1].route, 'curved');
  assert.equal(model.root.edges[1].label, 'approved by credit');
});
