// Human-vs-agent economics — pure local math over the parsed model.
// Runs in the browser, in Node tests, and inside standalone HTML exports.
//
// The unit of time is a MONTH: `runs` on a node means executions per month.
// Formulas (documented in docs/FORMAT.md — keep in sync):
//   human cost/run   = minutes / 60 × rate        (rate = loaded $/hour)
//   agent cost/run   = perRun
//   monthly human    = human cost/run × runs
//   monthly agent    = agent cost/run × runs
//   monthly savings  = monthly human − monthly agent
//   payback (months) = Σ setup / Σ monthly savings   (over fully-costed nodes)
//   first-year ROI   = (12 × Σ monthly savings − Σ setup) / Σ setup
//
// A missing input is UNKNOWN, never zero: a node participates in the roll-up
// only when both sides are computable (runs + minutes + rate [or the map's
// defaultRate] + perRun). This keeps the identity savings = human − agent
// exact over the costed subset. `setup` is optional and defaults to 0 for a
// costed node; zero `runs` is a valid input (a step that never runs).

// per-node economics; returns null when the node carries no cost data at all.
// `defaults` comes from the map's optional `costModel:` block.
export function nodeCost(node, defaults = {}) {
  const c = node.cost;
  if (!c) return null;
  const runs = c.runs ?? null;
  const minutes = c.minutes ?? null;
  const rate = c.rate ?? defaults.defaultRate ?? null;
  const perRun = c.perRun ?? null;
  const setup = c.setup ?? null;

  const humanPerRun = minutes != null && rate != null ? (minutes / 60) * rate : null;
  const agentPerRun = perRun;
  const humanMonthly = humanPerRun != null && runs != null ? humanPerRun * runs : null;
  const agentMonthly = agentPerRun != null && runs != null ? agentPerRun * runs : null;
  const complete = humanMonthly != null && agentMonthly != null;

  const missing = [];
  if (runs == null) missing.push('runs');
  if (minutes == null) missing.push('human.minutes');
  if (rate == null) missing.push('human.rate');
  if (perRun == null) missing.push('agent.perRun');

  return {
    runs, minutes, rate, perRun,
    setup: setup ?? (complete ? 0 : null),
    humanPerRun, agentPerRun,
    humanMonthly, agentMonthly,
    savingsMonthly: complete ? humanMonthly - agentMonthly : null,
    complete,
    missing,
  };
}

// whole-map roll-up; walks every scope at every depth.
export function rollupCost(model) {
  const defaults = model.costModel ?? {};
  const nodes = new Map(); // id -> nodeCost result (only nodes carrying data)
  let processCount = 0;
  let costedProcessCount = 0;
  let human = 0, agentTotal = 0, setupTotal = 0;
  let costedCount = 0;
  const partialIds = [];

  (function walk(scope) {
    for (const n of scope.nodes) {
      if (n.type === 'process') processCount++;
      const r = nodeCost(n, defaults);
      if (r) {
        nodes.set(n.id, r);
        if (r.complete) {
          costedCount++;
          if (n.type === 'process') costedProcessCount++;
          human += r.humanMonthly;
          agentTotal += r.agentMonthly;
          setupTotal += r.setup ?? 0;
        } else {
          partialIds.push(n.id);
        }
      }
      if (n.children) walk(n.children);
    }
  })(model.root);

  const savings = costedCount ? human - agentTotal : null;
  let paybackMonths = null;
  if (costedCount) {
    if (savings > 0) paybackMonths = setupTotal / savings;
    else if (setupTotal > 0) paybackMonths = Infinity; // never pays back
    else paybackMonths = savings === 0 ? 0 : Infinity;
  }
  const roiFirstYear = costedCount && setupTotal > 0 && savings != null
    ? (savings * 12 - setupTotal) / setupTotal
    : null;

  return {
    currency: defaults.currency ?? 'USD',
    nodes,
    humanMonthly: costedCount ? human : null,
    agentMonthly: costedCount ? agentTotal : null,
    savingsMonthly: savings,
    setupTotal: costedCount ? setupTotal : null,
    paybackMonths,
    roiFirstYear,
    costedCount,
    costedProcessCount,
    processCount,
    partialIds,
  };
}

// ── display helpers (shared by app + export so numbers match everywhere) ──
export function formatMoney(value, currency = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const opts = abs >= 100 || abs === 0 || Number.isInteger(value)
    ? { maximumFractionDigits: 0 }
    : { maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, ...opts }).format(value);
  } catch {
    return `$${value.toFixed(abs >= 100 ? 0 : 2)}`; // unknown currency code
  }
}

export function formatPayback(months) {
  if (months == null) return '—';
  if (months === Infinity) return 'never';
  if (months === 0) return 'immediate';
  if (months < 1) {
    const days = Math.ceil(months * 30);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (months < 24) {
    const r = Math.round(months * 10) / 10;
    return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)} mo`;
  }
  return `${(months / 12).toFixed(1)} yr`;
}

export function formatPercent(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${Math.round(x * 100).toLocaleString('en-US')}%`;
}

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$' };

// tight formatting for on-canvas chips: $1.9k, $48, €2.4M, $9B
export function compactMoney(v, currency = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : ''; // ASCII minus, matching Intl's formatMoney output
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (abs >= 100 || Number.isInteger(v)) return `${sign}${sym}${Math.round(abs)}`;
  return `${sign}${sym}${abs.toFixed(2)}`;
}
