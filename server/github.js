// Deliberately one public source. No caller-supplied URL, credentials, or writes.
export const GITHUB_SOURCE = Object.freeze({ repo: 'jross787/serigraph', branch: 'main' });
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
  async function read(suffix) {
    const res = await fetchImpl(ROOT + suffix, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Serigraph-public-pilot' },
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`GitHub returned ${res.status}. Observation unavailable.`); }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw new Error('GitHub response exceeded the metadata limit.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function observation() {
    const repo = await read('');
    if (repo.private !== false || repo.full_name?.toLowerCase() !== GITHUB_SOURCE.repo) throw new Error('The approved public repository is unavailable.');
    const branch = await read('/branches/main');
    const sha = branch.commit?.sha;
    if (!SHA.test(sha ?? '')) throw new Error('GitHub did not provide a valid branch commit.');
    const headObservedAt = new Date(now()).toISOString();
    const response = await read('/actions/runs?branch=main&per_page=10');
    if (!Array.isArray(response.workflow_runs)) throw new Error('GitHub did not provide workflow observations.');
    const runs = response.workflow_runs.slice(0, 10).map(run => ({
      id: Number.isSafeInteger(run.id) ? run.id : null,
      name: text(run.name), workflowId: run.workflow_id, event: text(run.event),
      sha: SHA.test(run.head_sha ?? '') ? run.head_sha : null,
      status: text(run.status), conclusion: text(run.conclusion) || null,
      updatedAt: date(run.updated_at), startedAt: date(run.run_started_at),
      url: Number.isSafeInteger(run.id) ? `${WEB}/actions/runs/${run.id}` : null,
    }));
    const [pulls, issues] = await Promise.all(['pulls', 'issues'].map(async kind => {
      try {
        const page = await read(`/${kind}?state=open&sort=updated&direction=desc&per_page=10`);
        if (!Array.isArray(page)) throw new Error('Invalid work list.');
        return { items: page.slice(0, 10).filter(item => kind !== 'issues' || !item.pull_request).map(item => workItem(item, kind)),
          fetchedAt: new Date(now()).toISOString(), error: null };
      } catch { return { items: null, fetchedAt: null, error: `${kind === 'pulls' ? 'Pull requests' : 'Issues'} unavailable; not an empty result.` }; }
    }));
    return { ...GITHUB_SOURCE, url: WEB, sha, headObservedAt, pulls, issues,
      commitAt: date(branch.commit?.commit?.committer?.date), fetchedAt: new Date(now()).toISOString(),
      runs, coverage: 'Latest 10 branch runs only; not all workflows or required checks. This is not production health.' };
  }

  async function pullChecks(number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('Invalid pull request number.');
    const pull = workItem(await read(`/pulls/${number}`), 'pulls');
    if (pull.number !== number || !pull.sha) throw new Error('Pull request head is unavailable.');
    const readChecks = async (path, key, convert) => {
      try {
        const data = await read(path);
        if (!Array.isArray(data[key])) throw new Error('Invalid checks response.');
        return { items: data[key].slice(0, 10).map(convert), fetchedAt: new Date(now()).toISOString(), error: null };
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
  return { observation, pullChecks };
}
