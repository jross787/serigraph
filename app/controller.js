// Orchestrates everything: loading maps, the edit→serialize→save pipeline,
// navigation (scopes, selection, deep links, history), and remote changes.
import { parseMap, ancestryOf, scopeOf, placementInScope, placementsOf } from '../shared/model.js';
import { collectProvenance } from '../shared/provenance.js';
import { parseHash, buildHash } from './routes.js';
import { state, bus } from './state.js';
import { invalidateLayouts } from './layout.js';
import * as canvas from './canvas.js';
import { api } from './api.js';

// ── hash routing ─────────────────────────────────────────────────────
// The codec lives in ./routes.js (pure, unit-tested). #/ is the projects
// home; #/map/<id> opens a map — the id may be "<project>/<map>".
export function readHash() {
  return parseHash(location.hash || '');
}

let squelchHash = false;
export function writeHash({ push = false } = {}) {
  if (!state.mapId) {
    const hash = '#/';
    if (location.hash === hash || location.hash === '' || location.hash === '#') return;
    squelchHash = true;
    if (push) location.hash = hash;
    else history.replaceState(null, '', hash);
    setTimeout(() => { squelchHash = false; }, 0);
    return;
  }
  const placed = state.selectedId
    && state.model?.mode === 'freeform'
    && state.model.elementById?.has(state.selectedId)
    && state.scopeId != null;
  const hash = buildHash({
    mapId: state.mapId,
    inId: state.selectedId ? (placed ? state.scopeId : null) : state.scopeId,
    nodeId: state.selectedId,
  });
  if (location.hash === hash) return;
  squelchHash = true;
  if (push) location.hash = hash;
  else history.replaceState(null, '', hash);
  // hashchange fires async; release on next tick
  setTimeout(() => { squelchHash = false; }, 0);
}

function scopeForNode(nodeId, preferredScopeId = state.scopeId) {
  const model = state.model;
  if (!model) return null;
  if (model.mode === 'freeform' && model.elementById?.has(nodeId)) {
    if (preferredScopeId != null && placementInScope(model, preferredScopeId, nodeId)) return preferredScopeId;
    return placementsOf(model, nodeId)[0]?.ownerId ?? null;
  }
  return model.byId.get(nodeId)?.ownerId ?? null;
}

function setSaveStatus(status, error = '') {
  state.saveStatus = status;
  state.saveError = error;
  bus.emit('save-status', status, error);
}

async function saveMapSource(source) {
  setSaveStatus('saving');
  try {
    const result = await api.saveMap(state.mapId, source);
    setSaveStatus('saved');
    return result;
  } catch (error) {
    setSaveStatus('error', error.message);
    throw error;
  }
}

function cleanHistoryLabel(label) {
  const value = String(label || '').trim();
  return value || 'edit map';
}

function revisionLabel(label) {
  const value = cleanHistoryLabel(label);
  return value[0].toUpperCase() + value.slice(1);
}

function historyEntry(source, label) {
  return { source, label: cleanHistoryLabel(label) };
}

function entrySource(entry) {
  return typeof entry === 'string' ? entry : entry.source;
}

function entryLabel(entry) {
  return typeof entry === 'string' ? 'edit map' : cleanHistoryLabel(entry.label);
}

