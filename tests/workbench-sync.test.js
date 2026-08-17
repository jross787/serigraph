import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkbenchError,
  createWorkbenchShare,
  extractSerigraphSource,
  inspectWorkbench,
  parseWorkbenchShareUrl,
  pushWorkbench,
  upsertSerigraphContent,
} from '../server/workbench-sync.js';

const MAP_A = `name: Shared map
description: First copy
nodes:
  - id: start
    type: process
    label: Start
edges: []
`;

const MAP_B = MAP_A.replace('First copy', 'Workbench copy');
const MAP_C = MAP_A.replace('First copy', 'Local copy');
const LINK = 'https://workbench.md/d/doc123?key=test-edit-key';

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test('Workbench share URLs accept document and agent links only', () => {
  assert.deepEqual(parseWorkbenchShareUrl(LINK), { docId: 'doc123', key: 'test-edit-key' });
  assert.deepEqual(parseWorkbenchShareUrl('https://workbench.md/d/doc123/agent?key=test-view-key'), {
    docId: 'doc123',
    key: 'test-view-key',
  });
  assert.throws(() => parseWorkbenchShareUrl('https://example.com/d/doc123?key=test'), WorkbenchError);
  assert.throws(() => parseWorkbenchShareUrl('https://workbench.md/d/doc123'), /share key/);
  assert.throws(() => parseWorkbenchShareUrl('https://workbench.md/api/docs/doc123?key=test'), /workbench.md document link/);
});

test('a Serigraph section round-trips YAML and preserves the rest of the document', () => {
  const original = '# Team workspace\n\nKeep this paragraph.\n';
  const linked = upsertSerigraphContent(original, MAP_A);
  assert.equal(extractSerigraphSource(linked), MAP_A);
  assert.match(linked, /^# Team workspace/);
  assert.match(linked, /Keep this paragraph\./);
  assert.match(linked, /```widget #serigraph-preview/);
  assert.match(linked, /Shared map/);

  const updated = upsertSerigraphContent(linked, MAP_B);
  assert.equal(extractSerigraphSource(updated), MAP_B);
  assert.equal((updated.match(/serigraph-link:start/g) || []).length, 1);
  assert.match(updated, /Keep this paragraph\./);
});

test('inspect reads role, content, and version without returning the share key', async () => {
  const content = upsertSerigraphContent('hello\n', MAP_A);
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers['X-Share-Key'], 'test-edit-key');
    if (url.endsWith('/content')) {
      return response(content, { headers: { ETag: '"v1"', 'X-Doc-Version': 'v1' } });
    }
    return response(JSON.stringify({ doc: { title: 'Shared operations', role: 'edit' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await inspectWorkbench(LINK, { fetchImpl });
  assert.deepEqual(result, {
    docId: 'doc123',
    title: 'Shared operations',
    role: 'edit',
    hasMap: true,
    source: MAP_A,
    version: 'v1',
  });
  assert.doesNotMatch(JSON.stringify(result), /test-edit-key/);
});

test('push replaces only the linked map and uses the current ETag', async () => {
  const before = upsertSerigraphContent('owner notes\n', MAP_A);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) return response(before, { headers: { ETag: '"v1"', 'X-Doc-Version': 'v1' } });
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers['If-Match'], '"v1"');
    assert.equal(options.headers['X-Share-Key'], 'test-edit-key');
    assert.match(options.body, /^owner notes/);
    assert.equal(extractSerigraphSource(options.body), MAP_C);
    return response(JSON.stringify({ ok: true, version: 'v2' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await pushWorkbench(LINK, MAP_C, {
    baseVersion: 'v1',
    baseSource: MAP_A,
    fetchImpl,
  });
  assert.equal(result.version, 'v2');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.url.includes('test-edit-key')));
});

test('push refuses to overwrite a map changed in both places', async () => {
  const remote = upsertSerigraphContent('notes\n', MAP_B);
  let puts = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'PUT') puts++;
    return response(remote, { headers: { ETag: '"v2"', 'X-Doc-Version': 'v2' } });
  };
  await assert.rejects(
    pushWorkbench(LINK, MAP_C, { baseVersion: 'v1', baseSource: MAP_A, fetchImpl }),
    (error) => error.status === 409 && error.remoteSource === MAP_B,
  );
  assert.equal(puts, 0);
});

test('push treats a removed Workbench map as a conflict', async () => {
  let puts = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'PUT') puts++;
    return response('notes without a map\n', { headers: { ETag: '"v2"', 'X-Doc-Version': 'v2' } });
  };
  await assert.rejects(
    pushWorkbench(LINK, MAP_C, { baseVersion: 'v1', baseSource: MAP_A, fetchImpl }),
    (error) => error.status === 409 && error.remoteSource === null,
  );
  assert.equal(puts, 0);
});

test('share creation returns browser and agent links for an allowed role', async () => {
  const fetchImpl = async (_url, options) => {
    assert.equal(options.headers['X-Share-Key'], 'test-edit-key');
    assert.deepEqual(JSON.parse(options.body), { role: 'suggest' });
    return response(JSON.stringify({ share: {
      role: 'suggest',
      url: 'https://workbench.md/d/doc123?key=suggest-key',
      agent_url: 'https://workbench.md/d/doc123/agent?key=suggest-key',
    } }), { headers: { 'Content-Type': 'application/json' } });
  };
  assert.deepEqual(await createWorkbenchShare(LINK, 'suggest', { fetchImpl }), {
    role: 'suggest',
    url: 'https://workbench.md/d/doc123?key=suggest-key',
    agentUrl: 'https://workbench.md/d/doc123/agent?key=suggest-key',
  });
  await assert.rejects(createWorkbenchShare(LINK, 'owner', { fetchImpl }), /view, comment, suggest, or edit/);
});
