import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMap } from '../shared/model.js';

const catalog = () => ({
  name: 'Synthetic catalog', mode: 'freeform',
  elements: [{ id: 'source', type: 'system', label: 'Source' }], nodes: [], edges: [],
  dataExplorer: {
    objects: [{ id: 'orders', system: 'source', sourceName: 'Orders', entityType: 'order', authority: 'originating' }],
    canonicalFields: [{ id: 'order.id', label: 'Order ID', entityType: 'order', dataType: 'string' }],
    fieldBindings: [{ object: 'orders', sourceField: 'OrderId', sourceDataType: 'string', canonicalField: 'order.id' }],
    flows: [{ id: 'sync', from: 'orders', to: 'orders', method: 'api', label: 'Sync' }],
  },
});

test('catalog survives a map edit and appears in the normalized model', () => {
  const input = catalog();
  const { doc, model, errors } = parseMap(JSON.stringify(input));
  assert.deepEqual(errors, []);
  assert.deepEqual(model.dataExplorer, input.dataExplorer);
  doc.set('name', 'Renamed');
  assert.deepEqual(parseMap(doc.toString()).model.dataExplorer, input.dataExplorer);
});

test('catalog references and duplicate identities are validated before saving', () => {
  for (const [mutate, message] of [
    [data => { data.elements = []; }, /unknown system/],
    [data => { data.dataExplorer.fieldBindings[0].canonicalField = 'missing'; }, /unknown canonical field/],
    [data => { data.dataExplorer.flows[0].to = 'missing'; }, /unknown object/],
    [data => { data.dataExplorer.objects.push(data.dataExplorer.objects[0]); }, /duplicate/],
    [data => { data.dataExplorer.fieldBindings.push(data.dataExplorer.fieldBindings[0]); }, /duplicate/],
    [data => { data.dataExplorer.flows.push(data.dataExplorer.flows[0]); }, /duplicate/],
    [data => { data.dataExplorer.objects = [null]; }, /must be a map/],
  ]) {
    const input = catalog();
    mutate(input);
    const { model, errors } = parseMap(JSON.stringify(input));
    assert.equal(model, null);
    assert.ok(errors.some(error => message.test(error.message)), JSON.stringify(errors));
  }
});
