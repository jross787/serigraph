import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { buildExport } from '../server/export.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('validate CLI: exit 0 on valid, 1 on invalid, messages have lines', () => {
  const good = '/tmp/opsmap-test-good.yaml';
  const bad = '/tmp/opsmap-test-bad.yaml';
  writeFileSync(good, 'name: G\nnodes:\n  - id: a\n    type: process\n    label: A\n');
  writeFileSync(bad, 'name: B\nnodes:\n  - id: a\n    type: nope\n    label: A\n');
  try {
    const out = execFileSync('node', ['tools/validate.mjs', good], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /PASS/);
    assert.throws(() => execFileSync('node', ['tools/validate.mjs', bad], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }),
      (e) => e.status === 1 && /line 4/.test(e.stderr));
  } finally {
    rmSync(good, { force: true });
    rmSync(bad, { force: true });
  }
});

test('generator is deterministic and self-validating', () => {
  const a = execFileSync('node', ['tools/generate-map.mjs', '--nodes', '80', '--depth', '3', '--seed', '5'], { cwd: ROOT, encoding: 'utf8' });
  const b = execFileSync('node', ['tools/generate-map.mjs', '--nodes', '80', '--depth', '3', '--seed', '5'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(a, b);
  assert.match(a, /^name:/m);
});

test('standalone export inlines everything and rewrites module specifiers', async () => {
  const source = readFileSync(path.join(ROOT, 'maps/lending.yaml'), 'utf8');
  const html = await buildExport(ROOT, 'lending', source);
  assert.match(html, /<title>Meridian Funding — Operations Map — Opsmap<\/title>/);
  assert.ok(html.includes('window.OPSMAP_STANDALONE'), 'embeds map payload');
  assert.ok(html.includes('type="importmap"'), 'has import map');
  assert.ok(!html.includes('src="/app/'), 'no external app references left');
  assert.ok(!html.includes('href="/app/'), 'no external css references left');
  assert.ok(!html.includes('src="/vendor/'), 'no external vendor references left');
  const mapJson = html.match(/<script type="importmap">(.*?)<\/script>/s)[1];
  const im = JSON.parse(mapJson);
  assert.ok(Object.keys(im.imports).length >= 11, 'all modules present in import map');
  for (const v of Object.values(im.imports)) assert.match(v, /^data:text\/javascript;base64,/);
  // decoded modules must not contain unresolved relative imports
  for (const [k, v] of Object.entries(im.imports)) {
    const src = Buffer.from(v.split(',')[1], 'base64').toString('utf8');
    const bad = src.match(/from\s*['"]\.\.?\//);
    assert.equal(bad, null, `unrewritten relative import in ${k}`);
  }
});

test('export html embeds the actual YAML source verbatim', async () => {
  const source = 'name: Tiny\nnodes:\n  - id: only\n    type: role\n    label: "Solo 🎯"\n';
  const html = await buildExport(ROOT, 'tiny', source);
  const payload = JSON.parse(html.match(/window\.OPSMAP_STANDALONE = (.*?);<\/script>/s)[1]);
  assert.equal(payload.source, source);
  assert.equal(payload.name, 'Tiny');
});

test('export survives $-replacement patterns in user YAML (regression)', async () => {
  const source = `name: "Payroll $& Books"\ndescription: "figures in $'000 and $\` too"\nnodes:\n  - id: a\n    type: process\n    label: "Costs $$ everywhere"\n`;
  const html = await buildExport(ROOT, 'dollar', source);
  const payload = JSON.parse(html.match(/window\.OPSMAP_STANDALONE = (.*?);<\/script>/s)[1]);
  assert.equal(payload.source, source, 'YAML embedded verbatim');
  assert.match(html, /<title>Payroll \$&(amp;)? Books — Opsmap<\/title>|<title>Payroll \$& Books — Opsmap<\/title>/);
  assert.ok(!html.includes("</body></html></script>"), 'no document-tail splicing');
});

test('generator hits the requested node count exactly (several seeds)', async () => {
  const { parseMap } = await import('../shared/model.js');
  for (const seed of ['1', '4', '7']) {
    const out = execFileSync('node', ['tools/generate-map.mjs', '--nodes', '150', '--depth', '4', '--seed', seed], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const { model, errors } = parseMap(out);
    assert.deepEqual(errors, [], `seed ${seed} valid`);
    assert.equal(model.nodeCount, 150, `seed ${seed} exact count`);
  }
});
