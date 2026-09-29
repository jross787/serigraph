import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPresence, inSharedFolder } from '../server/presence.js';

test('people with a map open in a cloud folder see each other; other folders stay untouched', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'serigraph-presence-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const drive = path.join(dir, 'Library', 'CloudStorage', 'GoogleDrive-someone@example.test', 'My Drive', 'Shared maps');
  await fs.mkdir(drive, { recursive: true });
  const map = path.join(drive, 'intake.yaml');
  await fs.writeFile(map, 'name: Synthetic\nnodes: []\n');
  assert.equal(inSharedFolder(map), true);
  assert.equal(inSharedFolder(path.join(dir, 'repo', 'intake.yaml')), false);

  const ana = createPresence({ identity: { id: 'ana-laptop', person: 'Ana Diaz', machine: 'Laptop' } });
  const ben = createPresence({ identity: { id: 'ben-studio', person: 'Ben Ito', machine: 'Studio' } });
  assert.deepEqual(await ana.beat(map), [], 'nobody else yet');
  const seenByBen = await ben.beat(map, { editing: true });
  assert.deepEqual(seenByBen.map((person) => [person.person, person.editing]), [['Ana Diaz', false]]);
  assert.deepEqual((await ana.list(map)).map((person) => [person.person, person.machine, person.editing]), [['Ben Ito', 'Studio', true]]);

  const stale = path.join(drive, '.serigraph-presence', 'intake.yaml', 'ben-studio.json');
  const record = JSON.parse(await fs.readFile(stale, 'utf8'));
  await fs.writeFile(stale, JSON.stringify({ ...record, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  assert.deepEqual(await ana.list(map), [], 'someone who stopped checking in drops off');

  await ana.leave(map);
  assert.deepEqual(await ben.list(map), [], 'leaving removes the record');
  const repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'intake.yaml'), 'name: Synthetic\nnodes: []\n');
  assert.deepEqual(await ana.beat(path.join(repo, 'intake.yaml')), []);
  await assert.rejects(fs.stat(path.join(repo, '.serigraph-presence')), 'no records in an ordinary folder');
});
