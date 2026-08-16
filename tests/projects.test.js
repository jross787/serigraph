import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectIndex, mapProjectTag, PROJECT_INDEX_FILE } from '../shared/projects.js';
import { projectStandalonePayload } from '../server/export.js';

const FULL = `
name: Atlas Logistics — Operations Review
description: Process and systems maps from the Atlas engagement.
order:
  - order-to-cash
  - systems-landscape
tags:
  order-to-cash: Business process
  systems-landscape: Systems
`;

test('index file name is fixed', () => {
  assert.equal(PROJECT_INDEX_FILE, 'projects.yaml');
});

test('parses a full projects.yaml', () => {
  const { name, description, order, tags, errors } = parseProjectIndex(FULL);
  assert.deepEqual(errors, []);
  assert.equal(name, 'Atlas Logistics — Operations Review');
  assert.equal(description, 'Process and systems maps from the Atlas engagement.');
  assert.deepEqual(order, ['order-to-cash', 'systems-landscape']);
  assert.deepEqual(tags, { 'order-to-cash': 'Business process', 'systems-landscape': 'Systems' });
});

test('tolerates missing fields', () => {
  for (const source of ['', '\n', 'name: Only a name\n']) {
    const { name, description, order, tags, errors } = parseProjectIndex(source);
    assert.deepEqual(errors, []);
    assert.equal(description, null);
    assert.deepEqual(order, []);
    assert.deepEqual(tags, {});
  }
  assert.equal(parseProjectIndex('name: Only a name\n').name, 'Only a name');
  assert.equal(parseProjectIndex('').name, null);
});

test('tolerates unknown slugs in order and tags', () => {
  const source = `
order:
  - ghost-map
tags:
  ghost-map: Not a real map
`;
  const { order, tags, errors } = parseProjectIndex(source);
  assert.deepEqual(errors, []);
  // slug existence is checked by callers, not the parser
  assert.deepEqual(order, ['ghost-map']);
  assert.deepEqual(tags, { 'ghost-map': 'Not a real map' });
});

test('malformed YAML lands in errors without throwing', () => {
  let result;
  assert.doesNotThrow(() => {
    result = parseProjectIndex('name: [unclosed\n  : : :');
  });
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0].message, /^YAML syntax:/);
  // fields stay at their defaults
  assert.equal(result.name, null);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.tags, {});
});

test('a non-map document lands in errors', () => {
  for (const source of ['- just\n- a\n- list\n', 'just a string\n']) {
    const { name, errors } = parseProjectIndex(source);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /must be a YAML map/);
    assert.equal(name, null);
  }
});

test('wrongly-typed fields land in errors and keep defaults', () => {
  const source = `
name: 42
description: true
order: not-a-list
tags:
  - not
  - a
  - map
`;
  const { name, description, order, tags, errors } = parseProjectIndex(source);
  assert.equal(errors.length, 4);
  assert.equal(name, null);
  assert.equal(description, null);
  assert.deepEqual(order, []);
  assert.deepEqual(tags, {});
});

test('wrongly-typed entries are skipped, good entries kept', () => {
  const source = `
order:
  - real-map
  - 7
tags:
  real-map: Systems
  other-map: 3
`;
  const { order, tags, errors } = parseProjectIndex(source);
  assert.equal(errors.length, 2);
  assert.deepEqual(order, ['real-map']);
  assert.deepEqual(tags, { 'real-map': 'Systems' });
});

test('mapProjectTag returns the tag or null', () => {
  const index = parseProjectIndex(FULL);
  assert.equal(mapProjectTag(index, 'order-to-cash'), 'Business process');
  assert.equal(mapProjectTag(index, 'systems-landscape'), 'Systems');
  assert.equal(mapProjectTag(index, 'no-such-map'), null);
  assert.equal(mapProjectTag(parseProjectIndex(''), 'order-to-cash'), null);
  assert.equal(mapProjectTag(null, 'order-to-cash'), null);
  assert.equal(mapProjectTag(parseProjectIndex('tags:\n  blank: ""\n'), 'blank'), null);
});

test('projectStandalonePayload shapes the embedded project context', () => {
  assert.equal(projectStandalonePayload(null), null);
  assert.equal(projectStandalonePayload(undefined), null);

  const payload = projectStandalonePayload({
    slug: 'atlas-logistics',
    name: 'Atlas Logistics — Operations Review',
    maps: [
      {
        id: 'atlas-logistics/order-to-cash',
        name: 'Order to cash',
        description: 'Intake to billing',
        nodeCount: 9,
        kind: 'process',
        mode: 'process',
        invalid: false, // extra fields are dropped
      },
      { id: 'atlas-logistics/systems-landscape' }, // missing fields default
    ],
  });
  assert.deepEqual(payload, {
    slug: 'atlas-logistics',
    name: 'Atlas Logistics — Operations Review',
    maps: [
      {
        id: 'atlas-logistics/order-to-cash',
        name: 'Order to cash',
        description: 'Intake to billing',
        nodeCount: 9,
        kind: 'process',
        mode: 'process',
      },
      {
        id: 'atlas-logistics/systems-landscape',
        name: 'atlas-logistics/systems-landscape',
        description: null,
        nodeCount: 0,
        kind: null,
        mode: null,
      },
    ],
  });
});
