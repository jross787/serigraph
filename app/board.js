// Board annotation editing and endpoint gestures. All writes use the existing
// comment-preserving commit/undo/save pipeline; previews never change YAML.
import { state, bus } from './state.js';
import * as ctrl from './controller.js';
import * as edit from './edit.js';
import * as canvas from './canvas.js';
import { attachmentAt, invalidateLayouts } from './layout.js';
import { buildAnnotation } from './annotation-view.js';
import { ANNOTATION_FONTS, ANNOTATION_LIMITS as LIMITS, ANNOTATION_COLORS, ANNOTATION_STROKES, DRAWING_KINDS, layoutAnnotation } from '../shared/annotations.js';

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

const DRAWING_LIMITS = {
  line: { minWidth: 0, maxWidth: 20000, minHeight: 0, maxHeight: 20000 },
  ink: { minWidth: 0, maxWidth: 20000, minHeight: 0, maxHeight: 20000 },
  shape: { minWidth: 12, maxWidth: 20000, minHeight: 12, maxHeight: 20000 },
  boundary: { minWidth: 12, maxWidth: 20000, minHeight: 12, maxHeight: 20000 },
};

export function resizeAnnotation(annotation, direction, dx, dy) {
  const limits = DRAWING_LIMITS[annotation.kind] ?? LIMITS;
  const { x, y } = annotation.position, { width, height } = annotation.size;
  const w = clamp(width + (direction.includes('w') ? -dx : direction.includes('e') ? dx : 0), limits.minWidth, limits.maxWidth);
  const ht = clamp(height + (direction.includes('n') ? -dy : direction.includes('s') ? dy : 0), limits.minHeight, limits.maxHeight);
  const next = { ...annotation, size: { width: Math.round(w), height: Math.round(ht) },
    position: { x: Math.round(x + (direction.includes('w') ? width - w : 0)), y: Math.round(y + (direction.includes('n') ? height - ht : 0)) } };
  // A pen stroke stretches with its box.
  if (annotation.kind === 'ink') {
    const sx = width ? w / width : 1, sy = height ? ht / height : 1;
    next.points = annotation.points.map((value, i) => Math.round(value * (i % 2 ? sy : sx)));
  }
  return next;
}

// ── drawing ─────────────────────────────────────────────────────────
const DRAW_TOOL_IDS = new Set(['text', 'pen', 'rect', 'ellipse', 'boundary', 'arrow', 'line']);
const STYLE_KEY = 'serigraph-draw-style';
const DEFAULT_STYLE = { color: 'blue', stroke: 'medium', fill: false, dash: false };
function drawStyle() {
  try { return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) || '{}') }; } catch { return { ...DEFAULT_STYLE }; }
}
function rememberStyle(fields) {
  const next = { ...drawStyle() };
  for (const key of Object.keys(DEFAULT_STYLE)) if (fields[key] !== undefined) next[key] = fields[key];
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(next)); } catch { /* per-session only */ }
}

// Keep the stroke's shape but drop points that add nothing (Douglas–Peucker).
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  let index = 0, farthest = 0;
  const dx = last.x - first.x, dy = last.y - first.y, length = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = Math.abs(dy * points[i].x - dx * points[i].y + last.x * first.y - last.y * first.x) / length;
    if (distance > farthest) { farthest = distance; index = i; }
  }
  if (farthest <= tolerance) return [first, last];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

const snapAngle = (from, to) => {
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
};

function lineFrom(start, end, fields) {
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
  return { ...fields, kind: 'line', position: { x: Math.round(x), y: Math.round(y) },
    size: { width: Math.round(Math.abs(end.x - start.x)), height: Math.round(Math.abs(end.y - start.y)) },
    points: [start.x - x, start.y - y, end.x - x, end.y - y].map(Math.round) };
}

