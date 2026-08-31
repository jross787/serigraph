// All chrome around the canvas: detail panel, dialogs, template browser,
// search palette, breadcrumbs, map switcher, toasts, error/empty states.
import {
  parseMap, NODE_TYPES, PROCESS_NODE_TYPES, FREEFORM_NODE_TYPES, AUTOMATION_STATES,
  PLANNING_TYPES, PLAN_STATUSES, PLAN_PRIORITIES, RELATION_TYPES, HIERARCHY_RELATION_TYPES,
  OWNER_ROLES, ancestryOf, placementInScope, placementsOf,
} from '../shared/model.js';
import { nodeCost, rollupCost, formatMoney, formatPayback, formatPercent, compactMoney } from '../shared/cost.js';
import { mapProjectTag } from '../shared/projects.js';
import { api } from './api.js';
import { state, bus, currentProjectSlug } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import * as canvas from './canvas.js';
import { ICONS } from './canvas.js';
import { opportunityDefaults, calculateOpportunity, assessOpportunity } from './opportunity.js';
import { disconnectWorkbenchLink, useWorkbenchCopy, sendLocalCopy } from './workbench-sync.js';

let fieldId = 0;

const TYPE_LABELS = {
  process: 'Process',
  decision: 'Decision',
  system: 'System',
  role: 'Role',
  artifact: 'Artifact',
  item: 'Item',
  database: 'Database',
  api: 'API',
};
const FREEFORM_TYPE_LABELS = { role: 'Person / team', artifact: 'Document' };
const isFreeform = () => state.model?.mode === 'freeform';
const activeNodeTypes = () => isFreeform() ? FREEFORM_NODE_TYPES : PROCESS_NODE_TYPES;
const typeLabel = (type) => isFreeform() ? (FREEFORM_TYPE_LABELS[type] ?? TYPE_LABELS[type] ?? type) : (TYPE_LABELS[type] ?? type);

// ── tiny DOM helpers ─────────────────────────────────────────────────
function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

function associateFieldLabels(root) {
  for (const field of root.querySelectorAll('.f-field')) {
    const label = field.querySelector('label');
    const control = field.querySelector('input, textarea, select');
    if (!label || !control) continue;
    if (!control.id) control.id = `serigraph-field-${++fieldId}`;
    label.htmlFor = control.id;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
function typeIcon(type, size = 14) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', ICONS[type] ?? ICONS.process);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

// ── toasts ───────────────────────────────────────────────────────────
export function toast(msg, isError = false, action = null) {
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  };
  const actionButton = action?.label && typeof action.onClick === 'function'
    ? h('button', {
        class: 'toast-action',
        onClick: () => {
          clearTimeout(timer);
          t.remove();
          action.onClick();
        },
      }, action.label)
    : null;
  const t = h('div', { class: `toast${isError ? ' error' : ''}` },
    h('span', {}, msg),
    actionButton);
  document.getElementById('toasts').append(t);
  timer = setTimeout(dismiss, actionButton ? 6500 : isError ? 5000 : 2400);
}
bus.on('toast', toast);

// ── breadcrumbs + map switcher ──────────────────────────────────────
function renderBreadcrumbs() {
  const nav = document.getElementById('breadcrumbs');
  nav.replaceChildren();
  if (!state.model || state.scopeId == null) return; // at root the switcher already names the map
  const chain = ancestryOf(state.model, state.scopeId);
  const parts = [{ id: null, label: state.model.name }, ...chain.map((id) => ({ id, label: state.model.byId.get(id)?.label ?? id }))];
  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1;
    if (i) nav.append(h('span', { class: 'crumb-sep' }, '›'));
    const b = h('button', {
      class: `crumb${isLast ? ' current' : ''}`,
      title: part.label,
    }, part.label);
    if (!isLast) b.addEventListener('click', () => ctrl.gotoScope(part.id));
    nav.append(b);
  });
}


function renderSwitcher() {
  const nameEl = document.getElementById('map-switcher-name');
  if (!nameEl) return;
  if (!state.mapId) { nameEl.replaceChildren(); nameEl.textContent = 'All maps'; return; }
  const current = state.maps.find((m) => m.id === state.mapId);
  const mapName = current?.name ?? state.model?.name ?? state.mapId ?? 'No map';
  const projectName = current?.project?.name;
  nameEl.replaceChildren();
  if (projectName) {
    const link = h('button', { class: 'switcher-project', title: `Open the ${projectName} project` }, projectName);
    link.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.standalone) return; // exports are single-map, read-only
      homeFilter = current.project.slug;
      ctrl.goHome();
    });
    nameEl.append(link, h('span', { class: 'switcher-sep' }, '/'), h('span', {}, mapName));
  } else {
    nameEl.textContent = mapName;
  }
}

function renderMapMode() {
  closeMenus();
  const button = document.getElementById('map-mode');
  const label = document.getElementById('map-mode-label');
  const freeform = isFreeform();
  if (button) {
    button.hidden = !state.model;
    button.classList.toggle('freeform', freeform);
    button.title = freeform ? 'Freeform map. Choose another mode' : 'Process map. Choose another mode';
  }
  if (label) label.textContent = freeform ? 'Freeform' : 'Process';
  const workspaces = document.getElementById('workspace-switcher');
  if (workspaces) workspaces.hidden = freeform || !state.model;
  const economics = document.getElementById('btn-economics');
  if (economics) economics.hidden = freeform;
  if (freeform && state.workspaceView !== 'map') bus.emit('workspace-map-request');
  const templates = document.getElementById('templates-panel');
  if (templates && !templates.hidden) renderTemplates();
}

function openModeMenu(anchor) {
  if (!state.model || state.standalone) return;
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu mode-menu', role: 'menu', style: `top:${r.bottom + 6}px;left:${r.left}px` });
  const modes = [
    ['process', 'Process', 'Steps, decisions, owners, automation, and cost.'],
    ['freeform', 'Freeform', 'Systems, data, APIs, people, or anything else.'],
  ];
  for (const [mode, label, description] of modes) {
    menu.append(h('button', {
      class: `menu-item${state.model.mode === mode ? ' current' : ''}`,
      role: 'menuitemradio',
      'aria-checked': String(state.model.mode === mode),
      onClick: () => {
        closeMenus();
        if (state.model.mode === mode) return;
        ctrl.commit(() => edit.setMapMode(mode)).then((ok) => {
          if (!ok) return;
          ctrl.loadMapList();
          toast(`${label} mode on`);
        });
      },
    }, h('span', { class: 'mi-name' }, label), h('span', { class: 'mi-sub' }, description)));
  }
  document.body.append(menu);
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) closeMenus(); };
    document.addEventListener('pointerdown', close, { once: true });
  }, 0);
}

function openMapMenu(anchor) {
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu', style: `top:${r.bottom + 6}px;left:${r.left}px` });

  const item = (m) => {
    const isCurrent = m.id === state.mapId;
    // In a standalone export, sibling project maps are listed read-only —
    // the bundle carries their summaries, not their sources.
    const readOnlySibling = state.standalone && !isCurrent;
    const row = h('button', {
      class: `menu-item${isCurrent ? ' current' : ''}${m.invalid ? ' invalid' : ''}`,
      ...(readOnlySibling ? { disabled: '', title: 'Read-only in this export' } : {}),
      onClick: () => { if (readOnlySibling) return; closeMenus(); ctrl.openMap(m.id); },
    },
    h('span', { class: 'mi-name' }, m.name || m.id),
    h('span', { class: 'mi-sub' }, m.invalid ? `⚠ ${m.errorCount} problem${m.errorCount === 1 ? '' : 's'} — open to see details` : `${m.nodeCount} nodes`));
    if (!state.standalone) {
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        closeMenus();
        moveMapDialog(m);
      });
      row.append(h('span', {
        class: 'mi-move',
        title: 'Move to a project',
        onClick: (ev) => {
          ev.stopPropagation();
          closeMenus();
          moveMapDialog(m);
        },
      }, 'Move'));
      row.append(h('span', {
        class: 'mi-trash',
        title: 'Move to Trash',
        onClick: (ev) => {
          ev.stopPropagation();
          closeMenus();
          moveToTrashDialog('map', m);
        },
      }, 'Trash'));
    }
    return row;
  };

  // group by project, current project first, then alphabetical; root maps last
  const byProject = new Map();
  const rootMaps = [];
  for (const m of state.maps) {
    if (!m.project) { rootMaps.push(m); continue; }
    if (!byProject.has(m.project.slug)) byProject.set(m.project.slug, { name: m.project.name, maps: [] });
    byProject.get(m.project.slug).maps.push(m);
  }
  const currentSlug = currentProjectSlug();
  const groups = [...byProject.entries()].sort(([a], [b]) => {
    if (a === currentSlug) return -1;
    if (b === currentSlug) return 1;
    return (byProject.get(a).name ?? a).localeCompare(byProject.get(b).name ?? b);
  });
  for (const [slug, group] of groups) {
    const heading = state.standalone && slug === currentSlug ? `From this project — ${group.name ?? slug}` : (group.name ?? slug);
    menu.append(h('div', { class: `menu-group${slug === currentSlug ? ' current' : ''}` }, heading));
    for (const m of group.maps) menu.append(item(m));
  }
  if (rootMaps.length) {
    if (groups.length) menu.append(h('div', { class: 'menu-group' }, 'Ungrouped'));
    for (const m of rootMaps) menu.append(item(m));
  }

  if (!state.standalone) {
    menu.append(h('div', { class: 'menu-sep' }));
    menu.append(h('button', { class: 'menu-item', onClick: () => { closeMenus(); newMapDialog(); } },
      h('span', { class: 'mi-name' }, '+ New map…')));
    menu.append(h('button', { class: 'menu-item', onClick: () => { closeMenus(); newProjectDialog(); } },
      h('span', { class: 'mi-name' }, '+ New project…')));
  }
  document.body.append(menu);
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) closeMenus(); };
    document.addEventListener('pointerdown', close, { once: true });
  }, 0);
}
function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }

// ── projects home ────────────────────────────────────────────────────
// Route #/ — replaces the empty boot state. Cards per project, one tile per
// map; root maps group under "Ungrouped" at the bottom.
let homeFilter = null; // project slug when the home is scoped to one project
export function resetHomeFilter() { homeFilter = null; }

function mapStatusDot(m) {
  // red = invalid; amber = provenance flags or issue: edges; else green.
  // hasFlags/hasIssues come from the server summaries; undefined → false.
  if (m.invalid) return { cls: 'bad', label: 'Invalid — open to see the problems' };
  if (m.hasFlags || m.hasIssues) return { cls: 'warn', label: 'Has inferred flags or issue edges' };
  return { cls: 'ok', label: 'Valid' };
}

function projectIndexFor(slug) {
  const p = state.projects.find((item) => item.slug === slug);
  return p ? { name: p.name, description: p.description ?? null, order: p.order ?? [], tags: p.tags ?? {} } : null;
}

function mapTile(m, index) {
  const dot = mapStatusDot(m);
  const mapSlug = m.id.includes('/') ? m.id.split('/').pop() : m.id;
  const tag = index ? mapProjectTag(index, mapSlug) : null;
  const isCurrent = m.id === state.mapId;
  const readOnlySibling = state.standalone && !isCurrent;
  const tile = h('button', {
    class: 'proj-tile',
    ...(readOnlySibling ? { disabled: '', title: 'Read-only in this export' } : { title: dot.label }),
    onClick: () => { if (!readOnlySibling) ctrl.openMap(m.id); },
  },
  h('span', { class: 'proj-tile-top' },
    tag ? h('span', { class: 'proj-tag' }, tag) : null,
    h('span', { class: `proj-dot ${dot.cls}` })),
  h('span', { class: 'proj-tile-name' }, m.name || mapSlug),
  h('span', { class: 'proj-tile-meta' }, `${m.mode === 'freeform' ? 'Freeform' : 'Process'} · ${m.nodeCount ?? 0} nodes`));
  if (state.standalone) return tile;
  return h('div', { class: 'proj-tile-wrap' }, tile,
    h('button', {
      class: 'proj-tile-trash',
      title: `Move ${m.name || mapSlug} to Trash`,
      'aria-label': `Move ${m.name || mapSlug} to Trash`,
      onClick: () => moveToTrashDialog('map', m),
    }, 'Trash'));
}

