import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseMap } from '../shared/model.js';
import { inlineMarkdown, layoutAnnotation, markdownBlocks } from '../shared/annotations.js';
import { state } from '../app/state.js';
import * as edit from '../app/edit.js';
import { invalidateLayouts, layoutScope, siblingContextLayout } from '../app/layout.js';
import { resizeAnnotation } from '../app/board.js';
import { mapMarkdown } from '../app/product.js';
import { buildExport } from '../server/export.js';

const annotation = { id: 'context', kind: 'note', markdown: '## Context\n\n- **Important** point\n- *Next* step',
  position: { x: -400, y: 80 }, size: { width: 360, height: 260 }, font: 'system', fontSize: 16 };
const source = (extra = {}) => JSON.stringify({ name: 'Synthetic notes', nodes: [], annotations: [annotation], ...extra });
const load = (text = source()) => {
  const result = parseMap(text); assert.deepEqual(result.errors, []);
  state.doc = result.doc; state.model = result.model; state.source = text;
  return result.model;
};
const save = () => { const text = state.doc.toString({ lineWidth: 0 }); return { text, model: load(text) }; };

test('notes and text are scope-local annotations, not nodes, edges, or Freeform elements', () => {
  for (const mode of ['process', 'freeform']) {
    const model = load(source({ mode, ...(mode === 'freeform' ? { elements: [] } : {}), nodes: [
      { id: 'group', type: 'process', label: 'Group', children: { nodes: [], annotations: [{ ...annotation, id: 'inside', kind: 'text' }] } },
    ] }));
    assert.equal(model.nodeCount, 1);
    assert.equal(model.root.annotations.length, 1);
    assert.equal(model.byId.get('group').children.annotations[0].ownerId, 'group');
    assert.equal(model.byId.get('group').stats.childCount, 0);
    assert.equal(model.annotationById.size, 2);
    assert.equal(model.byId.has('context'), false);
    assert.equal(model.elementById.size, 0);
  }
});

test('annotation contract rejects invalid kinds, typography, geometry and duplicate ids', () => {
  for (const bad of [{ kind: 'script' }, { font: 'https://fonts.invalid/font' }, { font: '__proto__' },
    { fontSize: 9 }, { fontSize: 73 }, { markdown: 12 }, { markdown: 'x'.repeat(40001) }, { id: 'bad"id' },
    { size: { width: 0, height: 80 } }, { size: { width: 200, height: 4000 } }, { position: { x: 1 } }]) {
    assert.ok(parseMap(source({ annotations: [{ ...annotation, ...bad }] })).errors.length, JSON.stringify(bad).slice(0, 100));
  }
  assert.ok(parseMap(source({ annotations: [annotation, annotation] })).errors.length);
  assert.ok(parseMap(source({ nodes: [{ id: 'context', type: 'process', label: 'Same ID' }] })).errors.length);
  assert.ok(parseMap(source({ annotations: {} })).errors.length);
  assert.ok(parseMap(source({ edges: [{ from: 'context', to: 'context' }] })).errors.length, 'notes cannot become flow endpoints');
});

