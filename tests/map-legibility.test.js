import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeNode, routeParallelEdges, routeDirect, placeEdgeLabels, edgeLabelBubble, cardLayout } from '../app/layout.js';
import { connectionsOf } from '../shared/connections.js';
import { parseMap } from '../shared/model.js';
import { bugReportDraft } from '../app/bug-report.js';

const width = text => String(text).length * 7.2;
globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: width(text) }) }) }) };

test('decision labels keep every word and fit the sloped shape, which grows for long questions', () => {
  for (const label of ['Approve claim level rules', 'A very long question about which approval rules should apply?', 'AnUnbrokenIdentifierThatWouldOtherwiseOverflow',
    'Does the payer accept this claim as submitted, or does it need corrected codes, a new attachment, or a call to the provider first?']) {
    const node = sizeNode({ type: 'decision', label });
    assert.ok(node.w >= 176 && node.h >= 120);
    assert.equal(node.lines.join('').replace(/\s+/g, ''), label.replace(/\s+/g, ''), 'no word is cut off');
    node.lines.forEach((line, index) => {
      const baseline = (node.h - node.lines.length * 17) / 2 + 13 + index * 17;
      const outerY = Math.max(Math.abs(baseline - 13 - node.h/2), Math.abs(baseline + 3 - node.h/2));
      const usable = node.w * (1 - outerY / (node.h/2));
      assert.ok(width(line) + 4 <= usable, `${line} stays inside the diamond`);
    });
  }
});

test('parallel return connectors have separate lanes, anchored endpoints, and unchanged manual routes', () => {
  const a = { id: 'a', x: 0, y: 0, w: 200, h: 64 };
  const b = { id: 'b', x: 440, y: 0, w: 200, h: 64 };
  const edges = [{ edge: { from: 'a', to: 'b' } }, { edge: { from: 'b', to: 'a' } }];
  routeParallelEdges([a, b], edges);
  assert.notDeepEqual(edges[0].labelPos, edges[1].labelPos);
  assert.equal(edges[0].points[0].x, 200);
  assert.equal(edges[0].points.at(-1).x, 440);
  assert.equal(edges[1].points[0].x, 440);
  assert.equal(edges[1].points.at(-1).x, 200);
  for (const edge of edges) assert.equal(edge.smooth, true);
  const manual = { edge: { from: 'a', to: 'b', via: { x: 320, y: 180 } }, points: [{ x: 1, y: 2 }], labelPos: { x: 1, y: 2 } };
  const before = structuredClone(manual);
  routeParallelEdges([a, b], [edges[0], manual]);
  assert.deepEqual(manual, before);
  const blocker = { id: 'c', x: 250, y: 0, w: 100, h: 64 };
  const routed = [0, 1].map(i => ({ edge: { from: 'a', to: 'b' }, points: [{x: 200, y: 32}, {x: 230, y: -80 - i*50}, {x: 410, y: -80 - i*50}, {x: 440, y: 32}], labelPos: {x: 320, y: -80 - i*50} }));
  const original = structuredClone(routed);
  routeParallelEdges([a, blocker, b], routed);
  assert.deepEqual(routed, original, 'obstructed corridors retain their original detours');
});

test('crowded two-line labels move clear of nodes and each other with a connector leader', () => {
  const a = { id: 'a', x: 0, y: 0, w: 200, h: 64 };
  const b = { id: 'b', x: 260, y: 0, w: 200, h: 64 };
  const edges = [0, 1].map(index => ({ index, edge: { from: 'a', to: 'b', label: 'A detailed description of the request' }, ...routeDirect(a, b) }));
  const nodesBefore = structuredClone([a, b]);
  const paths = edges.map(edge => structuredClone(edge.points));
  placeEdgeLabels([a, b], edges);
  for (const [i, edge] of edges.entries()) {
    assert.deepEqual(edge.points, paths[i]);
    assert.ok(edge.labelAnchor, 'off-route text is visibly tied back to its connector');
    const box = edgeLabelBubble(edge.edge.label);
    assert.ok(edge.labelPos.y + box.h/2 < 0 || edge.labelPos.y - box.h/2 > 64);
  }
  assert.notDeepEqual(edges[0].labelPos, edges[1].labelPos);
  assert.deepEqual([a, b], nodesBefore, 'pins/positions do not move to make room for labels');
});

test('connection inspector covers directions, parallel paths and declared dependencies without changing source', () => {
  const source = `name: Synthetic relationships
nodes:
  - { id: a, type: process, label: Intake }
  - { id: b, type: process, label: Review, planning: { dependsOn: [a] } }
  - { id: c, type: system, label: Console }
edges:
  - { from: a, to: b, label: Request, meaning: flow }
  - { from: b, to: a, label: Revision, meaning: flow }
  - { from: a, to: c, label: uses, meaning: association }
`;
  const { model, doc, errors } = parseMap(source);
  assert.deepEqual(errors, []);
  const before = doc.toString();
  const connections = connectionsOf(model, 'a');
  assert.equal(connections.length, 4);
  assert.deepEqual(connections.map(item => item.direction), ['Outgoing', 'Incoming', 'Related', 'Incoming']);
  assert.equal(connections[3].label, 'Depends on');
  assert.equal(doc.toString(), before);
});

test('bug reports hand off only explicitly entered content and safe diagnostics to the fixed public repo', () => {
  const report = bugReportDraft({ title: 'Diamond label', happened: 'Text overlaps', steps: 'Select a decision', expected: 'Text fits', photos: 2, diagnostics: 'Theme: glass' });
  assert.equal(new URL(report.url).origin, 'https://github.com');
  assert.equal(new URL(report.url).pathname, '/jross787/serigraph/issues/new');
  assert.match(report.body, /Attach the 2 reviewed photos/);
  assert.doesNotMatch(report.body, /localhost|\/Users\/|source:|token|data:image/);
  assert.equal(new URL(report.url).searchParams.get('body'), report.body);
});

test('cards grow to show their whole name and description, and keep a chosen width', () => {
  const description = 'Collect the intake form, check the insurance card, and confirm the referral.\n\nThen https://example.test/a/really/long/path/that/cannot/wrap/at/spaces goes in the note.';
  const card = cardLayout({ label: 'Verify the new patient before the first visit', description });
  assert.equal(card.w, 200);
  assert.ok(card.h > 64, 'a long description makes the card taller');
  assert.equal(card.desc.join('').replace(/\s+/g, ''), description.replace(/\s+/g, ''), 'every word and the link stay visible');
  assert.ok(card.desc.includes(''), 'a blank line between paragraphs is kept');
  assert.equal(cardLayout({ label: 'Short' }).h, 64, 'a short card keeps the standard size');
  const wide = cardLayout({ label: 'Verify the new patient before the first visit', description }, 480);
  assert.equal(wide.w, 480);
  assert.ok(wide.h < card.h, 'a wider card needs fewer lines');
  assert.equal(cardLayout({ label: 'x' }, 9999).w, 720);
});
