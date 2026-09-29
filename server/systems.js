// The library's shared systems and tools: one systems.yaml beside maps/ and
// projects/. A map that uses one keeps its own copy of the label, type, and
// description and names the shared entry with `library: <id>`, so the map
// still works when opened alone, exported, or kept in another repo.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as YAML from '../vendor/yaml.js';
import { NODE_TYPES, LIBRARY_ID_RE } from '../shared/model.js';

export const SYSTEMS_FILE = 'systems.yaml';
const HEADER = '# Systems and tools shared by every map in this library.\n# Maps refer to an entry with "library: <id>" and keep their own copy of its details.\n';

export function slugifySystem(label) {
  return String(label).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'system';
}

function clean(entry) {
  const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
  const type = NODE_TYPES.includes(entry?.type) ? entry.type : 'system';
  const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
  return { label, type, description };
}

export function createSystemsLibrary({ root }) {
  const file = path.join(root, SYSTEMS_FILE);
  let writes = Promise.resolve();

  async function readDocument() {
    let source = '';
    try { source = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const doc = YAML.parseDocument(source || `${HEADER}systems: []\n`);
    if (doc.errors.length) throw new Error(`${SYSTEMS_FILE} has a YAML error: ${doc.errors[0].message.split('\n')[0]}`);
    if (!YAML.isSeq(doc.get('systems', true))) doc.set('systems', doc.createNode([]));
    return doc;
  }

  async function list() {
    const doc = await readDocument();
    const seen = new Set();
    return (doc.toJS().systems ?? []).filter((entry) => {
      if (!entry || typeof entry.id !== 'string' || !LIBRARY_ID_RE.test(entry.id) || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    }).map((entry) => ({ id: entry.id, ...clean(entry) })).filter((entry) => entry.label);
  }

  async function write(doc) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, doc.toString({ lineWidth: 0 }), { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  const serial = (action) => {
    const next = writes.then(action, action);
    writes = next.catch(() => {});
    return next;
  };

  return {
    file,
    list,
    // Add a system, or update the one with this id. Comments and other
    // entries in the file stay as they are.
    save: (entry) => serial(async () => {
      const fields = clean(entry);
      if (!fields.label) throw new Error('A shared system needs a name.');
      const doc = await readDocument();
      const systems = doc.get('systems', true);
      const existing = typeof entry.id === 'string' && LIBRARY_ID_RE.test(entry.id)
        ? systems.items.findIndex((item) => YAML.isMap(item) && item.get('id') === entry.id) : -1;
      let id = existing >= 0 ? entry.id : null;
      if (!id) {
        const taken = new Set(systems.items.map((item) => YAML.isMap(item) ? item.get('id') : null));
        const base = typeof entry.id === 'string' && LIBRARY_ID_RE.test(entry.id) ? entry.id : slugifySystem(fields.label);
        id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      }
      const plain = { id, type: fields.type, label: fields.label, ...(fields.description ? { description: fields.description } : {}) };
      if (existing >= 0) {
        const item = systems.items[existing];
        item.set('type', plain.type);
        item.set('label', plain.label);
        if (plain.description) item.set('description', plain.description);
        else item.delete('description');
      } else {
        systems.items.push(doc.createNode(plain));
        systems.flow = false;
      }
      await write(doc);
      return { id, ...fields };
    }),
    remove: (id) => serial(async () => {
      const doc = await readDocument();
      const systems = doc.get('systems', true);
      const index = systems.items.findIndex((item) => YAML.isMap(item) && item.get('id') === id);
      if (index < 0) throw new Error('That shared system no longer exists.');
      systems.items.splice(index, 1);
      await write(doc);
    }),
  };
}

// Every card or shared element that names a library system, across maps.
export function libraryUses(model) {
  const uses = [];
  const seen = new Set();
  for (const node of model.byId.values()) {
    if (!node.library || seen.has(node.id)) continue;
    seen.add(node.id);
    uses.push({ library: node.library, nodeId: node.id, label: node.label });
  }
  return uses;
}
