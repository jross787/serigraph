// Central app state + a tiny event bus. Everything UI-visible lives here.
export const state = {
  standalone: typeof window !== 'undefined' && !!window.OPSMAP_STANDALONE,

  maps: [],            // [{id, name, description, nodeCount, invalid}]
  templates: [],       // [{id, name, description, nodeCount, source}]

  mapId: null,
  source: '',          // current YAML source (authoritative)
  doc: null,           // YAML Document (comment-preserving)
  model: null,         // normalized model from parseMap
  errors: [],          // parse/validation errors when model is null

  scopeId: null,       // owner node id of the scope on screen (null = root)
  selectedId: null,    // selected node id
  selectedEdge: null,  // {scopeId, index} when an edge is selected

  connectFrom: null,   // node id while in connect mode
  presenting: false,
  workspaceView: 'map', // map | brief | roadmap | audit

  // Workbench modes are intentionally ephemeral. The document remains YAML;
  // the editor state should never make a map harder to move or review.
  activeTool: 'select',
  probeStartId: null,
  probePath: null,
  ownerLanes: false,

  undoStack: [],       // previous sources
  redoStack: [],
};

const listeners = new Map();
export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },
  emit(event, ...args) {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(...args); } catch (e) { console.error(`[bus:${event}]`, e); }
    }
  },
};