// What the gesture would draw right now: a live preview, or the final shape.
function drawnAnnotation(draw, end, { shift = false, final = false } = {}) {
  const start = draw.points[0];
  const style = draw.style;
  // The file keeps only what differs from each kind's defaults.
  const look = { id: 'draft', color: style.color, stroke: style.stroke, ...(style.dash ? { dash: true } : {}) };
  if (draw.tool === 'pen') {
    const points = final ? simplify(draw.points, 0.9 / Math.max(0.2, canvas.getCamera().k)) : draw.points;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    const flat = points.length > 1 ? points.flatMap((p) => [p.x - x, p.y - y]) : [0, 0, 0.5, 0.5];
    return { ...look, kind: 'ink', position: { x: Math.round(x), y: Math.round(y) },
      size: { width: Math.round(Math.max(...xs) - x), height: Math.round(Math.max(...ys) - y) }, points: flat.map(Math.round) };
  }
  if (draw.tool === 'arrow' || draw.tool === 'line') {
    let target = shift ? snapAngle(start, end) : end;
    if (final && Math.hypot(target.x - start.x, target.y - start.y) < 6) target = { x: start.x + 140, y: start.y };
    return lineFrom(start, target, { ...look, arrow: draw.tool === 'arrow' ? 'end' : 'none' });
  }
  let w = end.x - start.x, h = end.y - start.y;
  if (shift) { const side = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * side; h = Math.sign(h || 1) * side; }
  const boundary = draw.tool === 'boundary';
  if (final && Math.abs(w) < 8 && Math.abs(h) < 8) {
    // A click without a drag draws a standard size, centered where you clicked.
    const [dw, dh] = boundary ? [420, 260] : draw.tool === 'ellipse' ? [160, 160] : [180, 110];
    return drawnAnnotation({ ...draw, points: [{ x: start.x - dw / 2, y: start.y - dh / 2 }] }, { x: start.x + dw / 2, y: start.y + dh / 2 });
  }
  const x = w < 0 ? start.x + w : start.x, y = h < 0 ? start.y + h : start.y;
  return {
    ...look,
    kind: boundary ? 'boundary' : 'shape',
    ...(boundary ? { color: style.color === 'gray' ? 'blue' : style.color, stroke: 'thin', dash: true, markdown: '' }
      : { shape: draw.tool === 'ellipse' ? 'ellipse' : 'rect', ...(style.fill ? { fill: true } : {}) }),
    position: { x: Math.round(x), y: Math.round(y) },
    size: { width: Math.round(Math.max(12, Math.abs(w))), height: Math.round(Math.max(12, Math.abs(h))) },
  };
}

// Move a line's start or end to a point; its box follows.
function lineWithEnd(annotation, end, point, shift) {
  const [x1, y1, x2, y2] = annotation.points;
  const { x, y } = annotation.position;
  const start = { x: x + x1, y: y + y1 }, finish = { x: x + x2, y: y + y2 };
  const fixed = end === 'start' ? finish : start;
  const moved = shift ? snapAngle(fixed, point) : point;
  const [a, b] = end === 'start' ? [moved, finish] : [start, moved];
  const next = lineFrom(a, b, annotation);
  return { ...annotation, position: next.position, size: next.size, points: next.points };
}

