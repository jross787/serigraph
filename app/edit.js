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

export function findElementPath(doc, elementId) {
  const seq = doc.getIn(['elements'], true);
  if (!isSeq(seq)) return null;
  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i];
    if (isMap(item) && item.get('id') === elementId) return ['elements', i];
  }
  return null;
}

export function findDefinitionPath(doc, nodeId) {
  return findElementPath(doc, nodeId) ?? findNodePath(doc, nodeId);
}

export function findPlacementPath(doc, ownerId, elementId) {
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) return null;
  const seq = doc.getIn(scope.nodesPath, true);
  if (!isSeq(seq)) return null;
  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i];
    if (isMap(item) && item.get('use') === elementId) return [...scope.nodesPath, i];
  }
  return null;
}

function useBlockSequence(doc, path) {
  const seq = doc.getIn(path, true);
  if (isSeq(seq)) seq.flow = false;
  return seq;
}

// Returns { nodesPath, edgesPath } for the scope owned by ownerId
// (null = root). Creates/normalizes the children container when needed.
export function ensureScope(doc, ownerId, { create = true } = {}) {
  if (ownerId == null) {
    if (!doc.getIn(['nodes'], true) && create) doc.setIn(['nodes'], doc.createNode([]));
    if (!doc.getIn(['edges'], true) && create) doc.setIn(['edges'], doc.createNode([]));
    if (create) {
      useBlockSequence(doc, ['nodes']);
      useBlockSequence(doc, ['edges']);
    }
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
  if (create) {
    useBlockSequence(doc, [...childrenPath, 'nodes']);
    useBlockSequence(doc, [...childrenPath, 'edges']);
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

// Position maps stay on one line wherever a YAML node is built from a plain
// object, including palette drops and templates.
function flowPositions(node) {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = typeof pair.key === 'string' ? pair.key : pair.key?.value;
      if (key === 'position' && isMap(pair.value)) pair.value.flow = true;
      else flowPositions(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) flowPositions(item);
  }
}

export function updateDocument(fields = {}) {
  const doc = state.doc;
  if (!doc.getIn(['document'], true)) doc.setIn(['document'], doc.createNode({}));
  for (const key of ['kind', 'version', 'summary', 'owner', 'status', 'updated']) {
    if (fields[key] === undefined) continue;
    const value = String(fields[key] ?? '').trim();
    if (value) doc.setIn(['document', key], value);
    else if (doc.getIn(['document', key], true)) doc.deleteIn(['document', key]);
  }
  for (const key of ['audience', 'goals', 'nonGoals', 'successMetrics']) {
    if (fields[key] === undefined) continue;
    const values = (fields[key] ?? []).map((item) => String(item).trim()).filter(Boolean);
    if (values.length) doc.setIn(['document', key], doc.createNode(values));
    else if (doc.getIn(['document', key], true)) doc.deleteIn(['document', key]);
  }
}

export function setMapMode(mode) {
  if (mode !== 'process' && mode !== 'freeform') throw new Error(`unknown map mode "${mode}"`);
  if (state.model?.nodeCount) throw new Error('Create a new map to use a different mode');
  if (mode === 'process') {
    if (state.doc.getIn(['mode'], true)) state.doc.deleteIn(['mode']);
    if (state.doc.getIn(['elements'], true)) state.doc.deleteIn(['elements']);
  } else {
    state.doc.setIn(['mode'], mode);
    if (!state.doc.getIn(['elements'], true)) state.doc.setIn(['elements'], state.doc.createNode([]));
  }
  tidyTopOrder(state.doc);
}

// ── node object construction (key order = file convention) ──────────
function nodeToPlain(fields) {
  const obj = { id: fields.id, type: fields.type, label: fields.label };
  if (fields.description?.trim()) obj.description = fields.description;
  if (fields.owner?.trim()) obj.owner = fields.owner.trim();
  if (fields.owners?.length) obj.owners = fields.owners
    .filter((owner) => owner?.to)
    .map((owner) => ({ to: String(owner.to).trim(), role: String(owner.role || 'owner').trim() }));
  if (fields.trigger?.trim()) obj.trigger = fields.trigger.trim();
  if (fields.sla?.trim()) obj.sla = fields.sla.trim();
  if (fields.automation?.trim()) obj.automation = fields.automation.trim();
  if (fields.systems?.length) obj.systems = fields.systems.map((s) => String(s).trim()).filter(Boolean);
  if (fields.planning) {
    const planning = planningToPlain(fields.planning);
    if (Object.keys(planning).length) obj.planning = planning;
  }
  if (fields.links?.length) obj.links = fields.links.map((l) => ({ label: l.label || l.url, url: l.url }));
  if (fields.position) obj.position = { x: fields.position.x, y: fields.position.y };
  if (fields.relations?.length) obj.relations = fields.relations
    .filter((relation) => relation?.to && relation?.type)
    .map((relation) => ({ to: String(relation.to).trim(), type: String(relation.type).trim() }));
  if (fields.review?.length) obj.review = fields.review.map((r) => ({
    id: r.id,
    body: r.body,
    author: r.author || 'Reviewer',
    createdAt: r.createdAt || '',
    ...(r.resolved ? { resolved: true } : {}),
  }));
  if (fields.children) obj.children = fields.children;
  return obj;
}

function planningToPlain(value = {}) {
  const out = {};
  for (const key of ['type', 'status', 'priority', 'phase', 'target']) {
    if (String(value[key] ?? '').trim()) out[key] = String(value[key]).trim();
  }
  for (const key of ['acceptance', 'evidence', 'risks', 'dependsOn']) {
    const items = (value[key] ?? []).map((item) => String(item).trim()).filter(Boolean);
    if (items.length) out[key] = items;
  }
  const rice = {};
  for (const key of ['reach', 'impact', 'confidence', 'effort']) {
    if (value.rice?.[key] === '' || value.rice?.[key] == null) continue;
    const number = Number(value.rice[key]);
    const invalid = !Number.isFinite(number)
      || number < 0
      || (key === 'effort' && number <= 0)
      || (key === 'confidence' && number > 100);
    if (invalid) throw new Error(`planning.rice.${key} has an invalid value`);
    rice[key] = number;
  }
  if (Object.keys(rice).length) out.rice = rice;
  return out;
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

export function addElement(fields) {
  const doc = state.doc;
  if (!doc.getIn(['elements'], true)) doc.setIn(['elements'], doc.createNode([]));
  useBlockSequence(doc, ['elements']);
  const plain = nodeToPlain(fields);
  delete plain.owner;
  delete plain.position;
  delete plain.children;
  doc.addIn(['elements'], doc.createNode(plain));
  tidyTopOrder(doc);
  return fields.id;
}

export function addPlacement(ownerId, elementId, { note = '', position = null } = {}) {
  if (state.model?.mode === 'freeform' && ownerId == null) {
    throw new Error('Choose a group before adding an item');
  }
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId);
  if (!scope) throw new Error(`can't find group "${ownerId}" in the file`);
  if (findPlacementPath(doc, ownerId, elementId)) {
    throw new Error(`"${elementId}" is already in this group`);
  }
  const plain = { use: elementId };
  if (String(note).trim()) plain.note = String(note).trim();
  if (position) plain.position = { x: Math.round(position.x), y: Math.round(position.y) };
  const created = doc.createNode(plain);
  flowPositions(created);
  doc.addIn(scope.nodesPath, created);
  return elementId;
}

export function updatePlacement(ownerId, elementId, fields = {}) {
  const doc = state.doc;
  const p = findPlacementPath(doc, ownerId, elementId);
  if (!p) throw new Error(`"${elementId}" is not placed in this group`);
  if (fields.note !== undefined) {
    const note = String(fields.note ?? '').trim();
    if (note) doc.setIn([...p, 'note'], note);
    else if (doc.getIn([...p, 'note'], true)) doc.deleteIn([...p, 'note']);
  }
  tidyKeyOrder(doc, p);
}

export function updateNode(nodeId, fields) {
  const doc = state.doc;
  const p = findDefinitionPath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in file`);
  if (fields.label != null) doc.setIn([...p, 'label'], fields.label);
  if (fields.type != null) doc.setIn([...p, 'type'], fields.type);
  for (const key of ['owner', 'trigger', 'sla', 'automation']) {
    if (fields[key] === undefined) continue;
    if (String(fields[key] ?? '').trim()) doc.setIn([...p, key], String(fields[key]).trim());
    else if (doc.getIn([...p, key], true)) doc.deleteIn([...p, key]);
  }
  if (fields.owners !== undefined) {
    const owners = (fields.owners ?? [])
      .filter((owner) => owner?.to)
      .map((owner) => ({ to: String(owner.to).trim(), role: String(owner.role || 'owner').trim() }));
    if (owners.length) doc.setIn([...p, 'owners'], doc.createNode(owners));
    else if (doc.getIn([...p, 'owners'], true)) doc.deleteIn([...p, 'owners']);
  }
  if (fields.systems !== undefined) {
    const systems = (fields.systems ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (systems.length) doc.setIn([...p, 'systems'], doc.createNode(systems));
    else if (doc.getIn([...p, 'systems'], true)) doc.deleteIn([...p, 'systems']);
  }
  if (fields.planning !== undefined) {
    const planning = fields.planning ? planningToPlain(fields.planning) : {};
    if (Object.keys(planning).length) doc.setIn([...p, 'planning'], doc.createNode(planning));
    else if (doc.getIn([...p, 'planning'], true)) doc.deleteIn([...p, 'planning']);
  }
  if (fields.description !== undefined) {
    if (fields.description?.trim()) doc.setIn([...p, 'description'], fields.description);
    else if (doc.getIn([...p, 'description'], true)) doc.deleteIn([...p, 'description']);
  }
  if (fields.links !== undefined) {
    const links = (fields.links ?? []).filter((l) => l.url?.trim());
    if (links.length) doc.setIn([...p, 'links'], doc.createNode(links.map((l) => ({ label: l.label?.trim() || l.url, url: l.url }))));
    else if (doc.getIn([...p, 'links'], true)) doc.deleteIn([...p, 'links']);
  }
  if (fields.relations !== undefined) {
    const relations = (fields.relations ?? [])
      .filter((relation) => relation?.to && relation?.type)
      .map((relation) => ({ to: String(relation.to).trim(), type: String(relation.type).trim() }));
    if (relations.length) doc.setIn([...p, 'relations'], doc.createNode(relations));
    else if (doc.getIn([...p, 'relations'], true)) doc.deleteIn([...p, 'relations']);
  }
  if (fields.review !== undefined) {
    const review = (fields.review ?? []).filter((r) => r?.body?.trim()).map((r) => ({
      id: r.id || `note-${Date.now().toString(36)}`,
      body: String(r.body).trim(),
      author: String(r.author || 'Reviewer').trim() || 'Reviewer',
      createdAt: String(r.createdAt || ''),
      ...(r.resolved ? { resolved: true } : {}),
    }));
    if (review.length) doc.setIn([...p, 'review'], doc.createNode(review));
    else if (doc.getIn([...p, 'review'], true)) doc.deleteIn([...p, 'review']);
  }
  tidyKeyOrder(doc, p);
}

// Pin a node where the user dropped it: position is the node's CENTER in its
// scope's layout coordinates, written as a one-line flow map so files stay
// human-readable. Clearing it returns the node to automatic layout.
export function setNodePosition(nodeId, { x, y }, ownerId = state.scopeId) {
  const doc = state.doc;
  const p = state.model?.mode === 'freeform' && state.model.elementById?.has(nodeId)
    ? findPlacementPath(doc, ownerId, nodeId)
    : findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in this group`);
  doc.setIn([...p, 'position'], doc.createNode({ x: Math.round(x), y: Math.round(y) }, { flow: true }));
  tidyKeyOrder(doc, p);
}

export function clearNodePosition(nodeId, ownerId = state.scopeId) {
  const doc = state.doc;
  const p = state.model?.mode === 'freeform' && state.model.elementById?.has(nodeId)
    ? findPlacementPath(doc, ownerId, nodeId)
    : findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in this group`);
  if (doc.getIn([...p, 'position'], true)) doc.deleteIn([...p, 'position']);
}

// Pin a node on the Flow view's ground grid: flowPosition is the node's
// { col, row } cell, written as a one-line flow map like a node position.
// Clearing it returns the node to automatic placement in the Flow view.
export function setNodeFlowPosition(nodeId, { col, row }, ownerId = state.scopeId) {
  const doc = state.doc;
  const p = state.model?.mode === 'freeform' && state.model.elementById?.has(nodeId)
    ? findPlacementPath(doc, ownerId, nodeId)
    : findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in this group`);
  const round = (v) => Math.round(v * 100) / 100;
  doc.setIn([...p, 'flowPosition'], doc.createNode({ col: round(col), row: round(row) }, { flow: true }));
  tidyKeyOrder(doc, p);
}

