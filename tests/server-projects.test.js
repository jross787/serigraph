// Project API tests: boot the real server against a temp workspace
// (OPSMAP_ROOT) and exercise project create/list, path-based map ids, and
// moves between the root and a project. The temp workspace starts empty, so
// booting here also proves the watcher survives a missing projects/ dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';

// etags are "<size>-<mtimeMs>" — mtimeMs keeps sub-millisecond decimals
const ETAG_RE = /^\d+-\d+(\.\d+)?$/;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc;
let port;
let work;

// raw client so we can send arbitrary Host / Content-Type headers;
// onPort targets a server other than the shared one (see the import test)
function raw({ method = 'GET', p = '/', headers = {}, body = null, onPort }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: onPort ?? port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const api = (method, p, payload, headers = {}) => raw({
  method,
  p,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: payload == null ? null : JSON.stringify(payload),
});

// boot a server with env overrides; resolves with the child process and the
// port it actually bound (parsed from the startup banner)
function boot(env) {
  const child = spawn(process.execPath, ['server/main.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childPort = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + buf)), 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/localhost:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${buf}`)); });
  });
  return { child, childPort };
}

before(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), 'serigraph-projects-'));
  // the standalone export inlines the app modules from ROOT — link them in
  // so export routes work against the temp workspace
  for (const dir of ['app', 'vendor', 'shared']) symlinkSync(path.join(ROOT, dir), path.join(work, dir));
  const started = boot({ PORT: String(4960 + Math.floor(Math.random() * 100)), OPSMAP_ROOT: work });
  proc = started.child;
  port = await started.childPort;
});

after(() => {
  proc?.kill();
  rmSync(work, { recursive: true, force: true });
});

test('boots with no library folders and lists nothing', async () => {
  const maps = await raw({ p: '/api/maps' });
  assert.equal(maps.status, 200);
  assert.deepEqual(JSON.parse(maps.body), []);
  const projects = await raw({ p: '/api/projects' });
  assert.equal(projects.status, 200);
  assert.deepEqual(JSON.parse(projects.body), []);
  const trash = await raw({ p: '/api/trash' });
  assert.equal(trash.status, 200);
  assert.deepEqual(JSON.parse(trash.body), []);
});

test('POST /api/projects creates the folder and index; duplicate is 409', async () => {
  const res = await api('POST', '/api/projects', { name: 'Atlas Logistics' });
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(res.body), { slug: 'atlas-logistics', name: 'Atlas Logistics' });
  const index = path.join(work, 'projects', 'atlas-logistics', 'projects.yaml');
  assert.ok(existsSync(index), 'index file written');
  assert.match(readFileSync(index, 'utf8'), /name: "Atlas Logistics"/);

  const again = await api('POST', '/api/projects', { name: 'Atlas Logistics' });
  assert.equal(again.status, 409);

  const noName = await api('POST', '/api/projects', {});
  assert.equal(noName.status, 400);
});

test('POST /api/maps creates a map inside a project', async () => {
  const res = await api('POST', '/api/maps', { name: 'Order Flow', project: 'atlas-logistics' });
  assert.equal(res.status, 201);
  const created = JSON.parse(res.body);
  assert.equal(created.id, 'atlas-logistics/order-flow');
  assert.equal(created.project, 'atlas-logistics');
  assert.match(created.etag, ETAG_RE, '201 body carries the new file etag');
  assert.equal(res.headers.etag, created.etag, 'ETag header matches the body field');
  assert.ok(existsSync(path.join(work, 'projects', 'atlas-logistics', 'order-flow.yaml')));

  const again = await api('POST', '/api/maps', { name: 'Order Flow', project: 'atlas-logistics' });
  assert.equal(again.status, 409);
});

test('POST /api/maps with a new project auto-creates folder and index', async () => {
  const res = await api('POST', '/api/maps', { name: 'Solo Map', project: 'newproj' });
  assert.equal(res.status, 201);
  const created = JSON.parse(res.body);
  assert.equal(created.id, 'newproj/solo-map');
  assert.equal(created.project, 'newproj');
  assert.match(created.etag, ETAG_RE, '201 body carries the new file etag');
  assert.ok(existsSync(path.join(work, 'projects', 'newproj', 'projects.yaml')), 'minimal index written');
});

