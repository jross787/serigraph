import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, bus } from '../app/state.js';
import { api } from '../app/api.js';
import { initWorkbenchSync, connectLink } from '../app/workbench-sync.js';

test('saved Workbench links never reconnect across libraries or from legacy unscoped storage', async () => {
  const saved = new Map();
  globalThis.localStorage = {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value)};
  const source = 'name: Synthetic\nnodes: []\nedges: []\n';
  const url = 'https://workbench.md/d/synthetic?key=test-only';
  let calls = 0;
  api.inspectWorkbench = async () => { calls++; return {hasMap: true, source, role: 'edit', version: '1'}; };
  api.pushWorkbench = async () => { calls++; return {version: '2'}; };
  api.watchWorkbench = async () => new Promise(() => {});
  Object.assign(state, {mapId: 'same-id', libraryId: 'library-a', source, standalone: false});
  initWorkbenchSync();
  await connectLink(url, {hasMap: true, source, role: 'edit', version: '1'});
  saved.set('serigraph-workbench-links-v1', JSON.stringify({'same-id': {url}}));

  state.libraryId = 'library-b';
  state.source = source.replace('Synthetic', 'Different private map');
  bus.emit('map-opened');
  await new Promise(setImmediate);
  assert.equal(calls, 0, 'no inspect or publish request for another library');
  assert.equal(state.workbench, null);

  state.libraryId = 'library-a';
  state.source = source;
  bus.emit('map-opened');
  await new Promise(setImmediate);
  assert.equal(calls, 1, 'the explicitly connected original library still reconnects');
  assert.equal(state.workbench?.url, url);
});
