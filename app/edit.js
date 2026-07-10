// Comment-preserving edits against the YAML document. Every function
// mutates state.doc in place; callers serialize with doc.toString().
import { isMap, isSeq } from '../vendor/yaml.js';
import { state } from './state.js';

// ── locating things in the YAML document ─────────────────────────────
// Returns the YAML path (e.g. ['nodes', 2, 'children', 'nodes', 0]) of the
// node with the given id, or null.
export function findNodePath(doc, nodeId, basePath = ['nodes']) {
  const seq = doc.getIn(basePath, true);
  if (!isSeq(seq)) return null;
  for (let i = 0; i < seq.items.length; i++) {
    const itemPath = [...basePath, i];
    const item = seq.items[i];
    if (!isMap(item)) continue;
    if (item.get('id') === nodeId) return itemPath;
    const children = item.get('children', true);
    if (children) {
      const childBase = isMap(children)
        ? [...itemPath, 'children', 'nodes'] // map form: children: {nodes, edges}
        : [...itemPath, 'children'];         // list form: children: [...]
      const found = findNodePath(doc, nodeId, childBase);
      if (found) return found;
    }
  }
  return null;
}

// Returns { nodesPath, edgesPath } for the scope owned by ownerId
// (null = root). Creates/normalizes the children container when needed.
export function ensureScope(doc, ownerId, { create = true } = {}) {
  if (ownerId == null) {
    if (!doc.getIn(['nodes'], true) && create) doc.setIn(['nodes'], doc.createNode([]));
    if (!doc.getIn(['edges'], true) && create) doc.setIn(['edges'], doc.createNode([]));
    return { nodesPath: ['nodes'], edgesPath: ['edges'] };
  }
  const nodePath = findNodePath(doc, ownerId);
  if (!nodePath) return null;
  const childrenPath = [...nodePath, 'children'];
  const children = doc.getIn(childrenPath, true);
  if (!children) {
    if (!create) return null;
    doc.setIn(childrenPath, doc.createNode({ nodes: [], edges: [] }));
  } else if (isSeq(children)) {
    // list form → normalize to { nodes: [...], edges: [] } so we can add edges
    const wrapper = doc.createNode({ nodes: [], edges: [] });
    wrapper.set('nodes', children);
    doc.setIn(childrenPath, wrapper);
  } else if (isMap(children)) {
    if (!children.get('nodes', true) && create) doc.setIn([...childrenPath, 'nodes'], doc.createNode([]));
    if (!children.get('edges', true) && create) doc.setIn([...childrenPath, 'edges'], doc.createNode([]));
  }
  return { nodesPath: [...childrenPath, 'nodes'], edgesPath: [...childrenPath, 'edges'] };
}

// ── id helpers ───────────────────────────────────────────────────────
export function slugify(label) {
  const s = String(label).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'node';
}

export function uniqueId(model, base, extraTaken = new Set()) {
  let id = base, n = 2;
  while (model?.byId.has(id) || extraTaken.has(id)) id = `${base}-${n++}`;
  return id;
}

// ── node object construction (key order = file convention) ──────────
function nodeToPlain(fields) {
  const obj = { id: fields.id, type: fields.type, label: fields.label };
  if (fields.description?.trim()) obj.description = fields.description;
  if (fields.links?.length) obj.links = fields.links.map((l) => ({ label: l.label || l.url, url: l.url }));
  if (fields.children) obj.children = fields.children;
  return obj;
}

// ── operations ───────────────────────────────────────────────────────
export function addNode(ownerId, fields) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId);
  if (!scope) throw new Error(`can't find node "${ownerId}" in the file`);
  doc.addIn(scope.nodesPath, doc.createNode(nodeToPlain(fields)));
  return fields.id;
}

export function updateNode(nodeId, fields) {
  const doc = state.doc;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  if (fields.label != null) doc.setIn([...p, 'label'], fields.label);
  if (fields.type != null) doc.setIn([...p, 'type'], fields.type);
  if (fields.description !== undefined) {
    if (fields.description?.trim()) doc.setIn([...p, 'description'], fields.description);
    else if (doc.getIn([...p, 'description'], true)) doc.deleteIn([...p, 'description']);
  }
  if (fields.links !== undefined) {
    const links = (fields.links ?? []).filter((l) => l.url?.trim());
    if (links.length) doc.setIn([...p, 'links'], doc.createNode(links.map((l) => ({ label: l.label?.trim() || l.url, url: l.url }))));
    else if (doc.getIn([...p, 'links'], true)) doc.deleteIn([...p, 'links']);
  }
  tidyKeyOrder(doc, p);
}

