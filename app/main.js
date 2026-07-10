// Boot + global wiring: theme, canvas events, keyboard, toolbar, SSE.
import { state, bus } from './state.js';
import { api } from './api.js';
import * as ctrl from './controller.js';
import * as canvas from './canvas.js';
import * as ui from './ui.js';
import * as edit from './edit.js';
import { togglePresent, exitPresent } from './present.js';

// ── theme ────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('opsmap-theme');
  const dark = saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('opsmap-theme', next);
}

// ── canvas event wiring ──────────────────────────────────────────────
function wireCanvasEvents() {
  bus.on('node-click', (id) => {
    if (state.presenting) return;
    if (state.connectFrom) {
      const from = state.connectFrom;
      state.connectFrom = null;
      canvas.paintSelection();
      if (from === id) { ui.toast('Connect cancelled'); return; }
      ctrl.commit(() => edit.addEdge(state.scopeId, { from, to: id }))
        .then((ok) => {
          if (!ok) return;
          const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
          ctrl.selectEdge(scope.edges.length - 1);
          ui.toast('Edge added — set its label in the panel');
        });
      return;
    }
    ctrl.selectNode(id);
  });

  bus.on('node-dblclick', (id) => {
    if (state.presenting) return;
    const node = state.model?.byId.get(id);
    if (node?.children) ctrl.diveInto(id);
    else ctrl.selectNode(id);
  });

  bus.on('dive-request', (id) => { if (!state.presenting) ctrl.diveInto(id); });

  bus.on('edge-click', (index) => {
    if (state.presenting || state.connectFrom) return;
    ctrl.selectEdge(index);
  });

  bus.on('bg-click', () => {
    if (state.presenting) return;
    if (state.connectFrom) {
      state.connectFrom = null;
      canvas.paintSelection();
      ui.toast('Connect cancelled');
      return;
    }
    ctrl.clearSelection();
  });
}

// ── keyboard ─────────────────────────────────────────────────────────
function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
function dialogOpen() {
  return !!document.querySelector('.dialog-backdrop') || !document.getElementById('search-overlay').hidden;
}

function spatialMove(dir) {
  const layout = canvas.getLayout();
  if (!layout?.nodes.length) return;
  const vec = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[dir];
  const cur = layout.nodes.find((n) => n.id === state.selectedId);
  if (!cur) {
    const first = [...layout.nodes].sort((a, b) => (a.x + a.y * 3) - (b.x + b.y * 3))[0];
    ctrl.selectNode(first.id);
    canvas.centerOn(first.id);
    return;
  }
  const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
  let best = null, bestScore = Infinity;
  for (const n of layout.nodes) {
    if (n.id === cur.id) continue;
    const dx = n.x + n.w / 2 - cx, dy = n.y + n.h / 2 - cy;
    const along = dx * vec[0] + dy * vec[1];
    if (along <= 8) continue; // must be in that direction
    const ortho = Math.abs(dx * vec[1]) + Math.abs(dy * vec[0]);
    const score = along + ortho * 2.2;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  if (best) {
    ctrl.selectNode(best.id);
    canvas.centerOn(best.id);
  }
}

function wireKeyboard() {
  document.addEventListener('keydown', (ev) => {
    const meta = ev.metaKey || ev.ctrlKey;

    if (meta && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      ui.openSearch();
      return;
    }
    if (isTyping() || dialogOpen() || state.presenting) return;

    if (meta && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ctrl.undo(); return; }
    if (meta && ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ctrl.redo(); return; }
    if (meta) return;

    switch (ev.key) {
      case 'Escape':
        if (state.connectFrom) { state.connectFrom = null; canvas.paintSelection(); ui.toast('Connect cancelled'); }
        else if (state.selectedId || state.selectedEdge != null) { ctrl.clearSelection(); ui.hideDetail(); }
        else if (!document.getElementById('templates-panel').hidden) ui.toggleTemplates(false);
        else if (state.scopeId != null) ctrl.riseUp();
        break;
      case 'Backspace':
        if (state.scopeId != null) { ev.preventDefault(); ctrl.riseUp(); }
        break;
      case 'Enter':
        if (state.selectedId && state.model.byId.get(state.selectedId)?.children) ctrl.diveInto(state.selectedId);
        break;
      case 'ArrowRight': case 'ArrowLeft': case 'ArrowUp': case 'ArrowDown':
        ev.preventDefault();
        spatialMove(ev.key);
        break;
      case 'n': case 'N':
        if (!state.standalone && state.model) ui.addNodeDialog(state.scopeId);
        break;
      case 'p': case 'P':
        togglePresent();
        break;
      case 't': case 'T':
        if (!state.standalone) ui.toggleTemplates();
        break;
      case '+': case '=':
        canvas.zoomBy(1.25);
        break;
      case '-': case '_':
        canvas.zoomBy(0.8);
        break;
      case '0':
        canvas.fit();
        break;
      case '?':
        ui.helpDialog();
        break;
      default:
        break;
    }
  });
}

// ── toolbar ──────────────────────────────────────────────────────────
function wireToolbar() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
  on('btn-search', ui.openSearch);
  on('btn-templates', () => ui.toggleTemplates());
  on('btn-add-node', () => ui.addNodeDialog(state.scopeId));
  on('btn-present', togglePresent);
  on('btn-theme', toggleTheme);
  on('btn-help', ui.helpDialog);
  on('btn-export', () => {
    if (state.mapId) window.location.href = `/export/${encodeURIComponent(state.mapId)}.html`;
  });
  on('zoom-in', () => canvas.zoomBy(1.3));
  on('zoom-out', () => canvas.zoomBy(0.77));
  on('zoom-fit', () => canvas.fit());
  document.querySelector('.logo')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (state.presenting) exitPresent();
    if (state.model) ctrl.gotoScope(null);
  });
}

// ── boot ─────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  canvas.initCanvas(document.getElementById('canvas'), document.querySelector('#minimap svg'));
  ui.initUI();
  wireCanvasEvents();
  wireKeyboard();
  wireToolbar();
  ctrl.wireHistory();

  try {
    await ctrl.loadMapList();
  } catch (e) {
    ui.toast('Could not reach the Opsmap server: ' + e.message, true);
    return;
  }

  const route = ctrl.readHash();
  let mapId = route.mapId && state.maps.some((m) => m.id === route.mapId) ? route.mapId : null;
  if (!mapId) mapId = state.maps.some((m) => m.id === 'lending') ? 'lending' : state.maps[0]?.id;

  if (mapId) {
    try {
      await ctrl.openMap(mapId, route.mapId === mapId ? route : {});
    } catch (e) {
      ui.toast(`Couldn't open map "${mapId}": ${e.message}`, true);
    }
  } else {
    bus.emit('view-changed');
  }

  ctrl.loadTemplates();
  api.subscribe((event) => {
    if (event.type === 'maps-changed') ctrl.handleRemoteChange(event.ids ?? []);
    if (event.type === 'templates-changed') ctrl.loadTemplates();
  });
}

boot();
