import test from 'node:test';
import assert from 'node:assert/strict';
import { opportunityDefaults, calculateOpportunity, assessOpportunity } from '../app/opportunity.js';

const node = {
  label: 'Underwriting',
  type: 'process',
  description: 'Review the application and prepare a credit memo.',
  owner: 'Credit Committee',
  trigger: 'Qualified application',
  sla: '4 business hours',
  automation: 'assisted',
  systems: ['Salesforce', 'Plaid', 'Data warehouse'],
  children: {},
  stats: { childCount: 8 },
};

test('opportunity model produces useful, finite planning metrics', () => {
  const defaults = opportunityDefaults(node);
  const metrics = calculateOpportunity(defaults);
  assert.ok(metrics.annualHours > 0);
  assert.ok(metrics.annualValue > metrics.setupCost);
  assert.ok(Number.isFinite(metrics.paybackMonths));
  assert.equal(metrics.cycleReduction, defaults.coverage);
});

test('readiness assessment rewards documented automation context', () => {
  const ready = assessOpportunity(node);
  const vague = assessOpportunity({ label: 'Unknown step', type: 'process', systems: [], stats: {} });
  assert.ok(ready.score >= 80);
  assert.equal(ready.label, 'Strong candidate');
  assert.ok(vague.score < ready.score);
  assert.ok(vague.guardrails.some((item) => item.includes('owner')));
});
