// All chrome around the canvas: detail panel, dialogs, template browser,
// search palette, breadcrumbs, map switcher, toasts, error/empty states.
import { parseMap, NODE_TYPES, ancestryOf } from '../shared/model.js';
import { state, bus } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import * as canvas from './canvas.js';
import { ICONS } from './canvas.js';

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
export function toast(msg, isError = false) {
  const t = h('div', { class: `toast${isError ? ' error' : ''}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, isError ? 5000 : 2400);
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
  const current = state.maps.find((m) => m.id === state.mapId);
  nameEl.textContent = current?.name ?? state.model?.name ?? state.mapId ?? 'No map';
}

function openMapMenu(anchor) {
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu', style: `top:${r.bottom + 6}px;left:${r.left}px` });
  for (const m of state.maps) {
    menu.append(h('button', {
      class: `menu-item${m.id === state.mapId ? ' current' : ''}${m.invalid ? ' invalid' : ''}`,
      onClick: () => { closeMenus(); ctrl.openMap(m.id); },
    },
    h('span', { class: 'mi-name' }, m.name || m.id),
    h('span', { class: 'mi-sub' }, m.invalid ? `⚠ ${m.errorCount} problem${m.errorCount === 1 ? '' : 's'} — open to see details` : `${m.nodeCount} nodes · maps/${m.file}`)));
  }
  if (!state.standalone) {
    menu.append(h('div', { class: 'menu-sep' }));
    menu.append(h('button', { class: 'menu-item', onClick: () => { closeMenus(); newMapDialog(); } },
      h('span', { class: 'mi-name' }, '+ New map…')));
  }
  document.body.append(menu);
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target)) closeMenus(); };
    document.addEventListener('pointerdown', close, { once: true });
  }, 0);
}
function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }

// ── dialogs ──────────────────────────────────────────────────────────
function modal(title, body, actions) {
  const root = document.getElementById('dialog-root');
  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
    h('h2', {}, title), body,
    h('div', { class: 'dialog-actions' }, actions.map((a) =>
      h('button', {
        class: `d-btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
        onClick: () => { const r = a.onClick?.(); if (r !== false) close(); },
      }, a.label))));
  const backdrop = h('div', { class: 'dialog-backdrop', onPointerdown: (ev) => { if (ev.target === backdrop) close(); } }, dialog);
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    if (ev.key === 'Enter' && !ev.shiftKey && ev.target.tagName !== 'TEXTAREA') {
      const primary = actions.find((x) => x.primary);
      if (primary) { ev.preventDefault(); ev.stopPropagation(); const r = primary.onClick?.(); if (r !== false) close(); }
    }
  };
  function close() { document.removeEventListener('keydown', onKey, true); backdrop.remove(); }
  document.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  dialog.querySelector('input, textarea')?.focus();
  return close;
}

function typeSegment(initial) {
  let value = initial;
  const seg = h('div', { class: 'type-seg' });
  for (const t of NODE_TYPES) {
    const b = h('button', {
      class: `t-${t}${t === value ? ' on' : ''}`,
      onClick: (ev) => {
        ev.preventDefault();
        value = t;
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      },
    }, typeIcon(t), t);
    seg.append(b);
  }
  seg.value = () => value;
  return seg;
}

export function addNodeDialog(ownerId) {
  if (state.standalone || !state.model) return;
  const ownerLabel = ownerId ? state.model.byId.get(ownerId)?.label : state.model?.name;
  const label = h('input', { class: 'f-input', placeholder: 'e.g. Verify bank statements' });
  const seg = typeSegment('process');
  const desc = h('textarea', { class: 'f-textarea', placeholder: 'What happens here? (optional)' });
  const body = h('div', {},
    h('div', { class: 'f-field' }, h('label', {}, 'Label'), label),
    h('div', { class: 'f-field' }, h('label', {}, 'Type'), seg),
    h('div', { class: 'f-field' }, h('label', {}, 'Description'), desc),
    h('p', { class: 'hint' }, `Will be added ${ownerId ? `inside “${ownerLabel}”` : `at the top level of “${ownerLabel}”`}.`));
  modal('Add node', body, [
    { label: 'Cancel' },
    {
      label: 'Add node', primary: true,
      onClick: () => {
        const text = label.value.trim();
        if (!text) { label.focus(); return false; }
        const id = edit.uniqueId(state.model, edit.slugify(text));
        ctrl.commit(() => edit.addNode(ownerId, { id, type: seg.value(), label: text, description: desc.value }), { select: id })
          .then(async (ok) => {
            if (!ok) return;
            if (ownerId && ownerId !== state.scopeId) {
              // added inside a container we're not looking at — go show it
              await ctrl.gotoScope(ownerId, { focusId: id });
            } else {
              canvas.centerOn(id);
            }
            showDetail(id);
            toast(`Added “${text}”`);
          });
      },
    },
  ]);
}

