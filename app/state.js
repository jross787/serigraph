// Central app state + a tiny event bus. Everything UI-visible lives here.
export const state = {
  standalone: typeof window !== 'undefined' && !!window.OPSMAP_STANDALONE,

  maps: [],            // [{id, name, description, nodeCount, invalid, project, hasFlags, hasIssues}]
  projects: [],        // [{slug, name, mapCount}]
  templates: [],       // [{id, name, description, nodeCount, source}]
  trash: [],           // [{id, kind, name, originalId|originalSlug, deletedAt, mapCount}]

  mapId: null,
  source: '',          // current YAML source (authoritative)
  doc: null,           // YAML Document (comment-preserving)
  model: null,         // normalized model from parseMap
  errors: [],          // parse/validation errors when model is null

  scopeId: null,       // owner node id of the scope on screen (null = root)
  selectedId: null,    // selected node id
  selectedEdge: null,  // {scopeId, index} when an edge is selected
  selectionIds: new Set(), // multi-select members; empty = single selection via selectedId

  connectFrom: null,   // node id while in connect mode
  pendingEdgeLabel: null, // branch label to apply when a connect completes
  presenting: false,
  workspaceView: 'map', // map | flow | brief | roadmap | audit

  // Workbench modes are intentionally ephemeral. The document remains YAML;
  // the editor state should never make a map harder to move or review.
  activeTool: 'select',
  probeStartId: null,
  probePath: null,
  ownerLanes: false,

  undoStack: [],       // [{source, label}] actions available to undo
  redoStack: [],       // [{source, label}] actions available to redo
  saveStatus: 'idle',  // idle | saving | saved | error
  saveError: '',
  workbench: null,     // active Workbench link metadata; the share key stays browser-local
};

// The project slug of the open map, or null for a root map / no map.
// Map ids are "<projectSlug>/<mapSlug>" for project maps, plain otherwise.
export function currentProjectSlug() {
  const id = state.mapId;
  if (!id) return null;
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : null;
}

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
