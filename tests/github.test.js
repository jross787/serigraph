import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReader } from '../server/github.js';
import { ciSummary, initGitHub, refreshGitHub, nodeObservation } from '../app/github.js';
import { state, bus } from '../app/state.js';
import { api } from '../app/api.js';

const sha = 'a'.repeat(40), old = 'b'.repeat(40);
const repo = { private: false, full_name: 'jross787/serigraph' };
const head = { commit: { sha, commit: { committer: { date: '2026-01-01T00:00:00Z' } } } };
function fixture(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  };
}

test('public CI reader constrains destination, strips payloads, and qualifies runs to the observed head', async () => {
  const calls = [];
  const reader = createGitHubReader({ fetchImpl: fixture([repo, head, { workflow_runs: [
    { id: 2, name: '<script>not executable</script>', workflow_id: 1, head_sha: sha, status: 'completed', conclusion: 'failure', html_url: 'https://evil.example', body: 'discard' },
    { id: 1, workflow_id: 1, head_sha: old, status: 'completed', conclusion: 'success' },
  ] }], calls), now: () => 1000 });
  const result = await reader.observation();
  assert.equal(ciSummary(result), 'CI failed');
  assert.equal(result.runs[0].url, 'https://github.com/jross787/serigraph/actions/runs/2');
  assert.equal(result.fetchedAt, '1970-01-01T00:00:01.000Z');
  assert.ok(!JSON.stringify(result).includes('discard'));
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://api.github.com/repos/jross787/serigraph'));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal);
  }
  assert.equal(ciSummary({ ...result, runs: [result.runs[1]] }), 'CI not observed');
  assert.equal(ciSummary({ ...result, runs: [] }), 'CI not observed');
  assert.equal(ciSummary(null), 'CI unavailable');
});

test('CI cannot become success through private, malformed, oversized, or denied reads', async () => {
  for (const responses of [
    [{ ...repo, private: true }], [repo, { commit: { sha: '../../other' } }],
    [repo, head, {}], [new Response('{}', { status: 403 })],
    [new Response('x'.repeat(512 * 1024 + 1))],
  ]) await assert.rejects(createGitHubReader({ fetchImpl: fixture(responses) }).observation());
});

test('work pages exclude PRs from issues and keep partial failures distinct from empty lists', async () => {
  const reader = createGitHubReader({ fetchImpl: fixture([repo, head, { workflow_runs: [] },
    [{ number: 3, title: 'Change', head: { sha, ref: 'topic' }, state: 'open' }],
    [{ number: 3, pull_request: {} }, { number: 4, title: 'Question', state: 'open', body: 'discard' }],
  ]) });
  const result = await reader.observation();
  assert.deepEqual(result.issues.items.map(item => item.number), [4]);
  assert.equal(result.pulls.items[0].sha, sha);
  assert.equal(result.issues.items[0].body, undefined);
  const partial = await createGitHubReader({ fetchImpl: fixture([repo, head, { workflow_runs: [] }, [], new Error('offline')]) }).observation();
  assert.deepEqual(partial.pulls.items, []);
  assert.equal(partial.issues.items, null);
  assert.ok(partial.issues.error);
});

test('PR evidence follows its freshly read head, rejects foreign checks, and never uses the main head', async () => {
  const calls = [];
  const reader = createGitHubReader({ fetchImpl: fixture([
    { number: 7, title: 'Change', state: 'open', head: { sha: old, ref: 'topic' } },
    { check_runs: [{ name: 'wrong head', head_sha: sha, status: 'completed', conclusion: 'success' }] },
    { sha: old, statuses: [] },
  ], calls) });
  const result = await reader.pullChecks(7);
  assert.equal(result.pull.sha, old);
  assert.ok(result.checks.error);
  assert.deepEqual(result.statuses.items, []);
  assert.ok(calls.slice(1).every(call => call.url.includes(`/commits/${old}/`)));
  await assert.rejects(reader.pullChecks('../private'));
  await assert.rejects(reader.pullChecks(0));
  assert.equal(calls.length, 3);
});

