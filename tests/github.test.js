import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReader } from '../server/github.js';
import { ciSummary } from '../app/github.js';

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
