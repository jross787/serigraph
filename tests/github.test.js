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