function renderHome() {
  const host = document.getElementById('projects-home');
  if (!host) return;
  if (state.mapId) { host.hidden = true; return; }
  host.hidden = false;

  const rootMaps = state.maps.filter((m) => !m.project);
  const byProject = new Map();
  for (const m of state.maps) {
    if (!m.project) continue;
    if (!byProject.has(m.project.slug)) byProject.set(m.project.slug, []);
    byProject.get(m.project.slug).push(m);
  }
  // a project with zero maps still gets a card
  for (const p of state.projects) {
    if (!byProject.has(p.slug)) byProject.set(p.slug, []);
  }

  const orderedSlugs = [...byProject.keys()].sort((a, b) => {
    const an = state.projects.find((p) => p.slug === a)?.name ?? a;
    const bn = state.projects.find((p) => p.slug === b)?.name ?? b;
    return an.localeCompare(bn);
  });

  const visibleSlugs = homeFilter ? orderedSlugs.filter((s) => s === homeFilter) : orderedSlugs;

  const head = h('div', { class: 'proj-head' },
    h('div', {},
      h('h1', {}, homeFilter ? (state.projects.find((p) => p.slug === homeFilter)?.name ?? homeFilter) : 'Projects'),
      h('p', { class: 'proj-sub' }, homeFilter
        ? 'Every map in this project.'
        : 'A project is a folder of maps that belong to one engagement.')),
    state.standalone ? null : h('div', { class: 'proj-head-actions' },
      homeFilter ? h('button', { class: 'd-btn', onClick: () => { homeFilter = null; renderHome(); } }, '‹ All projects') : null,
      h('button', { class: 'd-btn', onClick: () => openTrashDialog() }, `Trash${state.trash.length ? ` (${state.trash.length})` : ''}`),
      h('button', { class: 'd-btn', onClick: () => newProjectDialog() }, '+ New project'),
      h('button', { class: 'd-btn primary', onClick: () => newMapDialog() }, '+ New map')));

  const body = h('div', { class: 'proj-grid' });
  for (const slug of visibleSlugs) {
    const index = projectIndexFor(slug);
    const maps = byProject.get(slug) ?? [];
    const order = index?.order ?? [];
    const tiles = [...maps].sort((a, b) => {
      const ai = order.indexOf(a.id.split('/').pop());
      const bi = order.indexOf(b.id.split('/').pop());
      if (ai === -1 && bi === -1) return (a.name || a.id).localeCompare(b.name || b.id);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    body.append(h('article', { class: 'proj-card' },
      h('header', { class: 'proj-card-head' },
        h('h2', {}, index?.name ?? slug),
        h('div', { class: 'proj-card-actions' },
          h('span', { class: 'proj-count' }, `${maps.length} map${maps.length === 1 ? '' : 's'}`),
          state.standalone ? null : h('button', {
            class: 'proj-card-trash',
            title: `Move ${index?.name ?? slug} to Trash`,
            onClick: () => moveToTrashDialog('project', {
              slug,
              name: index?.name ?? slug,
              mapCount: maps.length,
            }),
          }, 'Trash'))),
      index?.description ? h('p', { class: 'proj-desc' }, index.description) : null,
      h('div', { class: 'proj-tiles' }, tiles.length
        ? tiles.map((m) => mapTile(m, index))
        : [h('p', { class: 'proj-empty' }, 'No maps yet — move one in from the map switcher.')])));
  }

  if (!homeFilter && rootMaps.length) {
    body.append(h('article', { class: 'proj-card ungrouped' },
      h('header', { class: 'proj-card-head' },
        h('h2', {}, 'Ungrouped'),
        h('span', { class: 'proj-count' }, `${rootMaps.length} map${rootMaps.length === 1 ? '' : 's'}`)),
      h('p', { class: 'proj-desc' }, 'Maps in the root maps/ folder, outside any project.'),
      h('div', { class: 'proj-tiles' }, rootMaps.map((m) => mapTile(m, null)))));
  }

  if (!visibleSlugs.length && !rootMaps.length) {
    body.append(h('div', { class: 'proj-none' },
      h('p', {}, 'Nothing here yet. Create a project or a map to get started.')));
  }

  host.replaceChildren(head, body);
}

function newProjectDialog() {
  const name = h('input', { class: 'f-input', placeholder: 'e.g. Acme Corp — Discovery' });
  modal('New project', h('div', {},
    h('div', { class: 'f-field' }, h('label', {}, 'Project name'), name),
    h('p', { class: 'hint' }, 'Creates a folder in projects/ with an optional projects.yaml index.')), [
    { label: 'Cancel' },
    {
      label: 'Create', primary: true,
      onClick: () => {
        const v = name.value.trim();
        if (!v) { name.focus(); return false; }
        api.createProject(v).then(async () => {
          await ctrl.loadProjects();
          renderHome();
          toast(`Created project “${v}”`);
        }).catch((e) => toast(e.message, true));
      },
    },
  ]);
}

// Small chooser for moving a map between the root and a project.
function moveMapDialog(mapSummary) {
  const current = mapSummary.project?.slug ?? null;
  const options = [
    { slug: null, name: 'Ungrouped (root maps/ folder)' },
    ...state.projects.map((p) => ({ slug: p.slug, name: p.name })),
  ].filter((o) => o.slug !== current);
  const list = h('div', { class: 'move-list' }, options.map((o) =>
    h('button', {
      class: 'menu-item',
      onClick: async () => {
        document.querySelector('.dialog-backdrop')?.remove();
        try {
          const res = await api.moveMap(mapSummary.id, o.slug);
          await ctrl.loadMapList();
          await ctrl.loadProjects();
          const newId = res?.id ?? (o.slug ? `${o.slug}/${mapSummary.id}` : mapSummary.id.split('/').pop());
          if (state.mapId === mapSummary.id) await ctrl.openMap(newId, { replace: true });
          renderHome();
          toast(o.slug ? `Moved to ${o.name}` : 'Moved to the root');
        } catch (e) { toast(e.message, true); }
      },
    }, h('span', { class: 'mi-name' }, o.name))));
  modal(`Move “${mapSummary.name || mapSummary.id}”`, list, [{ label: 'Cancel' }]);
}

async function refreshLibrary() {
  await Promise.all([ctrl.loadMapList(), ctrl.loadProjects(), ctrl.loadTrash()]);
  renderHome();
}

function moveToTrashDialog(kind, resource) {
  const isProject = kind === 'project';
  const name = resource.name || resource.id || resource.slug;
  const count = resource.mapCount ?? 0;
  const detail = isProject
    ? `This moves the project and its ${count} map${count === 1 ? '' : 's'} to Trash.`
    : 'This moves the map file to Trash.';
  modal(`Move “${name}” to Trash?`, h('div', { class: 'trash-confirm' },
    h('p', {}, detail),
    h('p', { class: 'hint' }, 'You can restore it from the Trash window.')), [
    { label: 'Cancel' },
    {
      label: 'Move to Trash',
      danger: true,
      onClick: async () => {
        try {
          if (isProject) await api.trashProject(resource.slug);
          else await api.trashMap(resource.id);
          if (state.mapId === resource.id
            || (isProject && state.mapId?.startsWith(`${resource.slug}/`))) {
            ctrl.goHome();
          }
          if (isProject && homeFilter === resource.slug) homeFilter = null;
          await refreshLibrary();
          toast(`Moved “${name}” to Trash`);
        } catch (error) {
          toast(`Could not move to Trash: ${error.message}`, true);
        }
      },
    },
  ]);
}

function trashLocation(item) {
  return item.kind === 'project'
    ? `Project folder: ${item.originalSlug}`
    : `Map file: ${item.originalId}`;
}

function deleteForeverDialog(item, refresh) {
  const contents = item.kind === 'project'
    ? ` and its ${item.mapCount} map${item.mapCount === 1 ? '' : 's'}`
    : '';
  modal(`Delete “${item.name}” forever?`, h('div', { class: 'trash-confirm' },
    h('p', {}, `This permanently deletes the ${item.kind}${contents}.`),
    h('p', { class: 'hint danger-copy' }, 'This cannot be undone.')), [
    { label: 'Cancel' },
    {
      label: 'Delete forever',
      danger: true,
      onClick: async () => {
        try {
          await api.deleteTrash(item.id);
          await ctrl.loadTrash();
          refresh();
          renderHome();
          toast(`Permanently deleted “${item.name}”`);
        } catch (error) {
          toast(`Could not delete item: ${error.message}`, true);
        }
      },
    },
  ]);
}

function openTrashDialog() {
  const body = h('div', { class: 'trash-list' });
  const render = () => {
    if (!state.trash.length) {
      body.replaceChildren(h('div', { class: 'trash-empty' },
        h('strong', {}, 'Trash is empty'),
        h('p', {}, 'Maps and projects moved here will stay until you restore or permanently delete them.')));
      return;
    }
    body.replaceChildren(...state.trash.map((item) => {
      const deleted = new Date(item.deletedAt);
      const when = Number.isNaN(deleted.getTime()) ? item.deletedAt : deleted.toLocaleString();
      return h('article', { class: 'trash-row' },
        h('div', { class: 'trash-row-copy' },
          h('span', { class: `trash-kind ${item.kind}` }, item.kind),
          h('strong', {}, item.name),
          h('span', {}, trashLocation(item)),
          h('small', {}, `Moved ${when}`)),
        h('div', { class: 'trash-row-actions' },
          h('button', {
            class: 'd-btn',
            onClick: async () => {
              try {
                await api.restoreTrash(item.id);
                await refreshLibrary();
                render();
                toast(`Restored “${item.name}”`);
              } catch (error) {
                toast(`Could not restore item: ${error.message}`, true);
              }
            },
          }, 'Restore'),
          h('button', {
            class: 'd-btn danger-outline',
            onClick: () => deleteForeverDialog(item, render),
          }, 'Delete forever')));
    }));
  };
  render();
  modal('Trash', body, [{ label: 'Close' }]);
}

// ── dialogs ──────────────────────────────────────────────────────────
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function modal(title, body, actions) {
  const root = document.getElementById('dialog-root');
  const returnFocus = document.activeElement;
  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
    h('h2', {}, title), body,
    h('div', { class: 'dialog-actions' }, actions.map((a) =>
      h('button', {
        class: `d-btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
        onClick: () => { const r = a.onClick?.(); if (r !== false) close(); },
      }, a.label))));
  associateFieldLabels(dialog);
  const backdrop = h('div', { class: 'dialog-backdrop', onPointerdown: (ev) => { if (ev.target === backdrop) close(); } }, dialog);
  const onKey = (ev) => {
    if (root.lastElementChild !== backdrop) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    if (ev.key === 'Tab') {
      // keep Tab / Shift+Tab cycling inside the dialog until it closes
      const focusable = [...dialog.querySelectorAll(FOCUSABLE)]
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
      if (!focusable.length) { ev.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const leaving = ev.shiftKey
        ? ev.target === first || !dialog.contains(ev.target)
        : ev.target === last || !dialog.contains(ev.target);
      if (leaving) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
    }
    if (ev.key === 'Enter' && !ev.shiftKey && ev.target.tagName !== 'TEXTAREA') {
      const primary = actions.find((x) => x.primary);
      if (primary) { ev.preventDefault(); ev.stopPropagation(); const r = primary.onClick?.(); if (r !== false) close(); }
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
  }
  document.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  (dialog.querySelector('input, textarea') ?? dialog.querySelector('.dialog-actions button'))?.focus();
  return close;
}

function typeSegment(initial, types = activeNodeTypes()) {
  let value = initial;
  const available = types.includes(initial) ? types : [initial, ...types];
  const seg = h('div', { class: 'type-seg', style: `--type-count:${available.length}` });
  for (const t of available) {
    const b = h('button', {
      class: `t-${t}${t === value ? ' on' : ''}`,
      onClick: (ev) => {
        ev.preventDefault();
        value = t;
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      },
    }, typeIcon(t), h('span', {}, typeLabel(t)));
    seg.append(b);
  }
  seg.value = () => value;
  return seg;
}

function mapModeSegment(initial = 'process') {
  let value = initial;
  const seg = h('div', { class: 'map-mode-seg' });
  const options = [
    ['process', 'Process', 'Map steps, decisions, owners, and automation.'],
    ['freeform', 'Freeform', 'Map systems, data, APIs, people, or anything else.'],
  ];
  for (const [mode, label, description] of options) {
    const button = h('button', {
      class: mode === value ? 'on' : '',
      onClick: (ev) => {
        ev.preventDefault();
        value = mode;
        seg.querySelectorAll('button').forEach((item) => item.classList.remove('on'));
        button.classList.add('on');
      },
    }, h('strong', {}, label), h('span', {}, description));
    seg.append(button);
  }
  seg.value = () => value;
  return seg;
}

function automationSelect(initial = '') {
  const labels = {
    manual: 'Manual — a human does it',
    assisted: 'Assisted — human + computer',
    automated: 'Automated — an agent does it',
    'at-risk': 'At risk',
  };
  const select = h('select', { class: 'f-select' },
    h('option', { value: '' }, 'Not assessed'),
    ...AUTOMATION_STATES.map((value) => h('option', { value }, labels[value] ?? value)));
  select.value = initial;
  return select;
}

function enumSelect(values, initial = '', emptyLabel = '') {
  const select = h('select', { class: 'f-select' },
    emptyLabel ? h('option', { value: '' }, emptyLabel) : null,
    ...values.map((value) => h('option', { value }, value.replace(/-/g, ' '))));
  select.value = initial;
  return select;
}

function lineValues(value) {
  return String(value || '').split('\n').map((item) => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
}

function relationValues(value, allowed = RELATION_TYPES) {
  return lineValues(value).map((line, index) => {
    const match = line.match(/^([a-z-]+)\s*->\s*([^\s]+)$/);
    if (!match) throw new Error(`Relation line ${index + 1} must use "type -> element-id".`);
    const [, type, to] = match;
    if (!allowed.includes(type)) {
      throw new Error(`Relation line ${index + 1} has unknown type "${type}".`);
    }
    return { type, to };
  });
}

function ownerValues(value) {
  return lineValues(value).map((line, index) => {
    const match = line.match(/^([a-z-]+)\s*->\s*([^\s]+)$/);
    if (!match) throw new Error(`Owner line ${index + 1} must use "role -> element-id".`);
    const [, role, to] = match;
    if (!OWNER_ROLES.includes(role)) {
      throw new Error(`Owner line ${index + 1} has unknown role "${role}".`);
    }
    return { role, to };
  });
}

function addElementDialog(ownerId, options = {}) {
  const ownerLabel = state.model.byId.get(ownerId)?.label ?? ownerId;
  const position = options?.position ?? null;
  const initialType = FREEFORM_NODE_TYPES.includes(options?.type) ? options.type : 'item';
  const search = h('input', {
    class: 'f-input element-search',
    type: 'search',
    placeholder: 'Search shared elements',
  });
  const list = h('div', { class: 'element-picker-list' });
  const createPanel = h('div', { class: 'element-create-panel' });
  createPanel.hidden = true;
  const createButton = h('button', { class: 'element-create-toggle' }, '+ Create a new element');
  const body = h('div', { class: 'element-picker' },
    h('p', { class: 'hint element-picker-hint' }, `Add an existing element to “${ownerLabel}”, or create one shared definition.`),
    search,
    list,
    createButton,
    createPanel);
  let close = null;

  const placed = (elementId, label) => {
    close?.();
    ctrl.commit(
      () => edit.addPlacement(ownerId, elementId, { position }),
      { select: elementId },
    ).then(async (ok) => {
      if (!ok) return;
      if (ownerId !== state.scopeId) await ctrl.gotoScope(ownerId, { focusId: elementId });
      else canvas.centerOn(elementId);
      showDetail(elementId);
      toast(`Added “${label}” to “${ownerLabel}”`);
    });
  };

  const renderList = () => {
    const query = search.value.trim().toLowerCase();
    const available = state.model.elements
      .filter((element) => !placementInScope(state.model, ownerId, element.id))
      .filter((element) => !query
        || element.label.toLowerCase().includes(query)
        || element.id.toLowerCase().includes(query)
        || typeLabel(element.type).toLowerCase().includes(query));
    list.replaceChildren();
    if (!available.length) {
      list.append(h('p', { class: 'element-picker-empty' },
        query ? 'No matching shared elements.' : 'Every shared element is already in this group.'));
      return;
    }
    for (const element of available) {
      const count = placementsOf(state.model, element.id).length;
      list.append(h('button', {
        class: 'element-picker-row',
        onClick: () => placed(element.id, element.label),
      },
      h('span', { class: `element-picker-icon t-${element.type}` }, typeIcon(element.type, 15)),
      h('span', { class: 'element-picker-name' }, element.label),
      h('span', { class: 'element-picker-meta' }, `${typeLabel(element.type)} · ${count} placement${count === 1 ? '' : 's'}`)));
    }
  };
  search.addEventListener('input', renderList);
  renderList();

  createButton.addEventListener('click', () => {
    createButton.hidden = true;
    search.hidden = true;
    list.hidden = true;
    createPanel.hidden = false;
    const label = h('input', { class: 'f-input', placeholder: 'e.g. Looker API' });
    const type = typeSegment(initialType, FREEFORM_NODE_TYPES);
    const description = h('textarea', { class: 'f-textarea', placeholder: 'What is this shared element?' });
    const note = h('textarea', { class: 'f-textarea compact-textarea', placeholder: `Optional note about its use in ${ownerLabel}` });
    createPanel.replaceChildren(
      h('button', {
        class: 'element-create-back',
        onClick: () => {
          createPanel.hidden = true;
          createButton.hidden = false;
          search.hidden = false;
          list.hidden = false;
          search.focus();
        },
      }, '← Existing elements'),
      h('div', { class: 'f-field' }, h('label', {}, 'Name'), label),
      h('div', { class: 'f-field' }, h('label', {}, 'Type'), type),
      h('div', { class: 'f-field' }, h('label', {}, 'Shared description'), description),
      h('div', { class: 'f-field' }, h('label', {}, `Note for ${ownerLabel}`), note),
      h('button', {
        class: 'd-btn primary element-create-save',
        onClick: () => {
          const text = label.value.trim();
          if (!text) { label.focus(); return; }
          const id = edit.uniqueId(state.model, edit.slugify(text));
          close?.();
          ctrl.commit(() => {
            edit.addElement({ id, type: type.value(), label: text, description: description.value });
            edit.addPlacement(ownerId, id, { note: note.value, position });
          }, { select: id }).then(async (ok) => {
            if (!ok) return;
            if (ownerId !== state.scopeId) await ctrl.gotoScope(ownerId, { focusId: id });
            else canvas.centerOn(id);
            showDetail(id, { edit: true });
            toast(`Created “${text}” and added it to “${ownerLabel}”`);
          });
        },
      }, 'Create and add'));
    associateFieldLabels(createPanel);
    label.focus();
  });

  close = modal('Add element', body, [{ label: 'Cancel' }]);
}

export function addElementToGroup(ownerId = state.scopeId, options = {}) {
  if (!isFreeform() || ownerId == null) return false;
  addElementDialog(ownerId, options);
  return true;
}


export function addNodeDialog(ownerId, options = {}) {
  if (state.standalone || !state.model) return;
  const freeform = isFreeform();
  if (freeform && ownerId != null) {
    addElementDialog(ownerId, typeof options === 'string' ? { type: options } : options);
    return;
  }

  const addingGroup = freeform && ownerId == null;
  const defaultType = addingGroup ? 'item' : 'process';
  const type = typeof options === 'string' ? options : options?.type ?? defaultType;
  const ownerLabel = ownerId ? state.model.byId.get(ownerId)?.label : state.model?.name;
  const label = h('input', {
    class: 'f-input',
    placeholder: addingGroup ? 'e.g. Revenue systems' : 'e.g. Verify bank statements',
  });
  const seg = typeSegment(NODE_TYPES.includes(type) ? type : defaultType);
  const desc = h('textarea', {
    class: 'f-textarea',
    placeholder: addingGroup ? 'What belongs in this group?' : 'What happens here? (optional)',
  });
  const owner = h('input', { class: 'f-input', placeholder: 'e.g. RevOps' });
  const automation = addingGroup ? null : automationSelect('manual');
  const productMode = !freeform && state.model.document.kind !== 'process';
  const planningType = enumSelect(PLANNING_TYPES, 'requirement');
  const planningStatus = enumSelect(PLAN_STATUSES, 'draft');
  const planningPriority = enumSelect(PLAN_PRIORITIES, 'should');
  const planningPhase = enumSelect(['now', 'next', 'later'], 'next');
  const acceptance = h('textarea', { class: 'f-textarea compact-textarea', placeholder: 'One acceptance criterion per line' });
  const planningEnabled = h('input', { type: 'checkbox' });
  planningEnabled.checked = productMode;
  const planningFields = h('div', { class: 'planning-fields' },
    h('div', { class: 'form-row' },
      h('div', { class: 'f-field' }, h('label', {}, 'Planning type'), planningType),
      h('div', { class: 'f-field' }, h('label', {}, 'Status'), planningStatus)),
    h('div', { class: 'form-row' },
      h('div', { class: 'f-field' }, h('label', {}, 'Priority'), planningPriority),
      h('div', { class: 'f-field' }, h('label', {}, 'Roadmap phase'), planningPhase)),
    h('div', { class: 'f-field' }, h('label', {}, 'Acceptance criteria'), acceptance));
  const syncPlanningFields = () => { planningFields.hidden = !planningEnabled.checked; };
  planningEnabled.addEventListener('change', syncPlanningFields);
  syncPlanningFields();

  const body = h('div', {},
    h('div', { class: 'f-field' }, h('label', {}, addingGroup ? 'Group name' : 'Label'), label),
    h('div', { class: 'f-field' }, h('label', {}, 'Type'), seg),
    addingGroup ? null : h('div', { class: 'form-row' },
      h('div', { class: 'f-field' }, h('label', {}, 'Owner'), owner),
      h('div', { class: 'f-field' }, h('label', {}, 'Automation'), automation)),
    productMode ? h('div', { class: 'planning-form-block' },
      h('label', { class: 'planning-toggle' }, planningEnabled, h('span', {}, 'Include as a product-planning item')),
      planningFields) : null,
    h('div', { class: 'f-field' }, h('label', {}, 'Description'), desc),
    h('p', { class: 'hint' }, addingGroup
      ? `Creates a top-level group in “${ownerLabel}”.`
      : `Will be added ${ownerId ? `inside “${ownerLabel}”` : `at the top level of “${ownerLabel}”`}.`));

  modal(addingGroup ? 'Add group' : 'Add node', body, [
    { label: 'Cancel' },
    {
      label: addingGroup ? 'Add group' : 'Add node',
      primary: true,
      onClick: () => {
        const text = label.value.trim();
        if (!text) { label.focus(); return false; }
        const id = edit.uniqueId(state.model, edit.slugify(text));
        ctrl.commit(() => edit.addNode(ownerId, {
          id,
          type: seg.value(),
          label: text,
          description: desc.value,
          owner: addingGroup ? undefined : owner.value,
          automation: automation?.value,
          planning: productMode && planningEnabled.checked ? {
            type: planningType.value,
            status: planningStatus.value,
            priority: planningPriority.value,
            phase: planningPhase.value,
            acceptance: lineValues(acceptance.value),
          } : null,
          children: addingGroup ? { nodes: [], edges: [] } : undefined,
          position: addingGroup ? options?.position : undefined,
        }), { select: id }).then(async (ok) => {
          if (!ok) return;
          if (ownerId && ownerId !== state.scopeId) await ctrl.gotoScope(ownerId, { focusId: id });
          else canvas.centerOn(id);
          showDetail(id);
          toast(`${addingGroup ? 'Added group' : 'Added node'} “${text}”`);
        });
      },
    },
  ]);
}

function newMapDialog() {
  const name = h('input', { class: 'f-input', placeholder: 'e.g. Customer systems' });
  const mode = mapModeSegment('process');
  const projectSel = h('select', { class: 'f-select' },
    h('option', { value: '' }, 'Ungrouped (root maps/ folder)'),
    state.projects.map((p) => h('option', { value: p.slug, ...(p.slug === currentProjectSlug() || p.slug === homeFilter ? { selected: '' } : {}) }, p.name)));
  modal('New map', h('div', {},
    h('div', { class: 'f-field' }, h('label', {}, 'Map name'), name),
    h('div', { class: 'f-field' }, h('label', {}, 'Mode'), mode),
    state.projects.length ? h('div', { class: 'f-field' }, h('label', {}, 'Project'), projectSel) : null,
    h('p', { class: 'hint' }, 'Creates a new YAML file — portable, like every Serigraph map.')), [
    { label: 'Cancel' },
    {
      label: 'Create', primary: true,
      onClick: () => {
        const v = name.value.trim();
        if (!v) { name.focus(); return false; }
        const project = projectSel.value || null;
        import('./api.js').then(async ({ api }) => {
          try {
            const { id } = await api.createMap(v, mode.value(), project);
            await ctrl.loadMapList();
            await ctrl.openMap(id);
            toast(`Created ${id}.yaml`);
          } catch (e) { toast(e.message, true); }
        });
      },
    },
  ]);
}

export function helpDialog() {
  const freeform = isFreeform();
  const rows = [
    ['⌘K / Ctrl+K', 'Search all nodes'],
    ['double-click / ⏎', freeform ? 'Open a group' : 'Zoom into a container node'],
    ...(freeform ? [['pan to another group', 'Follow its connections without zooming out']] : []),
    ['Esc', 'Zoom back out or close a panel'],
    ['Delete / Backspace', freeform ? 'Delete the selected item' : 'Delete the selected node'],
    ['⌘D / Ctrl+D', freeform ? 'Duplicate the selected item' : 'Duplicate the selected node'],
    ['⌘C / ⌘V', freeform ? 'Copy / paste the selected items' : 'Copy / paste the selected nodes'],
    ['F2', freeform ? 'Rename the selected item' : 'Rename the selected node'],
    ['← ↑ ↓ →', 'Move selection between nodes'],
    ['V / H', 'Select / pan'],
    ['N / C', freeform ? 'Add an item / connect items' : 'Add a unit / connect steps'],
    ...(freeform ? [['T', 'Review note']] : [['L / T', 'Owner lanes / review note'], ['P / A', 'Path probe / automation lens']]),
    ['⇧P', 'Presentation mode'],
    ['+ / − / 0', 'Zoom in / out / fit'],
    ['⌘Z / Ctrl+Z', 'Undo'],
    ['⌘⇧Z / Ctrl+Shift+Z', 'Redo'],
    ['drag a node', 'Move it and pin its position'],
    ['drag a node onto a container', freeform ? 'Move it into that group' : 'Move it into that sub-map'],
    ['drag from a node\'s ○ port', freeform ? 'Connect it to another item' : 'Draw an edge to another node'],
    ['drag from the palette', 'Drop a new node where you release it'],
    ['double-click empty canvas', 'Create a node at that spot'],
    ['drag the background', 'Pan the canvas'],
    ['Shift+click', freeform ? 'Add or remove an item in the selection' : 'Add or remove a node in the selection'],
    ['Shift+drag', freeform ? 'Draw a box to select every item inside' : 'Draw a box to select every node inside'],
    ['scroll · pinch', 'Pan · zoom'],
    ...(freeform ? [] : [['Space (in Flow)', 'Pause or resume the moving payloads']]),
  ];
  const grid = h('div', { class: 'kbd-grid' });
  for (const [k, d] of rows) { grid.append(h('kbd', {}, k)); grid.append(h('span', {}, d)); }
  modal('Keyboard & mouse', grid, [{ label: 'Done', primary: true }]);
}

// ── detail panel ─────────────────────────────────────────────────────
let editMode = false;
let automationMode = false;
let contextActionsArmed = null;
let scenarioNodeId = null;

export function armContextActions(nodeId) {
  contextActionsArmed = nodeId;
}

export function showDetail(nodeId, { edit = false } = {}) {
  editMode = edit;
  automationMode = false;
  state.detailNodeId = nodeId;
  renderDetail();
  requestAnimationFrame(() => {
    if (!state.presenting && state.detailNodeId === nodeId) canvas.ensureVisible(nodeId);
  });
}
export function hideDetail() {
  editMode = false;
  automationMode = false;
  state.detailNodeId = null;
  const panel = document.getElementById('detail');
  if (panel) panel.hidden = true;
  hideContextActions();
  clearScenarioPreview();
}

function beginConnect(node) {
  hideContextActions();
  state.connectFrom = node.id;
  canvas.paintSelection();
  toast(`Choose the ${isFreeform() ? 'item' : 'step'} this connects to · Esc cancels`);
}

// One click from a decision: start a connection with the branch label filled
// in — "no" by default, "yes" if a "no" branch already exists.
function beginBranch(node) {
  hideContextActions();
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const labels = (scope?.edges ?? [])
    .filter((e) => e.from === node.id)
    .map((e) => (e.label || '').trim().toLowerCase());
  const hasNo = labels.some((l) => l === 'no' || l.startsWith('no ') || l.startsWith('no—') || l.startsWith('no-'));
  const label = hasNo ? 'yes' : 'no';
  state.pendingEdgeLabel = label;
  state.connectFrom = node.id;
  canvas.paintSelection();
  toast(`Choose where the “${label}” branch goes · Esc cancels`);
}

function undoableToast(message) {
  toast(message, false, { label: 'Undo', onClick: () => ctrl.undo() });
}

function deleteNodeNow(node) {
  hideDetail();
  return ctrl.commit(
    () => edit.deleteNode(node.id),
    { select: null, historyLabel: `delete “${node.label}”` },
  ).then((ok) => {
    if (ok) undoableToast(`Deleted “${node.label}”`);
    return ok;
  });
}

function confirmDelete(node) {
  if (!(isFreeform() && node.isElement)) return deleteNodeNow(node);

  const useCount = placementsOf(state.model, node.id).length;
  const groupLabel = state.model.byId.get(state.scopeId)?.label ?? 'this group';
  modal(`Remove “${node.label}”?`,
    h('div', {},
      h('p', { class: 'hint' }, `Remove this placement from “${groupLabel}”, or delete the shared element from all ${useCount} group${useCount === 1 ? '' : 's'}.`),
      h('p', { class: 'hint' }, 'Removing this placement also removes its connections in this group.')),
    [
      { label: 'Cancel' },
      {
        label: 'Remove from group',
        onClick: () => {
          hideDetail();
          ctrl.commit(
            () => edit.removePlacement(state.scopeId, node.id),
            { select: null, historyLabel: `remove “${node.label}” from “${groupLabel}”` },
          ).then((ok) => ok && undoableToast(`Removed “${node.label}” from “${groupLabel}”`));
        },
      },
      {
        label: 'Delete everywhere',
        danger: true,
        onClick: () => {
          hideDetail();
          ctrl.commit(
            () => edit.deleteElement(node.id),
            { select: null, historyLabel: `delete “${node.label}” everywhere` },
          ).then((ok) => ok && undoableToast(`Deleted shared element “${node.label}”`));
        },
      },
    ]);
  return true;
}

function deleteEdgeNow(index) {
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const edge = scope?.edges?.[index];
  if (!edge) return false;
  const from = state.model.byId.get(edge.from)?.label ?? edge.from;
  const to = state.model.byId.get(edge.to)?.label ?? edge.to;
  return ctrl.commit(
    () => edit.deleteEdge(state.scopeId, index),
    { historyLabel: `delete connection from “${from}” to “${to}”` },
  ).then((ok) => {
    if (ok) {
      ctrl.selectEdge(null);
      hideDetail();
      undoableToast(`Deleted connection from “${from}” to “${to}”`);
    }
    return ok;
  });
}

// Delete the current selection immediately. Undo is always offered afterward.
export function requestDelete() {
  if (state.standalone || !state.model || state.presenting) return false;
  if (state.selectedId) {
    const node = state.model.byId.get(state.selectedId);
    if (node) { confirmDelete(node); return true; }
  }
  if (state.selectedEdge != null) { deleteEdgeNow(state.selectedEdge.index); return true; }
  return false;
}

export async function duplicateSelection() {
  if (state.standalone || !state.model || state.presenting || !state.selectedId) return false;
  const node = state.model.byId.get(state.selectedId);
  if (!node) return false;
  const layoutNode = canvas.getLayout()?.nodes.find((item) => item.id === node.id);
  const position = layoutNode
    ? {
        x: layoutNode.x + layoutNode.w / 2 + layoutNode.w + 28,
        y: layoutNode.y + layoutNode.h / 2 + 28,
      }
    : null;
  let duplicateId = null;
  const ok = await ctrl.commit(() => {
    duplicateId = node.isElement
      ? edit.duplicateElement(node.id, state.scopeId, { position })
      : edit.duplicateNode(node.id, { position });
  }, { historyLabel: `duplicate “${node.label}”` });
  if (!ok || !duplicateId) return false;
  ctrl.selectNode(duplicateId);
  toast(`Duplicated “${node.label}”`);
  return true;
}

// ── right-click context menu ─────────────────────────────────────────
let contextMenuEl = null;
function closeNodeMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('blur', closeNodeMenu);
}
function onMenuOutside(ev) { if (contextMenuEl && !contextMenuEl.contains(ev.target)) closeNodeMenu(); }
function onMenuKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeNodeMenu(); } }

// Open the Serigraph context menu for a node at screen coordinates.
export function openNodeMenu(nodeId, x, y) {
  const node = state.model?.byId.get(nodeId);
  if (!node || state.presenting) return;
  closeNodeMenu();
  editMode = false;
  automationMode = false;
  armContextActions(nodeId);
  ctrl.selectNode(nodeId);
  const ro = state.standalone;
  const freeform = isFreeform();
  const run = (fn) => () => { closeNodeMenu(); fn(); };
  const items = [
    node.children ? h('button', { onClick: run(() => ctrl.diveInto(node.id)) }, 'Open') : null,
    h('button', { onClick: run(() => navigator.clipboard?.writeText(ctrl.nodeUrl(node.id)).then(() => toast('Link copied'))) }, 'Copy link'),
    ro ? null : h('button', { onClick: run(beginEdit) }, 'Edit'),
    ro ? null : h('button', { onClick: run(() => beginConnect(node)) }, 'Connect'),
    ro || freeform || node.type !== 'decision' ? null : h('button', { onClick: run(() => beginBranch(node)) }, 'Branch'),
    ro ? null : h('button', { onClick: run(() => askAiAbout(node.id)) }, 'AI'),
    ro || freeform ? null : h('button', { class: 'automate', onClick: run(() => beginAutomation(node)) }, 'Automate'),
    ro || !node.children ? null : h('button', { onClick: run(() => addNodeDialog(node.id)) }, freeform ? 'Add item' : 'Add child'),
    ro ? null : h('div', { class: 'context-menu-sep' }),
    ro ? null : h('button', { class: 'danger', onClick: run(() => confirmDelete(node)) }, 'Delete'),
  ].filter(Boolean);
  const menu = h('div', { class: 'node-context-menu', role: 'menu' }, ...items);
  contextMenuEl = menu;
  document.getElementById('dialog-root').append(menu);
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 200;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, y))}px`;
  document.addEventListener('pointerdown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('blur', closeNodeMenu);
}

function beginEdit() {
  editMode = true;
  automationMode = false;
  contextActionsArmed = null;
  renderDetail();
}

function beginAutomation(node) {
  editMode = false;
  automationMode = true;
  contextActionsArmed = null;
  state.detailNodeId = node.id;
  hideContextActions();
  renderDetail();
}

export function openAutomation(nodeId = state.selectedId) {
  if (isFreeform()) return false;
  const node = nodeId ? state.model?.byId.get(nodeId) : null;
  if (!node) { toast('Select a step to assess its automation opportunity'); return false; }
  beginAutomation(node);
  return true;
}

export function startConnect(nodeId = state.selectedId) {
  const node = nodeId ? state.model?.byId.get(nodeId) : null;
  const visible = isFreeform()
    ? !!placementInScope(state.model, state.scopeId, nodeId)
    : node?.ownerId === (state.scopeId ?? null);
  if (!node || !visible) {
    toast(`Select the ${isFreeform() ? 'item' : 'step'} this connection should start from`);
    return false;
  }
  beginConnect(node);
  return true;
}

function hideContextActions() {
  const actions = document.getElementById('context-actions');
  if (actions) actions.hidden = true;
}

function positionContextActions() {
  const actions = document.getElementById('context-actions');
  const stage = document.getElementById('stage');
  if (!actions || !stage || actions.hidden || !state.selectedId) return;
  const rect = canvas.nodeScreenRect(state.selectedId);
  if (!rect) return;
  const w = actions.offsetWidth || 286;
  const hgt = actions.offsetHeight || 52;
  let left = rect.x + rect.width / 2 - w / 2;
  let top = rect.y + rect.height + 14;
  const detail = document.getElementById('detail');
  const stageRect = stage.getBoundingClientRect();
  const rightEdge = detail && !detail.hidden && window.innerWidth > 700
    ? detail.getBoundingClientRect().left - stageRect.left - 12
    : stage.clientWidth;
  const shelfTop = stage.clientHeight - 24;
  if (top + hgt > shelfTop) top = rect.y - hgt - 14;
  left = Math.max(16, Math.min(rightEdge - w - 16, left));
  top = Math.max(92, Math.min(stage.clientHeight - hgt - 24, top));
  actions.style.left = `${left}px`;
  actions.style.top = `${top}px`;
}

function renderContextActions(node) {
  const actions = document.getElementById('context-actions');
  if (!actions || contextActionsArmed !== node.id || editMode || automationMode || state.presenting) return hideContextActions();
  const ro = state.standalone;
  const freeform = isFreeform();
  const moreItems = [
    node.children ? h('button', { onClick: () => addNodeDialog(node.id) }, freeform ? 'Add item' : 'Add child') : null,
    ...node.links.map((l) => {
      const href = safeUrl(l.url);
      return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, l.label) : null;
    }),
    node.links.length ? h('button', { onClick: () => navigator.clipboard?.writeText(ctrl.nodeUrl(node.id)).then(() => toast('Link copied')) }, 'Copy deep link') : null,
  ].filter(Boolean);
  const more = moreItems.length
    ? h('details', { class: 'context-more' },
        h('summary', { class: 'context-btn' }, 'More'),
        h('div', { class: 'context-menu' }, ...moreItems))
    : null;
  const primary = [
    h('button', {
      class: 'context-btn',
      onClick: () => node.children ? ctrl.diveInto(node.id) : navigator.clipboard?.writeText(ctrl.nodeUrl(node.id)).then(() => toast('Link copied')),
    }, node.children ? 'Open' : 'Link'),
    ro ? null : h('button', { class: 'context-btn', onClick: beginEdit }, 'Edit'),
    ro ? null : h('button', { class: 'context-btn', onClick: () => beginConnect(node) }, 'Connect'),
    ro || freeform || node.type !== 'decision' ? null : h('button', { class: 'context-btn', onClick: () => beginBranch(node) }, 'Branch'),
    ro ? null : h('button', { class: 'context-btn', onClick: () => askAiAbout(node.id) }, 'AI'),
    ro || freeform ? null : h('button', { class: 'context-btn automate', onClick: () => beginAutomation(node) }, 'Automate'),
    ro ? null : h('button', { class: 'context-btn danger', onClick: () => confirmDelete(node) }, 'Delete'),
  ].filter(Boolean);
  actions.replaceChildren(...primary, ...(more ? [more] : []));
  actions.hidden = false;
  requestAnimationFrame(positionContextActions);
}

function formatOpportunityMoney(value) {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}m`;
  if (value >= 1000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value)}`;
}

function clearScenarioPreview() {
  scenarioNodeId = null;
  canvas.paintScenario();
  const badge = document.getElementById('scenario-preview');
  if (badge) badge.hidden = true;
}

function positionScenarioPreview() {
  const badge = document.getElementById('scenario-preview');
  if (!badge || badge.hidden || !scenarioNodeId) return;
  const rect = canvas.nodeScreenRect(scenarioNodeId);
  if (!rect) return;
  const width = badge.offsetWidth || 230;
  const stage = document.getElementById('stage');
  const detail = document.getElementById('detail');
  const stageRect = stage.getBoundingClientRect();
  const rightEdge = detail && !detail.hidden && window.innerWidth > 700
    ? detail.getBoundingClientRect().left - stageRect.left - 12
    : stage.clientWidth;
  badge.style.left = `${Math.max(16, Math.min(rightEdge - width - 16, rect.x + rect.width / 2 - width / 2))}px`;
  badge.style.top = `${Math.max(94, rect.y - badge.offsetHeight - 14)}px`;
}

function showScenarioPreview(node, metrics) {
  scenarioNodeId = node.id;
  canvas.paintScenario(node.id);
  const badge = document.getElementById('scenario-preview');
  badge.replaceChildren(
    h('span', { class: 'scenario-kicker' }, 'Scenario active'),
    h('strong', {}, `${Math.round(metrics.cycleReduction)}% faster · ${Math.round(metrics.annualHours).toLocaleString()} h/year`));
  badge.hidden = false;
  requestAnimationFrame(positionScenarioPreview);
}

function renderAutomationDetail(panel, node) {
  hideContextActions();
  const defaults = opportunityDefaults(node);
  const assessment = assessOpportunity(node);
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const outcomes = (scope?.edges ?? [])
    .filter((edge) => edge.from === node.id)
    .map((edge) => edge.label || state.model.byId.get(edge.to)?.label)
    .filter(Boolean)
    .slice(0, 3);

  panel.hidden = false;
  panel.classList.remove('editing', 'edge-detail');
  panel.classList.add('automation-lens');

  const head = h('div', { class: 'panel-head opportunity-head' },
    h('span', { class: 'opportunity-kicker' }, 'Automation opportunity'),
    h('h2', {}, node.label),
    h('div', { class: 'readiness-line' },
      h('strong', {}, `${assessment.score}`),
      h('div', {}, h('span', {}, assessment.label), h('small', {}, 'Readiness score'))),
    h('progress', { max: '100', value: String(assessment.score), 'aria-label': 'Automation readiness score' }),
    h('button', {
      class: 'panel-close', title: 'Back to overview',
      onClick: () => { automationMode = false; clearScenarioPreview(); renderDetail(); },
    }, 'Overview'));

  const metrics = {
    hours: h('strong', {}),
    value: h('strong', {}),
    payback: h('strong', {}),
    cycle: h('strong', {}),
  };
  const metric = (label, value, note) => h('div', { class: 'opp-metric' },
    h('span', {}, label), value, h('small', {}, note));
  const impact = h('div', { class: 'opportunity-impact' },
    metric('Hours returned', metrics.hours, 'per year'),
    metric('Capacity value', metrics.value, 'per year'),
    metric('Estimated payback', metrics.payback, 'planning estimate'),
    metric('Cycle-time reduction', metrics.cycle, 'at target coverage'));

  const makeInput = (label, value, suffix) => {
    const input = h('input', { class: 'opp-input', type: 'number', min: '0', value: String(value), 'aria-label': label });
    return { input, el: h('label', { class: 'opp-assumption' }, h('span', {}, label), h('div', {}, input, h('small', {}, suffix))) };
  };
  const cases = makeInput('Cases / month', defaults.monthlyCases, 'cases');
  const minutes = makeInput('Minutes / case', defaults.minutesPerCase, 'min');
  const coverage = makeInput('Automation coverage', defaults.coverage, '%');
  const hourly = makeInput('Value / hour', defaults.hourlyValue, '$');

  const blueprint = h('div', { class: 'opportunity-blueprint' },
    h('div', { class: 'opp-section-title' }, h('span', {}, 'Recommended blueprint'), h('strong', {}, assessment.pattern)),
    h('dl', {},
      h('div', {}, h('dt', {}, 'Trigger'), h('dd', {}, node.trigger || 'Define the starting event')),
      h('div', {}, h('dt', {}, 'Observe'), h('dd', {}, node.systems.length ? node.systems.join(' · ') : 'Connect source systems')),
      h('div', {}, h('dt', {}, 'Human control'), h('dd', {}, node.owner ? `${node.owner} owns approval and exceptions` : 'Assign an exception owner')),
      h('div', {}, h('dt', {}, 'Outcome'), h('dd', {}, outcomes.length ? outcomes.join(' · ') : 'Define a measurable completion state'))));

  const guardrails = h('div', { class: 'opportunity-guardrails' },
    h('div', { class: 'opp-section-title' }, h('span', {}, 'Before you build'), h('strong', {}, `${assessment.guardrails.length} guardrails`)),
    h('ul', {}, assessment.guardrails.map((item) => h('li', {}, item))));

  const body = h('div', { class: 'panel-body opportunity-body' },
    h('div', { class: 'opportunity-model' },
      h('div', { class: 'opportunity-title-row' },
        h('div', {}, h('span', {}, 'Modeled impact'), h('small', {}, 'Adjust the assumptions—results update instantly.')),
        h('span', { class: 'estimate-pill' }, 'Planning estimate')),
      impact,
      h('div', { class: 'opportunity-assumptions' }, cases.el, minutes.el, coverage.el, hourly.el)),
    h('div', { class: 'opportunity-plan' }, blueprint, guardrails));

  let currentMetrics = calculateOpportunity(defaults);
  const update = () => {
    currentMetrics = calculateOpportunity({
      ...defaults,
      monthlyCases: cases.input.value,
      minutesPerCase: minutes.input.value,
      coverage: coverage.input.value,
      hourlyValue: hourly.input.value,
    });
    metrics.hours.textContent = Math.round(currentMetrics.annualHours).toLocaleString();
    metrics.value.textContent = formatOpportunityMoney(currentMetrics.annualValue);
    metrics.payback.textContent = Number.isFinite(currentMetrics.paybackMonths) ? `${currentMetrics.paybackMonths.toFixed(1)} mo` : '—';
    metrics.cycle.textContent = `−${Math.round(currentMetrics.cycleReduction)}%`;
    if (scenarioNodeId === node.id) showScenarioPreview(node, currentMetrics);
  };
  [cases.input, minutes.input, coverage.input, hourly.input].forEach((input) => input.addEventListener('input', update));
  update();

  const previewButton = h('button', {
    class: 'pa-btn',
    onClick: () => {
      if (scenarioNodeId === node.id) clearScenarioPreview();
      else showScenarioPreview(node, currentMetrics);
      previewButton.textContent = scenarioNodeId === node.id ? 'Remove preview' : 'Preview on map';
    },
  }, 'Preview on map');
  const actions = h('div', { class: 'panel-actions opportunity-actions' },
    h('div', {}, h('span', {}, 'This is a decision model'), h('small', {}, 'Validate assumptions with the process owner before funding the build.')),
    previewButton,
    h('button', {
      class: 'pa-btn primary-action',
      onClick: async () => {
        const text = `${node.label} automation business case\n${Math.round(currentMetrics.annualHours).toLocaleString()} hours returned/year\n${formatOpportunityMoney(currentMetrics.annualValue)} annual capacity value\n${currentMetrics.paybackMonths.toFixed(1)} month estimated payback\n${assessment.pattern}`;
        await navigator.clipboard?.writeText(text);
        toast('Business case copied');
      },
    }, 'Copy business case →'));

  panel.replaceChildren(head, body, actions);
}

// only allow link protocols that can't execute script
function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url).trim()) ? String(url).trim() : null;
}

function linkifiedDesc(text) {
  const div = h('div', { class: 'desc' });
  const parts = String(text).split(/(https?:\/\/[^\s)>\]]+)/g);
  parts.forEach((p, i) => {
    if (i % 2) div.append(h('a', { href: p, target: '_blank', rel: 'noopener' }, p));
    else div.append(p);
  });
  return div;
}