function newMapDialog() {
  const name = h('input', { class: 'f-input', placeholder: 'e.g. Acme Dental — Operations' });
  modal('New map', h('div', { class: 'f-field' }, h('label', {}, 'Map name'), name,
    h('p', { class: 'hint' }, 'Creates a new YAML file in the maps/ folder.')), [
    { label: 'Cancel' },
    {
      label: 'Create', primary: true,
      onClick: () => {
        const v = name.value.trim();
        if (!v) { name.focus(); return false; }
        import('./api.js').then(async ({ api }) => {
          try {
            const { id } = await api.createMap(v);
            await ctrl.loadMapList();
            await ctrl.openMap(id);
            toast(`Created maps/${id}.yaml`);
          } catch (e) { toast(e.message, true); }
        });
      },
    },
  ]);
}

export function helpDialog() {
  const rows = [
    ['⌘K / Ctrl+K', 'Search all nodes'],
    ['double-click / ⏎', 'Zoom into a container node'],
    ['Esc / ⌫', 'Zoom back out (Esc also closes panels)'],
    ['← ↑ ↓ →', 'Move selection between nodes'],
    ['N', 'Add a node'],
    ['P', 'Presentation mode'],
    ['+ / − / 0', 'Zoom in / out / fit'],
    ['⌘Z / ⌘⇧Z', 'Undo / redo'],
    ['drag', 'Pan the canvas'],
    ['scroll · pinch', 'Pan · zoom'],
  ];
  const grid = h('div', { class: 'kbd-grid' });
  for (const [k, d] of rows) { grid.append(h('kbd', {}, k)); grid.append(h('span', {}, d)); }
  modal('Keyboard & mouse', grid, [{ label: 'Done', primary: true }]);
}

// ── detail panel ─────────────────────────────────────────────────────
let editMode = false;