// keep files predictable: links before children on every node we touch
function tidyKeyOrder(doc, nodePath) {
  const map = doc.getIn(nodePath, true);
  if (!isMap(map)) return;
  const idx = (key) => map.items.findIndex((pair) => pair.key?.value === key);
  const li = idx('links'), ci = idx('children');
  if (li !== -1 && ci !== -1 && li > ci) {
    const [linksPair] = map.items.splice(li, 1);
    map.items.splice(idx('children'), 0, linksPair);
  }
}

export function deleteNode(nodeId) {
  const doc = state.doc;
  const node = state.model.byId.get(nodeId);
  if (!node) throw new Error(`node "${nodeId}" not found`);
  const ownerId = node.ownerId;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);

  // remove sibling edges that reference it
  const scope = ensureScope(doc, ownerId, { create: false });
  if (scope) {
    const edgesSeq = doc.getIn(scope.edgesPath, true);
    if (isSeq(edgesSeq)) {
      for (let i = edgesSeq.items.length - 1; i >= 0; i--) {
        const e = edgesSeq.items[i];
        if (isMap(e) && (e.get('from') === nodeId || e.get('to') === nodeId)) {
          doc.deleteIn([...scope.edgesPath, i]);
        }
      }
    }
  }
  doc.deleteIn(p);
  cleanupScope(doc, ownerId);
}

// remove empty children containers so files stay tidy
function cleanupScope(doc, ownerId) {
  if (ownerId == null) return;
  const nodePath = findNodePath(doc, ownerId);
  if (!nodePath) return;
  const ch = doc.getIn([...nodePath, 'children'], true);
  if (!ch) return;
  const nodes = isMap(ch) ? ch.get('nodes', true) : ch;
  const edges = isMap(ch) ? ch.get('edges', true) : null;
  const nEmpty = !isSeq(nodes) || nodes.items.length === 0;
  const eEmpty = !isSeq(edges) || edges.items.length === 0;
  if (nEmpty && eEmpty) doc.deleteIn([...nodePath, 'children']);
}

export function addEdge(ownerId, { from, to, label }) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId);
  if (!scope) throw new Error(`can't find scope for "${ownerId}"`);
  const edge = { from, to };
  if (label?.trim()) edge.label = label.trim();
  doc.addIn(scope.edgesPath, doc.createNode(edge));
}

export function updateEdge(ownerId, index, { label }) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  if (label?.trim()) doc.setIn([...scope.edgesPath, index, 'label'], label.trim());
  else if (doc.getIn([...scope.edgesPath, index, 'label'], true)) doc.deleteIn([...scope.edgesPath, index, 'label']);
}

export function deleteEdge(ownerId, index) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  doc.deleteIn([...scope.edgesPath, index]);
}

// ── template insertion ───────────────────────────────────────────────
// Grafts a parsed template model into the given scope, renaming any ids
// that would collide with ids already in the map.
export function insertTemplate(ownerId, templateModel) {
  const doc = state.doc;
  const model = state.model;

  const taken = new Set();
  const rename = new Map();
  const allTemplateIds = [];
  (function collect(scope) {
    for (const n of scope.nodes) {
      allTemplateIds.push(n.id);
      if (n.children) collect(n.children);
    }
  })(templateModel.root);

  for (const id of allTemplateIds) {
    if (model.byId.has(id) || taken.has(id)) {
      const fresh = uniqueId(model, id, taken);
      rename.set(id, fresh);
      taken.add(fresh);
    } else {
      taken.add(id);
    }
  }
  const rid = (id) => rename.get(id) ?? id;

  const plainScope = (scope) => ({
    nodes: scope.nodes.map((n) => nodeToPlain({
      id: rid(n.id), type: n.type, label: n.label,
      description: n.description, links: n.links,
      children: n.children ? plainScope(n.children) : undefined,
    })),
    edges: scope.edges.map((e) => {
      const edge = { from: rid(e.from), to: rid(e.to) };
      if (e.label) edge.label = e.label;
      return edge;
    }),
  });
  const plain = plainScope(templateModel.root);

  const scope = ensureScope(doc, ownerId);
  if (!scope) throw new Error(`can't find scope for "${ownerId}"`);
  for (const n of plain.nodes) doc.addIn(scope.nodesPath, doc.createNode(n));
  for (const e of plain.edges) doc.addIn(scope.edgesPath, doc.createNode(e));

  return plain.nodes.map((n) => n.id);
}
