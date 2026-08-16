// Parse + validate Serigraph YAML into a normalized model.
// Runs in the browser, in Node, and inside standalone HTML exports.
import * as YAML from '../vendor/yaml.js';

export const MAP_MODES = ['process', 'freeform'];
export const ROUTE_STYLES = ['curved', 'straight', 'angled', 'stepped'];
export const EDGE_KINDS = ['api', 'file', 'manual', 'event'];
export const PROCESS_NODE_TYPES = ['process', 'decision', 'system', 'role', 'artifact'];
export const FREEFORM_NODE_TYPES = ['item', 'system', 'database', 'api', 'role', 'artifact'];
export const NODE_TYPES = [...new Set([...PROCESS_NODE_TYPES, ...FREEFORM_NODE_TYPES])];
export const AUTOMATION_STATES = ['manual', 'assisted', 'automated', 'at-risk'];
export const DOCUMENT_KINDS = ['process', 'prd', 'roadmap'];
export const PLANNING_TYPES = ['objective', 'problem', 'requirement', 'milestone', 'metric', 'risk', 'decision', 'research', 'release'];
export const PLAN_STATUSES = ['draft', 'discovery', 'planned', 'in-progress', 'blocked', 'validated', 'shipped', 'archived'];
export const PLAN_PRIORITIES = ['must', 'should', 'could', 'wont'];
export const HIERARCHY_RELATION_TYPES = ['part-of', 'member-of', 'variant-of'];
export const RELATION_TYPES = ['informed-by', 'supports', 'satisfies', 'depends-on', 'validated-by', 'measured-by', 'mitigates', 'blocks', 'delivers'];
export const OWNER_ROLES = ['owner', 'business', 'technical', 'data-steward'];