export function clearNodeFlowPosition(nodeId, ownerId = state.scopeId) {
  const doc = state.doc;
  const p = state.model?.mode === 'freeform' && state.model.elementById?.has(nodeId)
    ? findPlacementPath(doc, ownerId, nodeId)
    : findNodePath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found in this group`);
  if (doc.getIn([...p, 'flowPosition'], true)) doc.deleteIn([...p, 'flowPosition']);
}

// Cost inputs (human-vs-agent economics, FORMAT.md). `fields` carries any of
// { runs, minutes, rate, perRun, setup }; a number sets, null clears, absent
// keys keep their current value. Clearing everything removes the block.
export function setNodeCost(nodeId, fields) {
  const doc = state.doc;
  const p = findDefinitionPath(doc, nodeId);
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
  const p = findDefinitionPath(doc, nodeId);
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

// keep the top level predictable across process and product documents
const TOP_ORDER = ['name', 'description', 'mode', 'document', 'costModel', 'elements', 'nodes', 'edges'];
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

export function addReviewComment(nodeId, { body, author = 'You', createdAt = new Date().toISOString() }) {
  const doc = state.doc;
  const p = findDefinitionPath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found`);
  const message = String(body || '').trim();
  if (!message) throw new Error('write a note before saving');
  const reviewPath = [...p, 'review'];
  if (!doc.getIn(reviewPath, true)) doc.setIn(reviewPath, doc.createNode([]));
  const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  doc.addIn(reviewPath, doc.createNode({ id, body: message, author: String(author || 'You').trim() || 'You', createdAt }));
  tidyKeyOrder(doc, p);
  return id;
}

