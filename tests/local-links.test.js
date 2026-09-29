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
  const registryDir = path.join(dir, 'library', '.serigraph', 'links');
  return { engineRoot, originals, registryDir, dir };
}
const records = dir => fs.readdir(dir).then(names => names.filter(name => name.endsWith('.json')), () => []);

test('a file link persists outside the engine, resolves the original, deduplicates and removes only its reference', async t => {
  const options = await workspace(t);
  const file = path.join(options.originals, 'File with spaces.yaml');
  await fs.writeFile(file, source);
  const links = createLocalLinks(options), preview = await links.preview(file);
  assert.equal(preview.mapCount, 1); assert.equal(preview.name, 'Synthetic Intake');
  assert.deepEqual(await records(options.registryDir), [], 'preview writes nothing');
  const added = await links.add(preview);
  assert.ok(isLocalLink(added.id));
  assert.equal(await links.resolve(`${added.id}/map`), file);
  assert.equal((await links.add(preview)).id, added.id, 'repeat approval cannot duplicate the same path');
  const restarted = createLocalLinks(options);
  assert.equal((await restarted.projects())[0].slug, added.id);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(options.registryDir, `${added.id}.json`))).mode & 0o777, 0o600);
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
  assert.deepEqual(await records(options.registryDir), []);
  const wrongRegistry = createLocalLinks({...options, registryDir: path.join(options.engineRoot, 'private', 'links')});
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

test('links inside the home folder are stored as ~/ paths and resolve on another machine with a different user name', async t => {
  const options = await workspace(t);
  const homeA = path.join(options.dir, 'Users', 'joe'), homeB = path.join(options.dir, 'Users', 'zeus');
  for (const home of [homeA, homeB]) {
    await fs.mkdir(path.join(home, 'Code', 'repo'), {recursive: true});
    await fs.writeFile(path.join(home, 'Code', 'repo', 'process.yaml'), source);
  }
  const first = createLocalLinks({...options, home: homeA});
  const opened = await first.open('~/Code/repo/process.yaml');
  assert.equal(opened.existing, false);
  assert.equal((await first.open(path.join(homeA, 'Code', 'repo', 'process.yaml'))).id, opened.id, 'opening the same file again reuses its link');
  const saved = JSON.parse(await fs.readFile(path.join(options.registryDir, `${opened.id}.json`), 'utf8'));
  assert.equal(saved.path, '~/Code/repo/process.yaml');
  const second = createLocalLinks({...options, home: homeB});
  assert.equal(await second.resolve(`${opened.id}/map`), path.join(homeB, 'Code', 'repo', 'process.yaml'));
  assert.equal((await second.projects())[0].location, '~/Code/repo/process.yaml');
  await fs.rm(path.join(homeB, 'Code', 'repo'), {recursive: true});
  const [missing] = await second.projects();
  assert.equal(missing.unavailable, true);
  assert.match(missing.error, /Not found on this Mac/);
  assert.equal(await second.resolve(`${opened.id}/map`), null);
});

test('a damaged or half-synced link record is skipped without hiding the others', async t => {
  const options = await workspace(t), links = createLocalLinks(options);
  const file = path.join(options.originals, 'one.yaml');
  await fs.writeFile(file, source);
  const {id} = await links.add(await links.preview(file));
  await fs.writeFile(path.join(options.registryDir, 'linked-00000000-0000-4000-8000-000000000000.json'), '{"version": 1, "id": "linked-');
  await fs.writeFile(path.join(options.registryDir, 'notes.json'), '{}');
  const projects = await links.projects();
  assert.deepEqual(projects.map(project => project.slug), [id]);
});

test('the Open dialog lists one folder: visible subfolders and YAML maps, never hidden files or the project index', async t => {
  const options = await workspace(t);
  const home = path.join(options.dir, 'Users', 'joe'), repo = path.join(home, 'Code', 'repo');
  await fs.mkdir(path.join(repo, 'docs'), {recursive: true});
  await fs.mkdir(path.join(repo, '.git'));
  await fs.mkdir(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-someone@example.com'), {recursive: true});
  for (const name of ['process.yaml', 'b10.yml', 'b9.yaml', 'projects.yaml', 'notes.txt', '.hidden.yaml']) await fs.writeFile(path.join(repo, name), source);
  await fs.symlink(path.join(repo, 'docs'), path.join(repo, 'linked-docs'));
  const links = createLocalLinks({...options, home});
  const listing = await links.browse('~/Code/repo');
  assert.equal(listing.path, '~/Code/repo');
  assert.equal(listing.parent, '~/Code');
  assert.deepEqual(listing.folders.map(folder => folder.name), ['docs', 'linked-docs']);
  assert.deepEqual(listing.files.map(file => file.name), ['b9.yaml', 'b10.yml', 'process.yaml']);
  assert.equal(listing.files[2].path, '~/Code/repo/process.yaml');
  const top = await links.browse('~');
  assert.deepEqual([top.name, top.path, top.parent], ['Home', '~', path.join(options.dir, 'Users')]);
  assert.deepEqual(top.folders.map(folder => folder.name), ['Code'], 'the home Library stays hidden, as in Finder');
  assert.deepEqual(top.places.map(place => place.name), ['Home', 'Code', 'Google Drive · someone@example.com']);
  await assert.rejects(links.browse('relative/folder'), /Choose a folder/);
  await assert.rejects(links.browse('~/missing'), /unavailable/);
  await assert.rejects(createLocalLinks({...options, home, enabled: false}).browse('~'), /only in the local app/);
  assert.equal((await links.open('~/Code/repo/process.yaml')).kind, 'file', 'a listed path opens as it is shown');
});

