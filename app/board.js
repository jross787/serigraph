// Board annotation editing and endpoint gestures. All writes use the existing
// comment-preserving commit/undo/save pipeline; previews never change YAML.
import { state, bus } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import * as canvas from './canvas.js';
import { attachmentAt } from './layout.js';
import { buildAnnotation } from './annotation-view.js';
import { ANNOTATION_FONTS, ANNOTATION_LIMITS as LIMITS, layoutAnnotation } from '../shared/annotations.js';

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter(value => value != null));
  return node;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const editable = () => state.model && !state.standalone && !state.presenting && !state.updateApplying;

export function resizeAnnotation(annotation, direction, dx, dy) {
  const { x, y } = annotation.position, { width, height } = annotation.size;
  const w = clamp(width + (direction.includes('w') ? -dx : direction.includes('e') ? dx : 0), LIMITS.minWidth, LIMITS.maxWidth);
  const ht = clamp(height + (direction.includes('n') ? -dy : direction.includes('s') ? dy : 0), LIMITS.minHeight, LIMITS.maxHeight);
  return { ...annotation, size: { width: Math.round(w), height: Math.round(ht) },
    position: { x: Math.round(x + (direction.includes('w') ? width - w : 0)), y: Math.round(y + (direction.includes('n') ? height - ht : 0)) } };
}

