// Deterministic planning model for the Automation Opportunity Lens.
// The output is deliberately framed as an editable estimate, not measured fact.

const COVERAGE_BY_STATE = {
  manual: 72,
  assisted: 62,
  automated: 22,
  'at-risk': 48,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function opportunityDefaults(node) {
  const children = node?.stats?.childCount ?? 0;
  const systems = node?.systems?.length ?? 0;
  return {
    monthlyCases: clamp(24 + children * 6, 24, 600),
    minutesPerCase: clamp(25 + children * 10, 20, 360),
    coverage: COVERAGE_BY_STATE[node?.automation] ?? 55,
    hourlyValue: 85,
    setupCost: 14000 + systems * 2200 + children * 450,
  };
}

export function calculateOpportunity(input) {
  const monthlyCases = clamp(input.monthlyCases, 1, 100000);
  const minutesPerCase = clamp(input.minutesPerCase, 1, 1440);
  const coverage = clamp(input.coverage, 0, 95);
  const hourlyValue = clamp(input.hourlyValue, 1, 10000);
  const setupCost = clamp(input.setupCost, 0, 100000000);
  const annualHours = monthlyCases * 12 * minutesPerCase * (coverage / 100) / 60;
  const annualValue = annualHours * hourlyValue;
  const monthlyValue = annualValue / 12;
  return {
    monthlyCases,
    minutesPerCase,
    coverage,
    hourlyValue,
    setupCost,
    annualHours,
    annualValue,
    paybackMonths: monthlyValue > 0 ? setupCost / monthlyValue : Infinity,
    cycleReduction: coverage,
  };
}

export function assessOpportunity(node) {
  let score = 8;
  const gaps = [];
  if (node?.owner) score += 14;
  else gaps.push('Assign an accountable owner');
  if (node?.trigger) score += 18;
  else gaps.push('Define the event that starts this step');
  if (node?.systems?.length) score += 18;
  else gaps.push('Identify the systems and data sources involved');
  if (node?.sla) score += 10;
  else gaps.push('Add a baseline service target');
  if (node?.description) score += 8;
  else gaps.push('Document the current operating procedure');
  if (node?.automation === 'assisted') score += 8;
  if (node?.automation === 'automated') score += 12;
  if (node?.children) score += 6;
  score = clamp(score, 0, 100);

  const guardrails = [...gaps];
  if (node?.type === 'decision' || /credit|approval|underwriting|risk/i.test(`${node?.label} ${node?.description}`)) {
    guardrails.push('Keep final approval and exception handling with a human');
  }
  if ((node?.systems?.length ?? 0) > 1) {
    guardrails.push('Confirm cross-system permissions, audit logs, and recovery paths');
  }
  if (!guardrails.length) guardrails.push('Validate edge cases with the process owner before launch');

  return {
    score,
    label: score >= 80 ? 'Strong candidate' : score >= 60 ? 'Promising candidate' : 'Needs definition',
    guardrails: guardrails.slice(0, 3),
    pattern: node?.children
      ? 'Orchestrated workflow with human checkpoints'
      : node?.type === 'decision'
        ? 'Decision support with human approval'
        : 'Event-driven task automation',
  };
}
