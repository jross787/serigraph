#!/usr/bin/env node
// Validate Serigraph YAML maps: node tools/validate.mjs [file.yaml ...]
// With no arguments, walks maps/, templates/, and projects/*/ (one level).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';
import { parseProjectIndex, PROJECT_INDEX_FILE } from '../shared/projects.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// a project index file is not a map
const INDEX_RE = /^projects\.ya?ml$/;

// display name of the project a file belongs to, or null for root maps and
// templates — used to label PASS lines for project maps
function projectFor(file) {
  const rel = path.relative(ROOT, path.resolve(file)).split(path.sep);
  if (rel.length !== 3 || rel[0] !== 'projects') return null;
  try {
    const { name } = parseProjectIndex(readFileSync(path.join(ROOT, 'projects', rel[1], PROJECT_INDEX_FILE), 'utf8'));
    return name ?? rel[1];
  } catch { return rel[1]; }
}

function yamlFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch { return []; }
}

// jobs carry a label so walk mode can print tidy root-relative paths no
// matter where the command was invoked from
let jobs = process.argv.slice(2).map((f) => ({ file: f, label: f }));
if (!jobs.length) {
  for (const dir of ['maps', 'templates']) {
    for (const f of yamlFiles(path.join(ROOT, dir))) jobs.push({ file: path.join(ROOT, dir, f), label: path.join(dir, f) });
  }
  let slugs = [];
  try {
    slugs = readdirSync(path.join(ROOT, 'projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { /* no projects/ yet */ }
  for (const slug of slugs) {
    for (const f of yamlFiles(path.join(ROOT, 'projects', slug))) {
      if (INDEX_RE.test(f)) continue;
      jobs.push({ file: path.join(ROOT, 'projects', slug, f), label: path.join('projects', slug, f) });
    }
  }
}
if (!jobs.length) {
  console.error('usage: node tools/validate.mjs <file.yaml> [more.yaml ...]\n       (no arguments: validate maps/, templates/, and projects/*/)');
  process.exit(2);
}

let failed = false;
for (const { file, label } of jobs) {
  const project = projectFor(file);
  if (project && INDEX_RE.test(path.basename(file))) continue; // indexes are not maps
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    failed = true;
    continue;
  }
  const { model, errors, warnings } = parseMap(source);
  if (errors.length) {
    failed = true;
    console.error(`FAIL ${label}`);
    for (const e of errors) console.error(`  ${e.line ? `line ${e.line}: ` : ''}${e.message}`);
  } else {
    const depths = [...model.byId.values()].map(n => n.depth);
    const maxDepth = depths.length ? Math.max(...depths) + 1 : 0;
    const where = project ? `[${project}] ` : '';
    console.log(`PASS ${label} — ${where}"${model.name}", ${model.nodeCount} nodes, ${maxDepth} level(s) deep`);
  }
  for (const w of warnings ?? []) console.log(`  warn${w.line ? ` line ${w.line}` : ''}: ${w.message}`);
}
process.exit(failed ? 1 : 0);
