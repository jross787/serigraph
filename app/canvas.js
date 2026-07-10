// The map canvas: SVG rendering, camera (pan/zoom), semantic-zoom dive/rise
// transitions, selection visuals, connect-mode, and the minimap.
import { bus, state } from './state.js';
import { layoutScope, miniTransform, edgePath } from './layout.js';

const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, cls = '') => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (cls) n.setAttribute('class', cls);
  return n;
};

// 16px stroke icons per type (decision uses its diamond shape instead)
export const ICONS = {
  process: 'M2.5 8h7.5M7.5 4.5 11 8l-3.5 3.5M12.5 3v10',
  system: 'M4 4.5h8v7H4zM6.5 4.5v-2M9.5 4.5v-2M6.5 13.5v-2M9.5 13.5v-2M2 7h2M2 9.5h2M12 7h2M12 9.5h2',
  role: 'M8 7.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM2.8 13.6c.6-2.9 2.7-4 5.2-4s4.6 1.1 5.2 4',
  artifact: 'M3.5 2h6l3 3v9h-9zM9.5 2v3h3M5.5 8.5h5M5.5 11h5',
  decision: 'M8 2l6 6-6 6-6-6z',
};

let svg, viewport, layersG, gridPattern, gridRect;
let mmSvg, mmNodesG, mmView, mmScale = 1, mmPad = 8, mmOff = { x: 0, y: 0 };
let vw = 0, vh = 0;
let camera = { x: 0, y: 0, k: 1 };
let currentLayout = null;
let currentLayer = null;
let animToken = 0;
let transitioning = false;
const scopeCameras = new Map(); // ownerId -> camera (restore on revisit)

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ── setup ────────────────────────────────────────────────────────────
export function initCanvas(svgEl, minimapSvg) {
  svg = svgEl;
  mmSvg = minimapSvg;

  const defs = el('defs');
  gridPattern = el('pattern', { id: 'griddots', patternUnits: 'userSpaceOnUse', width: 26, height: 26 });
  gridPattern.appendChild(el('circle', { cx: 1.2, cy: 1.2, r: 1.2 }, 'grid-dots'));
  defs.appendChild(gridPattern);
  svg.appendChild(defs);

  // grid stays in screen space (pattern offset follows the camera)
  gridRect = el('rect', { x: 0, y: 0, width: '100%', height: '100%', fill: 'url(#griddots)' });
  gridRect.style.pointerEvents = 'none';
  svg.appendChild(gridRect);

  viewport = el('g', { id: 'viewport' });
  layersG = el('g', {}, 'layers');
  viewport.appendChild(layersG);
  svg.appendChild(viewport);

  mmNodesG = el('g');
  mmView = el('rect', {}, 'mm-view');
  mmSvg.appendChild(mmNodesG);
  mmSvg.appendChild(mmView);

  const measure = () => {
    const r = svg.getBoundingClientRect();
    vw = r.width; vh = r.height;
    applyCamera();
  };
  new ResizeObserver(measure).observe(svg);
  measure();

  wirePointer();
  wireMinimap();
}

// ── camera ───────────────────────────────────────────────────────────
function applyCamera() {
  viewport.setAttribute('transform', `translate(${camera.x},${camera.y}) scale(${camera.k})`);
  // screen-space grid: spacing tracks zoom in power-of-2 buckets
  let spacing = 26 * camera.k;
  if (!Number.isFinite(spacing) || spacing <= 0.001) spacing = 26;
  while (spacing < 14) spacing *= 2;
  while (spacing > 56) spacing /= 2;
  gridPattern.setAttribute('width', spacing);
  gridPattern.setAttribute('height', spacing);
  gridPattern.setAttribute('x', camera.x % spacing);
  gridPattern.setAttribute('y', camera.y % spacing);
  updateMinimapView();
  bus.emit('camera-changed', camera);
}

export const getCamera = () => ({ ...camera });
export function setCamera(c) { camera = { ...c }; applyCamera(); }

const screenToWorld = (px, py) => ({ x: (px - camera.x) / camera.k, y: (py - camera.y) / camera.k });