// ── typing on the board ─────────────────────────────────────────────
// Click with the Text tool, or double-click text, a note, a boundary's name,
// or a shape's label, and type right there. Click away to finish; Esc
// cancels. Notes keep their Markdown; the full editor is in the panel.
let inlineCommit = null;
export function editInline({ id = null, at = null } = {}) {
  if (!editable() || inlineCommit) return false;
  const existing = id ? state.model.annotationById.get(id) : null;
  if (id && (!existing || !['text', 'note', 'boundary', 'shape'].includes(existing.kind))) return false;
  const kind = existing?.kind ?? 'text';
  const scopeId = state.scopeId, mapId = state.mapId, source = state.source;
  const camera = canvas.getCamera(), k = camera.k;
  const bounds = document.getElementById('canvas').getBoundingClientRect();
  const fontSize = kind === 'boundary' ? 15 : kind === 'shape' ? 14 : existing?.fontSize ?? 20;
  // New text starts with its first line centered on the click.
  const origin = existing?.position ?? { x: at.x - 6, y: at.y - 6 - fontSize * 0.725 };
  const screen = (x, y) => ({ left: bounds.left + camera.x + x * k, top: bounds.top + camera.y + y * k });
  const family = kind === 'text' || kind === 'note' ? ANNOTATION_FONTS[existing?.font ?? 'system']?.stack : ANNOTATION_FONTS.system.stack;
  const editor = document.createElement('textarea');
  editor.className = `inline-editor inline-${kind}${existing?.color ? ` draw-color-${existing.color}` : ''}`;
  editor.spellcheck = true;
  editor.rows = 1;
  editor.value = existing?.markdown ?? '';
  editor.setAttribute('aria-label', kind === 'boundary' ? 'Boundary name' : kind === 'shape' ? 'Shape label' : 'Text');
  Object.assign(editor.style, { fontSize: `${fontSize * k}px`, fontFamily: family, lineHeight: '1.45' });
  const place = () => {
    if (kind === 'boundary') {
      Object.assign(editor.style, { ...px(screen(origin.x + 12, origin.y + 8)), width: `${Math.max(160, Math.min(existing.size.width - 24, 360)) * k}px`, fontWeight: 650 });
    } else if (kind === 'shape') {
      const width = Math.max(80, existing.size.width - 16);
      Object.assign(editor.style, { ...px(screen(origin.x + (existing.size.width - width) / 2, origin.y + existing.size.height / 2 - 14)), width: `${width * k}px`, textAlign: 'center', fontWeight: 600 });
    } else if (kind === 'note') {
      Object.assign(editor.style, { ...px(screen(origin.x, origin.y)), width: `${existing.size.width * k}px`, height: `${existing.size.height * k}px`, padding: `${22 * k}px` });
    } else {
      Object.assign(editor.style, { ...px(screen(origin.x, origin.y)), padding: `${6 * k}px`, minWidth: `${60 * k}px` });
    }
  };
  const px = ({ left, top }) => ({ left: `${left}px`, top: `${top}px` });
  const fit = () => {
    if (kind === 'text') {
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = `${fontSize * k}px ${family}`;
      const widest = Math.max(...editor.value.split('\n').map((line) => measure.measureText(line || ' ').width));
      editor.style.width = `${Math.max(60 * k, widest + 14 * k + 8)}px`;
    }
    if (kind !== 'note') { editor.style.height = 'auto'; editor.style.height = `${editor.scrollHeight}px`; }
  };
  const target = existing ? document.querySelector(`.board-annotation[data-annotation-id="${CSS.escape(existing.id)}"]`) : null;
  target?.classList.add('inline-editing');
  place();
  document.body.append(editor);
  fit();
  editor.focus();
  if (existing) editor.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    inlineCommit = null;
    editor.remove();
    target?.classList.remove('inline-editing');
    unsubscribe();
    const value = kind === 'boundary' || kind === 'shape' ? editor.value.replace(/\s*\n\s*/g, ' ').trim() : editor.value.replace(/\s+$/, '');
    if (!existing) bus.emit('drawing-done'); // the Text tool types one piece of text
    if (!save || !editable() || state.mapId !== mapId || state.scopeId !== scopeId || state.source !== source) return;
    if (existing && value === (existing.markdown ?? '')) return;
    if (!existing && !value.trim()) return;
    let nextId = id;
    const ok = await ctrl.commit(() => {
      if (!existing) {
        const draft = { kind: 'text', markdown: value, font: 'system', fontSize, position: { x: Math.round(origin.x), y: Math.round(origin.y) }, size: { width: 360, height: 40 } };
        draft.size = fittedTextSize(draft);
        nextId = edit.addAnnotation(scopeId, draft);
      } else if (kind === 'text' && !value.trim()) {
        edit.deleteAnnotation(existing.id);
        nextId = null;
      } else if (kind === 'text' || kind === 'note') {
        const draft = { ...existing, markdown: value };
        const fitted = fittedTextSize(draft, kind === 'note');
        edit.updateAnnotation(existing.id, { markdown: value, size: fitted });
      } else {
        edit.updateAnnotation(existing.id, { markdown: value });
      }
    }, { historyLabel: existing ? `edit ${kind === 'boundary' ? 'boundary name' : kind === 'shape' ? 'shape label' : 'board text'}` : 'add text' });
    if (ok && nextId) ctrl.selectAnnotation(nextId);
  };
  inlineCommit = finish;
  editor.addEventListener('input', fit);
  editor.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || kind === 'boundary' || kind === 'shape')) { event.preventDefault(); finish(true); }
  });
  editor.addEventListener('blur', () => finish(true));
  // Moving the map closes the editor, keeping what was typed.
  const unsubscribe = bus.on('camera-changed', () => editor.blur());
  return true;
}