function renderDetail() {
  const panel = document.getElementById('detail');
  const nodeId = state.detailNodeId;
  const node = nodeId ? state.model?.byId.get(nodeId) : null;

  if (state.selectedEdge != null && !node) return renderEdgeDetail(panel);
  if (!node) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.toggle('editing', editMode);
  panel.classList.toggle('automation-lens', automationMode);
  panel.classList.remove('edge-detail');
  if (automationMode) return renderAutomationDetail(panel, node);
  renderContextActions(node);

  const ro = state.standalone;
  const freeform = isFreeform();
  const placement = freeform && node.isElement
    ? placementInScope(state.model, state.scopeId, node.id)
    : null;
  const placementPosition = placement?.position ?? node.position;
  const groupLabel = placement
    ? state.model.byId.get(placement.ownerId)?.label ?? placement.ownerId
    : null;
  const usageLabels = freeform && node.isElement
    ? placementsOf(state.model, node.id).map((item) => state.model.byId.get(item.ownerId)?.label ?? item.ownerId)
    : [];
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('span', { class: 'inspector-eyebrow' },
        node.planning ? 'Product item' : node.isElement ? 'Shared element' : freeform && node.children ? 'Group' : 'Selection'),
      h('span', { class: `type-pill t-${node.type}` }, typeIcon(node.type, 12), typeLabel(node.type)),
      h('h2', {}, node.label),
      h('button', {
        class: 'node-id', title: 'Copy deep link to this node',
        onClick: () => { navigator.clipboard?.writeText(ctrl.nodeUrl(node.id)); toast('Link copied'); },
      }, `#${node.id} ⧉`)),
    h('button', { class: 'panel-close', title: 'Close (Esc)', onClick: () => { hideDetail(); ctrl.clearSelection(); } }, 'Close'));

  const body = h('div', { class: 'panel-body' });

  if (!editMode) {
    body.classList.add('focus-shelf-body');
    const status = node.automation || 'not-assessed';
    const fact = (label, value, cls = '') => h('div', { class: `focus-fact ${cls}` },
      h('span', { class: 'focus-label' }, label),
      h('strong', {}, value));
    const systemChips = node.systems.length
      ? h('div', { class: 'system-chips' }, node.systems.map((s) => h('span', {}, s)))
      : h('span', { class: 'unassigned' }, 'Not linked');
    const scope = placement
      ? state.model.byId.get(placement.ownerId)?.children
      : node.ownerId == null ? state.model.root : state.model.byId.get(node.ownerId)?.children;
    const connectionCount = (scope?.edges ?? []).filter((edge) => edge.from === node.id || edge.to === node.id).length;
    const ownerSummary = node.owners?.length
      ? node.owners.map((ownerRef) => {
        const ownerNode = state.model.elementById?.get(ownerRef.to);
        return `${ownerNode?.label ?? ownerRef.to} · ${ownerRef.role.replace('-', ' ')}`;
      }).join(', ')
      : 'Not assigned';
    body.append(
      h('div', { class: 'focus-summary' },
        node.description
          ? linkifiedDesc(node.description)
          : h('div', { class: 'desc placeholder' }, ro ? 'No description.' : freeform ? 'Describe this element.' : 'Describe what happens in this step.')),
      freeform
        ? h('div', { class: 'focus-facts' },
          fact('Owners', ownerSummary),
          fact('Connections', connectionCount ? `${connectionCount} connected` : 'None'),
          node.isElement
            ? fact('Used in', usageLabels.length
              ? `${usageLabels.length} group${usageLabels.length === 1 ? '' : 's'}: ${usageLabels.join(', ')}`
              : 'No groups')
            : null)
        : node.planning ? h('div', { class: 'focus-facts planning-facts' },
          fact('Owner', node.owner || 'Not assigned'),
          fact('Status', node.planning.status?.replace('-', ' ') || 'Draft'),
          fact('Priority', node.planning.priority || 'Unprioritized'),
          fact('Horizon', node.planning.phase?.replace(/-/g, ' ') || 'Unscheduled'),
          fact('Target', node.planning.target || 'Not set'),
          fact('Acceptance', `${node.planning.acceptance.length} checks`))
          : h('div', { class: 'focus-facts' },
            fact('Owner', node.owner || 'Not assigned'),
            fact('Trigger', node.trigger || 'Not documented'),
            fact('SLA', node.sla || 'No target'),
            h('div', { class: 'focus-fact systems-fact' }, h('span', { class: 'focus-label' }, 'Systems'), systemChips),
            h('div', { class: 'focus-fact readiness-fact' },
              h('span', { class: 'focus-label' }, 'Automation readiness'),
              h('strong', { class: `automation-state a-${status}` }, status.replace('-', ' ')))));
    if (placement) {
      body.append(h('div', { class: 'panel-section placement-note' },
        h('h3', {}, 'Note for this group', h('span', { class: 'local-marker' }, 'Local')),
        h('div', { class: placement.note ? 'desc' : 'desc placeholder' },
          placement.note || `No note for ${groupLabel}.`)));
    }
    if (node.isElement && node.relations.length) {
      body.append(h('div', { class: 'panel-section hierarchy-section' },
        h('h3', {}, 'Element hierarchy'),
        h('div', { class: 'hierarchy-links' }, node.relations.map((relation) => {
          const target = state.model.elementById.get(relation.to);
          return h('button', {
            class: 'hierarchy-link',
            onClick: () => ctrl.gotoNode(relation.to),
          }, h('span', {}, relation.type.replace('-', ' ')), h('strong', {}, target?.label ?? relation.to));
        }))));
    }
    const flagNote = state.flags?.nodes?.get(node.id);
    if (flagNote) {
      body.append(h('div', { class: 'panel-section flag-section' },
        h('h3', {}, '⚑ Inferred, not stated'),
        h('div', { class: 'desc' }, flagNote),
        ro ? null : h('button', {
          class: 'pa-btn', title: 'Remove the “# inferred:” comment from the file — you have verified this',
          onClick: () => ctrl.commit(() => edit.confirmNodeFlag(node.id))
            .then((ok) => ok && toast('Confirmed — flag removed from the file')),
        }, '✓ Mark confirmed')));
    }

    if (!freeform) body.append(renderCostSection(node, ro));

    if (placementPosition) {
      body.append(h('div', { class: 'panel-section' },
        h('h3', {}, 'Layout'),
        h('div', { class: 'pin-row' },
          h('span', { class: 'pin-info' }, `Pinned at ${placementPosition.x}, ${placementPosition.y}`),
          ro ? null : h('button', {
            class: 'pa-btn', title: 'Remove the pinned position and return to automatic layout',
            onClick: () => ctrl.commit(() => edit.clearNodePosition(node.id, placement?.ownerId ?? node.ownerId))
              .then((ok) => ok && toast('Released to auto-layout')),
          }, 'Release to auto-layout'))));
    }

    if (node.links.length || node.children) {
      body.append(h('div', { class: 'focus-aux' },
        node.children ? h('button', { class: 'focus-link', onClick: () => ctrl.diveInto(node.id) },
          freeform ? `Open group with ${node.stats.childCount} items` : `Open ${node.stats.childCount}-step sub-map`) : null,
        node.links.map((l) => {
          const href = safeUrl(l.url);
          return href ? h('a', { class: 'focus-link', href, target: '_blank', rel: 'noopener noreferrer' }, l.label) : null;
        })));
    }
  } else {
    hideContextActions();
    const label = h('input', { class: 'f-input', value: node.label });
    const seg = typeSegment(node.type);
    const desc = h('textarea', { class: 'f-textarea' });
    desc.value = node.description;
    const owner = h('input', { class: 'f-input', value: node.owner, placeholder: freeform ? 'Who owns this item?' : 'Who owns it?' });
    const owners = h('textarea', {
      class: 'f-textarea compact-textarea',
      placeholder: 'business -> revenue-operations',
    });
    owners.value = (node.owners ?? []).map((ownerRef) => `${ownerRef.role} -> ${ownerRef.to}`).join('\n');
    const placementNote = h('textarea', {
      class: 'f-textarea compact-textarea',
      placeholder: groupLabel ? `How is this used in ${groupLabel}?` : 'Optional note for this group',
    });
    placementNote.value = placement?.note ?? '';
    const roleIds = state.model.elements
      .filter((element) => element.type === 'role')
      .map((element) => element.id);
    const trigger = h('input', { class: 'f-input', value: node.trigger, placeholder: 'What starts it?' });
    const sla = h('input', { class: 'f-input', value: node.sla, placeholder: 'e.g. 4 hours' });
    const automation = automationSelect(node.automation);
    const systems = h('input', { class: 'f-input', value: node.systems.join(', '), placeholder: 'Salesforce, Plaid' });
    const productMode = !freeform && (state.model.document.kind !== 'process' || !!node.planning);
    const planning = node.planning ?? { type: 'requirement', status: 'draft', priority: 'should', phase: 'next', target: '', acceptance: [], evidence: [], risks: [], dependsOn: [], rice: {} };
    const planningType = enumSelect(PLANNING_TYPES, planning.type || 'requirement');
    const planningStatus = enumSelect(PLAN_STATUSES, planning.status || 'draft');
    const planningPriority = enumSelect(PLAN_PRIORITIES, planning.priority || 'should');
    const phaseOptions = ['now', 'next', 'later'];
    if (planning.phase && !phaseOptions.includes(planning.phase)) phaseOptions.push(planning.phase);
    const planningPhase = enumSelect(phaseOptions, planning.phase || '', 'No horizon');
    const planningTarget = h('input', { class: 'f-input', value: planning.target || '', placeholder: 'e.g. 2026-Q4' });
    const acceptance = h('textarea', { class: 'f-textarea compact-textarea' }); acceptance.value = planning.acceptance.join('\n');
    const evidence = h('textarea', { class: 'f-textarea compact-textarea' }); evidence.value = planning.evidence.join('\n');
    const risks = h('textarea', { class: 'f-textarea compact-textarea' }); risks.value = planning.risks.join('\n');
    const dependsOn = h('input', { class: 'f-input', value: planning.dependsOn.join(', '), placeholder: 'node-id, another-id' });
    const relations = h('textarea', {
      class: 'f-textarea compact-textarea',
      placeholder: freeform ? 'part-of -> parent-element-id' : 'supports -> objective-id',
    });
    relations.value = node.relations.map((relation) => `${relation.type} -> ${relation.to}`).join('\n');
    const planningEnabled = h('input', { type: 'checkbox' });
    planningEnabled.checked = !!node.planning;
    const planningFields = h('div', { class: 'planning-fields' },
      h('div', { class: 'form-row' },
        h('div', { class: 'f-field' }, h('label', {}, 'Planning type'), planningType),
        h('div', { class: 'f-field' }, h('label', {}, 'Status'), planningStatus)),
      h('div', { class: 'form-row' },
        h('div', { class: 'f-field' }, h('label', {}, 'Priority'), planningPriority),
        h('div', { class: 'f-field' }, h('label', {}, 'Roadmap phase'), planningPhase)),
      h('div', { class: 'f-field' }, h('label', {}, 'Target period'), planningTarget),
      h('div', { class: 'f-field' }, h('label', {}, 'Acceptance criteria · one per line'), acceptance),
      h('div', { class: 'form-row' },
        h('div', { class: 'f-field' }, h('label', {}, 'Evidence · one per line'), evidence),
        h('div', { class: 'f-field' }, h('label', {}, 'Risks · one per line'), risks)),
      h('div', { class: 'f-field' }, h('label', {}, 'Dependencies · node ids, comma-separated'), dependsOn));
    const syncPlanningFields = () => { planningFields.hidden = !planningEnabled.checked; };
    planningEnabled.addEventListener('change', syncPlanningFields);
    syncPlanningFields();
    const planningPanel = productMode ? h('div', { class: 'planning-form-block' },
      h('label', { class: 'planning-toggle' }, planningEnabled, h('span', {}, 'Include as a product-planning item')),
      planningFields,
      h('div', { class: 'f-field relation-field' }, h('label', {}, 'Traceability relations · type -> node id'), relations)) : null;
    const linksBox = h('div', {});
    const linkRows = [];
    const addLinkRow = (l = { label: '', url: '' }) => {
      const lab = h('input', { class: 'f-input', placeholder: 'Label', value: l.label ?? '' });
      const url = h('input', { class: 'f-input', placeholder: 'https://…', value: l.url ?? '' });
      const row = h('div', { class: 'link-edit-row' }, lab, url,
        h('button', { class: 'rm', title: 'Remove link', onClick: () => { row.remove(); linkRows.splice(linkRows.indexOf(row), 1); } }, '✕'));
      row.get = () => ({ label: lab.value.trim(), url: url.value.trim() });
      linkRows.push(row);
      linksBox.append(row);
    };
    node.links.forEach(addLinkRow);

    // Escape = cancel edit mode (matches Escape-cancels everywhere else);
    // handled here because the document-level handler ignores typing focus
    body.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      editMode = false;
      renderDetail();
    });

    body.append(
      h('div', { class: 'f-field' }, h('label', {}, 'Label'), label),
      h('div', { class: 'f-field' }, h('label', {}, 'Type'), seg),
      freeform
        ? h('div', { class: 'freeform-shared-fields' },
          h('div', { class: 'f-field' },
            h('label', {}, 'Owners · role -> person or team id'),
            owners,
            h('p', { class: 'field-help' }, roleIds.length
              ? `Person / team ids: ${roleIds.join(', ')}`
              : 'Create a Person / team element first, then link it here.')),
          node.isElement ? h('div', { class: 'f-field' },
            h('label', {}, 'Hierarchy · relation -> element id'),
            relations,
            h('p', { class: 'field-help' }, `${HIERARCHY_RELATION_TYPES.join(', ')}`)) : null,
          placement ? h('div', { class: 'f-field placement-note-field' },
            h('label', {}, `Note for ${groupLabel}`, h('span', { class: 'local-marker' }, 'Local')),
            placementNote) : null)
        : h('div', { class: 'form-row' },
          h('div', { class: 'f-field' }, h('label', {}, 'Owner'), owner),
          h('div', { class: 'f-field' }, h('label', {}, 'Automation'), automation)),
      freeform ? null : h('div', { class: 'form-row' },
        h('div', { class: 'f-field' }, h('label', {}, 'Trigger'), trigger),
        h('div', { class: 'f-field' }, h('label', {}, 'SLA'), sla)),
      freeform ? null : h('div', { class: 'f-field' }, h('label', {}, 'Systems (comma-separated)'), systems),
      ...(planningPanel ? [planningPanel] : []),
      h('div', { class: 'f-field' }, h('label', {}, node.isElement ? 'Shared description' : 'Description'), desc),
      h('div', { class: 'f-field' }, h('label', {}, 'Links'), linksBox,
        h('button', { class: 'add-inline', onClick: () => addLinkRow() }, '+ Add link')),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'd-btn', onClick: () => { editMode = false; renderDetail(); } }, 'Cancel'),
        h('button', {
          class: 'd-btn primary',
          onClick: async () => {
            const ok = await ctrl.commit(() => {
              edit.updateNode(node.id, {
                label: label.value.trim() || node.label,
                type: seg.value(),
                description: desc.value,
                owner: freeform ? undefined : owner.value,
                owners: freeform ? ownerValues(owners.value) : undefined,
                trigger: freeform ? undefined : trigger.value,
                sla: freeform ? undefined : sla.value,
                automation: freeform ? undefined : automation.value,
                systems: freeform ? undefined : systems.value.split(',').map((s) => s.trim()).filter(Boolean),
                planning: productMode ? (planningEnabled.checked ? {
                  ...planning,
                  type: planningType.value,
                  status: planningStatus.value,
                  priority: planningPriority.value,
                  phase: planningPhase.value,
                  target: planningTarget.value,
                  acceptance: lineValues(acceptance.value),
                  evidence: lineValues(evidence.value),
                  risks: lineValues(risks.value),
                  dependsOn: dependsOn.value.split(',').map((value) => value.trim()).filter(Boolean),
                } : null) : undefined,
                relations: freeform && node.isElement
                  ? relationValues(relations.value, HIERARCHY_RELATION_TYPES)
                  : productMode ? relationValues(relations.value) : undefined,
                links: linkRows.map((row) => row.get()).filter((link) => link.url),
              });
              if (placement) edit.updatePlacement(placement.ownerId, node.id, { note: placementNote.value });
            });
            if (ok) { editMode = false; renderDetail(); toast('Saved'); }
          },
        }, 'Save')));
  }

  associateFieldLabels(body);
  panel.replaceChildren(head, body);

  if (editMode) {
    const first = panel.querySelector('input.f-input');
    first?.focus();
    first?.select();
  }

  if (!editMode && !ro) {
    panel.append(h('div', { class: 'panel-actions' },
      freeform
        ? h('button', { class: 'pa-btn primary-action', onClick: () => { editMode = true; renderDetail(); } },
          node.isElement ? 'Edit shared element' : 'Edit group')
        : node.planning
          ? h('button', { class: 'pa-btn primary-action', onClick: () => { editMode = true; renderDetail(); } }, 'Edit requirement →')
          : h('button', { class: 'pa-btn primary-action', onClick: () => beginAutomation(node) }, 'Design automation →')));
  }
}

