#!/usr/bin/env node
// Validate one or more Serigraph YAML files: node tools/validate.mjs maps/*.yaml
import { readFileSync } from 'node:fs';
import { parseMap } from '../shared/model.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/validate.mjs <file.yaml> [more.yaml ...]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`FAIL ${file}: ${e.message}`);
    failed = true;
    continue;
  }
  const { model, errors, warnings } = parseMap(source);
  if (errors.length) {
    failed = true;
    console.error(`FAIL ${file}`);
    for (const e of errors) console.error(`  ${e.line ? `line ${e.line}: ` : ''}${e.message}`);
  } else {
    const depths = [...model.byId.values()].map(n => n.depth);
    const maxDepth = depths.length ? Math.max(...depths) + 1 : 0;
    console.log(`PASS ${file} — "${model.name}", ${model.nodeCount} nodes, ${maxDepth} level(s) deep`);
  }
  for (const w of warnings ?? []) console.log(`  warn${w.line ? ` line ${w.line}` : ''}: ${w.message}`);
}
process.exit(failed ? 1 : 0);
