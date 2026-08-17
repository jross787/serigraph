// The Quiet Instrument workbench: a compact tool rail, semantic path probe,
// review notes, portable sharing, and local revision recovery. None of these
// modes change the meaning of a map until the user explicitly saves a YAML edit.
import { state, bus, currentProjectSlug } from './state.js';
import { api } from './api.js';
import { parseMap } from '../shared/model.js';
import { buildHash } from './routes.js';
import * as canvas from './canvas.js';
import * as ctrl from './controller.js';
import * as workbenchSync from './workbench-sync.js';
import * as edit from './edit.js';
import * as ui from './ui.js';
import { ICONS } from './canvas.js';

const SVG = 'http://www.w3.org/2000/svg';

function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') n.className = value;
    else if (key.startsWith('on')) n.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) n.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    n.append(child.nodeType ? child : document.createTextNode(child));
  }
  return n;
}

function svgIcon(path) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', 'none');
  shape.setAttribute('stroke', 'currentColor');
  shape.setAttribute('stroke-width', '1.7');
  shape.setAttribute('stroke-linecap', 'round');
  shape.setAttribute('stroke-linejoin', 'round');
  svg.append(shape);
  return svg;
}

const TOOL_ICONS = {
  select: 'm4 3 11 6-5 1.4L8.5 16zM10 10.4l3 5.1',
  hand: 'M7.2 9.1V4.8a1.2 1.2 0 0 1 2.4 0v3.4M9.6 8.2V3.5a1.2 1.2 0 0 1 2.4 0v4.7m0 0V4.7a1.2 1.2 0 0 1 2.4 0v5.1m0 0V6.5a1.2 1.2 0 0 1 2.4 0v5.3c0 3-2.3 5.3-5.3 5.3H10c-1.7 0-2.9-.8-3.8-2.1L4.5 12a1.35 1.35 0 0 1 2-1.8l.7.7',
  unit: ICONS.process,
  connect: 'M4 4v4h4m8 8v-4h-4M8 8l4 4',
  lane: 'M4 3h12v14H4zM4 7h12M4 11h12',
  note: ICONS.artifact,
  probe: 'M10 3v14M3 10h14M6.5 6.5l7 7M13.5 6.5l-7 7',
  automate: ICONS.system,
  undo: 'M8 5 4 9l4 4M4 9h8a4 4 0 0 1 0 8H9',
  redo: 'M12 5l4 4-4 4M16 9H8a4 4 0 0 0 0 8h3',
};

const TOOL_GROUPS = [
  [
    { id: 'select', label: 'Select', shortcut: 'V', description: 'Select a step or drag to pan the map.' },
    { id: 'hand', label: 'Hand', shortcut: 'H', description: 'Pan the canvas without changing the selection.' },
  ],
  [
    { id: 'unit', label: 'Unit', shortcut: 'N', description: 'Add a process, decision, role, system, or artifact.', flyout: true },
    { id: 'connect', label: 'Connect', shortcut: 'C', description: 'Join two steps with a workflow connection.', flyout: true },
  ],
  [
    { id: 'lane', label: 'Owner lanes', shortcut: 'L', description: 'Group the current map by accountable owner.' },
    { id: 'note', label: 'Review note', shortcut: 'T', description: 'Leave a durable review note on a selected step.' },
  ],
  [
    { id: 'probe', label: 'Path probe', shortcut: 'P', description: 'Trace a path and reveal handoffs, systems, and automation gaps.' },
    { id: 'automate', label: 'Automation lens', shortcut: 'A', description: 'Assess the selected step as an automation opportunity.' },
  ],
];

const MUTATING_TOOLS = new Set(['unit', 'connect']);

