// Per-install library preference, outside both the engine and map files.
// Launch-environment overrides always win. No map or credential migration.
import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export function preferencesPath(root, env = process.env) {
  if (env.SERIGRAPH_PREFERENCES_FILE) return path.resolve(env.SERIGRAPH_PREFERENCES_FILE);
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || path.join(homedir(), '.config');
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
  return path.join(base, 'serigraph', `installation-${id}.json`);
}

async function readPreference(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error();
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || typeof value.library !== 'string' || !path.isAbsolute(value.library)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('The saved project-files preference cannot be read safely. Repair the preferences file or set SERIGRAPH_LIBRARY_DIR explicitly.');
  }
}

export async function resolveLibraryRoot(root, env = process.env) {
  if (env.SERIGRAPH_LIBRARY_DIR) return path.resolve(env.SERIGRAPH_LIBRARY_DIR);
  const saved = await readPreference(preferencesPath(root, env));
  if (!saved) return root;
  // Never silently fall back to another library when a drive is missing.
  try { if (!(await fs.stat(saved.library)).isDirectory()) throw new Error(); }
  catch { throw new Error('The saved project-files folder is unavailable. Reconnect it or set SERIGRAPH_LIBRARY_DIR explicitly before starting Serigraph.'); }
  return saved.library;
}

export async function inspectLibraryDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error('Enter an absolute path to an existing folder.');
  let resolved, stat;
  try {
    resolved = await fs.realpath(directory);
    stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error();
    await fs.access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch { throw new Error('That folder is unavailable or is not readable and writable by Serigraph. Create it first, then try again.'); }
  for (const name of ['maps', 'projects', '.serigraph-trash', '.env']) {
    try {
      const item = await fs.lstat(path.join(resolved, name));
      if (item.isSymbolicLink() || (name === '.env' ? !item.isFile() : !item.isDirectory())) throw new Error('unsafe');
      await fs.access(path.join(resolved, name), constants.R_OK | (name === '.env' ? 0 : constants.W_OK | constants.X_OK));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`The folder's ${name} must be accessible and must not be a symbolic link.`);
    }
  }
  const entries = async name => { try { return await fs.readdir(path.join(resolved, name), { withFileTypes: true }); } catch { return []; } };
  const [maps, projects] = await Promise.all([entries('maps'), entries('projects')]);
  const hasEnv = await fs.stat(path.join(resolved, '.env')).then(() => true, () => false);
  return { path: resolved, identity: `${stat.dev}:${stat.ino}`, maps: maps.filter(e => e.isFile() && /\.ya?ml$/i.test(e.name)).length,
    projects: projects.filter(e => e.isDirectory()).length, hasEnv };
}

export async function saveLibraryPreference(file, directory) {
  const previous = await readPreference(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...previous, version: 1, library: directory }) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
