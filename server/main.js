// Opsmap server — zero npm dependencies, Node built-ins only.
// Serves the app, reads/writes map files, pushes file changes to the
// browser over SSE, and builds standalone HTML exports.
import { createServer } from 'node:http';
import { promises as fs, watch, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';
import { buildExport } from './export.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAPS_DIR = path.join(ROOT, 'maps');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const DEFAULT_PORT = Number(process.env.PORT) || 4700;
const NO_OPEN = process.argv.includes('--no-open') || process.env.OPSMAP_NO_OPEN === '1';

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

const ID_RE = /^[A-Za-z0-9._-]+$/;
const safeId = (id) => typeof id === 'string' && id.length < 200 && ID_RE.test(id) && !id.includes('..');

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

async function mapSummaries(dir) {
  const out = [];
  for (const file of await listDir(dir)) {
    const id = file.replace(/\.ya?ml$/, '');
    try {
      const source = await fs.readFile(path.join(dir, file), 'utf8');
      const { model, errors } = parseMap(source);
      if (model) {
        out.push({ id, file, name: model.name, description: model.description, nodeCount: model.nodeCount });
      } else {
        out.push({ id, file, name: id, description: '', nodeCount: 0, invalid: true, errorCount: errors.length });
      }
    } catch (e) {
      out.push({ id, file, name: id, description: '', nodeCount: 0, invalid: true, errorCount: 1 });
    }
  }
  return out;
}

async function findMapFile(id) {
  for (const ext of ['.yaml', '.yml']) {
    const p = path.join(MAPS_DIR, id + ext);
    if (existsSync(p)) return p;
  }
  return null;
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
  for (const file of await listDir(MAPS_DIR)) {
    try {
      fileHashes.set(file, hashOf(await fs.readFile(path.join(MAPS_DIR, file), 'utf8')));
    } catch { /* ignore */ }
  }
}

function watchDir(dir, onChange) {
  if (!existsSync(dir)) return;
  try {
    watch(dir, (eventType, filename) => {
      if (filename && /\.ya?ml$/.test(filename)) onChange(filename);
    });
  } catch { /* fs.watch unsupported — SSE degrades gracefully */ }
}

function scheduleMapChange(filename) {
  pendingChanges.add(filename);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    const changed = [];
    for (const file of pendingChanges) {
      const p = path.join(MAPS_DIR, file);
      let h = null;
      try { h = hashOf(await fs.readFile(p, 'utf8')); } catch { /* deleted */ }
      if (fileHashes.get(file) !== h) {
        if (h === null) fileHashes.delete(file); else fileHashes.set(file, h);
        changed.push(file.replace(/\.ya?ml$/, ''));
      }
    }
    pendingChanges = new Set();
    if (changed.length) broadcast({ type: 'maps-changed', ids: changed });
  }, 120);
}

// ---------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (parts[1] === 'maps' && parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, await mapSummaries(MAPS_DIR));
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
      if (await findMapFile(slug)) return json(res, 409, { error: `a map named "${slug}" already exists` });
      const source = `# ${name} — operations map\nname: ${JSON.stringify(name)}\ndescription: ""\n\nnodes: []\n\nedges: []\n`;
      await fs.mkdir(MAPS_DIR, { recursive: true });
      await fs.writeFile(path.join(MAPS_DIR, slug + '.yaml'), source, 'utf8');
      // fileHashes deliberately NOT updated here: the watcher must see the
      // change and broadcast it so other tabs pick the new map up
      return json(res, 201, { id: slug });
    }
  }

  if (parts[1] === 'maps' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]);
    if (!safeId(id)) return json(res, 400, { error: 'invalid map id' });
    const file = await findMapFile(id);

    if (req.method === 'GET') {
      if (!file) return json(res, 404, { error: `no map "${id}" in maps/` });
      const source = await fs.readFile(file, 'utf8');
      return json(res, 200, { id, source });
    }
    if (req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
      if (typeof body?.source !== 'string') return json(res, 400, { error: 'body must be { source: string }' });
      const { errors } = parseMap(body.source);
      if (errors.length) return json(res, 422, { error: 'refusing to save an invalid map', errors });
      const target = file ?? path.join(MAPS_DIR, id + '.yaml');
      const tmp = target + '.tmp-' + process.pid;
      await fs.mkdir(MAPS_DIR, { recursive: true });
      await fs.writeFile(tmp, body.source, 'utf8');
      await fs.rename(tmp, target);
      // fileHashes deliberately NOT updated here: the watcher must detect the
      // write and broadcast to OTHER tabs; the writing tab ignores the echo
      // because the fetched source matches what it already has
      return json(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'templates' && req.method === 'GET') {
    const out = [];
    for (const file of await listDir(TEMPLATES_DIR)) {
      const id = file.replace(/\.ya?ml$/, '');
      try {
        const source = await fs.readFile(path.join(TEMPLATES_DIR, file), 'utf8');
        const { model } = parseMap(source);
        if (model) out.push({ id, name: model.name, description: model.description, nodeCount: model.nodeCount, source });
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
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/export/')) {
      const id = decodeURIComponent(url.pathname.slice('/export/'.length)).replace(/\.html$/, '');
      if (!safeId(id)) { res.writeHead(400); return res.end('invalid map id'); }
      const file = await findMapFile(id);
      if (!file) { res.writeHead(404); return res.end(`no map "${id}"`); }
      const html = await buildExport(ROOT, id, await fs.readFile(file, 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${id}-opsmap.html"`,
      });
      return res.end(html);
    }
    return await handleStatic(req, res, url);
  } catch (e) {
    console.error(`[opsmap] ${req.method} ${url.pathname} failed:`, e.message);
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
      console.log(`[opsmap] port ${port} busy, trying ${port + 1}`);
      start(port + 1, attempt + 1);
    } else {
      console.error('[opsmap] failed to start:', e.message);
      process.exit(1);
    }
  });
  server.listen(port, async () => {
    await primeHashes();
    watchDir(MAPS_DIR, scheduleMapChange);
    watchDir(TEMPLATES_DIR, () => broadcast({ type: 'templates-changed' }));
    const urlStr = `http://localhost:${port}/`;
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │   Opsmap — your business, mapped        │');
    console.log(`  │   ${urlStr.padEnd(38)}│`);
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
    console.log(`  maps:      ${path.relative(process.cwd(), MAPS_DIR) || 'maps'}/*.yaml  (edit them in any editor — the canvas follows)`);
    console.log(`  templates: ${path.relative(process.cwd(), TEMPLATES_DIR) || 'templates'}/*.yaml`);
    console.log('');
    if (!NO_OPEN) openBrowser(urlStr);
  });
}

start(DEFAULT_PORT);
