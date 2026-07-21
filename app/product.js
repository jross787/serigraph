// Pure product-planning intelligence shared by the PRD, roadmap, audit, and
// publishing surfaces. The YAML graph stays authoritative; these are views.

const PRIORITY_WEIGHT = { must: 4, should: 3, could: 2, wont: 1 };
const PHASE_WEIGHT = { now: 0, next: 1, later: 2 };
const ROADMAP_TYPES = new Set(['requirement', 'research', 'milestone', 'release']);

function riceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateRice(value) {
  const rice = value?.rice ?? value ?? {};
  const reach = riceNumber(rice.reach);
  const impact = riceNumber(rice.impact);
  const confidence = riceNumber(rice.confidence);
  const effort = riceNumber(rice.effort);
  if ([reach, impact, confidence, effort].some((part) => part == null)) return null;
  if (reach < 0 || impact < 0 || confidence < 0 || confidence > 100 || effort <= 0) return null;
  const score = (reach / effort) * impact * (confidence / 100);
  return Number.isFinite(score) ? score : null;
}

export function formatRice(score) {
  if (!Number.isFinite(score)) return 'Needs inputs';
  if (score >= 100) return Math.round(score).toLocaleString();
  if (score >= 10) return score.toFixed(1);
  return score.toFixed(2);
}

export function planningInventory(model) {
  const all = [...(model?.byId?.values?.() ?? [])];
  const items = all.filter((node) => node.planning);
  const byType = new Map();
  const byStatus = new Map();
  for (const node of items) {
    const type = node.planning.type || 'unspecified';
    const status = node.planning.status || 'unspecified';
    if (!byType.has(type)) byType.set(type, []);
    if (!byStatus.has(status)) byStatus.set(status, []);
    byType.get(type).push(node);
    byStatus.get(status).push(node);
  }
  return { all, items, byType, byStatus };
}

function roadmapItem(node) {
  const planning = node.planning;
  return {
    id: node.id,
    label: node.label,
    description: node.description,
    owner: node.owner,
    planning,
    score: calculateRice(planning?.rice),
    relationCount: node.relations.length,
  };
}

function roadmapSort(a, b) {
  const scoreA = a.score ?? -1;
  const scoreB = b.score ?? -1;
  return scoreB - scoreA
    || (PRIORITY_WEIGHT[b.planning.priority] ?? 0) - (PRIORITY_WEIGHT[a.planning.priority] ?? 0)
    || a.label.localeCompare(b.label)
    || a.id.localeCompare(b.id);
}

function isRoadmapEligible(node) {
  return Boolean(node?.planning && (ROADMAP_TYPES.has(node.planning.type)
    || (!node.planning.type && (node.planning.phase || node.planning.target))));
}

function roadmapLane(node) {
  return String(node.planning.phase || node.planning.target || 'backlog').trim().toLowerCase() || 'backlog';
}

