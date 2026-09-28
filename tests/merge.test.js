import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText } from '../server/merge.js';

const base = 'name: Synthetic\nnodes:\n  - id: a\n    type: process\n    label: Alpha\n  - id: b\n    type: process\n    label: Beta\n';

test('edits to different cards combine; edits to the same line wait for a person', async () => {
  const mine = base.replace('label: Alpha', 'label: Alpha one');
  const theirs = base.replace('label: Beta', 'label: Beta two');
  assert.equal(await mergeText({ base, mine, theirs }),
    base.replace('label: Alpha', 'label: Alpha one').replace('label: Beta', 'label: Beta two'));
  assert.equal(await mergeText({ base, mine, theirs: base.replace('label: Alpha', 'label: Alpha three') }), null);
  assert.equal(await mergeText({ base, mine, theirs: base }), mine, 'nothing new on disk keeps mine');
  assert.equal(await mergeText({ base, mine: base, theirs }), theirs, 'no local change takes theirs');
});
