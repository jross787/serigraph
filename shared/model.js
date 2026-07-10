// Parse + validate Opsmap YAML into a normalized model.
// Runs in the browser, in Node, and inside standalone HTML exports.
import * as YAML from '../vendor/yaml.js';

export const NODE_TYPES = ['process', 'decision', 'system', 'role', 'artifact'];

const TYPE_HINTS = {
  step: 'process', stage: 'process', task: 'process', activity: 'process',
  tool: 'system', software: 'system', platform: 'system', app: 'system',
  person: 'role', team: 'role', actor: 'role', department: 'role',
  document: 'artifact', doc: 'artifact', data: 'artifact', output: 'artifact',
  choice: 'decision', branch: 'decision', gateway: 'decision',
};

export function parseMap(source) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter, keepSourceTokens: true });
  const errors = [];
  const warnings = [];

  const lineOf = (path) => {
    // walk up the path until something with a source range is found
    for (let p = [...path]; ; p.pop()) {
      try {
        const node = p.length ? doc.getIn(p, true) : doc.contents;
        if (node && node.range) return lineCounter.linePos(node.range[0]).line;
      } catch { /* keep walking up */ }
      if (!p.length) return null;
    }
  };
  const err = (path, message) => errors.push({ message, line: lineOf(path), path: path.join('.') });
  const warn = (path, message) => warnings.push({ message, line: lineOf(path), path: path.join('.') });

  for (const e of doc.errors) {
    const line = e.linePos ? e.linePos[0].line : null;
    errors.push({ message: `YAML syntax: ${e.message.split('\n')[0]}`, line, path: '' });
  }
  if (errors.length) return { doc, model: null, errors, warnings };

  const data = doc.toJS() ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    err([], 'The file must be a YAML map with "name:" and "nodes:" at the top level.');
    return { doc, model: null, errors, warnings };
  }
  if (typeof data.name !== 'string' || !data.name.trim()) {
    err(['name'], 'Missing "name:" — give the map a title, e.g. name: Acme Lending');
  }
  if (!Array.isArray(data.nodes)) {
    err(['nodes'], 'Missing "nodes:" — the top level needs a list of nodes.');
    return { doc, model: null, errors, warnings };
  }

  const byId = new Map();
  const seenIds = new Map(); // id -> first path (for duplicate messages)

  function normalizeScope(rawNodes, rawEdges, ownerId, path, depth) {
    const nodes = [];
    rawNodes.forEach((raw, i) => {
      const npath = [...path, 'nodes', i];
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        err(npath, `Node #${i + 1} here is not a map — each list item needs id, type, and label.`);
        return;
      }
      const id = raw.id;
      if (typeof id !== 'string' || !id.trim()) {
        err(npath, `A node${raw.label ? ` (label "${raw.label}")` : ''} is missing its "id:".`);
        return;
      }
      if (/[\s/#?]/.test(id)) {
        err([...npath, 'id'], `Node id "${id}" contains spaces or /#? — use kebab-case like "credit-check".`);
        return;
      }
      if (seenIds.has(id)) {
        err([...npath, 'id'], `Duplicate id "${id}" — ids must be unique across the entire file (first used at ${seenIds.get(id)}).`);
        return;
      }
      seenIds.set(id, npath.join('.') || '(top)');

      let type = raw.type;
      if (type == null) {
        err(npath, `Node "${id}" is missing its "type:" — one of: ${NODE_TYPES.join(', ')}.`);
        type = 'process';
      } else if (typeof type !== 'string' || !NODE_TYPES.includes(type)) {
        const hint = TYPE_HINTS[String(type).toLowerCase()];
        err([...npath, 'type'], `Node "${id}" has type "${type}" — must be one of: ${NODE_TYPES.join(', ')}.` + (hint ? ` (did you mean "${hint}"?)` : ''));
        type = 'process';
      }
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : null;
      if (!label) err([...npath, 'label'], `Node "${id}" is missing its "label:".`);

      const links = [];
      if (raw.links != null) {
        if (!Array.isArray(raw.links)) {
          err([...npath, 'links'], `Node "${id}": "links:" must be a list of { label, url }.`);
        } else {
          raw.links.forEach((l, j) => {
            if (typeof l === 'string') links.push({ label: l, url: l });
            else if (l && typeof l === 'object' && typeof l.url === 'string') {
              links.push({ label: typeof l.label === 'string' ? l.label : l.url, url: l.url });
            } else {
              err([...npath, 'links', j], `Node "${id}": link #${j + 1} needs a "url:".`);
            }
          });
        }
      }

      const node = {
        id, type,
        label: label ?? id,
        description: typeof raw.description === 'string' ? raw.description : '',
        links,
        children: null,
        ownerId,
        depth,
        stats: { childCount: 0, descendantCount: 0, maxDepth: 0 },
      };

      if (raw.children != null) {
        let childNodes, childEdges, cpath = [...npath, 'children'];
        if (Array.isArray(raw.children)) {
          childNodes = raw.children; childEdges = [];
        } else if (typeof raw.children === 'object') {
          childNodes = raw.children.nodes ?? [];
          childEdges = raw.children.edges ?? [];
          if (!Array.isArray(childNodes)) {
            err([...cpath, 'nodes'], `Node "${id}": "children.nodes:" must be a list.`);
            childNodes = [];
          }
          if (!Array.isArray(childEdges)) {
            err([...cpath, 'edges'], `Node "${id}": "children.edges:" must be a list.`);
            childEdges = [];
          }
          cpath = [...cpath];
        } else {
          err(cpath, `Node "${id}": "children:" must contain "nodes:" (and optionally "edges:").`);
          childNodes = []; childEdges = [];
        }
        if (childNodes.length || childEdges.length) {
          const scopePath = Array.isArray(raw.children) ? [...npath, 'children'] : [...npath, 'children'];
          node.children = normalizeScope(childNodes, childEdges, id, scopePath, depth + 1);
          node.stats.childCount = node.children.nodes.length;
          node.stats.descendantCount = node.children.nodes.reduce(
            (sum, c) => sum + 1 + c.stats.descendantCount, 0);
          node.stats.maxDepth = 1 + Math.max(0, ...node.children.nodes.map(c => c.stats.maxDepth));
        }
      }

      byId.set(id, node);
      nodes.push(node);
    });

    const siblingIds = new Set(nodes.map(n => n.id));
    const edges = [];
    (rawEdges ?? []).forEach((raw, i) => {
      const epath = [...path, 'edges', i];
      if (raw == null || typeof raw !== 'object') {
        err(epath, `Edge #${i + 1} here is not a map — each edge needs "from:" and "to:".`);
        return;
      }
      const { from, to } = raw;
      for (const [k, v] of [['from', from], ['to', to]]) {
        if (typeof v !== 'string' || !v.trim()) {
          err([...epath], `Edge #${i + 1} here is missing "${k}:".`);
          return;
        }
      }
      for (const [k, v] of [['from', from], ['to', to]]) {
        if (!siblingIds.has(v)) {
          const elsewhere = seenIds.has(v);
          err([...epath, k],
            elsewhere
              ? `Edge ${from} → ${to}: "${v}" exists but not in this scope. Edges connect siblings in the same nodes: list — draw cross-branch handoffs one level up, between the parents.`
              : `Edge ${from} → ${to}: there is no node with id "${v}"${ownerId ? ` among the children of "${ownerId}"` : ' at the top level'}.`);
          return;
        }
      }
      edges.push({ from, to, label: typeof raw.label === 'string' ? raw.label : '' });
    });

    return { ownerId, nodes, edges };
  }

  const root = normalizeScope(data.nodes, data.edges, null, [], 0);

  // Edges referencing nodes defined later in the file: normalizeScope checks
  // siblingIds after all siblings parse, so ordering is already handled.

  if (errors.length) return { doc, model: null, errors, warnings };

  const model = {
    name: data.name,
    description: typeof data.description === 'string' ? data.description : '',
    root,
    byId,
    nodeCount: byId.size,
  };
  return { doc, model, errors, warnings };
}

// Path of ancestor ids from root down to (and including) the node.
export function ancestryOf(model, nodeId) {
  const chain = [];
  let cur = model.byId.get(nodeId);
  while (cur) {
    chain.unshift(cur.id);
    cur = cur.ownerId ? model.byId.get(cur.ownerId) : null;
  }
  return chain;
}

// The scope (nodes+edges list) owned by ownerId, or the root scope for null.
export function scopeOf(model, ownerId) {
  if (ownerId == null) return model.root;
  const owner = model.byId.get(ownerId);
  return owner && owner.children ? owner.children : null;
}