// ── cost section (detail panel) ──────────────────────────────────────
// Five inputs → one comment-preserving commit. Empty input = unknown (the
// field is removed from the file); unknowns show "—" and stay out of totals.
function renderCostSection(node, ro) {
  const cm = state.model?.costModel ?? {};
  const cur = cm.currency ?? 'USD';
  const rc = nodeCost(node, cm);

  const section = h('div', { class: 'panel-section' }, h('h3', {}, 'Cost — human vs. agent'));

  if (ro) {
    section.append(rc
      ? costSummary(rc, cur)
      : h('div', { class: 'desc placeholder' }, 'No cost data.'));
    return section;
  }

  const val = (x) => (x == null ? '' : String(x));
  const runs = h('input', { class: 'f-input c-num', type: 'number', min: '0', step: 'any', placeholder: 'e.g. 120', value: val(node.cost?.runs) });
  const minutes = h('input', { class: 'f-input c-num', type: 'number', min: '0', step: 'any', placeholder: 'e.g. 15', value: val(node.cost?.minutes) });
  const rate = h('input', {
    class: 'f-input c-num', type: 'number', min: '0', step: 'any',
    placeholder: cm.defaultRate != null ? `${cm.defaultRate} (map default)` : 'e.g. 65',
    value: val(node.cost?.rate),
  });
  const perRun = h('input', { class: 'f-input c-num', type: 'number', min: '0', step: 'any', placeholder: 'e.g. 0.40', value: val(node.cost?.perRun) });
  const setup = h('input', { class: 'f-input c-num', type: 'number', min: '0', step: 'any', placeholder: 'one-time, e.g. 1200', value: val(node.cost?.setup) });

  const summaryBox = h('div', {});
  if (rc) summaryBox.append(costSummary(rc, cur));

  const field = (label, input) => h('label', { class: 'c-field' }, h('span', {}, label), input);
  const grid = h('div', { class: 'cost-grid' },
    field('Runs / month', runs),
    field('Human min / run', minutes),
    field(`Rate (${cur}/hr)`, rate),
    field(`Agent ${cur} / run`, perRun),
    field(`Agent setup (${cur})`, setup));

  const parse = (inp) => (inp.value.trim() === '' ? null : inp.value.trim());
  const inputs = [runs, minutes, rate, perRun, setup];
  const save = h('button', {
    class: 'pa-btn primary-ish',
    onClick: () => {
      // mark offending fields inline, not just via toast
      let bad = false;
      for (const inp of inputs) {
        const v = inp.value.trim();
        const invalid = v !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0);
        inp.classList.toggle('invalid', invalid);
        inp.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        bad = bad || invalid;
      }
      if (bad) { toast('Cost inputs must be numbers ≥ 0 — fix the highlighted fields', true); return; }
      ctrl.commit(() => edit.setNodeCost(node.id, {
        runs: parse(runs), minutes: parse(minutes), rate: parse(rate),
        perRun: parse(perRun), setup: parse(setup),
      })).then((ok) => ok && toast('Cost saved'));
    },
  }, 'Save cost');
  const actions = h('div', { class: 'cost-actions' }, save);
  if (node.cost) {
    actions.append(h('button', {
      class: 'pa-btn', title: 'Remove all cost data from this node',
      onClick: () => ctrl.commit(() => edit.setNodeCost(node.id, { runs: null, minutes: null, rate: null, perRun: null, setup: null }))
        .then((ok) => ok && toast('Cost data removed')),
    }, 'Clear'));
  }

  section.append(summaryBox, grid, actions);
  return section;
}

