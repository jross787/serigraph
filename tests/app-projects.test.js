// Projects routing: the pure hash codec in app/routes.js. Project map ids
// carry one "/" segment ("<project>/<map>"); the codec must round-trip them
// without confusing the id for a scope/node suffix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash } from '../app/routes.js';

test('home routes: empty, bare #, and #/ all mean the projects home', () => {
  for (const h of ['', '#', '#/']) {
    assert.deepEqual(parseHash(h), { home: true });
  }
});

test('home round-trips through buildHash', () => {
  assert.equal(buildHash({}), '#/');
  assert.deepEqual(parseHash(buildHash({})), { home: true });
});

test('root map id round-trips', () => {
  const hash = buildHash({ mapId: 'insurance' });
  assert.equal(hash, '#/map/insurance');
  assert.deepEqual(parseHash(hash), { mapId: 'insurance' });
});

test('project map id round-trips with the slash intact', () => {
  const id = 'atlas-logistics/order-to-cash';
  const hash = buildHash({ mapId: id });
  assert.equal(hash, '#/map/atlas-logistics/order-to-cash');
  assert.deepEqual(parseHash(hash), { mapId: id });
});

test('project map id + node selection round-trips', () => {
  const route = { mapId: 'serigraph-dogfood/code-pipeline', nodeId: 'parse yaml' };
  const parsed = parseHash(buildHash(route));
  assert.equal(parsed.mapId, route.mapId);
  assert.equal(parsed.nodeId, route.nodeId);
  assert.equal(parsed.inId, undefined);
});

test('project map id + scope + node round-trips (freeform placement form)', () => {
  const route = { mapId: 'atlas-logistics/systems', inId: 'group one', nodeId: 'crm' };
  const parsed = parseHash(buildHash(route));
  assert.deepEqual(parsed, route);
});

test('a node id is never mistaken for part of the map id', () => {
  // greedy id matching must stop before /node/ and /in/
  const parsed = parseHash('#/map/proj/map/node/n1');
  assert.equal(parsed.mapId, 'proj/map');
  assert.equal(parsed.nodeId, 'n1');
});

test('root map with a scope is not confused with a project map', () => {
  const parsed = parseHash('#/map/insurance/in/claims');
  assert.deepEqual(parsed, { mapId: 'insurance', inId: 'claims' });
});

test('special characters in ids survive encode/decode', () => {
  const route = { mapId: 'proj/ma p', inId: 'scope & co', nodeId: 'node?x' };
  const hash = buildHash(route);
  assert.ok(!hash.includes('?'), 'query char must be encoded');
  assert.deepEqual(parseHash(hash), route);
});

test('malformed percent sequences fall back to the verbatim hash', () => {
  // decodeURIComponent throws on a lone %; the parser must not
  const parsed = parseHash('#/map/100%/node/a');
  assert.equal(parsed.mapId, '100%');
  assert.equal(parsed.nodeId, 'a');
});

test('unknown shapes fall back to home', () => {
  assert.deepEqual(parseHash('#/nonsense'), { home: true });
});
