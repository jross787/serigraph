// Flow — the operating model in motion. A rotatable 3D reading of the
// current scope: every node is a building on a ground grid, every handoff is
// a lane styled by how the data actually moves (API, file, manual re-entry,
// event), and payloads — the real work items — travel the lanes at the pace
// recorded in the file. Confirmed problems (`issue:` on an edge) render
// loudly. Drag rotates the scene, ⌘-drag pans, scroll zooms, and dragging a
// building moves it — persisted as a one-line `flowPosition:` in the YAML,
// additive and removable like every other presentation field.
import { state, bus } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import { scopeOf } from '../shared/model.js';
import { nodeCost, rollupCost, formatMoney } from '../shared/cost.js';
import {
  buildFlowScene,
  enumerateFlows,
  integrationStats,
  payloadCadence,
  codeFor,
  WORK_TYPES,
  SUPPORT_TYPES,
} from './flow-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID = { col: 2.05, row: 1.8 }; // ground-plane spacing between tiles
const UNIT = 82; // px per grid step at zoom 1
const PAYLOAD_SPEED = 105; // px per second along a lane
const MAX_PAYLOADS = 48;
const MAX_HOPS = 16;
const SNAP = 0.25; // building drag snaps to quarter tiles

const TYPE_WORD = {
  process: 'Step',
  decision: 'Decision',
  system: 'System',
  role: 'Person or team',
  artifact: 'Document',
};

const KINDS = {
  api: { glyph: 'API', word: 'API call' },
  file: { glyph: 'FILE', word: 'File transfer' },
  manual: { glyph: 'MAN', word: 'Manual re-entry' },
  event: { glyph: 'EVT', word: 'Event / webhook' },
};

// ── ephemeral module state (never persisted — see DESIGN.md rule 4) ──
const sim = {
  key: '',
  raf: 0,
  lastTime: 0,
  paused: false,
  reduced: false,
  scene: null,
  geo: null, // Map<nodeId, entry>
  lanes: [],
  outgoing: new Map(),
  flows: [],
  flowIndex: -1,
  tracer: null,
  payloads: [],
  pulses: [],
  spawners: [],
  selection: null, // {kind:'node'|'edge'|'payload'|'tracer', id|index}
  tab: 'does',
  nextPayloadId: 1,
  els: {},
  cam: null, // { yaw, tilt, zoom, panX, panY }
  suppressClick: false,
};

// yaw π/4 is the classic isometric diamond; 0 would be a flat front view
const defaultCam = () => ({ yaw: Math.PI / 4, tilt: 0.52, zoom: 1, panX: 0, panY: 0 });