export function showDetail(nodeId) {
  editMode = false;
  state.detailNodeId = nodeId;
  renderDetail();
}
export function hideDetail() {
  state.detailNodeId = null;
  const panel = document.getElementById('detail');
  if (panel) panel.hidden = true;
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

  const ro = state.standalone;
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('span', { class: `type-pill t-${node.type}` }, typeIcon(node.type, 12), node.type),
      h('h2', {}, node.label),
      h('button', {
        class: 'node-id', title: 'Copy deep link to this node',
        onClick: () => { navigator.clipboard?.writeText(ctrl.nodeUrl(node.id)); toast('Link copied'); },
      }, `#${node.id} ⧉`)),
    h('button', { class: 'panel-close', title: 'Close (Esc)', onClick: () => { hideDetail(); ctrl.clearSelection(); } }, '✕'));

  const body = h('div', { class: 'panel-body' });

  if (!editMode) {
    body.append(h('div', { class: 'panel-section' },
      h('h3', {}, 'What happens here'),
      node.description
        ? linkifiedDesc(node.description)
        : h('div', { class: 'desc placeholder' }, ro ? 'No description.' : 'No description yet — Edit to add one.')));

    body.append(h('div', { class: 'panel-section' },
      h('h3', {}, 'Links'),
      node.links.length
        ? node.links.map((l) => {
            const href = safeUrl(l.url);
            return h(href ? 'a' : 'div', { class: 'link-row', ...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {}) },
              typeIcon('artifact', 13),
              h('span', {}, l.label, h('span', { class: 'url' }, l.url)));
          })
        : h('div', { class: 'no-links' }, ro ? 'No links.' : 'No links yet — SOPs, repos, dashboards…')));

    if (node.children) {
      body.append(h('div', { class: 'panel-section' },
        h('h3', {}, 'Sub-map'),
        h('button', { class: 'contains-btn', onClick: () => ctrl.diveInto(node.id) },
          '⤵ Open sub-map',
          h('span', { class: 'n' }, `${node.stats.childCount} nodes${node.stats.maxDepth > 1 ? `, ${node.stats.maxDepth} levels` : ''}`))));
    }
  } else {
    const label = h('input', { class: 'f-input', value: node.label });
    const seg = typeSegment(node.type);
    const desc = h('textarea', { class: 'f-textarea' });
    desc.value = node.description;
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

    body.append(
      h('div', { class: 'f-field' }, h('label', {}, 'Label'), label),
      h('div', { class: 'f-field' }, h('label', {}, 'Type'), seg),
      h('div', { class: 'f-field' }, h('label', {}, 'Description'), desc),
      h('div', { class: 'f-field' }, h('label', {}, 'Links'), linksBox,
        h('button', { class: 'add-inline', onClick: () => addLinkRow() }, '+ Add link')),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'd-btn', onClick: () => { editMode = false; renderDetail(); } }, 'Cancel'),
        h('button', {
          class: 'd-btn primary',
          onClick: async () => {
            const ok = await ctrl.commit(() => edit.updateNode(node.id, {
              label: label.value.trim() || node.label,
              type: seg.value(),
              description: desc.value,
              links: linkRows.map((r) => r.get()).filter((l) => l.url),
            }));
            if (ok) { editMode = false; renderDetail(); toast('Saved'); }
          },
        }, 'Save')));
  }

  panel.replaceChildren(head, body);

  if (!editMode && !ro) {
    panel.append(h('div', { class: 'panel-actions' },
      h('button', { class: 'pa-btn', onClick: () => { editMode = true; renderDetail(); } }, '✎ Edit'),
      h('button', { class: 'pa-btn', onClick: () => addNodeDialog(node.id) }, '+ Child'),
      h('button', {
        class: 'pa-btn', title: 'Draw an edge from this node — then click a sibling',
        onClick: () => { state.connectFrom = node.id; canvas.paintSelection(); toast('Now click the node this connects to (Esc to cancel)'); },
      }, '→ Connect'),
      h('button', {
        class: 'pa-btn danger',
        onClick: () => {
          const n = node.stats.descendantCount;
          modal(`Delete “${node.label}”?`,
            h('p', { class: 'hint' }, n
              ? `This also deletes the ${n} node${n === 1 ? '' : 's'} nested inside it, plus any edges touching it.`
              : 'Any edges touching it are removed too.'),
            [{ label: 'Cancel' },
              {
                label: 'Delete', danger: true,
                onClick: () => {
                  hideDetail();
                  ctrl.commit(() => edit.deleteNode(node.id), { select: null })
                    .then((ok) => ok && toast(`Deleted “${node.label}”`));
                },
              }]);
        },
      }, '🗑 Delete')));
  }
}

