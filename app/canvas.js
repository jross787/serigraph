// The map canvas: SVG rendering, camera (pan/zoom), semantic-zoom dive/rise
// transitions, selection visuals, connect-mode, drag gestures (move/pin,
// re-nest, connect-by-port), and the minimap.
import { bus, state } from './state.js';
import { ancestryOf } from '../shared/model.js';
import { nodeCost, compactMoney } from '../shared/cost.js';
import { layoutScope, miniTransform, edgePath, smoothEdgePath, routeDirect, routeStyled, invalidateLayouts } from './layout.js';

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
  item: 'M3 3h10v10H3z',
  database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2zM3 4c0 1.1 2.2 2 5 2s5-.9 5-2M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  api: 'M5.5 3H3v10h2.5M10.5 3H13v10h-2.5M7 5.5h2M6.5 8h3M7 10.5h2',
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

// cameras are per-map state: opening another map must not inherit them
// (node ids can collide across maps, and pinned nodes make a stale camera
// visibly wrong instead of merely off-center). The pending flag also stops
// the NEXT showScope from re-saving the outgoing map's camera.
let camerasResetPending = false;
export function resetScopeCameras() {
  scopeCameras.clear();
  camerasResetPending = true;
}

// Motion is deliberately a little springy rather than merely slow. The map
// should feel connected to the pointer — like a taut string — without making
// a process diagram feel like a toy. These values settle in well under a
// second and only allow a small, controlled overshoot.
let panFrame = 0;
let panTarget = null;
let panVelocity = { x: 0, y: 0 };
let panLastTime = 0;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rubberEase = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const overshoot = 1.18;
  const u = t - 1;
  return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
};
const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

  moveOutBar = document.getElementById('moveout-bar');
  wirePointer();
  wireMinimap();
}

// ── move-out drop bar (shown while dragging a node inside a sub-map) ──
let moveOutBar = null;
function showMoveOutBar() {
  if (!moveOutBar || state.scopeId == null || !state.model) return;
  const owner = state.model.byId.get(state.scopeId);
  const parentLabel = owner?.ownerId
    ? state.model.byId.get(owner.ownerId)?.label ?? owner.ownerId
    : state.model.name;
  moveOutBar.textContent = `⤴ Drop here to move out to “${parentLabel}”`;
  moveOutBar.hidden = false;
}
function hideMoveOutBar() {
  if (!moveOutBar) return;
  moveOutBar.hidden = true;
  moveOutBar.classList.remove('hot');
}

// ── camera ───────────────────────────────────────────────────────────
function applyCamera() {
  viewport.setAttribute('transform', `translate(${camera.x},${camera.y}) scale(${camera.k})`);
  const inverseScale = 1 / Math.max(camera.k, 0.02);
  for (const badge of viewport.querySelectorAll('.identity-context')) {
    badge.setAttribute('transform', `translate(${badge.dataset.x},0) scale(${inverseScale})`);
  }
  // screen-space grid: spacing tracks zoom in power-of-2 buckets
  let spacing = 26 * camera.k;
  if (!Number.isFinite(spacing) || spacing <= 0.001) spacing = 26;
  while (spacing < 14) spacing *= 2;
  while (spacing > 56) spacing /= 2;
  gridPattern.setAttribute('width', spacing);
  gridPattern.setAttribute('height', spacing);
  gridPattern.setAttribute('x', camera.x % spacing);
  gridPattern.setAttribute('y', camera.y % spacing);
  // Dense maps stay legible and responsive: secondary copy disappears before
  // the whole graph turns into unreadable visual noise.
  svg.classList.toggle('canvas-overview', camera.k < 0.58);
  updateMinimapView();
  bus.emit('camera-changed', camera);
}

export const getCamera = () => ({ ...camera });
export const isTransitioning = () => transitioning;
export function nodeScreenRect(nodeId) {
  const n = currentLayout?.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  return {
    x: camera.x + n.x * camera.k,
    y: camera.y + n.y * camera.k,
    width: n.w * camera.k,
    height: n.h * camera.k,
  };
}
export function setCamera(c) {
  stopPanMotion();
  animToken++; // an explicit camera set cancels any in-flight camera animation
  camera = { ...c };
  applyCamera();
}

const screenToWorld = (px, py) => ({ x: (px - camera.x) / camera.k, y: (py - camera.y) / camera.k });

// client (viewport) coordinates → world coordinates of the current scope
export function worldAt(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return screenToWorld(clientX - r.left, clientY - r.top);
}

// What sits under a client point — used by palette drops. The caller's ghost
// must be pointer-events:none for elementFromPoint to see through it.
export function dropInfo(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  if (clientX < r.left || clientY < r.top || clientX > r.right || clientY > r.bottom) return { kind: 'outside' };
  const under = document.elementFromPoint(clientX, clientY);
  if (!under || (under !== svg && !svg.contains(under))) return { kind: 'outside' };
  const nodeEl = under.closest?.('.node');
  if (nodeEl && currentLayer?.contains(nodeEl)) {
    const n = state.model?.byId.get(nodeEl.dataset.id);
    return { kind: n?.children ? 'container' : 'node', id: nodeEl.dataset.id };
  }
  return { kind: 'canvas', world: worldAt(clientX, clientY) };
}

// highlight a node as the current drop target (or clear with null)
export function setDropHighlight(id) {
  if (!currentLayer) return;
  for (const g of currentLayer.querySelectorAll('.node.drop-target')) {
    if (g.dataset.id !== id) g.classList.remove('drop-target');
  }
  if (id) currentLayer.querySelector(`.node[data-id="${CSS.escape(id)}"]`)?.classList.add('drop-target');
}

function fitCamera(bounds, pad = null, maxK = 1.15, viewport = null) {
  const W = viewport?.width || vw || window.innerWidth || 1200;
  const H = viewport?.height || vh || window.innerHeight || 800;
  if (pad == null) pad = Math.min(70, W * 0.05);
  const w = Math.max(bounds.w, 1), h = Math.max(bounds.h, 1);
  const k = Math.max(0.02, Math.min(maxK, (W - pad * 2) / w, (H - pad * 2) / h));
  return {
    k,
    x: (W - w * k) / 2 - bounds.x * k,
    y: (H - h * k) / 2 - bounds.y * k,
  };
}

function scopeEntryCamera(model, ownerId, layout) {
  const bounds = layoutBounds(layout);
  const target = fitCamera(bounds);
  const width = vw || window.innerWidth || 1200;
  const height = vh || window.innerHeight || 800;
  const prioritizeReadability = model.mode !== 'freeform' || ownerId != null;
  const minK = width <= 700 ? 0.62 : 0.70;
  if (!prioritizeReadability || target.k >= minK) return target;
  const k = minK;
  return {
    k,
    x: width <= 700 || model.mode !== 'freeform'
      ? 34 - bounds.x * k
      : (width - bounds.w * k) / 2 - bounds.x * k,
    y: (height - bounds.h * k) / 2 - bounds.y * k,
  };
}

function usableViewport() {
  const full = { width: vw || window.innerWidth || 1200, height: vh || window.innerHeight || 800 };
  const panel = document.getElementById('detail');
  if (!panel || panel.hidden) return full;
  const panelRect = panel.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  if (full.width <= 700 && panelRect.top > svgRect.top && panelRect.top < svgRect.bottom) {
    return {
      width: full.width,
      height: Math.max(180, panelRect.top - svgRect.top - 10),
    };
  }
  if (panelRect.left <= svgRect.left || panelRect.left >= svgRect.right) return full;
  return {
    width: Math.max(360, panelRect.left - svgRect.left - 12),
    height: full.height,
  };
}

function animate(ms, step, curve = ease) {
  const token = ++animToken;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      if (token !== animToken) return resolve(false); // superseded
      const t = Math.min(1, (now - t0) / ms);
      step(curve(t), t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve(true);
    };
    requestAnimationFrame(frame);
  });
}

export function animateCamera(target, ms = 420) {
  stopPanMotion();
  if (!ms || prefersReducedMotion()) {
    setCamera(target);
    return Promise.resolve(true);
  }
  const from = { ...camera };
  return animate(ms, (e) => {
    camera = {
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      k: from.k + (target.k - from.k) * e,
    };
    applyCamera();
  }, rubberEase);
}

function visibleInstances(nodeId) {
  const nodes = currentLayout?.minimapLayout?.nodes ?? currentLayout?.nodes ?? [];
  return nodes.filter((node) => node.id === nodeId);
}

