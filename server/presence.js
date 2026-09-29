// Who else has a map open, for maps in folders a cloud drive shares with
// other people (Google Drive, iCloud Drive, and other File Provider drives).
// Each person's app keeps one small record beside the map, in a hidden
// folder the drive syncs; readers list the records that are still fresh.
// Maps in ordinary folders, such as a code repository, get no records.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { machineIdentity } from './recents.js';

const FOLDER = '.serigraph-presence';
const FRESH_MS = 150_000;
const EDITING_MS = 90_000;
const FORGET_MS = 7 * 24 * 60 * 60 * 1000;
const CLOUD_PARTS = [['Library', 'CloudStorage'], ['Library', 'Mobile Documents']]
  .map((parts) => path.sep + parts.join(path.sep) + path.sep);

export const inSharedFolder = (file) => CLOUD_PARTS.some((part) => String(file).includes(part));

export function personIdentity(name = process.env.SERIGRAPH_USER_NAME || os.userInfo().username) {
  const person = String(name).trim().slice(0, 60) || 'Someone';
  const machine = machineIdentity();
  const slug = person.normalize('NFKD').replace(/[’']/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'someone';
  return { id: `${slug}-${machine.id}`.slice(0, 120), person, machine: machine.label };
}

export function createPresence({ identity = personIdentity(), writable = true } = {}) {
  const written = new Map(); // map file -> { at, editing }
  const folderFor = (file) => path.join(path.dirname(file), FOLDER, path.basename(file));

  async function write(file, editing) {
    const folder = folderFor(file);
    await fs.mkdir(folder, { recursive: true });
    const target = path.join(folder, `${identity.id}.json`);
    const temporary = path.join(folder, `.${identity.id}.${randomUUID()}.tmp`);
    const record = { version: 1, person: identity.person, machine: identity.machine, at: new Date().toISOString(), editing };
    try {
      await fs.writeFile(temporary, JSON.stringify(record) + '\n');
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async function list(file) {
    if (!inSharedFolder(file)) return [];
    const folder = folderFor(file);
    let names;
    try { names = await fs.readdir(folder); } catch { return []; }
    const people = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.') || name === `${identity.id}.json`) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
        const age = Date.now() - Date.parse(record.at);
        if (record.version !== 1 || !Number.isFinite(age)) continue;
        // Someone who left without closing, long ago: tidy their record away.
        if (age > FORGET_MS) { await fs.unlink(path.join(folder, name)).catch(() => {}); continue; }
        if (age > FRESH_MS) continue;
        people.push({
          person: String(record.person || 'Someone').slice(0, 60),
          machine: String(record.machine || '').slice(0, 80),
          at: record.at,
          editing: !!record.editing && age < EDITING_MS,
        });
      } catch { /* a record still syncing */ }
    }
    return people.sort((a, b) => a.person.localeCompare(b.person) || a.machine.localeCompare(b.machine));
  }

  return {
    identity,
    list,
    // Refresh this person's record at most every 45 seconds, or at once when
    // they start or stop editing, to keep the drive's sync traffic small.
    async beat(file, { editing = false } = {}) {
      if (!inSharedFolder(file)) return [];
      const last = written.get(file);
      if (writable && (!last || Date.now() - last.at > 45_000 || last.editing !== editing)) {
        written.set(file, { at: Date.now(), editing });
        await write(file, editing).catch(() => written.delete(file));
      }
      return list(file);
    },
    async leave(file) {
      written.delete(file);
      if (writable) await fs.unlink(path.join(folderFor(file), `${identity.id}.json`)).catch(() => {});
    },
  };
}
