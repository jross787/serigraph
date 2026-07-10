#!/usr/bin/env node
// Generate synthetic Opsmap YAML files for performance and adversarial testing.
//
//   node tools/generate-map.mjs --nodes 300 --depth 4 --out maps/perf-300.yaml [--seed 42] [--unicode] [--name "Perf Test"]
//
// Deterministic: identical args + seed always produce byte-identical output
// (seeded mulberry32 PRNG only — never Math.random()/Date.now()).
import { writeFileSync } from 'node:fs';
import * as YAML from '../vendor/yaml.js';
import { parseMap } from '../shared/model.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — the ONLY source of randomness in this file.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
function choice(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function chance(rand, p) {
  return rand() < p;
}
function shuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function weightedChoice(rand, weights) {
  const r = rand();
  let acc = 0;
  for (const [val, w] of weights) {
    acc += w;
    if (r < acc) return val;
  }
  return weights[weights.length - 1][0];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function usage() {
  return [
    'usage: node tools/generate-map.mjs --nodes N --depth D [options]',
    '',
    'options:',
    '  --nodes N       target total node count (required-ish; default 100)',
    '  --depth D       max nesting depth, 1 = flat (required-ish; default 3)',
    '  --seed S        PRNG seed, integer (default 42)',
    '  --unicode       mix emoji/CJK/RTL/accents/quotes into labels & descriptions',
    '  --name "..."    map title (default "Generated Map")',
    '  --out PATH      output file (default: stdout)',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { nodes: 100, depth: 3, seed: 42, unicode: false, name: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--nodes':
        args.nodes = parseInt(argv[++i], 10);
        break;
      case '--depth':
        args.depth = parseInt(argv[++i], 10);
        break;
      case '--seed':
        args.seed = parseInt(argv[++i], 10);
        break;
      case '--unicode':
        args.unicode = true;
        break;
      case '--name':
        args.name = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        console.error(`generate-map: unknown argument "${a}"\n\n${usage()}`);
        process.exit(2);
    }
  }
  if (!Number.isFinite(args.nodes) || args.nodes < 1) {
    console.error(`generate-map: --nodes must be a positive integer\n\n${usage()}`);
    process.exit(2);
  }
  if (!Number.isFinite(args.depth) || args.depth < 1) {
    console.error(`generate-map: --depth must be a positive integer\n\n${usage()}`);
    process.exit(2);
  }
  if (!Number.isFinite(args.seed)) {
    console.error(`generate-map: --seed must be an integer\n\n${usage()}`);
    process.exit(2);
  }
  if (!args.name) args.name = 'Generated Map';
  return args;
}

// ---------------------------------------------------------------------------
// Word lists — the "businessy" vocabulary generated labels are built from.
// ---------------------------------------------------------------------------
const VERBS = [
  'Verify', 'Route', 'Reconcile', 'Escalate', 'Approve', 'Archive', 'Validate', 'Submit',
  'Review', 'Dispatch', 'Audit', 'Notify', 'Sync', 'Merge', 'Trigger', 'Schedule', 'Flag',
  'Close', 'Assign', 'Generate', 'Update', 'Cancel', 'Renew', 'Ship', 'Pack', 'Invoice',
  'Collect', 'Deposit', 'Transfer', 'Register', 'Onboard', 'Terminate', 'Appraise', 'Inspect',
  'Draft', 'Finalize', 'Publish', 'Digitize', 'Classify', 'Screen', 'Match', 'Score', 'Enrich',
  'Redact', 'Encrypt', 'Batch', 'Throttle', 'Retry', 'Rollback', 'Confirm', 'Forward',
];
const NOUNS = [
  'payload', 'queue', 'ledger', 'invoice', 'lead', 'application', 'claim', 'shipment', 'order',
  'payment', 'account', 'contract', 'ticket', 'request', 'record', 'batch', 'report',
  'credential', 'policy', 'case', 'document', 'package', 'manifest', 'inventory',
  'subscription', 'refund', 'dispute', 'webhook', 'customer', 'vendor', 'asset', 'statement',
  'deposit', 'transaction', 'file', 'draft', 'submission', 'appointment', 'label', 'return',
];
const PREPOSITION_TARGETS = [
  'the queue', 'underwriting', 'the warehouse', 'the fulfillment center', 'compliance',
  'the review board', 'the ledger', 'accounts payable', 'the support desk', 'the archive',
];
const DECISION_SUBJECTS = [
  'Payload', 'Payment', 'Application', 'Claim', 'Order', 'Applicant', 'Shipment',
  'Credit check', 'Document', 'Inventory', 'Signature', 'Address', 'Fraud score', 'Balance',
  'Approval', 'Account', 'Contract', 'Refund',
];
const DECISION_PREDICATES = [
  'valid?', 'approved?', 'in stock?', 'above threshold?', 'complete?', 'on file?',
  'within budget?', 'verified?', 'flagged?', 'ready to ship?', 'past due?', 'matched?',
];
const SYSTEMS = [
  'Salesforce', 'NetSuite', 'Zendesk', 'Stripe', 'internal LOS', 'Snowflake warehouse', 'Slack',
  'Jira', 'internal CRM', 'SAP', 'Workday', 'internal ledger service', 'S3 bucket', 'Airtable',
  'internal task queue', 'Twilio', 'DocuSign', 'internal API gateway', 'Looker',
  'internal fraud engine', 'HubSpot', 'QuickBooks', 'internal billing service', 'Segment',
  'Datadog', 'internal document store',
];
const ROLES = [
  'Loan Officer', 'Case Manager', 'Support Agent', 'Compliance Analyst', 'Warehouse Lead',
  'Dispatcher', 'Underwriter', 'Account Manager', 'Data Steward', 'QA Analyst',
  'Ops Coordinator', 'Billing Specialist', 'Fraud Analyst', 'Customer Success Manager',
  'Procurement Lead', 'Legal Counsel', 'HR Partner', 'Finance Analyst', 'Vendor Manager',
  'Shift Supervisor', 'Onboarding Specialist', 'Escalations Lead', 'Regional Manager',
  'Night-shift Operator',
];
const ARTIFACTS = [
  'Invoice', 'Purchase Order', 'Credit File', 'Term Sheet', 'Shipping Manifest',
  'Refund Request', 'Compliance Report', 'Signed Contract', 'Claim Form', 'Audit Log',
  'Customer Record', 'Payment Receipt', 'Inventory Snapshot', 'Escalation Ticket',
  'Onboarding Packet', 'Policy Document', 'Dispute Case File', 'Vendor Agreement',
  'Reconciliation Report', 'Credential Bundle', 'Approval Memo', 'Delivery Confirmation',
];

const ACTORS = [
  'The assigned analyst', 'A team member', 'The on-call engineer', 'Whoever owns the queue',
  'The regional lead', 'An automated worker', 'The reviewing manager', 'The intake team',
  'A designated approver',
];
const DURATIONS = [
  'a few minutes', 'an hour', 'one business day', 'four business hours', 'the same day',
  '24 hours', 'a couple of days', 'ten minutes',
];
const FOLLOWUPS = [
  'then hands off to the next stage.', 'and logs the result for audit.',
  'before escalating exceptions.', 'and notifies downstream systems.', 'then updates the record.',
  'and flags anomalies for review.', 'then closes out the step.',
];
const EXTRA_SENTENCES = [
  "Exceptions are routed to a human for manual review.",
  'Retries happen automatically up to three times.',
  'A summary is posted to the ops channel.',
  'Metrics from this step feed the weekly report.',
  'This step is skipped for low-risk cases.',
];
const DECISION_DESC_SUBJECTS = [
  'a rules engine check', 'a manual review', 'an automated risk score', 'policy thresholds',
  'a threshold comparison', 'a lookup against the ledger',
];
const ROLE_DESC = [
  'Owns this part of the process end to end.',
  "Handles exceptions that automation can't resolve.",
  'Reviews edge cases and signs off before it moves on.',
  'Coordinates with other teams to keep things moving.',
  'Is the point of contact when something goes wrong.',
];
const SYSTEM_DESC = [
  'Stores and syncs data used by this part of the process.',
  'Automates the routine parts of this step.',
  'Provides the source of truth for downstream teams.',
  'Sends notifications and tracks status changes.',
  'Integrates with upstream systems via webhook.',
];
const ARTIFACT_DESC = [
  'Produced at this stage and consumed by the next.',
  'Serves as the audit trail for this part of the process.',
  'Gets archived once the case closes.',
  'Is versioned so downstream teams can track changes.',
  'Must be signed off before it moves forward.',
];
const LINK_LABELS = [
  'SOP', 'Runbook', 'Policy', 'Spec', 'Playbook', 'Wiki page', 'API docs', 'Design doc',
  'Onboarding guide',
];
const OUTCOME_PAIRS = [
  ['yes', 'no'], ['approved', 'rejected'], ['pass', 'fail'], ['true', 'false'],
  ['in stock', 'backordered'], ['on file', 'missing'], ['complete', 'incomplete'],
  ['above threshold', 'below threshold'],
];

// Unicode flavor pools for --unicode mode.
const EMOJI = ['🚀', '✅', '📦', '🔥', '🧾', '📊', '⚙️', '🛡️', '💳', '📥', '📤', '🔔', '🧩', '🗂️', '⏱️', '📈', '🧠', '🔒', '🌐', '📝'];
const CJK = ['日本語', '注文処理', '確認済み', '出荷準備', '顧客対応', '請求書発行', '在庫確認', '承認完了', '品質管理', '配送手配'];
const RTL = ['مرحبا', 'طلب جديد', 'فاتورة', 'تحقق من الهوية', 'مخزون', 'عميل مهم', 'تمت الموافقة', 'قيد المراجعة'];
const ACCENTED = ['café', 'naïve approach', 'façade layer', 'résumé check', 'Zürich office', 'São Paulo hub', 'jalapeño batch', 'über-fast lane', 'Montréal team', 'coördinate'];
const SPECIALS = ['"priority"', 'note: pending', "it's ready", 'A & B combined', '50% complete', 'cost: $1,200', 'edge-case: none', 'see §4.2'];
const UNICODE_POOLS = [EMOJI, CJK, RTL, ACCENTED, SPECIALS];

function unicodeFlourish(rand) {
  return choice(rand, choice(rand, UNICODE_POOLS));
}

function guaranteedUnicodeSentence() {
  return 'Includes emoji 🚀, CJK 日本語, RTL مرحبا, accents café, and "quotes": plus colons, & other specials — 100% YAML-safe.';
}

// ---------------------------------------------------------------------------
// Label / description generators
// ---------------------------------------------------------------------------
function processLabel(rand) {
  const verb = choice(rand, VERBS);
  const noun = choice(rand, NOUNS);
  const style = randInt(rand, 0, 3);
  if (style === 0) return `${verb} ${noun}`;
  if (style === 1) return `${verb} the ${noun}`;
  if (style === 2) return `${verb} ${noun} to ${choice(rand, PREPOSITION_TARGETS)}`;
  return `${verb} and log ${noun}`;
}
function decisionLabel(rand) {
  return `${choice(rand, DECISION_SUBJECTS)} ${choice(rand, DECISION_PREDICATES)}`;
}
function labelFor(type, rand) {
  switch (type) {
    case 'process': return processLabel(rand);
    case 'decision': return decisionLabel(rand);
    case 'system': return choice(rand, SYSTEMS);
    case 'role': return choice(rand, ROLES);
    case 'artifact': return choice(rand, ARTIFACTS);
    default: return 'Untitled';
  }
}

function processDescription(rand) {
  let s = `${choice(rand, ACTORS)} completes this within ${choice(rand, DURATIONS)}, ${choice(rand, FOLLOWUPS)}`;
  if (chance(rand, 0.4)) s += ' ' + choice(rand, EXTRA_SENTENCES);
  return s;
}
function decisionDescription(rand) {
  let s = `Branches the flow based on ${choice(rand, DECISION_DESC_SUBJECTS)}.`;
  if (chance(rand, 0.4)) s += ' ' + choice(rand, EXTRA_SENTENCES);
  return s;
}
function roleDescription(rand) {
  let s = choice(rand, ROLE_DESC);
  if (chance(rand, 0.3)) s += ' ' + choice(rand, EXTRA_SENTENCES);
  return s;
}
function systemDescription(rand) {
  let s = choice(rand, SYSTEM_DESC);
  if (chance(rand, 0.3)) s += ' ' + choice(rand, EXTRA_SENTENCES);
  return s;
}
function artifactDescription(rand) {
  let s = choice(rand, ARTIFACT_DESC);
  if (chance(rand, 0.3)) s += ' ' + choice(rand, EXTRA_SENTENCES);
  return s;
}
function descriptionFor(type, rand) {
  switch (type) {
    case 'process': return processDescription(rand);
    case 'decision': return decisionDescription(rand);
    case 'system': return systemDescription(rand);
    case 'role': return roleDescription(rand);
    case 'artifact': return artifactDescription(rand);
    default: return '';
  }
}
function fakeLink(rand, id) {
  return { label: choice(rand, LINK_LABELS), url: `https://docs.example.com/${id}` };
}

// ---------------------------------------------------------------------------
// Tree shape: distribute ~N nodes across up to `depth` nesting levels.
// Realistic shape: top level 8-14 nodes, containers get 4-12 children,
// shrinking at deeper levels. Final count within +/-5% of requested.
// ---------------------------------------------------------------------------
const CHILD_RANGES = [[4, 12], [3, 9], [3, 7], [2, 5], [2, 4], [1, 3], [1, 2]];
const CONTAINER_PROB = [0.5, 0.42, 0.36, 0.3, 0.24, 0.18, 0.12];

function childRange(depth) {
  return CHILD_RANGES[Math.min(depth - 1, CHILD_RANGES.length - 1)];
}
function containerProb(depth) {
  return CONTAINER_PROB[Math.min(depth, CONTAINER_PROB.length - 1)];
}

function buildTree(rand, n, maxDepth) {
  const targetMin = Math.floor(n * 0.95);
  const targetMax = Math.max(targetMin, Math.ceil(n * 1.05));
  const state = { total: 0 };

  const topCount = Math.max(1, Math.min(targetMax, randInt(rand, 8, 14)));
  const root = [];
  for (let i = 0; i < topCount; i++) {
    root.push({ depth: 0, children: null });
    state.total++;
  }

  let currentLevel = root.slice();
  for (let d = 1; d < maxDepth && state.total < targetMax; d++) {
    const nextLevel = [];
    const parents = shuffle(rand, currentLevel);
    for (const parent of parents) {
      if (state.total >= targetMax) break;
      if (!chance(rand, containerProb(d - 1))) continue;
      const [mn, mx] = childRange(d);
      let count = randInt(rand, mn, mx);
      count = Math.min(count, targetMax - state.total);
      if (count <= 0) continue;
      parent.children = [];
      for (let i = 0; i < count; i++) {
        const child = { depth: d, children: null };
        parent.children.push(child);
        nextLevel.push(child);
        state.total++;
        if (state.total >= targetMax) break;
      }
    }
    currentLevel = nextLevel;
    if (currentLevel.length === 0) break;
  }

  if (state.total < targetMin) {
    const expandable = [];
    (function collect(slots) {
      for (const s of slots) {
        if (s.depth < maxDepth - 1) expandable.push(s);
        if (s.children) collect(s.children);
      }
    })(root);

    let guard = 0;
    const guardMax = targetMin * 4 + 200;
    while (state.total < targetMin && guard < guardMax) {
      guard++;
      if (expandable.length === 0) {
        // Flat map (maxDepth === 1) or nothing left to expand: add more top-level nodes.
        const s = { depth: 0, children: null };
        root.push(s);
        state.total++;
        continue;
      }
      const parent = choice(rand, expandable);
      if (!parent.children) parent.children = [];
      const child = { depth: parent.depth + 1, children: null };
      parent.children.push(child);
      state.total++;
      if (child.depth < maxDepth - 1) expandable.push(child);
    }
  }

  return root;
}

const CONTAINER_TYPE_WEIGHTS = [['process', 0.78], ['system', 0.16], ['decision', 0.06]];
const LEAF_TYPE_WEIGHTS = [['process', 0.30], ['decision', 0.16], ['system', 0.20], ['role', 0.19], ['artifact', 0.15]];

function assignTypes(slots, rand) {
  for (const s of slots) {
    s.type = s.children ? weightedChoice(rand, CONTAINER_TYPE_WEIGHTS) : weightedChoice(rand, LEAF_TYPE_WEIGHTS);
    if (s.children) assignTypes(s.children, rand);
  }
}

// ---------------------------------------------------------------------------
// Turn the shape tree into actual node/edge objects.
// ---------------------------------------------------------------------------
function idFor(path) {
  return 'n' + path.join('-');
}

function buildNode(slot, path, rand, args) {
  const id = idFor(path);
  const type = slot.type;
  let label = labelFor(type, rand);
  if (args.unicode && chance(rand, 0.25)) label = `${label} ${unicodeFlourish(rand)}`;
  const node = { id, type, label };
  if (chance(rand, 0.6)) {
    let desc = descriptionFor(type, rand);
    if (args.unicode && chance(rand, 0.35)) desc += ` ${unicodeFlourish(rand)}.`;
    node.description = desc;
  }
  if (chance(rand, 0.1)) node.links = [fakeLink(rand, id)];
  if (slot.children && slot.children.length) {
    node.children = buildScope(slot.children, path, rand, args);
  }
  return node;
}

function buildEdges(nodes, rand) {
  const flow = nodes.filter((n) => n.type === 'process' || n.type === 'decision');
  const support = nodes.filter((n) => n.type !== 'process' && n.type !== 'decision');
  const edges = [];
  const seen = new Set();
  function addEdge(from, to, label) {
    if (from === to) return;
    const key = `${from}>${to}>${label || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const e = { from, to };
    if (label) e.label = label;
    edges.push(e);
  }

  for (let i = 0; i < flow.length; i++) {
    const node = flow[i];
    const later = flow.slice(i + 1); // only forward targets -> guarantees a DAG
    if (node.type === 'decision') {
      const [l1, l2] = choice(rand, OUTCOME_PAIRS);
      if (later.length > 0) {
        const t1 = later[0];
        const t2 = later.length > 1 ? choice(rand, later.slice(1)) : later[0];
        addEdge(node.id, t1.id, l1);
        addEdge(node.id, t2.id, l2);
      } else if (support.length > 0) {
        const t1 = support[0];
        const t2 = support[Math.min(1, support.length - 1)];
        addEdge(node.id, t1.id, l1);
        addEdge(node.id, t2.id, l2);
      }
    } else if (later.length > 0) {
      addEdge(node.id, later[0].id, '');
      if (later.length > 1 && chance(rand, 0.15)) {
        const branchTarget = choice(rand, later.slice(1));
        addEdge(node.id, branchTarget.id, '');
      }
    }
  }

  for (const s of support) {
    const attachCount = chance(rand, 0.85) ? 1 : 2;
    const pool = flow.length ? flow : support.filter((x) => x !== s);
    for (let k = 0; k < attachCount; k++) {
      if (!pool.length) break;
      const target = choice(rand, pool);
      if (target.id === s.id) continue;
      if (s.type === 'role') {
        addEdge(s.id, target.id, chance(rand, 0.5) ? 'performs' : '');
      } else if (s.type === 'system') {
        addEdge(target.id, s.id, chance(rand, 0.5) ? 'uses' : '');
      } else {
        // artifact
        if (chance(rand, 0.6)) addEdge(target.id, s.id, chance(rand, 0.5) ? 'produces' : '');
        else addEdge(s.id, target.id, chance(rand, 0.5) ? 'feeds' : '');
      }
    }
  }

  return edges;
}

function buildScope(slots, parentPath, rand, args) {
  const nodes = slots.map((slot, i) => buildNode(slot, [...parentPath, i + 1], rand, args));
  const edges = buildEdges(nodes, rand);
  const scope = { nodes };
  if (edges.length) scope.edges = edges;
  return scope;
}

function countEdges(scope) {
  let count = (scope.edges || []).length;
  for (const n of scope.nodes || []) {
    if (n.children) count += countEdges(n.children);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Assemble the full document
// ---------------------------------------------------------------------------
function generate(args) {
  const rand = mulberry32(args.seed);

  const root = buildTree(rand, args.nodes, args.depth);
  assignTypes(root, rand);
  const topScope = buildScope(root, [], rand, args);

  const doc = { name: args.name };
  let description = `Synthetic map generated for testing — target ${args.nodes} nodes, depth ${args.depth}, seed ${args.seed}.`;
  if (args.unicode) description += ' ' + guaranteedUnicodeSentence();
  doc.description = description;
  doc.nodes = topScope.nodes;
  if (topScope.edges && topScope.edges.length) doc.edges = topScope.edges;

  return doc;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const doc = generate(args);
  const yamlText = YAML.stringify(doc, { lineWidth: 0 });

  const { model, errors } = parseMap(yamlText);
  if (errors.length) {
    console.error(`generate-map: self-validation FAILED (${errors.length} error(s)) — refusing to write output`);
    for (const e of errors) console.error(`  ${e.line ? `line ${e.line}: ` : ''}${e.message}`);
    process.exit(1);
  }

  if (args.out) {
    writeFileSync(args.out, yamlText);
  } else {
    process.stdout.write(yamlText);
  }

  const depths = [...model.byId.values()].map((n) => n.depth);
  const maxDepth = depths.length ? Math.max(...depths) + 1 : 0;
  const edgeCount = countEdges(doc);
  console.error(
    `Generated "${model.name}" — ${model.nodeCount} nodes, max depth ${maxDepth}, ${edgeCount} edges -> ${args.out || '(stdout)'}`
  );
}

main();
