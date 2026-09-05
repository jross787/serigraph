// Public pilot bindings are browser-local; observations never enter the map.
import { state, bus } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';

let active = null;
let pullRequest = null;
let activeTask = null;
let timer = null;
let generation = 0;
const bindingKey = () => `serigraph:github:${state.libraryId}:${state.mapId}`;
const announce = () => bus.emit('github-changed');
function visible() {
  return !state.standalone && !document.hidden && state.workspaceView === 'map'
    && !!state.mapId && state.github?.mapKey === bindingKey() && state.github.bindings.some(id => state.model?.byId.has(id));
}
function stop() {
  clearTimeout(timer); timer = null;
  generation++; active?.abort(); active = null; activeTask = null;
  pullRequest?.abort(); pullRequest = null;
  if (state.github) { state.github.loading = false; state.github.pullLoading = false; }
}
function schedule() {
  clearTimeout(timer); timer = null;
  if (!visible()) return;
  const github = state.github;
  const due = Math.max(github.retryAt ?? 0, github.result?.refreshAfter ?? 0, Date.parse(github.result?.fetchedAt ?? '') + github.config.refreshMs || 0);
  timer = setTimeout(refreshGitHub, Math.max(1000, due - Date.now()));
}
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
  if (state.standalone || github?.mapKey !== bindingKey() || !github?.bindings.includes(id)) return null;
  const stale = github.result && Date.now() - Date.parse(github.result.fetchedAt) >= github.config.refreshMs;
  const label = github.error || stale ? (github.result ? 'CI stale' : 'CI unavailable') : github.loading && !github.result ? 'CI loading' : ciSummary(github.result);
  return { label, detail: `${label} · ${github.config.repo} · ${github.config.branch} · ${github.result?.sha ?? 'commit unknown'} · fetched ${time(github.result?.fetchedAt)} · bounded sample, not production health` };
}

export function refreshGitHub() {
  if (!visible()) return Promise.resolve();
  if (activeTask) return activeTask;
  if (Date.now() < (state.github.retryAt ?? 0)) { schedule(); announce(); return Promise.resolve(); }
  activeTask = readObservation();
  return activeTask;
}

async function readObservation() {
  const token = ++generation;
  clearTimeout(timer); timer = null;
  pullRequest?.abort(); pullRequest = null; state.github.pullLoading = false;
  active = new AbortController();
  state.github.loading = true;
  announce();
  try {
    const result = await api.githubObservation(active.signal);
    if (token !== generation) return;
    state.github.result = result;
    state.github.error = null;
    state.github.retryAt = result.pausedUntil;
    const detail = state.github.pull;
    if (detail && result.pulls?.items?.find(item => item.number === detail.pull.number)?.sha !== detail.pull.sha) {
      state.github.pull = null;
      state.github.pullError = 'PR list changed or no longer covers that head. Inspect it again for current evidence.';
    }
  } catch (error) {
    if (token !== generation) return;
    state.github.error = error.message;
    state.github.retryAt = Math.max(error.data?.retryAt ?? 0, Date.now() + state.github.config.refreshMs);
  } finally {
    if (token === generation) { state.github.loading = false; active = null; activeTask = null; announce(); schedule(); }
  }
}

function bindNode(id, enabled) {
  pullRequest?.abort(); state.github.pull = null; state.github.pullError = null;
  const bindings = enabled ? [...new Set([...state.github.bindings, id])] : state.github.bindings.filter(nodeId => nodeId !== id);
  try { localStorage.setItem(bindingKey(), JSON.stringify(bindings)); }
  catch { bus.emit('toast', 'Could not save the local GitHub binding.', true); return; }
  state.github.bindings = bindings;
  if (bindings.length) refreshGitHub();
  else { stop(); state.github.result = null; announce(); }
}

async function inspectPull(number) {
  if (!visible() || Date.now() < (state.github.retryAt ?? 0)) return;
  pullRequest?.abort();
  const request = new AbortController(); pullRequest = request;
  const token = generation;
  Object.assign(state.github, { pull: null, pullError: null, pullLoading: true }); announce();
  try {
    const result = await api.githubPullChecks(number, request.signal);
    if (request !== pullRequest || token !== generation) return;
    state.github.pull = result;
    if (result.pausedUntil) { state.github.retryAt = result.pausedUntil; schedule(); }
  } catch (error) {
    if (request !== pullRequest || token !== generation) return;
    state.github.pullError = error.message;
    if (error.data?.retryAt) { state.github.retryAt = error.data.retryAt; schedule(); }
  } finally {
    if (request === pullRequest) { pullRequest = null; state.github.pullLoading = false; announce(); }
  }
}

function workList(kind, section) {
  const title = kind === 'pulls' ? 'Open pull requests' : 'Open issues';
  const list = h('details', { 'data-github-section': kind }, h('summary', {}, `${title} · ${section?.items?.length ?? 'unknown'} shown`));
  list.append(h('p', { class: 'github-meta' }, kind === 'issues'
    ? 'Issues from the first 10 updated issue/PR entries; PRs excluded. This is not a total.'
    : 'First 10 updated open pull requests, not a total. Inspect checks on demand.'));
  if (section?.error) list.append(h('p', { class: 'github-error' }, section.error));
  else if (!section?.items?.length) list.append(h('p', {}, `No ${kind === 'pulls' ? 'pull requests' : 'issues'} in this page.`));
  for (const item of section?.items ?? []) list.append(h('div', { class: 'github-row' },
    item.url ? sourceLink(item.url, `#${item.number} ${item.title}`) : h('span', {}, item.title),
    h('span', {}, `${item.state} · updated ${time(item.updatedAt)}`),
    kind === 'pulls' && item.number ? h('button', { class: 'pa-btn', 'data-github-action': `pr-${item.number}`, onClick: () => inspectPull(item.number) }, 'Inspect checks') : null));
  return list;
}