// Size a text block to its words: as wide as its longest line (up to a
// comfortable reading width), as tall as its lines. Notes keep their width
// and grow only when the words need more room.
function fittedTextSize(annotation, keepWidth = false) {
  let width = annotation.size.width;
  if (!keepWidth) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${annotation.fontSize}px ${ANNOTATION_FONTS[annotation.font]?.stack ?? ANNOTATION_FONTS.system.stack}`;
    const widest = Math.max(...annotation.markdown.split('\n').map((line) => measure.measureText(line).width));
    width = clamp(Math.ceil(widest + 16), LIMITS.minWidth, 720);
  }
  const height = clamp(layoutAnnotation({ ...annotation, size: { width, height: LIMITS.maxHeight } }).contentHeight, LIMITS.minHeight, LIMITS.maxHeight);
  return { width, height: keepWidth ? Math.max(annotation.size.height, height) : height };
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
  const fontSize = input('Font size', draft.fontSize, LIMITS.minFont, LIMITS.maxFont);
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
    draft.fontSize = clamp(Number(fontSize.value) || 16, LIMITS.minFont, LIMITS.maxFont);
    draft.size = { width: clamp(Number(width.value) || 360, LIMITS.minWidth, LIMITS.maxWidth),
      height: clamp(Number(height.value) || 260, LIMITS.minHeight, LIMITS.maxHeight) };
    preview.setAttribute('viewBox', `-8 -8 ${draft.size.width + 16} ${draft.size.height + 16}`);
    preview.replaceChildren(buildAnnotation({ ...draft, position: { x: 0, y: 0 } }, { interactive: false }));
    const layout = layoutAnnotation(draft);
    hint.textContent = layout.horizontalOverflow ? 'The text is too wide. Increase the width or reduce the font size.'
      : layout.overflow ? 'Some text is outside the block. Increase its size or choose Fit text.' : 'All text fits. Drag the block to move it; select it to resize.';
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
  const ok = await ctrl.commit(() => edit.deleteAnnotation(id), { historyLabel: 'delete from board' });
  if (ok) { ctrl.clearSelection(); bus.emit('toast', 'Deleted. Undo restores it.'); }
  return ok;
}

const KIND_NAMES = { shape: 'Shape', boundary: 'Boundary', line: 'Line', ink: 'Drawing' };
const COLOR_NAMES = { gray: 'Gray', blue: 'Blue', green: 'Green', orange: 'Orange', red: 'Red', purple: 'Purple', yellow: 'Yellow', teal: 'Teal' };

// Style a drawing: color, line weight, fill, dashes, arrowheads, and name.
// Each change saves at once and becomes the style of the next drawing.
function renderDrawingDetail(panel, annotation) {
  const set = async (fields, label = 'style drawing') => {
    const ok = await ctrl.commit(() => edit.updateAnnotation(annotation.id, fields), { historyLabel: label });
    if (ok) { rememberStyle(fields); ctrl.selectAnnotation(annotation.id); }
  };
  const choice = (label, options, current, onPick) => h('div', { class: 'draw-choice', role: 'group', 'aria-label': label },
    options.map(([value, name]) => h('button', { type: 'button', class: 'd-btn', 'aria-pressed': String(value === current), onClick: () => onPick(value) }, name)));
  const swatches = h('div', { class: 'draw-swatches', role: 'group', 'aria-label': 'Color' },
    ANNOTATION_COLORS.map((color) => h('button', { type: 'button', class: `draw-swatch draw-color-${color}`, title: COLOR_NAMES[color],
      'aria-label': COLOR_NAMES[color], 'aria-pressed': String(color === annotation.color), onClick: () => set({ color }) })));
  const sections = [
    h('h3', {}, 'Color'), swatches,
    h('h3', {}, 'Line'), choice('Line weight', Object.keys(ANNOTATION_STROKES).map((key) => [key, key[0].toUpperCase() + key.slice(1)]), annotation.stroke, (stroke) => set({ stroke })),
    choice('Line style', [[false, 'Solid'], [true, 'Dashed']], annotation.dash, (dash) => set({ dash })),
  ];
  if (annotation.kind === 'shape') {
    sections.push(h('h3', {}, 'Shape'), choice('Shape', [['rect', 'Rectangle'], ['ellipse', 'Ellipse']], annotation.shape, (shape) => set({ shape })),
      choice('Fill', [[false, 'No fill'], [true, 'Tinted fill']], annotation.fill, (fill) => set({ fill })));
  }
  if (annotation.kind === 'boundary') {
    sections.push(h('h3', {}, 'Background'), choice('Fill', [[true, 'Tinted'], [false, 'Clear']], annotation.fill, (fill) => set({ fill })));
  }
  if (annotation.kind === 'line') {
    sections.push(h('h3', {}, 'Arrowheads'), choice('Arrowheads', [['none', 'None'], ['end', 'End'], ['both', 'Both ends']], annotation.arrow, (arrow) => set({ arrow })));
  }
  if (annotation.kind === 'boundary' || annotation.kind === 'shape') {
    const name = h('input', { class: 'f-input', value: annotation.markdown ?? '', placeholder: annotation.kind === 'boundary' ? 'e.g. Billing team' : 'Optional label' });
    name.addEventListener('change', () => set({ markdown: name.value.trim() }, annotation.kind === 'boundary' ? 'rename boundary' : 'label shape'));
    sections.unshift(h('label', { class: 'f-field' }, annotation.kind === 'boundary' ? 'Name' : 'Label', name));
  }
  panel.replaceChildren(h('div', { class: 'panel-head' }, h('div', { class: 'titles' },
    h('span', { class: 'inspector-eyebrow' }, 'On the board'), h('h2', {}, KIND_NAMES[annotation.kind])),
    h('button', { class: 'panel-close', onClick: () => ctrl.clearSelection() }, 'Close')),
  h('div', { class: 'panel-body draw-detail' }, ...(editable() ? sections : []),
    editable() ? h('div', { class: 'board-detail-actions' },
      h('button', { class: 'd-btn', onClick: duplicateBoardSelection }, 'Duplicate'),
      h('button', { class: 'd-btn', onClick: deleteBoardSelection }, 'Delete')) : null,
    h('p', { class: 'field-help' }, annotation.kind === 'boundary'
      ? 'Moving a boundary moves the cards inside it. Double-click its name to rename it.'
      : 'Drawings explain the board. They do not count as steps, costs, or connections.')));
}

export function renderAnnotationDetail(panel) {
  const annotation = state.model?.annotationById.get(state.selectedAnnotationId);
  if (!annotation) { panel.hidden = true; return; }
  if (DRAWING_KINDS.includes(annotation.kind)) {
    panel.hidden = false; panel.classList.remove('editing', 'automation-lens', 'edge-detail');
    return renderDrawingDetail(panel, annotation);
  }
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
  let draw = null;
  const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const finishDraw = async (save) => {
    const current = draw; draw = null;
    canvas.clearDraft();
    if (!current) return;
    try { svg.releasePointerCapture(current.pointerId); } catch { /* already released */ }
    if (!save || !editable() || state.mapId !== current.mapId || state.scopeId !== current.scopeId || state.source !== current.source) return;
    const fields = drawnAnnotation(current, current.last ?? current.points[0], { shift: current.shift, final: true });
    let id;
    const ok = await ctrl.commit(() => { id = edit.addAnnotation(current.scopeId, fields); },
      { historyLabel: `draw ${fields.kind === 'ink' ? 'with the pen' : fields.kind === 'line' ? (fields.arrow === 'none' ? 'a line' : 'an arrow') : fields.kind === 'boundary' ? 'a boundary' : `a${fields.shape === 'ellipse' ? 'n ellipse' : ' rectangle'}`}` });
    if (!ok) return;
    if (current.tool !== 'pen') ctrl.selectAnnotation(id);
    bus.emit('drawing-done');
    if (fields.kind === 'boundary') editInline({ id }); // name it right away
  };
  const finish = async (commit) => {
    const current = drag; drag = null;
    if (!current) return;
    try { svg.releasePointerCapture(current.pointerId); } catch { /* already released */ }
    const sameContext = state.mapId === current.mapId && state.libraryId === current.libraryId
      && state.scopeId === current.scopeId && state.source === current.source;
    if (commit && current.active && editable() && sameContext) {
      const layout = canvas.getLayout();
      await ctrl.commit(() => {
        if (current.endpoint) {
          edit.setEdgeAnchor({ scopeId: current.scopeId, index: current.index }, current.endpoint, current.anchor);
          return;
        }
        edit.updateAnnotation(current.annotation.id, { position: current.preview.position, size: current.preview.size,
          ...(current.preview.points ? { points: current.preview.points } : {}) });
        if (current.carried && current.offset) {
          for (const id of current.carried.nodes) {
            const ln = layout?.nodes.find((n) => n.id === id);
            const from = ln?.boundaryOrigin ?? ln;
            if (from) edit.setNodePosition(id, { x: Math.round(from.x + current.offset.x + ln.w / 2), y: Math.round(from.y + current.offset.y + ln.h / 2) }, current.scopeId);
          }
          for (const other of current.carried.annotations) {
            edit.updateAnnotation(other.id, { position: { x: other.position.x + current.offset.x, y: other.position.y + current.offset.y } });
          }
        }
      }, { historyLabel: current.endpoint ? 'position connection anchor'
        : current.lineEnd ? 'reshape line' : current.direction ? 'resize on board' : current.carried?.nodes.length ? 'move boundary and its cards' : 'move on board' });
    }
    if (current.active && state.model) { invalidateLayouts(); canvas.refreshScope(state.model); canvas.paintSelection(); }
  };
  svg.addEventListener('pointerdown', event => {
    if (drag && event.pointerId !== drag.pointerId) { stop(event); finish(false); return; }
    if (draw && event.pointerId !== draw.pointerId) { stop(event); finishDraw(false); return; }
    if (event.button !== 0 || canvas.isTransitioning() || !state.model || event.target.closest('[data-peer-scope]')) return;
    // A click anywhere on the board finishes text being typed. With the Text
    // tool, that is all the click does.
    const tool = state.activeTool;
    if (inlineCommit) {
      inlineCommit(true);
      if (tool === 'text') { stop(event); return; }
    }
    // A drawing tool draws anywhere, even over cards: circle them, point at
    // them, or sketch beside them.
    if (DRAW_TOOL_IDS.has(tool) && editable()) {
      stop(event);
      const point = canvas.worldAt(event.clientX, event.clientY);
      if (tool === 'text') {
        // Clicking words with the Text tool edits them; anywhere else starts new text.
        const words = event.target.closest('.board-annotation')?.dataset.annotationId;
        const kind = state.model.annotationById.get(words)?.kind;
        if (kind === 'text' || kind === 'note') editInline({ id: words });
        else editInline({ at: point });
        return;
      }
      draw = { tool, pointerId: event.pointerId, points: [point], last: point, shift: event.shiftKey,
        style: drawStyle(), mapId: state.mapId, scopeId: state.scopeId, source: state.source };
      try { svg.setPointerCapture(event.pointerId); } catch { /* stale pointer */ }
      return;
    }
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
      const direction = event.target.closest('[data-resize]')?.dataset.resize;
      const lineEnd = event.target.closest('[data-line-end]')?.dataset.lineEnd;
      drag = { ...common, annotation, preview: annotation, direction, lineEnd };
      // A boundary carries what it surrounds: cards whose centers are
      // inside it, and board items that fit entirely inside it.
      if (annotation.kind === 'boundary' && !direction) {
        const { x, y } = annotation.position, { width, height } = annotation.size;
        const inside = (px, py) => px >= x && px <= x + width && py >= y && py <= y + height;
        drag.carried = {
          nodes: (canvas.getLayout()?.nodes ?? []).filter((n) => inside(n.x + n.w / 2, n.y + n.h / 2)).map((n) => n.id),
          annotations: [...state.model.annotationById.values()].filter((other) => other.id !== annotation.id && other.ownerId === state.scopeId
            && inside(other.position.x, other.position.y) && inside(other.position.x + other.size.width, other.position.y + other.size.height)),
        };
      }
    } else if (editable()) {
      const index = Number(handle.dataset.edgeIndex), endpoint = handle.dataset.anchor;
      const le = canvas.getLayout()?.edges.find(edge => edge.index === index);
      const node = canvas.getLayout()?.nodes.find(node => node.id === le?.edge[endpoint]);
      if (!node) return;
      ctrl.selectEdge(index); drag = { ...common, index, endpoint, node };
    }
  }, true);
  svg.addEventListener('pointermove', event => {
    if (draw && event.pointerId === draw.pointerId) {
      stop(event);
      if (!(event.buttons & 1)) { finishDraw(true); return; }
      const point = canvas.worldAt(event.clientX, event.clientY);
      draw.shift = event.shiftKey;
      draw.last = point;
      const previous = draw.points[draw.points.length - 1];
      if (draw.tool === 'pen' && Math.hypot(point.x - previous.x, point.y - previous.y) * canvas.getCamera().k >= 1.5) draw.points.push(point);
      canvas.showDraft(drawnAnnotation(draw, point, { shift: draw.shift }));
      return;
    }
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
      drag.preview = drag.lineEnd ? lineWithEnd(drag.annotation, drag.lineEnd, point, event.shiftKey)
        : drag.direction ? resizeAnnotation(drag.annotation, drag.direction, dx, dy)
          : { ...drag.annotation, position: { x: Math.round(drag.annotation.position.x + dx), y: Math.round(drag.annotation.position.y + dy) } };
      canvas.previewAnnotation(drag.preview);
      if (drag.carried) {
        drag.offset = { x: Math.round(dx), y: Math.round(dy) };
        canvas.previewNodeOffsets(drag.carried.nodes, drag.offset.x, drag.offset.y);
        for (const other of drag.carried.annotations) canvas.previewAnnotation({ ...other,
          position: { x: other.position.x + drag.offset.x, y: other.position.y + drag.offset.y } }, { selected: false });
      }
    }
  }, true);
  svg.addEventListener('pointerup', event => {
    if (draw?.pointerId === event.pointerId) { stop(event); finishDraw(true); return; }
    if (drag?.pointerId === event.pointerId) { stop(event); finish(true); }
  }, true);
  svg.addEventListener('pointercancel', event => {
    if (draw?.pointerId === event.pointerId) { stop(event); finishDraw(false); return; }
    if (drag?.pointerId === event.pointerId) { stop(event); finish(false); }
  }, true);
  window.addEventListener('pointerup', event => {
    if (draw?.pointerId === event.pointerId) finishDraw(true);
    if (drag?.pointerId === event.pointerId) finish(false);
  });
  svg.addEventListener('lostpointercapture', event => {
    if (draw?.pointerId === event.pointerId) finishDraw(true);
    if (drag?.pointerId === event.pointerId) finish(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (draw) { stop(event); finishDraw(false); }
    else if (drag) { stop(event); finish(false); }
  }, true);
  svg.addEventListener('dblclick', event => {
    const item = event.target.closest('.board-annotation');
    if (!item) return;
    stop(event);
    if (!item.closest('[data-peer-scope]')) editInline({ id: item.dataset.annotationId });
  }, true);
  svg.addEventListener('keydown', event => {
    const item = event.target.closest('.board-annotation');
    if (!item || item.closest('[data-peer-scope]') || !['Enter', ' '].includes(event.key)) return;
    stop(event); ctrl.selectAnnotation(item.dataset.annotationId);
    if (event.key === 'Enter') editInline({ id: item.dataset.annotationId });
  }, true);
}
