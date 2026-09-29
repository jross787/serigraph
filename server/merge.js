// Combine two edits that started from the same version of a map, line by
// line, the way git merges branches. Maps are YAML, where each card and
// connector sits on its own lines, so edits to different parts combine
// cleanly. Returns null when both edits changed the same lines; a person
// decides those.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function mergeText({ base, mine, theirs }) {
  if (mine === theirs || base === theirs) return mine;
  if (base === mine) return theirs;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'serigraph-merge-'));
  try {
    const files = { mine: path.join(dir, 'mine.yaml'), base: path.join(dir, 'base.yaml'), theirs: path.join(dir, 'theirs.yaml') };
    await Promise.all([
      fs.writeFile(files.mine, mine, { mode: 0o600 }),
      fs.writeFile(files.base, base, { mode: 0o600 }),
      fs.writeFile(files.theirs, theirs, { mode: 0o600 }),
    ]);
    const { code, stdout } = await new Promise((resolve) => {
      execFile('git', ['merge-file', '-p', files.mine, files.base, files.theirs],
        { maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
        (error, out) => resolve({ code: error ? error.code : 0, stdout: out }));
    });
    return code === 0 ? stdout : null;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
