// The map assistant: chatEdit validates model output against the real schema
// and gives one corrective retry, and the /api/chat endpoint guards its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEdit, ChatError } from '../server/chat.js';
import { parseMap } from '../shared/model.js';

const CURRENT = `name: Demo
nodes:
  - id: intake
    type: process
    label: Intake
  - id: review
    type: decision
    label: OK?
edges:
  - from: intake
    to: review
`;

const UPDATED = `name: Demo
nodes:
  - id: intake
    type: process
    label: Intake
  - id: review
    type: decision
    label: OK?
  - id: fix
    type: process
    label: Fix
edges:
  - from: intake
    to: review
  - from: review
    to: fix
    label: "yes"
`;

const BROKEN = `name: Demo
nodes:
  - id: intake
    type: wizard
    label: Intake
edges:
  - from: intake
    to: ghost
`;

const llmReturning = (...replies) => {
  const queue = [...replies];
  return async () => queue.length > 1 ? queue.shift() : queue[0];
};

test('a valid proposal passes through and parses', async () => {
  const result = await chatEdit(
    { source: CURRENT, instruction: 'add a fix step after review' },
    { llm: llmReturning(UPDATED) },
  );
  const { model, errors } = parseMap(result.source);
  assert.equal(errors.length, 0);
  assert.ok(model.byId.has('fix'));
});

test('fenced YAML is unwrapped before validation', async () => {
  const result = await chatEdit(
    { source: CURRENT, instruction: 'add a fix step' },
    { llm: llmReturning('```yaml\n' + UPDATED + '\n```') },
  );
  assert.ok(result.source.startsWith('name: Demo'));
});

test('one corrective retry with validator feedback succeeds', async () => {
  const seen = [];
  const llm = async ({ prompt }) => { seen.push(prompt); return seen.length === 1 ? BROKEN : UPDATED; };
  const result = await chatEdit({ source: CURRENT, instruction: 'add a fix step' }, { llm });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes('failed validation'), 'retry carries validator feedback');
  assert.ok(parseMap(result.source).errors.length === 0);
});

test('two invalid attempts produce a clean 422', async () => {
  await assert.rejects(
    chatEdit({ source: CURRENT, instruction: 'add a fix step' }, { llm: llmReturning(BROKEN, BROKEN) }),
    (e) => e instanceof ChatError && e.status === 422 && /couldn't produce a valid map/.test(e.message),
  );
});

test('an ERROR reply surfaces its reason as a 422', async () => {
  await assert.rejects(
    chatEdit({ source: CURRENT, instruction: 'what is the meaning of life?' }, { llm: llmReturning('ERROR: not a map-editing request') }),
    (e) => e.status === 422 && /not a map-editing request/.test(e.message),
  );
});

test('missing input is rejected before any model call', async () => {
  const llm = async () => { throw new Error('must not be called'); };
  await assert.rejects(chatEdit({ source: '', instruction: 'x' }, { llm }), (e) => e.status === 400);
  await assert.rejects(chatEdit({ source: CURRENT, instruction: ' ' }, { llm }), (e) => e.status === 400);
});
