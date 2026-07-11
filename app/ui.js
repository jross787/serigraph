// All chrome around the canvas: detail panel, dialogs, template browser,
// search palette, breadcrumbs, map switcher, toasts, error/empty states.
import { parseMap, NODE_TYPES, ancestryOf } from '../shared/model.js';
import { nodeCost, rollupCost, formatMoney, formatPayback, formatPercent, compactMoney } from '../shared/cost.js';
import { api } from './api.js';
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

export function addNodeDialog(ownerId, presetType = 'process') {
  if (state.standalone || !state.model) return;
  const ownerLabel = ownerId ? state.model.byId.get(ownerId)?.label : state.model?.name;
  const label = h('input', { class: 'f-input', placeholder: 'e.g. Verify bank statements' });
  const seg = typeSegment(presetType);
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
    ['drag a node', 'Move it — pins its position (click the pin badge to release)'],
    ['drag a node onto a container', 'Move it into that sub-map (drop bar at top moves it out)'],
    ['drag from a node\'s ○ port', 'Draw an edge to another node'],
    ['drag from the palette', 'Drop a new node of that type where you release'],
    ['double-click empty canvas', 'New node at that spot'],
    ['drag the background', 'Pan the canvas'],
    ['scroll · pinch', 'Pan · zoom'],
  ];
  const grid = h('div', { class: 'kbd-grid' });
  for (const [k, d] of rows) { grid.append(h('kbd', {}, k)); grid.append(h('span', {}, d)); }
  modal('Keyboard & mouse', grid, [{ label: 'Done', primary: true }]);
}

// ── detail panel ─────────────────────────────────────────────────────
let editMode = false;

export function showDetail(nodeId, { edit = false } = {}) {
  editMode = edit;
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
    // provenance flag — inferred from a transcript, awaiting human confirmation
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

    body.append(renderCostSection(node, ro));

    if (node.position) {
      body.append(h('div', { class: 'panel-section' },
        h('h3', {}, 'Layout'),
        h('div', { class: 'pin-row' },
          h('span', { class: 'pin-info' }, `Pinned at ${node.position.x}, ${node.position.y}`),
          ro ? null : h('button', {
            class: 'pa-btn', title: 'Remove the pinned position — the node returns to automatic layout',
            onClick: () => ctrl.commit(() => edit.clearNodePosition(node.id))
              .then((ok) => ok && toast('Released — back to auto-layout')),
          }, 'Release to auto-layout'))));
    }

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

  if (editMode) {
    const first = panel.querySelector('input.f-input');
    first?.focus();
    first?.select();
  }

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
        class: 'pa-btn', onClick: () => ctrl.commit(() => edit.updateEdge(state.scopeId, sel.index, { label: label.value })).then((ok) => ok && toast('Saved')),
      }, 'Save label'),
      h('button', {
        class: 'pa-btn danger',
        onClick: () => { panel.hidden = true; ctrl.commit(() => edit.deleteEdge(state.scopeId, sel.index)).then((ok) => { if (ok) { ctrl.selectEdge(null); toast('Edge deleted'); } }); },
      }, '🗑 Delete edge')));
  }
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

  const status = await api.importStatus().catch(() => ({ available: false, hint: 'Could not reach the Opsmap server.' }));

  let transcript = '';

  function renderPaste() {
    const ta = h('textarea', {
      class: 'f-textarea import-ta',
      placeholder: 'Paste the meeting / discovery-call transcript here…',
      ...(status.available ? {} : { disabled: 'disabled' }),
    });
    ta.value = transcript;
    const counter = h('span', { class: 'import-count' }, '');
    ta.addEventListener('input', () => { counter.textContent = ta.value.trim() ? `${ta.value.trim().length.toLocaleString()} chars` : ''; });

    const providerLine = status.available
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
            api.importTranscript(transcript)
              .then((result) => { if (!closed) renderReview(result); })
              .catch((e) => {
                if (closed) return;
                renderPaste();
                toast(e.message, true);
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
              const { id } = await api.createMap(name);
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
const TYPE_LABELS = { process: 'Process', decision: 'Decision', system: 'System', role: 'Role', artifact: 'Artifact' };

// create a node pinned at a world point in the current scope (palette drop /
// canvas double-click), then open it for naming
export function createNodeAt(type, world) {
  const label = `New ${type}`;
  const id = edit.uniqueId(state.model, edit.slugify(label));
  ctrl.commit(
    () => edit.addNode(state.scopeId, {
      id, type, label,
      position: { x: Math.round(world.x), y: Math.round(world.y) },
    }),
    { select: id },
  ).then((ok) => {
    if (!ok) return;
    showDetail(id, { edit: true });
    toast(`Added ${type} — name it in the panel`);
  });
}

function createNodeInside(type, containerId) {
  const label = `New ${type}`;
  const id = edit.uniqueId(state.model, edit.slugify(label));
  const contLabel = state.model.byId.get(containerId)?.label ?? containerId;
  ctrl.commit(() => edit.addNode(containerId, { id, type, label }))
    .then((ok) => ok && toast(`Added ${type} inside “${contLabel}” — double-click it to open`));
}

function initPalette() {
  const pal = document.getElementById('palette');
  if (!pal || state.standalone) return;
  pal.hidden = false;
  pal.setAttribute('aria-label', 'Node palette — drag a type onto the canvas');
  for (const t of NODE_TYPES) {
    const chip = h('button', {
      class: `pal-chip t-${t}`,
      title: `Drag onto the canvas to add a ${t} (click for the dialog)`,
    }, typeIcon(t, 15), h('span', { class: 'pal-chip-label' }, TYPE_LABELS[t]));
    chip.addEventListener('pointerdown', (ev) => startPaletteDrag(ev, t, chip));
    pal.append(chip);
  }
}

function startPaletteDrag(ev, type, chip) {
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
      ghost = h('div', { class: 'pal-ghost' }, typeIcon(type, 14), TYPE_LABELS[type]);
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
    if (!moved) { addNodeDialog(state.scopeId, type); return; } // plain click
    const info = canvas.dropInfo(e.clientX, e.clientY);
    if (info.kind === 'canvas') createNodeAt(type, info.world);
    else if (info.kind === 'container') createNodeInside(type, info.id);
    else if (info.kind === 'node') toast('Drop on empty canvas — or on a container to nest inside it');
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
  initPalette();
  bus.on('map-opened', () => { econOverride = null; econExpanded = false; });
  bus.on('view-changed', () => {
    renderBreadcrumbs();
    renderSwitcher();
    renderCanvasMessage();
    renderEconomics();
    if (state.selectedId) showDetail(state.selectedId);
    else if (state.selectedEdge == null) hideDetail();
    const mm = document.getElementById('minimap');
    const curScope = state.model ? (state.scopeId == null ? state.model.root : state.model.byId.get(state.scopeId)?.children) : null;
    if (mm) mm.hidden = !curScope || curScope.nodes.length === 0;
  });
  let panelTimer = null;
  bus.on('selection-changed', () => {
    clearTimeout(panelTimer);
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
  bus.on('maps-listed', () => { renderSwitcher(); });
  bus.on('templates-loaded', () => {
    if (!document.getElementById('templates-panel').hidden) renderTemplates();
  });
  bus.on('map-opened', () => { renderBreadcrumbs(); renderSwitcher(); renderCanvasMessage(); });

  document.getElementById('map-switcher').addEventListener('click', (ev) => openMapMenu(ev.currentTarget));

  if (state.standalone) {
    for (const id of ['btn-add-node', 'btn-templates', 'btn-export', 'btn-import']) {
      document.getElementById(id)?.remove();
    }
  }
}
