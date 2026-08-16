// Pure hash-route codec. No DOM, no state — safe to unit test in Node.
//
// #/                    — projects home
// #/map/<id>            — root scope (id may be "<project>/<map>")
// #/map/<id>/in/<node>  — inside a container node
// #/map/<id>/node/<id>  — a node, selected in its parent scope

// Read a location.hash string into a route. Always decodes safely: a
// malformed %-sequence falls back to the verbatim hash.
export function parseHash(rawHash) {
  let h;
  try { h = decodeURIComponent(rawHash || ''); }
  catch { h = rawHash || ''; }
  if (h === '#/' || h === '#' || h === '') return { home: true };
  // a map id carries at most one "/" segment (project/map)
  let m = h.match(/^#\/map\/([^/]+(?:\/[^/]+)?)\/in\/([^/]+)\/node\/(.+)$/);
  if (m) return { mapId: m[1], inId: m[2], nodeId: m[3] };
  m = h.match(/^#\/map\/([^/]+(?:\/[^/]+)?)\/node\/(.+)$/);
  if (m) return { mapId: m[1], nodeId: m[2] };
  m = h.match(/^#\/map\/([^/]+(?:\/[^/]+)?)\/in\/(.+)$/);
  if (m) return { mapId: m[1], inId: m[2] };
  m = h.match(/^#\/map\/([^/]+(?:\/[^/]+)?)/);
  if (m) return { mapId: m[1] };
  return { home: true };
}

// Build the hash string for a route. Each segment is encoded separately so
// a project id's "/" survives the round trip and stays readable in the URL.
export function buildHash({ mapId = null, inId = null, nodeId = null } = {}) {
  if (!mapId) return '#/';
  const encId = mapId.split('/').map(encodeURIComponent).join('/');
  const base = `#/map/${encId}`;
  if (nodeId && inId) return `${base}/in/${encodeURIComponent(inId)}/node/${encodeURIComponent(nodeId)}`;
  if (nodeId) return `${base}/node/${encodeURIComponent(nodeId)}`;
  if (inId) return `${base}/in/${encodeURIComponent(inId)}`;
  return base;
}