function renderEdgeDetail(panel) {
  const sel = state.selectedEdge;
  const scope = state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children;
  const e = scope?.edges[sel.index];
  if (!e) { panel.hidden = true; return; }
  panel.hidden = false;
  const from = state.model.byId.get(e.from), to = state.model.byId.get(e.to);

  const label = h('input', { class: 'f-input', placeholder: 'e.g. approved / declined', value: e.label ?? '' });
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('span', { class: 'type-pill t-artifact' }, '→ edge'),
      h('h2', {}, `${from?.label ?? e.from} → ${to?.label ?? e.to}`)),
    h('button', { class: 'panel-close', onClick: () => { ctrl.selectEdge(null); panel.hidden = true; } }, '✕'));
  const body = h('div', { class: 'panel-body' },
    h('div', { class: 'f-field' }, h('label', {}, 'Label (what flows / the outcome)'), label));
  panel.replaceChildren(head, body);
  if (!state.standalone) {
    panel.append(h('div', { class: 'panel-actions' },
      h('button', {
        class: 'pa-btn', onClick: () => ctrl.commit(() => edit.updateEdge(state.scopeId, sel.index, { label: label.value })).then((ok) => ok && toast('Saved')),
      }, 'Save label'),
      h('button', {
        class: 'pa-btn danger',
        onClick: () => { panel.hidden = true; ctrl.commit(() => edit.deleteEdge(state.scopeId, sel.index)).then((ok) => { if (ok) { ctrl.selectEdge(null); toast('Edge deleted'); } }); },
      }, '🗑 Delete edge')));
  }
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
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('h2', {}, 'Template library'),
      h('span', { class: 'node-id' }, 'reusable process blocks — insert, then customize')),
    h('button', { class: 'panel-close', onClick: () => toggleTemplates(false) }, '✕'));
  const list = h('div', { class: 'tpl-list' });
  if (!state.templates.length) {
    list.append(h('p', { class: 'hint', style: 'padding:8px 6px' },
      'No templates found. Add YAML files to the templates/ folder — same format as maps.'));
  }
  for (const t of state.templates) {
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
                toast(`Inserted “${t.name}” — ${inserted.length} nodes added`);
              }
            });
        },
      }, `Insert into ${state.scopeId ? `“${state.model.byId.get(state.scopeId)?.label}”` : 'this level'}`)));
  }
  panel.replaceChildren(head, list);
}

// ── search palette ───────────────────────────────────────────────────
export function openSearch() {
  if (!state.model) return;
  const overlay = document.getElementById('search-overlay');
  overlay.hidden = false;

  const input = h('input', { placeholder: 'Search nodes by name, id, or description…', 'aria-label': 'Search nodes' });
  const results = h('div', { class: 'palette-results' });
  const pal = h('div', { class: 'palette' }, input, results);
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
  if (!state.mapId && state.maps.length === 0) {
    box.hidden = false;
    box.replaceChildren(h('div', { class: 'map-card' },
      h('h2', {}, 'No maps yet'),
      h('p', {}, 'Create your first operations map, or drop a YAML file into the maps/ folder.'),
      state.standalone ? null : h('div', { class: 'empty-actions' },
        h('button', { class: 'd-btn primary', onClick: () => newMapDialog() }, '+ New map'))));
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
      h('p', {}, 'Add your first node, or start from a template block.'),
      state.standalone ? null : h('div', { class: 'empty-actions' },
        h('button', { class: 'd-btn primary', onClick: () => addNodeDialog(state.scopeId) }, '+ Add a node'),
        h('button', { class: 'd-btn', onClick: () => toggleTemplates(true) }, 'Browse templates'))));
    return;
  }
  box.hidden = true;
}

// ── reactive wiring ──────────────────────────────────────────────────
export function initUI() {
  bus.on('view-changed', () => {
    renderBreadcrumbs();
    renderSwitcher();
    renderCanvasMessage();
    if (state.selectedId) showDetail(state.selectedId);
    else if (state.selectedEdge == null) hideDetail();
    const mm = document.getElementById('minimap');
    const curScope = state.model ? (state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children) : null;
    if (mm) mm.hidden = !curScope || curScope.nodes.length === 0;
  });
  bus.on('selection-changed', () => {
    if (state.selectedId) showDetail(state.selectedId);
    else if (state.selectedEdge != null) renderDetail();
    else hideDetail();
  });
  bus.on('maps-listed', () => { renderSwitcher(); });
  bus.on('templates-loaded', () => {
    if (!document.getElementById('templates-panel').hidden) renderTemplates();
  });
  bus.on('map-opened', () => { renderBreadcrumbs(); renderSwitcher(); renderCanvasMessage(); });

  document.getElementById('map-switcher').addEventListener('click', (ev) => openMapMenu(ev.currentTarget));

  if (state.standalone) {
    for (const id of ['btn-add-node', 'btn-templates', 'btn-export']) {
      document.getElementById(id)?.remove();
    }
  }
}