// ── tiny DOM helpers ─────────────────────────────────────────────────
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.setAttribute('class', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

const text = (value) => document.createTextNode(String(value));
const pts = (list) => list.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const labelize = (value) => String(value || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const truncate = (value, n = 22) => (value.length > n ? `${value.slice(0, n - 1)}…` : value);
const runsOf = (node) => node?.cost?.runs ?? null;

function maxRunsIn(scope) {
  let max = 0;
  for (const node of scope.nodes) max = Math.max(max, runsOf(node) ?? 0);
  return max;
}

// ── projection ───────────────────────────────────────────────────────
// The ground plane rotates by yaw and tilts toward the viewer; z rises
// straight up in pixels. Zoom and pan are a screen-space transform on the
// viewport group, so heights scale with the scene.
let CS = 1;
let SN = 0;
let TILT = 0.52;

function refreshBasis() {
  CS = Math.cos(sim.cam.yaw);
  SN = Math.sin(sim.cam.yaw);
  TILT = sim.cam.tilt;
}

// The scene orbits its own ground centroid, so rotating feels like turning
// the model in your hand instead of swinging it around the grid origin.
let CENTER = { col: 0, row: 0 };

function project(col, row, z = 0) {
  const c = (col - CENTER.col) * GRID.col;
  const r = (row - CENTER.row) * GRID.row;
  return {
    x: (c * CS - r * SN) * UNIT,
    y: (c * SN + r * CS) * UNIT * TILT - z,
  };
}

const depthOf = (col, row) => ((col - CENTER.col) * GRID.col * SN + (row - CENTER.row) * GRID.row * CS);

function signedArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

// Screen-space x of a ground normal: negative faces the (fixed) light.
const litSide = (nc, nr) => (nc * CS - nr * SN) < 0;

// ── node shapes ──────────────────────────────────────────────────────
function heightFor(node, maxRuns) {
  const volume = runsOf(node);
  const boost = volume != null && maxRuns > 0 ? 26 * Math.sqrt(volume / maxRuns) : 0;
  switch (node.type) {
    case 'decision': return 14;
    case 'system': return 52;
    case 'role': return 18;
    case 'artifact': return 7;
    default: return 30 + boost + (node.children ? 8 : 0);
  }
}

function footprintFor(node) {
  switch (node.type) {
    case 'decision': return { w: 0.5, d: 0.5 };
    case 'system': return { w: 0.4, d: 0.4 };
    case 'role': return { w: 0.42, d: 0.42 };
    case 'artifact': return { w: 0.58, d: 0.42 };
    default: return { w: 0.56, d: 0.56 };
  }
}

// Footprint corners in grid units around (col,row): order N, E, S, W in
// grid space; screen roles change as the scene rotates.
function gridCorners(col, row, w, d) {
  const hw = w / (2 * GRID.col);
  const hd = d / (2 * GRID.row);
  return [
    [col - hw, row - hd],
    [col + hw, row - hd],
    [col + hw, row + hd],
    [col - hw, row + hd],
  ];
}

// Ground outward normals for the face between corner i and i+1.
const FACE_NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function makeBuilding(entry) {
  const { node } = entry;
  const g = s('g', {
    class: `flow-building t-${node.type}${node.children ? ' has-children' : ''}`,
    'data-id': node.id,
  });
  g.append(s('title', {}, text(`${node.label} — ${TYPE_WORD[node.type] ?? node.type}`)));
  const els = { g, sides: [], pyr: [], rules: [] };

  els.tile = s('polygon', { class: 'flow-tile' });
  g.append(els.tile);

  if (node.type === 'role') {
    els.body = s('path', { class: 'flow-side shade-dark flow-cyl-body' });
    els.cap = s('ellipse', { class: 'flow-face-top' });
    g.append(els.body, els.cap);
  } else {
    for (let i = 0; i < 4; i += 1) {
      const face = s('polygon', { class: 'flow-side' });
      els.sides.push(face);
      g.append(face);
    }
    els.top = s('polygon', { class: 'flow-face-top' });
    g.append(els.top);
    if (node.type === 'decision') {
      for (let i = 0; i < 4; i += 1) {
        const face = s('polygon', { class: 'flow-side flow-pyr' });
        els.pyr.push(face);
        g.append(face);
      }
    }
    if (node.type === 'system') {
      els.mast = s('line', { class: 'flow-mast' });
      els.mastDot = s('circle', { class: 'flow-mast-dot', r: 2.6 });
      g.append(els.mast, els.mastDot);
    }
    if (node.type === 'artifact') {
      for (const _ of [0, 1, 2]) {
        const rule = s('line', { class: 'flow-rule' });
        els.rules.push(rule);
        g.append(rule);
      }
    }
  }

  // one centered caption line: code chip, then markers, then the label
  const label = s('g', { class: 'flow-node-label' });
  els.chip = s('rect', { class: `flow-code t-${node.type}`, height: 13, rx: 3 });
  els.chipText = s('text', { class: 'flow-code-text', 'text-anchor': 'middle' }, text(entry.code));
  label.append(els.chip, els.chipText);
  let markers = '';
  if (node.children) markers += `▣${node.stats?.childCount ?? ''}`;
  if (entry.flagged) markers += `${markers ? ' ' : ''}⚑`;
  if (markers) {
    els.markers = s('text', { class: `flow-markers${entry.flagged ? ' flagged' : ''}` }, text(markers));
    label.append(els.markers);
  }
  els.labelText = s('text', { class: 'flow-label-text' }, text(truncate(node.label)));
  label.append(els.labelText);
  g.append(label);
  els.markerText = markers;
  entry.els = els;
  return g;
}

function updateBuilding(entry) {
  const { node, col, row, height, els } = entry;
  const { w, d } = footprintFor(node);
  const base = project(col, row, 0);
  entry.base = base;
  entry.depth = depthOf(col, row);

  const tileCorners = gridCorners(col, row, w + 0.22, d + 0.22).map(([c, r]) => project(c, r, 0));
  els.tile.setAttribute('points', pts(tileCorners));
  entry.tilePts = tileCorners;

  let labelY = Math.max(...tileCorners.map((p) => p.y));

  if (node.type === 'role') {
    const rx = 24;
    const ry = Math.max(6, rx * TILT);
    const top = project(col, row, height);
    els.body.setAttribute('d',
      `M ${base.x - rx} ${top.y} L ${base.x - rx} ${base.y} A ${rx} ${ry} 0 0 0 ${base.x + rx} ${base.y} L ${base.x + rx} ${top.y} Z`);
    els.cap.setAttribute('cx', base.x);
    els.cap.setAttribute('cy', top.y);
    els.cap.setAttribute('rx', rx);
    els.cap.setAttribute('ry', ry);
  } else {
    const corners = gridCorners(col, row, w, d);
    const topPts = corners.map(([c, r]) => project(c, r, height));
    const basePts = corners.map(([c, r]) => project(c, r, 0));
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const quad = [topPts[i], topPts[j], basePts[j], basePts[i]];
      const face = els.sides[i];
      if (signedArea(quad) < -3) {
        face.setAttribute('points', pts(quad));
        face.setAttribute('display', '');
        face.classList.toggle('shade-light', litSide(...FACE_NORMALS[i]));
        face.classList.toggle('shade-dark', !litSide(...FACE_NORMALS[i]));
      } else {
        face.setAttribute('display', 'none');
      }
    }
    els.top.setAttribute('points', pts(topPts));

    if (node.type === 'decision') {
      const apex = project(col, row, height + 22);
      for (let i = 0; i < 4; i += 1) {
        const j = (i + 1) % 4;
        const tri = [topPts[i], topPts[j], apex];
        const face = els.pyr[i];
        if (signedArea(tri) < -3) {
          face.setAttribute('points', pts(tri));
          face.setAttribute('display', '');
          face.classList.toggle('shade-light', litSide(...FACE_NORMALS[i]));
          face.classList.toggle('shade-dark', !litSide(...FACE_NORMALS[i]));
        } else {
          face.setAttribute('display', 'none');
        }
      }
    }
    if (node.type === 'system') {
      const from = project(col, row, height);
      const to = project(col, row, height + 15);
      els.mast.setAttribute('x1', from.x); els.mast.setAttribute('y1', from.y);
      els.mast.setAttribute('x2', to.x); els.mast.setAttribute('y2', to.y);
      els.mastDot.setAttribute('cx', to.x); els.mastDot.setAttribute('cy', to.y);
    }
    if (node.type === 'artifact') {
      els.rules.forEach((rule, i) => {
        const t = 0.35 + i * 0.2;
        const p1 = project(col - (w / (2 * GRID.col)) * (1 - 0.15), row - (d / (2 * GRID.row)) + (d / GRID.row) * t, height);
        const p2 = project(col + (w / (2 * GRID.col)) * (1 - 0.15), row - (d / (2 * GRID.row)) + (d / GRID.row) * t, height);
        rule.setAttribute('x1', p1.x); rule.setAttribute('y1', p1.y);
        rule.setAttribute('x2', p2.x); rule.setAttribute('y2', p2.y);
      });
    }
  }

  // caption: centered under the tile as one line
  const chipW = 22;
  const markerW = els.markers ? els.markerText.length * 7 + 6 : 0;
  const labelW = truncate(node.label).length * 5.7;
  const total = chipW + 4 + markerW + labelW;
  const startX = base.x - total / 2;
  const y = labelY + 8;
  els.chip.setAttribute('x', startX);
  els.chip.setAttribute('y', y);
  els.chip.setAttribute('width', chipW);
  els.chipText.setAttribute('x', startX + chipW / 2);
  els.chipText.setAttribute('y', y + 9.5);
  if (els.markers) {
    els.markers.setAttribute('x', startX + chipW + 4);
    els.markers.setAttribute('y', y + 10);
  }
  els.labelText.setAttribute('x', startX + chipW + 4 + markerW);
  els.labelText.setAttribute('y', y + 10.5);
}

// ── provenance lookups ───────────────────────────────────────────────
const nodeFlag = (id) => state.flags?.nodes?.get?.(id) ?? null;
function edgeFlag(edge) {
  const scopeOwner = state.scopeId ?? null;
  return state.flags?.edges?.find?.(
    (f) => (f.owner ?? null) === scopeOwner && f.from === edge.from && f.to === edge.to,
  )?.note ?? null;
}

// ── lanes ────────────────────────────────────────────────────────────
// Interval of the segment p1→p2 inside a convex quad; null when it misses.
// Used to stop lanes at building tiles instead of running through them.
function segmentQuadInterval(p1, p2, quad) {
  if (!quad) return null;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    if (nx * (cx - a.x) + ny * (cy - a.y) > 0) { nx = -nx; ny = -ny; } // outward
    const denom = nx * dx + ny * dy;
    const dist = nx * (p1.x - a.x) + ny * (p1.y - a.y); // > 0 means outside
    if (Math.abs(denom) < 1e-9) {
      if (dist > 0) return null;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

function makeLane(lane) {
  const cls = [
    'flow-lane',
    lane.edge.kind ? `flow-kind-${lane.edge.kind}` : (lane.work ? 'flow-lane-work' : 'flow-lane-support'),
    lane.back ? 'flow-lane-back' : '',
    lane.edge.issue ? 'flow-lane-issue' : '',
    lane.flagged ? 'flow-lane-flagged' : '',
  ].filter(Boolean).join(' ');
  const group = s('g', { class: cls });
  const tip = lane.edge.label || `${lane.from.node.label} → ${lane.to.node.label}`;
  group.append(s('title', {}, text(lane.edge.issue ? `${tip} — issue: ${lane.edge.issue}` : tip)));
  lane.lineEl = s('line', { class: 'flow-lane-line' });
  group.append(lane.lineEl);
  lane.hitEl = s('line', {
    class: 'flow-lane-hit',
    onclick: (ev) => { ev.stopPropagation(); select({ kind: 'edge', index: lane.index }); },
    onpointerenter: () => { lane.decorEl?.classList.add('flow-hover'); },
    onpointerleave: () => { lane.decorEl?.classList.remove('flow-hover'); },
  });
  group.append(lane.hitEl);
  lane.el = group;

  // labels, kind chips, and issue marks live in an overlay above the
  // buildings so they are never sliced by a wall
  lane.decorEl = s('g', { class: `${cls} flow-lane-decor` });
  if (lane.edge.label) {
    lane.labelEl = s('text', { class: 'flow-edge-label', 'text-anchor': 'middle' }, text(lane.edge.label));
    lane.decorEl.append(lane.labelEl);
  }
  if (lane.edge.kind) {
    lane.kindChip = s('g', { class: 'flow-kind-chip' });
    const glyph = KINDS[lane.edge.kind]?.glyph ?? '?';
    const cw = glyph.length * 5.6 + 8;
    lane.kindChip.append(
      s('rect', { width: cw, height: 12, rx: 3, x: -cw / 2, y: -6 }),
      s('text', { 'text-anchor': 'middle', y: 3.5 }, text(glyph)),
    );
    lane.decorEl.append(lane.kindChip);
  }
  if (lane.edge.issue) {
    lane.issueMark = s('text', { class: 'flow-issue-mark', 'text-anchor': 'middle' }, text('⚠'));
    lane.decorEl.append(lane.issueMark);
  }
  // parallel lanes stagger their chips so they never pile up at one t
  lane.chipT = 0.3 + ((lane.index % 3) * 0.2);
  return group;
}

function updateLane(lane) {
  const p1 = { x: lane.from.base.x, y: lane.from.base.y };
  const p2 = { x: lane.to.base.x, y: lane.to.base.y };
  if (lane.back) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const norm = Math.hypot(dx, dy) || 1;
    p1.x += (-dy / norm) * 8; p1.y += (dx / norm) * 8;
    p2.x += (-dy / norm) * 8; p2.y += (dx / norm) * 8;
  }

  // stop at the tile edges instead of running under the buildings
  const rawLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const gap = 5 / rawLen;
  let t0 = 0;
  let t1 = 1;
  const fromHit = segmentQuadInterval(p1, p2, lane.from.tilePts);
  if (fromHit) t0 = Math.min(Math.max(t0, fromHit[1] + gap), 1);
  const toHit = segmentQuadInterval(p1, p2, lane.to.tilePts);
  if (toHit) t1 = Math.max(Math.min(t1, toHit[0] - gap), 0);
  if (t1 - t0 < 0.12) { t0 = 0; t1 = 1; } // buildings overlap: keep the full line
  const lerp = (t) => ({ x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t });
  lane.p1 = lerp(t0);
  lane.p2 = lerp(t1);
  lane.len = Math.hypot(lane.p2.x - lane.p1.x, lane.p2.y - lane.p1.y) || 1;

  for (const el of [lane.lineEl, lane.hitEl]) {
    el.setAttribute('x1', lane.p1.x); el.setAttribute('y1', lane.p1.y);
    el.setAttribute('x2', lane.p2.x); el.setAttribute('y2', lane.p2.y);
  }
  if (lane.labelEl) {
    const mid = pointOn(lane, 0.5);
    lane.labelEl.setAttribute('x', mid.x);
    lane.labelEl.setAttribute('y', mid.y + (lane.back ? 15 : -8));
  }
  if (lane.kindChip) {
    const at = pointOn(lane, lane.chipT);
    lane.kindChip.setAttribute('transform', `translate(${at.x.toFixed(1)},${at.y.toFixed(1)})`);
  }
  if (lane.issueMark) {
    const at = pointOn(lane, lane.chipT >= 0.6 ? 0.35 : 0.75);
    lane.issueMark.setAttribute('x', at.x);
    lane.issueMark.setAttribute('y', at.y + 4);
  }
}

function laneClass(lane, cls, on) {
  lane.el?.classList.toggle(cls, on);
  lane.decorEl?.classList.toggle(cls, on);
}

// ── whole-scene geometry pass (runs on rotate, tilt, and drag) ───────
function updateGeometry() {
  refreshBasis();
  for (const entry of sim.geo.values()) updateBuilding(entry);
  for (const lane of sim.lanes) updateLane(lane);
  // painter order: farther buildings first
  const ordered = [...sim.geo.values()].sort((a, b) => a.depth - b.depth);
  for (const entry of ordered) sim.els.buildingLayer.append(entry.els.g);
  updateGridLines();
}

function updateGridLines() {
  const { gridLayer, gridBounds } = sim.els;
  if (!gridLayer) return;
  const { minC, maxC, minR, maxR } = gridBounds;
  const lines = gridLayer.children;
  let i = 0;
  for (let c = Math.floor(minC); c <= Math.ceil(maxC) && i < lines.length; c += 0.5, i += 1) {
    const a = project(c, minR);
    const b = project(c, maxR);
    const el = lines[i];
    el.setAttribute('x1', a.x); el.setAttribute('y1', a.y);
    el.setAttribute('x2', b.x); el.setAttribute('y2', b.y);
  }
  for (let r = Math.floor(minR); r <= Math.ceil(maxR) && i < lines.length; r += 0.5, i += 1) {
    const a = project(minC, r);
    const b = project(maxC, r);
    const el = lines[i];
    el.setAttribute('x1', a.x); el.setAttribute('y1', a.y);
    el.setAttribute('x2', b.x); el.setAttribute('y2', b.y);
  }
}

// ── camera ───────────────────────────────────────────────────────────
function applyCamera() {
  const { zoom, panX, panY } = sim.cam;
  const rect = sim.els.svg.getBoundingClientRect();
  sim.els.viewport.setAttribute('transform',
    `translate(${(rect.width / 2 + panX).toFixed(1)},${(rect.height / 2 + panY).toFixed(1)}) scale(${zoom.toFixed(3)})`);
}

function fitCamera() {
  refreshBasis();
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const entry of sim.geo.values()) {
    const { w, d } = footprintFor(entry.node);
    for (const [c, r] of gridCorners(entry.col, entry.row, w + 0.5, d + 0.5)) {
      for (const z of [0, entry.height + 40]) {
        const p = project(c, r, z);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + 90);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y + 34);
      }
    }
  }
  const rect = sim.els.svg.getBoundingClientRect();
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  sim.cam.zoom = Math.min((rect.width - 60) / bw, (rect.height - 70) / bh, 1.5);
  sim.cam.panX = -((minX + maxX) / 2) * sim.cam.zoom;
  sim.cam.panY = -((minY + maxY) / 2) * sim.cam.zoom;
  applyCamera();
}