test('annotation edits preserve surrounding comments and stable ids; duplicate and delete are reversible YAML edits', () => {
  load('name: Notes # keep this\nnodes: []\n# a board note\nannotations:\n  - id: context\n    kind: note\n    markdown: Hello # keep this too\n    position: {x: 1, y: 2}\n    size: {width: 200, height: 120}\n');
  edit.updateAnnotation('context', { markdown: '**Edited**', size: { width: 480, height: 360 }, font: 'serif', fontSize: 24 });
  let { text, model } = save();
  assert.match(text, /# keep this/); assert.match(text, /# a board note/);
  assert.equal(model.annotationById.get('context').font, 'serif');
  const original = text;
  const id = edit.duplicateAnnotation('context'); ({ model } = save());
  assert.equal(id, 'context-copy'); assert.deepEqual(model.annotationById.get(id).position, { x: 29, y: 30 });
  edit.deleteAnnotation(id); ({ model } = save());
  assert.equal(model.annotationById.size, 1);
  load(original); assert.equal(state.model.annotationById.get('context').markdown, '**Edited**', 'undo source restores the content');
  assert.equal(edit.addAnnotation(null, annotation), 'note');
  save(); assert.equal(edit.addAnnotation(null, annotation), 'note-2'); save();
});

test('legacy children can gain notes, keep them after the last node is deleted, and clone their annotation ids', () => {
  load('name: Nested\nnodes:\n  - id: group\n    type: process\n    label: Group\n    children:\n      # legacy child\n      - {id: step, type: process, label: Step}\n');
  edit.addAnnotation('group', annotation); let { text } = save(); assert.match(text, /# legacy child/);
  edit.deleteNode('step'); let { model } = save();
  assert.equal(model.byId.get('group').children.annotations.length, 1);
  const copy = edit.duplicateNode('group'); ({ model } = save());
  assert.equal(model.byId.get(copy).children.annotations[0].id, 'note-copy');
  assert.equal(model.annotationById.size, 2);
});

test('changing annotation scalars and geometry retains comments; unchanged drafts are source no-ops', () => {
  load('name: Notes\nnodes: []\nannotations:\n  - id: context\n    kind: note\n    markdown: Before # text context\n    position: # placement context\n      x: 1 # horizontal context\n      y: 2\n    size: {width: 200, height: 120} # size context\n    font: serif # font context\n');
  const before = state.doc.toString({ lineWidth: 0 });
  edit.updateAnnotation('context', state.model.annotationById.get('context'));
  assert.equal(state.doc.toString({ lineWidth: 0 }), before);
  edit.updateAnnotation('context', { markdown: 'After', position: {x: 10, y: 20}, size: {width: 350, height: 300}, font: 'mono' });
  const { text } = save();
  for (const comment of ['# text context', '# placement context', '# horizontal context', '# size context', '# font context']) assert.ok(text.includes(comment), comment);
});

test('template insertion retains annotations and exact anchors with collision-safe ids', () => {
  const template = parseMap(source({ nodes: [{ id: 'a', type: 'process', label: 'A' }, { id: 'b', type: 'process', label: 'B' }],
    edges: [{ from: 'a', to: 'b', fromSide: 'bottom', fromOffset: 0, toSide: 'top', toOffset: 0.9, route: 'stepped' }] })).model;
  load(); edit.insertTemplate(null, template); const { model } = save();
  assert.equal(model.root.edges[0].fromOffset, 0); assert.equal(model.root.edges[0].toOffset, 0.9);
  assert.equal(model.annotationById.size, 2); assert.ok(model.annotationById.has('context-2'));
});

test('Markdown supports styled runs, headings, lists, quotes and code without interpreting resources', () => {
  assert.deepEqual(inlineMarkdown('One **bold** and *italic* `code`').filter(run => run.bold || run.italic || run.code),
    [{ text: 'bold', bold: true }, { text: 'italic', italic: true }, { text: 'code', code: true }]);
  const blocks = markdownBlocks('# Title\n- Point\n1. First\n> Quote\n```js\n**literal**\n```');
  assert.equal(blocks[0].heading, 1); assert.equal(blocks[1].bullet, '•'); assert.equal(blocks[2].bullet, '1.');
  assert.equal(blocks[3].quote, true); assert.deepEqual(blocks[4].runs, [{ text: '**literal**', code: true }]);
  const untrusted = '<script>alert(1)</script> ![photo](https://example.invalid/a.png) [link](javascript:alert(1))';
  assert.equal(inlineMarkdown(untrusted).map(run => run.text).join(''), untrusted);
});

test('measured Markdown wraps long identifiers and preserves all text when the block is too short', () => {
  const note = { ...annotation, size: { width: 180, height: 80 }, markdown: '## Heading\n' + 'LongUnbrokenIdentifier'.repeat(8) };
  const measure = (text, _style, size) => Array.from(text).length * size * 0.6;
  const layout = layoutAnnotation(note, measure);
  assert.ok(layout.overflow); assert.ok(layout.contentHeight > 80);
  for (const line of layout.lines) for (const run of line.runs) {
    assert.ok(line.x + run.x + measure(run.text, run, line.size) <= note.size.width - layout.padding + 0.001);
  }
  const fit = layoutAnnotation({ ...note, size: { ...note.size, height: layout.contentHeight } }, measure);
  assert.equal(fit.overflow, false);
});

test('combined bold and italic formatting renders without stray delimiters', () => {
  for (const markdown of ['***both***', '___both___', '**_both_**', '*__both__*']) {
    assert.deepEqual(inlineMarkdown(markdown), [{ text: 'both', bold: true, italic: true }], markdown);
  }
  assert.deepEqual(inlineMarkdown('**bold *and italic***'), [
    { text: 'bold ', bold: true }, { text: 'and italic', bold: true, italic: true },
  ]);
  for (const markdown of ['*italic **and bold***', '_italic __and bold___']) {
    assert.deepEqual(inlineMarkdown(markdown), [
      { text: 'italic ', italic: true }, { text: 'and bold', italic: true, bold: true },
    ]);
  }
  assert.deepEqual(inlineMarkdown('*one **bold** and **another** end*'), [
    { text: 'one ', italic: true }, { text: 'bold', italic: true, bold: true },
    { text: ' and ', italic: true }, { text: 'another', italic: true, bold: true }, { text: ' end', italic: true },
  ]);
});

test('numbered list gutters follow measured font size and disclose horizontal overflow', () => {
  const measure = (text, _style, size) => Array.from(text).length * size * 0.6;
  for (const bullet of ['10.', '12345.', '•']) {
    const layout = layoutAnnotation({ ...annotation, font: 'mono', fontSize: 72,
      markdown: `${bullet === '•' ? '-' : bullet} Words`, size: { width: 900, height: 400 } }, measure);
    const line = layout.lines[0];
    assert.equal(line.bullet, bullet);
    assert.ok(line.bulletX + measure(bullet, {}, line.size) < line.x);
    assert.equal(layout.overflow, false);
  }
  const narrow = layoutAnnotation({ ...annotation, fontSize: 72, markdown: '10. A', size: { width: 80, height: 400 } }, measure);
  assert.equal(narrow.horizontalOverflow, true); assert.equal(narrow.overflow, true);
});

test('fenced and inline code retain indentation, including blank lines and tabs', () => {
  const layout = layoutAnnotation({ ...annotation, markdown: '```\n    indented\n\n\talso indented\n```\n`  inline  `' });
  assert.deepEqual(layout.lines.map(line => line.runs.map(run => run.text).join('')), [
    '    indented', ' ', '    also indented', '  inline  ',
  ]);
  assert.ok(layout.lines.flatMap(line => line.runs).every(run => run.code));
});

test('resize clamps dimensions and keeps the opposite corner fixed', () => {
  const shrunk = resizeAnnotation(annotation, 'nw', 9999, 9999);
  assert.deepEqual(shrunk.size, { width: 80, height: 40 });
  assert.equal(shrunk.position.x + shrunk.size.width, annotation.position.x + annotation.size.width);
  const expanded = resizeAnnotation(annotation, 'se', 9999, 9999);
  assert.deepEqual(expanded.size, { width: 2400, height: 3200 });
  assert.deepEqual(expanded.position, annotation.position);
});

test('layout fits annotation-only boards and adding text never rearranges process cards', () => {
  const context = {}; vm.runInNewContext(readFileSync(new URL('../vendor/dagre.min.js', import.meta.url), 'utf8'), context);
  globalThis.dagre = context.dagre;
  globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) };
  invalidateLayouts(); let layout = layoutScope(load(), null);
  assert.equal(layout.w, 360); assert.equal(layout.x, -400); assert.equal(layout.ownerId, null);
  const nodes = [{ id: 'a', type: 'process', label: 'A', position: { x: 600, y: 180 } }];
  invalidateLayouts(); const before = layoutScope(load(source({ nodes, annotations: [] })), null).nodes.map(({x, y, w, h}) => ({x, y, w, h}));
  invalidateLayouts(); layout = layoutScope(load(source({ nodes })), null);
  assert.deepEqual(layout.nodes.map(({x, y, w, h}) => ({x, y, w, h})), before);
  assert.ok(layout.w >= 1000); assert.equal(layout.annotations.length, 1);
});

