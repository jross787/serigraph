// Live-HTTP tests: boot the real server on an ephemeral port and exercise
// the API surface, including the localhost-only guards. Read-only against
// maps/ — no test here may perform a successful write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc;
let port;

// raw client so we can send arbitrary Host / Content-Type headers
function raw({ method = 'GET', p = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

before(async () => {
  const tryPort = 4860 + Math.floor(Math.random() * 100);
  proc = spawn('node', ['server/main.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(tryPort) },
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

after(() => { proc?.kill(); });

test('GET /api/maps lists each map mode', async () => {
  const res = await raw({ p: '/api/maps' });
  assert.equal(res.status, 200);
  const maps = JSON.parse(res.body);
  assert.ok(Array.isArray(maps));
  assert.equal(maps.find((m) => m.id === 'insurance')?.mode, 'process');
  assert.equal(maps.find((m) => m.id === 'vip')?.mode, 'freeform');
});

test('GET /api/templates exposes freeform templates', async () => {
  const res = await raw({ p: '/api/templates' });
  assert.equal(res.status, 200);
  const templates = JSON.parse(res.body);
  assert.equal(templates.find((template) => template.id === 'systems-of-record')?.mode, 'freeform');
});

test('POST /api/maps rejects an unknown map mode without writing', async () => {
  const res = await raw({
    method: 'POST',
    p: '/api/maps',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid mode test', mode: 'diagram' }),
  });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /process, freeform/);
});

test('requests with a non-local Host header are refused (DNS rebinding)', async () => {
  const res = await raw({ p: '/api/maps', headers: { Host: 'evil.example' } });
  assert.equal(res.status, 403);
  const page = await raw({ p: '/', headers: { Host: 'evil.example:4700' } });
  assert.equal(page.status, 403);
});

test('local Host variants are accepted', async () => {
  for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost']) {
    const res = await raw({ p: '/api/maps', headers: { Host: h } });
    assert.equal(res.status, 200, `Host: ${h}`);
  }
});

test('API writes without application/json are refused (CSRF simple requests)', async () => {
  const body = 'name: X\nnodes: []\nedges: []\n';
  const noType = await raw({ method: 'PUT', p: '/api/maps/insurance', body });
  assert.equal(noType.status, 415);
  const textPlain = await raw({
    method: 'PUT', p: '/api/maps/insurance',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ source: body }),
  });
  assert.equal(textPlain.status, 415);
  const form = await raw({
    method: 'POST', p: '/api/maps',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=evil',
  });
  assert.equal(form.status, 415);
});

test('a JSON write with an invalid map is refused with 422, file untouched', async () => {
  const res = await raw({
    method: 'PUT', p: '/api/maps/insurance',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'name: X\nnodes:\n  - id: a\n    type: wizard\n    label: A\n' }),
  });
  assert.equal(res.status, 422);
  const back = await raw({ p: '/api/maps/insurance' });
  assert.equal(back.status, 200);
  assert.match(JSON.parse(back.body).source, /Summit Insurance/);
});

test('import status reports availability without crashing offline', async () => {
  const res = await raw({ p: '/api/import/status' });
  assert.equal(res.status, 200);
  const status = JSON.parse(res.body);
  assert.equal(typeof status.available, 'boolean');
});