// A standalone export is a portable, read-only inspection surface. Keep the
// tools that help a reviewer navigate and understand the map, but never render
// (or keyboard-activate) controls that imply the exported model can be edited.
function visibleToolGroups() {
  const freeform = state.model?.mode === 'freeform';
  const hiddenInFreeform = new Set(['lane', 'probe', 'automate']);
  return TOOL_GROUPS
    .map((group) => group
      .filter((tool) => !(freeform && hiddenInFreeform.has(tool.id)))
      .filter((tool) => !(state.standalone && MUTATING_TOOLS.has(tool.id)))
      .map((tool) => {
        if (state.standalone && tool.id === 'note') {
          return { ...tool, label: 'Review trail', description: `Inspect review notes attached to the selected ${freeform ? 'item' : 'step'}.` };
        }
        if (!freeform) return tool;
        if (tool.id === 'select') return { ...tool, description: 'Select an item or drag to pan the map.' };
        if (tool.id === 'unit') return { ...tool, label: 'Item', description: 'Add an item, system, database, API, person, or document.' };
        if (tool.id === 'connect') return { ...tool, description: 'Connect any two items.' };
        if (tool.id === 'note') return { ...tool, description: 'Leave a review note on the selected item.' };
        return tool;
      }))
    .filter((group) => group.length);
}

function toolIsVisible(id) {
  return visibleToolGroups().some((group) => group.some((tool) => tool.id === id));
}

let rail;

function closeFlyout() {
  document.getElementById('tool-flyout')?.replaceChildren();
  document.getElementById('tool-flyout')?.setAttribute('hidden', '');
}

function refreshRail() {
  if (!rail) return;
  for (const button of rail.querySelectorAll('[data-tool]')) {
    const id = button.dataset.tool;
    const pressed = id === 'lane' ? state.ownerLanes : state.activeTool === id;
    button.classList.toggle('active', pressed);
    button.setAttribute('aria-pressed', String(pressed));
  }
  document.getElementById('canvas')?.setAttribute('data-tool', state.activeTool);
}

function setTool(id) {
  state.activeTool = id;
  if (id !== 'probe') {
    state.probeStartId = null;
    canvas.setProbePath(null);
    hideProbePanel();
  }
  if (id !== 'connect' && state.connectFrom) {
    state.connectFrom = null;
    state.pendingEdgeLabel = null;
    canvas.paintSelection();
  }
  refreshRail();
}

function showUnitFlyout(anchor) {
  const host = document.getElementById('tool-flyout');
  if (!host) return;
  const freeform = state.model?.mode === 'freeform';
  const rect = anchor.getBoundingClientRect();
  host.style.top = `${rect.top}px`;
  host.style.left = `${rect.right + 8}px`;
  const types = freeform
    ? [['item', 'Item'], ['system', 'System'], ['database', 'Database'], ['api', 'API'], ['role', 'Person / team'], ['artifact', 'Document']]
    : [['process', 'Process'], ['decision', 'Decision'], ['role', 'Role'], ['system', 'System'], ['artifact', 'Artifact']];
  const items = types.map(([type, label]) => {
    const button = h('button', {
      class: `tool-flyout-item t-${type}`,
      title: `Drag onto the canvas to add a ${label.toLowerCase()}; click to open the form`,
    }, svgIcon(ICONS[type]), h('span', {}, label));
    ui.enableNodeTypeDrag(button, type, {
      onActivate: () => {
        closeFlyout();
        ui.addNodeDialog(state.scopeId, { type });
        setTool('select');
      },
      onComplete: () => {
        closeFlyout();
        setTool('select');
      },
    });
    return button;
  });
  host.replaceChildren(
    h('div', { class: 'tool-flyout-title' }, freeform ? 'Add an item' : 'Add a unit'),
    ...items,
  );
  host.removeAttribute('hidden');
}

function showConnectFlyout(anchor) {
  const host = document.getElementById('tool-flyout');
  if (!host) return;
  const freeform = state.model?.mode === 'freeform';
  const rect = anchor.getBoundingClientRect();
  host.style.top = `${rect.top}px`;
  host.style.left = `${rect.right + 8}px`;
  host.replaceChildren(
    h('div', { class: 'tool-flyout-title' }, freeform ? 'Connect items' : 'Connect steps'),
    h('button', { class: 'tool-flyout-item selected', onClick: () => { closeFlyout(); startConnect(); } },
      svgIcon(TOOL_ICONS.connect), h('span', {}, freeform ? 'Connection' : 'Workflow handoff'), h('kbd', {}, 'C')),
    h('p', { class: 'tool-flyout-note' }, freeform
      ? 'Select one item, then the item it connects to. Use the label to explain the relationship.'
      : 'Select an origin, then the step that follows it. Edge labels can describe the handoff or outcome.'),
  );
  host.removeAttribute('hidden');
}