test('portable HTML embeds every annotation module; Markdown exports keep risky syntax literal', async () => {
  const model = load(source({ annotations: [{ ...annotation, markdown: '```\n![private](https://example.invalid/photo)\n<script>bad()</script>' }] }));
  const markdown = mapMarkdown(model);
  assert.match(markdown, /````markdown\n```/);
  const html = await buildExport(new URL('..', import.meta.url).pathname, 'synthetic', state.source);
  for (const module of ['shared/annotations.js', 'app/annotation-view.js', 'app/board.js']) assert.ok(html.includes(`opsmap/${module}`));
  assert.ok(!html.includes('<script>bad()</script>'));
});

test('nested annotations expand fit bounds without resizing the parent or moving siblings', () => {
  const make = annotations => source({ annotations: [], nodes: [
    { id: 'group', type: 'process', label: 'Parent', children: { nodes: [
      { id: 'first', type: 'process', label: 'First', position: {x: 0, y: 0} },
      { id: 'second', type: 'process', label: 'Second', position: {x: 0, y: 400} },
    ], annotations } }, { id: 'sibling', type: 'process', label: 'Sibling' },
  ], edges: [{ from: 'group', to: 'sibling' }] });
  const positions = layout => layout.nodes.map(({id, x, y, w, h}) => ({id, x, y, w, h}));
  invalidateLayouts(); const baseline = positions(layoutScope(load(make([])), null));
  for (const size of [{width: 2400, height: 40}, {width: 80, height: 3200}]) {
    invalidateLayouts(); const layout = layoutScope(load(make([{ ...annotation, size }])), null);
    assert.deepEqual(positions(layout), baseline);
    const child = layoutScope(state.model, 'group');
    assert.equal(child.graphBounds.w, 200);
    assert.ok(child.w > child.graphBounds.w || child.h > child.graphBounds.h);
  }
});

test('connected annotation-only Freeform groups have finite Fit bounds and minimap content', () => {
  const model = load(source({ mode: 'freeform', elements: [], annotations: [], nodes: [
    { id: 'a', type: 'item', label: 'A', children: { nodes: [], annotations: [annotation] } },
    { id: 'b', type: 'item', label: 'B', children: { nodes: [], annotations: [{ ...annotation, id: 'peer' }] } },
  ], edges: [{ from: 'a', to: 'b' }] }));
  invalidateLayouts();
  const entries = ['a', 'b'].map((id, i) => {
    const layout = layoutScope(model, id), dx = i * 700, dy = i * 60;
    return { layout, dx, dy, frame: { x: layout.x + dx - 20, y: layout.y + dy - 40, w: layout.w + 40, h: layout.h + 60 } };
  });
  const bounds = siblingContextLayout(entries);
  assert.equal(bounds.nodes.length, 0); assert.equal(bounds.annotations.length, 2);
  assert.equal(bounds.annotations[1].x, annotation.position.x + 700);
  for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(bounds[key]));
  for (const note of bounds.annotations) {
    assert.ok(note.x >= bounds.x && note.y >= bounds.y);
    assert.ok(note.x + note.w <= bounds.x + bounds.w && note.y + note.h <= bounds.y + bounds.h);
  }
  assert.deepEqual(siblingContextLayout([]), { nodes: [], annotations: [], x: 0, y: 0, w: 0, h: 0 });
});
