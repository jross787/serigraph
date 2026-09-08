import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../app/state.js';
import { api } from '../app/api.js';

test('API pins the library and refuses a changed server without adopting its data', async () => {
  const originalFetch = globalThis.fetch;
  let responseLibrary = 'library-a';
  let calls = 0;
  state.libraryId = null;
  state.standalone = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['X-Serigraph-Library'], calls++ ? 'library-a' : undefined);
    return new Response('[]', {headers: {'X-Serigraph-Library': responseLibrary}});
  };
  try {
    await api.listMaps();
    assert.equal(state.libraryId, 'library-a');
    await api.listProjects();
    responseLibrary = 'library-b';
    await assert.rejects(api.listMaps(), error => error.status === 412 && /Reload/.test(error.message));
    assert.equal(state.libraryId, 'library-a', 'reload is required to adopt another library');
  } finally {
    globalThis.fetch = originalFetch;
    state.libraryId = null;
  }
});