// Invert a screen delta onto the ground plane at the current camera.
function groundDelta(dxScreen, dyScreen) {
  const dx = dxScreen / sim.cam.zoom;
  const dy = dyScreen / sim.cam.zoom;
  const a = CS * GRID.col * UNIT;
  const b = -SN * GRID.row * UNIT;
  const c = SN * GRID.col * UNIT * TILT;
  const d = CS * GRID.row * UNIT * TILT;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return { dc: 0, dr: 0 };
  return { dc: (dx * d - b * dy) / det, dr: (a * dy - c * dx) / det };
}

function wireCamera(svg) {
  let drag = null; // { mode, x, y, entry, moved, anchor, anchorScreen }

  // ground point currently under a client position, and its screen position
  const groundAt = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const sx = clientX - rect.left - rect.width / 2 - sim.cam.panX;
    const sy = clientY - rect.top - rect.height / 2 - sim.cam.panY;
    const { dc, dr } = groundDelta(sx, sy);
    return { col: CENTER.col + dc, row: CENTER.row + dr };
  };
  const screenOf = (col, row) => {
    const rect = svg.getBoundingClientRect();
    const p = project(col, row, 0);
    return {
      x: rect.left + rect.width / 2 + sim.cam.panX + p.x * sim.cam.zoom,
      y: rect.top + rect.height / 2 + sim.cam.panY + p.y * sim.cam.zoom,
    };
  };

  svg.addEventListener('contextmenu', (ev) => ev.preventDefault());
  svg.addEventListener('pointerdown', (ev) => {
    if ((ev.button !== 0 && ev.button !== 2) || ev.target.closest('.flow-payload')) return;
    const buildingEl = ev.target.closest('.flow-building');
    const meta = ev.metaKey || ev.ctrlKey;
    let mode = 'rotate';
    let entry = null;
    if (ev.button === 2 || meta) {
      mode = 'pan';
    } else if (buildingEl) {
      mode = 'node';
      entry = sim.geo.get(buildingEl.dataset.id);
    }
    drag = {
      mode,
      x: ev.clientX,
      y: ev.clientY,
      entry,
      moved: false,
      // the scene turns around the spot you grabbed, not a fixed origin
      anchor: mode === 'rotate' ? groundAt(ev.clientX, ev.clientY) : null,
      anchorScreen: { x: ev.clientX, y: ev.clientY },
    };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    sim.suppressClick = true;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    if (drag.mode === 'pan') {
      sim.cam.panX += dx;
      sim.cam.panY += dy;
      applyCamera();
    } else if (drag.mode === 'rotate') {
      // foreground follows the cursor: drag right, the front turns right
      sim.cam.yaw -= dx * 0.008;
      sim.cam.tilt = Math.min(0.92, Math.max(0.3, sim.cam.tilt + dy * 0.004));
      updateGeometry();
      if (drag.anchor) {
        const now = screenOf(drag.anchor.col, drag.anchor.row);
        sim.cam.panX += drag.anchorScreen.x - now.x;
        sim.cam.panY += drag.anchorScreen.y - now.y;
      }
      applyCamera();
    } else if (drag.mode === 'node' && drag.entry) {
      const { dc, dr } = groundDelta(dx, dy);
      drag.entry.col += dc;
      drag.entry.row += dr;
      updateGeometry();
    }
  });
  const finish = async (ev) => {
    const done = drag;
    drag = null;
    if (!done?.moved) return;
    setTimeout(() => { sim.suppressClick = false; }, 0);
    if (done.mode !== 'node' || !done.entry) return;
    const entry = done.entry;
    entry.col = Math.round(entry.col / SNAP) * SNAP;
    entry.row = Math.round(entry.row / SNAP) * SNAP;
    updateGeometry();
    if (state.standalone) {
      bus.emit('toast', 'Standalone export is read-only — the new position is not saved');
      return;
    }
    const ok = await ctrl.commit(() => edit.setNodeFlowPosition(entry.node.id, { col: entry.col, row: entry.row }));
    if (!ok) bus.emit('toast', 'Could not save the position', true);
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', () => { drag = null; });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const next = Math.min(Math.max(sim.cam.zoom * factor, 0.25), 4);
    const applied = next / sim.cam.zoom;
    const mx = ev.clientX - rect.left - rect.width / 2;
    const my = ev.clientY - rect.top - rect.height / 2;
    sim.cam.panX = mx - (mx - sim.cam.panX) * applied;
    sim.cam.panY = my - (my - sim.cam.panY) * applied;
    sim.cam.zoom = next;
    applyCamera();
  }, { passive: false });
}

