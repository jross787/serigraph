// The CLI and local app share one conservative Git update path. Only the
// operator configures the checkout/remote/branch; HTTP never supplies them.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export class UpdateError extends Error {}

export function createUpdater({ root, branch = 'main', remote, protectedPaths = [] }) {
  const git = async args => {
    try {
      const result = await exec('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
        cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
      return result.stdout.trim();
    } catch {
      // Git errors can contain credential-bearing remote URLs and private
      // file names. Do not return raw subprocess output to a browser/log.
      throw new UpdateError(`Git ${args[0]} failed. Check Git access and checkout permissions on this machine, then try again.`);
    }
  };
  async function revision() {
    try { return await git(['rev-parse', 'HEAD']); } catch { return null; }
  }
  async function local() {
    let top;
    try { top = await git(['rev-parse', '--show-toplevel']); } catch {
      throw new UpdateError('Serigraph is not in a Git checkout. Install a Git clone to use updates.');
    }
    if (await fs.realpath(top) !== await fs.realpath(root)) {
      throw new UpdateError('Serigraph must be the root of its own Git checkout to update safely.');
    }
    if (!branch || branch.startsWith('-')) throw new UpdateError('The configured update branch is invalid.');
    await git(['check-ref-format', '--branch', branch]);
    const currentBranch = await git(['branch', '--show-current']);
    if (currentBranch !== branch) throw new UpdateError(`Serigraph is on ${currentBranch || 'a detached revision'}. Switch to ${branch} before updating.`);
    if (await git(['status', '--porcelain', '--untracked-files=normal'])) {
      throw new UpdateError('Serigraph has local changes. Commit or move that work before updating; nothing was overwritten.');
    }
    const remotes = (await git(['remote'])).split('\n').filter(Boolean);
    const selected = remote || (remotes.includes('origin') ? 'origin' : remotes.includes('client') ? 'client' : remotes.length === 1 ? remotes[0] : null);
    if (!selected || selected.startsWith('-') || !remotes.includes(selected)) throw new UpdateError('No unambiguous Git update remote is configured. Configure origin on this machine.');
    return { current: await git(['rev-parse', 'HEAD']), branch, remote: selected };
  }
  async function check() {
    const info = await local();
    // FETCH_HEAD is the exact result of this fetch, even with custom refspecs.
    await git(['fetch', '--no-tags', info.remote, `refs/heads/${branch}`]);
    const target = await git(['rev-parse', 'FETCH_HEAD']);
    const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `${info.current}...${target}`])).split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new UpdateError('Could not compare Serigraph versions.');
    if (ahead) throw new UpdateError('The local branch has commits not on the update branch. Update stopped to protect that work.');
    return { ...info, target, behind, checkedAt: Date.now(), status: behind ? 'available' : 'current' };
  }
  async function apply(plan) {
    if (!plan || !/^[a-f0-9]{40,64}$/.test(plan.target) || Date.now() - plan.checkedAt > 60 * 60 * 1000) {
      throw new UpdateError('Check for updates again before installing.');
    }
    const info = await local();
    if (info.current !== plan.current || info.remote !== plan.remote || info.branch !== plan.branch) throw new UpdateError('The checkout changed since the update check. Check again before installing.');
    // Never modify active maps/configuration even if a clean tracked file is
    // changed upstream. External libraries are outside this checkout entirely.
    const changed = (await git(['diff', '--name-only', '-z', info.current, plan.target])).split('\0').filter(Boolean);
    if (changed.some(file => protectedPaths.some(p => {
      const absolute = path.resolve(root, file);
      return absolute === p || absolute.startsWith(p + path.sep) || p.startsWith(absolute + path.sep);
    }))) throw new UpdateError('This update touches the active map library or configuration. Update manually after moving the library outside the engine checkout.');
    // Pin the reviewed target; do not fetch/apply a newer unseen commit.
    // Git must not overwrite ignored local files or autostash user work.
    await git(['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', plan.target]);
    return { ...plan, current: await git(['rev-parse', 'HEAD']), status: 'current', behind: 0 };
  }
  return { revision, check, apply };
}
