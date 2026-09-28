import { ANNOTATION_FONTS, ANNOTATION_STROKES, DRAWING_KINDS, layoutAnnotation } from '../shared/annotations.js';

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
  if (DRAWING_KINDS.includes(annotation.kind)) return buildDrawing(annotation, { interactive });
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
    // Words flow from the line's start as the browser sets them. Pinning each
    // word to a measured spot left uneven gaps when the measuring font and the
    // drawn font differed slightly.
    for (const run of line.runs) text.append(el('tspan', {
      'font-weight': run.bold ? 700 : 400, 'font-style': run.italic ? 'italic' : 'normal',
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

// A pen stroke as a smooth curve: straight to the first point, then through
// the midpoints between samples, so jitter turns into a clean line.
export function inkPath(points) {
  const pts = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts.map(([x, y]) => `${x} ${y}`).join(' L')}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx} ${ly}`;
}

function arrowhead(fromX, fromY, toX, toY, weight) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const size = 7 + weight * 1.6;
  const spread = Math.PI / 7;
  const point = (a) => `${toX - size * Math.cos(a)},${toY - size * Math.sin(a)}`;
  return el('polygon', { class: 'draw-arrowhead', points: `${toX},${toY} ${point(angle - spread)} ${point(angle + spread)}` });
}

const DRAWING_NAMES = { shape: 'Shape', boundary: 'Boundary', line: 'Line', ink: 'Drawing' };

function buildDrawing(a, { interactive = true } = {}) {
  const { width, height } = a.size;
  const weight = ANNOTATION_STROKES[a.stroke] ?? 1.5;
  const group = el('g', {
    class: `board-annotation annotation-${a.kind} draw-color-${a.color}${a.fill ?? a.kind === 'boundary' ? ' draw-filled' : ''}`,
    transform: `translate(${a.position.x},${a.position.y})`,
    'data-annotation-id': a.id,
    ...(interactive ? { tabindex: '0', role: 'button', 'aria-label': `${DRAWING_NAMES[a.kind]}${a.markdown ? `: ${a.markdown.slice(0, 240)}` : ''}` } : {}),
  });
  if (a.markdown) group.append(el('title', {}, a.markdown));
  const line = { 'stroke-width': weight, ...(a.dash ? { 'stroke-dasharray': `${weight * 3.5} ${weight * 2.5}` } : {}) };
  const hitWidth = Math.max(14, weight + 12);
  if (a.kind === 'shape' || a.kind === 'boundary') {
    const make = () => a.kind === 'shape' && a.shape === 'ellipse'
      ? el('ellipse', { cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2 })
      : el('rect', { width, height, rx: a.kind === 'boundary' ? 18 : Math.min(12, width / 4, height / 4) });
    const hit = make();
    hit.setAttribute('class', 'draw-hit');
    hit.setAttribute('stroke-width', hitWidth);
    const shape = make();
    shape.setAttribute('class', 'draw-shape');
    for (const [key, value] of Object.entries(line)) shape.setAttribute(key, value);
    group.append(shape, hit);
    const label = String(a.markdown ?? '').split('\n')[0].trim();
    if (a.kind === 'boundary') {
      // The name tab is also a handle: grab it to move the boundary.
      group.append(el('rect', { class: 'draw-hit-area', width: Math.min(width, 360), height: 40, rx: 12 }));
      if (label) group.append(el('text', { class: 'boundary-label', x: 18, y: 27 }, label));
    } else if (label) {
      group.append(el('text', { class: 'shape-label', x: width / 2, y: height / 2 + 5, 'text-anchor': 'middle' }, label));
    }
  } else if (a.kind === 'line') {
    const [x1, y1, x2, y2] = a.points;
    group.append(el('line', { class: 'draw-hit', x1, y1, x2, y2, 'stroke-width': hitWidth }));
    const stroke = el('line', { class: 'draw-stroke', x1, y1, x2, y2 });
    for (const [key, value] of Object.entries(line)) stroke.setAttribute(key, value);
    group.append(stroke);
    if (a.arrow === 'end' || a.arrow === 'both') group.append(arrowhead(x1, y1, x2, y2, weight));
    if (a.arrow === 'both') group.append(arrowhead(x2, y2, x1, y1, weight));
  } else {
    const d = inkPath(a.points);
    group.append(el('path', { class: 'draw-hit', d, 'stroke-width': hitWidth }));
    const stroke = el('path', { class: 'draw-stroke', d });
    for (const [key, value] of Object.entries(line)) stroke.setAttribute(key, value);
    group.append(stroke);
  }
  if (interactive) {
    group.append(el('rect', { class: 'annotation-selection', x: -6, y: -6, width: width + 12, height: height + 12, rx: 10 }));
    if (a.kind === 'line') {
      const [x1, y1, x2, y2] = a.points;
      for (const [end, x, y] of [['start', x1, y1], ['end', x2, y2]]) {
        group.append(el('circle', { class: 'annotation-resize line-end', 'data-line-end': end, cx: x, cy: y, r: 6 }));
      }
    } else {
      for (const [direction, x, y] of [['nw', 0, 0], ['n', width / 2, 0], ['ne', width, 0], ['e', width, height / 2],
        ['se', width, height], ['s', width / 2, height], ['sw', 0, height], ['w', 0, height / 2]]) {
        group.append(el('rect', { class: 'annotation-resize', 'data-resize': direction, x: x - 5, y: y - 5, width: 10, height: 10, rx: 3 }));
      }
    }
  }
  return group;
}
