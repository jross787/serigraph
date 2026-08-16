// Flow view core — pure graph math for the isometric runtime view.
// No DOM and no app state: this runs in the browser, in Node tests, and
// inside standalone HTML exports. Everything here is presentation math over
// the parsed model; nothing is ever written back to the file.

// The "work path" is what payloads travel: steps, decisions, and the
// documents that carry work between them. People and systems support the
// path; they receive and provide handoffs but work does not originate there.
export const WORK_TYPES = new Set(['process', 'decision', 'artifact']);
export const SUPPORT_TYPES = new Set(['role', 'system']);

function adjacency(scope) {
  const nodes = scope?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = new Map(nodes.map((node) => [node.id, []]));
  const inn = new Map(nodes.map((node) => [node.id, []]));
  const edges = [];
  (scope?.edges ?? []).forEach((edge, index) => {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) return;
    edges.push({ edge, index });
    out.get(edge.from).push({ to: edge.to, index });
    inn.get(edge.to).push({ from: edge.from, index });
  });
  return { nodes, byId, out, inn, edges };
}

// Depth-first back-edge detection (on-stack test). Deterministic in node
// order, iterative so a long generated chain can't blow the stack.
function findBackEdges(nodes, out) {
  const back = new Set();
  const seen = new Set();
  const onStack = new Set();
  for (const root of nodes) {
    if (seen.has(root.id)) continue;
    const stack = [{ id: root.id, i: 0 }];
    seen.add(root.id);
    onStack.add(root.id);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = (out.get(frame.id) ?? [])[frame.i];
      if (!next) {
        onStack.delete(frame.id);
        stack.pop();
        continue;
      }
      frame.i += 1;
      if (onStack.has(next.to)) back.add(next.index);
      else if (!seen.has(next.to)) {
        seen.add(next.to);
        onStack.add(next.to);
        stack.push({ id: next.to, i: 0 });
      }
    }
  }
  return back;
}

// Where work enters this scope: steps with no incoming work-path edge.
// Edges from people and systems ("prepares", "assigned to") are support,
// not arrival, so they do not disqualify an entry point.
export function entryPoints(scope) {
  const { nodes, byId, inn } = adjacency(scope);
  return nodes
    .filter((node) => node.type === 'process')
    .filter((node) => !(inn.get(node.id) ?? []).some(({ from }) => WORK_TYPES.has(byId.get(from)?.type)))
    .map((node) => node.id);
}

// Isometric scene: a column (rank) for every node from longest-path
// layering, a centered row inside each column, and the edge list with
// back-edges marked so cycles render (and animate) without looping layout.
export function buildFlowScene(scope) {
  const { nodes, byId, out, inn, edges } = adjacency(scope);
  const back = findBackEdges(nodes, out);

  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const { edge, index } of edges) {
      if (back.has(index)) continue;
      const next = rank.get(edge.from) + 1;
      if (next > rank.get(edge.to)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // People and systems hug what they touch instead of piling into column 0:
  // a reviewer who feeds step 5 belongs beside step 5, not at the entrance.
  for (const node of nodes) {
    if (!SUPPORT_TYPES.has(node.type)) continue;
    const outs = (out.get(node.id) ?? []).map(({ to }) => rank.get(to));
    const ins = (inn.get(node.id) ?? []).map(({ from }) => rank.get(from));
    if (outs.length) rank.set(node.id, Math.max(0, Math.min(...outs) - 1));
    else if (ins.length) rank.set(node.id, Math.max(...ins) + 1);
  }

  const columns = new Map();
  for (const node of nodes) {
    const col = rank.get(node.id);
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(node);
  }

  // Keep the work path on the spine; support stands at the edges.
  const spine = (node) => (WORK_TYPES.has(node.type) ? 0 : 1);
  const row = new Map();
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    const list = columns.get(col);
    const pull = (node) => {
      const anchors = (inn.get(node.id) ?? [])
        .map(({ from }) => row.get(from))
        .filter((value) => value != null);
      if (!anchors.length) return 0;
      return anchors.reduce((sum, value) => sum + value, 0) / anchors.length;
    };
    list.sort((a, b) => spine(a) - spine(b) || pull(a) - pull(b));
    list.forEach((node, i) => row.set(node.id, i - (list.length - 1) / 2));
  }

  const sinkOf = (id) => !(out.get(id) ?? []).length;
  return {
    nodes: nodes.map((node) => ({
      node,
      // a stored flowPosition pin wins over automatic placement, exactly
      // like position: does on the Map canvas — additive and removable
      col: node.flowPosition?.col ?? rank.get(node.id),
      row: node.flowPosition?.row ?? row.get(node.id),
    })),
    edges: edges.map(({ edge, index }) => ({ edge, index, back: back.has(index) })),
    entries: entryPoints(scope),
    sinks: nodes.filter((node) => sinkOf(node.id)).map((node) => node.id),
    outgoing: out,
  };
}

