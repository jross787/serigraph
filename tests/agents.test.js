// Agent Trail: live HTTP API with a deterministic fake harness.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc, port, work;

function raw({ method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
const api = (method, p, payload) => raw({
  method, p,
  headers: { 'Content-Type': 'application/json' },
  body: payload == null ? null : JSON.stringify(payload),
});

before(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'serigraph-agents-'));
  // a fake harness: emits a JSONL edit event, then either prints the result
  // and exits (default) or sleeps forever (mode file 'sleep') so the stop
  // route can be exercised against a live child
  const fake = path.join(work, 'fake-harness.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const [,, prompt] = process.argv;
let mode = 'run';
try { mode = readFileSync(join(dirname(import.meta.url.replace('file://', '')), 'mode.txt'), 'utf8').trim(); } catch {}
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/demo.ts' } }] } }));
if (mode === 'sleep') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', result: 'Finished: ' + (prompt ?? '').slice(0, 20) }));
`);
  chmodSync(fake, 0o755);

  const tryPort = 4930 + Math.floor(Math.random() * 60);
  proc = spawn('node', ['server/main.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(tryPort), OPSMAP_ROOT: work, OPSMAP_FAKE_HARNESS: fake },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + buf)), 10000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/localhost:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.stderr.on('data', (d) => { buf += d; });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${buf}`)); });
  });
});

after(() => { proc?.kill(); rmSync(work, { recursive: true, force: true }); });

test('agents list starts empty', async () => {
  const res = await api('GET', '/api/agents');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), []);
});

test('spawn runs the harness, records steps, and finishes', async () => {
  const spawned = await api('POST', '/api/agents', { harness: 'claude', prompt: 'Write the demo module' });
  assert.equal(spawned.status, 201);
  const created = JSON.parse(spawned.body);
  assert.equal(created.harness, 'claude');
  assert.equal(created.title, 'Write the demo module');

  // poll until the fake harness finishes
  let final = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const res = await api('GET', `/api/agents/${encodeURIComponent(created.id)}`);
    if (res.status === 200) {
      const a = JSON.parse(res.body);
      if (a.status === 'done' || a.status === 'error') { final = a; break; }
    }
  }
  assert.ok(final, 'agent reached a terminal status');
  assert.equal(final.status, 'done');
  assert.ok(final.steps.length >= 2, 'captured both events');
  const edit = final.steps.find((s) => s.kind === 'edit');
  assert.ok(edit, 'edit step recorded');
  assert.equal(final.lastEditPath, 'src/demo.ts');
  assert.ok(final.steps.some((s) => s.kind === 'message' && s.label.startsWith('Finished:')), 'result message captured');
});

test('validation: bad harness and empty prompt are 400', async () => {
  const bad = await api('POST', '/api/agents', { harness: 'sh', prompt: 'x' });
  assert.equal(bad.status, 400);
  const empty = await api('POST', '/api/agents', { harness: 'claude', prompt: '  ' });
  assert.equal(empty.status, 400);
});

test('stop keeps a stopped agent stopped — never error, never EXIT null as failure', async () => {
  const modeFile = path.join(work, 'mode.txt');
  writeFileSync(modeFile, 'sleep');
  try {
    const spawned = await api('POST', '/api/agents', { harness: 'claude', prompt: 'sleep long enough to be stopped' });
    assert.equal(spawned.status, 201, spawned.body);
    const { id } = JSON.parse(spawned.body);

    // wait until the session is live beyond 'starting' (the edit event landed)
    let live = null;
    for (let i = 0; i < 40 && !live; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await api('GET', `/api/agents/${encodeURIComponent(id)}`);
      const a = res.status === 200 ? JSON.parse(res.body) : null;
      if (a && a.status !== 'starting') live = a;
    }
    assert.ok(live, 'agent went live');

    const stopped = await api('POST', `/api/agents/${encodeURIComponent(id)}/stop`);
    assert.equal(stopped.status, 200, stopped.body);
    assert.equal(JSON.parse(stopped.body).status, 'stopped');

    // after SIGTERM closes the child, the status must survive as stopped
    let final = null;
    for (let i = 0; i < 40 && !final; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await api('GET', `/api/agents/${encodeURIComponent(id)}`);
      const a = res.status === 200 ? JSON.parse(res.body) : null;
      if (a && ['stopped', 'done', 'error'].includes(a.status)) final = a;
    }
    assert.ok(final, 'agent reached a terminal state');
    assert.equal(final.status, 'stopped', 'a user stop is not an error');
    assert.equal(final.exitCode, null);
    assert.ok(!final.steps.some((s) => s.kind === 'error'), 'no error step for a clean stop');
  } finally {
    rmSync(modeFile, { force: true });
  }
});

test('unknown agent id is 404; forget works', async () => {
  const missing = await api('GET', '/api/agents/nope');
  assert.equal(missing.status, 404);
  const list = JSON.parse((await api('GET', '/api/agents')).body);
  const id = list[0]?.id;
  const del = await api('DELETE', `/api/agents/${encodeURIComponent(id)}`);
  assert.equal(del.status, 200);
  const after = await api('GET', `/api/agents/${encodeURIComponent(id)}`);
  assert.equal(after.status, 404);
});