function costSummary(rc, cur) {
  if (!rc.complete) {
    return h('div', { class: 'cost-summary partial' },
      `Incomplete — missing ${rc.missing.join(', ')}. Shown as “—” and excluded from totals.`);
  }
  return h('div', { class: 'cost-summary' },
    h('div', {}, h('b', {}, formatMoney(rc.humanMonthly, cur)), ` human → `, h('b', {}, formatMoney(rc.agentMonthly, cur)), ` agent / month`),
    h('div', { class: 'cost-sub' },
      `${formatMoney(rc.humanPerRun, cur)} vs ${formatMoney(rc.agentPerRun, cur)} per run · saves `,
      h('b', {}, formatMoney(rc.savingsMonthly, cur)), '/mo',
      rc.setup ? ` · setup ${formatMoney(rc.setup, cur)}` : ''));
}

// ── economics panel (map roll-up) ────────────────────────────────────
let econOverride = null; // null = auto (show when the map has cost data)
let econExpanded = false;

export function toggleEconomics() {
  const hasData = state.model ? rollupCost(state.model).costedCount + rollupCost(state.model).partialIds.length > 0 : false;
  const visible = econOverride ?? hasData;
  econOverride = !visible;
  if (econOverride) econExpanded = true; // opening by hand → show the details
  renderEconomics();
}