export function setReviewResolved(nodeId, reviewId, resolved) {
  const doc = state.doc;
  const p = findDefinitionPath(doc, nodeId);
  if (!p) throw new Error(`node "${nodeId}" not found`);
  const review = doc.getIn([...p, 'review'], true);
  if (!isSeq(review)) throw new Error('review note not found');
  for (let i = 0; i < review.items.length; i++) {
    const item = review.items[i];
    if (isMap(item) && item.get('id') === reviewId) {
      if (resolved) doc.setIn([...p, 'review', i, 'resolved'], true);
      else if (doc.getIn([...p, 'review', i, 'resolved'], true)) doc.deleteIn([...p, 'review', i, 'resolved']);
      return;
    }
  }
  throw new Error('review note not found');
}

// keep files predictable; unknown keys keep their relative order at the end
const KEY_ORDER = [
  'id', 'type', 'label', 'description', 'owner', 'owners', 'trigger', 'sla',
  'automation', 'systems', 'planning', 'links', 'relations', 'review',
  'cost', 'note', 'position', 'flowPosition', 'children',
];
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

function removeScopeEdgesFor(doc, scope, nodeId) {
  const edges = scope ? doc.getIn(scope.edgesPath, true) : null;
  if (!isSeq(edges)) return 0;
  let removed = 0;
  for (let i = edges.items.length - 1; i >= 0; i--) {
    const edge = edges.items[i];
    if (isMap(edge) && (edge.get('from') === nodeId || edge.get('to') === nodeId)) {
      doc.deleteIn([...scope.edgesPath, i]);
      removed += 1;
    }
  }
  return removed;
}

