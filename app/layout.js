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

function ellipsize(text, maxWidth, font) {
  while (text && measure(text + '…', font) > maxWidth) text = text.slice(0, -1).trimEnd();
  return text + '…';
}

// Reserve the existing maximum footprint so shorter bubbles don't rearrange
// the map or its routes. Rendering shrinks within this envelope.
export const EDGE_LABEL_SIZE = { w: 192, h: 28 };
const EDGE_LABEL_FONT = '600 11px ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
export function edgeLabelText(text) {
  const width = EDGE_LABEL_SIZE.w - 24;
  return fitText(text, width, EDGE_LABEL_FONT);
}

export function edgeLabelBubble(text) {
  const fitted = edgeLabelText(text);
  return {
    text: fitted,
    w: Math.min(EDGE_LABEL_SIZE.w, Math.max(EDGE_LABEL_SIZE.h, Math.ceil(measure(fitted, EDGE_LABEL_FONT)) + 24)),
    h: EDGE_LABEL_SIZE.h,
  };
}

export function fitText(text, maxWidth, font = CARD_FONT) {
  return measure(text, font) <= maxWidth ? text : ellipsize(text, maxWidth, font);
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
    lines[lines.length - 1] = ellipsize(lines[lines.length - 1] ?? '', maxWidth, font);
  }
  return lines;
}

// ── node sizing ──────────────────────────────────────────────────────
const HEADER_FONT = '650 14px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
// Match the full-size .node .label typography; overview labels are smaller.
export const CARD_FONT = '650 14.25px ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif';

