// Agent Trail — a live map of coding agents working in parallel.
// One card per agent session, laid left→right in spawn order, dashed edges
// chaining them, an activity feed overlay, and a launch dialog. All chrome
// rides on the shared design tokens.
import { state, bus } from './state.js';
import { api } from './api.js';

const CARD_W = 260;
const CARD_H = 150;
const COL_GAP = 96;
const ROW_GAP = 56;

const view = {
  agents: [],
  selectedId: null,
  cam: { x: 0, y: 0, k: 1 },
  feedOpen: false,
  els: {},
};

const h = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

const STATUS_LABEL = {
  starting: 'Starting', working: 'Working', editing: 'Editing',
  done: 'Done', error: 'Error', stopped: 'Stopped',
};
const HARNESS_GLYPH = { claude: '✳', codex: '◈', omp: '▲' };

function statusLabel(a) {
  if (a.status === 'working' || a.status === 'editing') {
    return `${STATUS_LABEL[a.status]} · ${ago(a.lastEventAt)}`;
  }
  return STATUS_LABEL[a.status] ?? a.status;
}

// ── layout: spawn order, 3 per row, chained left→right ──────────────
function layoutAgents(agents) {
  const positions = new Map();
  const perRow = Math.max(1, Math.floor(1400 / (CARD_W + COL_GAP)));
  agents.forEach((a, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    positions.set(a.id, { x: col * (CARD_W + COL_GAP), y: row * (CARD_H + ROW_GAP) });
  });
  return positions;
}

// ── card ────────────────────────────────────────────────────────────
function agentCard(a) {
  const selected = a.id === view.selectedId;
  const progress = a.tasksTotal > 0 ? Math.min(1, a.tasksDone / a.tasksTotal) : (a.status === 'done' ? 1 : 0.06);
  const live = a.status === 'working' || a.status === 'editing' || a.status === 'starting';

  const card = h('div', {
    class: `agent-card${selected ? ' selected' : ''} s-${a.status}`,
    'data-agent': a.id,
    onClick: () => { view.selectedId = a.id === view.selectedId ? null : a.id; view.feedOpen = view.selectedId != null; render(); },
  },
    h('div', { class: 'agent-card-top' },
      h('span', { class: `agent-harness t-${a.harness}` }, HARNESS_GLYPH[a.harness] ?? '•', ' ', a.harness),
      h('span', { class: `agent-status st-${a.status}` }, live ? h('i', { class: 'agent-live-dot' }) : null, statusLabel(a))),
    h('div', { class: 'agent-card-title', title: a.title }, a.title),
    h('div', { class: 'agent-card-meta' },
      `${a.steps.length} step${a.steps.length === 1 ? '' : 's'}`,
      h('span', { class: 'agent-meta-sep' }, '·'),
      a.lastEditPath ? shortPath(a.lastEditPath) : a.repoPath.split('/').pop()),
    h('div', { class: 'agent-progress' }, h('i', { style: `width:${Math.round(progress * 100)}%` })),
    h('div', { class: 'agent-card-foot' },
      h('span', { class: 'agent-repo' }, a.repoPath.split('/').slice(-1)[0] ?? a.repoPath),
      a.lastEditPath ? h('span', { class: 'agent-badge badge-edit' }, 'EDITED FILE') : null,
      a.status === 'done' ? h('span', { class: 'agent-badge badge-done' }, 'DONE') : null,
      a.status === 'error' ? h('span', { class: 'agent-badge badge-error' }, 'EXIT ' + a.exitCode) : null,
      live ? h('button', {
        class: 'agent-stop', title: 'Stop this agent',
        onClick: (ev) => { ev.stopPropagation(); api.stopAgent(a.id).then(() => refresh()); },
      }, 'Stop') : null));
  return card;
}

function shortPath(p) {
  const parts = String(p).split('/');
  return parts.slice(-2).join('/');
}

