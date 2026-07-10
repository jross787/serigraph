// Builds a single self-contained, read-only HTML file for a map.
// Strategy: inline CSS + dagre; ship every ES module as a data: URL wired
// up through an import map (specifiers rewritten to bare "opsmap/…" keys).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseMap } from '../shared/model.js';

const MODULE_FILES = [
  'vendor/yaml.js',
  'shared/model.js',
  'app/state.js',
  'app/api.js',
  'app/layout.js',
  'app/canvas.js',
  'app/edit.js',
  'app/controller.js',
  'app/ui.js',
  'app/present.js',
  'app/main.js',
];

// rewrite './x.js' / '../shared/model.js' specifiers to bare "opsmap/…" keys
function rewriteSpecifiers(source, moduleDir) {
  return source.replace(
    /(from\s*|import\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (all, lead, quote, spec) => {
      const resolved = path.posix.normalize(path.posix.join(moduleDir, spec));
      return `${lead}${quote}opsmap/${resolved}${quote}`;
    },
  );
}

const escapeInline = (s) => s.replace(/<\/script/gi, '<\\/script');

export async function buildExport(root, id, mapSource) {
  const read = (p) => fs.readFile(path.join(root, p), 'utf8');

  const [html, css, dagre] = await Promise.all([
    read('app/index.html'),
    read('app/styles.css'),
    read('vendor/dagre.min.js'),
  ]);

  const importMap = { imports: {} };
  for (const file of MODULE_FILES) {
    const src = rewriteSpecifiers(await read(file), path.posix.dirname(file));
    importMap.imports[`opsmap/${file}`] = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  }

  const { model } = parseMap(mapSource);
  const title = model ? `${model.name} — Opsmap` : `${id} — Opsmap`;
  const payload = JSON.stringify({ id, name: model?.name ?? id, source: mapSource }).replace(/</g, '\\u003c');

  let out = html;
  out = out.replace(/<title>.*?<\/title>/, `<title>${title.replace(/</g, '&lt;')}</title>`);
  out = out.replace(
    /<link rel="stylesheet" href="\/app\/styles.css">/,
    `<style>\n${css}\n</style>`,
  );
  out = out.replace(
    /<script src="\/vendor\/dagre.min.js"><\/script>/,
    `<script>${escapeInline(dagre)}</script>`,
  );
  out = out.replace(
    /<script type="module" src="\/app\/main.js"><\/script>/,
    [
      `<script>window.OPSMAP_STANDALONE = ${escapeInline(payload)};</script>`,
      `<script type="importmap">${escapeInline(JSON.stringify(importMap))}</script>`,
      `<script type="module">import 'opsmap/app/main.js';</script>`,
    ].join('\n'),
  );
  return out;
}
