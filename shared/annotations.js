// Board-only content. It never participates in process flow, costs or ownership.
// No HTML interpretation, remote fonts, image loading or Markdown dependencies.
export const ANNOTATION_FONTS = {
  system: { label: 'System sans', stack: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' },
  humanist: { label: 'Humanist', stack: 'Optima, Candara, Calibri, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, monospace' },
};
export const ANNOTATION_LIMITS = { minWidth: 80, maxWidth: 2400, minHeight: 40, maxHeight: 3200, minFont: 10, maxFont: 72, maxText: 40000 };

export function normalizeAnnotations(raw, ownerId, path, err) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { err(path, '"annotations:" must be a list.'); return []; }
  return raw.flatMap((value, i) => {
    const p = [...path, i];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      err(p, 'A board annotation must be a map.'); return [];
    }
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) err([...p, 'id'], 'An annotation needs a unique id using letters, digits, hyphens or underscores.');
    if (!['note', 'text'].includes(value.kind)) err([...p, 'kind'], 'Annotation kind must be "note" or "text".');
    if (typeof value.markdown !== 'string' || value.markdown.length > ANNOTATION_LIMITS.maxText) {
      err([...p, 'markdown'], `Annotation markdown must be text of at most ${ANNOTATION_LIMITS.maxText} characters.`);
    }
    for (const key of ['x', 'y']) if (!Number.isFinite(value.position?.[key]) || Math.abs(value.position[key]) > 1000000) {
      err([...p, 'position', key], 'Annotation position must use finite coordinates between -1000000 and 1000000.');
    }
    for (const [key, min, max] of [['width', ANNOTATION_LIMITS.minWidth, ANNOTATION_LIMITS.maxWidth],
      ['height', ANNOTATION_LIMITS.minHeight, ANNOTATION_LIMITS.maxHeight]]) {
      if (!Number.isFinite(value.size?.[key]) || value.size[key] < min || value.size[key] > max) err([...p, 'size', key], `Annotation ${key} must be ${min}–${max}.`);
    }
    const font = value.font ?? 'system', fontSize = value.fontSize ?? 16;
    if (!Object.hasOwn(ANNOTATION_FONTS, font)) err([...p, 'font'], `Annotation font must be one of: ${Object.keys(ANNOTATION_FONTS).join(', ')}.`);
    if (!Number.isFinite(fontSize) || fontSize < ANNOTATION_LIMITS.minFont || fontSize > ANNOTATION_LIMITS.maxFont) {
      err([...p, 'fontSize'], `Annotation fontSize must be ${ANNOTATION_LIMITS.minFont}–${ANNOTATION_LIMITS.maxFont}.`);
    }
    return [{ id, kind: value.kind, markdown: typeof value.markdown === 'string' ? value.markdown : '',
      position: value.position, size: value.size, font, fontSize, ownerId }];
  });
}

// A deliberately bounded Markdown subset. Unmatched markup and raw HTML stay
// literal; image/link syntax is also literal and cannot make network requests.
export function inlineMarkdown(text, style = {}, depth = 0) {
  if (depth > 8) return [{ text, ...style }];
  // Within italic text, consume a nested strong span as one unit so its
  // opening pair cannot be mistaken for the outer span's closing delimiter.
  const runs = [], pattern = /\\([\\`*_])|(`+)([\s\S]*?)\2|(\*\*\*|___)(?=\S)([\s\S]*?\S)\4|(\*\*|__)(?=\S)([\s\S]*?\S)\6(?![*_])|(\*|_)(?=\S)((?:\8\8(?=\S)[^\n]*?\S\8\8|(?!\8)[^\n])+?)(?<=\S)\8(?![*_])/g;
  let start = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > start) runs.push({ text: text.slice(start, match.index), ...style });
    if (match[1]) runs.push({ text: match[1], ...style });
    else if (match[2]) runs.push({ text: match[3], ...style, code: true });
    else runs.push(...inlineMarkdown(match[5] ?? match[7] ?? match[9], {
      ...style, ...(match[4] ? { bold: true, italic: true } : { [match[6] ? 'bold' : 'italic']: true }),
    }, depth + 1));
    start = pattern.lastIndex;
  }
  if (start < text.length) runs.push({ text: text.slice(start), ...style });
  return runs;
}

