// Comment-preserving edits against the YAML document. Every function
// mutates state.doc in place; callers serialize with doc.toString().
import { isMap, isSeq } from '../vendor/yaml.js';
import { ancestryOf, scopeOf } from '../shared/model.js';
import { stripFlagComments } from '../shared/provenance.js';
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

// position maps stay one-liners wherever a YAML node gets built from a plain
// object (palette drops, templates)
function flowPositions(node) {
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = typeof pair.key === 'string' ? pair.key : pair.key?.value;
      if (k === 'position' && isMap(pair.value)) pair.value.flow = true;
      else flowPositions(pair.value);
    }
  } else if (isSeq(node)) {
    for (const it of node.items) flowPositions(it);
  }
}

// ── node object construction (key order = file convention) ──────────
function nodeToPlain(fields) {
  const obj = { id: fields.id, type: fields.type, label: fields.label };
  if (fields.description?.trim()) obj.description = fields.description;
  if (fields.links?.length) obj.links = fields.links.map((l) => ({ label: l.label || l.url, url: l.url }));
  if (fields.position) obj.position = { x: fields.position.x, y: fields.position.y };
  if (fields.children) obj.children = fields.children;
  return obj;
}

// ── operations ───────────────────────────────────────────────────────
export function addNode(ownerId, fields) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId);
  if (!scope) throw new Error(`can't find node "${ownerId}" in the file`);
  const created = doc.createNode(nodeToPlain(fields));
  flowPositions(created);
  doc.addIn(scope.nodesPath, created);
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

// Pin a node where the user dropped it: position is the node's CENTER in its
// scope's layout coordinates, written as a one-line flow map so files stay
// human-readable. Clearing it returns the node to automatic layout.
export function setNodePosition(nodeId, { x, y }) {
  const doc = state.doc;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  doc.setIn([...p, 'position'], doc.createNode({ x: Math.round(x), y: Math.round(y) }, { flow: true }));
  tidyKeyOrder(doc, p);
}

export function clearNodePosition(nodeId) {
  const doc = state.doc;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  if (doc.getIn([...p, 'position'], true)) doc.deleteIn([...p, 'position']);
}

