import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferencesPath, resolveLibraryRoot, inspectLibraryDirectory, saveLibraryPreference } from '../server/library-location.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fetch = (url, options = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(2500), ...options });

test('folder preferences are private, per installation, overrideable, and fail closed when unavailable', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'serigraph-library-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prefs/install.json'), library = path.join(dir, 'library');
  await fs.mkdir(library);
  const env = { SERIGRAPH_PREFERENCES_FILE: file };
  assert.equal(await resolveLibraryRoot(ROOT, env), ROOT);
  await saveLibraryPreference(file, library);
  assert.equal(await resolveLibraryRoot(ROOT, env), library);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await resolveLibraryRoot(ROOT, { ...env, SERIGRAPH_LIBRARY_DIR: dir }), dir);
  assert.notEqual(preferencesPath('/one', {}), preferencesPath('/two', {}));
  await assert.rejects(inspectLibraryDirectory('relative/path'), /absolute/);
  await assert.rejects(inspectLibraryDirectory(file), /folder/);
  await fs.symlink(dir, path.join(library, 'maps'), 'dir');
  await assert.rejects(inspectLibraryDirectory(library), /symbolic link/);
  await fs.unlink(path.join(library, 'maps'));
  assert.equal((await inspectLibraryDirectory(library)).maps, 0);
  await fs.rmdir(library);
  await assert.rejects(resolveLibraryRoot(ROOT, env), /unavailable/);
  await fs.writeFile(file, 'unrelated content');
  await assert.rejects(saveLibraryPreference(file, dir), /cannot be read safely/);
  assert.equal(await fs.readFile(file, 'utf8'), 'unrelated content');
});

test('approved folder switch restarts, persists, preserves old data, and rejects stale-library requests', { timeout: 25_000 }, async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'serigraph-library-switch-')));
  const file = path.join(dir, 'preferences.json');
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  const source = name => `name: ${name}\nnodes: [{id: example, type: process, label: Synthetic}]\n`;
  for (const [folder, name] of [[a, 'First'], [b, 'Second']]) {
    await fs.mkdir(path.join(folder, 'maps'), { recursive: true });
    await fs.writeFile(path.join(folder, 'maps/example.yaml'), source(name));
    await fs.writeFile(path.join(folder, '.env'), `SYNTHETIC_MARKER=${name}\n`);
  }
  await saveLibraryPreference(file, a);
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let child;
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } };
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const start = async (overrides = {}, args = []) => {
    child = spawn(process.execPath, ['server/main.js', '--no-open', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), SERIGRAPH_PREFERENCES_FILE: file,
        OPSMAP_SKIP_DOTENV: '1', SERIGRAPH_GITHUB_PILOT: '0', ...overrides } });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Startup timeout: ' + output)), 8000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes(`http://localhost:${port}/`)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
  };
  await start();
  const base = `http://127.0.0.1:${port}`;
  let current = await (await fetch(base + '/api/library')).json();
  assert.equal(current.enabled, true);
  assert.equal(current.path, a);
  const action = (name, body, headers = {}) => fetch(base + '/api/library/' + name, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'X-Serigraph-Library': current.libraryId,
      'X-Serigraph-Settings-Token': current.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await action('preview', { path: b }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await action('preview', { path: b }, { 'X-Serigraph-Settings-Token': 'wrong' })).status, 403);
  assert.equal((await action('preview', { path: 'relative' })).status, 400);
  const preview = await (await action('preview', { path: b })).json();
  assert.equal(preview.maps, 1); assert.equal(preview.hasEnv, true);
  assert.equal(await resolveLibraryRoot(ROOT, { SERIGRAPH_PREFERENCES_FILE: file }), a, 'preview does not switch');
  assert.equal((await action('switch', { nonce: preview.nonce, trusted: false })).status, 409);
  assert.equal((await action('switch', { nonce: 'stale', trusted: true })).status, 409);
  const tab1 = await fetch(base + '/api/events'), tab2 = await fetch(base + '/api/events');
  assert.equal((await action('switch', { nonce: preview.nonce, trusted: true })).status, 409);
  await tab1.body.cancel(); await tab2.body.cancel();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await action('switch', { nonce: preview.nonce, trusted: true })).status, 200);
  let next;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    try { next = await (await fetch(base + '/api/library')).json(); if (next.path === b) break; } catch { /* restarting */ }
  }
  assert.equal(next?.path, b);
  assert.notEqual(next.libraryId, current.libraryId);
  assert.equal((await fetch(base + '/api/maps', { headers: { 'X-Serigraph-Library': current.libraryId } })).status, 412);
  assert.equal((await (await fetch(base + '/api/maps')).json())[0].name, 'Second');
  assert.equal(await fs.readFile(path.join(a, 'maps/example.yaml'), 'utf8'), source('First'));
  assert.equal(await fs.readFile(path.join(a, '.env'), 'utf8'), 'SYNTHETIC_MARKER=First\n');
  await stop(); await start();
  assert.equal((await (await fetch(base + '/api/library')).json()).path, b, 'manual relaunch keeps the preference');
  await stop(); await start({ SERIGRAPH_LIBRARY_DIR: a });
  current = await (await fetch(base + '/api/library')).json();
  assert.equal(current.path, a); assert.equal(current.enabled, false); assert.equal(current.token, null);
  assert.equal((await action('preview', { path: b })).status, 403, 'operator environment cannot be overridden by HTTP');
  await stop(); await start({}, ['--lan']);
  current = await (await fetch(base + '/api/library')).json();
  assert.equal(current.path, null); assert.equal(current.enabled, false);
});