export function renderEconomics() {
  const box = document.getElementById('economics');
  if (!box) return;
  if (!state.model || state.presenting) { box.hidden = true; return; }
  const r = rollupCost(state.model);
  const hasData = r.costedCount > 0 || r.partialIds.length > 0;
  const visible = econOverride ?? hasData;
  if (!visible) { box.hidden = true; return; }
  box.hidden = false;

  const cur = r.currency;
  const ro = state.standalone;

  const coverage = h('span', {
    class: 'ec-coverage',
    title: 'Steps = process nodes across every level. Only nodes with complete inputs (runs, minutes, rate, agent $/run) enter the totals — unknowns are never counted as zero.',
  }, `${r.costedProcessCount} of ${r.processCount} steps costed${r.partialIds.length ? ` · ${r.partialIds.length} incomplete` : ''}`);

  const summary = h('div', { class: 'ec-summary', onClick: () => { econExpanded = !econExpanded; renderEconomics(); } },
    h('span', { class: 'ec-stat' }, 'Human ', h('b', {}, compactMoney(r.humanMonthly, cur)), '/mo'),
    h('span', { class: 'ec-arrow' }, '→'),
    h('span', { class: 'ec-stat' }, 'Agent ', h('b', {}, compactMoney(r.agentMonthly, cur)), '/mo'),
    h('span', { class: `ec-stat ec-savings${(r.savingsMonthly ?? 0) < 0 ? ' neg' : ''}` }, 'Saves ', h('b', {}, compactMoney(r.savingsMonthly, cur)), '/mo'),
    h('span', { class: 'ec-stat' }, 'Payback ', h('b', {}, formatPayback(r.paybackMonths))),
    coverage,
    h('span', { class: 'ec-chevron' }, econExpanded ? '▾' : '▸'));

  const parts = [summary];
  if (econExpanded) {
    const rows = [
      ['Human cost', `${formatMoney(r.humanMonthly, cur)} / month`],
      ['Agent cost', `${formatMoney(r.agentMonthly, cur)} / month`],
      ['Savings', `${formatMoney(r.savingsMonthly, cur)} / month`],
      ['Agent setup (one-time)', formatMoney(r.setupTotal, cur)],
      ['Payback', formatPayback(r.paybackMonths)],
      ['First-year ROI', formatPercent(r.roiFirstYear)],
    ];
    const grid = h('div', { class: 'ec-grid' });
    for (const [k, v] of rows) { grid.append(h('span', { class: 'ec-k' }, k)); grid.append(h('span', { class: 'ec-v' }, v)); }

    const detail = h('div', { class: 'ec-detail' }, grid);
    if (r.partialIds.length) {
      detail.append(h('div', { class: 'ec-partial' }, 'Incomplete (excluded): ',
        ...r.partialIds.map((id) => h('button', {
          class: 'ec-node-link', onClick: () => ctrl.gotoNode(id).then(() => showDetail(id)),
        }, state.model.byId.get(id)?.label ?? id))));
    }
    if (!r.costedCount && !r.partialIds.length) {
      detail.append(h('p', { class: 'hint' }, 'No cost data yet — select a node and fill in “Cost — human vs. agent” in its panel.'));
    }
    if (!ro) {
      const cm = state.model.costModel ?? {};
      const curIn = h('input', { class: 'f-input c-num', placeholder: 'USD', value: cm.currency ?? '' });
      const rateIn = h('input', { class: 'f-input c-num', type: 'number', min: '0', step: 'any', placeholder: 'e.g. 65', value: cm.defaultRate ?? '' });
      detail.append(h('div', { class: 'ec-settings' },
        h('label', { class: 'c-field' }, h('span', {}, 'Currency'), curIn),
        h('label', { class: 'c-field' }, h('span', {}, 'Default rate (/hr)'), rateIn),
        h('button', {
          class: 'pa-btn',
          onClick: () => ctrl.commit(() => edit.setMapCostModel({
            currency: curIn.value.trim() || null,
            defaultRate: rateIn.value.trim() === '' ? null : rateIn.value.trim(),
          })).then((ok) => ok && toast('Cost defaults saved')),
        }, 'Save defaults')));
    }
    detail.append(h('div', { class: 'ec-formula' },
      'runs/mo × (min ÷ 60 × rate) vs runs/mo × agent $/run · payback = setup ÷ monthly savings'));
    parts.push(detail);
  }

  box.replaceChildren(...parts);
}

function renderEdgeDetail(panel) {
  hideContextActions();
  const sel = state.selectedEdge;
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const e = scope?.edges[sel.index];
  if (!e) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.add('edge-detail');
  panel.classList.remove('editing');
  const from = state.model.byId.get(e.from), to = state.model.byId.get(e.to);

  const freeform = isFreeform();
  // The label commits on blur (Enter blurs) — no Save click, panel stays open.
  const label = h('input', {
    class: 'f-input',
    placeholder: freeform ? 'e.g. reads customer data' : 'e.g. approved / declined',
    value: e.label ?? '',
    readonly: state.standalone ? '' : null,
  });
  const commitLabel = () => {
    const cur = state.selectedEdge;
    if (state.standalone || !cur || cur.scopeId !== sel.scopeId || cur.index !== sel.index) return;
    if (label.value === (e.label ?? '')) return;
    ctrl.commit(() => edit.updateEdgeLabel(cur, label.value));
  };
  label.addEventListener('blur', commitLabel);
  label.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); label.blur(); } });

  // From/To rewire row: every sibling node of this scope, plus Reverse.
  const siblings = scope?.nodes ?? [];
  const endpointSelect = (current, aria) => {
    const select = h('select', {
      class: 'f-select', 'aria-label': aria, disabled: state.standalone ? '' : null,
    }, ...siblings.map((n) => h('option', { value: n.id }, n.label || n.id)));
    if (!siblings.some((n) => n.id === current)) select.append(h('option', { value: current }, current));
    select.value = current;
    return select;
  };
  const fromSel = endpointSelect(e.from, 'From');
  const toSel = endpointSelect(e.to, 'To');
  const rewire = () => {
    const next = { from: fromSel.value, to: toSel.value };
    if (next.from === e.from && next.to === e.to) return;
    ctrl.commit(() => edit.rewireEdge(sel, next)).then((ok) => { if (ok) renderEdgeDetail(panel); });
  };
  fromSel.addEventListener('change', rewire);
  toSel.addEventListener('change', rewire);

  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('span', { class: 'type-pill t-artifact' }, freeform ? '→ connection' : '→ edge'),
      h('h2', {}, `${from?.label ?? e.from} → ${to?.label ?? e.to}`)),
    h('button', { class: 'panel-close', onClick: () => { ctrl.selectEdge(null); panel.hidden = true; } }, '✕'));
  const body = h('div', { class: 'panel-body' },
    h('div', { class: 'panel-section' },
      h('h3', {}, 'Connection'),
      h('div', { class: 'edge-rewire' }, fromSel, h('span', {}, '→'), toSel,
        h('button', {
          class: 'pa-btn', title: 'Swap the direction',
          disabled: state.standalone ? '' : null,
          onClick: () => ctrl.commit(() => edit.reverseEdge(sel)).then((ok) => { if (ok) renderEdgeDetail(panel); }),
        }, '⇄ Reverse'))),
    h('div', { class: 'f-field' }, h('label', {}, freeform ? 'Connection label' : 'Label (what flows / the outcome)'), label));

  // route style: automatic, or a pinned shape the user drags around on the canvas
  const currentRoute = e.route ?? (e.via ? 'curved' : 'auto');
  const pickRoute = (style) => {
    if (state.standalone) return;
    ctrl.commit(() => {
      if (style === 'auto') {
        edit.setEdgeRoute(state.scopeId, sel.index, null);
        edit.clearEdgeVia(state.scopeId, sel.index);
      } else {
        edit.setEdgeRoute(state.scopeId, sel.index, style);
        if (style !== 'straight' && !e.via) {
          const seed = canvas.edgeRouteSeed(sel.index);
          if (seed) edit.setEdgeVia(state.scopeId, sel.index, seed);
        }
      }
    }).then((ok) => { if (ok) renderEdgeDetail(panel); });
  };
  const ROUTE_OPTIONS = [
    ['auto', 'Auto'], ['curved', 'Curved'], ['straight', 'Straight'], ['angled', 'Angled'], ['stepped', 'Stepped'],
  ];
  body.append(h('div', { class: 'panel-section' },
    h('h3', {}, 'Route'),
    h('div', { class: 'route-seg', role: 'group', 'aria-label': 'Route style' },
      ...ROUTE_OPTIONS.map(([id, text]) => h('button', {
        class: `route-seg-btn${currentRoute === id ? ' on' : ''}`,
        'aria-pressed': currentRoute === id ? 'true' : 'false',
        disabled: state.standalone ? '' : null,
        onClick: () => pickRoute(id),
      }, text))),
    currentRoute === 'curved' || currentRoute === 'angled' || currentRoute === 'stepped'
      ? h('p', { class: 'field-help' }, 'Drag the line on the canvas to move the bend. The × on the line releases it back to Auto.')
      : null));

  // provenance flag on this edge (matched by endpoints within this scope)
  const edgeFlag = state.flags?.edges?.find((f) =>
    (f.owner ?? null) === (state.scopeId ?? null) && f.from === e.from && f.to === e.to);
  if (edgeFlag) {
    body.append(h('div', { class: 'panel-section flag-section' },
      h('h3', {}, '⚑ Inferred, not stated'),
      h('div', { class: 'desc' }, edgeFlag.note),
      state.standalone ? null : h('button', {
        class: 'pa-btn', title: 'Remove the “# inferred:” comment from the file — you have verified this',
        onClick: () => ctrl.commit(() => edit.confirmEdgeFlag(state.scopeId, sel.index))
          .then((ok) => ok && toast('Confirmed — flag removed from the file')),
      }, '✓ Mark confirmed')));
  }
  panel.replaceChildren(head, body);
  if (!state.standalone) {
    panel.append(h('div', { class: 'panel-actions' },
      h('button', {
        class: 'pa-btn danger',
        onClick: () => { panel.hidden = true; ctrl.commit(() => edit.deleteEdge(state.scopeId, sel.index)).then((ok) => { if (ok) { ctrl.selectEdge(null); toast('Edge deleted'); } }); },
      }, '🗑 Delete edge')));
  }
}

// ── AI map assistant ───────────────────────────────────────────────
// Chat with the map: the server validates every proposal, and nothing
// applies until the user clicks Apply. Review-before-save, same as Import.
let chatMessages = []; // { role, text, proposal?: { source, summary } }
let chatBusy = false;
let chatFocusId = null; // node the conversation is about, if any

function micIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', 'M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.7');
  p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

// Everything the model needs about the selected node: its fields and the
// edges that touch it, in plain text.
function nodeFocusSummary(node) {
  const lines = [`type: ${node.type}`, `label: ${node.label}`];
  if (node.description) lines.push(`description: ${node.description}`);
  if (node.owner) lines.push(`owner: ${node.owner}`);
  if (node.trigger) lines.push(`trigger: ${node.trigger}`);
  if (node.sla) lines.push(`sla: ${node.sla}`);
  if (node.automation) lines.push(`automation: ${node.automation}`);
  if (node.systems?.length) lines.push(`systems: ${node.systems.join(', ')}`);
  if (node.children) lines.push(`contains: ${node.stats.childCount} child nodes`);
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const nameOf = (id) => state.model.byId.get(id)?.label ?? id;
  const touching = (scope?.edges ?? []).filter((e) => e.from === node.id || e.to === node.id);
  if (touching.length) {
    lines.push('edges:');
    for (const e of touching) {
      lines.push(`  ${nameOf(e.from)} → ${nameOf(e.to)}${e.label ? ` (${e.label})` : ''}`);
    }
  }
  return lines.join('\n');
}

// Open the assistant aimed at one node — the "Ask AI" action on every node.
export function askAiAbout(nodeId) {
  if (!state.model?.byId.has(nodeId)) return;
  chatFocusId = nodeId;
  toggleChat(true);
}