export function markdownBlocks(markdown) {
  const blocks = [];
  let fence = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1][0] === fence)) { fence = fence ? null : marker[1][0]; continue; }
    if (fence) { blocks.push({ runs: [{ text: line || ' ', code: true }], code: true }); continue; }
    if (!line.trim()) { blocks.push({ gap: true }); continue; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const text = heading ? heading[2] : list ? list[3] : quote ? quote[1] : line;
    blocks.push({ runs: inlineMarkdown(text, heading ? { bold: true } : {}),
      heading: heading?.[1].length ?? 0, quote: !!quote,
      indent: list ? Math.min(4, Math.floor(list[1].length / 2)) : 0,
      bullet: list ? (/\d/.test(list[2]) ? list[2] : '•') : '' });
  }
  return blocks;
}

let measureContext;
function measureRun(text, style, size, font) {
  if (measureContext === undefined) {
    try { measureContext = globalThis.document?.createElement('canvas').getContext('2d') ?? null; } catch { measureContext = null; }
  }
  if (!measureContext) return Array.from(text).length * size * (style.code ? 0.62 : 0.57);
  measureContext.font = `${style.italic ? 'italic' : 'normal'} ${style.bold ? 700 : 400} ${size}px ${ANNOTATION_FONTS[style.code ? 'mono' : font]?.stack ?? ANNOTATION_FONTS.system.stack}`;
  return measureContext.measureText(text).width;
}

// Native SVG line layout, reused by the canvas and the live editor preview.
export function layoutAnnotation(annotation, measure = measureRun) {
  const padding = annotation.kind === 'note' ? 22 : 6;
  const lines = [];
  let y = padding, horizontalOverflow = false;
  for (const block of markdownBlocks(annotation.markdown)) {
    const base = annotation.fontSize ?? 16;
    if (block.gap) { y += base * 0.6; continue; }
    const size = base * (block.heading ? [1, 1.6, 1.35, 1.17, 1.08, 1, 1][block.heading] : 1);
    const height = size * 1.45;
    if (block.heading && lines.length) y += base * 0.3;
    const levelIndent = block.indent * size * 1.125;
    const markerWidth = block.bullet ? measure(block.bullet, {}, size, annotation.font) : 0;
    const indent = block.bullet ? levelIndent + markerWidth + Math.max(8, size * 0.4) : block.quote ? 16 : 0;
    const available = annotation.size.width - padding * 2 - indent;
    const width = Math.max(1, available);
    if (available < 1) horizontalOverflow = true;
    let runs = [], used = 0, first = true;
    const flush = () => {
      lines.push({ runs, x: padding + indent, y: y + size, size, height, quote: block.quote,
        bullet: first ? block.bullet : '', bulletX: padding + levelIndent });
      y += height; runs = []; used = 0; first = false;
    };
    const append = (text, style, measured) => {
      runs.push({ ...style, text, x: used }); used += measured;
      if (used > width) horizontalOverflow = true;
    };
    for (const run of block.runs) {
      const preserveSpace = block.code || run.code;
      const text = preserveSpace ? run.text.replace(/\t/g, '    ') : run.text;
      for (const token of text.split(/(\s+)/).filter(Boolean)) {
        if (!used && /^\s+$/.test(token) && !preserveSpace) continue;
        let w = measure(token, run, size, annotation.font);
        if (used && used + w > width) { flush(); if (/^\s+$/.test(token) && !preserveSpace) continue; }
        if (w <= width) append(token, run, w);
        else for (const char of Array.from(token)) {
          w = measure(char, run, size, annotation.font);
          if (used && used + w > width) flush();
          append(char, run, w);
        }
      }
    }
    if (runs.length || first) flush();
  }
  return { lines, padding, contentHeight: Math.ceil(y + padding), horizontalOverflow,
    overflow: horizontalOverflow || y + padding > annotation.size.height };
}