function fitCamera(bounds, pad = null, maxK = 1.15) {
  const W = vw || window.innerWidth || 1200;
  const H = vh || window.innerHeight || 800;
  if (pad == null) pad = Math.min(70, W * 0.05);
  const w = Math.max(bounds.w, 1), h = Math.max(bounds.h, 1);
  const k = Math.max(0.02, Math.min(maxK, (W - pad * 2) / w, (H - pad * 2) / h));
  return {
    k,
    x: (W - w * k) / 2 - bounds.x * k,
    y: (H - h * k) / 2 - bounds.y * k,
  };
}

function animate(ms, step) {
  const token = ++animToken;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      if (token !== animToken) return resolve(false); // superseded
      const t = Math.min(1, (now - t0) / ms);
      step(ease(t), t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve(true);
    };
    requestAnimationFrame(frame);
  });
}

export function animateCamera(target, ms = 420) {
  const from = { ...camera };
  return animate(ms, (e) => {
    camera = {
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      k: from.k + (target.k - from.k) * e,
    };
    applyCamera();
  });
}

export function fit(ms = 420) {
  if (!currentLayout) return;
  const target = fitCamera({ x: 0, y: 0, w: currentLayout.w, h: currentLayout.h });
  return ms ? animateCamera(target, ms) : setCamera(target);
}

export function zoomBy(factor, cx = vw / 2, cy = vh / 2) {
  const k = Math.min(3, Math.max(0.04, camera.k * factor));
  const wp = screenToWorld(cx, cy);
  camera = { k, x: cx - wp.x * k, y: cy - wp.y * k };
  applyCamera();
}

