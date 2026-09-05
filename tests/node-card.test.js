import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeCardDetails } from '../app/canvas.js';

test('card details preserve authored content and choose only a configured safe web launch', () => {
  const node = {
    description: '  Shared inventory\n  and stock movements.  ',
    links: [
      ...['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/private', '/relative', 'mailto:test@example.com',
        'not a URL', 'https://user:password@example.com/'].map(url => ({ url })),
      { label: '<b>Inventory</b>', url: 'https://example.com/inventory' },
      { label: 'Docs', url: 'https://example.com/docs' },
    ],
  };
  const before = structuredClone(node);
  assert.deepEqual(nodeCardDetails(node), {
    description: 'Shared inventory and stock movements.',
    launch: { label: '<b>Inventory</b>', url: 'https://example.com/inventory' },
  });
  assert.deepEqual(node, before, 'card preview does not rewrite map data');
  assert.deepEqual(nodeCardDetails({}), { description: '', launch: null });
  assert.equal(nodeCardDetails({ links: node.links.slice(0, 7) }).launch, null);
  assert.deepEqual(nodeCardDetails({ links: [{ url: 'http://localhost:4717/' }] }).launch,
    { label: 'localhost', url: 'http://localhost:4717/' });
  assert.equal(nodeCardDetails({ links: [{ label: '  ', url: 'https://example.com/' }] }).launch.label, 'example.com');
});