function chatDiffSummary(before, after) {
  const parts = [];
  try {
    const a = parseMap(before).model;
    const b = parseMap(after).model;
    const added = [...b.byId.keys()].filter((k) => !a.byId.has(k));
    const removed = [...a.byId.keys()].filter((k) => !b.byId.has(k));
    const edgeCount = (m) => [...m.byId.values()].reduce((t, n) => t + (n.children?.edges.length ?? 0), m.root.edges.length);
    const edgeDelta = edgeCount(b) - edgeCount(a);
    if (added.length) parts.push(`+${added.length} ${added.length === 1 ? 'node' : 'nodes'} (${added.slice(0, 3).join(', ')}${added.length > 3 ? '…' : ''})`);
    if (removed.length) parts.push(`−${removed.length} ${removed.length === 1 ? 'node' : 'nodes'} (${removed.slice(0, 3).join(', ')}${removed.length > 3 ? '…' : ''})`);
    if (edgeDelta) parts.push(`${edgeDelta > 0 ? '+' : ''}${edgeDelta} ${Math.abs(edgeDelta) === 1 ? 'edge' : 'edges'}`);
    if (!parts.length) parts.push('Content edits, no structural change');
  } catch { parts.push('Map update'); }
  return parts.join(' · ');
}

function renderChat() {
  const dock = document.getElementById('chat-dock');
  if (!dock) return;
  const list = h('div', { class: 'chat-list' });
  if (!chatMessages.length) {
    list.append(h('div', { class: 'chat-empty' },
      'Describe a change and I will propose it as a reviewed edit — nothing applies until you click Apply.',
      h('small', {}, 'Try: “add a decision after triage for whether the bug is a duplicate”')));
  }
  for (const msg of chatMessages) {
    if (msg.role === 'user') {
      list.append(h('div', { class: 'chat-msg user' }, msg.text));
    } else {
      const bubble = h('div', { class: 'chat-msg ai' }, msg.text);
      if (msg.proposal && !msg.proposal.settled) {
        bubble.append(h('div', { class: 'chat-proposal' },
          h('span', { class: 'chat-proposal-summary' }, msg.proposal.summary),
          h('div', { class: 'chat-proposal-actions' },
            h('button', {
              class: 'd-btn primary',
              onClick: async () => {
                const ok = await ctrl.applySource(msg.proposal.source, 'AI edit');
                msg.proposal.settled = ok ? 'applied' : 'rejected';
                if (ok) toast('Applied — the map file is updated');
                renderChat();
              },
            }, 'Apply'),
            h('button', {
              class: 'd-btn',
              onClick: () => { msg.proposal.settled = 'dismissed'; renderChat(); },
            }, 'Dismiss'))));
      } else if (msg.proposal?.settled === 'applied') {
        bubble.append(h('div', { class: 'chat-settled' }, `✓ Applied · ${msg.proposal.summary}`));
      } else if (msg.proposal?.settled === 'dismissed') {
        bubble.append(h('div', { class: 'chat-settled dismissed' }, `Dismissed · ${msg.proposal.summary}`));
      }
      list.append(bubble);
    }
  }
  if (chatBusy) list.append(h('div', { class: 'chat-msg ai thinking' }, 'Working on it…'));
  const input = h('textarea', {
    class: 'chat-input', rows: '2',
    placeholder: state.standalone ? 'The assistant needs the local Serigraph server.' : 'Tell the map what to change…',
    disabled: state.standalone ? '' : null,
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChat(input.value); }
    if (ev.key === 'Escape') { ev.stopPropagation(); toggleChat(false); }
  });
  // voice input: browser recognizer by default, or API transcription when AI
  // settings say so — either way, speech lands in the box and nothing sends
  // until the user presses Send
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const apiVoice = state.aiSettings?.voiceProvider === 'api';
  let micBtn = null;
  if ((SpeechRecognition || apiVoice) && !state.standalone) {
    let rec = null;
    let mediaRec = null;
    micBtn = h('button', {
      class: 'chat-mic', title: 'Dictate your request', 'aria-label': 'Dictate your request',
      onClick: async () => {
        if (apiVoice) {
          if (mediaRec) { mediaRec.stop(); return; }
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (e) {
            toast(`Microphone unavailable: ${e.message}`, true);
            return;
          }
          const chunks = [];
          mediaRec = new MediaRecorder(stream);
          const mime = mediaRec.mimeType || 'audio/webm';
          mediaRec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
          mediaRec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            mediaRec = null;
            micBtn.classList.remove('recording');
            try {
              const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(String(reader.result).split(',')[1] ?? '');
                reader.readAsDataURL(new Blob(chunks, { type: mime }));
              });
              micBtn.classList.add('thinking');
              const { text } = await api.transcribe(base64, mime);
              input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + text;
            } catch (e) {
              toast(e.message, true);
            } finally {
              micBtn.classList.remove('thinking');
            }
          };
          mediaRec.start();
          micBtn.classList.add('recording');
          return;
        }
        if (rec) { rec.stop(); return; }
        rec = new SpeechRecognition();
        rec.lang = 'en-US';
        rec.interimResults = true;
        const base = input.value;
        rec.onresult = (ev) => {
          let text = '';
          for (const r of ev.results) text += r[0].transcript;
          input.value = (base ? base.replace(/\s+$/, '') + ' ' : '') + text;
        };
        rec.onend = () => { rec = null; micBtn.classList.remove('recording'); };
        rec.onerror = () => { rec = null; micBtn.classList.remove('recording'); };
        rec.start();
        micBtn.classList.add('recording');
      },
    }, micIcon());
  }
  const focusNode = chatFocusId ? state.model?.byId.get(chatFocusId) : null;
  dock.replaceChildren(
    h('div', { class: 'chat-head' },
      h('div', {}, h('span', { class: 'chat-kicker' }, 'Map assistant'), h('strong', {}, state.model?.name ?? '')),
      h('div', { class: 'chat-head-actions' },
        state.standalone ? null : h('button', { class: 'panel-close chat-settings-btn', title: 'AI settings', onClick: () => bus.emit('ai-settings-request') }, '⚙'),
        h('button', { class: 'panel-close', onClick: () => toggleChat(false) }, '✕'))),
    ...(focusNode ? [h('div', { class: 'chat-focus' },
      h('span', {}, `About: ${focusNode.label}`),
      h('button', { title: 'Clear the focus — talk about the whole map', onClick: () => { chatFocusId = null; renderChat(); } }, '×'))] : []),
    list,
    h('div', { class: 'chat-compose' },
      input,
      micBtn,
      h('button', { class: 'd-btn primary chat-send', onClick: () => sendChat(input.value) }, 'Send')));
  list.scrollTop = list.scrollHeight;
  if (!dock.hidden && !chatBusy) input.focus();
}

async function sendChat(text) {
  const instruction = String(text || '').trim();
  if (!instruction || chatBusy || state.standalone) return;
  chatMessages.push({ role: 'user', text: instruction });
  chatBusy = true;
  renderChat();
  try {
    const history = chatMessages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.role === 'user' ? m.text : (m.proposal ? `Proposed map update: ${m.proposal.summary}` : m.text),
    }));
    const focusNode = chatFocusId ? state.model?.byId.get(chatFocusId) : null;
    const focus = focusNode ? { id: focusNode.id, summary: nodeFocusSummary(focusNode) } : null;
    const result = await api.chat(instruction, history, focus, currentProjectSlug());
    const summary = chatDiffSummary(state.source, result.source);
    chatMessages.push({ role: 'assistant', text: 'Here is the proposed change.', proposal: { source: result.source, summary } });
  } catch (e) {
    chatMessages.push({ role: 'assistant', text: e.message });
  }
  chatBusy = false;
  renderChat();
}

export function toggleChat(force) {
  const dock = document.getElementById('chat-dock');
  if (!dock) return;
  const show = force ?? dock.hidden;
  dock.hidden = !show;
  if (show) { ctrl.loadAiSettings().then(() => { if (!dock.hidden) renderChat(); }); renderChat(); }
  else document.getElementById('canvas')?.focus();
}

// ── transcript importer (✨ Import) ──────────────────────────────────
// Paste → derive (server-side LLM) → REVIEW (stats + inferred flags) → save.
// Nothing touches maps/ until the user approves the review step.
export async function importDialog() {
  if (state.standalone || !document.getElementById('dialog-root')) return;
  const root = document.getElementById('dialog-root');
  const dialog = h('div', { class: 'dialog import-dialog', role: 'dialog', 'aria-label': 'New map from transcript' });
  const backdrop = h('div', { class: 'dialog-backdrop', onPointerdown: (ev) => { if (ev.target === backdrop) close(); } }, dialog);
  let closed = false;
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  }
  document.addEventListener('keydown', onKey, true);
  root.append(backdrop);

  const status = await api.importStatus().catch(() => ({ available: false, hint: 'Could not reach the Serigraph server.' }));

  let transcript = '';

  function renderPaste(importError = null) {
    const ta = h('textarea', {
      class: 'f-textarea import-ta',
      placeholder: 'Paste the meeting / discovery-call transcript here…',
      ...(status.available ? {} : { disabled: 'disabled' }),
    });
    ta.value = transcript;
    const counter = h('span', { class: 'import-count' }, '');
    ta.addEventListener('input', () => { counter.textContent = ta.value.trim() ? `${ta.value.trim().length.toLocaleString()} chars` : ''; });

    // A derive that failed with llm-no-provider replaces the provider line
    // with the three ways to point the server at a model.
    const providerLine = importError?.data?.code === 'llm-no-provider'
      ? h('div', { class: 'hint-box' },
        h('strong', {}, 'No model provider is configured. '),
        'Pick one setup path, then try again: add ANTHROPIC_API_KEY to a .env file next to the server, as .env.example shows, log in with the claude CLI, or set OPSMAP_LLM_CMD to a command that prints the reply.')
      : status.available
        ? h('p', { class: 'hint' }, `The transcript is sent to your configured model (${status.provider}: ${status.model}) from the local server — steps, decisions, roles, systems, and artifacts come back as a map you review before anything is saved.`)
        : h('p', { class: 'hint import-unavailable' }, `⚠ Transcript import is disabled — no model is configured. ${status.hint ?? ''}`);

    dialog.replaceChildren(
      h('h2', {}, '✨ New map from transcript'),
      providerLine,
      ta,
      h('div', { class: 'import-row' }, counter),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'd-btn', onClick: close }, 'Cancel'),
        h('button', {
          class: 'd-btn primary',
          ...(status.available ? {} : { disabled: 'disabled' }),
          onClick: () => {
            transcript = ta.value;
            if (transcript.trim().length < 120) { toast('Paste the full transcript — a few hundred words minimum.', true); return; }
            renderProgress();
            api.importTranscript(transcript, currentProjectSlug())
              .then((result) => { if (!closed) renderReview(result); })
              .catch((e) => {
                if (closed) return;
                renderPaste(e);
                if (e?.data?.code !== 'llm-no-provider') toast(e.message, true);
              });
          },
        }, 'Derive the map')));
    if (status.available) ta.focus();
  }

  function renderProgress() {
    dialog.replaceChildren(
      h('h2', {}, '✨ Deriving the map…'),
      h('div', { class: 'import-progress' },
        h('div', { class: 'import-spinner' }),
        h('p', {}, 'Reading the transcript, extracting steps, decisions, roles, systems, and artifacts.'),
        h('p', { class: 'hint' }, 'Typically 30–90 seconds. Only what the transcript supports is included; anything inferred gets flagged for your review.')),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'd-btn', onClick: close }, 'Cancel')));
  }

  function renderReview({ source, review }) {
    const nameIn = h('input', { class: 'f-input', value: review.name ?? 'Imported map' });
    const typeChips = Object.entries(review.types).filter(([, n]) => n > 0)
      .map(([t, n]) => h('span', { class: `type-pill t-${t}` }, `${n} ${t}${n === 1 ? '' : t === 'process' ? 'es' : 's'}`));

    const flags = review.flags ?? [];
    const flagsBox = flags.length
      ? h('div', { class: 'import-flags' },
        h('h3', {}, `⚑ Inferred, not stated — confirm after saving (${flags.length})`),
        h('ul', {}, flags.map((f) => h('li', {},
          h('b', {}, f.label), ' — ', f.note,
          f.kind === 'edge' ? h('span', { class: 'import-flag-kind' }, ' (edge)') : null))),
        h('p', { class: 'hint' }, 'These carry an “# inferred:” comment in the saved YAML, so the flags stay with the file.'))
      : h('p', { class: 'hint' }, 'Nothing was inferred — every element is stated in the transcript.');

    dialog.replaceChildren(
      h('h2', {}, 'Review before saving'),
      h('div', { class: 'import-stats' },
        h('span', { class: 'import-stat' }, h('b', {}, String(review.nodeCount)), ' nodes'),
        h('span', { class: 'import-stat' }, h('b', {}, String(review.edgeCount)), ' edges'),
        h('span', { class: 'import-stat' }, h('b', {}, String(review.depth)), ` level${review.depth === 1 ? '' : 's'}`),
        ...typeChips),
      flagsBox,
      h('div', { class: 'f-field' }, h('label', {}, 'Map name'), nameIn),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'd-btn', onClick: () => renderPaste() }, '‹ Back'),
        h('button', { class: 'd-btn', onClick: close }, 'Discard'),
        h('button', {
          class: 'd-btn primary',
          onClick: async () => {
            const name = nameIn.value.trim() || 'Imported map';
            try {
              const { id } = await api.createMap(name, 'process', currentProjectSlug());
              // the generated YAML is the source of truth; keep the user's name
              const named = source.replace(/^name:.*$/m, `name: ${JSON.stringify(name)}`);
              await api.saveMap(id, named);
              close();
              await ctrl.loadMapList();
              await ctrl.openMap(id);
              toast(`Imported “${name}” — review the ⚑ flagged items, then add costs to see the economics`);
            } catch (e) {
              toast(e.message, true);
            }
          },
        }, 'Create map')));
  }

  renderPaste();
}

// ── node palette (drag a type onto the canvas) ───────────────────────

// create a node pinned at a world point in the current scope (palette drop /
// canvas double-click), then open it for naming
export function createNodeAt(type, world) {
  const position = { x: Math.round(world.x), y: Math.round(world.y) };
  if (isFreeform()) {
    if (state.scopeId == null) addNodeDialog(null, { type: 'item', position });
    else addElementDialog(state.scopeId, { type, position });
    return;
  }
  const label = `New ${typeLabel(type)}`;
  const id = edit.uniqueId(state.model, edit.slugify(label));
  ctrl.commit(
    () => edit.addNode(state.scopeId, { id, type, label, position }),
    { select: id },
  ).then((ok) => {
    if (!ok) return;
    showDetail(id, { edit: true });
    toast(`Added ${typeLabel(type)}. Name it in the panel.`);
  });
}

function createNodeInside(type, containerId) {
  if (isFreeform()) {
    addElementDialog(containerId, { type });
    return;
  }
  const label = `New ${typeLabel(type)}`;
  const id = edit.uniqueId(state.model, edit.slugify(label));
  const contLabel = state.model.byId.get(containerId)?.label ?? containerId;
  ctrl.commit(() => edit.addNode(containerId, { id, type, label }))
    .then((ok) => ok && toast(`Added ${typeLabel(type)} inside “${contLabel}”. Double-click it to open.`));
}

function initPalette() {
  const pal = document.getElementById('palette');
  if (!pal || state.standalone) return;
  // Serigraph's Unit flyout owns the visible type palette. Keeping this host
  // hidden avoids a second floating toolbar while the same drag-to-create
  // interaction is attached to the flyout buttons by workbench.js.
  pal.hidden = true;
}

export function enableNodeTypeDrag(chip, type, { onActivate, onComplete } = {}) {
  chip.addEventListener('pointerdown', (ev) => startPaletteDrag(ev, type, chip, { onActivate, onComplete }));
}