test('POST /api/maps without a project stays at the root', async () => {
  const res = await api('POST', '/api/maps', { name: 'Root Map' });
  assert.equal(res.status, 201);
  const created = JSON.parse(res.body);
  assert.equal(created.id, 'root-map');
  assert.equal(created.project, null);
  assert.match(created.etag, ETAG_RE, '201 body carries the new file etag');
  assert.ok(existsSync(path.join(work, 'maps', 'root-map.yaml')));
});

test('GET /api/maps lists root and project maps with project metadata, index hidden', async () => {
  const res = await raw({ p: '/api/maps' });
  assert.equal(res.status, 200);
  const maps = JSON.parse(res.body);
  const root = maps.find((m) => m.id === 'root-map');
  assert.equal(root.project, null);
  assert.equal(root.hasFlags, false);
  assert.equal(root.hasIssues, false);
  const nested = maps.find((m) => m.id === 'atlas-logistics/order-flow');
  assert.deepEqual(nested.project, { slug: 'atlas-logistics', name: 'Atlas Logistics' });
  assert.equal(nested.name, 'Order Flow');
  assert.ok(!maps.some((m) => m.id === 'atlas-logistics/projects'), 'projects.yaml never listed as a map');
});

test('GET /api/projects returns slug, name, description, order, tags, mapCount', async () => {
  const res = await raw({ p: '/api/projects' });
  assert.equal(res.status, 200);
  const projects = JSON.parse(res.body);
  const atlas = projects.find((p) => p.slug === 'atlas-logistics');
  assert.deepEqual(atlas, {
    slug: 'atlas-logistics',
    name: 'Atlas Logistics',
    description: null,
    order: [],
    tags: {},
    mapCount: 1,
  });
  const auto = projects.find((p) => p.slug === 'newproj');
  assert.equal(auto.name, 'newproj', 'auto-created project falls back to the slug as its name');
  assert.equal(auto.mapCount, 1);
});

test('GET and PUT by path-based id', async () => {
  const got = await raw({ p: '/api/maps/atlas-logistics/order-flow' });
  assert.equal(got.status, 200);
  const { id, source, etag } = JSON.parse(got.body);
  assert.equal(id, 'atlas-logistics/order-flow');
  assert.match(source, /Order Flow/);
  assert.equal(got.headers.etag, etag, 'ETag header matches the body field');

  // saving an existing file requires the etag the edit was based on
  const updated = 'name: Renamed Flow\nnodes:\n  - id: a\n    type: process\n    label: A\nedges: []\n';
  const put = await api('PUT', '/api/maps/atlas-logistics/order-flow', { source: updated }, { 'If-Match': etag });
  assert.equal(put.status, 200);
  const fresh = JSON.parse(put.body).etag;
  assert.match(fresh, ETAG_RE, 'a successful save returns the new etag');
  const back = await raw({ p: '/api/maps/atlas-logistics/order-flow' });
  assert.equal(JSON.parse(back.body).source, updated);

  const invalid = await api('PUT', '/api/maps/atlas-logistics/order-flow', { source: 'name: X\nnodes:\n  - id: a\n    type: wizard\n    label: A\n' }, { 'If-Match': fresh });
  assert.equal(invalid.status, 422);
  assert.ok(JSON.parse(invalid.body).error, '422 is a JSON error body');
  const still = await raw({ p: '/api/maps/atlas-logistics/order-flow' });
  assert.equal(JSON.parse(still.body).source, updated, '422 leaves the file untouched');
});

test('a .yml map inside a project resolves and lists', async () => {
  writeFileSync(path.join(work, 'projects', 'atlas-logistics', 'legacy.yml'), 'name: Legacy\nnodes: []\nedges: []\n');
  const got = await raw({ p: '/api/maps/atlas-logistics/legacy' });
  assert.equal(got.status, 200);
  const maps = JSON.parse((await raw({ p: '/api/maps' })).body);
  assert.ok(maps.some((m) => m.id === 'atlas-logistics/legacy' && m.file === 'legacy.yml'));
});

