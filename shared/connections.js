import { connectionPresentation } from './visual-language.js';

// One read-only neighborhood for canvas focus and inspector navigation.
// Include every occurrence of a shared element, without inventing links from
// matching labels or legacy free-text system names.
export function connectionsOf(model, selected) {
  if (!model?.byId.has(selected)) return [];
  const result = [];
  const scopes = [model.root, ...[...model.byId.values()].map(node => node.children).filter(Boolean)];
  for (const scope of scopes) (scope.edges ?? []).forEach((edge, index) => {
    if (edge.from !== selected && edge.to !== selected) return;
    const presentation = connectionPresentation(edge);
    result.push({
      target: edge.from === selected ? edge.to : edge.from,
      direction: !presentation.arrow ? 'Related' : edge.from === selected ? 'Outgoing' : 'Incoming',
      label: edge.label || presentation.label, kind: presentation.label,
      scopeId: scope.ownerId ?? null, index,
    });
  });
  for (const node of model.byId.values()) {
    for (const ref of [
      ...(node.owners ?? []).map(owner => ({ to: owner.to, label: `Owner · ${owner.role}` })),
      ...(node.relations ?? []).map(relation => ({ to: relation.to, label: relation.type.replaceAll('-', ' ') })),
      ...(node.planning?.dependsOn ?? []).map(to => ({ to, label: 'Depends on' })),
    ]) {
      if (node.id !== selected && ref.to !== selected) continue;
      result.push({ target: node.id === selected ? ref.to : node.id,
        direction: node.id === selected ? 'Outgoing' : 'Incoming', label: ref.label, kind: 'Declared relationship',
        scopeId: node.ownerId ?? null, index: null });
    }
  }
  return result;
}
