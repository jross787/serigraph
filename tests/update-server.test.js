// Real update/restart against a throwaway local Git remote and synthetic
// external library. Never fetch, update, or read maps from the user's repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fetch = (url, options = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(3000), ...options });

test('local updates enforce authority/idle state and restart on the actual port, preserving external data', { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serigraph-update-server-'));
  const source = path.join(dir, 'source');
  const checkout = path.join(dir, 'checkout');
  const library = path.join(dir, 'library');
  let child;
  let held;
  let serverOutput = '';
  t.after(async () => {
    held?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(source);
  for (const file of ['server', 'app', 'shared', 'vendor', 'tools', 'package.json']) cpSync(path.join(ROOT, file), path.join(source, file), { recursive: true });
  mkdirSync(path.join(library, 'maps'), { recursive: true });
  const map = 'name: Update test\nnodes: [{ id: example, type: process, label: Synthetic }]\n';
  const config = 'SYNTHETIC_SETTING=keep\n';
  writeFileSync(path.join(library, 'maps/example.yaml'), map);
  writeFileSync(path.join(library, '.env'), config);
  git(source, 'init', '--initial-branch=main');
  git(source, 'config', 'user.name', 'Synthetic Test');
  git(source, 'config', 'user.email', 'synthetic@example.test');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'synthetic install one');
  git(dir, 'clone', source, checkout);
  const first = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'app/update-test-version.txt'), 'two');
  git(source, 'add', 'app/update-test-version.txt');
  git(source, 'commit', '-m', 'synthetic update two');
  const target = git(source, 'rev-parse', 'HEAD');

  // Force the initial launch to pick the next port; restart must stay there.
  held = createServer();
  held.listen(0, '127.0.0.1');
  await once(held, 'listening');
  const startingPort = held.address().port;
  const start = async (args = []) => {
    child = spawn(process.execPath, ['server/main.js', '--no-open', ...args], {
      cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(startingPort),
        OPSMAP_SKIP_DOTENV: '1', SERIGRAPH_LIBRARY_DIR: library, SERIGRAPH_GITHUB_PILOT: '0' },
    });
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 10_000);
      child.stdout.on('data', chunk => {
        serverOutput += chunk;
        output += chunk;
        const match = output.match(/http:\/\/localhost:(\d+)\//);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.stderr.on('data', chunk => { output += chunk; serverOutput += chunk; });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
  };
  let port = await start();
  assert.notEqual(port, startingPort);
  const base = () => `http://127.0.0.1:${port}`;
  let info = await (await fetch(base() + '/api/updates')).json();
  const instance = info.instance;
  const libraryId = (await fetch(base() + '/api/maps')).headers.get('x-serigraph-library');
  const action = (name, payload = {}, headers = {}) => fetch(base() + '/api/updates/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base(),
      'X-Serigraph-Library': libraryId, 'X-Serigraph-Update-Token': info.token, ...headers },
    body: JSON.stringify(payload),
  });
  assert.equal(info.enabled, true);
  assert.equal(info.running, first);
  assert.equal((await action('check', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await action('check', {}, { 'X-Serigraph-Update-Token': 'wrong' })).status, 403);
  assert.equal((await action('check', {}, { 'X-Serigraph-Library': 'wrong' })).status, 412);
  info = await (await action('check')).json();
  assert.equal(info.status, 'available');
  assert.equal(info.target, target);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), first);
  const plan = { current: info.current, target: info.target };
  assert.equal((await action('apply', { ...plan, target: first })).status, 409);

  const tab1 = await fetch(base() + '/api/events');
  const tab2 = await fetch(base() + '/api/events');
  assert.equal((await action('apply', plan)).status, 409, 'another connected tab blocks restart');
  await tab2.body.cancel();
  await tab1.body.cancel();
  // Hold an unfinished JSON request: applying cannot interrupt an in-flight
  // save, AI call, or sync request even when that caller disconnects early.
  const slow = request(base() + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  slow.on('error', () => {});
  slow.flushHeaders();
  await pause(50);
  assert.equal((await action('apply', plan)).status, 409, 'active API work blocks restart');
  slow.end('{}');
  const slowResponse = (await once(slow, 'response'))[0];
  slowResponse.resume();
  await once(slowResponse, 'end');
  const pid = child.pid;
  const applied = await action('apply', plan);
  assert.equal(applied.status, 200, await applied.text());
  let restarted = null;
  const restartDeadline = Date.now() + 7000;
  for (let attempt = 0; attempt < 100 && Date.now() < restartDeadline; attempt++) {
    await pause(50);
    try {
      const next = await (await fetch(base() + '/api/updates', { signal: AbortSignal.timeout(2000) })).json();
      if (next.instance !== instance && next.running === target) { restarted = next; break; }
    } catch { /* restart closes old sockets */ }
  }
  assert.ok(restarted, 'a fresh server reports the approved revision on the same port:\n' + serverOutput);
  assert.equal(child.pid, pid, 'launcher stays alive across restart');
  assert.equal(await (await fetch(base() + '/app/update-test-version.txt')).text(), 'two');
  assert.equal(readFileSync(path.join(library, 'maps/example.yaml'), 'utf8'), map);
  assert.equal(readFileSync(path.join(library, '.env'), 'utf8'), config);
  assert.equal(git(checkout, 'status', '--porcelain'), '');

  let exited = once(child, 'exit'); child.kill(); await exited;
  await new Promise(resolve => held.close(resolve));
  held = null;
  port = await start(['--lan']);
  info = await (await fetch(base() + '/api/updates')).json();
  assert.equal(info.enabled, false);
  assert.equal(info.token, null);
  assert.equal((await action('check')).status, 403, 'LAN mode cannot update even from loopback');
});
