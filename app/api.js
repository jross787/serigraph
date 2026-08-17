// Server API. In standalone-export mode everything is read-only and local.
import { state, bus } from './state.js';

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const detail = data?.errors?.length
      ? data.errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join('\n')
      : data?.error || res.statusText;
    const err = new Error(detail);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  async listMaps() {
    if (state.standalone) {
      const s = window.OPSMAP_STANDALONE;
      if (s.project?.maps) return s.project.maps.map((m) => ({ ...m, project: { slug: s.project.slug, name: s.project.name } }));
      return [{ id: s.id, name: s.name || s.id }];
    }
    return jfetch('/api/maps');
  },
  async listProjects() {
    if (state.standalone) {
      const p = window.OPSMAP_STANDALONE.project;
      return p ? [{ slug: p.slug, name: p.name, mapCount: p.maps?.length ?? 0 }] : [];
    }
    return jfetch('/api/projects');
  },
  async createProject(name) {
    return jfetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },
  async moveMap(id, project) {
    return jfetch(`/api/maps/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    });
  },
  async listTrash() {
    if (state.standalone) return [];
    return jfetch('/api/trash');
  },
  async trashMap(id) {
    return jfetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async trashProject(slug) {
    return jfetch(`/api/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  },
  async restoreTrash(id) {
    return jfetch(`/api/trash/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  },
  async deleteTrash(id) {
    return jfetch(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async getMap(id) {
    if (state.standalone) return { id: window.OPSMAP_STANDALONE.id, source: window.OPSMAP_STANDALONE.source };
    return jfetch(`/api/maps/${encodeURIComponent(id)}`);
  },
  async saveMap(id, source) {
    if (state.standalone) throw new Error('This is a read-only export — edits are disabled.');
    const result = await jfetch(`/api/maps/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    bus.emit('map-saved', { id, source });
    return result;
  },
  async inspectWorkbench(url) {
    return jfetch('/api/workbench/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  },
  async pushWorkbench(url, source, baseVersion = null, baseSource = null) {
    return jfetch('/api/workbench/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, source, baseVersion, baseSource }),
    });
  },
  async createWorkbenchShare(url, role) {
    return jfetch('/api/workbench/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, role }),
    });
  },
  async watchWorkbench(url, since = 'latest') {
    return jfetch('/api/workbench/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, since }),
    });
  },
  async createMap(name, mode = 'process', project = null) {
    return jfetch('/api/maps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode, ...(project ? { project } : {}) }),
    });
  },
  async listTemplates() {
    if (state.standalone) return [];
    return jfetch('/api/templates');
  },
  async importStatus() {
    if (state.standalone) return { available: false, hint: 'Imports need the local Serigraph server.' };
    return jfetch('/api/import/status');
  },
  async importTranscript(transcript, project = null) {
    return jfetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, ...(project ? { project } : {}) }),
    });
  },
  async chat(instruction, history, focus = null, project = null) {
    return jfetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.source, instruction, history, focus, ...(project ? { project } : {}) }),
    });
  },
  async getSettings() {
    if (state.standalone) return null;
    return jfetch('/api/settings');
  },
  async saveSettings(patch) {
    return jfetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
  async transcribe(base64, mime) {
    return jfetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64, mime }),
    });
  },
  subscribe(onEvent) {
    if (state.standalone || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      try { onEvent(JSON.parse(msg.data)); } catch { /* ignore */ }
    };
    // EventSource auto-reconnects; nothing else to do.
  },
};