function activateTool(id, anchor) {
  if (!toolIsVisible(id)) {
    closeFlyout();
    return false;
  }
  if (id === 'unit') {
    setTool('unit');
    showUnitFlyout(anchor);
    return true;
  }
  if (id === 'connect') {
    setTool('connect');
    showConnectFlyout(anchor);
    return true;
  }
  closeFlyout();
  if (id === 'lane') {
    state.ownerLanes = !state.ownerLanes;
    canvas.setOwnerLanes(state.ownerLanes);
    ui.toast(state.ownerLanes ? 'Owner lanes are on' : 'Owner lanes are off');
    refreshRail();
    return true;
  }
  if (id === 'note') {
    setTool('note');
    if (state.selectedId) openReview(state.selectedId);
    else {
      const selection = state.model?.mode === 'freeform' ? 'an item' : 'a step';
      ui.toast(state.standalone ? `Select ${selection} to inspect its review trail` : `Select ${selection} before leaving a review note`);
    }
    return true;
  }
  if (id === 'probe') {
    beginProbe();
    return true;
  }
  if (id === 'automate') {
    setTool('automate');
    if (ui.openAutomation()) setTool('select');
    return true;
  }
  setTool(id);
  return true;
}

function startConnect(nodeId = state.selectedId) {
  if (!ui.startConnect(nodeId)) return;
  setTool('connect');
  closeFlyout();
}

function beginProbe() {
  closeFlyout();
  state.probeStartId = null;
  canvas.setProbePath(null);
  hideProbePanel();
  state.activeTool = 'probe';
  refreshRail();
  ui.toast('Path probe: choose the first step, then its downstream outcome');
}

function scopeForCurrentView() {
  return state.scopeId == null ? state.model?.root : state.model?.byId.get(state.scopeId)?.children;
}

function findDirectedPath(fromId, toId) {
  const scope = scopeForCurrentView();
  if (!scope) return null;
  const edges = scope.edges.map((edge, index) => ({ edge, index }));
  const next = new Map();
  for (const item of edges) {
    if (!next.has(item.edge.from)) next.set(item.edge.from, []);
    next.get(item.edge.from).push(item);
  }
  const queue = [fromId];
  const visited = new Set([fromId]);
  const predecessor = new Map();
  while (queue.length) {
    const id = queue.shift();
    if (id === toId) break;
    for (const item of next.get(id) ?? []) {
      if (visited.has(item.edge.to)) continue;
      visited.add(item.edge.to);
      predecessor.set(item.edge.to, { from: id, index: item.index });
      queue.push(item.edge.to);
    }
  }
  if (!visited.has(toId)) return null;
  const nodeIds = [toId];
  const edgeIndexes = [];
  for (let cursor = toId; cursor !== fromId;) {
    const prior = predecessor.get(cursor);
    if (!prior) return null;
    edgeIndexes.unshift(prior.index);
    nodeIds.unshift(prior.from);
    cursor = prior.from;
  }
  return { nodeIds, edgeIndexes };
}

function renderProbePanel(path) {
  const panel = document.getElementById('probe-panel');
  if (!panel) return;
  const nodes = path.nodeIds.map((id) => state.model.byId.get(id)).filter(Boolean);
  const handoffs = nodes.slice(1).reduce((total, node, index) => {
    const prior = nodes[index];
    return total + (prior?.owner && node?.owner && prior.owner !== node.owner ? 1 : 0);
  }, 0);
  const systems = nodes.filter((node) => node.type === 'system').length;
  const manual = nodes.filter((node) => ['manual', 'at-risk'].includes(node.automation)).length;
  panel.replaceChildren(
    h('div', { class: 'probe-head' },
      h('div', {}, h('span', {}, 'Path probe'), h('strong', {}, `${nodes[0]?.label} → ${nodes[nodes.length - 1]?.label}`)),
      h('button', { title: 'Clear path probe', onClick: () => { setTool('select'); } }, 'Close')),
    h('div', { class: 'probe-metrics' },
      h('div', {}, h('strong', {}, String(Math.max(0, nodes.length - 1))), h('span', {}, 'handoffs')),
      h('div', {}, h('strong', {}, String(handoffs)), h('span', {}, 'owner changes')),
      h('div', {}, h('strong', {}, String(systems)), h('span', {}, 'systems')),
      h('div', {}, h('strong', {}, String(manual)), h('span', {}, 'manual / at risk'))),
    h('p', {}, manual ? 'The highlighted path has automation gaps worth reviewing.' : 'This path has no manually flagged steps.'),
  );
  panel.hidden = false;
}

