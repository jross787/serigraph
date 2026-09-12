// A small, shared vocabulary for authoring, inspection, and the map legend.
// These are descriptions of declared structure, never observed health.
export const NODE_VISUALS = {
  process: { label: 'Step', group: 'Flow', shape: 'Rounded rectangle', hint: 'Work that happens. Name it with a verb.', example: 'Review request' },
  decision: { label: 'Decision', group: 'Flow', shape: 'Diamond', hint: 'A question with labeled paths to the next steps.', example: 'Ready to proceed?' },
  event: { label: 'Event', group: 'Flow', shape: 'Circle', hint: 'Something that starts, finishes, or interrupts work.', example: 'Request received' },
  role: { label: 'Person or team', group: 'People', shape: 'Capsule', hint: 'Who does the work or is accountable for it.', example: 'Service team' },
  system: { label: 'Application', group: 'Resources', shape: 'Window', hint: 'A tool or platform people and processes use.', example: 'Work console' },
  database: { label: 'Data store', group: 'Resources', shape: 'Cylinder', hint: 'Where information is stored.', example: 'Request database' },
  api: { label: 'Interface / API', group: 'Resources', shape: 'Hexagon', hint: 'An addressable interface, not the transfer itself.', example: 'Requests API' },
  artifact: { label: 'Document or data', group: 'Resources', shape: 'Folded document', hint: 'Information that work consumes or produces.', example: 'Completion record' },
  item: { label: 'Concept', group: 'Structure', shape: 'Card', hint: 'A named concept when a more specific type does not fit.', example: 'Customer experience' },
};

export const CONNECTION_MEANINGS = {
  flow: { label: 'Process flow', hint: 'What happens next. From a decision, label the outcome.', stroke: 'solid', arrow: true },
  data: { label: 'Data transfer', hint: 'Information moves in this direction. Label the payload; record API, file, or event as the method.', stroke: 'dashed', arrow: true },
  'reports-to': { label: 'Reports to', hint: 'Person or team → their manager or parent team. This is an organizational relationship.', stroke: 'solid', arrow: true },
  association: { label: 'Association', hint: 'A relationship without sequence or transfer. Label it with a verb such as “uses”.', stroke: 'solid', arrow: false },
};

export const nodeTypeLabel = (type) => NODE_VISUALS[type]?.label ?? type;

export function connectionPresentation(edge = {}) {
  return CONNECTION_MEANINGS[edge.meaning] ?? {
    label: 'Connection · meaning unspecified',
    hint: 'An existing directional connection. Choose its meaning explicitly; it is not evidence of activity.',
    stroke: 'solid', arrow: true,
  };
}

// Preserve legacy paths, but don't treat organizational relationships as
// work/data flow. Direction alone is not a process or a measured transfer.
export function carriesFlow(edge) {
  return edge.meaning == null || edge.meaning === 'flow' || edge.meaning === 'data';
}
