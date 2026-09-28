// Project API tests: boot the real server against a temp workspace
// (SERIGRAPH_LIBRARY_DIR) and exercise project create/list, path-based map ids, and
// moves between the root and a project. The temp workspace starts empty, so
// booting here also proves the watcher survives a missing projects/ dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';
import { createLocalLinks } from '../server/local-links.js';

// etags are "<size>-<mtimeMs>-<contentHash>" — mtimeMs keeps sub-millisecond
// decimals and the hash separates same-size writes within one tick
const ETAG_RE = /^\d+-\d+(\.\d+)?-[A-Za-z0-9_-]+$/;

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
  const started = boot({ PORT: String(4960 + Math.floor(Math.random() * 100)),
    OPSMAP_ROOT: ROOT, OPSMAP_MAPS_DIR: '', OPSMAP_ENV_FILE: '', OPSMAP_SKIP_DOTENV: '1',
    SERIGRAPH_LIBRARY_DIR: work, SERIGRAPH_PREFERENCES_FILE: path.join(work, 'preferences', 'install.json') });
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

test('external library uses application assets and keeps settings private', async () => {
  const page = await raw({ p: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(existsSync(path.join(work, 'app')), false, 'no copied application required');
  const settings = await api('POST', '/api/settings', { model: 'synthetic-test-model' });
  assert.equal(settings.status, 200);
  assert.match(readFileSync(path.join(work, '.env'), 'utf8'), /synthetic-test-model/);
  assert.equal((await raw({ p: '/.env' })).status, 404);
});

test('stale library requests cannot read, save, or publish after a workspace switch', async () => {
  const current = await raw({p: '/api/maps'});
  assert.match(current.headers['x-serigraph-library'], /^[a-f0-9]{64}$/);
  const headers = {'X-Serigraph-Library': 'different-library'};
  assert.equal((await raw({p: '/api/maps', headers})).status, 412);
  assert.equal((await api('POST', '/api/maps', {name: 'Wrong workspace'}, headers)).status, 412);
  assert.equal((await api('POST', '/api/workbench/push', {}, headers)).status, 412);
  assert.equal(existsSync(path.join(work, 'maps', 'wrong-workspace.yaml')), false);
});

test('external project watcher emits the full project/map identity', async () => {
  await api('POST', '/api/maps', { name: 'Watched', project: 'watch-project' });
  const file = path.join(work, 'projects', 'watch-project', 'watched.yaml');
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events' });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('No project change event')); }, 5000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.on('response', res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk;
        if (text.includes('watch-project/watched')) {
          clearTimeout(timer);
          req.destroy();
          resolve();
        }
      });
      writeFileSync(file, readFileSync(file, 'utf8') + '\n# External editor change\n');
    });
    req.end();
  });
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

