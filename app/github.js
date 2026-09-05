// Public pilot bindings are browser-local; observations never enter the map.
import { state, bus } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';

let active = null;
let generation = 0;
const bindingKey = () => `serigraph:github:${state.libraryId}:${state.mapId}`;
const announce = () => bus.emit('github-changed');
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'onClick') el.addEventListener('click', value);
    else if (value != null) el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) el.append(child);
  return el;
}
const time = value => value ? new Date(value).toLocaleString() : 'Not provided';
const sourceLink = (url, label) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label);

export function ciSummary(result) {
  if (!result) return 'CI unavailable';
  const current = result.runs.filter(run => run.sha === result.sha);
  if (!current.length) return 'CI not observed';
  // Only the newest run of each workflow in this bounded sample contributes.
  const latest = [...new Map([...current].reverse().map(run => [run.workflowId, run])).values()];
  if (latest.some(run => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run.conclusion))) return 'CI failed';
  if (latest.some(run => ['queued', 'waiting', 'pending', 'requested', 'in_progress'].includes(run.status))) return 'CI pending';
  if (latest.every(run => run.status === 'completed' && run.conclusion === 'success')) return 'CI sample passed';
  if (latest.some(run => run.conclusion === 'cancelled')) return 'CI cancelled';
  if (latest.every(run => ['skipped', 'neutral'].includes(run.conclusion))) return 'CI skipped/neutral';
  return 'CI unknown';
}

export function nodeObservation(id) {
  const github = state.github;
  if (state.standalone || !github?.bindings.includes(id)) return null;
  const label = github.error ? (github.result ? 'CI stale' : 'CI unavailable') : github.loading && !github.result ? 'CI loading' : ciSummary(github.result);
  return { label, detail: `${label} · ${github.config.repo} · ${github.config.branch} · ${github.result?.sha ?? 'commit unknown'} · fetched ${time(github.result?.fetchedAt)} · bounded sample, not production health` };
}

export async function refreshGitHub() {
  if (!state.github?.bindings.length || state.standalone) return;
  const token = ++generation;
  active?.abort();
  active = new AbortController();
  state.github.loading = true;
  announce();
  try {
    const result = await api.githubObservation(active.signal);
    if (token !== generation) return;
    state.github.result = result;
    state.github.error = null;
  } catch (error) {
    if (token !== generation) return;
    state.github.error = error.message;
  } finally {
    if (token === generation) { state.github.loading = false; active = null; announce(); }
  }
}

function bindNode(id, enabled) {
  const bindings = enabled ? [...new Set([...state.github.bindings, id])] : state.github.bindings.filter(nodeId => nodeId !== id);
  try { localStorage.setItem(bindingKey(), JSON.stringify(bindings)); }
  catch { bus.emit('toast', 'Could not save the local GitHub binding.', true); return; }
  state.github.bindings = bindings;
  if (bindings.length) refreshGitHub();
  else { generation++; active?.abort(); active = null; state.github.result = null; state.github.loading = false; announce(); }
}

export function renderGitHubGlance(node) {
  const github = state.github;
  if (state.standalone || !github?.config?.enabled) return null;
  const section = h('section', { id: 'github-glance', class: 'panel-section github-glance', 'aria-label': 'GitHub Glance' },
    h('h3', {}, 'GitHub Glance'));
  if (!github.bindings.includes(node.id)) {
    section.append(h('p', {}, 'Public repository · read-only'), h('button', { class: 'pa-btn', onClick: () => bindNode(node.id, true) },
      icon('plugs-connected', 14), `Connect ${github.config.repo}`));
    return section;
  }
  const result = github.result;
  section.append(h('p', {}, sourceLink(`https://github.com/${github.config.repo}`, github.config.repo), ` · ${github.config.branch}`),
    h('div', { class: 'github-actions' },
      h('button', { class: 'pa-btn', disabled: github.loading ? '' : null, onClick: refreshGitHub }, icon('arrow-clockwise', 14), github.loading ? 'Refreshing…' : 'Refresh'),
      h('button', { class: 'pa-btn', onClick: () => bindNode(node.id, false) }, 'Disconnect')),
    h('p', { class: 'github-state', role: 'status' }, nodeObservation(node.id).label));
  if (github.error) section.append(h('p', { class: 'github-error' }, `${github.error}${result ? ' Retaining the last observation with its original timestamp.' : ''}`));
  if (!result) return section;
  section.append(h('p', {}, 'Observed head ', sourceLink(`${result.url}/commit/${result.sha}`, result.sha.slice(0, 10))),
    h('p', { class: 'github-meta' }, `Commit time: ${time(result.commitAt)}\nFetched: ${time(result.fetchedAt)}`),
    h('p', { class: 'github-meta' }, result.coverage));
  if (!result.runs.length) section.append(h('p', {}, 'No runs returned. CI has not been observed.'));
  for (const run of result.runs) section.append(h('div', { class: 'github-row' },
    run.url ? sourceLink(run.url, `${run.name || 'Workflow'} · #${run.id}`) : h('span', {}, run.name),
    h('strong', {}, `${run.sha === result.sha ? 'Observed head' : 'Historical'} · ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`),
    h('span', {}, `${run.event} · ${run.sha?.slice(0, 10) ?? 'Unknown commit'} · updated ${time(run.updatedAt)}`)));
  return section;
}

export async function initGitHub() {
  if (state.standalone) return;
  let config;
  try { config = await api.githubConfig(); } catch { return; }
  if (!config.enabled) return;
  state.github = { config, bindings: [], result: null, error: null, loading: false };
  const mapChanged = () => {
    generation++; active?.abort(); active = null;
    let bindings = [];
    try { bindings = JSON.parse(localStorage.getItem(bindingKey()) || '[]'); } catch { /* invalid local preference */ }
    state.github.bindings = Array.isArray(bindings) ? bindings.filter(id => typeof id === 'string' && state.model?.byId.has(id)) : [];
    state.github.result = null; state.github.error = null; state.github.loading = false;
    announce();
    if (state.github.bindings.length) refreshGitHub();
  };
  bus.on('map-opened', mapChanged);
  mapChanged();
}
