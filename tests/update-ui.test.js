import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateBlocker, initUpdates } from '../app/updates.js';

test('the update dialog blocks pending saves, conflicts, inspector/chat drafts, and sync', () => {
  assert.equal(updateBlocker({ saveStatus: 'saved', errors: [] }), '');
  assert.match(updateBlocker({ saveStatus: 'saving' }), /save to finish/);
  assert.match(updateBlocker({ saveStatus: 'error' }), /conflicts/);
  assert.match(updateBlocker({ errors: [{}] }), /errors/);
  assert.match(updateBlocker({ workbench: { syncing: false } }), /Disconnect/);
  assert.match(updateBlocker({}, true), /draft/);
  assert.equal(typeof initUpdates, 'function');
});