// How data moves through this scope: counts per handoff kind and every
// confirmed issue. Pure derivation — an edge without kind: is simply not
// counted, and issues come only from the file.
export function integrationStats(scope) {
  const byKind = { api: 0, file: 0, manual: 0, event: 0 };
  const issues = [];
  let kinds = 0;
  (scope?.edges ?? []).forEach((edge, index) => {
    if (edge.kind && byKind[edge.kind] != null) {
      byKind[edge.kind] += 1;
      kinds += 1;
    }
    if (edge.issue) {
      issues.push({ index, from: edge.from, to: edge.to, label: edge.label || '', issue: edge.issue });
    }
  });
  return { byKind, kinds, issues };
}

// Named start-to-end walks along the work path. Path-local visited set:
// a denial-rework loop terminates, but a node reached again on a different
// branch is still allowed. Capped — this is a selector, not an enumeration
// of every path through a lattice.
export function enumerateFlows(scope, { max = 8, maxLength = 24 } = {}) {
  const { byId, out } = adjacency(scope);
  const flows = [];
  const walk = (id, nodeIds, edgeIndexes, visited) => {
    if (flows.length >= max || nodeIds.length > maxLength) return;
    const next = (out.get(id) ?? []).filter(
      ({ to }) => WORK_TYPES.has(byId.get(to)?.type) && !visited.has(to),
    );
    if (!next.length) {
      if (nodeIds.length >= 2) {
        const first = byId.get(nodeIds[0]);
        const last = byId.get(nodeIds[nodeIds.length - 1]);
        flows.push({
          name: `${first.label} → ${last.label}`,
          nodeIds: [...nodeIds],
          edgeIndexes: [...edgeIndexes],
        });
      }
      return;
    }
    for (const { to, index } of next) {
      visited.add(to);
      nodeIds.push(to);
      edgeIndexes.push(index);
      walk(to, nodeIds, edgeIndexes, visited);
      visited.delete(to);
      nodeIds.pop();
      edgeIndexes.pop();
    }
  };
  for (const id of entryPoints(scope)) {
    walk(id, [id], [], new Set([id]));
    if (flows.length >= max) break;
  }
  return flows;
}

// Spawn cadence in payloads per second. This is presentation pacing, not a
// data claim: recorded volume scales the cadence, a missing volume gets one
// slow neutral tick (never a fabricated number), and a recorded volume of
// zero emits nothing — a step that never runs stays still.
export function payloadCadence(runs, maxRuns) {
  if (runs == null || !(maxRuns > 0)) return 0.05;
  if (runs <= 0) return 0;
  return 0.05 + 0.3 * Math.sqrt(runs / maxRuns);
}

// Two-letter legend code from a label, unique within one scope.
export function codeFor(label, taken = new Set()) {
  const words = String(label || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const candidates = [];
  if (words.length >= 2) candidates.push(words[0][0] + words[1][0]);
  if (words[0]?.length >= 2) candidates.push(words[0].slice(0, 2));
  if (words[0]) candidates.push(words[0][0] + (words[1]?.[1] ?? words[0][0]));
  for (const candidate of candidates) {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  for (let i = 2; i < 10; i += 1) {
    const candidate = (words[0]?.[0] ?? 'N') + String(i);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return '··';
}

// Isometric basis. One grid step along a column and one along a row both
// project through the same 2:1 diamond, so every shape composed from these
// two vectors stays consistent. z rises straight up in pixels.
export function makeIso({ unitX = 74, unitY = 37 } = {}) {
  return (col, rowPos, z = 0) => ({
    x: (col - rowPos) * unitX,
    y: (col + rowPos) * unitY - z,
  });
}