function hideProbePanel() {
  const panel = document.getElementById('probe-panel');
  if (panel) panel.hidden = true;
}

function reviewKey(nodeId) {
  return `${state.mapId || 'map'}:${nodeId}`;
}

function formatReviewDate(value) {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function closeReview() {
  const tray = document.getElementById('review-tray');
  if (tray) tray.hidden = true;
}

export function openReview(nodeId = state.selectedId) {
  const node = nodeId ? state.model?.byId.get(nodeId) : null;
  const selection = state.model?.mode === 'freeform' ? 'an item' : 'a step';
  if (!node) {
    ui.toast(state.standalone ? `Select ${selection} to inspect its review trail` : `Select ${selection} before leaving a review note`);
    return;
  }
  const tray = document.getElementById('review-tray');
  if (!tray) return;
  const notes = [...(node.review ?? [])].sort((a, b) => Number(a.resolved) - Number(b.resolved));
  const openCount = notes.filter((note) => !note.resolved).length;
  const textarea = h('textarea', { placeholder: state.model?.mode === 'freeform' ? 'What should the owner review?' : 'What should the process owner review?', 'aria-label': 'Review note' });
  const list = h('div', { class: 'review-list' }, notes.length ? notes.map((note) =>
    h('article', { class: `review-note${note.resolved ? ' resolved' : ''}` },
      h('div', { class: 'review-note-meta' }, h('strong', {}, note.author), h('span', {}, formatReviewDate(note.createdAt))),
      h('p', {}, note.body),
      state.standalone ? null : h('button', { class: 'review-resolve', onClick: () => {
        ctrl.commit(() => edit.setReviewResolved(node.id, note.id, !note.resolved)).then((ok) => { if (ok) openReview(node.id); });
      } }, note.resolved ? 'Reopen' : 'Resolve')),
    ) : h('div', { class: 'review-empty' }, 'No review notes yet. Capture a decision, question, or risk here.'));
  tray.replaceChildren(
    h('div', { class: 'review-head' },
      h('div', {}, h('span', {}, 'Review trail'), h('h2', {}, node.label), h('small', {}, `${openCount} open ${openCount === 1 ? 'note' : 'notes'}`)),
      h('button', { title: 'Close review trail', onClick: closeReview }, 'Close')),
    list,
    state.standalone ? null : h('div', { class: 'review-compose' }, textarea,
      h('button', { onClick: () => {
        ctrl.commit(() => edit.addReviewComment(node.id, { body: textarea.value })).then((ok) => { if (ok) openReview(node.id); });
      } }, 'Add note')),
  );
  tray.dataset.review = reviewKey(node.id);
  tray.hidden = false;
  textarea.focus();
}

function makeDialog(title, body) {
  const root = document.getElementById('dialog-root');
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'dialog-backdrop workbench-backdrop', onPointerdown: (event) => { if (event.target === backdrop) close(); } },
    h('section', { class: 'dialog workbench-dialog', role: 'dialog', 'aria-label': title },
      h('div', { class: 'workbench-dialog-head' }, h('h2', {}, title), h('button', { onClick: close, title: 'Close' }, 'Close')),
      body));
  root.append(backdrop);
  return close;
}

async function copyText(text) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { style: 'position:fixed;left:-9999px' }, text);
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    return !!ok;
  }
}

