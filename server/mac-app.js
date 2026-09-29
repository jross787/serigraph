// The installed Serigraph.app window. Its source hash, stamped into the
// app's Info.plist by tools/build-mac-app.sh, tells whether an engine update
// changed the app itself, so it can be rebuilt without rebuilding every time.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MAC_APP = path.join(os.homedir(), 'Applications', 'Serigraph.app');
const SOURCES = ['mac/Serigraph.swift', 'mac/make-icon.swift', 'tools/build-mac-app.sh'];

export async function appSourceHash(root) {
  const parts = await Promise.all(SOURCES.map((file) => fs.readFile(path.join(root, file))));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 16);
}

export async function installedAppHash(app = MAC_APP) {
  try {
    return (await exec('plutil', ['-extract', 'SerigraphSourceHash', 'raw', path.join(app, 'Contents', 'Info.plist')])).stdout.trim();
  } catch { return null; }
}

export async function appNeedsRebuild(root, app = MAC_APP) {
  if (process.platform !== 'darwin' || !existsSync(app)) return false;
  return (await installedAppHash(app)) !== (await appSourceHash(root));
}

export async function buildApp(root, app = MAC_APP) {
  await exec(path.join(root, 'tools', 'build-mac-app.sh'), [app], { timeout: 600_000 });
}