test('move project -> root: file renames, old id answers with movedTo', async () => {
  const res = await api('POST', '/api/maps/atlas-logistics/order-flow/move', { project: null });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { id: 'order-flow', project: null });
  assert.ok(existsSync(path.join(work, 'maps', 'order-flow.yaml')), 'file landed at the root');
  assert.ok(!existsSync(path.join(work, 'projects', 'atlas-logistics', 'order-flow.yaml')), 'old file gone');

  const oldId = await raw({ p: '/api/maps/atlas-logistics/order-flow' });
  assert.equal(oldId.status, 200, 'old id still answers');
  const body = JSON.parse(oldId.body);
  assert.equal(body.id, 'order-flow');
  assert.equal(body.movedTo, 'order-flow');
  assert.match(body.source, /Renamed Flow/);
  assert.equal(oldId.headers.etag, body.etag, 'the movedTo branch carries the new file etag too');

  const newId = await raw({ p: '/api/maps/order-flow' });
  assert.equal(newId.status, 200);
  assert.equal(JSON.parse(newId.body).movedTo, undefined, 'no movedTo on the canonical id');
});

test('move root -> project, and movedTo follows the chain', async () => {
  const res = await api('POST', '/api/maps/order-flow/move', { project: 'atlas-logistics' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { id: 'atlas-logistics/order-flow', project: 'atlas-logistics' });

  const oldest = await raw({ p: '/api/maps/order-flow' });
  assert.equal(JSON.parse(oldest.body).movedTo, 'atlas-logistics/order-flow');
});

test('move refuses a name collision with 409', async () => {
  const made = await api('POST', '/api/maps', { name: 'Order Flow' });
  assert.equal(made.status, 201);
  const res = await api('POST', '/api/maps/order-flow/move', { project: 'atlas-logistics' });
  assert.equal(res.status, 409);
  assert.ok(existsSync(path.join(work, 'maps', 'order-flow.yaml')), 'source left in place');
});

test('move to the same place is a 400', async () => {
  const atRoot = await api('POST', '/api/maps/order-flow/move', { project: null });
  assert.equal(atRoot.status, 400);
  const inProject = await api('POST', '/api/maps/atlas-logistics/order-flow/move', { project: 'atlas-logistics' });
  assert.equal(inProject.status, 400);
});

test('invalid ids and slugs are rejected', async () => {
  const dots = await raw({ p: '/api/maps/%2E%2E%2Fsecret' });
  assert.equal(dots.status, 400);
  const tooDeep = await raw({ p: '/api/maps/a/b/c' });
  assert.equal(tooDeep.status, 400);
  const badProject = await api('POST', '/api/maps', { name: 'X', project: '..' });
  assert.equal(badProject.status, 400);
  const badChars = await api('POST', '/api/maps', { name: 'X', project: 'bad slug!' });
  assert.equal(badChars.status, 400);
  const badMove = await api('POST', '/api/maps/order-flow/move', { project: 'bad slug!' });
  assert.equal(badMove.status, 400);
});

test('the index name is reserved inside a project', async () => {
  const created = await api('POST', '/api/maps', { name: 'projects', project: 'atlas-logistics' });
  assert.equal(created.status, 400);
  const got = await raw({ p: '/api/maps/atlas-logistics/projects' });
  assert.equal(got.status, 400);
  const moved = await api('POST', '/api/maps/root-map/move', { project: null });
  assert.equal(moved.status, 400, 'already at the root');
});

test('404 text mentions the looked-up path', async () => {
  const nested = await raw({ p: '/api/maps/atlas-logistics/nope' });
  assert.equal(nested.status, 404);
  assert.match(JSON.parse(nested.body).error, /projects\/atlas-logistics\/nope\.yaml/);
  const root = await raw({ p: '/api/maps/nope' });
  assert.equal(root.status, 404);
  assert.match(JSON.parse(root.body).error, /maps\/nope\.yaml/);
});

test('map summaries expose hasFlags and hasIssues', async () => {
  const source = [
    'name: Flagged',
    'nodes:',
    '  - id: a  # inferred: never stated outright',
    '    type: process',
    '    label: A',
    '  - id: b',
    '    type: system',
    '    label: B',
    'edges:',
    '  - from: a',
    '    to: b',
    '    issue: "drops orders weekly"',
    '',
  ].join('\n');
  const put = await api('PUT', '/api/maps/atlas-logistics/flagged', { source });
  assert.equal(put.status, 200);
  const maps = JSON.parse((await raw({ p: '/api/maps' })).body);
  const flagged = maps.find((m) => m.id === 'atlas-logistics/flagged');
  assert.equal(flagged.hasFlags, true);
  assert.equal(flagged.hasIssues, true);
  const plain = maps.find((m) => m.id === 'root-map');
  assert.equal(plain.hasFlags, false);
  assert.equal(plain.hasIssues, false);
});

const standalonePayload = (body) => JSON.parse(body.match(/window\.OPSMAP_STANDALONE = (\{.*?\});<\/script>/s)[1]);

test('project export bundles the lead map with the project context', async () => {
  // an explicit order makes the lead map deterministic
  writeFileSync(path.join(work, 'projects', 'atlas-logistics', 'projects.yaml'), 'name: Atlas Logistics\norder:\n  - order-flow\n');
  const res = await raw({ p: '/export/project/atlas-logistics.html' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-disposition'], /attachment; filename="atlas-logistics-serigraph\.html"/);
  const payload = standalonePayload(res.body);
  assert.equal(payload.id, 'atlas-logistics/order-flow', 'opens on the first map in "order:"');
  assert.match(payload.source, /Renamed Flow/);
  assert.deepEqual(Object.keys(payload.project), ['slug', 'name', 'maps']);
  assert.equal(payload.project.slug, 'atlas-logistics');
  assert.equal(payload.project.name, 'Atlas Logistics');
  const ids = payload.project.maps.map((m) => m.id).sort();
  assert.deepEqual(ids, ['atlas-logistics/flagged', 'atlas-logistics/legacy', 'atlas-logistics/order-flow']);
  assert.ok(!ids.includes('atlas-logistics/projects'), 'the index is not a map in the bundle either');
});

test('project export 404s for unknown or empty projects, 400 for bad slugs', async () => {
  const made = await api('POST', '/api/projects', { name: 'Empty Proj' });
  assert.equal(made.status, 201);
  const empty = await raw({ p: '/export/project/empty-proj.html' });
  assert.equal(empty.status, 404);
  assert.match(JSON.parse(empty.body).error, /no maps to export/);
  const unknown = await raw({ p: '/export/project/nope.html' });
  assert.equal(unknown.status, 404);
  assert.match(JSON.parse(unknown.body).error, /no project "nope"/);
  const bad = await raw({ p: '/export/project/bad%20slug.html' });
  assert.equal(bad.status, 400);
});

test('single-map export of a project map embeds the project context', async () => {
  const res = await raw({ p: '/export/atlas-logistics/order-flow.html' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /atlas-logistics-order-flow-serigraph\.html/);
  const payload = standalonePayload(res.body);
  assert.equal(payload.id, 'atlas-logistics/order-flow');
  assert.equal(payload.project.slug, 'atlas-logistics');

  const root = await raw({ p: '/export/root-map.html' });
  assert.equal(root.status, 200);
  assert.equal(standalonePayload(root.body).project, null, 'root maps export without project context');
});

test('"project" is a reserved project slug (keeps /export/project/<slug> unambiguous)', async () => {
  const made = await api('POST', '/api/projects', { name: 'project' });
  assert.equal(made.status, 400);
  const created = await api('POST', '/api/maps', { name: 'X', project: 'project' });
  assert.equal(created.status, 400);
  const moved = await api('POST', '/api/maps/root-map/move', { project: 'project' });
  assert.equal(moved.status, 400);
});

test('map trash supports conflict-safe restore and permanent deletion', async () => {
  const originalPath = path.join(work, 'maps', 'root-map.yaml');
  const originalSource = readFileSync(originalPath, 'utf8');
  const removed = await api('DELETE', '/api/maps/root-map');
  assert.equal(removed.status, 200);
  const first = JSON.parse(removed.body).item;
  assert.equal(first.kind, 'map');
  assert.equal(first.originalId, 'root-map');
  assert.equal(first.name, 'Root Map');
  assert.ok(!existsSync(originalPath), 'map is gone from its live location');

  const listed = JSON.parse((await raw({ p: '/api/trash' })).body);
  assert.ok(listed.some((item) => item.id === first.id && item.deletedAt));

  writeFileSync(originalPath, 'name: Replacement\nnodes: []\nedges: []\n');
  const conflict = await api('POST', `/api/trash/${first.id}/restore`, {});
  assert.equal(conflict.status, 409);
  assert.equal(readFileSync(originalPath, 'utf8'), 'name: Replacement\nnodes: []\nedges: []\n');
  rmSync(originalPath);

  const restored = await api('POST', `/api/trash/${first.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).item.originalId, 'root-map');
  assert.equal(readFileSync(originalPath, 'utf8'), originalSource);
  assert.equal((await raw({ p: `/api/trash/${first.id}` })).status, 404);

  const removedAgain = JSON.parse((await api('DELETE', '/api/maps/root-map')).body).item;
  const deleted = await api('DELETE', `/api/trash/${removedAgain.id}`);
  assert.equal(deleted.status, 200);
  assert.ok(!existsSync(originalPath));
  assert.equal((await api('POST', `/api/trash/${removedAgain.id}/restore`, {})).status, 404);
});

test('nested .yml map returns to the same project path', async () => {
  const livePath = path.join(work, 'projects', 'atlas-logistics', 'legacy.yml');
  const source = readFileSync(livePath, 'utf8');
  const removed = await api('DELETE', '/api/maps/atlas-logistics/legacy');
  assert.equal(removed.status, 200);
  const item = JSON.parse(removed.body).item;
  assert.equal(item.originalId, 'atlas-logistics/legacy');
  assert.ok(!existsSync(livePath));

  const restored = await api('POST', `/api/trash/${item.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).item.originalId, 'atlas-logistics/legacy');
  assert.equal(readFileSync(livePath, 'utf8'), source);
  assert.ok(!existsSync(path.join(work, 'projects', 'atlas-logistics', 'legacy.yaml')));
});

test('project trash moves, restores, and permanently deletes the whole folder', async () => {
  const projectPath = path.join(work, 'projects', 'atlas-logistics');
  writeFileSync(path.join(projectPath, 'working-notes.txt'), 'not a map\n');
  const removed = await api('DELETE', '/api/projects/atlas-logistics');
  assert.equal(removed.status, 200);
  const first = JSON.parse(removed.body).item;
  assert.equal(first.kind, 'project');
  assert.equal(first.originalSlug, 'atlas-logistics');
  assert.equal(first.name, 'Atlas Logistics');
  assert.equal(first.mapCount, 3);
  assert.ok(!existsSync(projectPath));
  const mapsAfterDelete = JSON.parse((await raw({ p: '/api/maps' })).body);
  assert.ok(!mapsAfterDelete.some((map) => map.project?.slug === 'atlas-logistics'));

  const replacement = await api('POST', '/api/projects', { name: 'Atlas Logistics' });
  assert.equal(replacement.status, 201);
  const conflict = await api('POST', `/api/trash/${first.id}/restore`, {});
  assert.equal(conflict.status, 409);
  rmSync(projectPath, { recursive: true });

  const restored = await api('POST', `/api/trash/${first.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).item.originalSlug, 'atlas-logistics');
  assert.ok(existsSync(path.join(projectPath, 'order-flow.yaml')));
  assert.ok(existsSync(path.join(projectPath, 'flagged.yaml')));
  assert.ok(existsSync(path.join(projectPath, 'legacy.yml')));
  assert.equal(readFileSync(path.join(projectPath, 'working-notes.txt'), 'utf8'), 'not a map\n');

  const removedAgain = JSON.parse((await api('DELETE', '/api/projects/atlas-logistics')).body).item;
  const deleted = await api('DELETE', `/api/trash/${removedAgain.id}`);
  assert.equal(deleted.status, 200);
  assert.ok(!existsSync(projectPath));
  assert.ok(!JSON.parse((await raw({ p: '/api/trash' })).body).some((item) => item.id === removedAgain.id));
});

// --- etag / If-Match save-conflict contract ---------------------------------

test('GET etag: header matches the body field, on the movedTo branch too', async () => {
  const made = await api('POST', '/api/maps', { name: 'Etag Probe' });
  assert.equal(made.status, 201);

  const got = await raw({ p: '/api/maps/etag-probe' });
  assert.equal(got.status, 200);
  const body = JSON.parse(got.body);
  assert.match(body.etag, ETAG_RE);
  assert.equal(got.headers.etag, body.etag);

  const project = await api('POST', '/api/projects', { name: 'Etag Moves' });
  assert.equal(project.status, 201);
  const moved = await api('POST', '/api/maps/etag-probe/move', { project: 'etag-moves' });
  assert.equal(moved.status, 200);

  const old = await raw({ p: '/api/maps/etag-probe' });
  assert.equal(old.status, 200, 'old id still answers after the move');
  const oldBody = JSON.parse(old.body);
  assert.equal(oldBody.movedTo, 'etag-moves/etag-probe');
  assert.match(oldBody.etag, ETAG_RE);
  assert.equal(old.headers.etag, oldBody.etag, 'movedTo answers set header + body etag');
});

test('PUT honors If-Match: missing is 428, fresh saves, stale is 409', async () => {
  const made = await api('POST', '/api/maps', { name: 'Etag Save' });
  const { etag: first } = JSON.parse(made.body);

  // an existing file refuses a save that proves nothing about what it based on
  const source = 'name: Etag Save\nnodes:\n  - id: a\n    type: process\n    label: A\nedges: []\n';
  const missing = await api('PUT', '/api/maps/etag-save', { source });
  assert.equal(missing.status, 428);
  assert.deepEqual(JSON.parse(missing.body), { error: 'If-Match required', code: 'precondition' });

  // the correct etag saves and returns the etag of the file just written
  const ok = await api('PUT', '/api/maps/etag-save', { source }, { 'If-Match': first });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(ok.body);
  assert.equal(saved.ok, true);
  assert.match(saved.etag, ETAG_RE);
  assert.notEqual(saved.etag, first, 'a successful save returns a fresh etag');

  // the pre-save etag is now stale: conflict, and the disk keeps the good write
  const stale = await api('PUT', '/api/maps/etag-save', { source }, { 'If-Match': first });
  assert.equal(stale.status, 409);
  assert.deepEqual(JSON.parse(stale.body), { error: 'Map changed on disk', code: 'conflict' });
  assert.equal(readFileSync(path.join(work, 'maps', 'etag-save.yaml'), 'utf8'), source);
});

test('PUT to a new id creates the file without If-Match', async () => {
  const source = 'name: Created By Put\nnodes: []\nedges: []\n';
  const put = await api('PUT', '/api/maps/created-by-put', { source });
  assert.equal(put.status, 200);
  const body = JSON.parse(put.body);
  assert.equal(body.ok, true);
  assert.match(body.etag, ETAG_RE);
  assert.equal(readFileSync(path.join(work, 'maps', 'created-by-put.yaml'), 'utf8'), source);
});

test('POST creates the map atomically: the file exists and parses as a map', async () => {
  const res = await api('POST', '/api/maps', { name: 'Atomic Create' });
  assert.equal(res.status, 201);
  const file = path.join(work, 'maps', 'atomic-create.yaml');
  assert.ok(existsSync(file), 'map file written');
  const { model, errors } = parseMap(readFileSync(file, 'utf8'));
  assert.deepEqual(errors, [], 'the written file parses cleanly');
  assert.equal(model.name, 'Atomic Create');
  const leftovers = readdirSync(path.join(work, 'maps')).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'the atomic write leaves no .tmp- files behind');
});

test('POST /api/import with no provider configured is a 400 with code and hint', async () => {
  const cleanWork = mkdtempSync(path.join(os.tmpdir(), 'serigraph-noprovider-'));
  // every provider path closed: keys and overrides blanked, and a PATH where
  // the `claude` CLI probe finds nothing
  const { child, childPort } = boot({
    PORT: String(5060 + Math.floor(Math.random() * 100)),
    OPSMAP_ROOT: cleanWork,
    PATH: '/usr/bin:/bin',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    OPENAI_API_KEY: '',
    VENICE_API_KEY: '',
    OPSMAP_LLM_CMD: '',
    OPSMAP_MOCK_LLM: '',
    OPSMAP_LLM_PROVIDER: '',
  });
  try {
    const cleanPort = await childPort;
    const res = await raw({
      method: 'POST',
      p: '/api/import',
      onPort: cleanPort,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'When a customer checks out, the payment service clears the card first. '
          + 'Once payment clears, the warehouse team picks the order, packs it, and hands it to the carrier. '
          + 'If the card is declined, support reaches out to the customer before anything ships.',
      }),
    });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'llm-no-provider');
    assert.ok(body.error, 'carries an error message');
    assert.match(body.hint, /ANTHROPIC_API_KEY/);
    assert.match(body.hint, /claude CLI/);
    assert.match(body.hint, /OPSMAP_LLM_CMD/);
  } finally {
    child.kill();
    rmSync(cleanWork, { recursive: true, force: true });
  }
});