// ── scene assembly ───────────────────────────────────────────────────
function buildGeometry(scope) {
  const scene = buildFlowScene(scope);
  const maxRuns = maxRunsIn(scope);
  const taken = new Set();
  const geo = new Map();
  for (const { node, col, row } of scene.nodes) {
    geo.set(node.id, {
      node, col, row,
      base: { x: 0, y: 0 },
      depth: 0,
      height: heightFor(node, maxRuns),
      flagged: nodeFlag(node.id),
      code: codeFor(node.label, taken),
      els: null,
    });
  }
  const lanes = scene.edges.map(({ edge, index, back }) => ({
    edge, index, back,
    from: geo.get(edge.from),
    to: geo.get(edge.to),
    p1: { x: 0, y: 0 },
    p2: { x: 0, y: 0 },
    len: 1,
    work: WORK_TYPES.has(geo.get(edge.from).node.type) && WORK_TYPES.has(geo.get(edge.to).node.type),
    flagged: edgeFlag(edge),
  }));
  const outgoing = new Map();
  for (const lane of lanes) {
    if (!outgoing.has(lane.edge.from)) outgoing.set(lane.edge.from, []);
    outgoing.get(lane.edge.from).push(lane);
  }
  return { scene, geo, lanes, outgoing };
}

// ── payload simulation ───────────────────────────────────────────────
function pointOn(lane, t) {
  return {
    x: lane.p1.x + (lane.p2.x - lane.p1.x) * t,
    y: lane.p1.y + (lane.p2.y - lane.p1.y) * t,
  };
}

function spawnPayload(lane, t = 0) {
  if (sim.payloads.length >= MAX_PAYLOADS) return null;
  const el = s('g', { class: 'flow-payload', 'data-payload': String(sim.nextPayloadId) });
  el.append(s('circle', { class: 'flow-payload-halo', r: 9 }));
  el.append(s('circle', { class: 'flow-payload-dot', r: 4 }));
  sim.els.payloadLayer.append(el);
  const payload = { id: sim.nextPayloadId++, lane, t, hops: 0, frozen: false, el };
  sim.payloads.push(payload);
  return payload;
}

function killPayload(payload, pulse = true) {
  payload.el.remove();
  sim.payloads = sim.payloads.filter((p) => p !== payload);
  if (sim.selection?.kind === 'payload' && sim.selection.id === payload.id) {
    sim.selection = null;
    renderPanel();
    paintSelection();
  }
  if (pulse) {
    const at = pointOn(payload.lane, 1);
    sim.pulses.push({ x: at.x, y: at.y, age: 0, el: null });
  }
}

function hopOnward(payload) {
  const targetId = payload.lane.edge.to;
  const target = sim.geo.get(targetId)?.node;
  if (!target || SUPPORT_TYPES.has(target.type)) return killPayload(payload); // delivered
  const options = sim.outgoing.get(targetId) ?? [];
  if (!options.length || payload.hops >= MAX_HOPS) return killPayload(payload);
  // Branch shares are not recorded in the file, so payloads split evenly.
  payload.lane = options[Math.floor(Math.random() * options.length)];
  payload.t = 0;
  payload.hops += 1;
  return null;
}

function advance(dt) {
  for (const spawner of sim.spawners) {
    spawner.next -= dt;
    if (spawner.next <= 0) {
      spawner.next += spawner.interval;
      const options = sim.outgoing.get(spawner.nodeId) ?? [];
      if (options.length) spawnPayload(options[Math.floor(Math.random() * options.length)]);
    }
  }
  for (const payload of [...sim.payloads]) {
    if (payload.frozen) continue;
    payload.t += (dt * PAYLOAD_SPEED) / payload.lane.len;
    if (payload.t >= 1) hopOnward(payload);
  }
  for (const pulse of [...sim.pulses]) {
    pulse.age += dt;
    if (pulse.age > 0.55) {
      pulse.el?.remove();
      sim.pulses = sim.pulses.filter((p) => p !== pulse);
    }
  }
}

function paintPayloads() {
  for (const payload of sim.payloads) {
    const at = pointOn(payload.lane, Math.min(payload.t, 1));
    payload.el.setAttribute('transform', `translate(${at.x.toFixed(1)},${at.y.toFixed(1)})`);
  }
  for (const pulse of sim.pulses) {
    if (!pulse.el) {
      pulse.el = s('circle', { class: 'flow-pulse', cx: pulse.x, cy: pulse.y });
      sim.els.payloadLayer.append(pulse.el);
    }
    pulse.el.setAttribute('r', String(4 + pulse.age * 34));
    pulse.el.setAttribute('opacity', String(Math.max(0, 0.45 * (1 - pulse.age / 0.55))));
  }
  if (sim.tracer?.el) {
    const flow = sim.flows[sim.flowIndex];
    const lane = flow && laneForFlowPosition(flow, sim.tracer.pos);
    if (lane) {
      const at = pointOn(lane, Math.min(sim.tracer.t, 1));
      sim.tracer.el.setAttribute('transform', `translate(${at.x.toFixed(1)},${at.y.toFixed(1)})`);
    }
  }
  const count = String(sim.payloads.length);
  if (sim.els.counter && sim.els.counter.textContent !== count) sim.els.counter.textContent = count;
}

// ── the tracer: walk one named flow a step at a time ─────────────────
function laneForFlowPosition(flow, pos) {
  const index = flow.edgeIndexes[Math.min(pos, flow.edgeIndexes.length - 1)];
  return sim.lanes.find((lane) => lane.index === index) ?? null;
}