// Cost inputs (human-vs-agent economics, FORMAT.md). `fields` carries any of
// { runs, minutes, rate, perRun, setup }; a number sets, null clears, absent
// keys keep their current value. Clearing everything removes the block.
export function setNodeCost(nodeId, fields) {
  const doc = state.doc;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  const cur = state.model?.byId.get(nodeId)?.cost ?? {};
  const val = (v, name) => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number ≥ 0`);
    return Math.round(n * 10000) / 10000;
  };
  const merged = {
    runs: fields.runs === undefined ? cur.runs ?? null : val(fields.runs, 'Runs per month'),
    minutes: fields.minutes === undefined ? cur.minutes ?? null : val(fields.minutes, 'Human minutes per run'),
    rate: fields.rate === undefined ? cur.rate ?? null : val(fields.rate, 'Hourly rate'),
    perRun: fields.perRun === undefined ? cur.perRun ?? null : val(fields.perRun, 'Agent cost per run'),
    setup: fields.setup === undefined ? cur.setup ?? null : val(fields.setup, 'Agent setup cost'),
  };

  const obj = {};
  if (merged.runs != null) obj.runs = merged.runs;
  const human = {};
  if (merged.minutes != null) human.minutes = merged.minutes;
  if (merged.rate != null) human.rate = merged.rate;
  if (Object.keys(human).length) obj.human = human;
  const agentM = {};
  if (merged.perRun != null) agentM.perRun = merged.perRun;
  if (merged.setup != null) agentM.setup = merged.setup;
  if (Object.keys(agentM).length) obj.agent = agentM;

  if (!Object.keys(obj).length) {
    if (doc.getIn([...p, 'cost'], true)) doc.deleteIn([...p, 'cost']);
    return;
  }
  const created = doc.createNode(obj);
  for (const pair of created.items) {
    const k = typeof pair.key === 'string' ? pair.key : pair.key?.value;
    if ((k === 'human' || k === 'agent') && isMap(pair.value)) pair.value.flow = true;
  }
  doc.setIn([...p, 'cost'], created);
  tidyKeyOrder(doc, p);
}

// Map-level cost defaults: costModel: { currency: USD, defaultRate: 65 }
export function setMapCostModel({ currency, defaultRate } = {}) {
  const doc = state.doc;
  const obj = {};
  if (currency != null && String(currency).trim()) {
    const c = String(currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new Error('Currency must be a 3-letter code like USD');
    obj.currency = c;
  }
  if (defaultRate != null && String(defaultRate).trim?.() !== '') {
    const n = typeof defaultRate === 'number' ? defaultRate : Number(String(defaultRate).trim());
    if (!Number.isFinite(n) || n < 0) throw new Error('Default rate must be a number ≥ 0');
    obj.defaultRate = Math.round(n * 100) / 100;
  }
  if (!Object.keys(obj).length) {
    if (doc.getIn(['costModel'], true)) doc.deleteIn(['costModel']);
    return;
  }
  doc.setIn(['costModel'], doc.createNode(obj, { flow: true }));
  tidyTopOrder(doc);
}

// Confirming a provenance flag = removing its "# inferred:" comment. The
// human has verified the fact; the file stops carrying the doubt.
export function confirmNodeFlag(nodeId) {
  const doc = state.doc;
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  if (!stripFlagComments(doc.getIn(p, true))) throw new Error('no provenance flag on this node');
}

export function confirmEdgeFlag(ownerId, index) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  const item = doc.getIn([...scope.edgesPath, index], true);
  if (!item || !stripFlagComments(item)) throw new Error('no provenance flag on this edge');
}

// keep the top level predictable: name, description, costModel, nodes, edges
const TOP_ORDER = ['name', 'description', 'costModel', 'nodes', 'edges'];
function tidyTopOrder(doc) {
  const map = doc.contents;
  if (!isMap(map)) return;
  const rank = (pair) => {
    const key = typeof pair.key === 'string' ? pair.key : pair.key?.value;
    const i = TOP_ORDER.indexOf(key);
    return i === -1 ? TOP_ORDER.length : i;
  };
  map.items = map.items
    .map((pair, i) => [pair, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([pair]) => pair);
}

// keep files predictable: id, type, label, description, links, cost,
// position, children — unknown keys keep their relative order at the end
const KEY_ORDER = ['id', 'type', 'label', 'description', 'links', 'cost', 'position', 'children'];
function tidyKeyOrder(doc, nodePath) {
  const map = doc.getIn(nodePath, true);
  if (!isMap(map)) return;
  const rank = (pair) => {
    // parsed pairs carry Scalar keys ({value}); setIn-created pairs carry raw strings
    const key = typeof pair.key === 'string' ? pair.key : pair.key?.value;
    const i = KEY_ORDER.indexOf(key);
    return i === -1 ? KEY_ORDER.length : i;
  };
  map.items = map.items
    .map((pair, i) => [pair, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([pair]) => pair);
}

export function deleteNode(nodeId) {
  const doc = state.doc;
  const node = state.model.byId.get(nodeId);
  if (!node) throw new Error(`node "${nodeId}" not found`);
  const ownerId = node.ownerId;
  // normalize the parent scope FIRST — list-form children get rewritten to
  // map form, which would invalidate any path computed before this call
  const scope = ensureScope(doc, ownerId, { create: false });
  const p = findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
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

// ── re-nesting ───────────────────────────────────────────────────────
// Move a node (with its entire subtree) into another scope.
// targetOwnerId is a container node id, or null for the root scope.
//
// Edge policy (documented in FORMAT.md): an edge that would no longer connect
// siblings is re-homed to the nearest scope that contains both endpoints,
// each endpoint rewritten to its ancestor-or-self in that scope. Edges that
// would become self-loops, or exact duplicates of an edge already there,
// are removed instead. Edges wholly inside the moved subtree are untouched.
export function moveNode(nodeId, targetOwnerId) {
  const doc = state.doc;
  const model = state.model;
  const node = model.byId.get(nodeId);
  if (!node) throw new Error(`node "${nodeId}" not found`);
  if (targetOwnerId === nodeId) throw new Error(`can't move "${nodeId}" into itself`);
  if (targetOwnerId != null) {
    const target = model.byId.get(targetOwnerId);
    if (!target) throw new Error(`container "${targetOwnerId}" not found`);
    if (ancestryOf(model, targetOwnerId).includes(nodeId)) {
      throw new Error(`can't move "${nodeId}" inside its own sub-map`);
    }
  }
  const oldOwnerId = node.ownerId;
  if ((targetOwnerId ?? null) === (oldOwnerId ?? null)) return { moved: false, lifted: 0, dropped: 0 };

  // ── plan edge re-homing from the (pre-move) model ──────────────────
  // chain = ids from root down to the node; the node's owner chain is
  // [null, chain[0], chain[1], …] — chain[k] is the direct child of scope
  // owner (k ? chain[k-1] : null).
  const repIn = (chain, scopeOwner) => {
    if (scopeOwner == null) return chain[0];
    const i = chain.indexOf(scopeOwner);
    return i === -1 ? null : chain[i + 1] ?? null;
  };
  const movedChain = targetOwnerId == null ? [nodeId] : [...ancestryOf(model, targetOwnerId), nodeId];
  const oldScope = scopeOf(model, oldOwnerId);
  const plans = [];
  for (const e of oldScope.edges) {
    if (e.from !== nodeId && e.to !== nodeId) continue;
    const otherId = e.from === nodeId ? e.to : e.from;
    const otherChain = ancestryOf(model, otherId);
    // deepest scope owner present in both owner chains (null is always shared)
    const movedOwners = [null, ...movedChain.slice(0, -1)];
    const otherOwners = new Set([null, ...otherChain.slice(0, -1)]);
    let common = null;
    for (let i = movedOwners.length - 1; i >= 0; i--) {
      if (otherOwners.has(movedOwners[i])) { common = movedOwners[i]; break; }
    }
    const repMoved = repIn(movedChain, common);
    const repOther = repIn(otherChain, common);
    const newFrom = e.from === nodeId ? repMoved : repOther;
    const newTo = e.to === nodeId ? repMoved : repOther;
    plans.push({
      from: e.from, to: e.to, label: e.label || '',
      newFrom, newTo, common,
      drop: !newFrom || !newTo || newFrom === newTo
        || scopeOf(model, common).edges.some((x) =>
          x.from === newFrom && x.to === newTo && (x.label || '') === (e.label || '')),
    });
  }

  // ── normalize every scope we will touch BEFORE taking any paths ─────
  // (ensureScope can rewrite list-form children to map form, which shifts
  // paths inside that subtree)
  ensureScope(doc, targetOwnerId);
  for (const p of plans) {
    if (!p.drop && p.common !== oldOwnerId) ensureScope(doc, p.common);
  }
  ensureScope(doc, oldOwnerId, { create: false });

  // ── transplant the node's YAML item (keeps comments + subtree) ──────
  const nodePath = findNodePath(doc, nodeId);
  if (!nodePath) throw new Error(`node "${nodeId}" not found in file`);
  const item = doc.getIn(nodePath, true);
  doc.deleteIn(nodePath);
  const targetScope = ensureScope(doc, targetOwnerId);
  doc.addIn(targetScope.nodesPath, item);
  // its pinned position (if any) was in the old scope's plane — meaningless now
  if (item.get('position', true)) item.delete('position');

  // ── apply the edge plans ─────────────────────────────────────────────
  let lifted = 0, dropped = 0;
  const srcScope = ensureScope(doc, oldOwnerId, { create: false });
  const edgesSeq = srcScope ? doc.getIn(srcScope.edgesPath, true) : null;
  if (isSeq(edgesSeq)) {
    const pending = [...plans];
    const written = new Set(); // two edges must not lift into the same edge
    for (let i = edgesSeq.items.length - 1; i >= 0; i--) {
      const it = edgesSeq.items[i];
      if (!isMap(it)) continue;
      const k = pending.findIndex((p) => p.from === it.get('from') && p.to === it.get('to')
        && (p.label || '') === (it.get('label') ?? ''));
      if (k === -1) continue;
      const plan = pending.splice(k, 1)[0];
      const key = `${plan.common ?? ''}|${plan.newFrom}|${plan.newTo}|${plan.label}`;
      if (plan.drop || written.has(key)) {
        doc.deleteIn([...srcScope.edgesPath, i]);
        dropped++;
        continue;
      }
      written.add(key);
      if (plan.common === oldOwnerId) {
        it.set('from', plan.newFrom);
        it.set('to', plan.newTo);
        lifted++;
      } else {
        doc.deleteIn([...srcScope.edgesPath, i]);
        it.set('from', plan.newFrom);
        it.set('to', plan.newTo);
        doc.addIn(ensureScope(doc, plan.common).edgesPath, it);
        lifted++;
      }
    }
  }
  cleanupScope(doc, oldOwnerId);
  return { moved: true, lifted, dropped };
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
      position: n.position,
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
  for (const n of plain.nodes) {
    const created = doc.createNode(n);
    flowPositions(created);
    doc.addIn(scope.nodesPath, created);
  }
  for (const e of plain.edges) doc.addIn(scope.edgesPath, doc.createNode(e));

  return plain.nodes.map((n) => n.id);
}
