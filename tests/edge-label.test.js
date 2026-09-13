import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeLabelBubble, EDGE_LABEL_SIZE } from '../app/layout.js';

test('connection bubbles fit measured text with padding and retain the long-label cap', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({
    measureText: (text) => ({ width: [...text].reduce((sum, char) => sum + (char === 'i' ? 3 : 8), 0) }),
  }) }) };
  try {
    const short = edgeLabelBubble('Yes');
    assert.deepEqual(short, { text: 'Yes', lines: ['Yes'], w: 48, h: 28 });
    assert.ok(edgeLabelBubble('iii').w < edgeLabelBubble('WWW').w, 'measure glyphs, not character count');
    assert.ok(edgeLabelBubble('').w >= 28, 'rounded bubble retains its minimum diameter');
    const long = edgeLabelBubble('A deliberately long connection description that exceeds the width limit');
    assert.ok(long.w <= EDGE_LABEL_SIZE.w);
    assert.ok(long.text.endsWith('…'));
    assert.equal(long.h, EDGE_LABEL_SIZE.h);
    assert.equal(long.lines.length, 2);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