const TYPE_HINTS = {
  step: 'process', stage: 'process', task: 'process', activity: 'process',
  tool: 'system', software: 'system', platform: 'system', app: 'system',
  database: 'database', datastore: 'database', db: 'database',
  api: 'api', endpoint: 'api', service: 'api',
  item: 'item', box: 'item', entity: 'item', concept: 'item',
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

  const mode = typeof data.mode === 'string' ? data.mode : 'process';
  if (!MAP_MODES.includes(mode)) {
    err(['mode'], `"mode:" must be one of: ${MAP_MODES.join(', ')}.`);
  }

  const byId = new Map();
  const seenIds = new Map(); // id -> first path (for duplicate messages)
  const nodePaths = new Map();
  const elementById = new Map();
  const placementsByElement = new Map();
  const placementByKey = new Map();
  const placementPaths = new Map();

  const stringList = (raw, path, label) => {
    if (raw == null) return [];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      err(path, `${label} must be a list of text values.`);
      return [];
    }
    return raw.map((item) => item.trim()).filter(Boolean);
  };

  const documentRaw = data.document == null ? {} : data.document;
  if (documentRaw == null || typeof documentRaw !== 'object' || Array.isArray(documentRaw)) {
    err(['document'], '"document:" must be a map of product-document metadata.');
  }
  const documentData = documentRaw && typeof documentRaw === 'object' && !Array.isArray(documentRaw) ? documentRaw : {};
  const documentKind = typeof documentData.kind === 'string' ? documentData.kind : 'process';
  if (!DOCUMENT_KINDS.includes(documentKind)) {
    err(['document', 'kind'], `"document.kind:" must be one of: ${DOCUMENT_KINDS.join(', ')}.`);
  }
  const documentStatus = typeof documentData.status === 'string' ? documentData.status : '';
  if (documentStatus && !PLAN_STATUSES.includes(documentStatus)) {
    err(['document', 'status'], `"document.status:" must be one of: ${PLAN_STATUSES.join(', ')}.`);
  }
  const document = {
    kind: DOCUMENT_KINDS.includes(documentKind) ? documentKind : 'process',
    version: documentData.version == null ? '' : String(documentData.version),
    summary: typeof documentData.summary === 'string' ? documentData.summary.trim() : '',
    owner: typeof documentData.owner === 'string' ? documentData.owner.trim() : '',
    status: PLAN_STATUSES.includes(documentStatus) ? documentStatus : '',
    updated: typeof documentData.updated === 'string' ? documentData.updated.trim() : '',
    audience: stringList(documentData.audience, ['document', 'audience'], '"document.audience:"'),
    goals: stringList(documentData.goals, ['document', 'goals'], '"document.goals:"'),
    nonGoals: stringList(documentData.nonGoals, ['document', 'nonGoals'], '"document.nonGoals:"'),
    successMetrics: stringList(documentData.successMetrics, ['document', 'successMetrics'], '"document.successMetrics:"'),
  };

  const placementKey = (ownerId, elementId) => `${ownerId ?? '$root'}\u0000${elementId}`;

  const normalizePosition = (raw, path, id, field = 'position') => {
    if (raw == null) return null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { x: raw.x, y: raw.y };
    }
    err(path, `Node "${id}": "${field}:" must be a map of two numbers, e.g. ${field}: { x: 340, y: 120 }.`);
    return null;
  };

  const normalizeFlowPosition = (raw, path, id) => {
    if (raw == null) return null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && Number.isFinite(raw.col) && Number.isFinite(raw.row)) {
      return { col: raw.col, row: raw.row };
    }
    err(path, `Node "${id}": "flowPosition:" must be a map of two numbers, e.g. flowPosition: { col: 3, row: 1 }.`);
    return null;
  };

  const normalizeOwners = (raw, path, id) => {
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
      err(path, `Node "${id}": "owners:" must be a list of { to, role } references.`);
      return [];
    }
    const owners = [];
    raw.forEach((owner, index) => {
      const ownerPath = [...path, index];
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
        err(ownerPath, `Node "${id}": owner #${index + 1} must be a map.`);
        return;
      }
      const to = typeof owner.to === 'string' ? owner.to.trim() : '';
      const role = typeof owner.role === 'string' ? owner.role.trim() : 'owner';
      if (!to) err([...ownerPath, 'to'], `Node "${id}": owner #${index + 1} needs a "to:" element id.`);
      if (!OWNER_ROLES.includes(role)) {
        err([...ownerPath, 'role'], `Node "${id}": owner #${index + 1} "role:" must be one of: ${OWNER_ROLES.join(', ')}.`);
      }
      if (to && OWNER_ROLES.includes(role)) owners.push({ to, role });
    });
    return owners;
  };

  function normalizeScope(rawNodes, rawEdges, ownerId, path, depth, elementMode = false) {
    const nodes = [];
    const usedElementIds = new Set();
    rawNodes.forEach((raw, i) => {
      const npath = elementMode ? ['elements', i] : [...path, 'nodes', i];
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        err(npath, `Node #${i + 1} here is not a map.`);
        return;
      }

      if (mode === 'freeform' && !elementMode && Object.hasOwn(raw, 'use')) {
        if (ownerId == null) {
          err(npath, 'Freeform placements must be inside a group.');
          return;
        }
        const elementId = typeof raw.use === 'string' ? raw.use.trim() : '';
        if (!elementId) {
          err([...npath, 'use'], 'A placement needs a "use:" element id.');
          return;
        }
        if (usedElementIds.has(elementId)) {
          err([...npath, 'use'], `Element "${elementId}" is already placed in this group.`);
          return;
        }
        const element = elementById.get(elementId);
        if (!element) {
          err([...npath, 'use'], `Placement references unknown element "${elementId}".`);
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!['use', 'note', 'position'].includes(key)) {
            err([...npath, key], `Placement "${elementId}" cannot override "${key}". Edit the shared element instead.`);
          }
        }
        if (raw.note != null && typeof raw.note !== 'string') {
          err([...npath, 'note'], `Placement "${elementId}": "note:" must be text.`);
        }
        const key = placementKey(ownerId, elementId);
        const placement = {
          ...element,
          elementId,
          isElement: false,
          isPlacement: true,
          note: typeof raw.note === 'string' ? raw.note : '',
          position: normalizePosition(raw.position, [...npath, 'position'], elementId),
          ownerId,
          depth,
          placementKey: key,
          stats: { childCount: 0, descendantCount: 0, maxDepth: 0 },
        };
        usedElementIds.add(elementId);
        nodes.push(placement);
        placementByKey.set(key, placement);
        placementPaths.set(key, npath);
        if (!placementsByElement.has(elementId)) placementsByElement.set(elementId, []);
        placementsByElement.get(elementId).push(placement);
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
        err([...npath, 'id'], `Duplicate id "${id}" — definitions must be unique across the entire file (first used at ${seenIds.get(id)}).`);
        return;
      }
      seenIds.set(id, npath.join('.') || '(top)');
      nodePaths.set(id, npath);
      let type = raw.type;
      if (type == null) {
        err(npath, `Node "${id}" is missing its "type:" — one of: ${NODE_TYPES.join(', ')}.`);
        type = 'process';
      } else if (typeof type !== 'string' || !NODE_TYPES.includes(type)) {
        const hint = TYPE_HINTS[String(type).toLowerCase()];
        err([...npath, 'type'], `Node "${id}" has type "${type}" — must be one of: ${NODE_TYPES.join(', ')}.` + (hint ? ` (did you mean "${hint}"?)` : ''));
        type = 'process';
      }
      if (elementMode && !FREEFORM_NODE_TYPES.includes(type)) {
        err([...npath, 'type'], `Element "${id}" type must be one of: ${FREEFORM_NODE_TYPES.join(', ')}.`);
      }
      const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : null;
      if (!label) err([...npath, 'label'], `Node "${id}" is missing its "label:".`);

      let automation = typeof raw.automation === 'string' ? raw.automation : '';
      if (automation && !AUTOMATION_STATES.includes(automation)) {
        err([...npath, 'automation'], `Node "${id}": "automation:" must be one of: ${AUTOMATION_STATES.join(', ')}.`);
        automation = '';
      }
      let systems = [];
      if (raw.systems != null) {
        if (!Array.isArray(raw.systems) || raw.systems.some((s) => typeof s !== 'string')) {
          err([...npath, 'systems'], `Node "${id}": "systems:" must be a list of names.`);
        } else {
          systems = raw.systems.map((s) => s.trim()).filter(Boolean);
        }
      }

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
      const owners = normalizeOwners(raw.owners, [...npath, 'owners'], id);
      if (mode === 'freeform' && raw.owner != null) {
        err([...npath, 'owner'], `Node "${id}": use "owners:" with shared role elements instead of free-text "owner:".`);
      }
      if (mode !== 'freeform' && raw.owners != null) {
        err([...npath, 'owners'], `Node "${id}": "owners:" is available only in Freeform maps.`);
      }

      // Position and notes belong to placements or ordinary process nodes.
      if (elementMode && raw.position != null) {
        err([...npath, 'position'], `Element "${id}" cannot have a shared position. Put "position:" on each placement.`);
      }
      if (elementMode && raw.note != null) {
        err([...npath, 'note'], `Element "${id}" cannot have a shared note. Put "note:" on each placement.`);
      }
      const position = elementMode ? null : normalizePosition(raw.position, [...npath, 'position'], id);
      const flowPosition = elementMode ? null : normalizeFlowPosition(raw.flowPosition, [...npath, 'flowPosition'], id);

      // optional cost block — human-vs-agent economics inputs (FORMAT.md).
      // Missing numbers stay null (unknown ≠ zero); negatives are errors.
      let cost = null;
      if (raw.cost != null) {
        const c = raw.cost;
        if (!c || typeof c !== 'object' || Array.isArray(c)) {
          err([...npath, 'cost'], `Node "${id}": "cost:" must be a map — e.g. cost: { runs: 120, human: { minutes: 15, rate: 65 }, agent: { perRun: 0.4, setup: 1200 } }.`);
        } else {
          const num = (v, keyPath, label) => {
            if (v == null) return null;
            if (!Number.isFinite(v) || v < 0) {
              err([...npath, 'cost', ...keyPath], `Node "${id}": cost ${label} must be a number ≥ 0 (got ${JSON.stringify(v)}).`);
              return null;
            }
            return v;
          };
          const human = c.human != null && typeof c.human === 'object' && !Array.isArray(c.human) ? c.human : (c.human != null ? (err([...npath, 'cost', 'human'], `Node "${id}": "cost.human:" must be a map like { minutes: 15, rate: 65 }.`), {}) : {});
          const agent = c.agent != null && typeof c.agent === 'object' && !Array.isArray(c.agent) ? c.agent : (c.agent != null ? (err([...npath, 'cost', 'agent'], `Node "${id}": "cost.agent:" must be a map like { perRun: 0.4, setup: 1200 }.`), {}) : {});
          cost = {
            runs: num(c.runs, ['runs'], '"runs" (executions per month)'),
            minutes: num(human.minutes, ['human', 'minutes'], '"human.minutes" (person-minutes per run)'),
            rate: num(human.rate, ['human', 'rate'], '"human.rate" (loaded $/hour)'),
            perRun: num(agent.perRun, ['agent', 'perRun'], '"agent.perRun" ($ per run)'),
            setup: num(agent.setup, ['agent', 'setup'], '"agent.setup" (one-time $ to build)'),
          };
          if (Object.values(cost).every((v) => v == null)) cost = null; // empty block = no data
        }
      }

      const relations = [];
      if (raw.relations != null) {
        const relationPath = [...npath, 'relations'];
        const allowedRelationTypes = elementMode ? HIERARCHY_RELATION_TYPES : RELATION_TYPES;
        if (!Array.isArray(raw.relations)) {
          err(relationPath, `Node "${id}": "relations:" must be a list of { to, type } references.`);
        } else {
          raw.relations.forEach((relation, j) => {
            const rpath = [...relationPath, j];
            if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
              err(rpath, `Node "${id}": relation #${j + 1} must be a map.`);
              return;
            }
            const to = typeof relation.to === 'string' ? relation.to.trim() : '';
            const type = typeof relation.type === 'string' ? relation.type.trim() : '';
            if (!to) err([...rpath, 'to'], `Node "${id}": relation #${j + 1} needs a "to:" node id.`);
            if (!allowedRelationTypes.includes(type)) {
              err([...rpath, 'type'], `Node "${id}": relation #${j + 1} "type:" must be one of: ${allowedRelationTypes.join(', ')}.`);
            }
            if (to && allowedRelationTypes.includes(type)) relations.push({ to, type });
          });
        }
      }

      const review = [];
      if (raw.review != null) {
        if (!Array.isArray(raw.review)) {
          err([...npath, 'review'], `Node "${id}": "review:" must be a list of notes.`);
        } else {
          raw.review.forEach((item, j) => {
            const rpath = [...npath, 'review', j];
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              err(rpath, `Node "${id}": review note #${j + 1} must be a map.`);
              return;
            }
            const body = typeof item.body === 'string' ? item.body.trim() : '';
            if (!body) {
              err([...rpath, 'body'], `Node "${id}": review note #${j + 1} needs a "body:".`);
              return;
            }
            review.push({
              id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `note-${j + 1}`,
              body,
              author: typeof item.author === 'string' && item.author.trim() ? item.author.trim() : 'Reviewer',
              createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
              resolved: item.resolved === true,
            });
          });
        }
      }

      let planning = null;
      if (raw.planning != null) {
        const ppath = [...npath, 'planning'];
        if (typeof raw.planning !== 'object' || Array.isArray(raw.planning)) {
          err(ppath, `Node "${id}": "planning:" must be a map.`);
        } else {
          const p = raw.planning;
          const planningType = typeof p.type === 'string' ? p.type : '';
          const status = typeof p.status === 'string' ? p.status : '';
          const priority = typeof p.priority === 'string' ? p.priority : '';
          if (planningType && !PLANNING_TYPES.includes(planningType)) {
            err([...ppath, 'type'], `Node "${id}": "planning.type:" must be one of: ${PLANNING_TYPES.join(', ')}.`);
          }
          if (status && !PLAN_STATUSES.includes(status)) {
            err([...ppath, 'status'], `Node "${id}": "planning.status:" must be one of: ${PLAN_STATUSES.join(', ')}.`);
          }
          if (priority && !PLAN_PRIORITIES.includes(priority)) {
            err([...ppath, 'priority'], `Node "${id}": "planning.priority:" must be one of: ${PLAN_PRIORITIES.join(', ')}.`);
          }
          const riceRaw = p.rice == null ? {} : p.rice;
          if (riceRaw == null || typeof riceRaw !== 'object' || Array.isArray(riceRaw)) {
            err([...ppath, 'rice'], `Node "${id}": "planning.rice:" must be a map.`);
          }
          const rice = {};
          const riceData = riceRaw && typeof riceRaw === 'object' && !Array.isArray(riceRaw) ? riceRaw : {};
          for (const key of ['reach', 'impact', 'confidence', 'effort']) {
            if (riceData[key] == null || riceData[key] === '') continue;
            const invalid = typeof riceData[key] !== 'number'
              || !Number.isFinite(riceData[key])
              || riceData[key] < 0
              || (key === 'effort' && riceData[key] <= 0)
              || (key === 'confidence' && riceData[key] > 100);
            if (invalid) {
              const rule = key === 'effort' ? 'a number greater than zero'
                : key === 'confidence' ? 'a number from 0 to 100'
                  : 'a non-negative number';
              err([...ppath, 'rice', key], `Node "${id}": "planning.rice.${key}:" must be ${rule}.`);
            } else {
              rice[key] = riceData[key];
            }
          }
          planning = {
            type: PLANNING_TYPES.includes(planningType) ? planningType : '',
            status: PLAN_STATUSES.includes(status) ? status : '',
            priority: PLAN_PRIORITIES.includes(priority) ? priority : '',
            phase: typeof p.phase === 'string' ? p.phase.trim() : '',
            target: typeof p.target === 'string' ? p.target.trim() : '',
            acceptance: stringList(p.acceptance, [...ppath, 'acceptance'], `Node "${id}": "planning.acceptance:"`),
            evidence: stringList(p.evidence, [...ppath, 'evidence'], `Node "${id}": "planning.evidence:"`),
            risks: stringList(p.risks, [...ppath, 'risks'], `Node "${id}": "planning.risks:"`),
            dependsOn: stringList(p.dependsOn, [...ppath, 'dependsOn'], `Node "${id}": "planning.dependsOn:"`),
            rice,
          };
        }
      }

      const node = {
        id, type,
        label: label ?? id,
        description: typeof raw.description === 'string' ? raw.description : '',
        owner: typeof raw.owner === 'string' ? raw.owner.trim() : '',
        owners,
        trigger: typeof raw.trigger === 'string' ? raw.trigger.trim() : '',
        sla: typeof raw.sla === 'string' ? raw.sla.trim() : '',
        automation,
        systems,
        links,
        position,
        flowPosition,
        cost,
        relations,
        review,
        planning,
        note: '',
        elementId: elementMode ? id : null,
        isElement: elementMode,
        isPlacement: false,
        children: null,
        ownerId,
        depth,
        stats: { childCount: 0, descendantCount: 0, maxDepth: 0 },
      };

      if (elementMode && raw.children != null) {
        err([...npath, 'children'], `Element "${id}" cannot contain a group. Use "part-of" to describe item hierarchy.`);
      } else if (raw.children != null) {
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
        } else {
          err(cpath, `Node "${id}": "children:" must contain "nodes:" and optionally "edges:".`);
          childNodes = []; childEdges = [];
        }
        if (childNodes.length || childEdges.length || mode === 'freeform') {
          node.children = normalizeScope(childNodes, childEdges, id, [...npath, 'children'], depth + 1);
          node.stats.childCount = node.children.nodes.length;
          node.stats.descendantCount = node.children.nodes.reduce(
            (sum, child) => sum + 1 + child.stats.descendantCount, 0);
          node.stats.maxDepth = 1 + Math.max(0, ...node.children.nodes.map((child) => child.stats.maxDepth));
        }
      }
      if (mode === 'freeform' && !elementMode && !node.children) {
        err(npath, `Freeform node "${id}" must be a group with "children:". Put reusable items in "elements:" and place them with "use: ${id}".`);
      }

      byId.set(id, node);
      if (elementMode) elementById.set(id, node);
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
      const route = raw.route == null ? null : String(raw.route);
      if (route != null && !ROUTE_STYLES.includes(route)) {
        err([...epath, 'route'], `Edge ${from} → ${to}: "route:" must be one of: ${ROUTE_STYLES.join(', ')}.`);
      }
      const kind = raw.kind == null ? null : String(raw.kind);
      if (kind != null && !EDGE_KINDS.includes(kind)) {
        err([...epath, 'kind'], `Edge ${from} → ${to}: "kind:" must be one of: ${EDGE_KINDS.join(', ')}.`);
      }
      let issue = null;
      if (raw.issue != null) {
        if (typeof raw.issue === 'string') {
          issue = raw.issue.trim() || null;
        } else {
          err([...epath, 'issue'], `Edge ${from} → ${to}: "issue:" must be a string.`);
        }
      }
      edges.push({
        from, to,
        label: typeof raw.label === 'string' ? raw.label : '',
        via: normalizePosition(raw.via, [...epath, 'via'], `${from} → ${to}`, 'via'),
        route: ROUTE_STYLES.includes(route) ? route : null,
        kind: EDGE_KINDS.includes(kind) ? kind : null,
        issue,
      });
    });

    return { ownerId, nodes, edges };
  }

  let elements = [];
  if (mode === 'freeform') {
    if (!Array.isArray(data.elements)) {
      err(['elements'], 'Freeform maps need a top-level "elements:" list.');
    }
    elements = normalizeScope(Array.isArray(data.elements) ? data.elements : [], [], null, [], 0, true).nodes;
  } else if (data.elements != null) {
    err(['elements'], '"elements:" is available only in Freeform maps.');
  }
  const root = normalizeScope(data.nodes, data.edges, null, [], 0);

  for (const node of byId.values()) {
    for (const relation of node.relations) {
      if (!byId.has(relation.to)) {
        const path = nodePaths.get(node.id) ?? [];
        err([...path, 'relations'], `Node "${node.id}": relation target "${relation.to}" does not exist in this document.`);
      }
    }
    for (const owner of node.owners) {
      const target = elementById.get(owner.to);
      const path = nodePaths.get(node.id) ?? [];
      if (!target) {
        err([...path, 'owners'], `Node "${node.id}": owner target "${owner.to}" is not a shared element.`);
      } else if (target.type !== 'role') {
        err([...path, 'owners'], `Node "${node.id}": owner target "${owner.to}" must have type "role".`);
      }
    }
    if (node.isElement) {
      for (const relation of node.relations) {
        const path = nodePaths.get(node.id) ?? [];
        if (!HIERARCHY_RELATION_TYPES.includes(relation.type)) {
          err([...path, 'relations'], `Element "${node.id}": relation type must be one of: ${HIERARCHY_RELATION_TYPES.join(', ')}.`);
        } else if (!elementById.has(relation.to)) {
          err([...path, 'relations'], `Element "${node.id}": "${relation.type}" target "${relation.to}" must be a shared element.`);
        }
      }
    }
    for (const dependencyId of node.planning?.dependsOn ?? []) {
      if (!byId.has(dependencyId)) {
        const path = nodePaths.get(node.id) ?? [];
        err([...path, 'planning', 'dependsOn'], `Node "${node.id}": dependency "${dependencyId}" does not exist in this document.`);
      }
    }
  }

  // Edges referencing nodes defined later in the file: normalizeScope checks
  // siblingIds after all siblings parse, so ordering is already handled.

  // optional map-level cost defaults (see docs/FORMAT.md — cost model)
  let costModel = null;
  if (data.costModel != null) {
    const cm = data.costModel;
    if (!cm || typeof cm !== 'object' || Array.isArray(cm)) {
      err(['costModel'], '"costModel:" must be a map — e.g. costModel: { currency: USD, defaultRate: 65 }.');
    } else {
      costModel = {};
      if (cm.currency != null) {
        if (typeof cm.currency === 'string' && /^[A-Za-z]{3}$/.test(cm.currency.trim())) {
          costModel.currency = cm.currency.trim().toUpperCase();
        } else {
          err(['costModel', 'currency'], `"costModel.currency:" must be a 3-letter code like USD or EUR (got ${JSON.stringify(cm.currency)}).`);
        }
      }
      if (cm.defaultRate != null) {
        if (Number.isFinite(cm.defaultRate) && cm.defaultRate >= 0) {
          costModel.defaultRate = cm.defaultRate;
        } else {
          err(['costModel', 'defaultRate'], `"costModel.defaultRate:" must be a number ≥ 0 — the loaded $/hour used when a node's cost omits human.rate.`);
        }
      }
      if (Object.keys(costModel).length === 0) costModel = null;
    }
  }

  if (errors.length) return { doc, model: null, errors, warnings };

  const model = {
    name: data.name,
    mode: MAP_MODES.includes(mode) ? mode : 'process',
    description: typeof data.description === 'string' ? data.description : '',
    costModel,
    document,
    root,
    byId,
    elements,
    elementById,
    placementsByElement,
    placementByKey,
    placementPaths,
    placementCount: placementByKey.size,
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

export function placementInScope(model, ownerId, elementId) {
  return model?.placementByKey?.get(`${ownerId ?? '$root'}\u0000${elementId}`) ?? null;
}

export function placementsOf(model, elementId) {
  return model?.placementsByElement?.get(elementId) ?? [];
}
