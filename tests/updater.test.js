import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { createUpdater } from '../server/updater.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'serigraph-updater-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const clone = path.join(dir, 'clone');
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(dir, 'init', '--initial-branch=main', source);
  git(source, 'config', 'user.name', 'Synthetic Test');
  git(source, 'config', 'user.email', 'synthetic@example.test');
  mkdirSync(path.join(source, 'maps'));
  writeFileSync(path.join(source, '.gitignore'), '.env\n');
  writeFileSync(path.join(source, 'maps/example.yaml'), 'name: Synthetic\nnodes: []\n');
  writeFileSync(path.join(source, 'version.txt'), 'one');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'one');
  git(dir, 'clone', source, clone);
  const next = (name, content, force = false) => {
    writeFileSync(path.join(source, name), content);
    git(source, 'add', ...(force ? ['-f'] : []), name);
    git(source, 'commit', '-m', 'next synthetic revision');
  };
  return { source, clone, git, next, updater: createUpdater({ root: clone }) };
}

test('checks are non-applying; apply pins the displayed commit and rejects stale/local work', async t => {
  const f = fixture(t);
  f.next('version.txt', 'two');
  const checked = await f.updater.check();
  assert.equal(checked.status, 'available');
  assert.equal(checked.behind, 1);
  assert.equal(readFileSync(path.join(f.clone, 'version.txt'), 'utf8'), 'one');
  f.next('version.txt', 'three');
  await f.updater.apply(checked);
  assert.equal(readFileSync(path.join(f.clone, 'version.txt'), 'utf8'), 'two', 'never installs a later unseen revision');
  await assert.rejects(f.updater.apply(checked), /checkout changed/);
  writeFileSync(path.join(f.clone, 'untracked.txt'), 'local work');
  await assert.rejects(f.updater.check(), /local changes/);
  assert.equal(readFileSync(path.join(f.clone, 'untracked.txt'), 'utf8'), 'local work');
});

test('in-app updates refuse upstream changes to active maps/config and preserve ignored files', async t => {
  const f = fixture(t);
  f.next('maps/example.yaml', 'name: Changed upstream\nnodes: []\n');
  const protectedUpdater = createUpdater({ root: f.clone, protectedPaths: [path.join(f.clone, 'maps')] });
  await assert.rejects(protectedUpdater.apply(await protectedUpdater.check()), /active map library/);
  assert.match(readFileSync(path.join(f.clone, 'maps/example.yaml'), 'utf8'), /Synthetic/);
  f.next('.env', 'SYNTHETIC_SETTING=upstream\n', true);
  writeFileSync(path.join(f.clone, '.env'), 'SYNTHETIC_SETTING=local\n');
  const head = f.git(f.clone, 'rev-parse', 'HEAD');
  await assert.rejects(f.updater.apply(await f.updater.check()), /Git merge failed/);
  assert.equal(f.git(f.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(f.clone, '.env'), 'utf8'), 'SYNTHETIC_SETTING=local\n');
});

test('wrong branch, local-only commits, expired plans, and absent Git are explicit blockers', async t => {
  const f = fixture(t);
  f.git(f.clone, 'switch', '-c', 'local-work');
  await assert.rejects(f.updater.check(), /Switch to main/);
  f.git(f.clone, 'switch', 'main');
  f.git(f.clone, 'config', 'user.name', 'Synthetic Test');
  f.git(f.clone, 'config', 'user.email', 'synthetic@example.test');
  f.git(f.clone, 'commit', '--allow-empty', '-m', 'local only');
  await assert.rejects(f.updater.check(), /local branch has commits/);
  await assert.rejects(f.updater.apply({ target: 'a'.repeat(40), checkedAt: 0 }), /Check for updates again/);
  const noGit = path.dirname(f.clone);
  assert.equal(await createUpdater({ root: noGit }).revision(), null);
  await assert.rejects(createUpdater({ root: noGit }).check(), /not in a Git checkout/);
});