// ── node + edge rendering ───────────────────────────────────────────
function nodeShape(n) {
  const { w, h } = n;
  const t = n.node.type;
  if (n.node.children) return el('rect', { width: w, height: h, rx: 13 }, 'shape');
  if (t === 'decision') return el('polygon', { points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}` }, 'shape');
  if (t === 'role') return el('rect', { width: w, height: h, rx: h / 2 }, 'shape');
  if (t === 'artifact') {
    const f = 13;
    return el('path', { d: `M0,0 h${w - f} l${f},${f} v${h - f} h${-w} z` }, 'shape');
  }
  if (t === 'system') return el('rect', { width: w, height: h, rx: 5 }, 'shape');
  return el('rect', { width: w, height: h, rx: 10 }, 'shape');
}

function iconChip(type, x, y, size = 24) {
  const g = el('g', { transform: `translate(${x},${y})` });
  g.appendChild(el('rect', { width: size, height: size, rx: 7 }, 'icon-bg'));
  const s = size / 22;
  const p = el('path', {
    d: ICONS[type], fill: 'none', 'stroke-width': 1.6,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    transform: `translate(${3 * s},${3 * s}) scale(${s})`,
  }, 'icon-fg');
  p.style.fill = 'none';
  g.appendChild(p);
  return g;
}

function textLines(lines, x, startY, cls, anchor = 'start', lh = 17) {
  const t = el('text', { x, y: startY, 'text-anchor': anchor }, cls);
  lines.forEach((line, i) => {
    const ts = el('tspan', { x, dy: i === 0 ? 0 : lh });
    ts.textContent = line;
    t.appendChild(ts);
  });
  return t;
}

const MINI_NODE_CAP = 90;

function buildNode(n) {
  const node = n.node;
  const isContainer = !!node.children;
  const g = el('g', { transform: `translate(${n.x},${n.y})` },
    `node t-${node.type}${isContainer ? ' container' : ''}${state.selectedId === node.id ? ' selected' : ''}`);
  g.dataset.id = node.id;

  // selection ring
  const ringPad = 5;
  g.appendChild(el('rect', { x: -ringPad, y: -ringPad, width: n.w + ringPad * 2, height: n.h + ringPad * 2, rx: 16 }, 'sel-ring'));

  if (isContainer) {
    g.appendChild(el('rect', { x: 5, y: 5, width: n.w, height: n.h, rx: 13 }, 'stack'));
    g.appendChild(nodeShape(n));
    g.appendChild(iconChip(node.type, 13, 10));
    g.appendChild(textLines(n.lines, 45, 26, 'label', 'start', 19));

    const m = n.mini;
    g.appendChild(el('rect', { x: 13, y: m.headerH, width: m.frameW, height: m.frameH }, 'mini-frame'));
    const miniG = el('g', { transform: `translate(${m.dx},${m.dy}) scale(${m.scale})` });
    const kids = m.child.nodes.slice(0, MINI_NODE_CAP);
    if (m.child.edges.length <= 60) {
      for (const e of m.child.edges) {
        miniG.appendChild(el('path', {
          d: edgePath(e.points, 8),
          'stroke-width': Math.min(10, 1.4 / m.scale),
        }, 'mini-edge'));
      }
    }
    for (const k of kids) {
      miniG.appendChild(el('rect', { x: k.x, y: k.y, width: k.w, height: k.h, rx: 8 / m.scale > k.h / 2 ? k.h / 4 : 10 }, `mini-node t-${k.node.type}`));
    }
    g.appendChild(miniG);

    // count chip — the "there's more inside" affordance; click dives in
    const label = `${node.stats.childCount}`;
    const chipW = 30 + label.length * 6.5;
    const chip = el('g', { transform: `translate(${n.w - chipW - 10},${n.h - 26})` });
    chip.dataset.dive = node.id;
    chip.style.cursor = 'zoom-in';
    chip.appendChild(el('rect', { width: chipW, height: 19, rx: 9.5 }, 'count-chip-bg'));
    const ct = el('text', { x: 9, y: 13.5 }, 'count-chip-txt');
    ct.textContent = label;
    chip.appendChild(ct);
    const zi = el('path', {
      d: 'M2 8h8M6 4l4 4-4 4', fill: 'none', 'stroke-width': 1.8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      transform: `translate(${chipW - 18},${3.5}) scale(0.75)`,
    }, 'count-chip-txt');
    zi.style.stroke = 'currentColor';
    zi.setAttribute('stroke', 'currentColor');
    chip.appendChild(zi);
    const title = el('title');
    title.textContent = `Open sub-map — ${node.stats.descendantCount} node${node.stats.descendantCount === 1 ? '' : 's'} inside`;
    chip.appendChild(title);
    g.appendChild(chip);
  } else if (node.type === 'decision') {
    g.appendChild(nodeShape(n));
    const totalH = n.lines.length * 17;
    g.appendChild(textLines(n.lines, n.w / 2, (n.h - totalH) / 2 + 13, 'label', 'middle'));
  } else {
    g.appendChild(nodeShape(n));
    g.appendChild(iconChip(node.type, 11, (n.h - 24) / 2));
    const totalH = n.lines.length * 17;
    g.appendChild(textLines(n.lines, 44, (n.h - totalH) / 2 + 13, 'label'));
  }

  if (node.links.length) {
    const lg = el('path', {
      d: 'M6.5 9.5l3-3M5 7l-1.8 1.8a2.3 2.3 0 0 0 3.2 3.2L8.2 10M8 5l1.8-1.8a2.3 2.3 0 0 1 3.2 3.2L11.2 8',
      fill: 'none', 'stroke-width': 1.5, 'stroke-linecap': 'round',
      transform: `translate(${n.w - 20},${n.h - 19})`,
    }, 'link-dot');
    lg.setAttribute('stroke', 'currentColor');
    lg.style.color = 'var(--faint)';
    g.appendChild(lg);
  }
  return g;
}

function buildEdge(e) {
  const g = el('g', {}, 'edge');
  g.dataset.index = e.index;
  const d = edgePath(e.points);
  g.appendChild(el('path', { d }, 'hit'));
  g.appendChild(el('path', { d }, 'line'));

  const pts = e.points;
  if (pts.length >= 2) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    g.appendChild(el('polygon', {
      points: '0,-4 8,0 0,4',
      transform: `translate(${b.x},${b.y}) rotate(${ang})`,
    }, 'arrow'));
  }

  if (e.edge.label) {
    const label = e.edge.label;
    const tw = label.length * 5.9 + 14;
    g.appendChild(el('rect', {
      x: e.labelPos.x - tw / 2, y: e.labelPos.y - 9.5, width: tw, height: 19, rx: 8,
    }, 'edge-label-bg'));
    const t = el('text', { x: e.labelPos.x, y: e.labelPos.y + 3.5, 'text-anchor': 'middle' }, 'edge-label');
    t.textContent = label;
    g.appendChild(t);
  }
  return g;
}

function renderScope(model, ownerId) {
  const layout = layoutScope(model, ownerId);
  const layer = el('g', {}, 'scope-layer');
  const edgesG = el('g', {}, 'edges');
  const nodesG = el('g', {}, 'nodes');
  for (const e of layout.edges) edgesG.appendChild(buildEdge(e));
  for (const n of layout.nodes) nodesG.appendChild(buildNode(n));
  layer.appendChild(edgesG);
  layer.appendChild(nodesG);
  return { layer, layout };
}

// ── scope management + transitions ───────────────────────────────────
export function showScope(model, ownerId, { transition = null, focusId = null } = {}) {
  if (transitioning) { animToken++; finishTransition(); }
  if (transition === 'dive' && currentLayout) return diveTo(model, ownerId, focusId);
  if (transition === 'rise' && currentLayout) return riseTo(model, ownerId);

  if (state.scopeId !== undefined && currentLayout) scopeCameras.set(currentLayout.ownerId ?? null, { ...camera });
  const { layer, layout } = renderScope(model, ownerId);
  layersG.replaceChildren(layer);
  currentLayer = layer;
  currentLayout = layout;
  renderMinimapNodes(layout);
  const saved = scopeCameras.get(ownerId ?? null);
  if (focusId) {
    setCamera(fitCamera({ x: 0, y: 0, w: layout.w, h: layout.h }));
    centerOn(focusId, 0);
  } else if (saved) {
    setCamera(saved);
  } else {
    setCamera(fitCamera({ x: 0, y: 0, w: layout.w, h: layout.h }));
  }
  return Promise.resolve(true);
}

let pendingFinish = null;
function finishTransition() {
  if (pendingFinish) { const f = pendingFinish; pendingFinish = null; f(); }
  transitioning = false;
}

async function diveTo(model, containerId, focusId) {
  const parentLayout = currentLayout;
  const ln = parentLayout.nodes.find((n) => n.id === containerId);
  if (!ln || !ln.mini) return showScope(model, containerId, { focusId });

  scopeCameras.set(parentLayout.ownerId ?? null, { ...camera });
  transitioning = true;
  const T = miniTransform(ln);
  const { layer: newLayer, layout: childLayout } = renderScope(model, containerId);
  newLayer.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
  newLayer.style.opacity = 0;
  const oldLayer = currentLayer;
  layersG.appendChild(newLayer);

  const worldRect = { x: T.x, y: T.y, w: childLayout.w * T.k, h: childLayout.h * T.k };
  const camTarget = fitCamera(worldRect, 60, Infinity);
  const from = { ...camera };

  pendingFinish = () => {
    oldLayer.remove();
    camera = { k: camera.k * T.k, x: camera.x + camera.k * T.x, y: camera.y + camera.k * T.y };
    newLayer.removeAttribute('transform');
    newLayer.style.opacity = 1;
    currentLayer = newLayer;
    currentLayout = childLayout;
    renderMinimapNodes(childLayout);
    applyCamera();
  };

  await animate(500, (e) => {
    camera = {
      x: from.x + (camTarget.x - from.x) * e,
      y: from.y + (camTarget.y - from.y) * e,
      k: from.k + (camTarget.k - from.k) * e,
    };
    applyCamera();
    newLayer.style.opacity = Math.min(1, e * 1.5);
    oldLayer.style.opacity = Math.max(0, 1 - e * 1.15);
  });
  finishTransition();
  await animateCamera(fitCamera({ x: 0, y: 0, w: childLayout.w, h: childLayout.h }), 300);
  return true;
}

async function riseTo(model, parentOwnerId) {
  const childOwnerId = currentLayout.ownerId;
  const { layer: parentLayer, layout: parentLayout } = renderScope(model, parentOwnerId);
  const ln = parentLayout.nodes.find((n) => n.id === childOwnerId);
  if (!ln || !ln.mini) return showScope(model, parentOwnerId, { focusId: childOwnerId });

  transitioning = true;
  const T = miniTransform(ln);
  const childLayer = currentLayer;
  childLayer.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
  camera = { k: camera.k / T.k, x: camera.x - (camera.k / T.k) * T.x, y: camera.y - (camera.k / T.k) * T.y };
  applyCamera();

  parentLayer.style.opacity = 0;
  layersG.insertBefore(parentLayer, childLayer);

  const saved = scopeCameras.get(parentOwnerId ?? null);
  const camTarget = saved ?? fitCamera({ x: 0, y: 0, w: parentLayout.w, h: parentLayout.h });
  const from = { ...camera };

  pendingFinish = () => {
    childLayer.remove();
    currentLayer = parentLayer;
    currentLayout = parentLayout;
    renderMinimapNodes(parentLayout);
    applyCamera();
  };

  await animate(500, (e) => {
    camera = {
      x: from.x + (camTarget.x - from.x) * e,
      y: from.y + (camTarget.y - from.y) * e,
      k: from.k + (camTarget.k - from.k) * e,
    };
    applyCamera();
    parentLayer.style.opacity = Math.min(1, e * 1.3);
    childLayer.style.opacity = Math.max(0, 1 - e * 1.3);
  });
  finishTransition();
  return true;
}

// re-render the current scope in place (after an edit), preserving camera
export function refreshScope(model) {
  if (!currentLayout) return;
  const ownerId = currentLayout.ownerId;
  const { layer, layout } = renderScope(model, ownerId);
  layersG.replaceChildren(layer);
  currentLayer = layer;
  currentLayout = layout;
  renderMinimapNodes(layout);
  applyCamera();
}

export function centerOn(nodeId, ms = 420) {
  const n = currentLayout?.nodes.find((x) => x.id === nodeId);
  if (!n) return Promise.resolve(false);
  const k = Math.min(1.2, Math.max(0.65, camera.k));
  const target = {
    k,
    x: vw / 2 - (n.x + n.w / 2) * k,
    y: vh / 2 - (n.y + n.h / 2) * k,
  };
  return ms ? animateCamera(target, ms) : Promise.resolve(setCamera(target) ?? true);
}

export const getLayout = () => currentLayout;

// ── selection visuals (no re-render) ─────────────────────────────────
export function paintSelection() {
  if (!currentLayer) return;
  for (const g of currentLayer.querySelectorAll('.node')) {
    g.classList.toggle('selected', g.dataset.id === state.selectedId);
    g.classList.toggle('connect-target', !!state.connectFrom && g.dataset.id !== state.connectFrom);
  }
  for (const g of currentLayer.querySelectorAll('.edge')) {
    g.classList.toggle('selected', state.selectedEdge != null && Number(g.dataset.index) === state.selectedEdge.index);
  }
  svg.classList.toggle('connecting', !!state.connectFrom);
}

export function dimExcept(nodeId) {
  if (!currentLayer) return;
  for (const g of currentLayer.querySelectorAll('.node')) {
    g.classList.toggle('dimmed', nodeId != null && g.dataset.id !== nodeId);
  }
  for (const g of currentLayer.querySelectorAll('.edge')) {
    let on = false;
    if (nodeId != null) {
      const e = currentLayout.edges.find((x) => x.index === Number(g.dataset.index));
      on = e && e.edge.from !== nodeId && e.edge.to !== nodeId;
    }
    g.classList.toggle('dimmed', !!on);
  }
}

// ── pointer interactions ─────────────────────────────────────────────
function wirePointer() {
  let down = null;
  let moved = false;

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    down = { px: ev.clientX, py: ev.clientY, cam: { ...camera } };
    moved = false;
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!down) return;
    const dx = ev.clientX - down.px, dy = ev.clientY - down.py;
    if (!moved && Math.hypot(dx, dy) > 4) { moved = true; svg.classList.add('panning'); }
    if (moved) {
      camera = { ...camera, x: down.cam.x + dx, y: down.cam.y + dy };
      applyCamera();
    }
  });
  svg.addEventListener('pointerup', (ev) => {
    svg.classList.remove('panning');
    const wasDrag = moved;
    down = null; moved = false;
    if (wasDrag) return;

    const dive = ev.target.closest?.('[data-dive]');
    if (dive) { bus.emit('dive-request', dive.dataset.dive); return; }
    const nodeEl = ev.target.closest?.('.node');
    if (nodeEl) { bus.emit('node-click', nodeEl.dataset.id, ev); return; }
    const edgeEl = ev.target.closest?.('.edge');
    if (edgeEl) { bus.emit('edge-click', Number(edgeEl.dataset.index)); return; }
    bus.emit('bg-click');
  });

  svg.addEventListener('dblclick', (ev) => {
    const nodeEl = ev.target.closest?.('.node');
    if (nodeEl) {
      bus.emit('node-dblclick', nodeEl.dataset.id);
    } else {
      fit();
    }
    ev.preventDefault();
  });

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
    if (ev.ctrlKey || ev.metaKey) {
      zoomBy(Math.exp(-ev.deltaY * 0.012), cx, cy);
    } else {
      camera = { ...camera, x: camera.x - ev.deltaX, y: camera.y - ev.deltaY };
      applyCamera();
    }
  }, { passive: false });
}

// ── minimap ──────────────────────────────────────────────────────────
function renderMinimapNodes(layout) {
  if (!mmSvg) return;
  const box = mmSvg.getBoundingClientRect();
  const W = box.width || 176, H = box.height || 120;
  mmNodesG.replaceChildren();
  if (!layout || !layout.w) { mmView.setAttribute('width', 0); return; }
  mmScale = Math.min((W - mmPad * 2) / layout.w, (H - mmPad * 2) / layout.h);
  mmOff = { x: (W - layout.w * mmScale) / 2, y: (H - layout.h * mmScale) / 2 };
  for (const n of layout.nodes) {
    mmNodesG.appendChild(el('rect', {
      x: mmOff.x + n.x * mmScale,
      y: mmOff.y + n.y * mmScale,
      width: Math.max(2, n.w * mmScale),
      height: Math.max(1.6, n.h * mmScale),
      rx: 1.5,
    }, `mm-node${n.node.children ? ' container' : ''}`));
  }
  updateMinimapView();
}

function updateMinimapView() {
  if (!mmSvg || !currentLayout) return;
  const tl = screenToWorld(0, 0), br = screenToWorld(vw, vh);
  mmView.setAttribute('x', mmOff.x + tl.x * mmScale);
  mmView.setAttribute('y', mmOff.y + tl.y * mmScale);
  mmView.setAttribute('width', Math.max(0, (br.x - tl.x) * mmScale));
  mmView.setAttribute('height', Math.max(0, (br.y - tl.y) * mmScale));
}

function wireMinimap() {
  if (!mmSvg) return;
  let dragging = false;
  const moveTo = (ev) => {
    const r = mmSvg.getBoundingClientRect();
    const wx = (ev.clientX - r.left - mmOff.x) / mmScale;
    const wy = (ev.clientY - r.top - mmOff.y) / mmScale;
    camera = { ...camera, x: vw / 2 - wx * camera.k, y: vh / 2 - wy * camera.k };
    applyCamera();
  };
  mmSvg.addEventListener('pointerdown', (ev) => { dragging = true; mmSvg.setPointerCapture(ev.pointerId); moveTo(ev); });
  mmSvg.addEventListener('pointermove', (ev) => { if (dragging) moveTo(ev); });
  mmSvg.addEventListener('pointerup', () => { dragging = false; });
}