export function openShareDialog() {
  const nodeId = state.selectedId;
  const link = nodeId ? ctrl.nodeUrl(nodeId) : `${location.origin}${location.pathname}${buildHash({ mapId: state.mapId })}`;
  const item = state.model?.mode === 'freeform' ? 'item' : 'step';
  const body = h('div', { class: 'share-stack' });
  makeDialog('Share & sync', body);

  const localSection = () => {
    const input = h('input', { class: 'f-input', value: link, readonly: '' });
    return h('section', { class: 'share-section' },
      h('div', { class: 'share-section-head' }, h('h3', {}, 'Local link'), h('span', { class: 'access-badge' }, 'This computer')),
      h('p', { class: 'hint' }, `A deep link opens the selected ${item} in context. The map source remains portable YAML.`),
      h('div', { class: 'share-link' }, input,
        h('button', { class: 'd-btn primary', onClick: async () => { if (await copyText(link)) ui.toast('Link copied'); } }, 'Copy link')),
      h('div', { class: 'share-actions' },
        h('button', { class: 'd-btn', onClick: downloadYaml }, 'Download YAML'),
        h('button', { class: 'd-btn', onClick: () => { if (state.mapId) window.location.href = `/export/${encodeURIComponent(state.mapId)}.html`; } }, 'Download standalone app')));
  };

  const renderShareResult = (container, share) => {
    const input = h('input', { class: 'f-input', value: share.url, readonly: '' });
    container.replaceChildren(
      h('p', { class: 'hint' }, `${share.role[0].toUpperCase()}${share.role.slice(1)} link ready.`),
      h('div', { class: 'share-link' }, input,
        h('button', { class: 'd-btn primary', onClick: async () => { if (await copyText(share.url)) ui.toast('Workbench link copied'); } }, 'Copy link')),
      h('button', {
        class: 'd-btn agent-link-button',
        onClick: async () => { if (await copyText(share.agentUrl)) ui.toast('Workbench agent link copied'); },
      }, 'Copy agent link'));
  };

  const connectedSection = (connection) => {
    const result = h('div', { class: 'workbench-share-result' });
    const role = h('select', { class: 'f-input workbench-role', 'aria-label': 'Workbench access' },
      h('option', { value: 'view' }, 'Can view'),
      h('option', { value: 'comment' }, 'Can comment'),
      h('option', { value: 'suggest' }, 'Can suggest'),
      h('option', { value: 'edit' }, 'Can edit'));
    const stateLabel = connection.conflict ? 'Needs a choice' : connection.syncing ? 'Syncing' : 'Connected';
    return h('section', { class: `share-section workbench-sync-card${connection.conflict ? ' conflict' : ''}` },
      h('div', { class: 'share-section-head' },
        h('h3', {}, 'Workbench sync'),
        h('span', { class: 'access-badge' }, `${connection.role} access`)),
      h('p', { class: 'workbench-doc-name' }, connection.title || connection.docId),
      h('p', { class: 'hint' }, `${stateLabel}. The share key stays in this browser and is never written into the YAML or Workbench document.`),
      connection.conflict
        ? h('div', { class: 'workbench-choice' },
          h('p', {}, connection.remoteMissing
            ? 'The map section was removed from Workbench after the local map changed.'
            : 'The local and Workbench copies both changed. Choose which map to keep.'),
          h('div', { class: 'share-actions' },
            connection.remoteMissing
              ? h('button', { class: 'd-btn', onClick: () => { workbenchSync.disconnectWorkbench('Kept the local map and disconnected Workbench.'); render(); } }, 'Keep local only')
              : h('button', { class: 'd-btn', onClick: async () => { if (await workbenchSync.useWorkbenchCopy()) render(); } }, 'Use Workbench copy'),
            connection.role === 'edit'
              ? h('button', { class: 'd-btn primary', onClick: async () => { if (await workbenchSync.sendLocalCopy()) render(); } }, 'Publish local copy')
              : null))
        : null,
      h('div', { class: 'share-actions' },
        h('button', { class: 'd-btn', onClick: () => window.open(connection.url, '_blank', 'noopener,noreferrer') }, 'Open Workbench'),
        h('button', { class: 'd-btn', onClick: async () => { await workbenchSync.syncNow(); render(); } }, 'Sync now')),
      h('button', { class: 'd-btn disconnect-workbench', onClick: () => { workbenchSync.disconnectWorkbench(); render(); } }, 'Disconnect'),
      connection.role === 'edit'
        ? h('div', { class: 'workbench-share-maker' },
          h('h4', {}, 'Create a Workbench link'),
          h('p', { class: 'hint' }, 'Workbench enforces the selected access level for people and agents.'),
          h('div', { class: 'share-link' }, role,
            h('button', {
              class: 'd-btn primary',
              onClick: async () => {
                try { renderShareResult(result, await api.createWorkbenchShare(connection.url, role.value)); }
                catch (error) { ui.toast(`Could not create link: ${error.message}`, true); }
              },
            }, 'Create link')),
          result)
        : null);
  };

  const unlinkedSection = (pending = null, priorUrl = '') => {
    const input = h('input', {
      class: 'f-input',
      type: 'url',
      value: priorUrl,
      placeholder: 'https://workbench.md/d/…?key=…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Workbench share link',
    });
    const connect = async (strategy = 'match') => {
      const url = input.value.trim();
      if (!url) return;
      try {
        const info = pending?.url === url ? pending.info : await workbenchSync.inspectLink(url);
        const result = await workbenchSync.connectLink(url, info, strategy);
        if (result.needsChoice) render({ url, info: result.info });
        else render();
      } catch (error) {
        ui.toast(`Could not link Workbench: ${error.message}`, true);
      }
    };
    return h('section', { class: 'share-section workbench-sync-card' },
      h('div', { class: 'share-section-head' }, h('h3', {}, 'Workbench sync'), h('span', { class: 'access-badge' }, 'Private by default')),
      h('p', { class: 'hint' }, 'Link this map to a Workbench document. Workbench supplies view, comment, suggest, and edit permissions while Serigraph keeps the YAML portable.'),
      h('div', { class: 'share-link' }, input,
        h('button', { class: 'd-btn primary', onClick: () => connect() }, 'Link')),
      pending
        ? h('div', { class: 'workbench-choice' },
          h('p', {}, 'That document already contains a different Serigraph map.'),
          h('div', { class: 'share-actions' },
            h('button', { class: 'd-btn', onClick: () => connect('pull') }, 'Use Workbench map'),
            pending.info.role === 'edit'
              ? h('button', { class: 'd-btn primary', onClick: () => connect('push') }, 'Publish this map')
              : null))
        : null);
  };

  function render(pending = null) {
    body.replaceChildren(localSection(), ...(state.standalone ? [] : [state.workbench
      ? connectedSection(state.workbench)
      : unlinkedSection(pending, pending?.url || '')]));
  }
  render();
}