export function openAnnotationEditor(id = null, kind = 'note') {
  if (!editable() || document.querySelector('.board-editor[open]')) return false;
  const existing = id ? state.model.annotationById.get(id) : null;
  if (id && !existing) return false;
  const scopeId = state.scopeId, mapId = state.mapId, libraryId = state.libraryId;
  const original = existing ? JSON.stringify(existing) : null;
  const bounds = document.getElementById('canvas').getBoundingClientRect();
  const center = canvas.worldAt(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const draft = existing ? structuredClone(existing) : {
    id: 'preview', kind, markdown: kind === 'note' ? '## A little context\n\nExplain the map here.\n\n- **What matters**\n- What happens next' : 'Your text here',
    font: 'system', fontSize: kind === 'note' ? 16 : 28,
    position: { x: Math.round(center.x - 180), y: Math.round(center.y - 130) },
    size: { width: 360, height: kind === 'note' ? 260 : 100 },
  };
  const dialog = h('dialog', { class: 'dialog board-editor', 'aria-labelledby': 'board-editor-title' });
  const form = h('form');
  const textarea = h('textarea', { class: 'f-textarea board-markdown', 'aria-label': 'Markdown text', maxlength: LIMITS.maxText, spellcheck: 'true' });
  textarea.value = draft.markdown;
  const font = h('select', { class: 'f-select', 'aria-label': 'Font' },
    Object.entries(ANNOTATION_FONTS).map(([value, entry]) => h('option', { value }, entry.label)));
  font.value = draft.font;
  const input = (name, value, min, max) => h('input', { class: 'f-input', type: 'number', required: '', min, max, step: 1, value, 'aria-label': name });
  const fontSize = input('Font size', draft.fontSize, 10, 72);
  const width = input('Block width', draft.size.width, LIMITS.minWidth, LIMITS.maxWidth);
  const height = input('Block height', draft.size.height, LIMITS.minHeight, LIMITS.maxHeight);
  const appearance = h('select', { class: 'f-select', 'aria-label': 'Text appearance' },
    h('option', { value: 'note' }, 'Note block'), h('option', { value: 'text' }, 'Freeform text'));
  appearance.value = draft.kind;
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  preview.setAttribute('role', 'img'); preview.setAttribute('aria-label', 'Markdown preview');
  const hint = h('p', { class: 'hint', role: 'status' });
  const updatePreview = () => {
    draft.markdown = textarea.value; draft.font = font.value; draft.kind = appearance.value;
    draft.fontSize = clamp(Number(fontSize.value) || 16, 10, 72);
    draft.size = { width: clamp(Number(width.value) || 360, LIMITS.minWidth, LIMITS.maxWidth),
      height: clamp(Number(height.value) || 260, LIMITS.minHeight, LIMITS.maxHeight) };
    preview.setAttribute('viewBox', `-8 -8 ${draft.size.width + 16} ${draft.size.height + 16}`);
    preview.replaceChildren(buildAnnotation({ ...draft, position: { x: 0, y: 0 } }, { interactive: false }));
    hint.textContent = layoutAnnotation(draft).overflow ? 'Some text is outside the block. Increase its size or choose Fit text.' : 'All text fits. Drag the block to move it; select it to resize.';
  };
  const format = (before, after = before, linePrefix = false) => {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (linePrefix) {
      const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
      const selected = textarea.value.slice(lineStart, end);
      textarea.setRangeText(selected.split('\n').map(line => before + line).join('\n'), lineStart, end, 'select');
    } else textarea.setRangeText(`${before}${textarea.value.slice(start, end) || 'text'}${after}`, start, end, 'select');
    textarea.focus(); updatePreview();
  };
  const toolbar = h('div', { class: 'board-format-toolbar', role: 'toolbar', 'aria-label': 'Markdown formatting' },
    h('button', { type: 'button', class: 'd-btn', title: 'Bold (⌘/Ctrl B)', 'aria-label': 'Bold', onClick: () => format('**') }, h('strong', {}, 'B')),
    h('button', { type: 'button', class: 'd-btn', title: 'Italic (⌘/Ctrl I)', 'aria-label': 'Italic', onClick: () => format('*') }, h('em', {}, 'I')),
    h('button', { type: 'button', class: 'd-btn', onClick: () => format('## ', '', true) }, 'Heading'),
    h('button', { type: 'button', class: 'd-btn', onClick: () => format('- ', '', true) }, '• List'),
    h('button', { type: 'button', class: 'd-btn', onClick: () => format('> ', '', true) }, 'Quote'),
    h('button', { type: 'button', class: 'd-btn', onClick: () => format('`') }, 'Code'));
  textarea.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || !['b', 'i'].includes(event.key.toLowerCase())) return;
    event.preventDefault(); format(event.key.toLowerCase() === 'b' ? '**' : '*');
  });
  for (const field of [textarea, font, fontSize, width, height, appearance]) field.addEventListener('input', updatePreview);
  const close = () => { dialog.close(); dialog.remove(); };
  let pending = false;
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) close(); });
  const error = h('p', { class: 'board-error', role: 'alert' });
  const apply = h('button', { type: 'submit', class: 'd-btn primary' }, existing ? 'Apply changes' : 'Add to board');
  const cancel = h('button', { type: 'button', class: 'd-btn', onClick: close }, 'Cancel');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    if (!editable() || mapId !== state.mapId || libraryId !== state.libraryId || scopeId !== state.scopeId
      || (existing && JSON.stringify(state.model.annotationById.get(id)) !== original)) {
      error.textContent = 'The map or this annotation changed. Cancel and reopen it to review the current version.'; return;
    }
    updatePreview(); pending = true; apply.disabled = true; cancel.disabled = true;
    let nextId = id;
    const ok = await ctrl.commit(() => {
      if (existing) edit.updateAnnotation(id, draft);
      else nextId = edit.addAnnotation(scopeId, draft);
    }, { historyLabel: existing ? 'edit board text' : `add ${draft.kind === 'note' ? 'note block' : 'freeform text'}` });
    pending = false; apply.disabled = false; cancel.disabled = false;
    if (ok) { close(); ctrl.selectAnnotation(nextId); }
    else error.textContent = 'Could not apply the changes. Your draft is still here.';
  });
  const field = (label, control) => h('label', { class: 'f-field' }, label, control);
  form.append(h('span', { class: 'inspector-eyebrow' }, 'Board annotation'),
    h('h2', { id: 'board-editor-title' }, existing ? 'Edit your words' : 'Give the map some context'),
    h('div', { class: 'board-type-controls' }, field('Appearance', appearance), field('Font', font), field('Size', fontSize)),
    h('div', { class: 'board-editor-columns' },
      h('div', {}, toolbar, textarea, h('p', { class: 'hint' }, 'Markdown: headings, bullets, numbered lists, quotes, **bold**, *italic* and `code`. HTML, images and links stay literal.')),
      h('div', { class: 'board-preview-column' }, h('span', { class: 'inspector-eyebrow' }, 'Live preview'), h('div', { class: 'board-preview' }, preview), hint)),
    h('div', { class: 'board-size-controls' }, field('Width', width), field('Height', height),
      h('button', { type: 'button', class: 'd-btn', onClick: () => { updatePreview(); height.value = clamp(layoutAnnotation(draft).contentHeight, LIMITS.minHeight, LIMITS.maxHeight); updatePreview(); } }, 'Fit text')),
    error, h('div', { class: 'dialog-actions' }, cancel, apply));
  dialog.append(form); document.body.append(dialog); updatePreview(); dialog.showModal();
  textarea.focus(); if (!existing) textarea.select();
  return true;
}

