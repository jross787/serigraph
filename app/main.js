// Boot + global wiring: theme, canvas events, keyboard, toolbar, SSE.
import { state, bus } from './state.js';
import { api } from './api.js';
import * as ctrl from './controller.js';
import * as canvas from './canvas.js';
import * as ui from './ui.js';
import * as edit from './edit.js';
import * as workbench from './workbench.js';
import * as productWorkspace from './product-workspace.js';
import { togglePresent, exitPresent } from './present.js';
import { flowShortcut } from './flow.js';

// ── theme ────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('opsmap-theme');
  const dark = saved ? saved === 'dark' : false;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('opsmap-theme', next);
}

// ── canvas event wiring ──────────────────────────────────────────────
function wireCanvasEvents() {
  let pendingContainerClick = 0;
  const cancelPendingContainerClick = () => {
    clearTimeout(pendingContainerClick);
    pendingContainerClick = 0;
  };
  bus.on('node-click', (id) => {
    if (state.presenting) return;
    cancelPendingContainerClick();
    if (workbench.handleNodeClick(id)) return;
    if (state.connectFrom) {
      const from = state.connectFrom;
      const label = state.pendingEdgeLabel ?? null;
      state.connectFrom = null;
      state.pendingEdgeLabel = null;
      canvas.paintSelection();
      if (from === id) { ui.toast('Connect cancelled'); return; }
      ctrl.commit(() => edit.addEdge(state.scopeId, { from, to: id, label }))
        .then((ok) => {
          if (!ok) return;
          const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
          ctrl.selectEdge(scope.edges.length - 1);
          workbench.completeConnect();
          ui.toast(label ? `“${label}” branch added — drag the line to route it` : 'Edge added — set its label in the panel');
        });
      return;
    }
    const node = state.model?.byId.get(id);
    if (node?.children) {
      // A native double-click emits click events first. Delay the single-click
      // focus so a dive preserves the overview camera instead of a partial
      // focus animation.
      pendingContainerClick = setTimeout(() => {
        pendingContainerClick = 0;
        const current = state.model?.byId.get(id);
        if (!current || current.ownerId !== (state.scopeId ?? null)) return;
        ui.armContextActions(id);
        ctrl.selectNode(id);
      }, 220);
      return;
    }
    ui.armContextActions(id);
    ctrl.selectNode(id);
  });

  bus.on('node-dblclick', (id) => {
    cancelPendingContainerClick();
    if (state.presenting) return;
    const node = state.model?.byId.get(id);
    if (node?.children) ctrl.diveInto(id);
    else ctrl.selectNode(id);
  });

  bus.on('dive-request', (id) => {
    cancelPendingContainerClick();
    if (!state.presenting) ctrl.diveInto(id);
  });

  // a finished node drag pins the node where it was dropped
  bus.on('node-moved', (id, pos) => {
    if (state.presenting || state.standalone) return;
    ctrl.commit(() => edit.setNodePosition(id, pos))
      .then((ok) => { if (!ok) canvas.refreshScope(state.model); });
  });

  bus.on('unpin-request', (id) => {
    if (state.presenting || state.standalone) return;
    ctrl.commit(() => edit.clearNodePosition(id))
      .then((ok) => { if (ok) ui.toast('Released — back to auto-layout'); });
  });

  // a finished edge drag pins the route through the drop point; a dragged
  // straight edge becomes curved (the via only makes sense on a bend)
  bus.on('edge-routed', (index, via, style) => {
    if (state.presenting || state.standalone) return;
    ctrl.commit(() => {
      edit.setEdgeVia(state.scopeId, index, via);
      if (style) edit.setEdgeRoute(state.scopeId, index, style);
    }).then((ok) => { if (!ok) canvas.refreshScope(state.model); });
  });

  bus.on('unroute-request', (index) => {
    if (state.presenting || state.standalone) return;
    ctrl.commit(() => {
      edit.clearEdgeVia(state.scopeId, index);
      edit.setEdgeRoute(state.scopeId, index, null);
    }).then((ok) => { if (ok) ui.toast('Released — back to automatic routing'); });
  });

  // re-nesting suffix: "· 2 edges re-linked · 1 edge removed"
  const edgeFate = (res) => {
    let s = '';
    if (res?.lifted) s += ` · ${res.lifted} edge${res.lifted === 1 ? '' : 's'} re-linked`;
    if (res?.dropped) s += ` · ${res.dropped} edge${res.dropped === 1 ? '' : 's'} removed`;
    return s;
  };

  // a node dropped onto a container moves into that container's sub-map
  bus.on('node-drop-into', (id, containerId) => {
    if (state.presenting || state.standalone) return;
    const nodeLabel = state.model?.byId.get(id)?.label ?? id;
    const contLabel = state.model?.byId.get(containerId)?.label ?? containerId;
    const isPlacement = state.model?.mode === 'freeform' && state.model.elementById?.has(id);
    const fromOwnerId = state.scopeId;
    let res;
    ctrl.commit(() => {
      res = isPlacement
        ? edit.movePlacement(id, fromOwnerId, containerId)
        : edit.moveNode(id, containerId);
    }, { select: null })
      .then((ok) => {
        if (!ok) { canvas.refreshScope(state.model); return; }
        ui.toast(`Moved “${nodeLabel}” into “${contLabel}”${edgeFate(res)}`);
      });
  });

  // a node dropped on the move-out bar climbs one level up
  bus.on('node-move-out', (id) => {
    if (state.presenting || state.standalone || state.scopeId == null) return;
    const owner = state.model?.byId.get(state.scopeId);
    if (!owner) return;
    const targetOwnerId = owner.ownerId ?? null;
    const nodeLabel = state.model.byId.get(id)?.label ?? id;
    const targetLabel = targetOwnerId
      ? state.model.byId.get(targetOwnerId)?.label ?? targetOwnerId
      : state.model.name;
    const isPlacement = state.model.mode === 'freeform' && state.model.elementById?.has(id);
    if (isPlacement && targetOwnerId == null) {
      ui.toast('Items must stay inside a group');
      canvas.refreshScope(state.model);
      return;
    }
    const fromOwnerId = state.scopeId;
    let res;
    ctrl.commit(() => {
      res = isPlacement
        ? edit.movePlacement(id, fromOwnerId, targetOwnerId)
        : edit.moveNode(id, targetOwnerId);
    }, { select: null })
      .then((ok) => {
        if (!ok) { canvas.refreshScope(state.model); return; }
        ui.toast(`Moved “${nodeLabel}” out to “${targetLabel}”${edgeFate(res)}`);
      });
  });

  bus.on('peer-scope-request', (ownerId, focusId = null) => {
    if (state.presenting || state.scopeId == null) return;
    ctrl.gotoPeerScope(ownerId, { focusId });
  });

  // drag released over a sibling after starting on a port → new edge
  bus.on('connect-drag', (from, to) => {
    if (state.presenting || state.standalone) return;
    const label = state.pendingEdgeLabel ?? null;
    state.pendingEdgeLabel = null;
    ctrl.commit(() => edit.addEdge(state.scopeId, { from, to, label }))
      .then((ok) => {
        if (!ok) return;
        const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
        ctrl.selectEdge(scope.edges.length - 1);
        ui.toast(label
          ? `“${label}” branch added — drag the line to route it`
          : `${state.model.mode === 'freeform' ? 'Connection' : 'Edge'} added. Set its label in the panel.`);
      });
  });

  // double-click on empty canvas creates the default node for this map mode
  bus.on('bg-dblclick', (world) => {
    cancelPendingContainerClick();
    if (state.presenting || state.standalone || !state.model) return;
    ui.createNodeAt(state.model.mode === 'freeform' ? 'item' : 'process', world);
  });

  bus.on('edge-click', (index) => {
    cancelPendingContainerClick();
    if (state.presenting || state.connectFrom) return;
    ctrl.selectEdge(index);
  });

  bus.on('bg-click', () => {
    cancelPendingContainerClick();
    if (state.presenting) return;
    if (state.connectFrom) {
      state.connectFrom = null;
      state.pendingEdgeLabel = null;
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
  return el && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName) || el.isContentEditable);
}
function dialogOpen() {
  return !!document.querySelector('.dialog-backdrop') || !document.getElementById('search-overlay').hidden;
}

function spatialMove(dir) {
  if (canvas.isTransitioning()) return; // the layout on screen is mid-swap
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

    if (ev.shiftKey && ev.key.toLowerCase() === 'p') { productWorkspace.setWorkspaceView('map'); togglePresent(); return; }
    if (state.workspaceView === 'flow') { if (flowShortcut(ev)) ev.preventDefault(); return; }
    if (state.workspaceView !== 'map') return;
    if (workbench.shortcutTool(ev.key)) { ev.preventDefault(); return; }

    switch (ev.key) {
      case 'Escape':
        if (state.connectFrom) { state.connectFrom = null; state.pendingEdgeLabel = null; canvas.paintSelection(); ui.toast('Connect cancelled'); }
        else if (state.activeTool !== 'select') workbench.cancelTool();
        else if (!document.getElementById('templates-panel').hidden) ui.toggleTemplates(false);
        else if (state.scopeId != null) ctrl.riseUp(); // one level per press, always
        else if (state.selectedId || state.selectedEdge != null) { ctrl.clearSelection(); ui.hideDetail(); }
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
  on('btn-templates', () => { productWorkspace.setWorkspaceView('map'); ui.toggleTemplates(); });
  on('btn-add-node', () => { productWorkspace.setWorkspaceView('map'); ui.addNodeDialog(state.scopeId); });
  on('btn-economics', () => { productWorkspace.setWorkspaceView('map'); ui.toggleEconomics(); });
  on('btn-import', () => { productWorkspace.setWorkspaceView('map'); ui.importDialog(); });
  on('btn-import-file', () => { productWorkspace.setWorkspaceView('map'); workbench.importMapFile(); });
  on('btn-export-file', workbench.downloadYaml);
  on('btn-ai', () => { productWorkspace.setWorkspaceView('map'); ui.toggleChat(); });
  on('btn-ai-settings', workbench.aiSettingsDialog);
  bus.on('ai-settings-request', workbench.aiSettingsDialog);
  on('btn-present', () => { productWorkspace.setWorkspaceView('map'); togglePresent(); });
  on('btn-theme', toggleTheme);
  on('btn-help', ui.helpDialog);
  on('btn-export', () => {
    if (state.mapId) window.location.href = `/export/${encodeURIComponent(state.mapId)}.html`;
  });
  on('btn-share', workbench.openShareDialog);
  on('btn-history', workbench.openHistory);
  on('zoom-in', () => canvas.zoomBy(1.3));
  on('zoom-out', () => canvas.zoomBy(0.77));
  on('zoom-fit', () => canvas.fit());
  for (const button of document.querySelectorAll('.utility-popover button')) {
    button.addEventListener('click', () => { const menu = button.closest('details'); if (menu) menu.open = false; });
  }
  document.querySelector('.logo')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (state.presenting) exitPresent();
    productWorkspace.setWorkspaceView('map');
    if (state.model) ctrl.gotoScope(null);
  });
}

// ── boot ─────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  canvas.initCanvas(document.getElementById('canvas'), document.querySelector('#minimap svg'));
  ui.initUI();
  workbench.initWorkbench();
  productWorkspace.initProductWorkspace();
  wireCanvasEvents();
  wireKeyboard();
  wireToolbar();
  ctrl.wireHistory();

  try {
    await ctrl.loadMapList();
  } catch (e) {
    ui.toast('Could not reach the Serigraph server: ' + e.message, true);
    return;
  }

  const route = ctrl.readHash();
  let mapId = route.mapId && state.maps.some((m) => m.id === route.mapId) ? route.mapId : null;
  if (!mapId) mapId = state.maps.some((m) => m.id === 'insurance') ? 'insurance' : state.maps[0]?.id;

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