export function downloadYaml() {
  if (!state.source) return;
  const blob = new Blob([state.source], { type: 'text/yaml;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = h('a', { href, download: `${(state.mapId || 'serigraph').replace(/\//g, '-')}.yaml` });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  ui.toast('YAML downloaded');
}

// Import a Serigraph YAML source as a new map. The source is validated
// before anything is written; a name collision gets a numeric suffix.
export async function importMapSource(filename, source) {
  const { model, errors } = parseMap(source);
  if (errors.length) {
    makeDialog('That file is not a valid map', h('div', {},
      h('p', { class: 'hint' }, `${filename} needs these fixes before it can open:`),
      h('ul', { class: 'err-list' }, errors.slice(0, 12).map((e) => h('li', {},
        e.line ? h('span', { class: 'ln' }, `line ${e.line}`) : null, e.message)))));
    return false;
  }
  const taken = new Set((await api.listMaps().catch(() => [])).map((m) => m.id));
  const base = edit.slugify(filename.replace(/\.ya?ml$/i, '')) || edit.slugify(model.name) || 'imported-map';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  // Inside a project, import into that project: the id carries the prefix.
  const project = currentProjectSlug();
  if (project) id = `${project}/${id}`;
  try {
    await api.saveMap(id, source);
  } catch (e) {
    ui.toast(`Import failed: ${e.message}`, true);
    return false;
  }
  await ctrl.loadMapList();
  await ctrl.openMap(id);
  ui.toast(`Imported ${filename}`);
  return true;
}

// Open a Serigraph YAML file from disk.
export function importMapFile() {
  if (state.standalone) { ui.toast('Imports need the local Serigraph server.', true); return; }
  const input = h('input', { type: 'file', accept: '.yaml,.yml' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await importMapSource(file.name, await file.text());
  });
  input.click();
}

// AI settings: provider, keys, and models. Keys are written to the server's
// .env (gitignored) and never come back — the dialog shows only saved/not.
const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  openrouter: ['openai/gpt-4o', 'anthropic/claude-opus-4', 'google/gemini-2.5-pro'],
  venice: ['llama-3.3-70b', 'qwen-2.5-coder-32b', 'deepseek-r1-671b'],
  cli: ['opus', 'sonnet'],
};
const VOICE_MODEL_SUGGESTIONS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];