function advanceTracer(dt) {
  const flow = sim.flows[sim.flowIndex];
  if (!flow || !sim.tracer?.moving) return;
  const lane = laneForFlowPosition(flow, sim.tracer.pos);
  if (!lane) { sim.tracer.moving = false; return; }
  sim.tracer.t += (dt * PAYLOAD_SPEED * 2.2) / lane.len;
  if (sim.tracer.t >= 1) {
    sim.tracer.t = 0;
    sim.tracer.pos += 1;
    sim.tracer.moving = false;
    paintTracerProgress();
    if (sim.selection == null || sim.selection.kind === 'tracer') {
      sim.selection = { kind: 'tracer' };
      renderPanel();
    }
  }
}

function paintTracerProgress() {
  const flow = sim.flows[sim.flowIndex];
  if (!flow) return;
  const currentId = flow.nodeIds[Math.min(sim.tracer.pos, flow.nodeIds.length - 1)];
  for (const g of sim.els.svg.querySelectorAll('.flow-building.flow-current')) g.classList.remove('flow-current');
  sim.els.svg.querySelector(`.flow-building[data-id="${CSS.escape(currentId)}"]`)?.classList.add('flow-current');
  const done = sim.tracer.pos >= flow.edgeIndexes.length;
  if (sim.els.stepBtn) {
    sim.els.stepBtn.disabled = done;
    sim.els.stepBtn.textContent = done ? 'Flow complete' : 'Trace one step';
  }
}

function selectFlow(index) {
  sim.flowIndex = index;
  sim.tracer?.el?.remove();
  sim.tracer = null;
  const flow = sim.flows[index];
  const onPath = new Set(flow?.edgeIndexes ?? []);
  const onNodes = new Set(flow?.nodeIds ?? []);
  for (const lane of sim.lanes) {
    laneClass(lane, 'flow-dim', !!flow && !onPath.has(lane.index));
    laneClass(lane, 'flow-on-path', !!flow && onPath.has(lane.index));
  }
  for (const g of sim.els.svg.querySelectorAll('.flow-building')) {
    g.classList.toggle('flow-dim', !!flow && !onNodes.has(g.dataset.id));
    g.classList.remove('flow-current');
  }
  if (flow) {
    const el = s('g', { class: 'flow-payload flow-tracer' });
    el.append(s('circle', { class: 'flow-payload-halo', r: 12 }));
    el.append(s('circle', { class: 'flow-payload-dot', r: 5.5 }));
    sim.els.payloadLayer.append(el);
    sim.tracer = { pos: 0, t: 0, moving: false, el };
    const start = sim.geo.get(flow.nodeIds[0]);
    el.setAttribute('transform', `translate(${start.base.x},${start.base.y})`);
    paintTracerProgress();
    sim.selection = { kind: 'tracer' };
  } else {
    if (sim.els.stepBtn) { sim.els.stepBtn.disabled = false; sim.els.stepBtn.textContent = 'Trace one step'; }
    if (sim.selection?.kind === 'tracer') sim.selection = null;
  }
  renderPanel();
  paintSelection();
}

function traceStep() {
  const flow = sim.flows[sim.flowIndex];
  if (!flow) {
    // No flow chosen: nudge the whole simulation forward by roughly one hop.
    advance(0.9);
    paintPayloads();
    return;
  }
  if (sim.tracer && !sim.tracer.moving && sim.tracer.pos < flow.edgeIndexes.length) {
    sim.tracer.moving = true;
  }
}

// ── selection & panel ────────────────────────────────────────────────
function paintSelection() {
  const { svg, legend } = sim.els;
  if (!svg) return;
  for (const g of svg.querySelectorAll('.flow-building.flow-selected')) g.classList.remove('flow-selected');
  for (const lane of sim.lanes) laneClass(lane, 'flow-selected', false);
  for (const el of svg.querySelectorAll('.flow-payload.flow-inspected')) el.classList.remove('flow-inspected');
  for (const rowEl of legend?.querySelectorAll('.flow-legend-row.active') ?? []) rowEl.classList.remove('active');
  const markSelected = (lane) => lane && laneClass(lane, 'flow-selected', true);
  const selected = sim.selection;
  if (!selected) return;
  if (selected.kind === 'node') {
    svg.querySelector(`.flow-building[data-id="${CSS.escape(selected.id)}"]`)?.classList.add('flow-selected');
    legend?.querySelector(`.flow-legend-row[data-id="${CSS.escape(selected.id)}"]`)?.classList.add('active');
  } else if (selected.kind === 'edge') {
    markSelected(sim.lanes.find((lane) => lane.index === selected.index));
  } else if (selected.kind === 'payload') {
    const payload = sim.payloads.find((p) => p.id === selected.id);
    payload?.el.classList.add('flow-inspected');
    markSelected(payload?.lane);
  }
}

function select(selection) {
  const previous = sim.payloads.find((p) => sim.selection?.kind === 'payload' && p.id === sim.selection.id);
  if (previous) previous.frozen = false;
  sim.selection = selection;
  if (selection?.kind === 'payload') {
    const payload = sim.payloads.find((p) => p.id === selection.id);
    if (payload) payload.frozen = true; // hold this one still while inspected
  }
  renderPanel();
  paintSelection();
}

function citation(parts) {
  return h('div', { class: 'flow-cite' },
    h('span', { class: 'flow-cite-eyebrow' }, 'In the file'),
    h('code', {}, `maps/${state.mapId}.yaml`),
    h('code', { class: 'flow-cite-path' }, parts));
}

function panelActions(nodeId) {
  return h('div', { class: 'flow-panel-actions' },
    h('button', {
      class: 'flow-btn',
      onclick: () => {
        bus.emit('workspace-map-request');
        ctrl.gotoNode(nodeId);
      },
    }, 'Open in Map'),
    h('button', {
      class: 'flow-btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(ctrl.nodeUrl(nodeId));
          bus.emit('toast', 'Link copied');
        } catch {
          bus.emit('toast', 'Could not copy the link', true);
        }
      },
    }, 'Copy link'));
}

function metaRow(label, value) {
  if (value == null || value === '') return null;
  return h('div', { class: 'flow-meta-row' }, h('span', {}, label), h('strong', {}, String(value)));
}

function flagSection(note) {
  if (!note) return null;
  return h('div', { class: 'flow-flag-note' }, h('span', {}, '⚑ Inferred'), h('p', {}, note));
}

function issueSection(issue) {
  if (!issue) return null;
  return h('div', { class: 'flow-issue-note' }, h('span', {}, '⚠ Known issue'), h('p', {}, issue));
}

function numberRows(node) {
  const cost = nodeCost(node, state.model.costModel ?? {});
  const currency = state.model.costModel?.currency ?? 'USD';
  if (!cost) {
    return [h('p', { class: 'flow-quiet' },
      'No economics recorded for this step. Unknown is never zero — it stays out of every total.')];
  }
  const money = (value) => (value == null ? '—' : formatMoney(value, currency));
  const rows = [
    metaRow('Volume', cost.runs != null ? `${cost.runs} runs/mo` : '—'),
    metaRow('Human time', cost.minutes != null ? `${cost.minutes} min/run` : '—'),
    metaRow('Human cost', `${money(cost.humanMonthly)}/mo`),
    metaRow('Agent cost', `${money(cost.agentMonthly)}/mo`),
    metaRow('Monthly savings', money(cost.savingsMonthly)),
    metaRow('Setup', cost.setup != null ? money(cost.setup) : '—'),
  ];
  if (!cost.complete) {
    rows.push(h('p', { class: 'flow-quiet' }, `Missing: ${cost.missing.join(', ')} — this step stays out of totals.`));
  }
  return rows;
}

