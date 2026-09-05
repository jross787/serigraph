// Deliberately one public source. No caller-supplied URL, credentials, or writes.
export const GITHUB_SOURCE = Object.freeze({ repo: 'jross787/serigraph', branch: 'main' });
export const GITHUB_REFRESH_MS = 10 * 60 * 1000;
const ROOT = `https://api.github.com/repos/${GITHUB_SOURCE.repo}`;
const WEB = `https://github.com/${GITHUB_SOURCE.repo}`;
const SHA = /^[a-f0-9]{40,64}$/;
const text = value => typeof value === 'string' ? value.slice(0, 240) : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
function workItem(item, kind) {
  return { number: Number.isSafeInteger(item.number) ? item.number : null, title: text(item.title),
    state: text(item.state), updatedAt: date(item.updated_at),
    url: Number.isSafeInteger(item.number) ? `${WEB}/${kind === 'pulls' ? 'pull' : 'issues'}/${item.number}` : null,
    ...(kind === 'pulls' ? { sha: SHA.test(item.head?.sha ?? '') ? item.head.sha : null, branch: text(item.head?.ref) } : {}) };
}

export function createGitHubReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const responses = new Map(), snapshots = new Map(), pending = new Map();
  let requests = [], pausedUntil = 0, failures = 0;
  function pause(message, until) {
    pausedUntil = Math.max(pausedUntil, until);
    return Object.assign(new Error(message), { status: 503, retryAt: pausedUntil });
  }
  function retain(map, key, value, limit) {
    map.delete(key); map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  }
  async function read(suffix, project) {
    if (now() < pausedUntil) throw pause('GitHub refresh paused by backoff or request limits.', pausedUntil);
    requests = requests.filter(at => at > now() - 3600000);
    if (requests.length >= 40) throw pause('Public pilot request budget reached (40 per hour).', requests[0] + 3600001);
    requests.push(now());
    const previous = responses.get(suffix);
    try {
      const res = await fetchImpl(ROOT + suffix, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Serigraph-public-pilot',
          ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}) },
      });
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        pausedUntil = Math.max(pausedUntil, Number.isFinite(reset) ? reset + 1000 : 0, now() + 60000);
      }
      if (res.status === 304 && previous) { await res.body?.cancel(); return previous.data; }
      if (!res.ok) {
        const retry = res.headers.get('retry-after');
        const retryAt = retry == null ? 0 : /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
        await res.body?.cancel();
        throw pause(`GitHub returned ${res.status}; refresh paused.`, Math.max(Number.isFinite(retryAt) ? retryAt : 0, now() + 60000 * 2 ** Math.min(failures++, 5)));
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) throw new Error('Response limit.');
        chunks.push(chunk);
      }
      // Cache only the allowlisted metadata, never full issue/PR bodies.
      const data = project(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      retain(responses, suffix, { etag: res.headers.get('etag'), data }, 24);
      failures = 0;
      return data;
    } catch (error) {
      if (error.retryAt) throw error;
      throw pause('GitHub metadata unavailable; refresh paused.', now() + 60000 * 2 ** Math.min(failures++, 5));
    }
  }

  async function cached(key, load) {
    let value = snapshots.get(key);
    if (!value || now() - Date.parse(value.fetchedAt) >= 60000) {
      if (!pending.has(key)) {
        const request = load().then(result => { retain(snapshots, key, result, 8); return result; }).finally(() => pending.delete(key));
        pending.set(key, request);
      }
      value = await pending.get(key);
    }
    return { ...value, refreshAfter: Math.max(Date.parse(value.fetchedAt) + GITHUB_REFRESH_MS, pausedUntil),
      pausedUntil: pausedUntil > now() ? pausedUntil : null };
  }

  async function observation() {
    const repo = await read('', data => ({ private: data.private, full_name: text(data.full_name) }));
    if (repo.private !== false || repo.full_name?.toLowerCase() !== GITHUB_SOURCE.repo) throw new Error('The approved public repository is unavailable.');
    const branch = await read('/branches/main', data => ({ sha: data.commit?.sha, commitAt: date(data.commit?.commit?.committer?.date) }));
    const sha = branch.sha;
    if (!SHA.test(sha ?? '')) throw new Error('GitHub did not provide a valid branch commit.');
    const headObservedAt = new Date(now()).toISOString();
    const runs = await read('/actions/runs?branch=main&per_page=10', response => {
      if (!Array.isArray(response.workflow_runs)) throw new Error('Invalid workflow observations.');
      return response.workflow_runs.slice(0, 10).map(run => ({
      id: Number.isSafeInteger(run.id) ? run.id : null,
      name: text(run.name), workflowId: run.workflow_id, event: text(run.event),
      sha: SHA.test(run.head_sha ?? '') ? run.head_sha : null,
      status: text(run.status), conclusion: text(run.conclusion) || null,
      updatedAt: date(run.updated_at), startedAt: date(run.run_started_at),
      url: Number.isSafeInteger(run.id) ? `${WEB}/actions/runs/${run.id}` : null,
      }));
    });
    const [pulls, issues] = await Promise.all(['pulls', 'issues'].map(async kind => {
      try {
        const items = await read(`/${kind}?state=open&sort=updated&direction=desc&per_page=10`, page => {
          if (!Array.isArray(page)) throw new Error('Invalid work list.');
          return page.slice(0, 10).filter(item => kind !== 'issues' || !item.pull_request).map(item => workItem(item, kind));
        });
        return { items,
          fetchedAt: new Date(now()).toISOString(), error: null };
      } catch { return { items: null, fetchedAt: null, error: `${kind === 'pulls' ? 'Pull requests' : 'Issues'} unavailable; not an empty result.` }; }
    }));
    return { ...GITHUB_SOURCE, url: WEB, sha, headObservedAt, pulls, issues,
      commitAt: branch.commitAt, fetchedAt: new Date(now()).toISOString(),
      runs, coverage: 'Latest 10 branch runs only; not all workflows or required checks. This is not production health.' };
  }

  async function pullChecks(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('Invalid pull request number.');
    const pull = await read(`/pulls/${number}`, data => workItem(data, 'pulls'));
    if (pull.number !== number || !pull.sha) throw new Error('Pull request head is unavailable.');
    const readChecks = async (path, key, convert) => {
      try {
        const items = await read(path, data => {
          if (!Array.isArray(data[key]) || (key === 'statuses' && data.sha !== pull.sha)) throw new Error('Invalid checks response.');
          return data[key].slice(0, 10).map(convert);
        });
        return { items, fetchedAt: new Date(now()).toISOString(), error: null };
      } catch { return { items: null, fetchedAt: null, error: 'Evidence unavailable for this head; not a pass.' }; }
    };
    const [checks, statuses] = await Promise.all([
      readChecks(`/commits/${pull.sha}/check-runs?per_page=10`, 'check_runs', run => {
        if (run.head_sha !== pull.sha) throw new Error('Check belongs to another commit.');
        return { name: text(run.name), status: text(run.status), conclusion: text(run.conclusion) || null,
          updatedAt: date(run.completed_at ?? run.started_at) };
      }),
      readChecks(`/commits/${pull.sha}/status?per_page=10`, 'statuses', status => ({
        name: text(status.context), status: text(status.state), updatedAt: date(status.updated_at),
      })),
    ]);
    return { ...GITHUB_SOURCE, pull, checks, statuses, fetchedAt: new Date(now()).toISOString(),
      coverage: 'Up to 10 check runs and 10 status contexts for this captured PR head. Required checks and merge-ref checks are not established; not a merge-readiness verdict.' };
  }
  return {
    observation: () => cached(`${GITHUB_SOURCE.repo}:${GITHUB_SOURCE.branch}`, observation),
    pullChecks: number => cached(`pull:${number}`, () => pullChecks(number)),
  };
}
