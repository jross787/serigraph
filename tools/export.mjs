#!/usr/bin/env node
// Generate a portable map from any repo, without starting a server or loading
// environment/provider settings. Export is not publication.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';
import { buildExport } from '../server/export.js';

const usage = 'Usage: node /path/to/serigraph/tools/export.mjs INPUT.yaml --out OUTPUT.html';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(`${usage}\nCreates a new self-contained, read-only HTML file. Existing files are never overwritten.`);
} else if (args.length !== 3 || args[1] !== '--out' || !/\.ya?ml$/i.test(args[0]) || !/\.html?$/i.test(args[2])) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const input = path.resolve(args[0]);
    const output = path.resolve(args[2]);
    const source = await readFile(input, 'utf8');
    const { model, errors } = parseMap(source);
    if (errors.length) throw new Error(errors.map((e) => `${e.line ? `line ${e.line}: ` : ''}${e.message}`).join('\n'));
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const id = path.basename(input).replace(/\.ya?ml$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-') || 'map';
    const html = await buildExport(root, id, source);
    await writeFile(output, html, { encoding: 'utf8', flag: 'wx' });
    console.log(`Exported ${model.name} to ${output}\nOpen this HTML file in a current browser; Serigraph is not required.`);
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Output already exists. Choose a new filename.' : error.message);
    process.exitCode = 1;
  }
}