export function removePlacement(ownerId, elementId) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  const path = findPlacementPath(doc, ownerId, elementId);
  if (!scope || !path) throw new Error(`"${elementId}" is not placed in this group`);
  const dropped = removeScopeEdgesFor(doc, scope, elementId);
  doc.deleteIn(path);
  cleanupScope(doc, ownerId);
  return { removed: true, dropped };
}

export function movePlacement(elementId, fromOwnerId, targetOwnerId) {
  if (fromOwnerId === targetOwnerId) return { moved: false, dropped: 0, lifted: 0 };
  const doc = state.doc;
  const sourcePath = findPlacementPath(doc, fromOwnerId, elementId);
  if (!sourcePath) throw new Error(`"${elementId}" is not placed in the current group`);
  if (findPlacementPath(doc, targetOwnerId, elementId)) {
    throw new Error(`"${elementId}" is already in that group`);
  }
  const note = doc.getIn([...sourcePath, 'note']) || '';
  const { dropped } = removePlacement(fromOwnerId, elementId);
  addPlacement(targetOwnerId, elementId, { note });
  return { moved: true, dropped, lifted: 0 };
}

export function deleteElement(elementId) {
  const doc = state.doc;
  const element = state.model?.elementById?.get(elementId);
  if (!element) throw new Error(`element "${elementId}" not found`);

  for (const placement of [...(state.model.placementsByElement.get(elementId) ?? [])]) {
    removePlacement(placement.ownerId, elementId);
  }

  for (const candidate of state.model.byId.values()) {
    if (candidate.id === elementId) continue;
    const candidatePath = findDefinitionPath(doc, candidate.id);
    if (!candidatePath) continue;
    for (const key of ['relations', 'owners']) {
      const listPath = [...candidatePath, key];
      const list = doc.getIn(listPath, true);
      if (!isSeq(list)) continue;
      for (let i = list.items.length - 1; i >= 0; i--) {
        const item = list.items[i];
        if (isMap(item) && item.get('to') === elementId) doc.deleteIn([...listPath, i]);
      }
      if (list.items.length === 0) doc.deleteIn(listPath);
    }
    const dependenciesPath = [...candidatePath, 'planning', 'dependsOn'];
    const dependencies = doc.getIn(dependenciesPath, true);
    if (isSeq(dependencies)) {
      for (let i = dependencies.items.length - 1; i >= 0; i--) {
        if ((dependencies.items[i]?.value ?? dependencies.items[i]) === elementId) {
          doc.deleteIn([...dependenciesPath, i]);
        }
      }
      if (dependencies.items.length === 0) doc.deleteIn(dependenciesPath);
    }
  }

  const path = findElementPath(doc, elementId);
  if (!path) throw new Error(`element "${elementId}" not found in file`);
  doc.deleteIn(path);
}