function boundsAround(nodes) {
  const x1 = Math.min(...nodes.map((node) => node.x));
  const y1 = Math.min(...nodes.map((node) => node.y));
  const x2 = Math.max(...nodes.map((node) => node.x + node.w));
  const y2 = Math.max(...nodes.map((node) => node.y + node.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function focusOn(nodeId, ms = 380) {
  const instances = state.model?.mode === 'freeform' ? visibleInstances(nodeId) : [];
  if (instances.length > 1) {
    const usable = usableViewport();
    const target = fitCamera(boundsAround(instances), usable.width <= 700 ? 120 : 80, 1.05, usable);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return ms && !reduced ? animateCamera(target, ms) : setCamera(target);
  }
  const n = currentLayout?.nodes.find((x) => x.id === nodeId);
  if (!n) return;
  const k = Math.min(1.12, Math.max(camera.k, 0.78));
  const usable = usableViewport();
  const target = {
    k,
    x: usable.width / 2 - (n.x + n.w / 2) * k,
    y: usable.height * 0.5 - (n.y + n.h / 2) * k,
  };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return ms && !reduced ? animateCamera(target, ms) : setCamera(target);
}

const layoutBounds = (l) => ({ x: l.x ?? 0, y: l.y ?? 0, w: l.w, h: l.h });

export function fit(ms = 420) {
  if (!currentLayout) return;
  const target = fitCamera(layoutBounds(currentLayout.minimapLayout ?? currentLayout));
  return ms ? animateCamera(target, ms) : setCamera(target);
}

export function zoomBy(factor, cx = vw / 2, cy = vh / 2) {
  const k = Math.min(3, Math.max(0.04, camera.k * factor));
  const wp = screenToWorld(cx, cy);
  return animateCamera({ k, x: cx - wp.x * k, y: cy - wp.y * k }, 240);
}

function stopPanMotion({ snap = false } = {}) {
  if (panFrame) cancelAnimationFrame(panFrame);
  panFrame = 0;
  if (snap && panTarget) {
    camera = { ...panTarget };
    applyCamera();
  }
  panTarget = null;
  panVelocity = { x: 0, y: 0 };
}

function springPanTo(target) {
  if (prefersReducedMotion()) {
    camera = { ...target };
    applyCamera();
    return;
  }
  if (panTarget) {
    // Give a fresh pointer delta a little momentum. This keeps the canvas
    // connected to the user's hand instead of lagging behind it.
    panVelocity.x += (target.x - panTarget.x) * 18;
    panVelocity.y += (target.y - panTarget.y) * 18;
  }
  panTarget = { ...target };
  if (panFrame) return;
  panLastTime = performance.now();

  const step = (now) => {
    if (!panTarget) { panFrame = 0; return; }
    const dt = Math.min(0.034, Math.max(0.001, (now - panLastTime) / 1000));
    panLastTime = now;
    const dx = panTarget.x - camera.x;
    const dy = panTarget.y - camera.y;
    // Near-critical damping with a touch of give. The tiny overshoot on a
    // release is the tactile "rubber band" finish, not a cartoon bounce.
    const stiffness = 210;
    const damping = 24;
    panVelocity.x = (panVelocity.x + dx * stiffness * dt) * Math.exp(-damping * dt);
    panVelocity.y = (panVelocity.y + dy * stiffness * dt) * Math.exp(-damping * dt);
    camera = {
      k: panTarget.k,
      x: camera.x + panVelocity.x * dt,
      y: camera.y + panVelocity.y * dt,
    };
    applyCamera();

    const distance = Math.hypot(panTarget.x - camera.x, panTarget.y - camera.y);
    const speed = Math.hypot(panVelocity.x, panVelocity.y);
    if (distance < 0.12 && speed < 0.12) {
      camera = { ...panTarget };
      applyCamera();
      panTarget = null;
      panVelocity = { x: 0, y: 0 };
      panFrame = 0;
      return;
    }
    panFrame = requestAnimationFrame(step);
  };
  panFrame = requestAnimationFrame(step);
}

// ── node + edge rendering ───────────────────────────────────────────
function nodeShape(n) {
  const { w, h } = n;
  const t = n.node.type;
  if (n.node.children) return el('rect', { width: w, height: h, rx: 8 }, 'shape');
  if (t === 'decision') return el('polygon', { points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}` }, 'shape');
  if (t === 'role') return el('rect', { width: w, height: h, rx: h / 2 }, 'shape');
  if (t === 'artifact') {
    const f = 13;
    return el('path', { d: `M0,0 h${w - f} l${f},${f} v${h - f} h${-w} z` }, 'shape');
  }
  if (t === 'system' || t === 'database' || t === 'api') return el('rect', { width: w, height: h, rx: 7 }, 'shape');
  return el('rect', { width: w, height: h, rx: 7 }, 'shape');
}

function iconChip(type, x, y, size = 24) {
  const g = el('g', { transform: `translate(${x},${y})` });
  g.appendChild(el('rect', { width: size, height: size, rx: 5 }, 'icon-bg'));
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

function summaryLines(text, maxChars = 31, maxLines = 2) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (trial.length <= maxChars || !line) line = trial;
    else { lines.push(line); line = word; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.join(' ').length < words.join(' ').length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:]$/, '')}…`;
  }
  return lines;
}

function truncateLabel(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
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
  g.appendChild(el('rect', { x: -ringPad, y: -ringPad, width: n.w + ringPad * 2, height: n.h + ringPad * 2, rx: 11 }, 'sel-ring'));
  if (state.model?.mode === 'freeform' && node.isPlacement) {
    const ownerLabel = state.model.byId.get(node.ownerId)?.label ?? node.ownerId;
    const visibleOwner = truncateLabel(ownerLabel, 26);
    const visibleElement = truncateLabel(node.label, 22);
    const badgeWidth = Math.max(visibleElement.length * 6.4, visibleOwner.length * 6) + 18;
    const contextBadge = el('g', {}, 'identity-context');
    contextBadge.dataset.x = n.w / 2;
    contextBadge.appendChild(el('path', { d: 'M0 -10V0' }, 'identity-context-stem'));
    contextBadge.appendChild(el('rect', {
      x: -badgeWidth / 2, y: -47, width: badgeWidth, height: 37, rx: 10,
    }, 'identity-context-bg'));
    const contextText = el('text', { x: 0, y: -31, 'text-anchor': 'middle' }, 'identity-context-text');
    contextText.textContent = visibleElement;
    contextBadge.appendChild(contextText);
    const ownerText = el('text', { x: 0, y: -17, 'text-anchor': 'middle' }, 'identity-context-owner');
    ownerText.textContent = visibleOwner;
    contextBadge.appendChild(ownerText);
    const contextTitle = el('title');
    contextTitle.textContent = `${node.label} in ${ownerLabel}`;
    contextBadge.appendChild(contextTitle);
    g.appendChild(contextBadge);
  }

  if (isContainer) {
    const countLabel = `${node.stats.childCount}`;
    const chipW = 30 + countLabel.length * 6.5;
    g.appendChild(el('rect', { x: 5, y: 5, width: n.w, height: n.h, rx: 8 }, 'stack'));
    g.appendChild(nodeShape(n));
    g.appendChild(iconChip(node.type, 13, 10));
    g.appendChild(textLines(n.lines, 45, 26, 'label', 'start', 19));
    const desc = summaryLines(node.description);
    if (desc.length) g.appendChild(textLines(desc, 14, 58, 'node-summary', 'start', 15));
    const meta = el('text', { x: 14, y: n.h - 15 }, 'node-meta');
    const ownerLabels = (node.owners ?? [])
      .map((owner) => state.model?.elementById?.get(owner.to)?.label ?? owner.to)
      .join(', ');
    const metaText = state.model?.mode === 'freeform'
      ? node.children ? `${node.stats.childCount} items` : ownerLabels || node.type
      : node.owner || `${node.stats.childCount} steps`;
    const metaChars = Math.max(10, Math.floor((n.w - chipW - 58) / 6.2));
    meta.textContent = truncateLabel(metaText, metaChars);
    g.appendChild(meta);
    if (state.model?.mode !== 'freeform') {
      const automation = node.automation || 'not-assessed';
      g.appendChild(el('circle', { cx: n.w - 15, cy: n.h - 17, r: 4 }, `automation-dot a-${automation}`));
    }

    // count chip — the "there's more inside" affordance; click dives in
    const label = countLabel;
    const chip = el('g', { transform: `translate(${n.w - chipW - 28},${n.h - 26})` });
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
    title.textContent = state.model?.mode === 'freeform'
      ? `Open group with ${node.stats.descendantCount} item${node.stats.descendantCount === 1 ? '' : 's'} inside`
      : `Open sub-map with ${node.stats.descendantCount} node${node.stats.descendantCount === 1 ? '' : 's'} inside`;
    chip.appendChild(title);
    g.appendChild(chip);
  } else if (node.type === 'decision') {
    g.appendChild(nodeShape(n));
    const totalH = n.lines.length * 17;
    g.appendChild(textLines(n.lines, n.w / 2, (n.h - totalH) / 2 + 13, 'label', 'middle'));
  } else {
    g.appendChild(nodeShape(n));
    if (node.type === 'artifact') {
      g.appendChild(el('path', { d: `M${n.w - 13},0 V13 H${n.w}` }, 'artifact-fold'));
    }
    g.appendChild(iconChip(node.type, 11, (n.h - 24) / 2));
    const totalH = n.lines.length * 17;
    g.appendChild(textLines(n.lines, 44, (n.h - totalH) / 2 + 13, 'label'));
  }

  // provenance badge — this element was inferred from a transcript, not
  // stated; the detail panel shows the note and a "Mark confirmed" action
  const flagNote = state.flags?.nodes?.get(node.id);
  if (flagNote) {
    const fb = el('g', { transform: 'translate(6,-2)' }, 'flag-badge');
    fb.appendChild(el('circle', { r: 9 }, 'flag-bg'));
    fb.appendChild(el('path', {
      d: 'M-2.5 4.5 v-9 h5.5 l-1.8 2.2 1.8 2.2 h-4.3',
      'stroke-linejoin': 'round',
    }, 'flag-glyph'));
    const ft = el('title');
    ft.textContent = `Inferred, not stated: ${flagNote} — open the panel to confirm`;
    fb.appendChild(ft);
    g.appendChild(fb);
  }

  // actor tag — who performs this step: a human, a computer, or both.
  // Read from the node's `automation` field; absent means not assessed.
  const ACTOR_TAGS = {
    manual: {
      cls: 'at-manual',
      label: 'Human — done by hand',
      glyph: 'M10 8.4a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4zM4.4 17c.2-3.4 2.5-5.1 5.6-5.1s5.4 1.7 5.6 5.1',
    },
    automated: {
      cls: 'at-automated',
      label: 'Computer — done by an agent',
      glyph: 'M4.6 4.8h10.8v8.2H4.6zM8 16.4h4M10 13v3.4',
    },
    assisted: {
      cls: 'at-assisted',
      label: 'Human + computer — assisted',
      glyph: 'M6.8 7.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM2.6 15.4c.2-2.9 2-4.4 4.2-4.4 1 0 1.8.2 2.5.7M11.4 8.2h6.2v4.9h-6.2zM13 16h3M14.5 13.1V16',
    },
    'at-risk': {
      cls: 'at-risk',
      label: 'At risk — needs attention',
      glyph: 'M10 4.4 16.8 16H3.2zM10 8.6v3.6m0 2v.2',
    },
  };
  const actorTag = ACTOR_TAGS[node.automation];
  if (actorTag) {
    const tag = el('g', { transform: `translate(${n.w - 4},${n.h + 2})` }, `actor-tag ${actorTag.cls}`);
    tag.appendChild(el('circle', { r: 10 }, 'actor-bg'));
    tag.appendChild(el('path', { d: actorTag.glyph, transform: 'translate(-10,-10) scale(0.94)' }, 'actor-glyph'));
    const at = el('title');
    at.textContent = actorTag.label;
    tag.appendChild(at);
    g.appendChild(tag);
  }

  // pinned nodes wear a small pin badge; clicking it releases to auto-layout
  if (node.position) {
    const pb = el('g', { transform: `translate(${n.w - 6},${-2})` }, 'pin-badge');
    pb.appendChild(el('circle', { r: 9.5 }, 'pin-bg'));
    pb.appendChild(el('path', {
      d: 'M0 4.6 C-3.2 1 -4.1 -0.6 -4.1 -2.1 A4.1 4.1 0 1 1 4.1 -2.1 C4.1 -0.6 3.2 1 0 4.6 Z',
    }, 'pin-glyph'));
    pb.appendChild(el('circle', { cx: 0, cy: -2.1, r: 1.5 }, 'pin-dot'));
    const pt = el('title');
    if (state.standalone) {
      pt.textContent = 'Pinned position';
      pb.style.cursor = 'default';
    } else {
      pt.textContent = 'Pinned — click to release back to auto-layout';
      pb.dataset.unpin = node.id;
    }
    pb.appendChild(pt);
    g.appendChild(pb);
  }

  // Freeform placement notes are local to one group. Mark the card so that
  // the reader knows to open the detail panel for group-specific context.
  if (state.model?.mode === 'freeform' && node.note) {
    const x = n.w - (node.position ? 29 : 7);
    const nb = el('g', { transform: `translate(${x},${-2})` }, 'local-note-badge');
    nb.appendChild(el('circle', { r: 9 }, 'local-note-bg'));
    nb.appendChild(el('path', {
      d: 'M-3.5-3h7v5.5h-3.8l-2.7 2.2V2.5h-.5z',
      'stroke-linejoin': 'round',
    }, 'local-note-glyph'));
    const nt = el('title');
    nt.textContent = `Note for this group: ${node.note}`;
    nb.appendChild(nt);
    g.appendChild(nb);
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

  // cost chip for process maps
  if (node.cost && state.model?.mode !== 'freeform') {
    const cur = state.model?.costModel?.currency ?? 'USD';
    const rc = nodeCost(node, state.model?.costModel ?? {});
    const txt = rc.complete
      ? `${compactMoney(rc.humanMonthly, cur)} → ${compactMoney(rc.agentMonthly, cur)}/mo`
      : 'cost: incomplete';
    const w = txt.length * 5.6 + 16;
    const chip = el('g', { transform: `translate(2,${n.h + 5})` }, `cost-chip${rc.complete ? '' : ' partial'}`);
    chip.appendChild(el('rect', { width: w, height: 16, rx: 8 }, 'cost-chip-bg'));
    const t = el('text', { x: 8, y: 11.5 }, 'cost-chip-txt');
    t.textContent = txt;
    chip.appendChild(t);
    const tip = el('title');
    tip.textContent = rc.complete
      ? `Human ${compactMoney(rc.humanMonthly, cur)}/mo vs agent ${compactMoney(rc.agentMonthly, cur)}/mo — saves ${compactMoney(rc.savingsMonthly, cur)}/mo`
      : `Cost inputs incomplete — missing: ${rc.missing.join(', ')}. Unknowns are excluded from totals.`;
    chip.appendChild(tip);
    g.appendChild(chip);
  }

  // connect port: drag from here to another node to draw an edge
  if (!state.standalone) {
    const port = el('g', { transform: `translate(${n.w},${n.h / 2})` }, 'port');
    port.dataset.port = node.id;
    port.appendChild(el('circle', { r: 9 }, 'port-hit'));
    port.appendChild(el('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5 }, 'port-dot'));
    const pt = el('title');
    pt.textContent = 'Drag to another node to connect';
    port.appendChild(pt);
    g.appendChild(port);
  }
  return g;
}

function buildEdge(e) {
  const g = el('g', {}, 'edge');
  g.dataset.index = e.index;
  const smooth = e.smooth ? smoothEdgePath(e.points) : null;
  const d = smooth ? smooth.d : edgePath(e.points);
  g.appendChild(el('path', { d }, 'hit'));
  g.appendChild(el('path', { d }, 'line'));

  const pts = e.points;
  if (pts.length >= 2) {
    const b = pts[pts.length - 1];
    const ang = smooth
      ? smooth.endAngle
      : (Math.atan2(b.y - pts[pts.length - 2].y, b.x - pts[pts.length - 2].x) * 180) / Math.PI;
    g.appendChild(el('polygon', {
      points: '-8,-3.5 0,0 -8,3.5',
      transform: `translate(${b.x},${b.y}) rotate(${ang})`,
    }, 'arrow'));
  }

  if (e.edge.label) {
    const label = e.edge.label;
    const tw = label.length * 7.1 + 21;
    g.appendChild(el('rect', {
      x: e.labelPos.x - tw / 2, y: e.labelPos.y - 12, width: tw, height: 24, rx: 12,
    }, 'edge-label-bg'));
    const t = el('text', { x: e.labelPos.x, y: e.labelPos.y + 4.3, 'text-anchor': 'middle' }, 'edge-label');
    t.textContent = label;
    g.appendChild(t);
  }

  // custom-route badge at the via point: click to release back to auto-routing
  if (e.edge.via) {
    const v = e.edge.via;
    const badge = el('g', { transform: `translate(${v.x},${v.y})`, 'data-unroute': e.index }, 'route-badge');
    badge.appendChild(el('circle', { r: 7.5 }, 'route-badge-bg'));
    badge.appendChild(el('path', { d: 'M-2.8,-2.8 L2.8,2.8 M2.8,-2.8 L-2.8,2.8' }, 'route-badge-glyph'));
    const title = el('title');
    title.textContent = 'Custom route — click to restore automatic routing';
    badge.appendChild(title);
    g.appendChild(badge);
  }
  return g;
}

// ── cable bundles ────────────────────────────────────────────────────
// Two or more edges between the same pair of nodes — either direction —
// render as one cable sheath with a count chip and an arrowhead for each
// direction present. Hovering (or tapping) the sheath fans the members out
// so each stays clickable and draggable; a member with a custom route
// leaves the bundle automatically.
function fanMember(points, labelPos, i, n, normal) {
  const spread = 24; // clears the 20px-tall label pills between neighbors
  const o = (i - (n - 1) / 2) * spread;
  return {
    points: points.map((p) => ({ x: p.x + normal.x * o, y: p.y + normal.y * o })),
    labelPos: { x: labelPos.x + normal.x * o, y: labelPos.y + normal.y * o },
  };
}

function bundleArrow(b, ang) {
  return el('polygon', {
    points: '-8,-3.5 0,0 -8,3.5',
    transform: `translate(${b.x},${b.y}) rotate(${ang})`,
  }, 'arrow');
}

function buildBundle(members, layout) {
  const g = el('g', {}, 'bundle');
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const first = members[0].edge;
  const a = byId.get(first.from), b = byId.get(first.to);
  if (!a || !b) { // endpoints not on screen together — render as singles
    for (const e of members) g.appendChild(buildEdge(e));
    return g;
  }
  const route = routeDirect(a, b);
  const d = edgePath(route.points);
  const sheath = el('g', {}, 'sheath');
  sheath.appendChild(el('path', { d }, 'bundle-hit'));
  sheath.appendChild(el('path', { d, 'stroke-width': 2.2 + members.length * 1.3 }, 'bundle-line'));
  const p1 = route.points[0], p2 = route.points[route.points.length - 1];
  const ang = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  if (members.some((e) => e.edge.from === first.from)) sheath.appendChild(bundleArrow(p2, ang));
  if (members.some((e) => e.edge.to === first.from)) sheath.appendChild(bundleArrow(p1, ang + 180));
  const chip = el('g', { transform: `translate(${route.labelPos.x},${route.labelPos.y})` }, 'bundle-chip');
  chip.appendChild(el('rect', { x: -13, y: -10, width: 26, height: 20, rx: 10 }, 'bundle-chip-bg'));
  const t = el('text', { y: 3.8, 'text-anchor': 'middle' }, 'bundle-chip-txt');
  t.textContent = `×${members.length}`;
  chip.appendChild(t);
  const title = el('title');
  title.textContent = `${members.length} connections — hover to fan them out`;
  chip.appendChild(title);
  sheath.appendChild(chip);
  g.appendChild(sheath);
  const mem = el('g', {}, 'members');
  // one normal for the whole corridor: a member running the other way must
  // fan to the OPPOSITE side, not collapse onto the same offset
  const corridorLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const normal = { x: -(p2.y - p1.y) / corridorLen, y: (p2.x - p1.x) / corridorLen };
  members.forEach((e, i) => {
    // each member runs along the shared corridor, in its own direction
    const pts = e.edge.from === first.from ? route.points : [...route.points].reverse();
    const fan = fanMember(pts, route.labelPos, i, members.length, normal);
    mem.appendChild(buildEdge({ ...e, points: fan.points, labelPos: fan.labelPos }));
  });
  g.appendChild(mem);
  return g;
}

// Group same-pair edges (either direction) into bundles; edges with a
// user-chosen route and self-loops always render on their own.
function groupEdgesForRender(edges) {
  const byPair = new Map();
  const out = [];
  for (const e of edges) {
    if (e.edge.via || e.edge.route || e.edge.from === e.edge.to) { out.push({ single: e }); continue; }
    const key = [e.edge.from, e.edge.to].sort().join('→');
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(e);
  }
  for (const members of byPair.values()) {
    if (members.length >= 2) out.push({ bundle: members });
    else out.push({ single: members[0] });
  }
  return out;
}

function renderOwnerLanes(layout) {
  const group = el('g', {}, 'owner-lanes');
  if (!state.ownerLanes) return group;

  const byOwner = new Map();
  for (const n of layout.nodes) {
    const owner = String(n.node.owner || '').trim();
    if (!owner) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(n);
  }

  for (const [owner, nodes] of byOwner) {
    if (!nodes.length) continue;
    const pad = 24;
    const x1 = Math.min(...nodes.map((n) => n.x)) - pad;
    const y1 = Math.min(...nodes.map((n) => n.y)) - pad - 18;
    const x2 = Math.max(...nodes.map((n) => n.x + n.w)) + pad;
    const y2 = Math.max(...nodes.map((n) => n.y + n.h)) + pad;
    group.appendChild(el('rect', { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 8 }, 'owner-lane'));
    const label = el('text', { x: x1 + 12, y: y1 + 16 }, 'owner-lane-label');
    label.textContent = owner;
    group.appendChild(label);
  }
  return group;
}

function renderScopeContent(model, ownerId) {
  const layout = layoutScope(model, ownerId);
  const layer = el('g', {}, 'scope-content');
  const lanesG = renderOwnerLanes(layout);
  const edgesG = el('g', {}, 'edges');
  const nodesG = el('g', {}, 'nodes');
  for (const item of groupEdgesForRender(layout.edges)) {
    edgesG.appendChild(item.bundle ? buildBundle(item.bundle, layout) : buildEdge(item.single));
  }
  for (const n of layout.nodes) nodesG.appendChild(buildNode(n));
  layer.appendChild(lanesG);
  layer.appendChild(edgesG);
  layer.appendChild(nodesG);
  return { layer, layout };
}

const SCOPE_CONTEXT_GAP = 280;
const SCOPE_FRAME_PAD = 44;
const SCOPE_FRAME_TOP = 42;

function buildScopeFrame(entry, active) {
  const { node, frame } = entry;
  const group = el('g', {}, `scope-frame${active ? ' active' : ' peer'}`);
  if (!active) group.dataset.peerScope = node.id;
  group.appendChild(el('rect', {
    x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 22,
  }, 'scope-frame-shape'));
  const label = el('text', { x: frame.x + 18, y: frame.y + 27 }, 'scope-frame-label');
  label.textContent = node.label;
  group.appendChild(label);
  const count = el('text', {
    x: frame.x + frame.w - 18, y: frame.y + 27, 'text-anchor': 'end',
  }, 'scope-frame-count');
  count.textContent = `${node.stats.childCount} ${node.stats.childCount === 1 ? 'item' : 'items'}`;
  group.appendChild(count);
  if (!active) {
    const title = el('title');
    title.textContent = `Open ${node.label}`;
    group.appendChild(title);
  }
  return group;
}

function offsetRoute(route, shift, a, b) {
  if (!shift) return route;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const leftToRight = ac.x < bc.x || (ac.x === bc.x && ac.y <= bc.y);
  const dx = (leftToRight ? bc.x - ac.x : ac.x - bc.x);
  const dy = (leftToRight ? bc.y - ac.y : ac.y - bc.y);
  const length = Math.hypot(dx, dy) || 1;
  const ox = (-dy / length) * shift;
  const oy = (dx / length) * shift;
  return {
    points: route.points.map((point) => ({ x: point.x + ox, y: point.y + oy })),
    labelPos: { x: route.labelPos.x + ox, y: route.labelPos.y + oy },
  };
}

function routeScopeLink(from, to, allFrames, shift) {
  const direct = routeDirect(from, to);
  const fromCenter = from.x + from.w / 2;
  const toCenter = to.x + to.w / 2;
  const left = Math.min(fromCenter, toCenter);
  const right = Math.max(fromCenter, toCenter);
  const blockers = allFrames.filter((frame) => {
    if (frame === from || frame === to) return false;
    const center = frame.x + frame.w / 2;
    return center > left && center < right;
  });
  if (!blockers.length) return offsetRoute(direct, shift, from, to);

  const start = direct.points[0];
  const end = direct.points[direct.points.length - 1];
  const direction = end.x >= start.x ? 1 : -1;
  const y = Math.min(from.y, to.y, ...blockers.map((frame) => frame.y)) - 74 + shift;
  const firstElbow = start.x + direction * 54;
  const lastElbow = end.x - direction * 54;
  return {
    points: [
      start,
      { x: firstElbow, y: start.y },
      { x: firstElbow, y },
      { x: lastElbow, y },
      { x: lastElbow, y: end.y },
      end,
    ],
    labelPos: { x: (firstElbow + lastElbow) / 2, y },
  };
}

function renderSiblingContext(model, ownerId) {
  if (model.mode !== 'freeform' || ownerId == null) return null;
  const current = model.byId.get(ownerId);
  if (!current) return null;
  const parentScope = current.ownerId == null
    ? model.root
    : model.byId.get(current.ownerId)?.children;
  if (!parentScope) return null;

  const containerIds = new Set(parentScope.nodes.filter((node) => node.children).map((node) => node.id));
  const connected = new Set([ownerId]);
  const pending = [ownerId];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    for (const edge of parentScope.edges) {
      const peerId = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (!peerId || !containerIds.has(peerId) || connected.has(peerId)) continue;
      connected.add(peerId);
      pending.push(peerId);
    }
  }
  const parentLayout = layoutScope(model, current.ownerId);
  const ordered = parentLayout.nodes
    .filter((layoutNode) => connected.has(layoutNode.id) && layoutNode.node.children)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (ordered.length < 2) return null;

  const entries = ordered.map((layoutNode) => ({
    node: layoutNode.node,
    layout: layoutScope(model, layoutNode.id),
  }));
  const maxHeight = Math.max(...entries.map((entry) => entry.layout.h), 1);
  let cursor = 0;
  for (const entry of entries) {
    entry.gx = cursor - entry.layout.x;
    entry.gy = (maxHeight - entry.layout.h) / 2 - entry.layout.y;
    cursor += entry.layout.w + SCOPE_CONTEXT_GAP;
  }
  const activeOrigin = entries.find((entry) => entry.node.id === ownerId);
  if (!activeOrigin) return null;

  const frames = new Map();
  for (const entry of entries) {
    entry.dx = entry.gx - activeOrigin.gx;
    entry.dy = entry.gy - activeOrigin.gy;
    entry.frame = {
      x: entry.layout.x + entry.dx - SCOPE_FRAME_PAD,
      y: entry.layout.y + entry.dy - SCOPE_FRAME_TOP,
      w: entry.layout.w + SCOPE_FRAME_PAD * 2,
      h: entry.layout.h + SCOPE_FRAME_TOP + SCOPE_FRAME_PAD,
      node: { type: 'item' },
    };
    frames.set(entry.node.id, entry.frame);
  }
  const frameList = [...frames.values()];

  const context = el('g', {}, 'scope-context');
  const links = el('g', {}, 'scope-context-links');
  const visibleIds = new Set(entries.map((entry) => entry.node.id));
  const visibleEdges = parentScope.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const totals = new Map();
  for (const edge of visibleEdges) {
    const key = [edge.from, edge.to].sort().join('\u0000');
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map();
  for (const edge of visibleEdges) {
    const key = [edge.from, edge.to].sort().join('\u0000');
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const shift = (index - (totals.get(key) - 1) / 2) * 50;
    const from = frames.get(edge.from);
    const to = frames.get(edge.to);
    const route = routeScopeLink(from, to, frameList, shift);
    const link = buildEdge({ edge, index: -1, ...route });
    link.removeAttribute('data-index');
    link.classList.add('scope-link');
    links.appendChild(link);
  }
  context.appendChild(links);

  const identityLayer = el('g', {}, 'identity-links');
  const locations = new Map();
  for (const entry of entries) {
    for (const layoutNode of entry.layout.nodes) {
      if (!layoutNode.node.isPlacement) continue;
      if (!locations.has(layoutNode.id)) locations.set(layoutNode.id, []);
      locations.get(layoutNode.id).push({
        x: layoutNode.x + entry.dx + layoutNode.w / 2,
        y: layoutNode.y + entry.dy + layoutNode.h / 2,
      });
    }
  }
  for (const [elementId, points] of locations) {
    if (points.length < 2) continue;
    points.sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1];
      const to = points[i];
      const bend = (from.x + to.x) / 2;
      identityLayer.appendChild(el('path', {
        d: `M${from.x},${from.y} C${bend},${from.y} ${bend},${to.y} ${to.x},${to.y}`,
        'data-element-id': elementId,
      }, 'identity-link'));
    }
  }
  context.appendChild(identityLayer);

  const frameLayer = el('g', {}, 'scope-frames');
  for (const entry of entries) frameLayer.appendChild(buildScopeFrame(entry, entry.node.id === ownerId));
  context.appendChild(frameLayer);

  const peers = el('g', {}, 'peer-scopes');
  for (const entry of entries) {
    if (entry.node.id === ownerId) continue;
    const { layer } = renderScopeContent(model, entry.node.id);
    layer.setAttribute('transform', `translate(${entry.dx},${entry.dy})`);
    layer.classList.add('peer-scope');
    layer.dataset.peerScope = entry.node.id;
    for (const edge of layer.querySelectorAll('.edge')) edge.removeAttribute('data-index');
    peers.appendChild(layer);
  }
  context.appendChild(peers);
  const minimapNodes = entries.flatMap((entry) => entry.layout.nodes.map((node) => ({
    ...node,
    x: node.x + entry.dx,
    y: node.y + entry.dy,
  })));
  return { layer: context, minimapNodes };
}

function renderScope(model, ownerId) {
  const { layer: content, layout } = renderScopeContent(model, ownerId);
  const layer = el('g', {}, 'scope-layer');
  const siblingContext = renderSiblingContext(model, ownerId);
  if (siblingContext) {
    layer.appendChild(siblingContext.layer);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of siblingContext.minimapNodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    }
    layout.minimapLayout = {
      nodes: siblingContext.minimapNodes,
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
    };
  }
  content.classList.add('active-scope');
  layer.appendChild(content);
  return { layer, layout };
}

// ── scope management + transitions ───────────────────────────────────
export function showScope(model, ownerId, { transition = null, focusId = null } = {}) {
  stopPanMotion({ snap: true });
  if (transitioning) { animToken++; finishTransition(); }
  if (transition === 'dive' && currentLayout) return diveTo(model, ownerId, focusId);
  if (transition === 'rise' && currentLayout) return riseTo(model, ownerId);

  if (!camerasResetPending && state.scopeId !== undefined && currentLayout) {
    scopeCameras.set(currentLayout.ownerId ?? null, { ...camera });
  }
  camerasResetPending = false;
  const { layer, layout } = renderScope(model, ownerId);
  layersG.replaceChildren(layer);
  currentLayer = layer;
  currentLayout = layout;
  renderMinimapNodes(layout);
  const saved = scopeCameras.get(ownerId ?? null);
  if (focusId) {
    setCamera(fitCamera(layoutBounds(layout)));
    focusOn(focusId, 0);
  } else if (saved) {
    setCamera(saved);
  } else {
    setCamera(scopeEntryCamera(model, ownerId, layout));
  }
  return Promise.resolve(true);
}

let pendingFinish = null;
function finishTransition() {
  if (pendingFinish) { const f = pendingFinish; pendingFinish = null; f(); }
  transitioning = false;
}

function setScopeContextVisible(layer, visible) {
  const context = layer?.querySelector('.scope-context');
  if (context) context.style.display = visible ? '' : 'none';
}

async function diveTo(model, containerId, focusId) {
  stopPanMotion({ snap: true });
  const parentLayout = currentLayout;
  const ln = parentLayout.nodes.find((n) => n.id === containerId);
  if (!ln || !ln.mini) return showScope(model, containerId, { focusId });

  scopeCameras.set(parentLayout.ownerId ?? null, { ...camera });
  transitioning = true;
  const T = miniTransform(ln);
  const { layer: newLayer, layout: childLayout } = renderScope(model, containerId);
  setScopeContextVisible(newLayer, false);
  newLayer.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
  newLayer.style.opacity = 0;
  const oldLayer = currentLayer;
  oldLayer.style.pointerEvents = 'none'; // the fading scope must not eat clicks
  layersG.appendChild(newLayer);

  const cb = layoutBounds(childLayout);
  const worldRect = { x: T.x + cb.x * T.k, y: T.y + cb.y * T.k, w: cb.w * T.k, h: cb.h * T.k };
  const camTarget = fitCamera(worldRect, 60, Infinity);
  const from = { ...camera };

  const myFinish = () => {
    oldLayer.remove();
    camera = { k: camera.k * T.k, x: camera.x + camera.k * T.x, y: camera.y + camera.k * T.y };
    newLayer.removeAttribute('transform');
    newLayer.style.opacity = 1;
    setScopeContextVisible(newLayer, true);
    currentLayer = newLayer;
    currentLayout = childLayout;
    renderMinimapNodes(childLayout);
    applyCamera();
  };
  pendingFinish = myFinish;

  await animate(500, (e, t) => {
    const cameraEase = rubberEase(t);
    camera = {
      x: from.x + (camTarget.x - from.x) * cameraEase,
      y: from.y + (camTarget.y - from.y) * cameraEase,
      k: from.k + (camTarget.k - from.k) * cameraEase,
    };
    applyCamera();
    newLayer.style.opacity = Math.min(1, e * 1.5);
    oldLayer.style.opacity = Math.max(0, 1 - e * 1.15);
  });
  // Finish OUR swap unless a newer scope change already consumed it. A mere
  // camera animation (fit, centerOn, ensureVisible) interrupting us must not
  // leave the layers half-swapped — snap, then settle onto the new scope.
  if (pendingFinish === myFinish) {
    finishTransition();
    await animateCamera(scopeEntryCamera(model, containerId, childLayout), 300);
  }
  return true;
}

async function riseTo(model, parentOwnerId) {
  stopPanMotion({ snap: true });
  const childOwnerId = currentLayout.ownerId;
  const { layer: parentLayer, layout: parentLayout } = renderScope(model, parentOwnerId);
  const ln = parentLayout.nodes.find((n) => n.id === childOwnerId);
  if (!ln || !ln.mini) return showScope(model, parentOwnerId, { focusId: childOwnerId });

  transitioning = true;
  const T = miniTransform(ln);
  const childLayer = currentLayer;
  setScopeContextVisible(childLayer, false);
  setScopeContextVisible(parentLayer, false);
  childLayer.style.pointerEvents = 'none'; // the fading scope must not eat clicks
  childLayer.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
  camera = { k: camera.k / T.k, x: camera.x - (camera.k / T.k) * T.x, y: camera.y - (camera.k / T.k) * T.y };
  applyCamera();

  parentLayer.style.opacity = 0;
  layersG.insertBefore(parentLayer, childLayer);

  const saved = scopeCameras.get(parentOwnerId ?? null);
  const camTarget = saved ?? fitCamera(layoutBounds(parentLayout));
  const from = { ...camera };

  const myFinish = () => {
    childLayer.remove();
    parentLayer.style.opacity = 1; // an interrupt may snap us here mid-fade
    setScopeContextVisible(parentLayer, true);
    currentLayer = parentLayer;
    currentLayout = parentLayout;
    renderMinimapNodes(parentLayout);
    camera = { ...camTarget };
    applyCamera();
  };
  pendingFinish = myFinish;

  await animate(500, (e, t) => {
    const cameraEase = rubberEase(t);
    camera = {
      x: from.x + (camTarget.x - from.x) * cameraEase,
      y: from.y + (camTarget.y - from.y) * cameraEase,
      k: from.k + (camTarget.k - from.k) * cameraEase,
    };
    applyCamera();
    parentLayer.style.opacity = Math.min(1, e * 1.3);
    childLayer.style.opacity = Math.max(0, 1 - e * 1.3);
  });
  if (pendingFinish === myFinish) {
    animToken++;
    finishTransition();
  }
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

export function setOwnerLanes(enabled) {
  state.ownerLanes = !!enabled;
  if (state.model && currentLayout) refreshScope(state.model);
}

export function centerOn(nodeId, ms = 420) {
  const n = currentLayout?.nodes.find((x) => x.id === nodeId);
  if (!n) return Promise.resolve(false);
  const k = Math.min(1.2, Math.max(0.65, camera.k));
  const usable = usableViewport();
  const target = {
    k,
    x: usable.width / 2 - (n.x + n.w / 2) * k,
    y: usable.height / 2 - (n.y + n.h / 2) * k,
  };
  return ms ? animateCamera(target, ms) : Promise.resolve(setCamera(target) ?? true);
}

export const getLayout = () => currentLayout;

// pan the node into view if it's off-screen or hidden by a panel resize
export function ensureVisible(nodeId, margin = 30) {
  const instances = state.model?.mode === 'freeform' ? visibleInstances(nodeId) : [];
  if (instances.length > 1) {
    const usable = usableViewport();
    return animateCamera(fitCamera(boundsAround(instances), usable.width <= 700 ? 120 : Math.max(80, margin), 1.05, usable), 320);
  }
  const n = currentLayout?.nodes.find((x) => x.id === nodeId);
  if (!n) return;
  const x1 = camera.x + n.x * camera.k, y1 = camera.y + n.y * camera.k;
  const x2 = x1 + n.w * camera.k, y2 = y1 + n.h * camera.k;
  const usable = usableViewport();
  if (x1 < margin || y1 < margin || x2 > usable.width - margin || y2 > usable.height - margin) centerOn(nodeId, 320);
}

// ── selection visuals (no re-render) ─────────────────────────────────
export function paintSelection() {
  if (!currentLayer) return;
  const selected = state.selectedId;
  const probeNodes = new Set(state.probePath?.nodeIds ?? []);
  const probeEdges = new Set(state.probePath?.edgeIndexes ?? []);
  const adjacent = new Set(selected ? [selected] : []);
  if (selected) {
    for (const e of currentLayout.edges) {
      if (e.edge.from === selected || e.edge.to === selected) {
        adjacent.add(e.edge.from);
        adjacent.add(e.edge.to);
      }
    }
  }
  for (const path of currentLayer.querySelectorAll('.identity-link')) {
    path.classList.toggle('active', !!selected && path.dataset.elementId === selected);
  }
  for (const g of currentLayer.querySelectorAll('.node')) {
    g.classList.toggle('selected', g.dataset.id === state.selectedId);
    g.classList.toggle('connect-target', !!state.connectFrom && g.dataset.id !== state.connectFrom);
    g.classList.toggle('probe-node', probeNodes.has(g.dataset.id));
    g.classList.toggle('probe-dimmed', probeNodes.size > 0 && !probeNodes.has(g.dataset.id));
    g.classList.toggle('focus-dimmed', probeNodes.size === 0 && !!selected && !adjacent.has(g.dataset.id));
  }
  for (const g of currentLayer.querySelectorAll('.edge')) {
    g.classList.toggle('selected', state.selectedEdge != null && Number(g.dataset.index) === state.selectedEdge.index);
    const e = currentLayout.edges.find((x) => x.index === Number(g.dataset.index));
    const isProbeEdge = probeEdges.has(Number(g.dataset.index));
    g.classList.toggle('probe-edge', isProbeEdge);
    g.classList.toggle('probe-dimmed', probeNodes.size > 0 && !isProbeEdge);
    g.classList.toggle('focus-dimmed', probeNodes.size === 0 && !!selected && e?.edge.from !== selected && e?.edge.to !== selected);
  }
  svg.classList.toggle('connecting', !!state.connectFrom);
}

export function setProbePath(path = null) {
  state.probePath = path;
  paintSelection();
}

// Where a style change should seed its via: the edge's current label
// position in scope coordinates — the visual midpoint of its current route.
export function edgeRouteSeed(index) {
  const e = currentLayout?.edges.find((x) => x.index === index);
  return e ? { x: Math.round(e.labelPos.x), y: Math.round(e.labelPos.y) } : null;
}

export function paintScenario(nodeId = null) {
  if (!currentLayer) return;
  for (const g of currentLayer.querySelectorAll('.node')) {
    g.classList.toggle('scenario-node', !!nodeId && g.dataset.id === nodeId);
  }
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

// While a node is being dragged, every edge touching it re-routes live as a
// direct line; the definitive layout is recomputed on commit.
function updateEdgesFor(ln) {
  if (!currentLayout || !currentLayer) return;
  const byId = new Map(currentLayout.nodes.map((n) => [n.id, n]));
  for (const e of currentLayout.edges) {
    if (e.edge.from !== ln.id && e.edge.to !== ln.id) continue;
    if (e.edge.via || e.edge.route) {
      const a = byId.get(e.edge.from), b = byId.get(e.edge.to);
      const via = e.edge.via ?? routeDirect(a, b).labelPos;
      Object.assign(e, routeStyled(a, b, via, e.edge.route ?? 'curved'));
    } else {
      Object.assign(e, routeDirect(byId.get(e.edge.from), byId.get(e.edge.to)));
    }
    const old = currentLayer.querySelector(`.edge[data-index="${e.index}"]`);
    if (!old) continue;
    old.closest('.bundle')?.classList.add('open'); // reveal the cables while their node moves
    const fresh = buildEdge(e);
    fresh.setAttribute('class', old.getAttribute('class'));
    old.replaceWith(fresh);
  }
}

function wirePointer() {
  let down = null;
  let moved = false;
  let nodeDrag = null; // { ln, el, ox, oy, active, dropInto, moveOut } while a node is grabbed
  let connectDrag = null; // { fromId, fromLn, ghost, targetId, active } while dragging from a port
  let edgeDrag = null; // { le, el, active, via } while an edge is being re-routed

  // live preview while an edge is being dragged: bend the route through the
  // pointer in the edge's own style — commit writes the via
  const previewEdgeRoute = (drag, w) => {
    const byId = new Map(currentLayout.nodes.map((n) => [n.id, n]));
    const a = byId.get(drag.le.edge.from), b = byId.get(drag.le.edge.to);
    if (!a || !b) return;
    const style = drag.le.edge.route === 'straight' ? 'curved' : (drag.le.edge.route ?? 'curved');
    const route = routeStyled(a, b, w, style);
    const smooth = route.smooth ? smoothEdgePath(route.points) : null;
    const d = smooth ? smooth.d : edgePath(route.points);
    drag.el.querySelector('path.hit')?.setAttribute('d', d);
    drag.el.querySelector('path.line')?.setAttribute('d', d);
    const arrow = drag.el.querySelector('.arrow');
    if (arrow) {
      const pts = route.points;
      const p2 = pts[pts.length - 1];
      const ang = smooth && smooth.endAngle != null
        ? smooth.endAngle
        : (Math.atan2(p2.y - pts[pts.length - 2].y, p2.x - pts[pts.length - 2].x) * 180) / Math.PI;
      arrow.setAttribute('transform', `translate(${p2.x},${p2.y}) rotate(${ang})`);
    }
    const labelBg = drag.el.querySelector('.edge-label-bg');
    const label = drag.el.querySelector('.edge-label');
    if (labelBg && label) {
      const tw = Number(labelBg.getAttribute('width'));
      labelBg.setAttribute('x', route.labelPos.x - tw / 2);
      labelBg.setAttribute('y', route.labelPos.y - 10);
      label.setAttribute('x', route.labelPos.x);
      label.setAttribute('y', route.labelPos.y + 3.8);
    }
    drag.via = w;
  };

  // an interrupted drag mutated the cached layout — rebuild it from the model
  const revertNodeDrag = () => {
    const wasActive = nodeDrag?.active;
    nodeDrag?.el?.classList.remove('dragging');
    nodeDrag = null;
    if (wasActive && state.model) {
      invalidateLayouts();
      refreshScope(state.model);
    }
  };

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    stopPanMotion({ snap: true });
    // remember the real pressed element: with pointer capture active the
    // browser retargets pointerup/click to the <svg>, so hit-testing must
    // use this, never ev.target of the up event.
    down = { px: ev.clientX, py: ev.clientY, cam: { ...camera }, target: ev.target, pointerId: ev.pointerId };
    moved = false;
    // grabbing a port draws an edge; grabbing a node moves the node;
    // grabbing the background pans
    nodeDrag = null;
    connectDrag = null;
    edgeDrag = null;
    if (!state.presenting && !state.standalone && !state.connectFrom && !transitioning) {
      const portEl = ev.target.closest?.('.port');
      if (portEl && currentLayer?.contains(portEl)) {
        const fromLn = currentLayout?.nodes.find((x) => x.id === portEl.dataset.port);
        if (fromLn) {
          connectDrag = { fromId: fromLn.id, fromLn, ghost: null, targetId: null, active: false };
          return;
        }
      }
      const nodeEl = ev.target.closest?.('.node');
      if (nodeEl && currentLayer?.contains(nodeEl)) {
        const ln = currentLayout?.nodes.find((x) => x.id === nodeEl.dataset.id);
        if (ln) nodeDrag = { ln, el: nodeEl, ox: ln.x, oy: ln.y, active: false, dropInto: null, moveOut: false };
      } else if (!ev.target.closest?.('[data-unroute]')) {
        // grabbing an edge line re-routes it; a plain click still selects
        const edgeEl = ev.target.closest?.('.edge');
        if (edgeEl && currentLayer?.contains(edgeEl)) {
          const le = currentLayout?.edges.find((x) => x.index === Number(edgeEl.dataset.index));
          if (le) edgeDrag = { le, el: edgeEl, active: false, via: null };
        }
      }
    }
  });
  const clearDrag = () => {
    svg.classList.remove('panning');
    svg.classList.remove('dragging-node');
    svg.classList.remove('connect-dragging');
    svg.classList.remove('edge-dragging');
    setDropHighlight(null);
    hideMoveOutBar();
    connectDrag?.ghost?.remove();
    connectDrag = null;
    // an interrupted edge drag only mutated DOM, not the cached layout —
    // a straight re-render restores the original route
    const revertEdgeDrag = edgeDrag?.active;
    edgeDrag = null;
    if (revertEdgeDrag && state.model) refreshScope(state.model);
    revertNodeDrag();
    down = null; moved = false;
  };
  // releases outside the svg (uncaptured non-drag presses) must not leave a
  // stale drag state that pans on buttonless hover — but only OUR pointer's
  // primary-button release counts, or chords/multi-touch swallow clicks
  window.addEventListener('pointerup', (ev) => {
    if (down && !moved && ev.pointerId === down.pointerId && ev.button === 0) clearDrag();
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!down) return;
    if ((ev.buttons & 1) === 0) { clearDrag(); return; }
    const dx = ev.clientX - down.px, dy = ev.clientY - down.py;
    if (!moved && Math.hypot(dx, dy) > 4) {
      moved = true;
      if (connectDrag) {
        connectDrag.active = true;
        svg.classList.add('connect-dragging');
        connectDrag.ghost = el('g', {}, 'connect-ghost');
        connectDrag.ghost.appendChild(el('path', {}, 'cg-line'));
        connectDrag.ghost.appendChild(el('polygon', { points: '0,-4 8,0 0,4' }, 'cg-arrow'));
        currentLayer?.appendChild(connectDrag.ghost);
      } else if (nodeDrag) {
        nodeDrag.active = true;
        svg.classList.add('dragging-node');
        nodeDrag.el.classList.add('dragging'); // pointer-events off → hit-test sees beneath
        nodeDrag.el.parentNode?.appendChild(nodeDrag.el); // dragged node on top
        if (state.scopeId != null) showMoveOutBar();
      } else if (edgeDrag) {
        edgeDrag.active = true;
        svg.classList.add('edge-dragging');
        edgeDrag.el.closest('.bundle')?.classList.add('open'); // keep the fan-out still while dragging
      } else {
        svg.classList.add('panning');
      }
      // capture only once a drag actually starts, so plain clicks and
      // dblclicks keep their natural targets
      try { svg.setPointerCapture(down.pointerId); } catch { /* stale pointer */ }
    }
    if (moved) {
      if (connectDrag?.active) {
        const w = worldAt(ev.clientX, ev.clientY);
        const phantom = { x: w.x - 0.5, y: w.y - 0.5, w: 1, h: 1, node: {} };
        const route = routeDirect(connectDrag.fromLn, phantom);
        const pts = route.points;
        connectDrag.ghost.querySelector('.cg-line').setAttribute('d', edgePath(pts));
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        connectDrag.ghost.querySelector('.cg-arrow').setAttribute('transform', `translate(${b.x},${b.y}) rotate(${ang})`);
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.node');
        const tid = under && currentLayer?.contains(under) && under.dataset.id !== connectDrag.fromId
          ? under.dataset.id : null;
        connectDrag.targetId = tid;
        setDropHighlight(tid);
      } else if (edgeDrag?.active) {
        previewEdgeRoute(edgeDrag, worldAt(ev.clientX, ev.clientY));
      } else if (nodeDrag?.active) {
        nodeDrag.ln.x = nodeDrag.ox + dx / camera.k;
        nodeDrag.ln.y = nodeDrag.oy + dy / camera.k;
        nodeDrag.el.setAttribute('transform', `translate(${nodeDrag.ln.x},${nodeDrag.ln.y})`);
        updateEdgesFor(nodeDrag.ln);
        // re-nest targeting: hovering a container (not our own subtree) arms a drop
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.node');
        let tid = null;
        if (under && currentLayer?.contains(under) && under !== nodeDrag.el) {
          const cand = state.model?.byId.get(under.dataset.id);
          if (cand?.children && !ancestryOf(state.model, cand.id).includes(nodeDrag.ln.id)) tid = cand.id;
        }
        nodeDrag.dropInto = tid;
        nodeDrag.moveOut = false;
        if (moveOutBar && !moveOutBar.hidden) {
          const br = moveOutBar.getBoundingClientRect();
          nodeDrag.moveOut = ev.clientX >= br.left && ev.clientX <= br.right
            && ev.clientY >= br.top && ev.clientY <= br.bottom;
          moveOutBar.classList.toggle('hot', nodeDrag.moveOut);
          if (nodeDrag.moveOut) nodeDrag.dropInto = null;
        }
        setDropHighlight(nodeDrag.dropInto);
      } else {
        springPanTo({ ...camera, x: down.cam.x + dx, y: down.cam.y + dy });
      }
    }
  });
  svg.addEventListener('pointerup', (ev) => {
    if (ev.button !== 0) return; // a chord's secondary release must not end the press
    svg.classList.remove('panning');
    svg.classList.remove('dragging-node');
    svg.classList.remove('connect-dragging');
    svg.classList.remove('edge-dragging');
    const wasDrag = moved;
    const target = down?.target;
    const finishedNodeDrag = nodeDrag?.active ? nodeDrag : null;
    const finishedConnect = connectDrag?.active ? connectDrag : null;
    const finishedEdgeDrag = edgeDrag?.active ? edgeDrag : null;
    nodeDrag = null; // consumed — clearDrag/revert must not undo a completed drop
    connectDrag = null;
    edgeDrag = null;
    if (down && svg.hasPointerCapture?.(down.pointerId)) {
      try { svg.releasePointerCapture(down.pointerId); } catch { /* already released */ }
    }
    down = null; moved = false;
    if (wasDrag || !target) {
      if (finishedEdgeDrag) {
        if (finishedEdgeDrag.via) {
          // dragging a straight edge bends it — the via only makes sense curved
          const style = finishedEdgeDrag.le.edge.route === 'straight' ? 'curved' : null;
          bus.emit('edge-routed', finishedEdgeDrag.le.index, finishedEdgeDrag.via, style);
        }
        return;
      }
      if (finishedConnect) {
        finishedConnect.ghost?.remove();
        setDropHighlight(null);
        if (finishedConnect.targetId) {
          bus.emit('connect-drag', finishedConnect.fromId, finishedConnect.targetId);
        } else {
          bus.emit('toast', 'Connect cancelled'); // same feedback as click-connect
        }
        return;
      }
      if (finishedNodeDrag) {
        finishedNodeDrag.el.classList.remove('dragging');
        setDropHighlight(null);
        hideMoveOutBar();
        const ln = finishedNodeDrag.ln;
        if (finishedNodeDrag.moveOut) {
          bus.emit('node-move-out', ln.id);
          return;
        }
        if (finishedNodeDrag.dropInto) {
          bus.emit('node-drop-into', ln.id, finishedNodeDrag.dropInto);
          return;
        }
        bus.emit('node-moved', ln.id, {
          x: Math.round(ln.x + ln.w / 2),
          y: Math.round(ln.y + ln.h / 2),
        });
      }
      return;
    }

    const peer = target.closest?.('[data-peer-scope]');
    if (peer) {
      const peerNode = target.closest?.('.node');
      bus.emit('peer-scope-request', peer.dataset.peerScope, peerNode?.dataset.id ?? null);
      return;
    }
    const unpin = target.closest?.('[data-unpin]');
    if (unpin) { bus.emit('unpin-request', unpin.dataset.unpin); return; }
    const unroute = target.closest?.('[data-unroute]');
    if (unroute) { bus.emit('unroute-request', Number(unroute.dataset.unroute)); return; }
    const dive = target.closest?.('[data-dive]');
    if (dive) { bus.emit('dive-request', dive.dataset.dive); return; }
    const nodeEl = target.closest?.('.node');
    if (nodeEl) { bus.emit('node-click', nodeEl.dataset.id, ev); return; }
    const edgeEl = target.closest?.('.edge');
    if (edgeEl) { bus.emit('edge-click', Number(edgeEl.dataset.index)); return; }
    // tap on a cable sheath toggles the fan-out (touch has no hover)
    const bundleEl = target.closest?.('.bundle');
    if (bundleEl) { bundleEl.classList.toggle('open'); return; }
    bus.emit('bg-click');
  });
  svg.addEventListener('pointercancel', clearDrag);

  // Escape during a node/connect drag cancels it (and must not also rise a scope)
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || (!nodeDrag?.active && !connectDrag?.active && !edgeDrag?.active)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (down && svg.hasPointerCapture?.(down.pointerId)) {
      try { svg.releasePointerCapture(down.pointerId); } catch { /* already released */ }
    }
    clearDrag();
  }, true);

  svg.addEventListener('dblclick', (ev) => {
    const peer = ev.target.closest?.('[data-peer-scope]');
    if (peer) {
      const peerNode = ev.target.closest?.('.node');
      bus.emit('peer-scope-request', peer.dataset.peerScope, peerNode?.dataset.id ?? null);
      ev.preventDefault();
      return;
    }
    const nodeEl = ev.target.closest?.('.node');
    if (nodeEl) {
      bus.emit('node-dblclick', nodeEl.dataset.id);
    } else if (state.presenting || state.standalone || state.connectFrom || !state.model) {
      fit();
    } else {
      // double-click on empty canvas drops a new node right there
      bus.emit('bg-dblclick', worldAt(ev.clientX, ev.clientY));
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
      const base = panTarget ?? camera;
      springPanTo({ ...base, x: base.x - ev.deltaX, y: base.y - ev.deltaY });
    }
  }, { passive: false });
}

