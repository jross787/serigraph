// Who else has this map open. Maps in a shared cloud folder show each other
// person as initials in the top bar; hovering names them and says whether
// they are editing. Records travel through the cloud drive, so they can lag
// by a few seconds.
import { api } from './api.js';
import { state, bus } from './state.js';

let openMapId = null;
let lastEdit = 0;

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function hue(name) {
  let sum = 0;
  for (const char of String(name)) sum = (sum * 31 + char.charCodeAt(0)) % 360;
  return sum;
}

function render() {
  let host = document.getElementById('presence');
  if (!host) {
    host = document.createElement('div');
    host.id = 'presence';
    host.setAttribute('aria-label', 'People with this map open');
    document.getElementById('map-switcher')?.after(host);
  }
  const people = state.mapId ? state.collaborators ?? [] : [];
  host.hidden = !people.length;
  host.replaceChildren(...people.map((person) => {
    const badge = document.createElement('span');
    badge.className = `presence-avatar${person.editing ? ' editing' : ''}`;
    badge.style.setProperty('--presence-hue', hue(person.person));
    badge.textContent = initials(person.person);
    badge.title = `${person.person}${person.machine ? ` · ${person.machine}` : ''} · ${person.editing ? 'editing now' : 'viewing'}`;
    return badge;
  }));
}

async function beat() {
  if (!state.mapId || state.standalone) return;
  const id = state.mapId;
  try {
    const { people = [], shared = false } = await api.presence(id, { editing: Date.now() - lastEdit < 60_000 });
    if (state.mapId !== id) return;
    state.collaborators = people;
    state.mapShared = shared;
  } catch { state.collaborators = []; }
  render();
}

function leave(id, keepalive = false) {
  if (id) api.presence(id, { leave: true }, keepalive).catch(() => {});
}

export function initPresence() {
  if (state.standalone) return;
  bus.on('map-opened', () => {
    if (openMapId && openMapId !== state.mapId) leave(openMapId);
    openMapId = state.mapId;
    state.collaborators = [];
    render();
    beat();
  });
  bus.on('view-changed', () => {
    if (state.mapId || !openMapId) return;
    leave(openMapId);
    openMapId = null;
    state.collaborators = [];
    render();
  });
  bus.on('map-saved', () => { lastEdit = Date.now(); beat(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
  window.addEventListener('pagehide', () => leave(openMapId, true));
  setInterval(() => { if (document.visibilityState === 'visible') beat(); }, 20_000);
}