export function buildRoadmap(model, filters = {}) {
  const { items } = planningInventory(model);
  const eligible = items.filter(isRoadmapEligible);
  const status = String(filters.status || 'all');
  const priority = String(filters.priority || 'all');
  const owner = String(filters.owner || 'all');
  const query = String(filters.query || '').trim().toLowerCase();
  const filtered = eligible.filter((node) => {
    if (status !== 'all' && node.planning.status !== status) return false;
    if (priority !== 'all' && node.planning.priority !== priority) return false;
    if (owner !== 'all' && node.owner !== owner) return false;
    if (query && !`${node.label} ${node.description} ${node.id}`.toLowerCase().includes(query)) return false;
    return true;
  });

  const groups = new Map();
  for (const node of filtered) {
    const key = roadmapLane(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(roadmapItem(node));
  }
  const standard = ['now', 'next', 'later'];
  const availableLanes = new Set(eligible.map(roadmapLane));
  const extra = [...availableLanes].filter((key) => !standard.includes(key) && key !== 'backlog').sort();
  const keys = [...standard, ...extra, ...(availableLanes.has('backlog') ? ['backlog'] : [])];
  const columns = keys
    .map((key) => ({
      id: key,
      label: key === 'backlog' ? 'Unscheduled' : key.replace(/(^|[-_])([a-z])/g, (_, p, c) => `${p ? ' ' : ''}${c.toUpperCase()}`),
      items: [...(groups.get(key) ?? [])].sort(roadmapSort),
      order: PHASE_WEIGHT[key] ?? (key === 'backlog' ? 999 : 10),
    }));

  return {
    columns,
    total: eligible.length,
    filtered: filtered.length,
    statuses: [...new Set(eligible.map((node) => node.planning.status).filter(Boolean))].sort(),
    priorities: [...new Set(eligible.map((node) => node.planning.priority).filter(Boolean))].sort((a, b) => (PRIORITY_WEIGHT[b] ?? 0) - (PRIORITY_WEIGHT[a] ?? 0)),
    owners: [...new Set(eligible.map((node) => node.owner).filter(Boolean))].sort(),
  };
}

function relationIndexes(model) {
  const outgoing = new Map();
  const incoming = new Map();
  for (const node of model?.byId?.values?.() ?? []) {
    outgoing.set(node.id, node.relations ?? []);
    for (const relation of node.relations ?? []) {
      if (!incoming.has(relation.to)) incoming.set(relation.to, []);
      incoming.get(relation.to).push({ from: node.id, type: relation.type });
    }
  }
  return { outgoing, incoming };
}

function dependencyCycles(model) {
  const edges = new Map();
  for (const node of model?.byId?.values?.() ?? []) {
    edges.set(node.id, [
      ...(node.planning?.dependsOn ?? []),
      ...(node.relations ?? []).filter((relation) => relation.type === 'depends-on').map((relation) => relation.to),
    ]);
  }
  // "A blocks B" means B depends on A, so it is the inverse direction of
  // "B depends-on A" in the dependency graph.
  for (const node of model?.byId?.values?.() ?? []) {
    for (const relation of node.relations ?? []) {
      if (relation.type === 'blocks' && edges.has(relation.to)) edges.get(relation.to).push(node.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const cycles = new Set();
  const walk = (id, trail = []) => {
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      for (const member of trail.slice(Math.max(0, start))) cycles.add(member);
      cycles.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) if (edges.has(next)) walk(next, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) walk(id);
  return cycles;
}

export function auditProductPlan(model) {
  const kind = model?.document?.kind ?? 'process';
  if (kind === 'process') return { applicable: false, score: null, state: 'Process map', issues: [], passed: 0, checks: 0 };

  const inventory = planningInventory(model);
  const issues = [];
  const severityWeight = { high: 3, medium: 2, low: 1 };
  let checks = 0;
  let passed = 0;
  let possibleWeight = 0;
  let passedWeight = 0;
  const add = (code, severity, title, detail, nodeId = null) => issues.push({ code, severity, title, detail, nodeId });
  const check = (condition, code, severity, title, detail, nodeId = null) => {
    const weight = severityWeight[severity] ?? 1;
    checks += 1;
    possibleWeight += weight;
    if (condition) {
      passed += 1;
      passedWeight += weight;
      return true;
    }
    add(code, severity, title, detail, nodeId);
    return false;
  };
  const doc = model.document;
  check(doc.summary, 'document-summary', 'high', 'Executive summary is missing', 'State the problem, proposed change, and expected outcome.');
  check(doc.audience.length, 'document-audience', 'medium', 'Audience is not named', 'Identify who will use or review this document.');
  check(doc.goals.length, 'document-goals', 'high', 'Goals are missing', 'Define the outcomes this product work must create.');
  check(doc.nonGoals.length, 'document-non-goals', 'low', 'Non-goals are missing', 'Protect the release from accidental scope expansion.');
  check(doc.successMetrics.length, 'document-metrics', 'high', 'Success metrics are missing', 'Name measurable proof that the release worked.');

  const objectives = inventory.byType.get('objective') ?? [];
  const problems = inventory.byType.get('problem') ?? [];
  const requirements = inventory.byType.get('requirement') ?? [];
  const metrics = inventory.byType.get('metric') ?? [];
  const risks = inventory.byType.get('risk') ?? [];
  const roadmapItems = inventory.items.filter(isRoadmapEligible);
  check(objectives.length, 'objective-missing', 'high', 'No product objective', 'Add at least one objective node.');
  check(problems.length, 'problem-missing', 'high', 'No problem statement', 'Add a problem node grounded in evidence.');
  check(requirements.length, 'requirements-missing', 'high', 'No requirements', 'Add requirement nodes that describe the release contract.');
  check(metrics.length, 'metric-missing', 'high', 'No metric nodes', 'Add metrics that measure the objectives.');
  check(risks.length, 'risk-missing', 'medium', 'No recorded risks', 'Make material product and delivery risks visible.');

  const { outgoing, incoming } = relationIndexes(model);
  const objectiveIds = new Set(objectives.map((node) => node.id));
  for (const node of roadmapItems) {
    const p = node.planning;
    const requirement = p.type === 'requirement';
    const prefix = requirement ? 'requirement' : 'roadmap';
    check(node.owner, `${prefix}-owner`, 'high', `${node.label} has no owner`, 'Assign one accountable person or team.', node.id);
    check(p.status, `${prefix}-status`, 'medium', `${node.label} has no status`, 'Set the current planning or delivery status.', node.id);
    check(p.phase || p.target, requirement ? 'requirement-target' : 'roadmap-schedule', 'medium', `${node.label} is unscheduled`, 'Assign a roadmap horizon or target period.', node.id);
    check(p.evidence.length, `${prefix}-evidence`, 'low', `${node.label} has no evidence`, 'Link the customer, operational, or analytical evidence behind it.', node.id);
    check(calculateRice(p.rice) != null, `${prefix}-rice`, 'low', `${node.label} is not scored`, 'Add reach, impact, confidence, and effort for transparent prioritization.', node.id);
  }

  for (const node of requirements) {
    const p = node.planning;
    check(p.acceptance.length, 'requirement-acceptance', 'high', `${node.label} has no acceptance criteria`, 'Define observable conditions that prove the requirement is complete.', node.id);
    check(p.priority, 'requirement-priority', 'medium', `${node.label} has no priority`, 'Set a Must, Should, Could, or Won’t priority.', node.id);
    const supportsObjective = (outgoing.get(node.id) ?? []).some((relation) =>
      (relation.type === 'supports' || relation.type === 'satisfies') && objectiveIds.has(relation.to));
    check(supportsObjective, 'requirement-trace', 'high', `${node.label} is not tied to an objective`, 'Add a supports or satisfies relation to an objective.', node.id);
  }

  for (const objective of objectives) {
    const hasMetric = (outgoing.get(objective.id) ?? []).some((relation) =>
      relation.type === 'measured-by' && model.byId.get(relation.to)?.planning?.type === 'metric');
    check(hasMetric, 'objective-metric', 'high', `${objective.label} has no linked metric`, 'Relate the objective to a metric using measured-by.', objective.id);
  }

  for (const risk of risks) {
    const hasMitigation = (incoming.get(risk.id) ?? []).some((relation) => relation.type === 'mitigates');
    check(hasMitigation, 'risk-mitigation', 'medium', `${risk.label} has no mitigation`, 'Relate the risk to the requirement or decision that mitigates it.', risk.id);
  }

  for (const node of inventory.items.filter((item) => item.planning.status === 'blocked')) {
    const namedBlocker = node.planning.dependsOn.length
      || node.relations.some((relation) => relation.type === 'depends-on')
      || (incoming.get(node.id) ?? []).some((relation) => relation.type === 'blocks');
    check(namedBlocker, 'blocked-dependency', 'high', `${node.label} is blocked without a dependency`, 'Record what is preventing progress.', node.id);
  }

  const cycleIds = [...dependencyCycles(model)];
  if (cycleIds.length) {
    const [first, ...rest] = cycleIds;
    check(false, 'dependency-cycle', 'high', `${model.byId.get(first)?.label ?? first} is in a dependency cycle`, 'Break the cycle before committing the roadmap.', first);
    for (const id of rest) {
      add('dependency-cycle', 'high', `${model.byId.get(id)?.label ?? id} is in a dependency cycle`, 'Break the cycle before committing the roadmap.', id);
    }
  } else {
    check(true, 'dependency-cycle', 'high', 'The plan has a dependency cycle', 'Break the cycle before committing the roadmap.');
  }

  const score = Math.max(0, Math.min(100, Math.round(100 * passedWeight / Math.max(possibleWeight, 1))));
  const state = score >= 90 && !issues.some((issue) => issue.severity === 'high') ? 'Ready'
    : score >= 68 ? 'Reviewable' : 'Draft';
  return { applicable: true, score, state, issues, passed, checks };
}

function mdText(value) {
  return String(value ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]|])/g, '\\$1');
}

function mdList(items, empty = '_Not documented._') {
  return items?.length ? items.map((item) => `- ${mdText(item)}`).join('\n') : empty;
}

export function productDocumentMarkdown(model) {
  const doc = model.document;
  const inventory = planningInventory(model);
  const audit = auditProductPlan(model);
  const requirements = inventory.byType.get('requirement') ?? [];
  const sections = [
    `# ${mdText(model.name)}`,
    mdText(doc.summary || model.description),
    `**Document:** ${mdText(doc.kind.toUpperCase())} · **Version:** ${mdText(doc.version || 'Unversioned')} · **Status:** ${mdText(doc.status || 'Draft')} · **Owner:** ${mdText(doc.owner || 'Unassigned')} · **Updated:** ${mdText(doc.updated || 'Not recorded')}`,
    '## Audience', mdList(doc.audience),
    '## Goals', mdList(doc.goals),
    '## Non-goals', mdList(doc.nonGoals),
    '## Success metrics', mdList(doc.successMetrics),
    '## Requirements',
  ];
  if (!requirements.length) sections.push('_No requirements documented._');
  for (const node of requirements) {
    const p = node.planning;
    const relations = node.relations.length
      ? node.relations.map((relation) => {
        const target = model.byId.get(relation.to);
        return `- **${mdText(relation.type)}** → ${mdText(target?.label || relation.to)} (\`${mdText(relation.to)}\`)`;
      }).join('\n')
      : '_No relations documented._';
    sections.push(
      `### ${mdText(node.label)}`,
      mdText(node.description) || '_No description._',
      `**Owner:** ${mdText(node.owner || 'Unassigned')} · **Priority:** ${mdText(p.priority || 'Unprioritized')} · **Status:** ${mdText(p.status || 'Unspecified')} · **Horizon:** ${mdText(p.phase || 'Unscheduled')} · **Target:** ${mdText(p.target || 'Not set')} · **RICE:** ${formatRice(calculateRice(p.rice))}`,
      '**Acceptance criteria**', mdList(p.acceptance),
      '**Evidence**', mdList(p.evidence),
      '**Requirement risks**', mdList(p.risks),
      '**Relations**', relations,
    );
  }
  const risks = inventory.byType.get('risk') ?? [];
  sections.push('## Risks', risks.length ? risks.map((node) => `- **${mdText(node.label)}:** ${mdText(node.description)}`).join('\n') : '_No risks documented._');
  if (audit.applicable) {
    sections.push('## Readiness audit', `**${audit.state} — ${audit.score}/100**`, audit.issues.length
      ? audit.issues.map((issue) => `- [${issue.severity.toUpperCase()}] ${mdText(issue.title)} — ${mdText(issue.detail)}`).join('\n')
      : '- No gaps detected.');
  }
  sections.push('', `_Generated from the Serigraph graph. Stable source: ${mdText(model.name)}._`);
  return sections.filter((section) => section !== '').join('\n\n') + '\n';
}
