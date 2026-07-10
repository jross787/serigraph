// Orchestrates everything: loading maps, the edit→serialize→save pipeline,
// navigation (scopes, selection, deep links, history), and remote changes.
import { parseMap, ancestryOf } from '../shared/model.js';
import { state, bus } from './state.js';
import { invalidateLayouts } from './layout.js';
import * as canvas from './canvas.js';
import { api } from './api.js';

// ── hash routing ─────────────────────────────────────────────────────
// #/map/<id>            — root scope
// #/map/<id>/in/<node>  — inside a container node
// #/map/<id>/node/<id>  — a node, selected in its parent scope
export function readHash() {
  let h;
  try { h = decodeURIComponent(location.hash || ''); }
  catch { h = location.hash || ''; } // malformed %-sequence: use it verbatim
  let m = h.match(/^#\/map\/([^/]+)\/node\/(.+)$/);
  if (m) return { mapId: m[1], nodeId: m[2] };
  m = h.match(/^#\/map\/([^/]+)\/in\/(.+)$/);
  if (m) return { mapId: m[1], inId: m[2] };
  m = h.match(/^#\/map\/([^/]+)/);
  if (m) return { mapId: m[1] };
  return {};
}

let squelchHash = false;
export function writeHash({ push = false } = {}) {
  if (!state.mapId) return;
  const base = `#/map/${encodeURIComponent(state.mapId)}`;
  let hash = base;
  if (state.selectedId) hash = `${base}/node/${encodeURIComponent(state.selectedId)}`;
  else if (state.scopeId) hash = `${base}/in/${encodeURIComponent(state.scopeId)}`;
  if (location.hash === hash) return;
  squelchHash = true;
  if (push) location.hash = hash;
  else history.replaceState(null, '', hash);
  // hashchange fires async; release on next tick
  setTimeout(() => { squelchHash = false; }, 0);
}

export function nodeUrl(nodeId) {
  return `${location.origin}${location.pathname}#/map/${encodeURIComponent(state.mapId)}/node/${encodeURIComponent(nodeId)}`;
}

// ── loading ──────────────────────────────────────────────────────────
export async function loadMapList() {
  state.maps = await api.listMaps();
  bus.emit('maps-listed');
  return state.maps;
}

export async function loadTemplates() {
  try {
    state.templates = await api.listTemplates();
    bus.emit('templates-loaded');
  } catch { /* templates are optional */ }
}

export async function openMap(mapId, { nodeId = null, inId = null } = {}) {
  const { source } = await api.getMap(mapId);
  state.mapId = mapId;
  state.undoStack = [];
  state.redoStack = [];
  adoptSource(source);
  bus.emit('map-opened');

  if (!state.model) {
    canvas.showScope({ byId: new Map(), root: { nodes: [], edges: [] } }, null);
    bus.emit('view-changed');
    return;
  }
  // resolve requested position
  if (nodeId && state.model.byId.has(nodeId)) {
    const node = state.model.byId.get(nodeId);
    state.scopeId = node.ownerId;
    state.selectedId = nodeId;
    await canvas.showScope(state.model, state.scopeId, { focusId: nodeId });
    canvas.paintSelection();
  } else if (inId && state.model.byId.get(inId)?.children) {
    state.scopeId = inId;
    state.selectedId = null;
    await canvas.showScope(state.model, inId);
  } else {
    state.scopeId = null;
    state.selectedId = null;
    await canvas.showScope(state.model, null);
  }
  writeHash();
  bus.emit('view-changed');
}

// parse source into state (doc + model + errors); no rendering
function adoptSource(source) {
  const { doc, model, errors } = parseMap(source);
  state.source = source;
  state.doc = doc;
  state.model = model;
  state.errors = errors;
  invalidateLayouts();
}

// ── the edit pipeline ────────────────────────────────────────────────
// commit(() => { ...mutate state.doc via edit.js... })
export async function commit(mutator, { select = undefined } = {}) {
  if (state.standalone) { bus.emit('toast', 'This is a read-only export.', true); return false; }
  const before = state.source;
  let after;
  try {
    mutator();
    after = state.doc.toString();
  } catch (e) {
    adoptSource(before); // doc may be half-mutated; rebuild from source
    bus.emit('toast', e.message, true);
    return false;
  }
  if (after === before) return true;

  const { errors } = parseMap(after);
  if (errors.length) {
    adoptSource(before);
    bus.emit('toast', 'Edit produced an invalid map — reverted. ' + errors[0].message, true);
    return false;
  }

  state.undoStack.push(before);
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
  adoptSource(after);

  try {
    await api.saveMap(state.mapId, after);
  } catch (e) {
    state.undoStack.pop();
    adoptSource(before);
    refreshView();
    bus.emit('toast', 'Save failed: ' + e.message, true);
    return false;
  }

  if (select !== undefined) state.selectedId = select;
  refreshView();
  return true;
}

export async function undo() {
  if (!state.undoStack.length) { bus.emit('toast', 'Nothing to undo'); return; }
  const prev = state.undoStack.pop();
  state.redoStack.push(state.source);
  adoptSource(prev);
  try { await api.saveMap(state.mapId, prev); } catch { /* keep local */ }
  refreshView();
  bus.emit('toast', 'Undone');
}

export async function redo() {
  if (!state.redoStack.length) { bus.emit('toast', 'Nothing to redo'); return; }
  const next = state.redoStack.pop();
  state.undoStack.push(state.source);
  adoptSource(next);
  try { await api.saveMap(state.mapId, next); } catch { /* keep local */ }
  refreshView();
  bus.emit('toast', 'Redone');
}

// After any model change: keep the user's place if it still exists.
function refreshView() {
  if (!state.model) { bus.emit('view-changed'); return; }
  if (state.scopeId && !state.model.byId.get(state.scopeId)?.children) {
    // current scope vanished — climb to nearest surviving ancestor
    state.scopeId = nearestSurvivingScope(state.scopeId);
  }
  if (state.selectedId && !state.model.byId.has(state.selectedId)) state.selectedId = null;
  if (state.selectedEdge) state.selectedEdge = null;
  canvas.showScope(state.model, state.scopeId);
  canvas.paintSelection();
  writeHash();
  bus.emit('view-changed');
}

let lastAncestry = [];
function nearestSurvivingScope(oldScopeId) {
  for (let i = lastAncestry.length - 1; i >= 0; i--) {
    const id = lastAncestry[i];
    if (state.model.byId.get(id)?.children) return id;
  }
  return null;
}

// ── remote changes (file edited on disk / another tab) ───────────────
export async function handleRemoteChange(ids) {
  await loadMapList();
  if (!ids.includes(state.mapId)) return;
  let payload;
  try { payload = await api.getMap(state.mapId); }
  catch { return; }
  if (payload.source === state.source) return; // our own write echoed back

  lastAncestry = state.scopeId && state.model ? ancestryOf(state.model, state.scopeId) : [];
  adoptSource(payload.source);
  state.undoStack = [];
  state.redoStack = [];
  refreshView();
  bus.emit('toast', state.model ? 'Map updated from file' : 'Map file has errors — see details', !state.model);
}

// ── navigation ───────────────────────────────────────────────────────
export async function diveInto(nodeId) {
  const node = state.model?.byId.get(nodeId);
  if (!node?.children) return;
  lastAncestry = ancestryOf(state.model, nodeId);
  state.scopeId = nodeId;
  state.selectedId = null;
  state.selectedEdge = null;
  bus.emit('view-changed');
  writeHash({ push: true });
  await canvas.showScope(state.model, nodeId, { transition: 'dive' });
  canvas.paintSelection();
}

export async function riseUp() {
  if (state.scopeId == null) return;
  const owner = state.model.byId.get(state.scopeId);
  const parent = owner?.ownerId ?? null;
  const cameFrom = state.scopeId;
  state.scopeId = parent;
  state.selectedId = cameFrom; // select the node we just left
  state.selectedEdge = null;
  bus.emit('view-changed');
  writeHash({ push: true });
  await canvas.showScope(state.model, parent, { transition: 'rise' });
  canvas.paintSelection();
}

// Jump anywhere (breadcrumbs, search, deep links). Instant, then focus.
export async function gotoScope(ownerId, { focusId = null } = {}) {
  state.scopeId = ownerId;
  state.selectedId = focusId;
  state.selectedEdge = null;
  bus.emit('view-changed');
  writeHash({ push: true });
  await canvas.showScope(state.model, ownerId, { focusId });
  canvas.paintSelection();
}

export async function gotoNode(nodeId) {
  const node = state.model?.byId.get(nodeId);
  if (!node) return;
  if (node.ownerId === state.scopeId) {
    selectNode(nodeId);
    canvas.centerOn(nodeId);
    return;
  }
  await gotoScope(node.ownerId, { focusId: nodeId });
}

export function selectNode(nodeId) {
  state.selectedId = nodeId;
  state.selectedEdge = null;
  canvas.paintSelection();
  writeHash();
  bus.emit('selection-changed');
  // the detail panel docks ~230ms after selection and shrinks the canvas —
  // keep the selected node on screen once that resize settles
  setTimeout(() => {
    if (!state.presenting && state.selectedId === nodeId) canvas.ensureVisible(nodeId);
  }, 360);
}

export function selectEdge(index) {
  state.selectedId = null;
  state.selectedEdge = index == null ? null : { scopeId: state.scopeId, index };
  canvas.paintSelection();
  bus.emit('selection-changed');
}

export function clearSelection() {
  state.selectedId = null;
  state.selectedEdge = null;
  canvas.paintSelection();
  writeHash();
  bus.emit('selection-changed');
}

// browser back/forward
export function wireHistory() {
  window.addEventListener('hashchange', async () => {
    if (squelchHash) return;
    const r = readHash();
    if (!r.mapId) return;
    if (r.mapId !== state.mapId) {
      await openMap(r.mapId, r);
      return;
    }
    if (!state.model) return;
    const targetScope = r.inId ?? (r.nodeId ? state.model.byId.get(r.nodeId)?.ownerId ?? null : null);
    const targetSel = r.nodeId && state.model.byId.has(r.nodeId) ? r.nodeId : null;
    if (targetScope === state.scopeId) {
      state.selectedId = targetSel;
      canvas.paintSelection();
      if (targetSel) canvas.centerOn(targetSel);
      bus.emit('selection-changed');
      return;
    }
    // pick a transition that matches the direction of travel
    const cur = state.scopeId;
    const parentOfCur = cur ? state.model.byId.get(cur)?.ownerId ?? null : undefined;
    const ownerOfTarget = targetScope ? state.model.byId.get(targetScope)?.ownerId ?? null : undefined;
    state.scopeId = targetScope;
    state.selectedId = targetSel;
    bus.emit('view-changed');
    if (parentOfCur === targetScope) {
      await canvas.showScope(state.model, targetScope, { transition: 'rise' });
    } else if (ownerOfTarget === cur) {
      await canvas.showScope(state.model, targetScope, { transition: 'dive' });
    } else {
      await canvas.showScope(state.model, targetScope, { focusId: targetSel });
    }
    canvas.paintSelection();
  });
}