// ── edges between consecutive agents (spawn chain) ──────────────────
function drawEdges(svg, positions) {
  const ordered = view.agents;
  for (let i = 1; i < ordered.length; i++) {
    const from = positions.get(ordered[i - 1].id);
    const to = positions.get(ordered[i].id);
    if (!from || !to) continue;
    const x1 = from.x + CARD_W, y1 = from.y + CARD_H / 2;
    const x2 = to.x, y2 = to.y + CARD_H / 2;
    const sameRow = Math.abs(y1 - y2) < 4;
    const midX = (x1 + x2) / 2;
    const d = sameRow
      ? `M${x1},${y1} L${x2},${y2}`
      : `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'agent-edge');
    g.innerHTML = `<path d="${d}" class="agent-edge-line"/><circle cx="${x2}" cy="${y2}" r="3" class="agent-edge-dot"/>`;
    svg.append(g);
  }
}

// ── render ──────────────────────────────────────────────────────────
export function renderAgents(stage) {
  view.els.stage = stage;
  stage.replaceChildren(
    h('div', { class: 'agent-toolbar' },
      h('button', { class: 'd-btn primary', onClick: launchDialog }, '+ Launch agent'),
      h('button', { class: 'd-btn', onClick: refresh }, 'Refresh'),
      h('span', { class: 'agent-toolbar-status' }, statusSummary()),
      h('span', { class: 'agent-watch' }, h('i', { class: 'agent-live-dot' }), 'watching')),
    h('div', { class: 'agent-canvas-wrap' },
      h('div', { class: 'agent-canvas', id: 'agent-canvas' },
        h('div', { class: 'agent-world', id: 'agent-world' })),
      h('aside', { class: 'agent-feed', id: 'agent-feed', hidden: !view.feedOpen })),
  );
  wireCanvas();
  render();
}

function statusSummary() {
  const live = view.agents.filter((a) => a.status === 'working' || a.status === 'editing' || a.status === 'starting').length;
  if (live) return `${live} working`;
  if (!view.agents.length) return 'no agents yet';
  const done = view.agents.filter((a) => a.status === 'done').length;
  const failed = view.agents.filter((a) => a.status === 'error' || a.status === 'stopped').length;
  const bits = [];
  if (done) bits.push(`${done} done`);
  if (failed) bits.push(`${failed} failed`);
  return bits.join(' · ') || `${view.agents.length} idle`;
}

function render() {
  const world = view.els.stage?.querySelector('#agent-world');
  if (!world) return;
  const positions = layoutAgents(view.agents);
  world.replaceChildren();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('agent-edges');
  const maxX = Math.max(1200, ...[...positions.values()].map((p) => p.x + CARD_W + 200));
  const maxY = Math.max(600, ...[...positions.values()].map((p) => p.y + CARD_H + 200));
  svg.setAttribute('width', maxX); svg.setAttribute('height', maxY);
  drawEdges(svg, positions);
  world.append(svg);
  for (const a of view.agents) {
    const p = positions.get(a.id);
    const el = agentCard(a);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    world.append(el);
  }
  applyCam();
  const status = view.els.stage.querySelector('.agent-toolbar-status');
  if (status) status.textContent = statusSummary();
  renderFeed();
}

function applyCam() {
  const world = view.els.stage?.querySelector('#agent-world');
  if (!world) return;
  world.style.transform = `translate(${view.cam.x}px,${view.cam.y}px) scale(${view.cam.k})`;
}

function wireCanvas() {
  const wrap = view.els.stage?.querySelector('.agent-canvas-wrap');
  if (!wrap) return;
  let drag = null;
  wrap.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, cam: { ...view.cam } };
  });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    view.cam.x = drag.cam.x + (ev.clientX - drag.x);
    view.cam.y = drag.cam.y + (ev.clientY - drag.y);
    applyCam();
  });
  window.addEventListener('pointerup', () => { drag = null; });
  wrap.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0012);
    view.cam.k = Math.min(1.6, Math.max(0.3, view.cam.k * factor));
    applyCam();
  }, { passive: false });
}

// ── feed overlay ────────────────────────────────────────────────────
function renderFeed() {
  const feed = view.els.stage?.querySelector('#agent-feed');
  if (!feed) return;
  feed.hidden = !view.feedOpen;
  if (!view.feedOpen) return;
  const selected = view.agents.find((a) => a.id === view.selectedId);
  const source = selected ? [selected] : view.agents;
  const steps = [];
  for (const a of source) {
    for (const s of a.steps.slice(-14)) steps.push({ agent: a, step: s });
  }
  steps.sort((x, y) => y.step.at - x.step.at);
  feed.replaceChildren(
    h('div', { class: 'agent-feed-head' },
      h('strong', {}, selected ? selected.title : 'All agents'),
      h('span', {}, selected ? `${selected.harness} · ${statusLabel(selected)}` : 'recent activity'),
      h('button', { class: 'agent-feed-close', onClick: () => { view.feedOpen = false; renderFeed(); } }, 'Close')),
    h('div', { class: 'agent-feed-list' },
      ...steps.slice(0, 30).map(({ agent, step }) => h('div', { class: `agent-feed-row k-${step.kind}` },
        h('span', { class: 'agent-feed-agent' }, HARNESS_GLYPH[agent.harness] ?? '•', ' ', agent.harness),
        h('div', { class: 'agent-feed-body' },
          h('strong', {}, step.label),
          step.detail ? h('code', {}, step.detail) : null),
        h('span', { class: 'agent-feed-age' }, ago(step.at))))),
  );
}

// ── launch dialog ───────────────────────────────────────────────────
function launchDialog() {
  if (state.standalone) return;
  const root = document.getElementById('dialog-root');
  const backdrop = h('div', { class: 'dialog-backdrop' });
  const close = () => backdrop.remove();
  backdrop.addEventListener('pointerdown', (ev) => { if (ev.target === backdrop) close(); });

  const harness = h('select', { class: 'f-select' },
    h('option', { value: 'claude' }, 'claude — Claude Code CLI'),
    h('option', { value: 'codex' }, 'codex — Codex CLI'),
    h('option', { value: 'omp' }, 'omp — oh-my-pi CLI'));
  const prompt = h('textarea', {
    class: 'f-textarea', placeholder: 'What should this agent do? e.g. “Write unit tests for server/export.js”',
  });
  const repo = h('input', { class: 'f-input', value: '', placeholder: '/path/to/repo the agent works in' });
  const allowEdits = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'dialog-error', hidden: '' });

  const launch = async () => {
    err.hidden = true;
    try {
      await api.spawnAgent({
        harness: harness.value,
        prompt: prompt.value,
        repoPath: repo.value.trim() || undefined,
        allowEdits: allowEdits.checked,
      });
      close();
      await refresh();
      bus.emit('toast', 'Agent launched — watch it work on the trail');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  };

  const dialog = h('div', { class: 'dialog agent-dialog' },
    h('h2', {}, 'Launch a coding agent'),
    h('p', { class: 'hint' }, 'The agent runs in its own process. Watch it appear on the trail and stream its steps live.'),
    h('div', { class: 'f-field' }, h('label', {}, 'Harness'), harness),
    h('div', { class: 'f-field' }, h('label', {}, 'Task'), prompt),
    h('div', { class: 'f-field' }, h('label', {}, 'Repository'), repo),
    h('label', { class: 'agent-edits-toggle' }, allowEdits, h('span', {}, 'Allow file edits (otherwise the agent plans read-only)')),
    err,
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'd-btn', onClick: close }, 'Cancel'),
      h('button', { class: 'd-btn primary', onClick: launch }, 'Launch agent')));
  backdrop.append(dialog);
  root.append(backdrop);
  prompt.focus();
}

// ── data ────────────────────────────────────────────────────────────
export async function refresh() {
  if (state.standalone) return;
  try {
    view.agents = await api.listAgents();
    if (view.selectedId && !view.agents.some((a) => a.id === view.selectedId)) view.selectedId = null;
    render();
  } catch { /* server briefly away */ }
}

export function initAgents() {
  if (state.standalone) return;
  // No default repo path: the launch dialog starts empty and the server
  // uses its own working directory when the field is left blank. (A '/'
  // prefill was a guaranteed 400 — the server rejects paths under two
  // characters.)
  refresh();
  bus.on('view-changed', () => {
    if (document.body.dataset.workspaceView === 'agents') refresh();
  });
}