test('local links save originals, reject stale edits, refresh externally, and remove references without deleting', async () => {
  const source = 'name: Original Synthetic Map\nnodes: [{id: start, type: process, label: Start}]\n';
  const originals = path.join(work, 'linked-originals');
  mkdirSync(originals);
  const file = path.join(originals, 'Original flow.yaml');
  writeFileSync(file, source);
  const status = await raw({p: '/api/local-links'}), info = JSON.parse(status.body);
  assert.equal(info.enabled, true);
  const headers = {Origin: `http://127.0.0.1:${port}`, 'X-Serigraph-Library': status.headers['x-serigraph-library'],
    'X-Serigraph-Links-Token': info.token};
  const action = (name, body, overrides = {}) => api('POST', `/api/local-links/${name}`, body, {...headers, ...overrides});
  assert.equal((await api('POST', '/api/local-links/preview', {path: file})).status, 403);
  assert.equal((await action('preview', {path: file}, {Origin: 'https://untrusted.example'})).status, 403);
  assert.equal((await action('preview', {path: file}, {'X-Serigraph-Library': 'stale'})).status, 412);
  const preview = JSON.parse((await action('preview', {path: file})).body);
  assert.equal(preview.mapCount, 1);
  assert.equal((await action('add', {nonce: preview.nonce, editOriginals: false})).status, 409);
  const added = await action('add', {nonce: preview.nonce, editOriginals: true});
  assert.equal(added.status, 201, added.body);
  const {id} = JSON.parse(added.body), mapId = `${id}/map`, url = `/api/maps/${mapId}`;
  assert.equal(existsSync(path.join(work, 'projects', id)), false, 'no copied project directory');
  assert.equal(existsSync(path.join(work, '.serigraph', 'links', `${id}.json`)), true, 'the link travels with the library');
  const project = JSON.parse((await raw({p: '/api/projects'})).body).find(p => p.slug === id);
  assert.equal(project.linked, true); assert.equal(project.location, realpathSync(file)); assert.equal(project.maps, undefined);
  const map = JSON.parse((await raw({p: url})).body);
  assert.equal(map.source, source);
  assert.equal((await api('PUT', url, {source: source + '# From Serigraph\n'}, {'If-Match': map.etag})).status, 200);
  assert.equal(readFileSync(file, 'utf8'), source + '# From Serigraph\n');
  assert.equal((await api('PUT', url, {source}, {'If-Match': map.etag})).status, 409);
  assert.equal((await api('DELETE', url)).status, 409);
  assert.equal((await api('POST', url + '/move', {project: null})).status, 409);
  assert.equal((await api('DELETE', `/api/projects/${id}`)).status, 409);
  assert.equal((await api('POST', '/api/maps', {name: 'New', project: id})).status, 409);
  const exported = await raw({p: `/export/${mapId}.html`});
  assert.equal(exported.status, 200);
  assert.ok(exported.body.includes('opsmap/app/library-links.js'), 'standalone import map contains the new module');
  await new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path: '/api/events'});
    const timer = setTimeout(() => {req.destroy(); reject(new Error('No linked-file change event'));}, 5000);
    req.on('error', error => {clearTimeout(timer); reject(error);});
    req.on('response', res => {
      let events = '';
      res.on('data', chunk => {
        events += chunk;
        if (events.includes(mapId)) {clearTimeout(timer); req.destroy(); resolve();}
      });
      writeFileSync(file, source + '# External change\n');
    });
    req.end();
  });
  assert.equal(JSON.parse((await raw({p: url})).body).source, source + '# External change\n');
  assert.equal((await action('remove', {id})).status, 200);
  assert.equal(readFileSync(file, 'utf8'), source + '# External change\n');
  assert.equal((await raw({p: url})).status, 404);
  assert.equal((await api('PUT', url, {source})).status, 404);
  assert.equal(existsSync(path.join(work, 'projects', id)), false, 'removed links never fall back into the base library');
});

test('linked folders and file parents reconnect their watchers after being unavailable at startup or replaced', async () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'serigraph-link-reconnect-')));
  const library = path.join(temp, 'library'), preferences = path.join(temp, 'preferences.json');
  mkdirSync(library);
  const links = createLocalLinks({engineRoot: ROOT, registryDir: path.join(library, '.serigraph', 'links')});
  const source = 'name: Reconnected Synthetic Map\nnodes: []\n';
  const originals = [];
  let child;
  try {
    for (const kind of ['file', 'folder']) {
      const directory = path.join(temp, kind), file = path.join(directory, 'flow.yaml');
      mkdirSync(directory); writeFileSync(file, source);
      const {id} = await links.add(await links.preview(kind === 'file' ? file : directory));
      originals.push({directory, file, mapId: `${id}/${kind === 'file' ? 'map' : 'flow'}`});
      renameSync(directory, directory + '-offline');
    }
    const started = boot({PORT: String(port + 120), OPSMAP_ROOT: ROOT, OPSMAP_MAPS_DIR: '', OPSMAP_ENV_FILE: '', OPSMAP_SKIP_DOTENV: '1',
      SERIGRAPH_LIBRARY_DIR: library, SERIGRAPH_PREFERENCES_FILE: preferences});
    child = started.child;
    const onPort = await started.childPort;
    assert.ok(JSON.parse((await raw({p: '/api/projects', onPort})).body).every(project => project.unavailable));
    const expectChange = ({file, mapId}, label) => new Promise((resolve, reject) => {
      const req = request({host: '127.0.0.1', port: onPort, path: '/api/events'});
      const timer = setTimeout(() => {req.destroy(); reject(new Error(`No reconnected change event: ${label}`));}, 5000);
      req.on('error', error => {clearTimeout(timer); reject(error);});
      req.on('response', res => {
        let events = '';
        res.on('data', chunk => {
          events += chunk;
          if (events.includes(mapId)) {clearTimeout(timer); req.destroy(); resolve();}
        });
        writeFileSync(file, source + `# ${label}\n`);
      });
      req.end();
    });
    for (const original of originals) renameSync(original.directory + '-offline', original.directory);
    const maps = JSON.parse((await raw({p: '/api/maps', onPort})).body);
    assert.deepEqual(maps.map(map => map.id).sort(), originals.map(item => item.mapId).sort());
    for (const original of originals) {
      await expectChange(original, 'Returned drive');
      renameSync(original.directory, original.directory + '-old');
      mkdirSync(original.directory); writeFileSync(original.file, source);
      await raw({p: '/api/projects', onPort});
      await expectChange(original, 'Replaced folder');
    }
  } finally {child?.kill(); rmSync(temp, {recursive: true, force: true});}
});

