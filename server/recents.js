// Recently opened maps, shared by every machine that uses the same library.
// Each machine writes only its own file, so a cloud drive never has two
// computers rewriting one list; readers merge the files by time.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT = 40;
const MACHINE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/;

// The label is the computer's own name ("Joe’s MacBook Pro"); the file name
// is a plain-character version of it that stays stable across restarts.
export function machineIdentity(label = process.env.SERIGRAPH_MACHINE_NAME || os.hostname()) {
  const clean = String(label).replace(/\.local$/i, '').trim().slice(0, 80) || 'This computer';
  const id = clean.normalize('NFKD').replace(/[’']/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80);
  return { id: id || 'this-computer', label: clean };
}

export function createRecents({ dir, identity = machineIdentity(), validId = () => true }) {
  const machine = identity.id;
  const own = path.join(dir, `${machine}.json`);
  let writes = Promise.resolve();

  async function readFile(file) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 65_536) return [];
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.items)) return [];
      const label = typeof data.label === 'string' ? data.label.slice(0, 80) : null;
      return data.items.map(item => ({ ...item, label })).filter(item => typeof item?.id === 'string' && validId(item.id)
        && typeof item.openedAt === 'string' && !Number.isNaN(Date.parse(item.openedAt)));
    } catch { return []; }
  }

  return {
    machine,
    label: identity.label,
    record(id) {
      if (!validId(id)) return Promise.reject(new Error('Unknown map.'));
      const next = writes.then(async () => {
        const items = (await readFile(own)).filter(item => item.id !== id).map(({ id, openedAt }) => ({ id, openedAt }));
        items.unshift({ id, openedAt: new Date().toISOString() });
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const temporary = path.join(dir, `.${machine}.${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, machine, label: identity.label, items: items.slice(0, LIMIT) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, own);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      });
      writes = next.catch(() => {});
      return next;
    },
    async list() {
      let names;
      try { names = await fs.readdir(dir); } catch { return []; }
      const newest = new Map();
      for (const name of names) {
        if (!MACHINE_FILE.test(name)) continue;
        const from = name.slice(0, -'.json'.length);
        for (const item of await readFile(path.join(dir, name))) {
          const seen = newest.get(item.id);
          if (!seen || Date.parse(item.openedAt) > Date.parse(seen.openedAt)) newest.set(item.id, { id: item.id, openedAt: item.openedAt, machine: from, machineLabel: item.label || from });
        }
      }
      return [...newest.values()].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt)).slice(0, LIMIT);
    },
  };
}