export function deleteNode(nodeId) {
  const doc = state.doc;
  const node = state.model.byId.get(nodeId);
  if (!node) throw new Error(`node "${nodeId}" not found`);
  const removedIds = new Set();
  (function collect(current) {
    removedIds.add(current.id);
    for (const child of current.children?.nodes ?? []) collect(child);
  })(node);

  // Product-document relations and dependencies can point across scopes.
  // Remove references to the full deleted subtree first so the resulting
  // document remains valid and the normal commit pipeline can save it.
  for (const candidate of state.model.byId.values()) {
    if (removedIds.has(candidate.id)) continue;
    const candidatePath = findNodePath(doc, candidate.id);
    if (!candidatePath) continue;
    for (const [tail, readValue] of [
      [['relations'], (item) => isMap(item) ? item.get('to') : null],
      [['planning', 'dependsOn'], (item) => item?.value ?? item],
    ]) {
      const listPath = [...candidatePath, ...tail];
      const list = doc.getIn(listPath, true);
      if (!isSeq(list)) continue;
      for (let i = list.items.length - 1; i >= 0; i--) {
        if (removedIds.has(readValue(list.items[i]))) doc.deleteIn([...listPath, i]);
      }
      if (list.items.length === 0) doc.deleteIn(listPath);
    }
  }
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
  if (state.model?.mode === 'freeform') return;
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
  const trimmed = label?.trim() ?? '';
  const scopeModel = ownerId == null ? state.model?.root : state.model?.byId.get(ownerId)?.children;
  if (scopeModel?.edges.some((e) => e.from === from && e.to === to && (e.label || '') === trimmed)) {
    throw new Error('That connection already exists.');
  }
  const edge = { from, to };
  if (trimmed) edge.label = trimmed;
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

// Pin an edge's route: via is a point in the scope's layout coordinates that
// the edge bends through, written as a one-line flow map like a node
// position. Clearing it returns the edge to automatic routing.
export function setEdgeVia(ownerId, index, { x, y }) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  if (!doc.getIn([...scope.edgesPath, index], true)) throw new Error('edge not found');
  doc.setIn([...scope.edgesPath, index, 'via'], doc.createNode({ x: Math.round(x), y: Math.round(y) }, { flow: true }));
}

