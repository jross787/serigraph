// Per-scope auto-layout: dagre for each connected component, shelf-packed.
// Container nodes embed a miniature of their child scope using the child's
// REAL layout geometry, so zooming in morphs the miniature into the sub-map.
/* global dagre */

const FONT = '13px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
let mctx = null;
function measure(text, font = `600 ${FONT}`) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = font;
  return mctx.measureText(text).width;
}

export function wrapText(text, maxWidth, font = `600 ${FONT}`, maxLines = 3) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (measure(trial, font) <= maxWidth || !line) {
      line = trial;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const used = lines.join(' ');
  if (used.length < words.join(' ').length) {
    let last = lines[lines.length - 1] ?? '';
    while (last && measure(last + '…', font) > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = (last || '') + '…';
  }
  return lines;
}

// ── node sizing ──────────────────────────────────────────────────────
const HEADER_FONT = '650 14px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';

function sizeNode(node, model) {
  const isContainer = !!node.children;
  if (isContainer) {
    const lines = wrapText(node.label, 168, HEADER_FONT, 2);
    const lw = Math.max(...lines.map((l) => measure(l, HEADER_FONT)), 60);
    const w = Math.min(288, Math.max(196, lw + 96));
    // height finished in layoutScope once the child layout (aspect) is known
    return { w, h: 0, lines };
  }
  if (node.type === 'decision') {
    const lines = wrapText(node.label, 116, `600 ${FONT}`, 3);
    const lw = Math.max(...lines.map((l) => measure(l)), 40);
    return { w: Math.max(128, lw + 72), h: Math.max(76, lines.length * 17 + 48), lines };
  }
  const lines = wrapText(node.label, 148, `600 ${FONT}`, 3);
  const lw = Math.max(...lines.map((l) => measure(l)), 30);
  const w = Math.max(120, Math.min(220, lw + 64));
  const h = Math.max(48, lines.length * 17 + 30);
  return { w, h, lines };
}

// ── connected components + dagre + shelf packing ────────────────────
function components(nodes, edges) {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const e of edges) {
    const a = find(e.from), b = find(e.to);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map();
  for (const n of nodes) {
    const root = find(n.id);
    if (!groups.has(root)) groups.set(root, { nodes: [], edges: [] });
    groups.get(root).nodes.push(n);
  }
  for (const e of edges) groups.get(find(e.from)).edges.push(e);
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return [...groups.values()].sort((g1, g2) => order.get(g1.nodes[0].id) - order.get(g2.nodes[0].id));
}

function layoutComponent(comp, sized) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 70, edgesep: 18, marginx: 4, marginy: 4 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of comp.nodes) {
    const s = sized.get(n.id);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  comp.edges.forEach((e, i) => {
    const labelW = e.label ? measure(e.label, '600 10.5px ui-sans-serif, sans-serif') + 20 : 0;
    g.setEdge(e.from, e.to, { width: labelW, height: e.label ? 22 : 0, labelpos: 'c' }, 'e' + i);
  });
  dagre.layout(g);

  let maxX = 0, maxY = 0;
  const nodes = comp.nodes.map((n) => {
    const p = g.node(n.id);
    const s = sized.get(n.id);
    const x = p.x - s.w / 2, y = p.y - s.h / 2;
    maxX = Math.max(maxX, x + s.w); maxY = Math.max(maxY, y + s.h);
    return { id: n.id, node: n, x, y, w: s.w, h: s.h, lines: s.lines, mini: s.mini };
  });
  const edges = comp.edges.map((e, i) => {
    const ge = g.edge(e.from, e.to, 'e' + i);
    const points = ge.points ?? [];
    for (const p of points) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const mid = points[Math.floor(points.length / 2)] ?? points[0] ?? { x: 0, y: 0 };
    const labelPos = ge.x != null ? { x: ge.x, y: ge.y } : mid;
    return { edge: e, index: i, points, labelPos };
  });
  return { nodes, edges, w: maxX, h: maxY };
}