test('opening a file links it in one step, reuses the link, and records it in Recent', async () => {
  const originals = path.join(work, 'opened-originals');
  mkdirSync(originals);
  const file = path.join(originals, 'Opened flow.yaml');
  writeFileSync(file, 'name: Opened Synthetic Map\nnodes: [{id: start, type: process, label: Start}]\n');
  const status = await raw({p: '/api/local-links'}), info = JSON.parse(status.body);
  const headers = {Origin: `http://127.0.0.1:${port}`, 'X-Serigraph-Library': status.headers['x-serigraph-library'],
    'X-Serigraph-Links-Token': info.token};
  assert.equal((await api('POST', '/api/local-links/open', {path: file})).status, 403, 'opening needs the local token');
  const first = await api('POST', '/api/local-links/open', {path: file}, headers);
  assert.equal(first.status, 201, first.body);
  const opened = JSON.parse(first.body);
  assert.equal(opened.kind, 'file');
  assert.equal(opened.mapId, `${opened.id}/map`);
  assert.equal(opened.name, 'Opened Synthetic Map');
  const again = JSON.parse((await api('POST', '/api/local-links/open', {path: file}, headers)).body);
  assert.equal(again.id, opened.id);
  assert.equal(again.existing, true);
  const recents = JSON.parse((await raw({p: '/api/recents'})).body);
  assert.equal(recents.items[0].id, opened.mapId);
  assert.equal(recents.items[0].machine, recents.machine);
  assert.equal((await api('POST', '/api/recents', {id: '../escape'})).status, 400);
  assert.equal((await api('POST', '/api/recents', {id: 'some-map'})).status, 200);
  assert.equal(JSON.parse((await raw({p: '/api/recents'})).body).items[0].id, 'some-map');
  await api('POST', '/api/local-links/remove', {id: opened.id}, headers);
});

test('a listed proxy host is served as shared access without local-only actions', async () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'serigraph-proxy-host-')));
  let child;
  try {
    const started = boot({PORT: String(port + 140), OPSMAP_ROOT: ROOT, OPSMAP_MAPS_DIR: '', OPSMAP_ENV_FILE: '', OPSMAP_SKIP_DOTENV: '1',
      SERIGRAPH_LIBRARY_DIR: temp, SERIGRAPH_PREFERENCES_FILE: path.join(temp, 'preferences.json'),
      SERIGRAPH_ALLOWED_HOSTS: 'graph.example.test'});
    child = started.child;
    const onPort = await started.childPort;
    assert.equal((await raw({p: '/api/maps', onPort, headers: {Host: 'graph.example.test'}})).status, 200);
    assert.equal((await raw({p: '/api/maps', onPort, headers: {Host: 'graph.example.test:443'}})).status, 200);
    assert.equal((await raw({p: '/api/maps', onPort, headers: {Host: 'attacker.example.test'}})).status, 403);
    assert.equal(JSON.parse((await raw({p: '/api/local-links', onPort})).body).enabled, false);
    assert.equal(JSON.parse((await raw({p: '/api/updates', onPort})).body).status, 'disabled');
  } finally {
    child?.kill();
    rmSync(temp, {recursive: true, force: true});
  }
});

