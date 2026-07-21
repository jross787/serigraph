// Product-document workspace: multiple useful readings of the same YAML graph.
// Map is the authoring surface; Brief, Roadmap, and Audit are deterministic views.
import { state, bus } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import * as canvas from './canvas.js';
import {
  auditProductPlan,
  buildRoadmap,
  calculateRice,
  formatRice,
  planningInventory,
  productDocumentMarkdown,
} from './product.js';

const VIEWS = ['map', 'brief', 'roadmap', 'audit'];
let filters = { status: 'all', priority: 'all', owner: 'all', query: '' };
let auditSeverity = 'all';
let dialogFieldId = 0;
let roadmapSearchComposing = false;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function labelize(value) {
  const normalized = String(value || 'Unspecified');
  if (normalized.toLowerCase() === 'prd') return 'PRD';
  return normalized.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function splitLines(value) {
  return String(value || '').split('\n').map((item) => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
}

function pill(text, cls = '') {
  return h('span', { class: `product-pill ${cls}`.trim() }, text);
}

function sectionHeading(eyebrow, title, description = '') {
  return h('div', { class: 'product-section-heading' },
    h('span', {}, eyebrow),
    h('h2', {}, title),
    description ? h('p', {}, description) : null);
}

function metricCard(label, value, detail = '') {
  return h('article', { class: 'product-metric' },
    h('span', {}, label), h('strong', {}, String(value)), detail ? h('small', {}, detail) : null);
}

function makeDialog(title, body, actions = []) {
  const root = document.getElementById('dialog-root');
  const returnFocus = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    root.replaceChildren();
    returnFocus?.focus?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.disabled && !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const panel = h('div', { class: 'dialog workbench-dialog product-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'workbench-dialog-head' }, h('h2', {}, title), h('button', { onClick: close }, 'Close')),
    body,
    actions.length ? h('div', { class: 'dialog-actions product-dialog-actions' }, actions.map((action) => h('button', {
      class: `d-btn${action.primary ? ' primary' : ''}`,
      onClick: async () => {
        if (!action.onClick) return close();
        const result = await action.onClick();
        if (result !== false) close();
      },
    }, action.label))) : null);
  for (const field of panel.querySelectorAll('.f-field')) {
    const label = field.querySelector('label');
    const control = field.querySelector('input, textarea, select');
    if (!label || !control) continue;
    if (!control.id) control.id = `product-dialog-field-${++dialogFieldId}`;
    label.htmlFor = control.id;
  }
  const backdrop = h('div', { class: 'dialog-backdrop', onClick: (event) => { if (event.target === backdrop) close(); } }, panel);
  root.replaceChildren(backdrop);
  document.addEventListener('keydown', onKey, true);
  panel.querySelector('input, textarea, select, button')?.focus();
  return close;
}

function productHeader(kicker) {
  const model = state.model;
  const doc = model.document;
  const audit = auditProductPlan(model);
  return h('header', { class: 'product-hero' },
    h('div', { class: 'product-hero-copy' },
      h('span', { class: 'product-kicker' }, kicker),
      h('h1', {}, model.name),
      h('p', {}, doc.summary || model.description || 'A living product document generated from the Serigraph graph.'),
      h('div', { class: 'product-meta' },
        pill(labelize(doc.kind), 'kind'),
        doc.version ? pill(`Version · ${doc.version}`) : null,
        pill(labelize(doc.status || 'draft'), `status-${doc.status || 'draft'}`),
        doc.owner ? pill(`Owner · ${doc.owner}`) : null,
        doc.updated ? pill(`Updated · ${doc.updated}`) : null)),
    h('div', { class: 'product-hero-actions' },
      audit.applicable ? h('button', { class: `readiness-badge readiness-${audit.state.toLowerCase()}`, onClick: () => setWorkspaceView('audit') },
        h('span', {}, audit.state), h('strong', {}, `${audit.score}`), h('small', {}, 'readiness')) : null,
      state.standalone ? null : h('button', { class: 'd-btn', onClick: openDocumentEditor }, 'Edit document'),
      h('button', { class: 'd-btn primary', onClick: downloadMarkdown }, 'Download Markdown')));
}

function bulletSection(title, items, empty) {
  return h('section', { class: 'product-prose-section' },
    h('h3', {}, title),
    items.length ? h('ul', {}, items.map((item) => h('li', {}, item))) : h('p', { class: 'product-empty-copy' }, empty));
}

function relationChips(node) {
  const links = node.relations.map((relation) => ({
    direction: 'outgoing',
    nodeId: relation.to,
    type: relation.type,
    other: state.model.byId.get(relation.to),
  }));
  for (const source of state.model.byId.values()) {
    if (source.id === node.id) continue;
    for (const relation of source.relations) {
      if (relation.to === node.id) links.push({
        direction: 'incoming',
        nodeId: source.id,
        type: relation.type,
        other: source,
      });
    }
  }
  if (!links.length) return null;
  return h('div', { class: 'relation-chips', 'aria-label': 'Traceability relations' }, links.map((relation) => {
    const otherLabel = relation.other?.label ?? relation.nodeId;
    const description = relation.direction === 'outgoing'
      ? `Outgoing relation: ${node.label} ${relation.type} ${otherLabel}`
      : `Incoming relation: ${otherLabel} ${relation.type} ${node.label}`;
    return h('button', {
      onClick: () => locateNode(relation.nodeId),
      title: description,
      'aria-label': `${description}. Locate ${otherLabel}`,
    },
    h('span', {}, relation.direction === 'outgoing' ? `${labelize(relation.type)} →` : `← ${labelize(relation.type)} from`),
    otherLabel);
  }));
}

function requirementCard(node, { compact = false } = {}) {
  const p = node.planning;
  const score = calculateRice(p.rice);
  return h('article', { class: `requirement-card${compact ? ' compact' : ''}`, 'data-node-id': node.id },
    h('div', { class: 'requirement-topline' },
      h('div', {}, pill(labelize(p.priority || 'unprioritized'), `priority-${p.priority || 'none'}`), pill(labelize(p.status || 'draft'))),
      h('span', { class: 'rice-inline' }, `RICE ${formatRice(score)}`)),
    h('h3', {}, node.label),
    node.description ? h('p', {}, node.description) : null,
    compact ? null : h('dl', { class: 'requirement-facts' },
      h('div', {}, h('dt', {}, 'Owner'), h('dd', {}, node.owner || 'Unassigned')),
      h('div', {}, h('dt', {}, 'Horizon'), h('dd', {}, labelize(p.phase || 'Unscheduled'))),
      h('div', {}, h('dt', {}, 'Target'), h('dd', {}, p.target || 'Not set')),
      h('div', {}, h('dt', {}, 'Acceptance'), h('dd', {}, `${p.acceptance.length} checks`))),
    compact || !p.acceptance.length ? null : h('ul', { class: 'acceptance-list' }, p.acceptance.map((item) => h('li', {}, item))),
    compact || (!p.evidence.length && !p.risks.length) ? null : h('div', { class: 'requirement-proof' },
      p.evidence.length ? h('section', {}, h('span', {}, 'Evidence'), h('ul', {}, p.evidence.map((item) => h('li', {}, item)))) : null,
      p.risks.length ? h('section', {}, h('span', {}, 'Risks'), h('ul', {}, p.risks.map((item) => h('li', {}, item)))) : null),
    compact ? null : relationChips(node),
    h('div', { class: 'requirement-actions' },
      h('button', { onClick: () => locateNode(node.id) }, 'Locate on map'),
      state.standalone ? null : h('button', { onClick: () => openRiceEditor(node.id) }, 'Edit score')));
}

function renderBrief(panel) {
  const model = state.model;
  const doc = model.document;
  const inventory = planningInventory(model);
  const audit = auditProductPlan(model);
  const requirements = inventory.byType.get('requirement') ?? [];
  const problems = inventory.byType.get('problem') ?? [];
  const objectives = inventory.byType.get('objective') ?? [];
  const metrics = inventory.byType.get('metric') ?? [];
  const risks = inventory.byType.get('risk') ?? [];
  const decisions = inventory.byType.get('decision') ?? [];

  const overview = h('div', { class: 'product-metric-grid' },
    metricCard('Planning items', inventory.items.length, 'Structured nodes'),
    metricCard('Requirements', requirements.length, `${requirements.filter((node) => node.planning.acceptance.length).length} testable`),
    metricCard('Objectives', objectives.length, `${metrics.length} ${metrics.length === 1 ? 'metric' : 'metrics'}`),
    metricCard('Readiness', audit.applicable ? `${audit.score}%` : '—', audit.applicable ? audit.state : 'Process map'));

  const main = h('div', { class: 'product-doc-main' },
    h('section', { class: 'product-prose-card' },
      sectionHeading('01 · Context', 'Why this work exists'),
      problems.length ? problems.map((node) => h('article', { class: 'narrative-item' }, h('h3', {}, node.label), h('p', {}, node.description || 'No supporting narrative yet.'), relationChips(node)))
        : h('p', { class: 'product-empty-copy' }, 'No problem statement has been mapped yet.')),
    h('section', { class: 'product-prose-card' },
      sectionHeading('02 · Outcomes', 'What success means'),
      bulletSection('Goals', doc.goals, 'No goals documented.'),
      bulletSection('Success metrics', doc.successMetrics, 'No success metrics documented.'),
      objectives.map((node) => h('article', { class: 'narrative-item objective-item' }, h('h3', {}, node.label), h('p', {}, node.description), relationChips(node))),
      metrics.map((node) => h('article', { class: 'narrative-item metric-item' }, h('h3', {}, node.label), h('p', {}, node.description), relationChips(node)))),
    h('section', { class: 'product-requirements-section' },
      sectionHeading('03 · Requirements', 'The observable product contract', 'Every requirement is a stable node with ownership, proof, priority, and delivery context.'),
      requirements.length ? h('div', { class: 'requirements-list' }, requirements.map((node) => requirementCard(node)))
        : h('div', { class: 'product-empty-state' }, h('strong', {}, 'No requirements yet'), h('p', {}, 'Add planning.type: requirement to product nodes.'))),
    h('section', { class: 'product-prose-card' },
      sectionHeading('04 · Decisions and risk', 'What could change the plan'),
      decisions.map((node) => h('article', { class: 'narrative-item' }, pill('Decision'), h('h3', {}, node.label), h('p', {}, node.description), relationChips(node))),
      risks.map((node) => h('article', { class: 'narrative-item risk-item' }, pill('Risk', 'risk'), h('h3', {}, node.label), h('p', {}, node.description), relationChips(node))),
      !decisions.length && !risks.length ? h('p', { class: 'product-empty-copy' }, 'No decisions or risks documented.') : null));

  const aside = h('aside', { class: 'product-doc-aside' },
    h('div', { class: 'product-aside-card' }, h('span', {}, 'Audience'), doc.audience.length ? h('ul', {}, doc.audience.map((item) => h('li', {}, item))) : h('p', {}, 'Not documented')),
    h('div', { class: 'product-aside-card' }, h('span', {}, 'Non-goals'), doc.nonGoals.length ? h('ul', {}, doc.nonGoals.map((item) => h('li', {}, item))) : h('p', {}, 'Not documented')),
    h('button', { class: 'product-audit-callout', onClick: () => setWorkspaceView('audit') },
      h('span', {}, 'Product readiness'), h('strong', {}, audit.applicable ? `${audit.score}/100` : 'Not applicable'), h('small', {}, audit.applicable ? `${audit.issues.length} gaps to review` : 'Set document.kind to prd or roadmap')));

  panel.replaceChildren(productHeader('Living product requirement document'), overview, h('div', { class: 'product-doc-layout' }, main, aside));
}

function selectControl(label, key, value, options, onChange) {
  const select = h('select', { 'aria-label': label, 'data-roadmap-filter': key, onChange: (event) => onChange(event.target.value) },
    h('option', { value: 'all' }, `All ${label.toLowerCase()}`),
    options.map((option) => h('option', { value: option }, labelize(option))));
  select.value = value;
  return h('label', { class: 'roadmap-filter' }, h('span', {}, label), select);
}

function roadmapCard(item) {
  const p = item.planning;
  return h('article', { class: `roadmap-card status-${p.status || 'draft'}`, 'data-testid': 'roadmap-card', 'data-node-id': item.id },
    h('div', { class: 'roadmap-card-top' }, pill(labelize(p.priority || 'unprioritized'), `priority-${p.priority || 'none'}`), h('span', {}, formatRice(item.score))),
    h('h3', {}, item.label),
    item.description ? h('p', {}, item.description) : null,
    h('div', { class: 'roadmap-card-meta' },
      h('span', {}, item.owner || 'Unassigned'), h('span', {}, labelize(p.status || 'draft'))),
    h('div', { class: 'roadmap-card-schedule' },
      h('span', {}, h('small', {}, 'Horizon'), h('strong', {}, labelize(p.phase || 'Unscheduled'))),
      h('span', {}, h('small', {}, 'Target'), h('strong', {}, p.target || 'Not set'))),
    h('div', { class: 'roadmap-card-actions' },
      h('button', { onClick: () => locateNode(item.id) }, 'Open'),
      state.standalone ? null : h('button', { onClick: () => openRiceEditor(item.id) }, 'Score')));
}

function focusRequest(selector, control = null, preserveSelection = false) {
  const request = { selector };
  if (preserveSelection && control) {
    request.selectionStart = control.selectionStart;
    request.selectionEnd = control.selectionEnd;
    request.selectionDirection = control.selectionDirection;
  }
  return request;
}

function renderRoadmap(panel) {
  const roadmap = buildRoadmap(state.model, filters);
  const filterRow = h('div', { class: 'roadmap-toolbar' },
    selectControl('Status', 'status', filters.status, roadmap.statuses, (value) => {
      filters.status = value;
      render({ preserveScroll: true, restoreFocus: focusRequest('[data-roadmap-filter="status"]') });
    }),
    selectControl('Priority', 'priority', filters.priority, roadmap.priorities, (value) => {
      filters.priority = value;
      render({ preserveScroll: true, restoreFocus: focusRequest('[data-roadmap-filter="priority"]') });
    }),
    selectControl('Owner', 'owner', filters.owner, roadmap.owners, (value) => {
      filters.owner = value;
      render({ preserveScroll: true, restoreFocus: focusRequest('[data-roadmap-filter="owner"]') });
    }),
    h('label', { class: 'roadmap-filter roadmap-search' }, h('span', {}, 'Find'), h('input', {
      value: filters.query,
      placeholder: 'Search roadmap',
      onCompositionStart: () => { roadmapSearchComposing = true; },
      onCompositionEnd: (event) => {
        roadmapSearchComposing = false;
        filters.query = event.currentTarget.value;
        render({ preserveScroll: true, restoreFocus: focusRequest('.roadmap-search input', event.currentTarget, true) });
      },
      onInput: (event) => {
        filters.query = event.currentTarget.value;
        if (event.isComposing || roadmapSearchComposing) return;
        render({ preserveScroll: true, restoreFocus: focusRequest('.roadmap-search input', event.currentTarget, true) });
      },
    })),
    h('button', { class: 'd-btn roadmap-reset', 'data-roadmap-reset': '', onClick: () => {
      filters = { status: 'all', priority: 'all', owner: 'all', query: '' };
      render({ preserveScroll: true, restoreFocus: focusRequest('[data-roadmap-reset]') });
    } }, 'Reset'));

  const lanes = h('div', { class: 'roadmap-lanes', 'data-testid': 'roadmap-lanes' }, roadmap.columns.map((column) => h('section', { class: `roadmap-lane lane-${column.id}` },
    h('header', {}, h('div', {}, h('span', {}, column.label), h('small', {}, `${column.items.length} ${column.items.length === 1 ? 'item' : 'items'}`)),
      h('i', { style: `--lane-progress:${Math.min(100, column.items.length * 18)}%` })),
    h('div', { class: 'roadmap-lane-list' }, column.items.length ? column.items.map(roadmapCard)
      : h('div', { class: 'roadmap-empty' }, 'Nothing here under the current filters.')))));

  panel.replaceChildren(productHeader('Outcome-led product roadmap'),
    h('div', { class: 'roadmap-summary' },
      metricCard('Visible', roadmap.filtered, `of ${roadmap.total} roadmap items`),
      metricCard('Now', roadmap.columns.find((column) => column.id === 'now')?.items.length ?? 0, 'Committed work'),
      metricCard('Blocked', roadmap.columns.flatMap((column) => column.items).filter((item) => item.planning.status === 'blocked').length, 'Visible items needing intervention')),
    filterRow,
    lanes);
}

function renderAudit(panel) {
  const audit = auditProductPlan(state.model);
  if (!audit.applicable) {
    panel.replaceChildren(productHeader('Product readiness audit'), h('div', { class: 'product-empty-state large' },
      h('strong', {}, 'This is an operations map'),
      h('p', {}, 'Product readiness applies when document.kind is prd or roadmap.'),
      state.standalone ? null : h('button', { class: 'd-btn primary', onClick: openDocumentEditor }, 'Convert document')));
    return;
  }
  const issues = auditSeverity === 'all' ? audit.issues : audit.issues.filter((issue) => issue.severity === auditSeverity);
  const severityCount = (severity) => audit.issues.filter((issue) => issue.severity === severity).length;
  const filtersRow = h('div', { class: 'audit-filters', role: 'group', 'aria-label': 'Filter audit issues' }, ['all', 'high', 'medium', 'low'].map((severity) => h('button', {
    class: auditSeverity === severity ? 'active' : '',
    'aria-pressed': String(auditSeverity === severity),
    'data-audit-severity': severity,
    onClick: () => {
      auditSeverity = severity;
      render({ preserveScroll: true, restoreFocus: focusRequest(`[data-audit-severity="${severity}"]`) });
    },
  }, h('span', {}, labelize(severity)), h('strong', {}, severity === 'all' ? audit.issues.length : severityCount(severity)))));
  const issueList = h('div', { class: 'audit-issues' }, issues.length ? issues.map((issue) => h('article', { class: `audit-issue severity-${issue.severity}`, 'data-testid': 'audit-issue' },
    h('div', { class: 'audit-severity' }, h('i'), h('span', {}, issue.severity)),
    h('div', { class: 'audit-issue-copy' }, h('strong', {}, issue.title), h('p', {}, issue.detail), h('code', {}, issue.code)),
    issue.nodeId ? h('button', { onClick: () => locateNode(issue.nodeId) }, 'Locate') : null))
    : h('div', { class: 'product-empty-state' }, h('strong', {}, 'No gaps detected'), h('p', {}, 'This product document passes every deterministic readiness check.')));

  panel.replaceChildren(productHeader('Deterministic product readiness audit'),
    h('section', { class: 'audit-overview' },
      h('div', { class: `audit-score score-${audit.state.toLowerCase()}` },
        h('span', {}, audit.state), h('strong', {}, audit.score), h('small', {}, 'out of 100'),
        h('progress', { max: '100', value: String(audit.score), 'aria-label': `Readiness ${audit.score} out of 100` })),
      h('div', { class: 'audit-overview-copy' },
        h('span', {}, 'The document can explain itself'),
        h('h2', {}, audit.state === 'Ready' ? 'Ready for delivery review.' : audit.state === 'Reviewable' ? 'Strong enough to review, with visible gaps.' : 'The product contract still has structural gaps.'),
        h('p', {}, 'Serigraph checks traceability, ownership, proof, prioritization, scheduling, dependencies, and risk. It never invents missing facts.'),
        h('div', { class: 'product-metric-grid compact' },
          metricCard('Checks', audit.checks), metricCard('Issues', audit.issues.length), metricCard('High severity', severityCount('high'))))),
    filtersRow,
    issueList);
}

function render({ preserveScroll = false, restoreFocus = null } = {}) {
  const panel = document.getElementById('product-workspace');
  if (!panel || state.workspaceView === 'map') return;
  if (!state.model) {
    panel.replaceChildren();
    setWorkspaceView('map');
    return;
  }
  const scrollTop = panel.scrollTop;
  const scrollLeft = panel.scrollLeft;
  if (!preserveScroll) panel.scrollTop = 0;
  if (state.workspaceView === 'brief') renderBrief(panel);
  else if (state.workspaceView === 'roadmap') renderRoadmap(panel);
  else renderAudit(panel);
  if (preserveScroll) {
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  }
  if (restoreFocus) {
    const control = panel.querySelector(restoreFocus.selector);
    control?.focus?.({ preventScroll: true });
    if (control?.setSelectionRange && Number.isInteger(restoreFocus.selectionStart) && Number.isInteger(restoreFocus.selectionEnd)) {
      const length = control.value.length;
      control.setSelectionRange(
        Math.min(restoreFocus.selectionStart, length),
        Math.min(restoreFocus.selectionEnd, length),
        restoreFocus.selectionDirection || 'none',
      );
    }
  }
}

export function setWorkspaceView(view) {
  if (!VIEWS.includes(view)) view = 'map';
  if (view !== 'roadmap') roadmapSearchComposing = false;
  state.workspaceView = view;
  const panel = document.getElementById('product-workspace');
  const stage = document.getElementById('stage');
  const documentView = view !== 'map';
  if (panel) panel.hidden = !documentView;
  stage?.classList.toggle('product-view-active', documentView);
  document.body.dataset.workspaceView = view;
  for (const button of document.querySelectorAll('#workspace-switcher [data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (documentView) {
    document.getElementById('detail')?.setAttribute('hidden', '');
    render();
  } else {
    canvas.fit();
    bus.emit('view-changed');
  }
}

async function locateNode(nodeId) {
  setWorkspaceView('map');
  await ctrl.gotoNode(nodeId);
}

function downloadMarkdown() {
  if (!state.model) return;
  const blob = new Blob([productDocumentMarkdown(state.model)], { type: 'text/markdown;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = h('a', { href, download: `${state.mapId || 'serigraph'}-${state.model.document.kind}.md` });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  bus.emit('toast', 'Product document downloaded');
}

function openDocumentEditor() {
  const doc = state.model?.document;
  if (!doc || state.standalone) return;
  const kind = h('select', { class: 'f-select' }, ['process', 'prd', 'roadmap'].map((value) => h('option', { value }, labelize(value))));
  kind.value = doc.kind;
  const status = h('select', { class: 'f-select' }, ['draft', 'discovery', 'planned', 'in-progress', 'blocked', 'validated', 'shipped', 'archived'].map((value) => h('option', { value }, labelize(value))));
  status.value = doc.status || 'draft';
  const owner = h('input', { class: 'f-input', value: doc.owner, placeholder: 'Product owner' });
  const version = h('input', { class: 'f-input', value: doc.version, placeholder: 'e.g. 1.1' });
  const updated = h('input', { class: 'f-input', value: doc.updated, placeholder: 'YYYY-MM-DD' });
  const summary = h('textarea', { class: 'f-textarea', placeholder: 'Executive summary' }); summary.value = doc.summary;
  const audience = h('textarea', { class: 'f-textarea compact-textarea', placeholder: 'One audience per line' }); audience.value = doc.audience.join('\n');
  const goals = h('textarea', { class: 'f-textarea compact-textarea', placeholder: 'One goal per line' }); goals.value = doc.goals.join('\n');
  const nonGoals = h('textarea', { class: 'f-textarea compact-textarea', placeholder: 'One non-goal per line' }); nonGoals.value = doc.nonGoals.join('\n');
  const metrics = h('textarea', { class: 'f-textarea compact-textarea', placeholder: 'One metric per line' }); metrics.value = doc.successMetrics.join('\n');
  const body = h('div', { class: 'product-dialog-body' },
    h('div', { class: 'form-row' }, h('div', { class: 'f-field' }, h('label', {}, 'Document kind'), kind), h('div', { class: 'f-field' }, h('label', {}, 'Status'), status)),
    h('div', { class: 'form-row' }, h('div', { class: 'f-field' }, h('label', {}, 'Owner'), owner), h('div', { class: 'f-field' }, h('label', {}, 'Version'), version), h('div', { class: 'f-field' }, h('label', {}, 'Updated'), updated)),
    h('div', { class: 'f-field' }, h('label', {}, 'Executive summary'), summary),
    h('div', { class: 'form-row' }, h('div', { class: 'f-field' }, h('label', {}, 'Audience'), audience), h('div', { class: 'f-field' }, h('label', {}, 'Goals'), goals)),
    h('div', { class: 'form-row' }, h('div', { class: 'f-field' }, h('label', {}, 'Non-goals'), nonGoals), h('div', { class: 'f-field' }, h('label', {}, 'Success metrics'), metrics)));
  makeDialog('Edit product document', body, [{ label: 'Cancel' }, { label: 'Save document', primary: true, onClick: async () => {
    const ok = await ctrl.commit(() => edit.updateDocument({
      kind: kind.value, version: version.value, status: status.value, owner: owner.value, updated: updated.value, summary: summary.value,
      audience: splitLines(audience.value), goals: splitLines(goals.value), nonGoals: splitLines(nonGoals.value), successMetrics: splitLines(metrics.value),
    }));
    if (ok) bus.emit('toast', 'Product document saved');
    return ok;
  } }]);
}

function openRiceEditor(nodeId) {
  const node = state.model?.byId.get(nodeId);
  if (!node?.planning || state.standalone) return;
  const fields = {};
  for (const [key, label, hint] of [
    ['reach', 'Reach', 'people / period'], ['impact', 'Impact', '0.25–3'], ['confidence', 'Confidence', '0–100%'], ['effort', 'Effort', 'person-months'],
  ]) {
    fields[key] = h('input', { class: 'f-input', type: 'number', min: key === 'effort' ? '0.01' : '0', max: key === 'confidence' ? '100' : null, step: 'any', value: node.planning.rice[key] ?? '', placeholder: hint });
  }
  const score = h('strong', { class: 'rice-preview' });
  const update = () => {
    const value = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value === '' ? '' : Number(input.value)]));
    score.textContent = formatRice(calculateRice(value));
  };
  Object.values(fields).forEach((input) => input.addEventListener('input', update)); update();
  const body = h('div', { class: 'product-dialog-body' },
    h('div', { class: 'rice-dialog-intro' }, h('div', {}, h('span', {}, 'Transparent priority score'), h('h3', {}, node.label)), h('div', {}, h('small', {}, 'RICE'), score)),
    h('div', { class: 'rice-input-grid' }, Object.entries(fields).map(([key, input]) => h('div', { class: 'f-field' }, h('label', {}, labelize(key)), input))),
    h('p', { class: 'hint' }, 'Reach × impact × confidence ÷ effort. The full-precision value determines roadmap order.'));
  makeDialog('Prioritize requirement', body, [{ label: 'Cancel' }, { label: 'Save score', primary: true, onClick: async () => {
    const rice = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value === '' ? '' : Number(input.value)]));
    if (calculateRice(rice) == null) {
      bus.emit('toast', 'Complete all four RICE inputs; effort must be greater than zero.', true);
      return false;
    }
    const ok = await ctrl.commit(() => edit.updateNode(nodeId, { planning: { ...node.planning, rice } }));
    if (ok) bus.emit('toast', 'Priority score saved');
    return ok;
  } }]);
}

export function initProductWorkspace() {
  for (const button of document.querySelectorAll('#workspace-switcher [data-view]')) {
    button.addEventListener('click', () => setWorkspaceView(button.dataset.view));
  }
  bus.on('map-opened', () => {
    filters = { status: 'all', priority: 'all', owner: 'all', query: '' };
    auditSeverity = 'all';
    if (state.workspaceView !== 'map') render();
  });
  bus.on('view-changed', () => { if (state.workspaceView !== 'map') render(); });
  bus.on('workspace-map-request', () => setWorkspaceView('map'));
  setWorkspaceView('map');
}