function shelfPack(blocks, gap = 72) {
  const totalArea = blocks.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const targetW = Math.max(820, Math.sqrt(totalArea) * 1.75);
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > targetW) { x = 0; y += rowH + gap; rowH = 0; }
    b.ox = x; b.oy = y;
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
    w = Math.max(w, b.ox + b.w);
  }
  const rows = new Map();
  for (const b of blocks) {
    if (!rows.has(b.oy)) rows.set(b.oy, []);
    rows.get(b.oy).push(b);
  }
  for (const [, row] of rows) {
    const h = Math.max(...row.map((b) => b.h));
    for (const b of row) b.oy += (h - b.h) / 2;
  }
  return { w, h: y + rowH };
}

// ── public API ───────────────────────────────────────────────────────
const cache = new Map();

export function invalidateLayouts() {
  cache.clear();
}

// Layout of the scope owned by ownerId (null = root).
// Every edge index in the result refers to the scope's edges array order —
// we re-derive it so edits can address edges by index.
export function layoutScope(model, ownerId) {
  const key = ownerId ?? '__root__';
  if (cache.has(key)) return cache.get(key);

  const scope = ownerId == null ? model.root : model.byId.get(ownerId)?.children;
  if (!scope || !scope.nodes.length) {
    const empty = { nodes: [], edges: [], w: 0, h: 0 };
    cache.set(key, empty);
    return empty;
  }

  const edgeIndex = new Map(scope.edges.map((e, i) => [e, i]));
  const sized = new Map();
  for (const n of scope.nodes) {
    const s = sizeNode(n, model);
    if (n.children) {
      const child = layoutScope(model, n.id); // recursive; cached
      const frameW = s.w - 26;
      const aspect = child.w > 0 ? child.h / child.w : 0.55;
      const frameH = Math.max(56, Math.min(118, frameW * aspect));
      const headerH = 12 + (s.lines?.length ?? 1) * 19 + 8;
      s.h = headerH + frameH + 16;
      const scale = child.w > 0
        ? Math.min(frameW / child.w, frameH / child.h, 0.24)
        : 0.1;
      s.mini = {
        child, frameW, frameH, headerH, scale,
        // offsets that center the child layout inside the frame (node-local coords)
        dx: 13 + (frameW - child.w * (child.w ? Math.min(frameW / child.w, frameH / child.h, 0.24) : 0.1)) / 2,
        dy: headerH + (frameH - child.h * (child.h ? Math.min(frameW / child.w, frameH / child.h, 0.24) : 0.1)) / 2,
      };
    }
    sized.set(n.id, s);
  }

  const comps = components(scope.nodes, scope.edges);
  const blocks = comps.map((c) => layoutComponent(c, sized));
  const packed = shelfPack(blocks);

  const nodes = [], edges = [];
  for (const b of blocks) {
    for (const n of b.nodes) {
      n.x += b.ox; n.y += b.oy;
      nodes.push(n);
    }
    for (const e of b.edges) {
      e.points = e.points.map((p) => ({ x: p.x + b.ox, y: p.y + b.oy }));
      e.labelPos = { x: e.labelPos.x + b.ox, y: e.labelPos.y + b.oy };
      e.index = edgeIndex.get(e.edge);
      edges.push(e);
    }
  }

  const result = { ownerId, nodes, edges, w: packed.w, h: packed.h };
  cache.set(key, result);
  return result;
}

// The transform that maps a container's child-layout coordinates into the
// container node's parent-scope (world) coordinates — the miniature placement.
export function miniTransform(layoutNode) {
  const m = layoutNode.mini;
  return {
    k: m.scale,
    x: layoutNode.x + m.dx,
    y: layoutNode.y + m.dy,
  };
}

// Smooth path through dagre points: straight lines with rounded corners.
export function edgePath(points, radius = 10) {
  if (points.length < 2) return '';
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 1) { d += ` L${p1.x},${p1.y}`; continue; }
    const a = { x: p1.x - ((p1.x - p0.x) / d1) * r, y: p1.y - ((p1.y - p0.y) / d1) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / d2) * r, y: p1.y + ((p2.y - p1.y) / d2) * r };
    d += ` L${a.x},${a.y} Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}
