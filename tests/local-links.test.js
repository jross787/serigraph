import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalLinks, isLocalLink } from '../server/local-links.js';

const source = '# Preserve this comment\nname: Synthetic Intake\nnodes: [{id: start, type: process, label: Review, position: {x: 1, y: 2}}]\n';
async function workspace(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'serigraph-local-links-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const engineRoot = path.join(dir, 'engine'), originals = path.join(dir, 'originals');
  await fs.mkdir(engineRoot); await fs.mkdir(originals);
  const registryFile = path.join(dir, 'preferences', 'links.json');
  return { engineRoot, originals, registryFile };
}

test('a file link persists outside the engine, resolves the original, deduplicates and removes only its reference', async t => {
  const options = await workspace(t);
  const file = path.join(options.originals, 'File with spaces.yaml');
  await fs.writeFile(file, source);
  const links = createLocalLinks(options), preview = await links.preview(file);
  assert.equal(preview.mapCount, 1); assert.equal(preview.name, 'Synthetic Intake');
  assert.equal(await fs.stat(options.registryFile).catch(() => null), null, 'preview writes nothing');
  const added = await links.add(preview);
  assert.ok(isLocalLink(added.id));
  assert.equal(await links.resolve(`${added.id}/map`), file);
  assert.equal((await links.add(preview)).id, added.id, 'repeat approval cannot duplicate the same path');
  const restarted = createLocalLinks(options);
  assert.equal((await restarted.projects())[0].slug, added.id);
  if (process.platform !== 'win32') assert.equal((await fs.stat(options.registryFile)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(options.engineRoot), []);
  await restarted.remove(added.id);
  assert.equal(await restarted.resolve(`${added.id}/map`), null);
  assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('folders include only immediate regular YAML files and preserve project metadata', async t => {
  const options = await workspace(t), links = createLocalLinks(options);
  await fs.writeFile(path.join(options.originals, 'intake.yml'), source);
  await fs.writeFile(path.join(options.originals, 'projects.yaml'), 'name: Example Project\norder: [intake]\ntags: {intake: Review}\n');
  await fs.writeFile(path.join(options.originals, '.env'), 'SYNTHETIC_ONLY=not-loaded\n');
  await fs.writeFile(path.join(options.originals, '.hidden.yaml'), 'not a map');
  await fs.mkdir(path.join(options.originals, 'nested'));
  await fs.writeFile(path.join(options.originals, 'nested', 'private.yaml'), source);
  await fs.symlink(path.join(options.originals, 'nested', 'private.yaml'), path.join(options.originals, 'alias.yaml'));
  const preview = await links.preview(options.originals);
  assert.equal(preview.name, 'Example Project'); assert.equal(preview.mapCount, 1);
  assert.deepEqual(preview.order, ['intake']); assert.equal(preview.tags.intake, 'Review');
  const added = await links.add(preview);
  assert.equal(await links.resolve(`${added.id}/intake`), path.join(options.originals, 'intake.yml'));
  assert.equal(await links.resolve(`${added.id}/alias`), null);
  assert.equal(await links.resolve(`${added.id}/../private`), null);
  assert.equal(await links.resolve(`${added.id}/projects`), null);
  await fs.writeFile(path.join(options.originals, 'new.yaml'), source);
  assert.equal((await links.projects())[0].mapCount, 2);
});

test('changed previews, engine locations, oversized maps and ambiguous folder names fail closed', async t => {
  const options = await workspace(t), links = createLocalLinks(options);
  const file = path.join(options.originals, 'one.yaml');
  await fs.writeFile(file, source);
  const preview = await links.preview(file);
  await fs.writeFile(file, source + '# Changed\n');
  await assert.rejects(links.add(preview), /changed since preview/);
  await assert.rejects(links.preview(options.engineRoot), /outside.*repository/);
  await assert.rejects(links.preview('relative.yaml'), /absolute/);
  await fs.writeFile(path.join(options.originals, 'large.yaml'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(links.preview(options.originals), /1 MB/);
  await fs.unlink(path.join(options.originals, 'large.yaml'));
  await fs.writeFile(path.join(options.originals, 'one.yml'), source);
  await assert.rejects(links.preview(options.originals), /ambiguous/);
  assert.equal(await fs.stat(options.registryFile).catch(() => null), null);
  const wrongRegistry = createLocalLinks({...options, registryFile: path.join(options.engineRoot, 'private', 'links.json')});
  await assert.rejects(wrongRegistry.add(await wrongRegistry.preview(file)), /outside.*repository/);
  assert.deepEqual(await fs.readdir(options.engineRoot), []);
});

test('missing or redirected originals remain unavailable without fallback; LAN never exposes links', async t => {
  const options = await workspace(t), links = createLocalLinks(options);
  const file = path.join(options.originals, 'one.yaml');
  await fs.writeFile(file, source);
  const {id} = await links.add(await links.preview(file));
  await fs.unlink(file);
  assert.equal(await links.resolve(`${id}/map`), null);
  assert.equal((await links.projects())[0].unavailable, true);
  await fs.writeFile(path.join(options.engineRoot, 'other.yaml'), source);
  await fs.symlink(path.join(options.engineRoot, 'other.yaml'), file);
  assert.equal(await links.resolve(`${id}/map`), null);
  assert.equal((await links.projects())[0].unavailable, true);
  const lan = createLocalLinks({...options, enabled: false});
  assert.deepEqual(await lan.projects(), []);
  assert.equal(await lan.resolve(`${id}/map`), null);
  await assert.rejects(lan.preview(file), /local app/);
  await links.remove(id);
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
});