export function clearEdgeVia(ownerId, index) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  if (doc.getIn([...scope.edgesPath, index, 'via'], true)) doc.deleteIn([...scope.edgesPath, index, 'via']);
}

// The edge's route style: curved, straight, angled, or stepped (FORMAT.md).
// Null clears the field and returns the edge to fully automatic routing.
export function setEdgeRoute(ownerId, index, style) {
  const doc = state.doc;
  const scope = ensureScope(doc, ownerId, { create: false });
  if (!scope) throw new Error('scope not found');
  if (!doc.getIn([...scope.edgesPath, index], true)) throw new Error('edge not found');
  if (style == null) {
    if (doc.getIn([...scope.edgesPath, index, 'route'], true)) doc.deleteIn([...scope.edgesPath, index, 'route']);
  } else {
    doc.setIn([...scope.edgesPath, index, 'route'], style);
  }
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
  if (templateModel.mode === 'freeform') {
    allTemplateIds.push(...templateModel.elements.map((element) => element.id));
  }
  (function collect(scope) {
    for (const node of scope.nodes) {
      if (!node.isPlacement) allTemplateIds.push(node.id);
      if (node.children) collect(node.children);
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

  const elementToPlain = (element) => nodeToPlain({
    ...element,
    id: rid(element.id),
    owners: element.owners.map((owner) => ({ ...owner, to: rid(owner.to) })),
    planning: element.planning ? {
      ...element.planning,
      dependsOn: element.planning.dependsOn.map(rid),
    } : null,
    relations: element.relations.map((relation) => ({ ...relation, to: rid(relation.to) })),
    position: null,
    children: null,
  });

  const plainScope = (scope) => ({
    nodes: scope.nodes.map((node) => {
      if (node.isPlacement) {
        return {
          use: rid(node.elementId),
          ...(node.note ? { note: node.note } : {}),
          ...(node.position ? { position: node.position } : {}),
        };
      }
      return nodeToPlain({
        ...node,
        id: rid(node.id),
        owners: node.owners.map((owner) => ({ ...owner, to: rid(owner.to) })),
        planning: node.planning ? {
          ...node.planning,
          dependsOn: node.planning.dependsOn.map(rid),
        } : null,
        relations: node.relations.map((relation) => ({ ...relation, to: rid(relation.to) })),
        children: node.children ? plainScope(node.children) : undefined,
      });
    }),
    edges: scope.edges.map((edge) => {
      const plainEdge = { from: rid(edge.from), to: rid(edge.to) };
      if (edge.label) plainEdge.label = edge.label;
      return plainEdge;
    }),
  });
  const plain = plainScope(templateModel.root);
  if (templateModel.mode === 'freeform') {
    if (model.mode !== 'freeform') throw new Error('Freeform templates can only be inserted into Freeform maps');
    if (!doc.getIn(['elements'], true)) doc.setIn(['elements'], doc.createNode([]));
    useBlockSequence(doc, ['elements']);
    for (const element of templateModel.elements) {
      doc.addIn(['elements'], doc.createNode(elementToPlain(element)));
    }
    tidyTopOrder(doc);
  }

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
