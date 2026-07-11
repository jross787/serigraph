// Provenance flags: inline "# inferred:" / "# assumption:" / "# uncertain:"
// comments on nodes and edges (see docs/FORMAT.md). Shared by the importer's
// review step and the app (badges + confirm buttons). Comment-preserving by
// nature — the flag IS the comment.
import { isMap, isSeq } from '../vendor/yaml.js';

// anchored to the start of the comment: "# inferred: x" is a flag,
// "# see the assumptions doc" is just a comment and must never be
// collected as provenance or deleted by "Mark confirmed"
export const FLAG_RE = /^\s*(inferred|assumption|low[\s-]?confidence|uncertain)\b[:\s—–-]*(.*)/i;

function noteOf(yamlNode) {
  if (!yamlNode || typeof yamlNode !== 'object') return null;
  for (const c of [yamlNode.comment, yamlNode.commentBefore]) {
    if (typeof c === 'string') {
      const m = c.match(FLAG_RE);
      if (m) return (m[2] || m[1]).trim() || m[1];
    }
  }
  return null;
}

// a flag comment anywhere on the item's own lines (not its children)
function anyNote(mapNode) {
  let found = noteOf(mapNode);
  if (found) return found;
  for (const pair of mapNode.items ?? []) {
    found = noteOf(pair.key) ?? noteOf(pair.value);
    if (found) return found;
  }
  return null;
}

// → { nodes: Map<id, note>, edges: [{ owner, from, to, note }] }
export function collectProvenance(doc) {
  const nodes = new Map();
  const edges = [];

  const walkScope = (nodesSeq, edgesSeq, ownerId) => {
    if (isSeq(edgesSeq)) {
      for (const item of edgesSeq.items) {
        if (!isMap(item)) continue;
        const note = anyNote(item);
        if (note) edges.push({ owner: ownerId, from: item.get('from'), to: item.get('to'), note });
      }
    }
    if (!isSeq(nodesSeq)) return;
    for (const item of nodesSeq.items) {
      if (!isMap(item)) continue;
      const id = item.get('id');
      const note = anyNote(item);
      if (note && id) nodes.set(id, note);
      const children = item.get('children', true);
      if (isMap(children)) walkScope(children.get('nodes', true), children.get('edges', true), id);
      else if (isSeq(children)) walkScope(children, null, id);
    }
  };

  walkScope(doc.getIn(['nodes'], true), doc.getIn(['edges'], true), null);
  return { nodes, edges };
}

// strip every flag comment on the item's own lines; returns true if any removed
export function stripFlagComments(mapNode) {
  let removed = false;
  const strip = (yamlNode) => {
    if (!yamlNode || typeof yamlNode !== 'object') return;
    if (typeof yamlNode.comment === 'string' && FLAG_RE.test(yamlNode.comment)) {
      yamlNode.comment = undefined;
      removed = true;
    }
    if (typeof yamlNode.commentBefore === 'string' && FLAG_RE.test(yamlNode.commentBefore)) {
      yamlNode.commentBefore = undefined;
      removed = true;
    }
  };
  strip(mapNode);
  for (const pair of mapNode.items ?? []) {
    strip(pair.key);
    strip(pair.value);
  }
  return removed;
}
