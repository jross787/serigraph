import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'tools', 'serigraph.mjs');

function run(program, args, cwd, env = {}) {
  return spawnSync(program, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function git(args, cwd) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('serigraph update checks and fast-forwards a clean clone without touching this checkout', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'serigraph-update-'));
  const remote = path.join(temp, 'remote.git');
  const source = path.join(temp, 'source');
  const checkout = path.join(temp, 'checkout');
  try {
    git(['init', '--bare', remote], temp);
    git(['init', '--initial-branch=main', source], temp);
    git(['config', 'user.name', 'Serigraph Test'], source);
    git(['config', 'user.email', 'serigraph-test@example.com'], source);
    writeFileSync(path.join(source, 'version.txt'), 'one\n');
    git(['add', 'version.txt'], source);
    git(['commit', '-m', 'version one'], source);
    git(['remote', 'add', 'origin', remote], source);
    git(['push', '-u', 'origin', 'main'], source);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    git(['clone', remote, checkout], temp);

    writeFileSync(path.join(source, 'version.txt'), 'two\n');
    git(['commit', '-am', 'version two'], source);
    git(['push'], source);

    const beforeHead = git(['rev-parse', 'HEAD'], checkout);
    const checked = run(process.execPath, [CLI, 'update', '--check'], ROOT, { SERIGRAPH_ROOT: checkout });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /1 update commit available/);
    assert.equal(git(['rev-parse', 'HEAD'], checkout), beforeHead, '--check leaves HEAD unchanged');
    assert.equal(readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'one\n');

    const updated = run(process.execPath, [CLI, 'update'], ROOT, { SERIGRAPH_ROOT: checkout });
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /updated by 1 commit/);
    assert.equal(readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'two\n');

    writeFileSync(path.join(checkout, 'version.txt'), 'local work\n');
    writeFileSync(path.join(source, 'version.txt'), 'three\n');
    git(['commit', '-am', 'version three'], source);
    git(['push'], source);
    const refused = run(process.execPath, [CLI, 'update'], ROOT, { SERIGRAPH_ROOT: checkout });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /has local changes/);
    assert.equal(readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'local work\n');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