export function renderGitHubGlance(node) {
  const github = state.github;
  if (state.standalone || !github?.config?.enabled || github.mapKey !== bindingKey()) return null;
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
      h('button', { class: 'pa-btn', 'data-github-action': 'refresh', disabled: github.loading || Date.now() < (github.retryAt ?? 0) ? '' : null, onClick: refreshGitHub }, icon('arrow-clockwise', 14), github.loading ? 'Refreshing…' : 'Refresh'),
      h('button', { class: 'pa-btn', onClick: () => bindNode(node.id, false) }, 'Disconnect')),
    h('p', { class: 'github-state', role: 'status' }, nodeObservation(node.id).label));
  section.append(h('p', { class: 'github-meta' }, Date.now() < (github.retryAt ?? 0)
    ? `Refresh paused until ${time(github.retryAt)}.`
    : visible() ? 'Auto refresh every 10 minutes while this map is visible. Manual reads share a 60-second cache.' : 'Auto refresh paused while this map is not visible.'));
  if (github.error) section.append(h('p', { class: 'github-error' }, `${github.error}${result ? ' Retaining the last observation with its original timestamp.' : ''}`));
  if (!result) return section;
  section.append(h('p', {}, 'Observed head ', sourceLink(`${result.url}/commit/${result.sha}`, result.sha.slice(0, 10))),
    h('p', { class: 'github-meta' }, `Commit time: ${time(result.commitAt)}\nFetched: ${time(result.fetchedAt)}`),
    h('p', { class: 'github-meta' }, result.coverage));
  const workflows = h('details', { 'data-github-section': 'workflows' }, h('summary', {}, `Workflow runs · ${result.runs.length} shown`));
  if (!result.runs.length) workflows.append(h('p', {}, 'No runs returned. CI has not been observed.'));
  for (const run of result.runs) workflows.append(h('div', { class: 'github-row' },
    run.url ? sourceLink(run.url, `${run.name || 'Workflow'} · #${run.id}`) : h('span', {}, run.name),
    h('strong', {}, `${run.sha === result.sha ? 'Observed head' : 'Historical'} · ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`),
    h('span', {}, `${run.event} · ${run.sha?.slice(0, 10) ?? 'Unknown commit'} · updated ${time(run.updatedAt)}`)));
  section.append(workflows, workList('pulls', result.pulls), workList('issues', result.issues));
  if (github.pullLoading) section.append(h('p', { role: 'status' }, 'Reading PR head and checks…'));
  if (github.pullError) section.append(h('p', { class: 'github-error' }, github.pullError));
  if (github.pull) {
    const detail = github.pull;
    section.append(h('h4', {}, `PR #${detail.pull.number} evidence`),
      h('p', {}, sourceLink(detail.pull.url, detail.pull.title)),
      h('p', { class: 'github-meta' }, `${detail.pull.branch} · ${detail.pull.sha}\nFetched ${time(detail.fetchedAt)}`),
      h('p', { class: 'github-meta' }, detail.coverage));
    for (const [name, evidence] of [['Check runs', detail.checks], ['Commit statuses', detail.statuses]]) {
      section.append(h('h4', {}, name));
      if (evidence.error) section.append(h('p', { class: 'github-error' }, evidence.error));
      else if (!evidence.items.length) section.append(h('p', {}, 'No evidence returned for this head.'));
      for (const item of evidence.items ?? []) section.append(h('div', { class: 'github-row' },
        h('strong', {}, item.name), h('span', {}, `${item.status}${item.conclusion ? ` / ${item.conclusion}` : ''} · ${time(item.updatedAt)}`)));
    }
  }
  return section;
}

export async function initGitHub() {
  if (state.standalone) return;
  let config;
  try { config = await api.githubConfig(); } catch { return; }
  if (!config.enabled) return;
  state.github = { config, bindings: [], result: null, error: null, loading: false, retryAt: null };
  const visibilityChanged = () => {
    if (!visible()) { stop(); announce(); return; }
    if (!state.github.result || Date.now() >= Math.max(state.github.result.refreshAfter ?? 0, state.github.retryAt ?? 0)) refreshGitHub();
    else { schedule(); announce(); }
  };
  const mapChanged = () => {
    stop();
    state.github.mapKey = bindingKey();
    state.github.pull = null; state.github.pullError = null; state.github.pullLoading = false;
    let bindings = [];
    try { bindings = JSON.parse(localStorage.getItem(bindingKey()) || '[]'); } catch { /* invalid local preference */ }
    state.github.bindings = Array.isArray(bindings) ? bindings.filter(id => typeof id === 'string' && state.model?.byId.has(id)) : [];
    state.github.result = null; state.github.error = null; state.github.loading = false; state.github.retryAt = null;
    announce();
    if (state.github.bindings.length) refreshGitHub();
  };
  const unsubscribers = [bus.on('map-opened', mapChanged), bus.on('view-changed', visibilityChanged)];
  document.addEventListener('visibilitychange', visibilityChanged);
  mapChanged();
  return () => { stop(); unsubscribers.forEach(unsubscribe => unsubscribe()); document.removeEventListener('visibilitychange', visibilityChanged); };
}
