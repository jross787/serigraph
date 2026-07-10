// Presentation mode: walk the current scope's flow node by node with a
// spotlight and a narration card — built for talking a client through it.
import { state, bus } from './state.js';
import * as canvas from './canvas.js';

let steps = [];
let index = 0;
let keyHandler = null;

function h(tag, cls, ...children) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

// topological order of the current scope (Kahn), stragglers appended
function stepOrder() {
  const layout = canvas.getLayout();
  if (!layout) return [];
  const nodes = layout.nodes.map((n) => n.node);
  const edges = layout.edges.map((e) => e.edge);
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (adj.has(e.from) && indeg.has(e.to)) {
      adj.get(e.from).push(e.to);
      indeg.set(e.to, indeg.get(e.to) + 1);
    }
  }
  const layoutPos = new Map(layout.nodes.map((n) => [n.id, n.x * 10000 + n.y]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).sort((a, b) => layoutPos.get(a.id) - layoutPos.get(b.id)).map((n) => n.id);
  const out = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) <= 0 && !seen.has(next)) queue.push(next);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) out.push(n.id);
  return out;
}

function renderHud() {
  const hud = document.getElementById('present-hud');
  const id = steps[index];
  const node = state.model.byId.get(id);
  if (!node) return;

  const card = h('div', 'present-card',
    h('div', `type-pill t-${node.type}`, node.type),
    h('h2', '', node.label),
    node.description ? h('div', 'desc', node.description) : null,
    node.children ? h('p', 'hint', `Contains a sub-map of ${node.stats.childCount} nodes — exit presenting and double-click to explore.`) : null);

  const prev = h('button', '', '←');
  prev.title = 'Previous (←)';
  prev.addEventListener('click', () => go(index - 1));
  const next = h('button', '', '→');
  next.title = 'Next (→ or space)';
  next.addEventListener('click', () => go(index + 1));
  const exitB = h('button', 'present-exit', 'Exit');
  exitB.addEventListener('click', exitPresent);
  const nav = h('div', 'present-nav', prev, h('span', '', `${index + 1} / ${steps.length}`), next, exitB);

  hud.replaceChildren(card, nav);
  hud.hidden = false;
}

function go(i) {
  if (i < 0 || i >= steps.length) return;
  index = i;
  const id = steps[index];
  canvas.dimExcept(id);
  canvas.centerOn(id);
  renderHud();
}

export function enterPresent() {
  if (!state.model) return;
  steps = stepOrder();
  if (!steps.length) { bus.emit('toast', 'Nothing to present in this level'); return; }
  state.presenting = true;
  document.body.classList.add('presenting');
  keyHandler = (ev) => {
    if (ev.key === 'Escape' || ev.key === 'p' || ev.key === 'P') { ev.preventDefault(); ev.stopPropagation(); exitPresent(); }
    else if (ev.key === 'ArrowRight' || ev.key === ' ' || ev.key === 'PageDown') { ev.preventDefault(); ev.stopPropagation(); go(index + 1); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); ev.stopPropagation(); go(index - 1); }
  };
  document.addEventListener('keydown', keyHandler, true);
  go(0);
}

export function exitPresent() {
  state.presenting = false;
  document.body.classList.remove('presenting');
  document.getElementById('present-hud').hidden = true;
  document.removeEventListener('keydown', keyHandler, true);
  canvas.dimExcept(null);
  canvas.fit();
}

export function togglePresent() {
  if (state.presenting) exitPresent();
  else enterPresent();
}
