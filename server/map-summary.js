// Both ordinary and linked libraries display the same parsed map facts.
// Filesystem access stays with the caller so linked reads retain their bounds.
import { parseMap } from '../shared/model.js';
import { collectProvenance } from '../shared/provenance.js';

export function summarizeMapSource(source, fallbackName) {
  const { doc, model, errors } = parseMap(source);
  let hasFlags = false;
  try {
    const flags = collectProvenance(doc);
    hasFlags = flags.nodes.size > 0 || flags.edges.length > 0;
  } catch { /* broken YAML may not have readable comments */ }
  if (!model) return { name: fallbackName, description: '', nodeCount: 0, invalid: true,
    errorCount: errors.length, hasFlags, hasIssues: false };
  const scopes = [model.root, ...[...model.byId.values()].map(node => node.children).filter(Boolean)];
  return { name: model.name, description: model.description, nodeCount: model.nodeCount,
    kind: model.document.kind, mode: model.mode, hasFlags,
    hasIssues: scopes.some(scope => scope.edges.some(edge => edge.issue)) };
}