function startPaletteDrag(ev, type, chip, { onActivate, onComplete } = {}) {
  if (ev.button !== 0 || state.presenting || !state.model) return;
  ev.preventDefault();
  const pid = ev.pointerId;
  try { chip.setPointerCapture(pid); } catch { /* stale pointer */ }
  let ghost = null;
  let moved = false;

  const onMove = (e) => {
    if (e.pointerId !== pid) return;
    if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) <= 4) return;
    if (!moved) {
      moved = true;
      ghost = h('div', { class: 'pal-ghost' }, typeIcon(type, 14), typeLabel(type));
      document.body.append(ghost);
    }
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    const info = canvas.dropInfo(e.clientX, e.clientY);
    canvas.setDropHighlight(info.kind === 'container' ? info.id : null);
    ghost.classList.toggle('ok', info.kind === 'canvas' || info.kind === 'container');
  };
  const finish = (e, cancelled) => {
    try { chip.releasePointerCapture(pid); } catch { /* already released */ }
    chip.removeEventListener('pointermove', onMove);
    chip.removeEventListener('pointerup', onUp);
    chip.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey, true);
    ghost?.remove();
    canvas.setDropHighlight(null);
    if (cancelled) return;
    if (!moved) {
      if (onActivate) onActivate();
      else addNodeDialog(state.scopeId, type);
      return;
    }
    const info = canvas.dropInfo(e.clientX, e.clientY);
    if (info.kind === 'canvas') createNodeAt(type, info.world);
    else if (info.kind === 'container') createNodeInside(type, info.id);
    else if (info.kind === 'node') toast('Drop on empty canvas — or on a container to nest inside it');
    onComplete?.();
  };
  const onUp = (e) => { if (e.pointerId === pid && e.button === 0) finish(e, false); };
  const onCancel = (e) => { if (e.pointerId === pid) finish(e, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e, true); } };
  chip.addEventListener('pointermove', onMove);
  chip.addEventListener('pointerup', onUp);
  chip.addEventListener('pointercancel', onCancel);
  document.addEventListener('keydown', onKey, true);
}

// ── templates panel ──────────────────────────────────────────────────
export function toggleTemplates(force) {
  const panel = document.getElementById('templates-panel');
  if (!panel) return;
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  if (show) renderTemplates();
}

function renderTemplates() {
  const panel = document.getElementById('templates-panel');
  const freeform = isFreeform();
  const templates = state.templates.filter((template) => (template.mode ?? 'process') === (freeform ? 'freeform' : 'process'));
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('h2', {}, 'Template library'),
      h('span', { class: 'node-id' }, freeform ? 'reusable map blocks. Insert, then customize' : 'reusable process blocks. Insert, then customize')),
    h('button', { class: 'panel-close', onClick: () => toggleTemplates(false) }, '✕'));
  const list = h('div', { class: 'tpl-list' });
  if (!templates.length) {
    list.append(h('p', { class: 'hint', style: 'padding:8px 6px' },
      freeform ? 'No freeform templates found.' : 'No process templates found.'));
  }
  for (const t of templates) {
    list.append(h('div', { class: 'tpl-card' },
      h('h4', {}, t.name),
      h('p', {}, t.description || ''),
      h('div', { class: 'tpl-meta' }, `${t.nodeCount} nodes · templates/${t.id}.yaml`),
      h('button', {
        class: 'tpl-insert',
        onClick: () => {
          const { model: tplModel, errors } = parseMap(t.source);
          if (!tplModel) { toast(`Template has errors: ${errors[0]?.message}`, true); return; }
          let inserted;
          ctrl.commit(() => { inserted = edit.insertTemplate(state.scopeId, tplModel); })
            .then((ok) => {
              if (ok) {
                toggleTemplates(false);
                if (inserted?.[0]) { ctrl.selectNode(inserted[0]); canvas.centerOn(inserted[0]); showDetail(inserted[0]); }
                toast(`Inserted “${t.name}”. ${inserted.length} ${inserted.length === 1 ? 'node' : 'nodes'} added.`);
              }
            });
        },
      }, `Insert into ${state.scopeId ? `“${state.model.byId.get(state.scopeId)?.label}”` : 'this level'}`)));
  }
  panel.replaceChildren(head, list);
}

// ── rename popover (F2 / double-click a leaf node) ───────────────────
// canvas.js and main.js emit node-rename-request with the node's screen
// position; when no position is reachable the popover opens centered.
let renamePopover = null; // { finish } of the open popover, if any

function openRenamePopover({ id, screen } = {}) {
  const node = state.model?.byId.get(id);
  if (!node || state.standalone) return;
  renamePopover?.finish(true); // a second request commits the open one, like blur
  const input = h('input', { class: 'rename-popover', value: node.label, 'aria-label': `Rename ${node.label}` });
  input.style.position = 'fixed';
  input.style.left = `${Math.round(screen?.x ?? window.innerWidth / 2)}px`;
  input.style.top = `${Math.round(screen?.y ?? window.innerHeight / 2)}px`;
  input.style.transform = 'translate(-50%, -50%)';
  input.style.zIndex = '60';
  let done = false;
  const finish = (commitIt) => {
    if (done) return;
    done = true;
    renamePopover = null;
    input.remove();
    const label = input.value.trim();
    if (commitIt && label && label !== node.label) ctrl.commit(() => edit.updateNode(id, { label }));
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  renamePopover = { finish };
  document.body.append(input);
  input.focus();
  input.select();
}

// ── search palette ───────────────────────────────────────────────────
const RECENT_SEARCHES_KEY = 'opsmap.recentSearches';
function readRecentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]');
    return Array.isArray(list) ? list.filter((q) => typeof q === 'string' && q.trim()).slice(0, 5) : [];
  } catch { return []; }
}
function pushRecentSearch(query) {
  const q = query.trim();
  if (!q) return;
  const list = [q, ...readRecentSearches().filter((x) => x !== q)].slice(0, 5);
  try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch { /* browser storage is optional */ }
}
export function openSearch() {
  if (!state.model) return;
  const overlay = document.getElementById('search-overlay');
  overlay.hidden = false;

  const input = h('input', { placeholder: 'Search nodes by name, id, or description…', 'aria-label': 'Search nodes' });
  const chips = h('div', { class: 'search-chips', hidden: '' });
  const results = h('div', { class: 'palette-results' });
  const foot = h('div', { class: 'palette-foot' },
    h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' navigate'),
    h('span', {}, h('kbd', {}, '↵'), ' open'),
    h('span', {}, h('kbd', {}, 'esc'), ' close'));
  const pal = h('div', { class: 'palette' }, input, chips, results, foot);
  overlay.replaceChildren(pal);

  const all = [...state.model.byId.values()];
  let items = [];
  let active = 0;

  const pathOf = (n) => {
    const chain = ancestryOf(state.model, n.id).slice(0, -1);
    return [state.model.name, ...chain.map((id) => state.model.byId.get(id)?.label ?? id)].join(' › ');
  };

  function score(n, q) {
    const label = n.label.toLowerCase(), id = n.id.toLowerCase(), desc = (n.description || '').toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if (id.includes(q)) return 2;
    if (desc.includes(q)) return 3;
    return -1;
  }

  function update() {
    const q = input.value.trim().toLowerCase();
    // with an empty query, offer the recent searches as one-click chips
    const recents = q ? [] : readRecentSearches();
    chips.replaceChildren(...recents.map((recent) => h('button', {
      class: 'search-chip',
      onClick: () => { input.value = recent; update(); input.focus(); },
    }, recent)));
    chips.hidden = !recents.length;
    const scored = q
      ? all.map((n) => ({ n, s: score(n, q) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s || a.n.depth - b.n.depth)
      : all.filter((n) => n.depth === 0).map((n) => ({ n, s: 0 }));
    items = scored.slice(0, 40).map((x) => x.n);
    active = 0;
    results.replaceChildren();
    if (!items.length) {
      results.append(h('div', { class: 'palette-empty' }, `No nodes match “${input.value}”`));
      return;
    }
    items.forEach((n, i) => {
      results.append(h('button', {
        class: `pal-item${i === active ? ' active' : ''}`,
        onClick: () => pick(n),
        onPointermove: () => { active = i; paint(); },
      },
      h('span', { class: `pal-icon t-${n.type}` }, typeIcon(n.type, 13)),
      h('span', {},
        h('div', { class: 'pal-label' }, n.label, n.children ? ` ▸ ${n.stats.childCount}` : ''),
        h('div', { class: 'pal-path' }, pathOf(n)))));
    });
  }
  function paint() {
    [...results.children].forEach((c, i) => c.classList?.toggle('active', i === active));
  }
  function pick(n) {
    pushRecentSearch(input.value);
    bus.emit('workspace-map-request');
    close();
    ctrl.gotoNode(n.id).then(() => showDetail(n.id));
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.hidden = true;
    document.getElementById('canvas').focus();
  }
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); active = Math.min(items.length - 1, active + 1); paint(); results.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); active = Math.max(0, active - 1); paint(); results.children[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); if (items[active]) pick(items[active]); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) close(); }, { once: true });
  input.addEventListener('input', update);
  update();
  input.focus();
}

// ── canvas-level messages (errors / empty states) ────────────────────
function renderCanvasMessage() {
  const box = document.getElementById('canvas-msg');
  const home = document.getElementById('projects-home');
  const atHome = !state.mapId;
  document.getElementById('stage')?.classList.toggle('home-active', atHome);
  if (home) home.hidden = !atHome;
  if (atHome) {
    box.hidden = true;
    renderHome();
    return;
  }
  if (state.mapId && !state.model) {
    box.hidden = false;
    box.replaceChildren(h('div', { class: 'map-card' },
      h('h2', {}, h('span', { class: 'err-badge' }, '⚠'), ' This map can’t be drawn yet'),
      h('p', {}, `maps/${state.mapId}.yaml has ${state.errors.length} problem${state.errors.length === 1 ? '' : 's'}. Fix the file in your editor — the canvas updates the moment you save.`),
      h('ul', { class: 'err-list' }, state.errors.slice(0, 20).map((e) =>
        h('li', {}, e.line ? h('span', { class: 'ln' }, `line ${e.line}`) : null, ` ${e.message}`))),
      h('p', {}, 'The file format is documented in docs/FORMAT.md.')));
    return;
  }
  const scope = state.model ? (state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children) : null;
  if (state.model && scope && scope.nodes.length === 0) {
    box.hidden = false;
    box.replaceChildren(h('div', { class: 'map-card' },
      h('h2', {}, state.scopeId == null ? 'This map is empty' : 'Nothing in here yet'),
      h('p', {}, isFreeform() ? 'Add your first item, or start from a template.' : 'Add your first node, or start from a template block.'),
      state.standalone ? null : h('div', { class: 'empty-actions' },
        h('button', { class: 'd-btn primary', onClick: () => addNodeDialog(state.scopeId) }, isFreeform() ? '+ Add an item' : '+ Add a node'),
        h('button', { class: 'd-btn', onClick: () => toggleTemplates(true) }, 'Browse templates'))));
    return;
  }
  box.hidden = true;
}

// ── save conflict ────────────────────────────────────────────────────
// api.js emits save-conflict when the file on disk changed under the open
// map. Keep = overwrite the file; Load = drop local edits for the disk copy.
let saveConflictEl = null;

function saveConflictDialog() {
  if (saveConflictEl?.isConnected) return; // one conflict dialog at a time
  const body = h('div', {},
    h('p', {}, 'The saved file changed since this map was loaded. Saving now would overwrite that version.'),
    h('p', { class: 'hint' }, 'Keep your version to overwrite the file, or load the saved file and redo your edits on top of it.'));
  saveConflictEl = body;
  modal('The file changed on disk', body, [
    { label: 'Keep my version', primary: true, onClick: () => ctrl.keepMyVersion() },
    { label: 'Load the saved file', onClick: () => ctrl.loadSavedFile() },
  ]);
}

// ── workbench conflict dialog ────────────────────────────────────────
// A link conflict used to hide behind a toast plus the Share & sync sheet;
// surface it as a modal with the same choices and a way out: Disconnect.
let workbenchConflictEl = null;

function workbenchConflictDialog(connection) {
  const body = h('div', {},
    h('p', {}, connection.remoteMissing
      ? 'The map section was removed from Workbench after the local map changed.'
      : 'The local and Workbench copies both changed. Choose which copy to keep.'),
    h('p', { class: 'hint' }, `Linked document: ${connection.title || connection.docId}. Disconnecting keeps the local map and drops the link.`));
  workbenchConflictEl = body;
  modal('Map changed in two places', body, [
    { label: 'Decide later' },
    connection.remoteMissing ? null : {
      label: 'Use Workbench copy',
      onClick: async () => { await useWorkbenchCopy(); },
    },
    connection.role === 'edit' ? {
      label: 'Publish local copy',
      onClick: async () => { await sendLocalCopy(); },
    } : null,
    {
      label: 'Disconnect',
      // disconnectWorkbenchLink() clears the link and toasts itself
      onClick: async () => { await disconnectWorkbenchLink(); },
    },
  ].filter(Boolean));
}

// ── reactive wiring ──────────────────────────────────────────────────
export function initUI() {
  initPalette();
  bus.on('map-opened', () => { econOverride = null; econExpanded = false; });
  bus.on('view-changed', () => {
    contextActionsArmed = null;
    hideContextActions();
    clearScenarioPreview();
    renderBreadcrumbs();
    renderSwitcher();
    renderMapMode();
    renderCanvasMessage();
    renderEconomics();
    if (state.workspaceView !== 'map') hideDetail();
    else if (state.selectedId) showDetail(state.selectedId);
    else if (state.selectedEdge == null) hideDetail();
    const mm = document.getElementById('minimap');
    const curScope = state.model ? (state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children) : null;
    if (mm) mm.hidden = !curScope || curScope.nodes.length === 0;
  });
  let panelTimer = null;
  bus.on('selection-changed', () => {
    clearTimeout(panelTimer);
    if (state.workspaceView !== 'map') { hideDetail(); return; }
    if (contextActionsArmed !== state.selectedId) hideContextActions();
    if (state.selectedId) {
      // open just past the double-click window: the first click of a
      // dblclick must not reflow the canvas before the second click lands
      const id = state.selectedId;
      panelTimer = setTimeout(() => {
        if (state.selectedId === id) showDetail(id);
      }, 230);
    } else if (state.selectedEdge != null) renderDetail();
    else hideDetail();
  });
  bus.on('maps-listed', () => { renderSwitcher(); if (!state.mapId) renderHome(); });
  bus.on('projects-listed', () => { if (!state.mapId) renderHome(); });
  bus.on('trash-listed', () => { if (!state.mapId) renderHome(); });
  bus.on('templates-loaded', () => {
    if (!document.getElementById('templates-panel').hidden) renderTemplates();
  });
  bus.on('map-opened', () => { renderBreadcrumbs(); renderSwitcher(); renderMapMode(); renderCanvasMessage(); });
  bus.on('camera-changed', () => { positionContextActions(); positionScenarioPreview(); });
  bus.on('node-rename-request', openRenamePopover);
  bus.on('save-conflict', ({ mapId } = {}) => {
    if (mapId && mapId !== state.mapId) return;
    saveConflictDialog();
  });
  bus.on('workbench-changed', (connection) => {
    if (!connection?.conflict) return;
    if (workbenchConflictEl?.isConnected) return; // already showing
    if (document.querySelector('.workbench-backdrop')) return; // Share & sync shows the same choice
    workbenchConflictDialog(connection);
  });

  document.getElementById('map-switcher').addEventListener('click', (ev) => openMapMenu(ev.currentTarget));
  document.getElementById('map-mode')?.addEventListener('click', (ev) => openModeMenu(ev.currentTarget));

  if (state.standalone) {
    for (const id of ['btn-templates', 'btn-projects']) document.getElementById(id)?.remove();
  }
}