function sizeNode(node, model) {
  const isContainer = !!node.children;
  if (isContainer) {
    const lines = wrapText(node.label, 168, HEADER_FONT, 2);
    const lw = Math.max(...lines.map((l) => measure(l, HEADER_FONT)), 60);
    const w = Math.min(236, Math.max(184, lw + 82));
    // height finished in layoutScope once the child layout (aspect) is known
    return { w, h: 0, lines };
  }
  if (node.type === 'decision') {
    const lines = wrapText(node.label, 108, `600 ${FONT}`, 3);
    const lw = Math.max(...lines.map((l) => measure(l)), 40);
    return { w: Math.max(120, Math.min(148, lw + 40)), h: Math.max(88, lines.length * 17 + 44), lines };
  }
  // Peer cards share a footprint; reserve room for the icon and corner badges.
  const labelWidth = 132;
  // Also cap unbroken names that exceed wrapText's word-based limit.
  const lines = wrapText(node.label, labelWidth, CARD_FONT, 2)
    .map((line) => fitText(line, labelWidth));
  return { w: 200, h: 64, lines };
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
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 48, edgesep: 16, marginx: 4, marginy: 4 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of comp.nodes) {
    const s = sized.get(n.id);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  comp.edges.forEach((e, i) => {
    g.setEdge(e.from, e.to, {
      width: e.label ? EDGE_LABEL_SIZE.w : 0,
      height: e.label ? EDGE_LABEL_SIZE.h : 0,
      labelpos: 'c',
    }, 'e' + i);
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

// Compact rows reuse Dagre's graph ordering, then wrap each component into
// alternating rows. This is presentation geometry only: scope membership,
// edge direction, card dimensions and authored pins/routes remain unchanged.
function compactComponent(block) {
  const ordered = [...block.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length / 2)));
  const width = Math.max(...ordered.map(n => n.w));
  const height = Math.max(...ordered.map(n => n.h));
  const gapX = block.edges.some(e => e.edge.label) ? EDGE_LABEL_SIZE.w + 48 : 72;
  const cells = new Map(ordered.map((n, i) => {
    const row = Math.floor(i / columns), offset = i % columns;
    return [n.id, { row, col: row % 2 ? columns - 1 - offset : offset }];
  }));
  // Reserve a separate gutter track for every non-adjacent connection at
  // both ends. Branches, return paths and loops stay outside the card rows.
  const tracks = new Map();
  const nextTrack = row => {
    const track = tracks.get(row) ?? 0;
    tracks.set(row, track + 1);
    return track;
  };
  const routes = new Map();
  for (const e of block.edges) {
    const a = cells.get(e.edge.from), b = cells.get(e.edge.to);
    const adjacent = a.row === b.row && Math.abs(a.col - b.col) === 1
      || a.col === b.col && Math.abs(a.row - b.row) === 1;
    if (!adjacent) routes.set(e, { start: nextTrack(a.row), end: a.row === b.row ? null : nextTrack(b.row) });
  }
  const rowTops = [];
  let y = 0;
  for (let row = 0; row < Math.ceil(ordered.length / columns); row++) {
    y += 56 + (tracks.get(row) ?? 0) * 36;
    rowTops.push(y);
    y += height;
  }
  for (const n of ordered) {
    const cell = cells.get(n.id);
    n.x = cell.col * (width + gapX) + (width - n.w) / 2;
    n.y = rowTops[cell.row] + (height - n.h) / 2;
  }
  const byId = new Map(ordered.map(n => [n.id, n]));
  const right = columns * width + (columns - 1) * gapX;
  let rail = 0;
  for (const e of block.edges) {
    const a = byId.get(e.edge.from), b = byId.get(e.edge.to);
    const route = routes.get(e);
    if (!route) {
      Object.assign(e, routeDirect(a, b));
      continue;
    }
    const ac = centerOf(a), bc = centerOf(b);
    const ay = rowTops[cells.get(a.id).row] - 28 - route.start * 36;
    const by = route.end == null ? ay : rowTops[cells.get(b.id).row] - 28 - route.end * 36;
    const points = [{ x: ac.x, y: a.y }, { x: ac.x, y: ay }];
    if (a === b || cells.get(a.id).row !== cells.get(b.id).row) {
      // Cross-row returns use an outside rail, clear of every card. A loop
      // returns through the side of its own card so its arrow stays visible.
      const rx = a === b ? a.x + a.w + 24
        : (ac.x + bc.x < right) ? -36 - rail * 20 : right + 36 + rail * 20;
      if (a !== b) rail++;
      points.push({ x: rx, y: ay }, { x: rx, y: a === b ? ac.y : by });
      if (a === b) points.push({ x: a.x + a.w, y: ac.y });
      else points.push({ x: bc.x, y: by }, { x: bc.x, y: b.y });
    } else points.push({ x: bc.x, y: ay }, { x: bc.x, y: b.y });
    Object.assign(e, { points, labelPos: { x: ac.x, y: ay } });
  }
  // Include the outside tracks when packing disconnected components.
  let x0 = 0, y0 = 0, x1 = right, y1 = y;
  for (const e of block.edges) {
    for (const p of e.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  for (const n of block.nodes) { n.x -= x0; n.y -= y0; }
  for (const e of block.edges) {
    e.points = e.points.map(p => ({ x: p.x - x0, y: p.y - y0 }));
    e.labelPos = { x: e.labelPos.x - x0, y: e.labelPos.y - y0 };
  }
  return { ...block, w: x1 - x0, h: y1 - y0 };
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

// ── pinned positions ─────────────────────────────────────────────────
// A node with a `position` in the file is "pinned": it renders with its
// center at exactly those scope coordinates. Everything else keeps the
// dagre layout (computed over the FULL graph, pinned nodes included, so
// pinning one node never reshuffles its siblings), then gets pushed out
// from under pinned nodes. Automatic routes are then rebuilt in clear
// horizontal corridors without changing any node positions.

const centerOf = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

// point where the segment from n's center toward `toward` crosses n's
// outline (diamond for decisions, bounding rect for everything else)
function boundaryPoint(n, toward, side) {
  const c = centerOf(n);
  if (side === 'top') return { x: c.x, y: n.y };
  if (side === 'right') return { x: n.x + n.w, y: c.y };
  if (side === 'bottom') return { x: c.x, y: n.y + n.h };
  if (side === 'left') return { x: n.x, y: c.y };
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  let s;
  if (n.node?.type === 'decision' && !n.node.children) {
    const t = Math.abs(dx) / (n.w / 2) + Math.abs(dy) / (n.h / 2);
    s = Math.min(t ? 1 / t : 1, 1);
  } else {
    const sx = dx ? (n.w / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (n.h / 2) / Math.abs(dy) : Infinity;
    s = Math.min(sx, sy, 1);
  }
  return { x: c.x + dx * s, y: c.y + dy * s };
}

// Direct edge route between two layout nodes: boundary to boundary.
// Exported so the canvas can re-route live while a node is being dragged.
export function routeDirect(a, b, edge = {}) {
  const p1 = boundaryPoint(a, centerOf(b), edge.fromSide);
  const p2 = boundaryPoint(b, centerOf(a), edge.toSide);
  return { points: [p1, p2], labelPos: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
}

// Give a clear left/right corridor a shared label column and separate,
// ordered arrival ports. Keep dagre/custom routes for tight or obstructed
// corridors, fan-out, self-loops and same-pair bundles; this is not a general router.
export function routeAutomaticEdges(nodes, edges) {
  const routed = new Set();
  // Reconsider previous automatic geometry when any node moves into its
  // corridor. The fallback stays layout-only; it never changes map data.
  for (const e of edges) {
    if (e.autoFallback && !e.edge.via && !e.edge.route && !e.edge.fromSide && !e.edge.toSide) {
      Object.assign(e, e.autoFallback);
      delete e.autoFallback;
      routed.add(e);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pairCounts = new Map();
  const outgoingCounts = new Map();
  const pairKey = (e) => [e.edge.from, e.edge.to].sort().join('\u0000');
  for (const e of edges) {
    pairCounts.set(pairKey(e), (pairCounts.get(pairKey(e)) ?? 0) + 1);
    outgoingCounts.set(e.edge.from, (outgoingCounts.get(e.edge.from) ?? 0) + 1);
  }
  const groups = new Map();
  for (const e of edges) {
    if (e.edge.via || e.edge.route || e.edge.fromSide || e.edge.toSide || e.edge.from === e.edge.to
      || pairCounts.get(pairKey(e)) > 1 || outgoingCounts.get(e.edge.from) > 1) continue;
    const a = byId.get(e.edge.from), b = byId.get(e.edge.to);
    if (!a || !b) continue;
    const gap = e.edge.label ? EDGE_LABEL_SIZE.w + 48 : 48;
    const direction = b.x - (a.x + a.w) >= gap ? 1 : a.x - (b.x + b.w) >= gap ? -1 : 0;
    if (!direction) continue;
    const key = `${b.id}\u0000${direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ e, a, b, direction });
  }

  for (const group of groups.values()) {
    group.sort((a, b) => centerOf(a.a).y - centerOf(b.a).y || a.e.index - b.e.index);
    const { b, direction } = group[0];
    // Work in a left-to-right coordinate system, then mirror if necessary.
    const start = Math.max(...group.map(({ a }) => direction > 0 ? a.x + a.w : -a.x));
    const end = direction > 0 ? b.x : -(b.x + b.w);
    const labeled = group.some(({ e }) => e.edge.label);
    const labelX = start + 16 + EDGE_LABEL_SIZE.w / 2;
    const firstTurn = labeled ? labelX + EDGE_LABEL_SIZE.w / 2 + 12 : start + 24;
    const lastTurn = end - 16;
    if (firstTurn > lastTurn) continue;
    const laneStep = Math.min(12, (lastTurn - firstTurn) / Math.max(1, group.length - 1));
    const portStep = Math.min(8, (b.h - 16) / Math.max(1, group.length - 1));
    const lanes = [...group].sort((a, c) =>
      Math.abs(centerOf(a.a).y - centerOf(b).y) - Math.abs(centerOf(c.a).y - centerOf(b).y)
      || a.e.index - c.e.index);
    const proposed = group.map((entry, i) => {
      const { a, e } = entry;
      const sy = centerOf(a).y;
      const ty = centerOf(b).y + (i - (group.length - 1) / 2) * portStep;
      const turn = (lastTurn - (group.length - 1 - lanes.indexOf(entry)) * laneStep) * direction;
      const targetInset = b.node?.type === 'decision' && !b.node.children
        ? Math.abs(ty - centerOf(b).y) * b.w / b.h : 0;
      const points = [
        { x: direction > 0 ? a.x + a.w : a.x, y: sy },
        { x: turn, y: sy },
        { x: turn, y: ty },
        { x: (end + targetInset) * direction, y: ty },
      ].filter((p, j, all) => !j || p.x !== all[j - 1].x || p.y !== all[j - 1].y);
      const labelPos = {
        x: e.edge.label ? labelX * direction : (points[0].x + turn) / 2,
        y: sy,
      };
      return { e, a, points, labelPos };
    });
    const blocked = proposed.some(({ e, a, points, labelPos }) => nodes.some((n) => {
      if (n === a || n === b) return false;
      const x1 = n.x - 8, y1 = n.y - 8, x2 = n.x + n.w + 8, y2 = n.y + n.h + 8;
      if (e.edge.label && labelPos.x + EDGE_LABEL_SIZE.w / 2 > x1
        && labelPos.x - EDGE_LABEL_SIZE.w / 2 < x2
        && labelPos.y + EDGE_LABEL_SIZE.h / 2 > y1 && labelPos.y - EDGE_LABEL_SIZE.h / 2 < y2) return true;
      return points.slice(1).some((p, i) => {
        const q = points[i];
        return p.x === q.x
          ? p.x > x1 && p.x < x2 && Math.max(p.y, q.y) > y1 && Math.min(p.y, q.y) < y2
          : p.y > y1 && p.y < y2 && Math.max(p.x, q.x) > x1 && Math.min(p.x, q.x) < x2;
      });
    }));
    if (!blocked) for (const { e, points, labelPos } of proposed) {
      e.autoFallback = { points: e.points, labelPos: e.labelPos, smooth: !!e.smooth };
      Object.assign(e, { points, labelPos, smooth: false });
      routed.add(e);
    }
  }
  return routed;
}

// Route through a user-pinned via point: boundary → via → boundary.
// `smooth` tells the canvas to draw one continuous cable curve through the
// via instead of the usual rounded orthogonal path. The label sits at t=0.3
// along the curve, clear of the bend and the pointer.
export function routeVia(a, b, via, edge = {}) {
  const p1 = boundaryPoint(a, via, edge.fromSide);
  const p2 = boundaryPoint(b, via, edge.toSide);
  const c = { x: 2 * via.x - (p1.x + p2.x) / 2, y: 2 * via.y - (p1.y + p2.y) / 2 };
  const t = 0.3;
  const labelPos = {
    x: (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * c.x + t * t * p2.x,
    y: (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * c.y + t * t * p2.y,
  };
  return { points: [p1, { x: via.x, y: via.y }, p2], labelPos, smooth: true };
}

// Route by style: curved is the smooth cable through the via; angled is one
// rounded corner at the via; stepped is a stair whose riser passes through
// the via on the dominant axis; straight ignores the via entirely.
export function routeStyled(a, b, via, style, edge = {}) {
  if (style === 'straight' || !via) return routeDirect(a, b, edge);
  if (style === 'angled') {
    const p1 = boundaryPoint(a, via, edge.fromSide);
    const p2 = boundaryPoint(b, via, edge.toSide);
    return { points: [p1, { x: via.x, y: via.y }, p2], labelPos: { x: (p1.x + via.x) / 2, y: (p1.y + via.y) / 2 } };
  }
  if (style === 'stepped') {
    const p1 = boundaryPoint(a, via, edge.fromSide);
    const p2 = boundaryPoint(b, via, edge.toSide);
    const flat = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y);
    const horizontal = (side) => side ? side === 'left' || side === 'right' : flat;
    const startFlat = horizontal(edge.fromSide), endFlat = horizontal(edge.toSide);
    const points = startFlat !== endFlat
      ? [p1, startFlat ? { x: via.x, y: p1.y } : { x: p1.x, y: via.y },
        { x: via.x, y: via.y }, endFlat ? { x: via.x, y: p2.y } : { x: p2.x, y: via.y }, p2]
      : startFlat
      ? [p1, { x: via.x, y: p1.y }, { x: via.x, y: p2.y }, p2]
      : [p1, { x: p1.x, y: via.y }, { x: p2.x, y: via.y }, p2];
    const labelPos = startFlat !== endFlat ? { x: via.x, y: via.y } : startFlat
      ? { x: via.x, y: (p1.y + p2.y) / 2 }
      : { x: (p1.x + p2.x) / 2, y: via.y };
    return { points, labelPos };
  }
  return routeVia(a, b, via, edge);
}

// Shared by committed layout and live node dragging. Side-only attachments
// use an orthogonal route without persisting a style or a bend.
export function routeEdge(a, b, edge) {
  if (!edge.via && !edge.route && !edge.fromSide && !edge.toSide) return routeDirect(a, b);
  const via = edge.via ?? routeDirect(a, b, edge).labelPos;
  if (!edge.via && !edge.route) {
    // Leave room outside each chosen side while keeping the midpoint where
    // it already fits. Opposing constraints still need a user-chosen bend.
    for (const [axis, low, high, size] of [['x', 'left', 'right', 'w'], ['y', 'top', 'bottom', 'h']]) {
      let min = -Infinity, max = Infinity;
      for (const [n, side] of [[a, edge.fromSide], [b, edge.toSide]]) {
        if (side === low) max = Math.min(max, n[axis] - 40);
        if (side === high) min = Math.max(min, n[axis] + n[size] + 40);
      }
      if (min <= max) via[axis] = Math.max(min, Math.min(max, via[axis]));
    }
  }
  const style = edge.route ?? (edge.via ? 'curved' : 'stepped');
  return routeStyled(a, b, via, style, edge);
}

// New manual bends use right angles. Preserve legacy via-only curves, but
// never turn an explicitly straight connection into another shape by dragging.
export function routeDragged(a, b, edge, point) {
  if (edge.route === 'straight') return null;
  const style = edge.route ?? (edge.via ? 'curved' : 'stepped');
  const via = { x: Math.round(point.x), y: Math.round(point.y) };
  return { ...routeStyled(a, b, via, style, edge), via, style };
}

// Push auto nodes out of (inflated) pinned rects, minimal-displacement axis
// first. Deterministic; pinned nodes never move. Returns ids it moved.
function resolvePinnedOverlaps(nodes, movedIds, margin = 18) {
  const pinned = nodes.filter((n) => n.pinned);
  if (!pinned.length) return;
  for (let pass = 0; pass < 8; pass++) {
    let any = false;
    for (const a of nodes) {
      if (a.pinned) continue;
      for (const p of pinned) {
        const px1 = p.x - margin, py1 = p.y - margin;
        const px2 = p.x + p.w + margin, py2 = p.y + p.h + margin;
        if (a.x + a.w <= px1 || a.x >= px2 || a.y + a.h <= py1 || a.y >= py2) continue;
        const pushRight = px2 - a.x, pushLeft = a.x + a.w - px1;
        const pushDown = py2 - a.y, pushUp = a.y + a.h - py1;
        const min = Math.min(pushRight, pushLeft, pushDown, pushUp);
        if (min === pushRight) a.x += pushRight;
        else if (min === pushLeft) a.x -= pushLeft;
        else if (min === pushDown) a.y += pushDown;
        else a.y -= pushUp;
        movedIds.add(a.id);
        any = true;
      }
    }
    if (!any) return;
  }
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
    const empty = { nodes: [], edges: [], x: 0, y: 0, w: 0, h: 0 };
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
      const frameH = Math.max(42, Math.min(64, frameW * aspect));
      const headerH = 12 + (s.lines?.length ?? 1) * 19 + 8;
      s.h = Math.max(116, headerH + frameH + 12);
      const scale = child.w > 0
        ? Math.min(frameW / child.w, frameH / child.h, 0.24)
        : 0.1;
      s.mini = {
        child, frameW, frameH, headerH, scale,
        // offsets that center the child layout inside the frame (node-local
        // coords) — child.x/child.y is the child layout's own origin, which
        // is non-zero when the child scope contains pinned nodes
        dx: 13 + (frameW - child.w * scale) / 2 - child.x * scale,
        dy: headerH + (frameH - child.h * scale) / 2 - child.y * scale,
      };
    }
    sized.set(n.id, s);
  }

  const comps = components(scope.nodes, scope.edges);
  const blocks = comps.map((c) => {
    const block = layoutComponent(c, sized);
    return scope.layout === 'compact' ? compactComponent(block) : block;
  });
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

  // pinned nodes: move each to its file position (center-based), push auto
  // nodes out from under them, and re-route every edge that touches a node
  // that is no longer where dagre put it
  const movedIds = new Set();
  for (const n of nodes) {
    const pos = n.node.position;
    if (!pos) continue;
    n.pinned = true;
    n.x = pos.x - n.w / 2;
    n.y = pos.y - n.h / 2;
    movedIds.add(n.id);
  }

  let bounds = { x: 0, y: 0, w: packed.w, h: packed.h };
  const styledEdges = edges.filter((e) => e.edge.via || e.edge.route || e.edge.fromSide || e.edge.toSide);
  if (movedIds.size || styledEdges.length) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    if (movedIds.size) {
      resolvePinnedOverlaps(nodes, movedIds);
      for (const e of edges) {
        if (movedIds.has(e.edge.from) || movedIds.has(e.edge.to)) {
          Object.assign(e, routeDirect(byId.get(e.edge.from), byId.get(e.edge.to)));
        }
      }
    }
    // user-chosen routes win over everything, pins included; a style with no
    // via yet seeds its via at the direct-route midpoint
    for (const e of styledEdges) {
      const a = byId.get(e.edge.from), b = byId.get(e.edge.to);
      if (!a || !b) continue;
      Object.assign(e, routeEdge(a, b, e.edge));
    }
  }
  routeAutomaticEdges(nodes, edges);
  {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    }
    for (const e of edges) {
      for (const p of e.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      if (e.edge.label) {
        x0 = Math.min(x0, e.labelPos.x - EDGE_LABEL_SIZE.w / 2);
        y0 = Math.min(y0, e.labelPos.y - EDGE_LABEL_SIZE.h / 2);
        x1 = Math.max(x1, e.labelPos.x + EDGE_LABEL_SIZE.w / 2);
        y1 = Math.max(y1, e.labelPos.y + EDGE_LABEL_SIZE.h / 2);
      }
    }
    bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const result = { ownerId, nodes, edges, ...bounds };
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

// One continuous cable through a via point: a single quadratic whose
// control point is chosen so the curve passes exactly through the middle
// point (at t = 0.5). Returns the path d and the tangent angle at the end,
// which the arrowhead needs because the last segment is curved.
export function smoothEdgePath(points) {
  if (!points || points.length !== 3) return { d: edgePath(points || []), endAngle: null };
  const [p1, via, p2] = points;
  const c = { x: 2 * via.x - (p1.x + p2.x) / 2, y: 2 * via.y - (p1.y + p2.y) / 2 };
  return {
    d: `M${p1.x},${p1.y} Q${c.x},${c.y} ${p2.x},${p2.y}`,
    endAngle: (Math.atan2(p2.y - c.y, p2.x - c.x) * 180) / Math.PI,
  };
}

// Smooth path through dagre points: straight lines with rounded corners.
export function edgePath(points, radius = 10) {  if (points.length < 2) return '';
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