export async function aiSettingsDialog() {
  if (state.standalone) { ui.toast('AI settings need the local Serigraph server.', true); return; }
  const s = await ctrl.loadAiSettings(true);
  if (!s) { ui.toast('Could not reach the Serigraph server.', true); return; }

  const provider = h('select', { class: 'f-select' },
    ...[['auto', 'Auto — first key found'], ['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'], ['venice', 'Venice.ai'], ['cli', 'Claude CLI — no key']].map(([v, label]) => h('option', { value: v }, label)));
  provider.value = s.provider;

  const keyField = (field, label, isSet) => {
    const input = h('input', { class: 'f-input', type: 'password', autocomplete: 'off', placeholder: isSet ? 'Saved — type a new key to replace it' : 'Not set — paste the key here' });
    return { field, input, row: h('div', { class: 'f-field' }, h('label', {}, label), input) };
  };
  const keys = [
    keyField('veniceKey', 'Venice.ai API key', s.veniceKeySet),
    keyField('openaiKey', 'OpenAI API key', s.openaiKeySet),
    keyField('openrouterKey', 'OpenRouter API key', s.openrouterKeySet),
    keyField('anthropicKey', 'Anthropic API key', s.anthropicKeySet),
  ];

  const modelList = h('datalist', { id: 'ai-model-list' });
  const model = h('input', { class: 'f-input', list: 'ai-model-list', placeholder: 'Provider default', value: s.model || '' });
  const syncSuggestions = () => {
    modelList.replaceChildren(...(MODEL_SUGGESTIONS[provider.value] ?? []).map((m) => h('option', { value: m })));
  };
  provider.addEventListener('change', syncSuggestions);
  syncSuggestions();

  const voiceProvider = h('select', { class: 'f-select' },
    h('option', { value: 'browser' }, 'Browser built-in — free, on this machine'),
    h('option', { value: 'api' }, 'API transcription — uses your key'));
  voiceProvider.value = s.voiceProvider;
  const voiceList = h('datalist', { id: 'ai-voice-model-list' }, VOICE_MODEL_SUGGESTIONS.map((m) => h('option', { value: m })));
  const voiceModel = h('input', { class: 'f-input', list: 'ai-voice-model-list', placeholder: 'whisper-1', value: s.voiceModel || '' });
  const voiceModelRow = h('div', { class: 'f-field' }, h('label', {}, 'Voice model'), voiceModel, voiceList);
  const syncVoice = () => { voiceModelRow.style.display = voiceProvider.value === 'api' ? '' : 'none'; };
  voiceProvider.addEventListener('change', syncVoice);
  syncVoice();

  const close = makeDialog('AI settings', h('div', { class: 'share-stack' },
    h('div', { class: 'f-field' }, h('label', {}, 'Provider'), provider),
    ...keys.map((k) => k.row),
    h('div', { class: 'f-field' }, h('label', {}, 'Chat model'), model, modelList),
    h('div', { class: 'f-field' }, h('label', {}, 'Voice input'), voiceProvider),
    voiceModelRow,
    h('p', { class: 'hint' }, 'Keys are stored in the .env file on this machine and never sent back to the browser.'),
    h('div', { class: 'dialog-actions' },
      h('button', {
        class: 'd-btn primary',
        onClick: async () => {
          const patch = { provider: provider.value, model: model.value, voiceProvider: voiceProvider.value, voiceModel: voiceModel.value };
          for (const k of keys) if (k.input.value.trim()) patch[k.field] = k.input.value.trim();
          try {
            state.aiSettings = await api.saveSettings(patch);
            close();
            ui.toast('AI settings saved');
          } catch (e) {
            ui.toast(e.message, true);
          }
        },
      }, 'Save'))));
}

