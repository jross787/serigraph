import { parseMap } from '../shared/model.js';
import { state, bus } from './state.js';
import { api } from './api.js';
import * as ctrl from './controller.js';

const STORAGE_KEY = 'serigraph-workbench-links-v1';
let watchGeneration = 0;
let applyingRemote = false;
let pushTimer = 0;
let pendingSource = null;
let initialized = false;

function sourceHash(source) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readStoredLinks() {
  try {
    const links = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
  } catch { return {}; }
}

function storeConnection(connection) {
  if (!state.mapId || !connection) return;
  const links = readStoredLinks();
  links[state.mapId] = {
    url: connection.url,
    version: connection.version,
    lastHash: connection.lastHash,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(links)); } catch { /* browser storage is optional */ }
}

function forgetConnection(mapId = state.mapId) {
  if (!mapId) return;
  const links = readStoredLinks();
  delete links[mapId];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(links)); } catch { /* browser storage is optional */ }
}

function validRemoteSource(source) {
  if (typeof source !== 'string') return false;
  return parseMap(source).errors.length === 0;
}

function setConnection(url, info, source, { conflict = false, remoteSource = null, remoteMissing = false } = {}) {
  const connection = {
    url,
    docId: info.docId,
    title: info.title,
    role: info.role,
    version: info.version,
    baseSource: source,
    lastHash: sourceHash(source),
    conflict,
    remoteSource,
    remoteMissing,
    syncing: false,
  };
  state.workbench = connection;
  storeConnection(connection);
  bus.emit('workbench-changed', connection);
  startWatch(connection);
  return connection;
}

function updateBaseline(connection, source, version) {
  // A disconnect or map switch during a push/pull must not resurrect the link.
  if (state.workbench !== connection) return;
  connection.baseSource = source;
  connection.lastHash = sourceHash(source);
  connection.version = version ?? connection.version;
  connection.conflict = false;
  connection.remoteSource = null;
  connection.remoteMissing = false;
  storeConnection(connection);
  bus.emit('workbench-changed', connection);
}

async function applyRemoteSource(connection, source, version) {
  if (!validRemoteSource(source)) {
    connection.conflict = true;
    connection.remoteSource = source;
    connection.remoteMissing = false;
    bus.emit('workbench-changed', connection);
    bus.emit('toast', 'The linked Workbench map has YAML errors. Serigraph left your local map unchanged.', true);
    return false;
  }
  applyingRemote = true;
  try {
    const applied = source === state.source || await ctrl.applySource(source, 'Workbench update');
    if (!applied) return false;
    updateBaseline(connection, source, version);
    bus.emit('toast', 'Map updated from Workbench');
    return true;
  } finally {
    applyingRemote = false;
  }
}

async function pushSource(connection, source, { force = false } = {}) {
  if (!connection || state.workbench !== connection) return false;
  if (connection.role !== 'edit') {
    bus.emit('toast', `This Workbench link has ${connection.role} access, so Serigraph cannot publish edits.`, true);
    return false;
  }
  if (connection.conflict && !force) return false;
  connection.syncing = true;
  bus.emit('workbench-changed', connection);
  try {
    let baseVersion = connection.version;
    let baseSource = connection.baseSource;
    if (force) {
      const latest = await api.inspectWorkbench(connection.url);
      baseVersion = latest.version;
      baseSource = latest.source;
    }
    const result = await api.pushWorkbench(connection.url, source, baseVersion, baseSource);
    updateBaseline(connection, source, result.version);
    return true;
  } catch (error) {
    if (error.status === 409) {
      connection.conflict = true;
      connection.remoteSource = error.data?.remoteSource ?? null;
      connection.remoteMissing = error.data?.remoteMissing === true;
      bus.emit('workbench-changed', connection);
      bus.emit('toast', 'Workbench and the local map both changed. Choose which copy to keep in Share & sync.', true);
      return false;
    }
    bus.emit('toast', `Workbench sync failed: ${error.message}`, true);
    return false;
  } finally {
    connection.syncing = false;
    bus.emit('workbench-changed', connection);
  }
}

function queuePush(source) {
  pendingSource = source;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const next = pendingSource;
    pendingSource = null;
    if (next != null) pushSource(state.workbench, next);
  }, 250);
}

async function reconcile(connection, info) {
  if (state.workbench !== connection || state.mapId == null) return;
  connection.title = info.title;
  connection.role = info.role;
  connection.version = info.version;
  const localHash = sourceHash(state.source);
  if (!info.hasMap) {
    if (localHash === connection.lastHash) {
      disconnectWorkbench('The Serigraph section was removed from Workbench. Your local map is unchanged.');
      return;
    }
    connection.conflict = true;
    connection.remoteSource = null;
    connection.remoteMissing = true;
    bus.emit('workbench-changed', connection);
    bus.emit('toast', 'The Workbench map was removed after the local map changed. Choose whether to publish or disconnect.', true);
    return;
  }
  const remote = info.source;
  if (!validRemoteSource(remote)) {
    connection.conflict = true;
    connection.remoteSource = remote;
    connection.remoteMissing = false;
    bus.emit('workbench-changed', connection);
    return;
  }
  const remoteHash = sourceHash(remote);
  if (remoteHash === localHash) {
    updateBaseline(connection, remote, info.version);
    return;
  }
  if (localHash === connection.lastHash) {
    await applyRemoteSource(connection, remote, info.version);
    return;
  }
  if (remoteHash === connection.lastHash) {
    await pushSource(connection, state.source);
    return;
  }
  connection.conflict = true;
  connection.remoteSource = remote;
  connection.remoteMissing = false;
  bus.emit('workbench-changed', connection);
  bus.emit('toast', 'Workbench and the local map both changed. Choose which copy to keep in Share & sync.', true);
}