export async function duplicateBoardSelection() {
  if (!editable() || !state.selectedAnnotationId) return false;
  let id;
  const ok = await ctrl.commit(() => { id = edit.duplicateAnnotation(state.selectedAnnotationId); }, { historyLabel: 'duplicate board text' });
  if (ok) ctrl.selectAnnotation(id);
  return ok;
}

export async function deleteBoardSelection() {
  if (!editable() || !state.selectedAnnotationId) return false;
  const id = state.selectedAnnotationId;
  const ok = await ctrl.commit(() => edit.deleteAnnotation(id), { historyLabel: 'delete board text' });
  if (ok) { ctrl.clearSelection(); bus.emit('toast', 'Board text deleted. Undo restores it.'); }
  return ok;
}

export function renderAnnotationDetail(panel) {
  const annotation = state.model?.annotationById.get(state.selectedAnnotationId);
  if (!annotation) { panel.hidden = true; return; }
  panel.hidden = false; panel.classList.remove('editing', 'automation-lens', 'edge-detail');
  panel.replaceChildren(h('div', { class: 'panel-head' }, h('div', { class: 'titles' },
    h('span', { class: 'inspector-eyebrow' }, 'Board annotation'), h('h2', {}, annotation.kind === 'note' ? 'Note block' : 'Freeform text')),
    h('button', { class: 'panel-close', onClick: () => ctrl.clearSelection() }, 'Close')),
  h('div', { class: 'panel-body' }, h('p', { class: 'field-help' }, `${ANNOTATION_FONTS[annotation.font].label} · ${annotation.fontSize} px · ${annotation.size.width} × ${annotation.size.height}`),
    editable() ? h('div', { class: 'board-detail-actions' }, h('button', { class: 'd-btn primary', onClick: () => openAnnotationEditor(annotation.id) }, 'Edit text & font'),
      h('button', { class: 'd-btn', onClick: duplicateBoardSelection }, 'Duplicate'), h('button', { class: 'd-btn', onClick: deleteBoardSelection }, 'Delete')) : null,
    h('h3', {}, 'Full Markdown text'), h('pre', { class: 'annotation-source' }, annotation.markdown),
    h('p', { class: 'field-help' }, 'Explanatory content only. Notes do not count as process steps, costs, or connections.')));
}

