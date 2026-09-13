import { ANNOTATION_FONTS, layoutAnnotation } from '../shared/annotations.js';

const SVG = 'http://www.w3.org/2000/svg';
let clipId = 0;
const el = (tag, attrs = {}, text = null) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
};

// Text remains native SVG, including in PNG rasterization. No foreignObject,
// HTML injection, resource URLs or browser-only fonts enter the exported board.
export function buildAnnotation(annotation, { interactive = true } = {}) {
  const { width, height } = annotation.size;
  const layout = layoutAnnotation(annotation);
  const clip = `annotation-clip-${++clipId}`;
  const group = el('g', { class: `board-annotation annotation-${annotation.kind}`,
    transform: `translate(${annotation.position.x},${annotation.position.y})`,
    'data-annotation-id': annotation.id,
    ...(interactive ? { tabindex: '0', role: 'button', 'aria-label': `${annotation.kind === 'note' ? 'Note' : 'Text'}: ${annotation.markdown.slice(0, 240)}` } : {}),
  });
  group.append(el('title', {}, annotation.markdown));
  group.append(el('rect', { class: 'annotation-surface', width, height, rx: annotation.kind === 'note' ? 14 : 3 }));
  const defs = el('defs'), clipPath = el('clipPath', { id: clip });
  clipPath.append(el('rect', { x: layout.padding - 2, y: layout.padding - 2,
    width: width - layout.padding * 2 + 4, height: Math.max(0, height - layout.padding * 2 - (layout.overflow ? 18 : 0)) }));
  defs.append(clipPath); group.append(defs);
  const content = el('g', { class: 'annotation-content', 'clip-path': `url(#${clip})` });
  for (const line of layout.lines) {
    if (line.y - line.size > height) break;
    const text = el('text', { x: line.x, y: line.y, 'font-size': line.size,
      'font-family': ANNOTATION_FONTS[annotation.font]?.stack ?? ANNOTATION_FONTS.system.stack });
    for (const run of line.runs) text.append(el('tspan', {
      x: line.x + run.x, 'font-weight': run.bold ? 700 : 400, 'font-style': run.italic ? 'italic' : 'normal',
      ...(run.code ? { 'font-family': ANNOTATION_FONTS.mono.stack } : {}),
    }, run.text));
    if (line.quote) content.append(el('line', { class: 'annotation-quote', x1: layout.padding + 2, x2: layout.padding + 2,
      y1: line.y - line.size, y2: line.y + line.size * 0.3 }));
    if (line.bullet) content.append(el('text', { x: line.bulletX, y: line.y, 'font-size': line.size,
      'font-family': ANNOTATION_FONTS[annotation.font]?.stack ?? ANNOTATION_FONTS.system.stack }, line.bullet));
    content.append(text);
  }
  group.append(content);
  if (layout.overflow) group.append(el('text', { class: 'annotation-overflow', x: layout.padding, y: height - 9,
    'font-size': 11, 'font-family': ANNOTATION_FONTS.system.stack }, 'More text · resize or open notes'));
  if (interactive) {
    group.append(el('rect', { class: 'annotation-selection', x: -3, y: -3, width: width + 6, height: height + 6, rx: 16 }));
    for (const [direction, x, y] of [['nw', 0, 0], ['n', width / 2, 0], ['ne', width, 0], ['e', width, height / 2],
      ['se', width, height], ['s', width / 2, height], ['sw', 0, height], ['w', 0, height / 2]]) {
      group.append(el('rect', { class: 'annotation-resize', 'data-resize': direction,
        x: x - 5, y: y - 5, width: 10, height: 10, rx: 3 }));
    }
  }
  return group;
}
