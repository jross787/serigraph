// Local file references live in library metadata, never in YAML or the engine
// checkout. Linking grants access only to the selected file or the immediate
// YAML children of the selected folder, not its settings.
//
// Each link is its own small JSON file, so a library shared through a cloud
// drive never has two machines rewriting one list. Paths inside the home
// folder are stored as "~/…" because the same repo or drive folder has a
// different absolute path on a Mac with a different user name.
import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseProjectIndex, isLocalLink } from '../shared/projects.js';
import { summarizeMapSource } from './map-summary.js';

export { isLocalLink };
const within = (root, target) => { const rel = path.relative(root, target); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const digest = text => createHash('sha256').update(text).digest('hex');
const LINK_FILE = /^(linked-[0-9a-f-]{36})\.json$/;

export function portablePath(absolute, home = os.homedir()) {
  const rel = path.relative(home, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absolute;
  return `~/${rel.split(path.sep).join('/')}`;
}

export function expandPath(stored, home = os.homedir()) {
  if (typeof stored !== 'string') return null;
  if (stored.startsWith('~/')) return path.join(home, ...stored.slice(2).split('/'));
  return path.isAbsolute(stored) ? stored : null;
}
const mapSlug = file => {
  const base = file.replace(/\.ya?ml$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(base) && !base.includes('..') ? base : `file-${digest(file).slice(0, 20)}`;
};

async function boundedSource(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Each linked YAML file must be a regular file no larger than 1 MB.');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1024 * 1024) throw new Error('Each linked YAML file must be no larger than 1 MB.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

export function createLocalLinks({ engineRoot, registryDir, enabled = true, home = os.homedir() }) {
  let writes = Promise.resolve();
  const serial = action => { const next = writes.then(action, action); writes = next.catch(() => {}); return next; };
  async function checkedPath(target, kind) {
    if (!enabled) throw new Error('Local links are available only in the local app, not LAN mode.');
    if (typeof target === 'string' && target.startsWith('~/')) target = expandPath(target, home);
    if (typeof target !== 'string' || !path.isAbsolute(target) || /[\0\r\n]/.test(target)) throw new Error('Enter an absolute path to a YAML file or map folder.');
    let resolved, stat;
    try { resolved = await fs.realpath(target); stat = await fs.lstat(resolved); }
    catch { throw new Error(kind ? 'Not found on this Mac. The file may live in a folder or repo that only another computer has.' : 'This location is unavailable. Reconnect the drive or check the path and permissions.'); }
    if (within(await fs.realpath(engineRoot), resolved)) throw new Error('Choose a location outside the Serigraph application repository.');
    const actual = stat.isDirectory() ? 'folder' : stat.isFile() && /\.ya?ml$/i.test(resolved) ? 'file' : null;
    if (!actual || (kind && (actual !== kind || resolved !== target))) throw new Error('The linked location changed. Remove the link and open the location again.');
    if (actual === 'file' && /^projects\.ya?ml$/i.test(path.basename(resolved))) throw new Error('Choose the project folder, not its projects.yaml index.');
    return { path: resolved, kind: actual };
  }
  // A half-synced or hand-edited record is skipped rather than blocking the
  // library: it never grants access to anything by itself.
  async function readRegistry() {
    if (!enabled) return [];
    let names;
    try { names = await fs.readdir(registryDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('The linked-file list cannot be read. Check the library folder permissions.'); }
    const links = [], paths = new Set();
    for (const name of names.sort()) {
      const match = name.match(LINK_FILE);
      if (!match || links.length >= 200) continue;
      try {
        const file = path.join(registryDir, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 16_384) continue;
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const absolute = expandPath(data.path, home);
        if (data.version !== 1 || data.id !== match[1] || !['file', 'folder'].includes(data.kind) || !absolute || paths.has(absolute)) continue;
        paths.add(absolute);
        links.push({ id: data.id, kind: data.kind, path: absolute, stored: data.path, added: data.added || null });
      } catch { /* skip an unreadable record */ }
    }
    return links;
  }
  async function writeRecord(link) {
    const engine = await fs.realpath(engineRoot);
    if (within(engine, path.resolve(registryDir))) throw new Error('The linked-file list must be stored outside the application repository.');
    await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
    if (within(engine, await fs.realpath(registryDir))) throw new Error('The linked-file list must be stored outside the application repository.');
    const target = path.join(registryDir, `${link.id}.json`);
    const temporary = path.join(registryDir, `.${link.id}.${randomUUID()}.tmp`);
    const record = { version: 1, id: link.id, kind: link.kind, path: portablePath(link.path, home), added: new Date().toISOString() };
    try {
      await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function filesFor(link) {
    await checkedPath(link.path, link.kind);
    if (link.kind === 'file') return [{ name: path.basename(link.path), id: 'map', path: link.path }];
    const files = [], names = new Set();
    let visited = 0;
    for await (const entry of await fs.opendir(link.path)) {
      if (++visited > 2000) throw new Error('This folder is too large. Link a smaller map folder.');
      if (!entry.isFile() || entry.name.startsWith('.') || !/\.ya?ml$/i.test(entry.name)) continue;
      const id = /^projects\.ya?ml$/i.test(entry.name) ? 'projects' : mapSlug(entry.name);
      if (names.has(id.toLowerCase())) throw new Error('This folder has ambiguous YAML filenames. Keep one file per map name.');
      names.add(id.toLowerCase());
      files.push({ name: entry.name, id, path: path.join(link.path, entry.name) });
      if (files.length > 100) throw new Error('Link at most 100 YAML files per folder.');
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function describe(link) {
    const files = await filesFor(link), maps = [], hashes = [];
    let index = {}, bytes = 0;
    for (const file of files) {
      const source = await boundedSource(file.path);
      bytes += Buffer.byteLength(source);
      if (bytes > 8 * 1024 * 1024) throw new Error('Link a folder with at most 8 MB of YAML.');
      hashes.push([file.name, digest(source)]);
      if (file.id === 'projects') { index = parseProjectIndex(source); continue; }
      maps.push({ id: `${link.id}/${file.id}`, file: file.name, ...summarizeMapSource(source, file.name) });
    }
    const name = index.name || (link.kind === 'file' ? maps[0]?.name : null) || path.basename(link.path);
    const project = { slug: link.id, name, linked: true };
    return { ...project, location: portablePath(link.path, home), linkKind: link.kind, description: index.description || '',
      order: index.order || [], tags: index.tags || {}, mapCount: maps.length,
      indexErrors: index.errors?.length || 0, maps: maps.map(map => ({ ...map, project })),
      fingerprint: digest(JSON.stringify([link.path, link.kind, hashes])) };
  }
  return {
    enabled,
    entries: readRegistry,
    async preview(target) {
      const link = { ...await checkedPath(target), id: 'preview' };
      const preview = await describe(link);
      if (!preview.mapCount) throw new Error('No YAML maps found directly in this location. Choose a map file or its containing folder.');
      return { ...preview, path: link.path, kind: link.kind };
    },
    add: preview => serial(async () => {
      const next = await checkedPath(preview.path, preview.kind);
      const current = await describe({ ...next, id: 'preview' });
      if (current.fingerprint !== preview.fingerprint) throw new Error('The files changed since preview. Preview the location again before linking.');
      const links = await readRegistry();
      const existing = links.find(link => link.path === next.path);
      if (existing) return { id: existing.id, existing: true, kind: existing.kind };
      if (links.length >= 200) throw new Error('Remove an unused location before adding more than 200 links.');
      const link = { ...next, id: `linked-${randomUUID()}` };
      await writeRecord(link);
      return { id: link.id, existing: false, kind: link.kind };
    }),
    // Opening a file from the Mac menu or Finder is the approval: preview and
    // save the reference in one step, reusing an existing link for the path.
    async open(target) {
      const preview = await this.preview(target);
      return this.add(preview);
    },
    remove: id => serial(async () => {
      const links = await readRegistry();
      if (!links.some(link => link.id === id)) throw new Error('This library link no longer exists. Refresh Projects.');
      await fs.unlink(path.join(registryDir, `${id}.json`));
    }),
    async projects() {
      return Promise.all((await readRegistry()).map(async link => {
        try { const { fingerprint, ...project } = await describe(link); return project; }
        catch (error) { return { slug: link.id, name: path.basename(link.path), linked: true, location: portablePath(link.path, home),
          linkKind: link.kind, unavailable: true, error: error.message, mapCount: 0, maps: [] }; }
      }));
    },
    async resolve(id) {
      const [slug, map, extra] = id.split('/');
      if (extra || !map || map === 'projects') return null;
      const link = (await readRegistry()).find(item => item.id === slug);
      if (!link) return null;
      try {
        const file = (await filesFor(link)).find(item => item.id === map);
        if (!file || !(await fs.lstat(file.path)).isFile() || await fs.realpath(file.path) !== file.path) return null;
        return file.path;
      } catch { return null; }
    },
  };
}