function connectionRows(node) {
  // every lane touching this node, with kind and issue — the integration
  // story of one building at a glance
  const rows = [];
  for (const lane of sim.lanes) {
    if (lane.edge.from !== node.id && lane.edge.to !== node.id) continue;
    const outboundHere = lane.edge.from === node.id;
    const other = outboundHere ? lane.to.node : lane.from.node;
    rows.push(h('button', {
      class: `flow-conn-row${lane.edge.issue ? ' has-issue' : ''}`,
      onclick: () => select({ kind: 'edge', index: lane.index }),
    },
    h('span', { class: 'flow-conn-dir' }, outboundHere ? '→' : '←'),
    h('span', { class: 'flow-conn-label' }, other.label),
    lane.edge.kind ? h('span', { class: `flow-kind-pill k-${lane.edge.kind}` }, KINDS[lane.edge.kind].glyph) : null,
    lane.edge.issue ? h('span', { class: 'flow-conn-issue' }, '⚠') : null));
  }
  if (!rows.length) return [];
  return [h('div', { class: 'flow-conn-list' },
    h('span', { class: 'flow-cite-eyebrow' }, 'Connections'), ...rows)];
}

function nodePanel(node) {
  const flagged = nodeFlag(node.id);
  const tabs = h('div', { class: 'flow-tabs' },
    ...[['does', 'What it does'], ['numbers', 'The numbers']].map(([key, label]) => h('button', {
      class: `flow-tab${sim.tab === key ? ' active' : ''}`,
      onclick: () => { sim.tab = key; renderPanel(); },
    }, label)));
  const body = [];
  if (sim.tab === 'does') {
    if (node.description || node.note) body.push(h('p', { class: 'flow-desc' }, node.description || node.note));
    body.push(
      metaRow('Owner', node.owner),
      metaRow('Trigger', node.trigger),
      metaRow('SLA', node.sla),
      metaRow('Automation', node.automation ? labelize(node.automation) : null),
    );
    if (node.systems?.length) {
      body.push(h('div', { class: 'flow-chip-row' }, node.systems.map((name) => h('span', { class: 'flow-chip' }, name))));
    }
    body.push(...connectionRows(node));
    if (node.children) {
      body.push(h('p', { class: 'flow-quiet' },
        `Contains ${node.stats?.childCount ?? 0} steps — double-click the building to walk inside.`));
    }
    body.push(flagSection(flagged));
  } else {
    body.push(...numberRows(node));
  }
  return [
    h('span', { class: 'flow-eyebrow' }, `Selected ${(TYPE_WORD[node.type] ?? node.type).toLowerCase()}`),
    h('h3', {}, node.label),
    tabs,
    ...body.filter(Boolean),
    citation(`nodes · id: ${node.id}`),
    panelActions(node.id),
  ];
}

function handoffPanel(lane, payload = null) {
  const { edge, from, to } = lane;
  const carries = to.node.type === 'artifact' ? to.node.label
    : from.node.type === 'artifact' ? from.node.label
      : edge.label || 'work item';
  const runs = runsOf(from.node);
  const body = [
    h('span', { class: 'flow-eyebrow' }, payload ? 'Payload in motion' : 'Handoff'),
    h('h3', {}, edge.label || `${from.node.label} → ${to.node.label}`),
    issueSection(edge.issue),
    metaRow('From', `${from.node.label} · ${TYPE_WORD[from.node.type]?.toLowerCase() ?? from.node.type}`),
    metaRow('To', `${to.node.label} · ${TYPE_WORD[to.node.type]?.toLowerCase() ?? to.node.type}`),
    edge.kind ? metaRow('Moves via', KINDS[edge.kind]?.word ?? edge.kind) : null,
    metaRow('Carries', carries),
    metaRow('Pacing', runs != null
      ? `${runs} runs/mo recorded on “${from.node.label}”`
      : 'no volume recorded — neutral pacing'),
    payload ? metaRow('Hops so far', payload.hops) : null,
    lane.back ? h('p', { class: 'flow-quiet' }, 'This handoff loops back to an earlier step.') : null,
    flagSection(lane.flagged),
    payload ? h('p', { class: 'flow-quiet' }, 'This payload is held still while you inspect it. Click anywhere else to release it.') : null,
    citation(`edges · ${edge.from} → ${edge.to}`),
  ];
  return body.filter(Boolean);
}

function tracerPanel() {
  const flow = sim.flows[sim.flowIndex];
  if (!flow || !sim.tracer) return overviewPanel();
  const pos = Math.min(sim.tracer.pos, flow.nodeIds.length - 1);
  const node = sim.geo.get(flow.nodeIds[pos])?.node;
  return [
    h('span', { class: 'flow-eyebrow' }, `Tracing · step ${pos + 1} of ${flow.nodeIds.length}`),
    h('h3', {}, node?.label ?? flow.name),
    node?.description || node?.note ? h('p', { class: 'flow-desc' }, node.description || node.note) : null,
    metaRow('Owner', node?.owner),
    metaRow('Flow', flow.name),
    h('p', { class: 'flow-quiet' }, sim.tracer.pos >= flow.edgeIndexes.length
      ? 'The tracer reached the end of this flow. Choose another flow or reset.'
      : 'Trace one step moves the bright payload one handoff forward.'),
    node ? citation(`nodes · id: ${node.id}`) : null,
    node ? panelActions(node.id) : null,
  ].filter(Boolean);
}

function overviewPanel() {
  const model = state.model;
  const scope = scopeOf(model, state.scopeId);
  const steps = scope.nodes.filter((n) => n.type === 'process' || n.type === 'decision').length;
  const stats = integrationStats(scope);
  const body = [
    h('span', { class: 'flow-eyebrow' }, 'Runtime overview'),
    h('h3', {}, model.name || state.mapId),
    model.description ? h('p', { class: 'flow-desc' }, model.description) : null,
    h('div', { class: 'flow-stat-grid' },
      h('div', {}, h('strong', {}, String(steps)), h('span', {}, 'steps')),
      h('div', {}, h('strong', {}, String(scope.edges.length)), h('span', {}, 'handoffs')),
      h('div', {}, h('strong', {}, String(sim.scene.entries.length)), h('span', {}, 'entrances')),
      h('div', {}, h('strong', {}, String(sim.flows.length)), h('span', {}, 'flows'))),
  ];

  // how the data moves — front and center when the file records it
  if (stats.kinds > 0 || stats.issues.length) {
    body.push(h('div', { class: 'flow-integration' },
      h('span', { class: 'flow-cite-eyebrow' }, 'How the data moves'),
      h('div', { class: 'flow-kind-grid' },
        ...Object.entries(KINDS).map(([key, meta]) => (stats.byKind[key]
          ? h('div', { class: `flow-kind-stat k-${key}` },
            h('strong', {}, String(stats.byKind[key])), h('span', {}, meta.word))
          : null)))));
    if (stats.issues.length) {
      body.push(h('div', { class: 'flow-issues' },
        h('span', { class: 'flow-cite-eyebrow danger' }, `${stats.issues.length} known issue${stats.issues.length > 1 ? 's' : ''}`),
        ...stats.issues.map((item) => h('button', {
          class: 'flow-issue-item',
          onclick: () => select({ kind: 'edge', index: item.index }),
        },
        h('span', {}, '⚠'),
        h('div', {},
          h('strong', {}, item.label || `${item.from} → ${item.to}`),
          h('small', {}, item.issue))))));
    }
  }

  body.push(h('div', { class: 'flow-key' },
    ...(stats.kinds > 0
      ? Object.entries(KINDS).filter(([key]) => stats.byKind[key]).map(([key, meta]) => keyRow(`flow-key-kind k-${key}`, meta.word))
      : [keyRow('flow-key-work', 'Work handoff'), keyRow('flow-key-support', 'People & systems')]),
    keyRow('flow-key-back', 'Loops back'),
    ...(stats.issues.length ? [keyRow('flow-key-issue', 'Known issue')] : []),
    keyRow('flow-key-payload', 'Payload — click one to inspect it'),
    keyRow('flow-key-flag', '⚑ Inferred, awaiting confirmation')));
  body.push(h('p', { class: 'flow-quiet' },
    'Payload pacing follows the monthly volume recorded in the file. Steps without a volume tick at a neutral rate, and branches split evenly — neither is data.'));

  // economics stay available, but they are not the story here
  const rollup = rollupCost(model);
  if (rollup.costedCount > 0) {
    const currency = rollup.currency ?? 'USD';
    body.push(h('details', { class: 'flow-econ' },
      h('summary', {}, 'Economics'),
      metaRow('Human', `${formatMoney(rollup.humanMonthly, currency)}/mo`),
      metaRow('Agent', `${formatMoney(rollup.agentMonthly, currency)}/mo`),
      metaRow('Savings', `${formatMoney(rollup.savingsMonthly, currency)}/mo`),
      h('p', { class: 'flow-quiet' }, `${rollup.costedCount} of ${rollup.processCount} steps costed — unknowns stay out.`)));
  }
  return body.filter(Boolean);
}

