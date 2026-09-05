import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('external workspace paths and dotenv stay separate from application code', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'serigraph-library-env-'));
  try {
    writeFileSync(path.join(work, '.env'), 'SERIGRAPH_TEST_MARKER=private-workspace\n');
    const inspect = (overrides) => JSON.parse(execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `import { ROOT, LIBRARY_ROOT, ENV_PATH } from './server/env.js';
       console.log(JSON.stringify({ ROOT, LIBRARY_ROOT, ENV_PATH, marker: process.env.SERIGRAPH_TEST_MARKER }));`,
    ], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...process.env, OPSMAP_ROOT: '', OPSMAP_SKIP_DOTENV: '', OPSMAP_ENV_FILE: '',
        SERIGRAPH_LIBRARY_DIR: work, SERIGRAPH_TEST_MARKER: '', ...overrides },
      encoding: 'utf8',
    }));
    const external = inspect({ SERIGRAPH_TEST_MARKER: undefined });
    assert.notEqual(external.ROOT, work);
    assert.equal(external.LIBRARY_ROOT, work);
    assert.equal(external.ENV_PATH, path.join(work, '.env'));
    assert.equal(external.marker, 'private-workspace');
    assert.equal(inspect({ SERIGRAPH_TEST_MARKER: 'shell-wins' }).marker, 'shell-wins');
    const defaults = inspect({ SERIGRAPH_LIBRARY_DIR: '', OPSMAP_SKIP_DOTENV: '1' });
    assert.equal(defaults.LIBRARY_ROOT, defaults.ROOT);
    const explicit = path.join(work, 'custom.env');
    writeFileSync(explicit, 'SERIGRAPH_TEST_MARKER=explicit\n');
    const overridden = inspect({ OPSMAP_ENV_FILE: explicit, SERIGRAPH_TEST_MARKER: undefined });
    assert.equal(overridden.ENV_PATH, explicit);
    assert.equal(overridden.marker, 'explicit');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