// ── minimap ──────────────────────────────────────────────────────────
function renderMinimapNodes(layout) {
  if (!mmSvg) return;
  const box = mmSvg.getBoundingClientRect();
  const W = box.width || 176, H = box.height || 120;
  mmNodesG.replaceChildren();
  const displayLayout = layout?.minimapLayout ?? layout;
  if (!displayLayout || !displayLayout.w) { mmView.setAttribute('width', 0); return; }
  mmScale = Math.min((W - mmPad * 2) / displayLayout.w, (H - mmPad * 2) / displayLayout.h);
  const lb = layoutBounds(displayLayout);
  mmOff = {
    x: (W - displayLayout.w * mmScale) / 2 - lb.x * mmScale,
    y: (H - displayLayout.h * mmScale) / 2 - lb.y * mmScale,
  };
  for (const n of displayLayout.nodes) {
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
    springPanTo({ ...camera, x: vw / 2 - wx * camera.k, y: vh / 2 - wy * camera.k });
  };
  mmSvg.addEventListener('pointerdown', (ev) => { dragging = true; mmSvg.setPointerCapture(ev.pointerId); moveTo(ev); });
  mmSvg.addEventListener('pointermove', (ev) => { if (dragging) moveTo(ev); });
  mmSvg.addEventListener('pointerup', () => { dragging = false; });
}