export function openHistory() {  const revisions = ctrl.listRevisions();
  const body = h('div', { class: 'history-list' }, revisions.length
    ? revisions.slice(0, 12).map((revision, index) => h('div', { class: 'history-row' },
      h('div', {}, h('strong', {}, revision.label || 'Edited map'), h('small', {}, formatReviewDate(revision.savedAt))),
      state.standalone ? null : h('button', { class: 'd-btn', onClick: () => ctrl.restoreRevision(revision) }, index === 0 ? 'Restore' : 'Restore')))
    : h('p', { class: 'hint' }, 'Your next map edit creates a local recovery point. The latest 30 are kept in this browser.'));
  makeDialog('Revision recovery', body);
}

export function handleNodeClick(nodeId) {
  if (!state.model) return false;
  if (state.activeTool === 'hand') return true;
  if (state.activeTool === 'note') { openReview(nodeId); return true; }
  if (state.activeTool === 'automate') { ui.openAutomation(nodeId); setTool('select'); return true; }
  if (state.activeTool !== 'probe') {
    if (state.activeTool === 'connect' && !state.connectFrom) {
      startConnect(nodeId);
      return true;
    }
    return false;
  }
  if (!state.probeStartId) {
    state.probeStartId = nodeId;
    canvas.setProbePath(null);
    ui.toast('Now choose a downstream outcome');
    return true;
  }
  if (nodeId === state.probeStartId) {
    ui.toast('Choose a different downstream step');
    return true;
  }
  const path = findDirectedPath(state.probeStartId, nodeId);
  if (!path) {
    ui.toast('No downstream path connects those two steps', true);
    return true;
  }
  state.probeStartId = null;
  canvas.setProbePath(path);
  renderProbePanel(path);
  return true;
}

export function completeConnect() {
  if (state.activeTool === 'connect') setTool('select');
}

// Escape should always return the canvas to its neutral, unsurprising state.
// This is intentionally exported rather than duplicating state resets in the
// keyboard handler so pointer and keyboard flows cannot get out of sync.
export function cancelTool() {
  closeFlyout();
  closeReview();
  setTool('select');
}

function renderRail() {
  if (!rail) return;
  if (!toolIsVisible(state.activeTool)) state.activeTool = 'select';
  const freeform = state.model?.mode === 'freeform';
  rail.replaceChildren(...visibleToolGroups().flatMap((group, groupIndex) => [
    groupIndex ? h('div', { class: 'tool-separator' }) : null,
    ...group.map((tool) => h('button', {
      class: 'tool-button',
      'data-tool': tool.id,
      'aria-label': `${tool.label} (${tool.shortcut})`,
      title: `${tool.label} · ${tool.shortcut}\n${tool.description}`,
      onClick: (event) => activateTool(tool.id, event.currentTarget),
    }, svgIcon(tool.id === 'unit' && freeform ? ICONS.item : TOOL_ICONS[tool.id]), tool.flyout ? h('i', { class: 'tool-caret' }) : null)),
  ].filter(Boolean)),
  // history actions, not tools: they never change the active tool
  h('div', { class: 'tool-separator' }),
  ...[['undo', 'Undo', '⌘Z'], ['redo', 'Redo', '⌘⇧Z']].map(([id, label, keys]) => h('button', {
    class: 'tool-button tool-action',
    'data-action': id,
    'aria-label': `${label} (${keys})`,
    title: `${label} · ${keys}`,
    disabled: state.standalone || !(id === 'undo' ? state.undoStack.length : state.redoStack.length) ? '' : null,
    onClick: () => (id === 'undo' ? ctrl.undo() : ctrl.redo()),
  }, svgIcon(TOOL_ICONS[id]))));
  refreshRail();
}

export function initWorkbench() {
  rail = document.getElementById('tool-rail');
  if (!rail) return;
  renderRail();
  bus.on('selection-changed', refreshRail);
  bus.on('view-changed', () => { closeFlyout(); closeReview(); setTool('select'); renderRail(); });
  document.addEventListener('pointerdown', (event) => {
    const flyout = document.getElementById('tool-flyout');
    if (flyout && !flyout.hidden && !flyout.contains(event.target) && !rail?.contains(event.target)) closeFlyout();
  });
}

export function shortcutTool(key) {
  const normalized = String(key || '').toLowerCase();
  const tool = visibleToolGroups().flat().find((item) => item.shortcut.toLowerCase() === normalized);
  if (!tool) return false;
  const button = rail?.querySelector(`[data-tool="${tool.id}"]`);
  return activateTool(tool.id, button);
}
