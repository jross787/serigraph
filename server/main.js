// Serigraph server — zero npm dependencies, Node built-ins only.
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
import { callLLM, resolveProvider } from './llm.js';
import { importTranscript, ImportError } from './importer.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAPS_DIR = path.join(ROOT, 'maps');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
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
        out.push({ id, file, name: model.name, description: model.description, nodeCount: model.nodeCount, kind: model.document.kind });
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
  // requiring JSON makes every write a CORS-preflighted request, so a hostile
  // web page in the same browser can't POST/PUT here as a "simple request"
  if ((req.method === 'POST' || req.method === 'PUT')
    && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return json(res, 415, { error: 'Content-Type must be application/json' });
  }
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

  // transcript importer — the LLM call happens HERE, server-side; no key or
  // token is ever sent to (or readable by) the browser
  if (parts[1] === 'import' && parts[2] === 'status' && req.method === 'GET') {
    const provider = await resolveProvider();
    return json(res, 200, provider
      ? { available: true, provider: provider.kind, model: provider.model }
      : {
        available: false,
        hint: 'Set ANTHROPIC_API_KEY in the server\'s environment, log in the claude CLI (run `claude` once), or point OPSMAP_LLM_CMD at a local model — then restart Serigraph.',
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
  // DNS-rebinding guard: a page at evil.example that resolves to 127.0.0.1
  // arrives with its own Host header; refuse anything that isn't local
  if (!LAN && !LOCAL_HOSTS.test(req.headers.host ?? '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden: unrecognized Host header (start with --lan to serve beyond localhost)');
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/export/')) {
      const id = decodeURIComponent(url.pathname.slice('/export/'.length)).replace(/\.html$/, '');
      if (!safeId(id)) { res.writeHead(400); return res.end('invalid map id'); }
      const file = await findMapFile(id);
      if (!file) { res.writeHead(404); return res.end(`no map "${id}"`); }
      const html = await buildExport(ROOT, id, await fs.readFile(file, 'utf8'));
      const preview = url.searchParams.get('preview') === '1';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': preview ? 'inline' : `attachment; filename="${id}-serigraph.html"`,
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
    watchDir(MAPS_DIR, scheduleMapChange);
    watchDir(TEMPLATES_DIR, () => broadcast({ type: 'templates-changed' }));
    const urlStr = `http://localhost:${port}/`;
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │   Serigraph — your business, mapped     │');
    console.log(`  │   ${urlStr.padEnd(38)}│`);
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
    console.log(`  maps:      ${path.relative(process.cwd(), MAPS_DIR) || 'maps'}/*.yaml  (edit them in any editor — the canvas follows)`);
    console.log(`  templates: ${path.relative(process.cwd(), TEMPLATES_DIR) || 'templates'}/*.yaml`);
    console.log(LAN ? '  serving:   all interfaces (--lan)' : '  serving:   localhost only (start with --lan to share on your network)');
    console.log('');
    if (!NO_OPEN) openBrowser(urlStr);
  });
}

start(DEFAULT_PORT);
