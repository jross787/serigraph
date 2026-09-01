// Concurrent PUTs to the same map must all succeed: each request writes its
// own uniquely-named temp file, fsyncs it, then atomically renames. Two
// requests sharing one temp path would truncate each other (ENOENT or the
// wrong content winning). We boot a real server against a throwaway maps
// directory and fire many PUTs at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAPS_DIR = mkdtempSync(path.join(tmpdir(), 'serigraph-concurrent-'));

let proc;
let port;

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
  const tryPort = 5060 + Math.floor(Math.random() * 100);
  proc = spawn('node', ['server/main.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(tryPort), OPSMAP_MAPS_DIR: MAPS_DIR },
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

after(() => {
  proc?.kill();
  rmSync(MAPS_DIR, { recursive: true, force: true });
});

test('concurrent PUTs stay atomic: each lands whole or conflicts, never corrupts', async () => {
  const headers = { 'Content-Type': 'application/json' };
  const payloads = Array.from({ length: 16 }, (_, i) =>
    `name: Concurrent ${i}\nnodes:\n  - id: n${i}\n    type: process\n    label: Node ${i}\nedges: []\n`);
  const bodies = payloads.map((source) => JSON.stringify({ source }));

  // first PUT creates the file (no If-Match needed for a create) and
  // returns the etag every subsequent save must present via If-Match
  const first = await raw({ method: 'PUT', p: '/api/maps/concurrent-target', headers, body: bodies[0] });
  assert.equal(first.status, 200, `seed PUT failed: ${first.body}`);
  const etag = JSON.parse(first.body).etag;
  assert.ok(etag, 'seed PUT must return an etag');

  // the rest race to overwrite it, each proving it saw the current file;
  // under the per-file save lock exactly one racer can win — the check and
  // the write are one unit, so every other racer must get a 409, never a
  // second 200 (a silent lost update)
  const responses = await Promise.all(
    bodies.slice(1).map((body) =>
      raw({ method: 'PUT', p: '/api/maps/concurrent-target', headers: { ...headers, 'If-Match': etag }, body })),
  );
  const ok = responses.filter((r) => r.status === 200);
  const conflicts = responses.filter((r) => r.status === 409);
  assert.equal(ok.length + conflicts.length, responses.length,
    `unexpected statuses: ${responses.map((r) => r.status).join(',')}`);
  assert.equal(ok.length, 1, `exactly one racer may win; got ${ok.length} × 200`);
  assert.equal(conflicts.length, responses.length - 1, 'every loser must be a 409 conflict');
  // the winner's etag differs from the seed: same-size writes in the same
  // tick must not mint colliding etags (content hash prevents that)
  const winnerEtag = JSON.parse(ok[0].body).etag;
  assert.notEqual(winnerEtag, etag, 'etag must change after a write');
  // the file on disk parses and equals exactly one of the written payloads
  const onDisk = readFileSync(path.join(MAPS_DIR, 'concurrent-target.yaml'), 'utf8');
  assert.ok(payloads.includes(onDisk), 'on-disk source must be one of the written payloads');

  // GET agrees with the file
  const back = await raw({ p: '/api/maps/concurrent-target' });
  assert.equal(JSON.parse(back.body).source, onDisk);

  // no temp files left behind
  const leftover = readdirSync(MAPS_DIR).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftover, [], `leftover temp files: ${leftover.join(', ')}`);
});

test('a failed PUT (invalid map) leaves no temp file behind', async () => {
  const before = new Set(readdirSync(MAPS_DIR));
  const res = await raw({
    method: 'PUT', p: '/api/maps/concurrent-target',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'name: X\nnodes:\n  - id: a\n    type: wizard\n    label: A\n' }),
  });
  assert.equal(res.status, 422);
  const after = new Set(readdirSync(MAPS_DIR));
  assert.deepEqual([...after], [...before], 'a rejected PUT must not create or leave any file');
});