test('shared systems live in the library file and report which maps use them', async () => {
  assert.deepEqual(JSON.parse((await raw({p: '/api/systems'})).body).items, []);
  const saved = JSON.parse((await api('PUT', '/api/systems', {label: 'Snowflake', type: 'database', description: 'Warehouse'})).body);
  assert.equal(saved.id, 'snowflake');
  const second = JSON.parse((await api('PUT', '/api/systems', {label: 'Snowflake', type: 'database'})).body);
  assert.equal(second.id, 'snowflake-2', 'a new entry with a taken name gets its own id');
  assert.equal((await api('PUT', '/api/systems', {id: 'snowflake', label: 'Snowflake', type: 'database', description: 'Cloud warehouse'})).status, 200);
  mkdirSync(path.join(work, 'maps'), {recursive: true});
  writeFileSync(path.join(work, 'maps', 'uses-snowflake.yaml'), 'name: Uses Snowflake\nnodes:\n  - id: wh\n    type: database\n    label: Snowflake\n    library: snowflake\n');
  const listed = JSON.parse((await raw({p: '/api/systems'})).body).items;
  const snowflake = listed.find((system) => system.id === 'snowflake');
  assert.equal(snowflake.description, 'Cloud warehouse');
  assert.deepEqual(snowflake.uses.map((use) => [use.mapId, use.nodeId, use.mapName]), [['uses-snowflake', 'wh', 'Uses Snowflake']]);
  assert.match(readFileSync(path.join(work, 'systems.yaml'), 'utf8'), /^# Systems and tools shared/);
  assert.equal((await api('DELETE', '/api/systems/snowflake-2')).status, 200);
  assert.deepEqual(JSON.parse((await raw({p: '/api/systems'})).body).items.map((system) => system.id), ['snowflake']);
  assert.equal((await api('PUT', '/api/systems', {label: '  '})).status, 400);
  assert.equal((await api('DELETE', '/api/systems/missing')).status, 400);
});

test('a save based on an older version combines with a newer one when they touch different lines', async () => {
  const base = 'name: Merge Synthetic\nnodes:\n  - id: a\n    type: process\n    label: Alpha\n  - id: b\n    type: process\n    label: Beta\n';
  mkdirSync(path.join(work, 'maps'), {recursive: true});
  writeFileSync(path.join(work, 'maps', 'merge-synthetic.yaml'), base);
  const opened = JSON.parse((await raw({p: '/api/maps/merge-synthetic'})).body);
  // Someone else's newer version arrives through the shared folder.
  const theirs = base.replace('label: Beta', 'label: Beta from a colleague');
  writeFileSync(path.join(work, 'maps', 'merge-synthetic.yaml'), theirs);
  const mine = base.replace('label: Alpha', 'label: Alpha from me');
  const combined = await api('PUT', '/api/maps/merge-synthetic', {source: mine, base}, {'If-Match': opened.etag});
  assert.equal(combined.status, 200, combined.body);
  const result = JSON.parse(combined.body);
  assert.equal(result.merged, true);
  assert.match(result.source, /Alpha from me/);
  assert.match(result.source, /Beta from a colleague/);
  assert.equal(readFileSync(path.join(work, 'maps', 'merge-synthetic.yaml'), 'utf8'), result.source);
  // The same line changed on both sides, or no starting version: a person chooses.
  const clash = await api('PUT', '/api/maps/merge-synthetic', {source: mine.replace('label: Beta', 'label: Beta from me'), base: mine}, {'If-Match': opened.etag});
  assert.equal(clash.status, 409);
  assert.equal((await api('PUT', '/api/maps/merge-synthetic', {source: mine}, {'If-Match': opened.etag})).status, 409);
});