test('refresh shares in-flight/cache reads, conditionally revalidates, respects rate limits, and recovers', async () => {
  let clock = 1000000;
  const calls = [];
  const payloads = [repo, head, { workflow_runs: [] }, [], []];
  const responses = [
    ...payloads.map(data => Response.json(data, { headers: { etag: '"v1"' } })),
    ...payloads.map(() => new Response(null, { status: 304 })),
    new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
    ...payloads,
  ];
  const reader = createGitHubReader({ fetchImpl: fixture(responses, calls), now: () => clock });
  const [first, shared] = await Promise.all([reader.observation(), reader.observation()]);
  assert.equal(first.fetchedAt, shared.fetchedAt); assert.equal(calls.length, 5);
  assert.equal((await reader.observation()).fetchedAt, first.fetchedAt); assert.equal(calls.length, 5);
  clock += 60001;
  const validated = await reader.observation();
  assert.equal(calls.length, 10);
  assert.ok(calls.slice(5).every(call => call.options.headers['If-None-Match'] === '"v1"'));
  assert.notEqual(validated.fetchedAt, first.fetchedAt); assert.equal(validated.commitAt, first.commitAt);
  clock += 60001;
  await assert.rejects(reader.observation(), error => error.retryAt >= clock + 120000);
  await assert.rejects(reader.observation()); assert.equal(calls.length, 11);
  clock += 120001;
  assert.equal((await reader.observation()).sha, sha); assert.equal(calls.length, 16);
});

test('one process spends no more than forty public metadata requests in an hour', async () => {
  let clock = 1000000, calls = 0;
  const reader = createGitHubReader({ now: () => clock, fetchImpl: async url => {
    calls++;
    return Response.json(url.endsWith('/serigraph') ? repo : url.includes('/branches/') ? head : url.includes('/actions/') ? { workflow_runs: [] } : []);
  } });
  for (let i = 0; i < 8; i++) { await reader.observation(); clock += 60001; }
  await assert.rejects(reader.observation(), /budget/);
  assert.equal(calls, 40);
});

test('visible-map lifecycle cancels obsolete reads, deduplicates refresh, preserves failed snapshots and invalidates PR heads', async t => {
  const original = { document: globalThis.document, localStorage: globalThis.localStorage, now: Date.now, config: api.githubConfig, observation: api.githubObservation };
  const doc = new EventTarget(); doc.hidden = false;
  let clock = 1000000, cleanup;
  globalThis.document = doc;
  globalThis.localStorage = { getItem: () => '["repository"]' };
  Date.now = () => clock;
  const requests = [];
  api.githubConfig = async () => ({ enabled: true, repo: 'jross787/serigraph', branch: 'main', refreshMs: 600000 });
  api.githubObservation = signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject }));
  Object.assign(state, { mapId: 'development', libraryId: 'synthetic', workspaceView: 'map', standalone: false, model: { byId: new Map([['repository', {}]]) } });
  t.after(() => {
    cleanup?.(); globalThis.document = original.document; globalThis.localStorage = original.localStorage; Date.now = original.now;
    api.githubConfig = original.config; api.githubObservation = original.observation; state.github = null;
  });
  cleanup = await initGitHub();
  const first = refreshGitHub(); assert.equal(first, refreshGitHub()); assert.equal(requests.length, 1);
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.ok(requests[0].signal.aborted);
  await refreshGitHub(); assert.equal(requests.length, 1);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  const second = refreshGitHub(); assert.equal(requests.length, 2);
  const snapshot = { sha, runs: [], fetchedAt: new Date(clock).toISOString(), refreshAfter: clock + 600000, pulls: { items: [{ number: 7, sha }] } };
  requests[0].resolve({ ...snapshot, sha: old }); await first;
  assert.equal(state.github.result, null);
  requests[1].resolve(snapshot); await second; assert.equal(state.github.result.sha, sha);
  state.github.pull = { pull: { number: 7, sha: old } };
  const updated = refreshGitHub(); requests[2].resolve(snapshot); await updated;
  assert.equal(state.github.pull, null); assert.match(state.github.pullError, /changed/);
  const failed = refreshGitHub(); requests[3].reject(new Error('offline')); await failed;
  assert.equal(state.github.result.fetchedAt, snapshot.fetchedAt); assert.equal(nodeObservation('repository').label, 'CI stale');
  await refreshGitHub(); assert.equal(requests.length, 4);
  clock += 600001; doc.dispatchEvent(new Event('visibilitychange'));
  const recovery = refreshGitHub(); requests[4].resolve({ ...snapshot, fetchedAt: new Date(clock).toISOString(), refreshAfter: clock + 600000 }); await recovery;
  assert.equal(state.github.error, null);
  const obsolete = refreshGitHub(); state.mapId = 'another'; bus.emit('view-changed');
  assert.ok(requests[5].signal.aborted);
  requests[5].resolve({ ...snapshot, sha: old }); await obsolete;
  assert.equal(nodeObservation('repository'), null); assert.equal(state.github.result.sha, sha);
});