function keyRow(cls, label) {
  const svg = s('svg', { viewBox: '0 0 34 12', class: `flow-key-swatch ${cls}` });
  if (cls === 'flow-key-payload') {
    svg.append(s('circle', { cx: 17, cy: 6, r: 4 }));
  } else if (cls !== 'flow-key-flag') {
    svg.append(s('line', { x1: 2, y1: 6, x2: 32, y2: 6 }));
  }
  return h('div', { class: 'flow-key-row' }, svg, h('span', {}, label));
}

function renderPanel() {
  const panel = sim.els.panel;
  if (!panel) return;
  let content;
  const selected = sim.selection;
  if (selected?.kind === 'node') {
    const node = sim.geo.get(selected.id)?.node;
    content = node ? nodePanel(node) : overviewPanel();
  } else if (selected?.kind === 'edge') {
    const lane = sim.lanes.find((l) => l.index === selected.index);
    content = lane ? handoffPanel(lane) : overviewPanel();
  } else if (selected?.kind === 'payload') {
    const payload = sim.payloads.find((p) => p.id === selected.id);
    content = payload ? handoffPanel(payload.lane, payload) : overviewPanel();
  } else if (selected?.kind === 'tracer') {
    content = tracerPanel();
  } else {
    content = overviewPanel();
  }
  panel.replaceChildren(...content);
}

// ── legend ───────────────────────────────────────────────────────────
function legendRow(entry) {
  const { node, code, flagged } = entry;
  const runs = runsOf(node);
  return h('button', {
    class: 'flow-legend-row',
    'data-id': node.id,
    onclick: () => select({ kind: 'node', id: node.id }),
    ondblclick: () => { if (node.children) ctrl.diveInto(node.id); },
  },
  h('span', { class: `flow-code-chip t-${node.type}` }, code),
  h('span', { class: 'flow-legend-label' }, node.label),
  runs != null ? h('span', { class: 'flow-legend-runs' }, `×${runs}`) : null,
  flagged ? h('span', { class: 'flow-legend-flag', title: flagged }, '⚑') : null);
}

function buildLegend() {
  const entries = [...sim.geo.values()].sort((a, b) => a.col - b.col || a.row - b.row);
  const groups = [
    ['Where work enters', entries.filter((e) => sim.scene.entries.includes(e.node.id))],
    ['The work path', entries.filter((e) => WORK_TYPES.has(e.node.type) && !sim.scene.entries.includes(e.node.id))],
    ['People & systems', entries.filter((e) => SUPPORT_TYPES.has(e.node.type))],
  ];
  const legend = h('aside', { class: 'flow-legend' });
  for (const [title, list] of groups) {
    if (!list.length) continue;
    legend.append(h('section', { class: 'flow-legend-group' },
      h('h4', {}, title),
      ...list.map(legendRow)));
  }
  return legend;
}

// ── animation loop ───────────────────────────────────────────────────
function alive() {
  return state.workspaceView === 'flow' && sim.els.svg?.isConnected;
}

function stopLoop() {
  if (sim.raf) cancelAnimationFrame(sim.raf);
  sim.raf = 0;
}

export function stopFlow() {
  stopLoop();
}

function tick(now) {
  if (!alive()) return stopLoop();
  const dt = Math.min(0.05, sim.lastTime ? (now - sim.lastTime) / 1000 : 0.016);
  sim.lastTime = now;
  if (!sim.paused) advance(dt);
  if (sim.tracer?.moving) advanceTracer(dt);
  paintPayloads();
  sim.raf = requestAnimationFrame(tick);
}

// ── keyboard (wired from main.js while the Flow view is active) ──────
export function flowShortcut(ev) {
  if (ev.key === ' ') {
    setPaused(!sim.paused);
    return true;
  }
  if (ev.key === 'Escape') {
    if (sim.selection) { select(null); return true; }
    if (state.scopeId != null) { ctrl.riseUp(); return true; }
    return false;
  }
  if (ev.key === 'Enter' && sim.selection?.kind === 'node') {
    const node = sim.geo.get(sim.selection.id)?.node;
    if (node?.children) { ctrl.diveInto(node.id); return true; }
  }
  if (ev.key === '0') {
    sim.cam = defaultCam();
    updateGeometry();
    fitCamera();
    return true;
  }
  return false;
}

function setPaused(paused) {
  sim.paused = paused;
  const btn = sim.els.pauseBtn;
  if (btn) {
    btn.textContent = paused ? 'Resume' : 'Pause';
    btn.classList.toggle('active', paused);
  }
}

// ── top bar ──────────────────────────────────────────────────────────
function buildTopbar(scope) {
  const steps = scope.nodes.filter((n) => n.type === 'process' || n.type === 'decision').length;
  const stats = integrationStats(scope);
  const counter = h('strong', { class: 'flow-live' }, '0');
  sim.els.counter = counter;

  const flowSelect = h('select', {
    class: 'flow-select',
    'aria-label': 'Choose a flow to trace',
    onchange: (ev) => selectFlow(Number(ev.target.value)),
  },
  h('option', { value: '-1' }, 'All flows'),
  ...sim.flows.map((flow, i) => h('option', { value: String(i) }, truncate(flow.name, 44))));
  flowSelect.value = String(sim.flowIndex);

  const pauseBtn = h('button', { class: 'flow-btn', onclick: () => setPaused(!sim.paused) }, sim.paused ? 'Resume' : 'Pause');
  pauseBtn.classList.toggle('active', sim.paused);
  const stepBtn = h('button', { class: 'flow-btn', onclick: traceStep }, 'Trace one step');
  const resetBtn = h('button', {
    class: 'flow-btn',
    title: 'Reset the camera and the payloads',
    onclick: () => {
      for (const payload of [...sim.payloads]) killPayload(payload, false);
      sim.cam = defaultCam();
      updateGeometry();
      fitCamera();
      if (sim.flowIndex !== -1) { sim.flowIndex = -1; flowSelect.value = '-1'; selectFlow(-1); }
      select(null);
      seedPayloads();
    },
  }, 'Reset');
  const themeBtn = h('button', {
    class: 'flow-btn',
    title: 'Toggle light / dark appearance',
    onclick: () => document.getElementById('btn-theme')?.click(),
  }, '◐ Theme');
  sim.els.pauseBtn = pauseBtn;
  sim.els.stepBtn = stepBtn;

  const statEls = [
    stat(String(steps), 'steps'),
    stat(String(scope.edges.length), 'handoffs'),
  ];
  if (stats.kinds > 0) {
    if (stats.byKind.api) statEls.push(stat(String(stats.byKind.api), 'APIs'));
    if (stats.byKind.file) statEls.push(stat(String(stats.byKind.file), 'files'));
    if (stats.byKind.manual) statEls.push(stat(String(stats.byKind.manual), 'manual'));
    if (stats.byKind.event) statEls.push(stat(String(stats.byKind.event), 'events'));
  } else {
    statEls.push(stat(String(sim.flows.length), 'flows'));
  }
  if (stats.issues.length) {
    const issueStat = stat(String(stats.issues.length), stats.issues.length > 1 ? 'issues' : 'issue');
    issueStat.classList.add('danger');
    statEls.push(issueStat);
  }
  statEls.push(h('div', { class: 'flow-stat' }, counter, h('span', {}, 'in motion')));

  const scopeNode = state.scopeId ? state.model.byId.get(state.scopeId) : null;
  return h('div', { class: 'flow-topbar' },
    h('div', { class: 'flow-title' },
      h('span', { class: 'flow-eyebrow' }, 'Runtime topology'),
      h('h2', {}, scopeNode ? scopeNode.label : (state.model.name || state.mapId)),
      scopeNode ? h('button', { class: 'flow-btn flow-up', onclick: () => ctrl.riseUp(), title: 'Back out one level' }, '⬑ Up') : null),
    h('div', { class: 'flow-stats' }, ...statEls),
    h('div', { class: 'flow-controls' }, flowSelect, pauseBtn, stepBtn, resetBtn, themeBtn));
}