export function initBoardGestures(svg) {
  let drag = null;
  const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const finish = async (commit) => {
    const current = drag; drag = null;
    if (!current) return;
    try { svg.releasePointerCapture(current.pointerId); } catch { /* already released */ }
    const sameContext = state.mapId === current.mapId && state.libraryId === current.libraryId
      && state.scopeId === current.scopeId && state.source === current.source;
    if (commit && current.active && editable() && sameContext) {
      await ctrl.commit(() => current.endpoint
        ? edit.setEdgeAnchor({ scopeId: current.scopeId, index: current.index }, current.endpoint, current.anchor)
        : edit.updateAnnotation(current.annotation.id, { position: current.preview.position, size: current.preview.size }),
      { historyLabel: current.endpoint ? 'position connection anchor' : current.direction ? 'resize board text' : 'move board text' });
    }
    if (current.active && state.model) { canvas.refreshScope(state.model); canvas.paintSelection(); }
  };
  svg.addEventListener('pointerdown', event => {
    if (drag && event.pointerId !== drag.pointerId) { stop(event); finish(false); return; }
    if (event.button !== 0 || canvas.isTransitioning() || !state.model || event.target.closest('[data-peer-scope]')) return;
    const item = event.target.closest('.board-annotation'), handle = event.target.closest('.edge-anchor');
    if (!item && !handle) return;
    if (state.activeTool === 'hand') return;
    stop(event);
    const start = canvas.worldAt(event.clientX, event.clientY);
    const common = { start, px: event.clientX, py: event.clientY, pointerId: event.pointerId, active: false,
      mapId: state.mapId, libraryId: state.libraryId, scopeId: state.scopeId, source: state.source };
    if (item) {
      const annotation = state.model.annotationById.get(item.dataset.annotationId);
      if (!annotation || annotation.ownerId !== state.scopeId) return;
      ctrl.selectAnnotation(annotation.id);
      drag = { ...common, annotation, preview: annotation, direction: event.target.closest('[data-resize]')?.dataset.resize };
    } else if (editable()) {
      const index = Number(handle.dataset.edgeIndex), endpoint = handle.dataset.anchor;
      const le = canvas.getLayout()?.edges.find(edge => edge.index === index);
      const node = canvas.getLayout()?.nodes.find(node => node.id === le?.edge[endpoint]);
      if (!node) return;
      ctrl.selectEdge(index); drag = { ...common, index, endpoint, node };
    }
  }, true);
  svg.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    stop(event);
    if (!(event.buttons & 1)) { finish(false); return; }
    if (!editable()) return;
    if (!drag.active && Math.hypot(event.clientX - drag.px, event.clientY - drag.py) < 4) return;
    if (!drag.active) svg.setPointerCapture(event.pointerId);
    drag.active = true;
    const point = canvas.worldAt(event.clientX, event.clientY);
    if (drag.endpoint) {
      drag.anchor = attachmentAt(drag.node, point); canvas.previewEdgeAnchor(drag.index, drag.endpoint, drag.anchor);
    } else {
      const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      drag.preview = drag.direction ? resizeAnnotation(drag.annotation, drag.direction, dx, dy)
        : { ...drag.annotation, position: { x: Math.round(drag.annotation.position.x + dx), y: Math.round(drag.annotation.position.y + dy) } };
      canvas.previewAnnotation(drag.preview);
    }
  }, true);
  svg.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) { stop(event); finish(true); } }, true);
  svg.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) { stop(event); finish(false); } }, true);
  window.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finish(false); });
  svg.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) finish(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { stop(event); finish(false); } }, true);
  svg.addEventListener('dblclick', event => {
    const item = event.target.closest('.board-annotation');
    if (!item) return;
    stop(event);
    if (!item.closest('[data-peer-scope]')) openAnnotationEditor(item.dataset.annotationId);
  }, true);
  svg.addEventListener('keydown', event => {
    const item = event.target.closest('.board-annotation');
    if (!item || item.closest('[data-peer-scope]') || !['Enter', ' '].includes(event.key)) return;
    stop(event); ctrl.selectAnnotation(item.dataset.annotationId);
    if (event.key === 'Enter') openAnnotationEditor(item.dataset.annotationId);
  }, true);
}