async function startWatch(connection) {
  const generation = ++watchGeneration;
  let cursor = 'latest';
  while (state.workbench === connection && generation === watchGeneration) {
    try {
      const result = await api.watchWorkbench(connection.url, cursor);
      if (state.workbench !== connection || generation !== watchGeneration) return;
      cursor = result.latest ?? cursor;
      if (result.events?.length) await reconcile(connection, await api.inspectWorkbench(connection.url));
    } catch {
      if (state.workbench !== connection || generation !== watchGeneration) return;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export async function inspectLink(url) {
  const info = await api.inspectWorkbench(url);
  if (info.hasMap && !validRemoteSource(info.source)) {
    const error = new Error('The linked Workbench document contains an invalid Serigraph map.');
    error.status = 422;
    throw error;
  }
  return info;
}

export async function connectLink(url, info, strategy = 'match') {
  if (!state.mapId || state.standalone) throw new Error('Open an editable map before linking Workbench.');
  let baseline = state.source;
  if (!info.hasMap) {
    if (info.role !== 'edit') throw new Error('This Workbench document has no map yet. Use an edit link to publish one.');
    const result = await api.pushWorkbench(url, state.source, info.version, null);
    info = { ...info, hasMap: true, source: state.source, version: result.version };
  } else if (info.source !== state.source) {
    if (strategy === 'pull') {
      applyingRemote = true;
      try {
        if (!await ctrl.applySource(info.source, 'Linked from Workbench')) throw new Error('Could not apply the Workbench map.');
      } finally { applyingRemote = false; }
      baseline = info.source;
    } else if (strategy === 'push') {
      if (info.role !== 'edit') throw new Error(`This is a ${info.role} link. It cannot replace the Workbench map.`);
      const result = await api.pushWorkbench(url, state.source, info.version, info.source);
      info = { ...info, source: state.source, version: result.version };
    } else {
      return { needsChoice: true, info };
    }
  } else {
    baseline = info.source;
  }
  const connection = setConnection(url, info, baseline);
  bus.emit('toast', `Linked to Workbench with ${info.role} access`);
  return { connection, needsChoice: false };
}

export async function syncNow() {
  const connection = state.workbench;
  if (!connection) return false;
  const info = await inspectLink(connection.url);
  await reconcile(connection, info);
  return !connection.conflict;
}

export async function useWorkbenchCopy() {
  const connection = state.workbench;
  if (!connection) return false;
  const info = await inspectLink(connection.url);
  if (!info.hasMap) return false;
  return applyRemoteSource(connection, info.source, info.version);
}

export async function sendLocalCopy() {
  const connection = state.workbench;
  if (!connection) return false;
  return pushSource(connection, state.source, { force: true });
}

export function disconnectWorkbench(message = 'Workbench disconnected') {
  clearTimeout(pushTimer);
  pendingSource = null;
  watchGeneration++;
  forgetConnection();
  state.workbench = null;
  bus.emit('workbench-changed', null);
  if (message) bus.emit('toast', message);
}

// Conflict resolution 'disconnect': clears every locally stored piece of the
// connection (share key, document metadata, sync state) exactly where the
// connect flow persisted them. It makes no network call, so neither copy is
// written and the remote document is never touched.
export async function disconnectWorkbenchLink() {
  disconnectWorkbench('Disconnected from Workbench. Your local map is unchanged.');
}

async function resumeForOpenMap() {
  watchGeneration++;
  state.workbench = null;
  bus.emit('workbench-changed', null);
  if (!state.mapId || state.standalone) return;
  const stored = readStoredLinks()[state.mapId];
  if (!stored?.url) return;
  try {
    const info = await inspectLink(stored.url);
    if (!info.hasMap) {
      forgetConnection();
      bus.emit('toast', 'The linked Serigraph section is no longer in Workbench. Your local map is unchanged.');
      return;
    }
    const localHash = sourceHash(state.source);
    const remoteHash = sourceHash(info.source);
    if (localHash === remoteHash) {
      setConnection(stored.url, info, info.source);
      return;
    }
    if (stored.lastHash && localHash === stored.lastHash) {
      const connection = setConnection(stored.url, info, state.source);
      await applyRemoteSource(connection, info.source, info.version);
      return;
    }
    if (stored.lastHash && remoteHash === stored.lastHash && info.role === 'edit') {
      const connection = setConnection(stored.url, info, info.source);
      await pushSource(connection, state.source);
      return;
    }
    setConnection(stored.url, info, info.source, { conflict: true, remoteSource: info.source });
    bus.emit('toast', 'This linked map changed in two places. Choose which copy to keep in Share & sync.', true);
  } catch (error) {
    bus.emit('toast', `Could not reconnect Workbench: ${error.message}`, true);
  }
}

export function initWorkbenchSync() {
  if (initialized || state.standalone) return;
  initialized = true;
  bus.on('map-opened', resumeForOpenMap);
  bus.on('map-saved', ({ id, source }) => {
    const connection = state.workbench;
    if (!connection || applyingRemote || id !== state.mapId) return;
    queuePush(source);
  });
}