function stat(value, label) {
  return h('div', { class: 'flow-stat' }, h('strong', {}, value), h('span', {}, label));
}

// ── payload seeding & spawners ───────────────────────────────────────
function seedPayloads() {
  const workLanes = sim.lanes.filter((lane) => lane.work || lane.edge.kind);
  workLanes.forEach((lane, i) => {
    spawnPayload(lane, 0.2 + ((i * 0.37) % 0.6));
  });
}

function buildSpawners(scope) {
  const maxRuns = maxRunsIn(scope);
  sim.spawners = sim.scene.entries.map((id) => {
    const cadence = payloadCadence(runsOf(state.model.byId.get(id)), maxRuns);
    if (cadence <= 0) return null;
    const interval = 1 / cadence;
    return { nodeId: id, interval, next: Math.random() * interval * 0.5 };
  }).filter(Boolean);
}

// ── empty states ─────────────────────────────────────────────────────
function emptyState(title, message) {
  return h('div', { class: 'flow-empty' },
    h('h2', {}, title),
    h('p', {}, message),
    h('button', { class: 'flow-btn', onclick: () => bus.emit('workspace-map-request') }, 'Back to Map'));
}

// ── entry point ──────────────────────────────────────────────────────
export function renderFlow(panel) {
  stopLoop();
  const model = state.model;
  if (!model) return;
  if (model.mode === 'freeform') {
    panel.replaceChildren(h('div', { class: 'flow-root' },
      emptyState('Flow animates Process maps', 'Freeform maps describe shared elements and groups, not a step-by-step flow. Open a Process map to watch its work move.')));
    return;
  }
  const scope = scopeOf(model, state.scopeId);
  if (!scope?.nodes?.length) {
    panel.replaceChildren(h('div', { class: 'flow-root' },
      emptyState('Nothing to animate yet', 'This scope has no steps. Add steps in the Map view and they will appear here as buildings on the grid.')));
    return;
  }

  const key = `${state.mapId}::${state.scopeId ?? ''}`;
  const sameKey = key === sim.key;
  if (!sameKey) {
    sim.key = key;
    sim.flowIndex = -1;
    sim.selection = null;
    sim.tab = 'does';
    sim.paused = false;
    sim.cam = defaultCam();
  }
  if (!sim.cam) sim.cam = defaultCam();
  sim.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (sim.reduced) sim.paused = true;

  const { scene, geo, lanes, outgoing } = buildGeometry(scope);
  sim.scene = scene;
  CENTER = scene.nodes.length
    ? {
      col: scene.nodes.reduce((sum, n) => sum + n.col, 0) / scene.nodes.length,
      row: scene.nodes.reduce((sum, n) => sum + n.row, 0) / scene.nodes.length,
    }
    : { col: 0, row: 0 };
  sim.geo = geo;
  sim.lanes = lanes;
  sim.outgoing = outgoing;
  sim.flows = enumerateFlows(scope);
  if (sim.flowIndex >= sim.flows.length) sim.flowIndex = -1;
  sim.payloads = [];
  sim.pulses = [];
  sim.tracer = null;
  sim.nextPayloadId = 1;
  buildSpawners(scope);

  // ── svg scene ──
  const svg = s('svg', { class: 'flow-canvas', role: 'img', 'aria-label': 'Rotatable 3D view of this map' });
  const viewport = s('g', { class: 'flow-viewport' });
  svg.append(viewport);

  const cols = scene.nodes.map((n) => n.col);
  const rows = scene.nodes.map((n) => n.row);
  const gridBounds = {
    minC: Math.min(...cols) - 1.2,
    maxC: Math.max(...cols) + 1.2,
    minR: Math.min(...rows) - 1.2,
    maxR: Math.max(...rows) + 1.2,
  };
  const gridLayer = s('g', { class: 'flow-grid' });
  const gridCount = (Math.ceil(gridBounds.maxC) - Math.floor(gridBounds.minC)) * 2
    + (Math.ceil(gridBounds.maxR) - Math.floor(gridBounds.minR)) * 2 + 4;
  for (let i = 0; i < gridCount; i += 1) gridLayer.append(s('line', {}));
  viewport.append(gridLayer);

  const laneLayer = s('g', { class: 'flow-lanes' });
  for (const lane of lanes) laneLayer.append(makeLane(lane));
  viewport.append(laneLayer);

  const buildingLayer = s('g', { class: 'flow-buildings' });
  for (const entry of geo.values()) {
    const group = makeBuilding(entry);
    group.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (sim.suppressClick) return;
      select({ kind: 'node', id: entry.node.id });
    });
    group.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      if (entry.node.children) ctrl.diveInto(entry.node.id);
    });
    buildingLayer.append(group);
  }
  viewport.append(buildingLayer);

  // labels, chips, and issue marks float above the buildings
  const laneDecorLayer = s('g', { class: 'flow-lane-decor-layer' });
  for (const lane of lanes) laneDecorLayer.append(lane.decorEl);
  viewport.append(laneDecorLayer);

  const payloadLayer = s('g', { class: 'flow-payload-layer' });
  viewport.append(payloadLayer);

  svg.addEventListener('click', () => {
    if (sim.suppressClick) { sim.suppressClick = false; return; }
    select(null);
  });

  sim.els = {
    svg, viewport, payloadLayer, buildingLayer, gridLayer, gridBounds,
    panel: null, legend: null, counter: null, pauseBtn: null, stepBtn: null,
  };

  wireCamera(svg);

  payloadLayer.addEventListener('click', (ev) => {
    const el = ev.target.closest('.flow-payload[data-payload]');
    if (!el) return;
    ev.stopPropagation();
    select({ kind: 'payload', id: Number(el.dataset.payload) });
  });

  // ── page assembly ──
  const legend = buildLegend();
  const explainer = h('aside', { class: 'flow-explainer' });
  sim.els.legend = legend;
  sim.els.panel = explainer;

  const hint = h('div', { class: 'flow-hint' },
    sim.reduced
      ? 'Animation is paused because your system prefers reduced motion — Resume or Trace one step to move work forward.'
      : 'drag to rotate · right-drag or ⌘-drag to pan · scroll to zoom · drag a building to move it · double-click a container to walk inside');

  const root = h('div', { class: 'flow-root' },
    buildTopbar(scope),
    h('div', { class: 'flow-body' },
      legend,
      h('div', { class: 'flow-stage' }, svg, hint),
      explainer));
  panel.replaceChildren(root);

  updateGeometry();
  if (sameKey) applyCamera();
  else fitCamera();

  if (sim.flowIndex >= 0) selectFlow(sim.flowIndex);
  setPaused(sim.paused);
  renderPanel();
  paintSelection();
  seedPayloads();
  paintPayloads();

  sim.lastTime = 0;
  sim.raf = requestAnimationFrame(tick);
}
