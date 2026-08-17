// Serigraph server — zero npm dependencies, Node built-ins only.
// Serves the app, reads/writes map files, pushes file changes to the
// browser over SSE, and builds standalone HTML exports.
import { createServer } from 'node:http';
import { promises as fs, watch, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap, MAP_MODES } from '../shared/model.js';
import { parseProjectIndex, PROJECT_INDEX_FILE } from '../shared/projects.js';
import { collectProvenance } from '../shared/provenance.js';
import { buildExport } from './export.js';
import { callLLM, resolveProvider, callTranscription } from './llm.js';
import { importTranscript, ImportError } from './importer.js';
import { chatEdit, ChatError } from './chat.js';
import { readSettings, writeSettings } from './settings.js';
import {
  WorkbenchError,
  createWorkbenchShare,
  inspectWorkbench,
  pushWorkbench,
  watchWorkbench,
} from './workbench-sync.js';

// overridable so tests can boot the server against a temp workspace
const ROOT = process.env.OPSMAP_ROOT
  ? path.resolve(process.env.OPSMAP_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// .env next to the repo root carries secrets like ANTHROPIC_API_KEY — this is
// how the double-clicked Mac app picks them up, since it launches without a
// shell. Real environment variables always win; the file only fills gaps.
try {
  const envFile = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
} catch { /* no .env — fine */ }

const MAPS_DIR = path.join(ROOT, 'maps');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const TRASH_DIR = path.join(ROOT, '.serigraph-trash');
const DEFAULT_PORT = Number(process.env.PORT) || 4700;
const NO_OPEN = process.argv.includes('--no-open') || process.env.OPSMAP_NO_OPEN === '1';
// maps hold confidential client operations data: serve localhost-only unless
// the user explicitly opts into LAN exposure with --lan (or OPSMAP_LAN=1)
const LAN = process.argv.includes('--lan') || process.env.OPSMAP_LAN === '1';
const BIND_HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// map ids are path-based: "<project>/<map>" for project maps — one slash, no ".."
const ID_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;
const safeSlug = (slug) => typeof slug === 'string' && slug.length < 200 && SLUG_RE.test(slug) && !slug.includes('..');
const safeId = (id) => typeof id === 'string' && id.length < 200 && ID_RE.test(id) && !id.includes('..');
const TRASH_ID_RE = /^(map|project)-[a-z0-9-]+$/;
const safeTrashId = (id) => typeof id === 'string' && id.length < 240 && TRASH_ID_RE.test(id);
let trashCounter = 0;

class TrashError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const hashOf = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

async function listDir(dir) {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch { return []; }
}

// a project's index file is never a map
const PROJECT_INDEX_RE = /^projects\.ya?ml$/;
// "<project>/projects" names the index, so it is reserved as a map id
const isProjectIndexId = (id) => id.includes('/') && id.slice(id.indexOf('/') + 1) === 'projects';

// any edge in any scope carrying an "issue:" note
function hasIssueEdges(model) {
  const scopes = [model.root];
  for (const node of model.byId.values()) if (node.children) scopes.push(node.children);
  return scopes.some((scope) => scope.edges.some((e) => e.issue));
}

async function mapSummaries(dir, project = null) {
  const out = [];
  for (const file of await listDir(dir)) {
    if (project && PROJECT_INDEX_RE.test(file)) continue; // the index is not a map
    const base = file.replace(/\.ya?ml$/, '');
    const id = project ? `${project.slug}/${base}` : base;
    try {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      const { doc, model, errors } = parseMap(source);
      // flags are comments, so they show up even in a map that fails to parse
      let hasFlags = false;
      try {
        const provenance = collectProvenance(doc);
        hasFlags = provenance.nodes.size > 0 || provenance.edges.length > 0;
      } catch { /* a broken doc just means no flags */ }
      if (model) {
        out.push({ id, file, name: model.name, description: model.description, nodeCount: model.nodeCount, kind: model.document.kind, mode: model.mode, project, hasFlags, hasIssues: hasIssueEdges(model) });
      } else {
        out.push({ id, file, name: id, description: '', nodeCount: 0, invalid: true, errorCount: errors.length, project, hasFlags, hasIssues: false });
      }
    } catch (e) {
      out.push({ id, file, name: id, description: '', nodeCount: 0, invalid: true, errorCount: 1, project, hasFlags: false, hasIssues: false });
    }
  }
  return out;
}

// path-based ids: "<project>/<map>" resolves under projects/, a bare id under
// maps/. safeId has already run, so the segments are clean and the result can
// never escape the two roots.
function mapPathFor(id) {
  const slash = id.indexOf('/');
  return slash === -1
    ? path.join(MAPS_DIR, id + '.yaml')
    : path.join(PROJECTS_DIR, id.slice(0, slash), id.slice(slash + 1) + '.yaml');
}

async function resolveMapPath(id) {
  const slash = id.indexOf('/');
  const dir = slash === -1 ? MAPS_DIR : path.join(PROJECTS_DIR, id.slice(0, slash));
  const base = slash === -1 ? id : id.slice(slash + 1);
  for (const ext of ['.yaml', '.yml']) {
    const p = path.join(dir, base + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

// parsed index for one project folder; empty defaults when absent/unreadable
async function readProjectIndex(dir) {
  try {
    const { name, description, order, tags } = parseProjectIndex(await fs.readFile(path.join(dir, PROJECT_INDEX_FILE), 'utf8'));
    return { name, description, order, tags };
  } catch {
    return { name: null, description: null, order: [], tags: {} };
  }
}

// every immediate subdirectory of projects/ is a project, even an empty one
async function projectIndex() {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch { return []; } // no projects/ yet — zero projects
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeSlug(entry.name)) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    const index = await readProjectIndex(dir);
    let mapCount = 0;
    for (const file of await listDir(dir)) if (!PROJECT_INDEX_RE.test(file)) mapCount++;
    out.push({
      slug: entry.name,
      name: index.name ?? entry.name,
      description: index.description,
      order: index.order,
      tags: index.tags,
      mapCount,
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// in-memory move log, old id -> new id: an open tab asking for the old id
// gets the map back with a movedTo pointer instead of an error
const movedFrom = new Map();

function followMoves(id) {
  const seen = new Set([id]);
  let cur = id;
  // a cycle (a moved away, its old id reused, then moved back) is stale —
  // stop at the last fresh id instead of looping
  while (movedFrom.has(cur) && !seen.has(movedFrom.get(cur))) {
    cur = movedFrom.get(cur);
    seen.add(cur);
  }
  return cur === id ? null : cur;
}

// the project context embedded in a standalone export: the project itself
// plus a summary of every map in it
async function projectMetaFor(slug) {
  const index = await readProjectIndex(path.join(PROJECTS_DIR, slug));
  const name = index.name ?? slug;
  return { index, slug, name, maps: await mapSummaries(path.join(PROJECTS_DIR, slug), { slug, name }) };
}

function nextTrashId(kind) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').toLowerCase();
  const sequence = (trashCounter++).toString(36);
  return `${kind}-${stamp}-${process.pid.toString(36)}-${sequence}`;
}

function trashEntryPath(id) {
  return path.join(TRASH_DIR, id);
}

function validTrashMetadata(metadata, id) {
  if (!metadata || metadata.id !== id || !['map', 'project'].includes(metadata.kind)) return false;
  if (typeof metadata.name !== 'string' || typeof metadata.deletedAt !== 'string') return false;
  if (metadata.kind === 'map') {
    return safeId(metadata.originalId) && ['.yaml', '.yml'].includes(metadata.extension);
  }
  return safeSlug(metadata.originalSlug);
}

async function readTrashEntry(id) {
  if (!safeTrashId(id)) throw new TrashError(400, 'invalid trash id');
  const entry = trashEntryPath(id);
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(entry, 'entry.json'), 'utf8'));
    if (!validTrashMetadata(metadata, id) || !existsSync(path.join(entry, 'payload'))) throw new Error('invalid entry');
    return { entry, payload: path.join(entry, 'payload'), metadata };
  } catch {
    throw new TrashError(404, `no trash item "${id}"`);
  }
}

async function listTrash() {
  let entries;
  try { entries = await fs.readdir(TRASH_DIR, { withFileTypes: true }); }
  catch { return []; }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeTrashId(entry.name)) continue;
    try {
      const item = await readTrashEntry(entry.name);
      items.push(item.metadata);
    } catch { /* skip incomplete or manually damaged entries */ }
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function moveIntoTrash(source, metadata) {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  const destination = trashEntryPath(metadata.id);
  const pending = path.join(TRASH_DIR, `.${metadata.id}.tmp`);
  await fs.mkdir(pending);
  let moved = false;
  try {
    await fs.writeFile(path.join(pending, 'entry.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await fs.rename(source, path.join(pending, 'payload'));
    moved = true;
    await fs.rename(pending, destination);
    return metadata;
  } catch (error) {
    let safeToClean = !moved;
    if (moved) {
      try {
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.rename(path.join(pending, 'payload'), source);
        safeToClean = true;
      } catch { /* keep the payload in the pending trash folder */ }
    }
    if (safeToClean) {
      try { await fs.rm(pending, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw error;
  }
}

async function trashMap(id, file) {
  let name = id;
  try {
    const { model } = parseMap(await fs.readFile(file, 'utf8'));
    if (model?.name) name = model.name;
  } catch { /* preserve invalid maps too */ }
  const metadata = {
    id: nextTrashId('map'),
    kind: 'map',
    name,
    originalId: id,
    extension: path.extname(file),
    deletedAt: new Date().toISOString(),
    mapCount: 1,
  };
  const item = await moveIntoTrash(file, metadata);
  fileHashes.delete(file);
  return item;
}

async function trashProject(slug) {
  const source = path.join(PROJECTS_DIR, slug);
  const index = await readProjectIndex(source);
  let mapCount = 0;
  for (const file of await listDir(source)) {
    if (/\.ya?ml$/.test(file) && !PROJECT_INDEX_RE.test(file)) mapCount++;
  }
  const metadata = {
    id: nextTrashId('project'),
    kind: 'project',
    name: index.name ?? slug,
    originalSlug: slug,
    deletedAt: new Date().toISOString(),
    mapCount,
  };
  unwatchProjectDir(slug);
  try {
    const item = await moveIntoTrash(source, metadata);
    for (const file of fileHashes.keys()) {
      if (file.startsWith(source + path.sep)) fileHashes.delete(file);
    }
    return item;
  } catch (error) {
    watchProjectDir(slug);
    throw error;
  }
}

function restoredMapPath(metadata) {
  const slash = metadata.originalId.indexOf('/');
  const dir = slash === -1
    ? MAPS_DIR
    : path.join(PROJECTS_DIR, metadata.originalId.slice(0, slash));
  const base = slash === -1 ? metadata.originalId : metadata.originalId.slice(slash + 1);
  return path.join(dir, base + metadata.extension);
}

async function restoreTrashItem(id) {
  const { entry, payload, metadata } = await readTrashEntry(id);
  let target;
  if (metadata.kind === 'map') {
    if (await resolveMapPath(metadata.originalId)) {
      throw new TrashError(409, `a map named "${metadata.originalId}" already exists`);
    }
    if (metadata.originalId.includes('/')) {
      const project = metadata.originalId.slice(0, metadata.originalId.indexOf('/'));
      if (!existsSync(path.join(PROJECTS_DIR, project))) {
        throw new TrashError(409, `restore project "${project}" before restoring this map`);
      }
    } else {
      await fs.mkdir(MAPS_DIR, { recursive: true });
    }
    target = restoredMapPath(metadata);
  } else {
    target = path.join(PROJECTS_DIR, metadata.originalSlug);
    if (existsSync(target)) {
      throw new TrashError(409, `a project named "${metadata.originalSlug}" already exists`);
    }
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
  }
  await fs.rename(payload, target);
  await fs.rm(entry, { recursive: true, force: true });
  if (metadata.kind === 'project') watchProjectDir(metadata.originalSlug);
  return metadata;
}

async function permanentlyDeleteTrashItem(id) {
  const { entry, metadata } = await readTrashEntry(id);
  await fs.rm(entry, { recursive: true, force: false });
  return metadata;
}

// ---------------------------------------------------------------- SSE
const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

const fileHashes = new Map();
let pendingChanges = new Set();
let changeTimer = null;

async function primeHashes() {
  const dirs = [MAPS_DIR];
  for (const project of await projectIndex()) dirs.push(path.join(PROJECTS_DIR, project.slug));
  for (const dir of dirs) {
    for (const file of await listDir(dir)) {
      try {
        const p = path.join(dir, file);
        fileHashes.set(p, hashOf(await fs.readFile(p, 'utf8')));
      } catch { /* ignore */ }
    }
  }
}

function watchDir(dir, onChange) {
  if (!existsSync(dir)) return null;
  let watcher;
  try {
    watcher = watch(dir, (eventType, filename) => {
      if (filename && /\.ya?ml$/.test(filename)) onChange(filename);
    });
  } catch { return null; } // fs.watch unsupported - live reload degrades gracefully
  // watcher errors arrive asynchronously and must never take the server down
  watcher.on('error', (e) => {
    console.warn(`[serigraph] file watcher for ${path.basename(dir)} stopped (${e.code ?? e.message}); live reload off, server unaffected`);
    try { watcher.close(); } catch { /* already closed */ }
  });
  return watcher;
}

// Project folders come and go at runtime. Keep their watchers addressable so
// moving a project to Trash does not leave a watcher attached to the payload.
const watchedProjects = new Map();
function watchProjectDir(slug) {
  if (watchedProjects.has(slug)) return;
  const dir = path.join(PROJECTS_DIR, slug);
  const watcher = watchDir(dir, (filename) => scheduleMapChange(dir, filename));
  if (watcher) watchedProjects.set(slug, watcher);
}

function unwatchProjectDir(slug) {
  const watcher = watchedProjects.get(slug);
  if (watcher) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  watchedProjects.delete(slug);
}

// create projects/<slug>/ and a minimal index when either is missing, and
// make sure the file watcher covers the folder
async function ensureProject(slug, name = slug) {
  const dir = path.join(PROJECTS_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, PROJECT_INDEX_FILE))) {
    await fs.writeFile(path.join(dir, PROJECT_INDEX_FILE), `# ${name} project\nname: ${JSON.stringify(name)}\n`, 'utf8');
  }
  watchProjectDir(slug);
}

function scheduleMapChange(dir, filename) {
  pendingChanges.add(path.join(dir, filename));
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    const changed = [];
    for (const p of pendingChanges) {
      let h = null;
      try { h = hashOf(await fs.readFile(p, 'utf8')); } catch { /* deleted */ }
      if (fileHashes.get(p) !== h) {
        if (h === null) fileHashes.delete(p); else fileHashes.set(p, h);
        changed.push(idForPath(p));
      }
    }
    pendingChanges = new Set();
    if (changed.length) broadcast({ type: 'maps-changed', ids: changed });
  }, 120);
}

// the id the app knows a changed file by: the bare map id for root maps,
// "<project>/<map>" for project maps, "<project>/projects.yaml" for an index
function idForPath(p) {
  const parts = path.relative(ROOT, p).split(path.sep);
  if (parts[0] === 'projects' && parts.length === 3) {
    const base = parts[2].replace(/\.ya?ml$/, '');
    return base === 'projects' ? `${parts[1]}/${parts[2]}` : `${parts[1]}/${base}`;
  }
  return path.basename(p).replace(/\.ya?ml$/, '');
}

// ---------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  // requiring JSON makes every write a CORS-preflighted request, so a hostile
  // web page in the same browser can't POST/PUT here as a "simple request"
  if ((req.method === 'POST' || req.method === 'PUT')
    && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return json(res, 415, { error: 'Content-Type must be application/json' });
  }
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'workbench' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      if (parts[2] === 'inspect' && parts.length === 3) {
        return json(res, 200, await inspectWorkbench(body?.url));
      }
      if (parts[2] === 'push' && parts.length === 3) {
        if (typeof body?.source !== 'string') return json(res, 400, { error: 'body must include source' });
        const result = await pushWorkbench(body?.url, body.source, {
          baseVersion: body.baseVersion ?? null,
          baseSource: typeof body.baseSource === 'string' ? body.baseSource : null,
        });
        return json(res, 200, result);
      }
      if (parts[2] === 'share' && parts.length === 3) {
        return json(res, 200, await createWorkbenchShare(body?.url, body?.role));
      }
      if (parts[2] === 'events' && parts.length === 3) {
        return json(res, 200, await watchWorkbench(body?.url, body?.since ?? 'latest'));
      }
    } catch (e) {
      if (!(e instanceof WorkbenchError)) throw e;
      return json(res, e.status, {
        error: e.message,
        ...(e.currentVersion ? { currentVersion: e.currentVersion } : {}),
        ...(Object.prototype.hasOwnProperty.call(e, 'remoteSource')
          ? { remoteSource: e.remoteSource, remoteMissing: e.remoteSource === null }
          : {}),
        ...(e.errors?.length ? { errors: e.errors } : {}),
      });
    }
  }

  if (parts[1] === 'trash') {
    if (parts.length === 2 && req.method === 'GET') return json(res, 200, await listTrash());
    if (parts.length >= 3) {
      const id = decodeURIComponent(parts[2]);
      if (!safeTrashId(id)) return json(res, 400, { error: 'invalid trash id' });
      try {
        if (parts.length === 4 && parts[3] === 'restore' && req.method === 'POST') {
          const item = await restoreTrashItem(id);
          broadcast({ type: 'library-changed' });
          return json(res, 200, { item });
        }
        if (parts.length === 3 && req.method === 'DELETE') {
          const item = await permanentlyDeleteTrashItem(id);
          broadcast({ type: 'library-changed' });
          return json(res, 200, { item });
        }
      } catch (error) {
        if (error instanceof TrashError) return json(res, error.status, { error: error.message });
        throw error;
      }
    }
  }


  if (parts[1] === 'maps' && parts.length === 2) {
    if (req.method === 'GET') {
      const projects = await projectIndex();
      const nested = await Promise.all(projects.map((p) => mapSummaries(path.join(PROJECTS_DIR, p.slug), { slug: p.slug, name: p.name })));
      return json(res, 200, [...await mapSummaries(MAPS_DIR), ...nested.flat()]);
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const name = String(body.name || '').trim();
      const mode = body.mode == null ? 'process' : String(body.mode);
      const project = body.project == null ? null : String(body.project).trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      if (!MAP_MODES.includes(mode)) return json(res, 400, { error: `mode must be one of: ${MAP_MODES.join(', ')}` });
      if (project !== null && !safeSlug(project)) return json(res, 400, { error: 'invalid project slug' });
      if (project === 'project') return json(res, 400, { error: '"project" is a reserved project slug' });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
      if (project && slug === 'projects') return json(res, 400, { error: '"projects" is a reserved name inside a project' });
      const id = project ? `${project}/${slug}` : slug;
      if (await resolveMapPath(id)) return json(res, 409, { error: `a map named "${id}" already exists` });
      const modeLine = mode === 'freeform' ? 'mode: freeform\n' : '';
      const elements = mode === 'freeform' ? '\nelements: []\n' : '';
      const purpose = mode === 'freeform' ? 'map' : 'operations map';
      const source = `# ${name} - ${purpose}\nname: ${JSON.stringify(name)}\n${modeLine}description: ""\n${elements}\nnodes: []\n\nedges: []\n`;
      if (project) await ensureProject(project); else await fs.mkdir(MAPS_DIR, { recursive: true });
      await fs.writeFile(mapPathFor(id), source, 'utf8');
      // fileHashes deliberately NOT updated here: the watcher must see the
      // change and broadcast it so other tabs pick the new map up
      return json(res, 201, { id, project });
    }
  }

  // /api/maps/<id> — ids are path-based ("<project>/<map>" spans two path
  // segments), and POST …/move moves a map between the root and a project
  if (parts[1] === 'maps' && parts.length >= 3) {
    const isMove = req.method === 'POST' && parts.length >= 4 && parts[parts.length - 1] === 'move';
    const idParts = isMove ? parts.slice(2, -1) : parts.slice(2);
    if (idParts.length > 2) return json(res, 400, { error: 'invalid map id' });
    const id = idParts.map((p) => decodeURIComponent(p)).join('/');
    if (!safeId(id)) return json(res, 400, { error: 'invalid map id' });
    if (isProjectIndexId(id)) return json(res, 400, { error: `"${id}" is the project index, not a map` });
    const file = await resolveMapPath(id);

    if (isMove) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const project = body?.project == null ? null : String(body.project).trim();
      if (project !== null && !safeSlug(project)) return json(res, 400, { error: 'invalid project slug' });
      if (project === 'project') return json(res, 400, { error: '"project" is a reserved project slug' });
      if (!file) return json(res, 404, { error: `no map "${id}" (looked for ${path.relative(ROOT, mapPathFor(id))})` });
      const fromProject = id.includes('/') ? id.slice(0, id.indexOf('/')) : null;
      const mapSlug = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
      if (project === fromProject) {
        return json(res, 400, { error: `"${id}" is already ${project ? `in project "${project}"` : 'at the root'}` });
      }
      if (project && mapSlug === 'projects') return json(res, 400, { error: '"projects" is a reserved name inside a project' });
      const newId = project ? `${project}/${mapSlug}` : mapSlug;
      if (await resolveMapPath(newId)) return json(res, 409, { error: `a map named "${newId}" already exists` });
      if (project) await ensureProject(project); else await fs.mkdir(MAPS_DIR, { recursive: true });
      // rename(2) keeps the move atomic — maps/ and projects/ share one volume
      await fs.rename(file, mapPathFor(newId));
      movedFrom.set(id, newId);
      return json(res, 200, { id: newId, project });
    }

    if (req.method === 'DELETE') {
      if (!file) return json(res, 404, { error: `no map "${id}"` });
      const item = await trashMap(id, file);
      broadcast({ type: 'library-changed' });
      return json(res, 200, { item });
    }

    if (req.method === 'GET') {
      if (file) {
        const source = await fs.readFile(file, 'utf8');
        return json(res, 200, { id, source });
      }
      // after a move the old id keeps answering, so open tabs learn the new
      // location from movedTo instead of erroring
      const movedTo = followMoves(id);
      const movedFile = movedTo ? await resolveMapPath(movedTo) : null;
      if (movedFile) {
        const source = await fs.readFile(movedFile, 'utf8');
        return json(res, 200, { id: movedTo, source, movedTo });
      }
      return json(res, 404, { error: `no map "${id}" (looked for ${path.relative(ROOT, mapPathFor(id))})` });
    }
    if (req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      if (typeof body?.source !== 'string') return json(res, 400, { error: 'body must be { source: string }' });
      const { errors } = parseMap(body.source);
      if (errors.length) return json(res, 422, { error: 'refusing to save an invalid map', errors });
      const target = file ?? mapPathFor(id);
      const tmp = target + '.tmp-' + process.pid;
      if (id.includes('/')) await ensureProject(id.slice(0, id.indexOf('/')));
      else await fs.mkdir(MAPS_DIR, { recursive: true });
      await fs.writeFile(tmp, body.source, 'utf8');
      await fs.rename(tmp, target);
      // fileHashes deliberately NOT updated here: the watcher must detect the
      // write and broadcast to OTHER tabs; the writing tab ignores the echo
      // because the fetched source matches what it already has
      return json(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'projects' && parts.length === 3 && req.method === 'DELETE') {
    const slug = decodeURIComponent(parts[2]);
    if (!safeSlug(slug)) return json(res, 400, { error: 'invalid project slug' });
    const source = path.join(PROJECTS_DIR, slug);
    if (!existsSync(source)) return json(res, 404, { error: `no project "${slug}"` });
    const item = await trashProject(slug);
    broadcast({ type: 'library-changed' });
    return json(res, 200, { item });
  }

  if (parts[1] === 'projects' && parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, await projectIndex());
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const name = String(body?.name || '').trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
      if (slug === 'project') return json(res, 400, { error: '"project" is a reserved project slug' });
      if (existsSync(path.join(PROJECTS_DIR, slug))) return json(res, 409, { error: `a project named "${slug}" already exists` });
      await ensureProject(slug, name);
      return json(res, 201, { slug, name });
    }
  }

  // transcript importer — the LLM call happens HERE, server-side; no key or
  // token is ever sent to (or readable by) the browser
  if (parts[1] === 'import' && parts[2] === 'status' && req.method === 'GET') {
    const provider = await resolveProvider();
    return json(res, 200, provider
      ? { available: true, provider: provider.kind, model: provider.model }
      : {
        available: false,
        hint: 'Add ANTHROPIC_API_KEY or OPENAI_API_KEY to a .env file in the Serigraph folder (see .env.example), or log in the claude CLI (run `claude` once) — then restart Serigraph.',
      });
  }
  if (parts[1] === 'import' && parts.length === 2 && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    if (typeof body?.transcript !== 'string') return json(res, 400, { error: 'body must be { transcript: string }' });
    try {
      const result = await importTranscript(body.transcript, { llm: callLLM });
      return json(res, 200, result);
    } catch (e) {
      const status = e instanceof ImportError ? e.status : 502;
      console.error('[serigraph] import failed:', e.message);
      return json(res, status, { error: e.message });
    }
  }

  // map assistant — same server-side LLM discipline as the importer: the
  // proposal is validated here, and the browser reviews before applying
  if (parts[1] === 'chat' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      const result = await chatEdit(body, { llm: callLLM });
      return json(res, 200, result);
    } catch (e) {
      const status = e instanceof ChatError ? e.status : 502;
      console.error('[serigraph] chat failed:', e.message);
      return json(res, status, { error: e.message });
    }
  }

  // AI settings — masked on read; keys are stored server-side in .env
  if (parts[1] === 'settings' && req.method === 'GET') {
    return json(res, 200, await readSettings());
  }
  if (parts[1] === 'settings' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      return json(res, 200, await writeSettings(body ?? {}));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // voice transcription — audio goes to the configured provider, never to the browser
  if (parts[1] === 'transcribe' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    if (typeof body?.audio !== 'string' || !body.audio) return json(res, 400, { error: 'body must be { audio: base64, mime? }' });
    if (body.audio.length > 20_000_000) return json(res, 413, { error: 'Keep the clip under about 2 minutes.' });
    try {
      const text = await callTranscription({ audio: Buffer.from(body.audio, 'base64'), mime: body.mime });
      return json(res, 200, { text });
    } catch (e) {
      console.error('[serigraph] transcribe failed:', e.message);
      return json(res, 502, { error: e.message });
    }
  }

  if (parts[1] === 'templates' && req.method === 'GET') {
    const out = [];
    for (const file of await listDir(TEMPLATES_DIR)) {
      const id = file.replace(/\.ya?ml$/, '');
      try {
        const source = await fs.readFile(path.join(TEMPLATES_DIR, file), 'utf8');
        const { model } = parseMap(source);
        if (model) out.push({ id, name: model.name, description: model.description, nodeCount: model.nodeCount, mode: model.mode, source });
      } catch { /* skip unreadable */ }
    }
    return json(res, 200, out);
  }

  if (parts[1] === 'events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 25000);
    const cleanup = () => { clearInterval(heartbeat); sseClients.delete(res); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return;
  }

  json(res, 404, { error: `unknown API route ${url.pathname}` });
}

async function handleStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/app/index.html';
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  const allowed = ['app', 'vendor', 'shared', 'docs'];
  const top = path.relative(ROOT, filePath).split(path.sep)[0];
  if (!allowed.includes(top)) { res.writeHead(404); return res.end('not found'); }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`not found: ${pathname}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // DNS-rebinding guard: a page at evil.example that resolves to 127.0.0.1
  // arrives with its own Host header; refuse anything that isn't local
  if (!LAN && !LOCAL_HOSTS.test(req.headers.host ?? '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden: unrecognized Host header (start with --lan to serve beyond localhost)');
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/export/')) {
      const rest = decodeURIComponent(url.pathname.slice('/export/'.length)).replace(/\.html$/, '');
      // a whole project as one standalone bundle: /export/project/<slug>.html —
      // the "project/" prefix is reserved so it can never shadow a map export
      if (rest.startsWith('project/')) {
        const slug = rest.slice('project/'.length);
        if (!safeSlug(slug)) { res.writeHead(400); return res.end('invalid project slug'); }
        if (!existsSync(path.join(PROJECTS_DIR, slug))) { res.writeHead(404); return res.end(`no project "${slug}"`); }
        const { index, name, maps } = await projectMetaFor(slug);
        if (!maps.length) { res.writeHead(404); return res.end(`project "${slug}" has no maps to export`); }
        // the bundle opens on the lead map: first in the index's "order:", else first file
        const leadId = index.order.map((s) => `${slug}/${s}`).find((mid) => maps.some((m) => m.id === mid));
        const primary = maps.find((m) => m.id === leadId) ?? maps[0];
        const source = await fs.readFile(await resolveMapPath(primary.id), 'utf8');
        const html = await buildExport(ROOT, primary.id, source, { slug, name, maps });
        const preview = url.searchParams.get('preview') === '1';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': preview ? 'inline' : `attachment; filename="${slug}-serigraph.html"`,
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      }
      const id = rest;
      if (!safeId(id)) { res.writeHead(400); return res.end('invalid map id'); }
      const file = await resolveMapPath(id);
      if (!file) { res.writeHead(404); return res.end(`no map "${id}"`); }
      const projectMeta = id.includes('/') ? await projectMetaFor(id.slice(0, id.indexOf('/'))) : null;
      const html = await buildExport(ROOT, id, await fs.readFile(file, 'utf8'), projectMeta);
      const preview = url.searchParams.get('preview') === '1';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': preview ? 'inline' : `attachment; filename="${id.replace('/', '-')}-serigraph.html"`,
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }
    return await handleStatic(req, res, url);
  } catch (e) {
    console.error(`[serigraph] ${req.method} ${url.pathname} failed:`, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

function openBrowser(urlStr) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [urlStr], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref(); }
  catch { /* best effort */ }
}

async function start(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`[serigraph] port ${port} busy, trying ${port + 1}`);
      start(port + 1, attempt + 1);
    } else {
      console.error('[serigraph] failed to start:', e.message);
      process.exit(1);
    }
  });
  server.listen(port, BIND_HOST, async () => {
    await primeHashes();
    watchDir(MAPS_DIR, (f) => scheduleMapChange(MAPS_DIR, f));
    watchDir(TEMPLATES_DIR, () => broadcast({ type: 'templates-changed' }));
    for (const project of await projectIndex()) watchProjectDir(project.slug);
    const urlStr = `http://localhost:${port}/`;
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │   Serigraph — your business, mapped     │');
    console.log(`  │   ${urlStr.padEnd(38)}│`);
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
    console.log(`  maps:      ${path.relative(process.cwd(), MAPS_DIR) || 'maps'}/*.yaml  (edit them in any editor — the canvas follows)`);
    console.log(`  templates: ${path.relative(process.cwd(), TEMPLATES_DIR) || 'templates'}/*.yaml`);
    console.log(`  projects:  ${path.relative(process.cwd(), PROJECTS_DIR) || 'projects'}/*/`);
    console.log(LAN ? '  serving:   all interfaces (--lan)' : '  serving:   localhost only (start with --lan to share on your network)');
    console.log('');
    if (!NO_OPEN) openBrowser(urlStr);
  });
}

start(DEFAULT_PORT);