export function nodeUrl(nodeId) {
  const ownerId = scopeForNode(nodeId);
  const inScope = state.model?.mode === 'freeform' && state.model.elementById?.has(nodeId) && ownerId != null;
  return `${location.origin}${location.pathname}` + buildHash({
    mapId: state.mapId,
    inId: inScope ? ownerId : null,
    nodeId,
  });
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

export async function openMap(mapId, { nodeId = null, inId = null, replace = false } = {}) {
  const mapChanged = mapId !== state.mapId;
  const pushHash = mapChanged && !replace;
  let payload;
  try {
    payload = await api.getMap(mapId);
  } catch (e) {
    // The file may have moved into/out of a project. If the maps list shows
    // the same file under a new id, follow it silently.
    if (e.status === 404) {
      await loadMapList().catch(() => {});
      const tail = mapId.includes('/') ? mapId.slice(mapId.lastIndexOf('/') + 1) : mapId;
      const hit = state.maps.find((m) => m.id === tail || m.id.endsWith(`/${tail}`) || m.id.split('/').pop() === tail);
      if (hit && hit.id !== mapId) return followMoved(hit.id, { nodeId, inId });
    }
    throw e;
  }
  if (payload.movedTo && payload.movedTo !== mapId) {
    return followMoved(payload.movedTo, { nodeId, inId });
  }
  const { source } = payload;
  if (mapChanged) canvas.resetScopeCameras();
  state.mapId = mapId;
  state.undoStack = [];
  state.redoStack = [];
  adoptSource(source);
  setSaveStatus(state.standalone ? 'idle' : 'saved');
  bus.emit('map-opened');

  if (!state.model) {
    canvas.showScope({ byId: new Map(), root: { nodes: [], edges: [] } }, null);
    if (pushHash) writeHash({ push: true });
    bus.emit('view-changed');
    return;
  }
  // resolve requested position
  if (nodeId && state.model.byId.has(nodeId)) {
    const scopeId = scopeForNode(nodeId, inId);
    state.scopeId = scopeId;
    state.selectedId = scopeOf(state.model, scopeId)?.nodes.some((node) => node.id === nodeId) ? nodeId : null;
    await canvas.showScope(state.model, scopeId, { focusId: state.selectedId });
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
  writeHash({ push: pushHash });
  bus.emit('view-changed');
}

// Follow a map that was moved between the root and a project: swap the id,
// update the address bar in place, and tell the user once.
async function followMoved(newId, { nodeId = null, inId = null } = {}) {
  const projectName = state.maps.find((m) => m.id === newId)?.project?.name
    ?? state.projects.find((p) => p.slug === newId.split('/')[0])?.name
    ?? newId.split('/')[0];
  await openMap(newId, { nodeId, inId, replace: true });
  history.replaceState(null, '', buildHash({ mapId: newId }));
  bus.emit('toast', newId.includes('/') ? `Map moved to ${projectName}` : 'Map moved to the root');
}

// Leave the current map and show the projects home.
export function goHome({ push = true } = {}) {
  state.mapId = null;
  state.source = '';
  state.doc = null;
  state.model = null;
  state.errors = [];
  state.scopeId = null;
  state.selectedId = null;
  state.selectedEdge = null;
  setSaveStatus('idle');
  if (push && location.hash !== '#/') {
    squelchHash = true;
    location.hash = '#/';
    setTimeout(() => { squelchHash = false; }, 0);
  } else if (!push) {
    writeHash();
  }
  bus.emit('view-changed');
}

export async function loadProjects() {
  try {
    state.projects = await api.listProjects();
  } catch {
    state.projects = [];
  }
  bus.emit('projects-listed');
  return state.projects;
}

export async function loadTrash() {
  try {
    state.trash = await api.listTrash();
  } catch {
    state.trash = [];
  }
  bus.emit('trash-listed');
  return state.trash;
}

// parse source into state (doc + model + errors); no rendering
function adoptSource(source) {
  const { doc, model, errors } = parseMap(source);
  state.source = source;
  state.doc = doc;
  state.model = model;
  state.errors = errors;
  // provenance flags ("# inferred:" comments) — shown as badges + panel rows
  try {
    state.flags = doc && model ? collectProvenance(doc) : { nodes: new Map(), edges: [] };
  } catch {
    state.flags = { nodes: new Map(), edges: [] };
  }
  invalidateLayouts();
}

function revisionKey() {
  return state.mapId ? `opsmap:revisions:${state.mapId}` : '';
}

function readRevisions() {
  const key = revisionKey();
  if (!key) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function recordRevision(source, label = 'Edited map') {
  const key = revisionKey();
  if (!key) return;
  const revisions = readRevisions();
  revisions.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, source, label, savedAt: new Date().toISOString() });
  try { localStorage.setItem(key, JSON.stringify(revisions.slice(0, 30))); } catch { /* storage is optional */ }
}

export function listRevisions() {
  return readRevisions();
}

export async function restoreRevision(revision) {
  if (!revision?.source || state.standalone) return false;
  const before = state.source;
  const label = `restore ${revision.label || 'revision'}`;
  const { errors } = parseMap(revision.source);
  if (errors.length) {
    bus.emit('toast', 'That revision is no longer valid.', true);
    return false;
  }
  adoptSource(revision.source);
  try {
    await saveMapSource(revision.source);
  } catch (e) {
    adoptSource(before);
    refreshView();
    bus.emit('toast', 'Restore failed: ' + e.message, true);
    return false;
  }
  state.undoStack.push(historyEntry(before, label));
  state.redoStack = [];
  recordRevision(revision.source, revisionLabel(label));
  refreshView();
  bus.emit('toast', `Restored ${revision.label || 'a revision'}`);
  return true;
}

// Apply a wholesale map replacement (the AI assistant's reviewed proposal).
// Same safety as a normal commit: validate, keep an undo point, record a
// local revision, and roll back if the save fails.
export async function applySource(after, label = 'AI edit') {
  if (state.standalone || typeof after !== 'string' || !after.trim()) return false;
  const before = state.source;
  const action = cleanHistoryLabel(label);
  const { errors } = parseMap(after);
  if (errors.length) {
    bus.emit('toast', 'The proposed map is invalid — not applied. ' + errors[0].message, true);
    return false;
  }
  if (after === before) return true;
  adoptSource(after);
  try {
    await saveMapSource(after);
  } catch (e) {
    adoptSource(before);
    refreshView();
    bus.emit('toast', 'Save failed: ' + e.message, true);
    return false;
  }
  state.undoStack.push(historyEntry(before, action));
  state.redoStack = [];
  recordRevision(after, revisionLabel(action));
  refreshView();
  return true;
}

// Masked AI settings, cached on state for the chat dock's voice mode.
export async function loadAiSettings(force = false) {
  if (state.standalone) return null;
  if (state.aiSettings && !force) return state.aiSettings;
  state.aiSettings = await api.getSettings().catch(() => null);
  return state.aiSettings;
}

// ── the edit pipeline ────────────────────────────────────────────────
// commit(() => { ...mutate state.doc via edit.js... })
export async function commit(mutator, { select = undefined, historyLabel = 'edit map' } = {}) {
  if (state.standalone) { bus.emit('toast', 'This is a read-only export.', true); return false; }
  const before = state.source;
  const action = cleanHistoryLabel(historyLabel);
  let after;
  try {
    mutator();
    // lineWidth 0 = never re-wrap long lines the edit didn't touch
    after = state.doc.toString({ lineWidth: 0 });
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

  state.undoStack.push(historyEntry(before, action));
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
  adoptSource(after);

  try {
    await saveMapSource(after);
  } catch (e) {
    state.undoStack.pop();
    adoptSource(before);
    refreshView();
    bus.emit('toast', 'Save failed: ' + e.message, true);
    return false;
  }

  recordRevision(after, revisionLabel(action));

  if (select !== undefined) state.selectedId = select;
  refreshView();
  return true;
}

export async function undo() {
  if (!state.undoStack.length) { bus.emit('toast', 'Nothing to undo'); return false; }
  const previous = state.undoStack.pop();
  const source = entrySource(previous);
  const label = entryLabel(previous);
  state.redoStack.push(historyEntry(state.source, label));
  adoptSource(source);
  try { await saveMapSource(source); } catch { /* keep the local undo and show the failed save state */ }
  recordRevision(source, `Undo ${label}`);
  refreshView();
  bus.emit('toast', `Undid ${label}`);
  return true;
}

export async function redo() {
  if (!state.redoStack.length) { bus.emit('toast', 'Nothing to redo'); return false; }
  const next = state.redoStack.pop();
  const source = entrySource(next);
  const label = entryLabel(next);
  state.undoStack.push(historyEntry(state.source, label));
  adoptSource(source);
  try { await saveMapSource(source); } catch { /* keep the local redo and show the failed save state */ }
  recordRevision(source, `Redo ${label}`);
  refreshView();
  bus.emit('toast', `Redid ${label}`);
  return true;
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
  if (!state.mapId) return;
  if (!ids.includes(state.mapId)) {
    // The open map may have been moved into/out of a project by another
    // process: its old id disappears from the list while the file survives
    // under a new id. openMap follows that move on its own.
    if (state.maps.length && !state.maps.some((m) => m.id === state.mapId)) {
      try { await openMap(state.mapId, { replace: true }); } catch { /* truly gone — stay put */ }
    }
    return;
  }
  let payload;
  try { payload = await api.getMap(state.mapId); }
  catch { return; }
  if (payload.movedTo && payload.movedTo !== state.mapId) {
    await openMap(state.mapId); // openMap follows the move
    return;
  }
  if (payload.source === state.source) return; // our own write echoed back

  lastAncestry = state.scopeId && state.model ? ancestryOf(state.model, state.scopeId) : [];
  adoptSource(payload.source);
  state.undoStack = [];
  state.redoStack = [];
  setSaveStatus(state.model ? 'saved' : 'error', state.model ? '' : 'Map file has errors');
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

export async function gotoPeerScope(ownerId, { focusId = null } = {}) {
  const current = state.model?.byId.get(state.scopeId);
  const target = state.model?.byId.get(ownerId);
  if (!current || !target?.children || target.ownerId !== current.ownerId || target.id === current.id) return false;
  await gotoScope(target.id, { focusId });
  return true;
}

export async function gotoNode(nodeId) {
  const node = state.model?.byId.get(nodeId);
  if (!node) return;
  const ownerId = scopeForNode(nodeId);
  if (ownerId === state.scopeId && scopeOf(state.model, ownerId)?.nodes.some((item) => item.id === nodeId)) {
    selectNode(nodeId);
    canvas.centerOn(nodeId);
    return;
  }
  await gotoScope(ownerId, { focusId: nodeId });
}

export function selectNode(nodeId) {
  // Stale input from a fading layer must never select a node outside the
  // current scope. Shared Freeform elements use their placement's scope.
  const visible = scopeOf(state.model, state.scopeId)?.nodes.some((node) => node.id === nodeId);
  if (!visible) return;
  state.selectedId = nodeId;
  state.selectedEdge = null;
  canvas.paintSelection();
  canvas.focusOn(nodeId);
  writeHash();
  bus.emit('selection-changed');
}

export function selectEdge(index) {
  state.selectedId = null;
  state.detailNodeId = null; // panel must not keep showing the last node
  state.selectedEdge = index == null ? null : { scopeId: state.scopeId, index };
  canvas.paintSelection();
  writeHash(); // drop any stale /node/<id> from the URL
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
    if (!r.mapId) {
      if (r.home && state.mapId) goHome({ push: false });
      return;
    }
    if (r.mapId !== state.mapId) {
      await openMap(r.mapId, { ...r, replace: true });
      return;
    }
    if (!state.model) return;
    const targetScope = r.nodeId ? scopeForNode(r.nodeId, r.inId) : (r.inId ?? null);
    const targetSel = r.nodeId
      && scopeOf(state.model, targetScope)?.nodes.some((node) => node.id === r.nodeId)
      ? r.nodeId
      : null;
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
