#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.SERIGRAPH_ROOT || DEFAULT_ROOT);

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    console.error(`Could not run Git: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFailure) {
    const message = result.stderr.trim() || result.stdout.trim() || `Git exited with status ${result.status}`;
    console.error(message);
    process.exit(result.status || 1);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function usage() {
  console.log(`Usage: serigraph update [--check]

Pull the latest Serigraph release from its configured Git remote.

  --check   Fetch and report whether an update exists without applying it
  --help    Show this help

The command stops before changing files when the checkout has local changes,
is on the wrong branch, or cannot be updated with a fast-forward merge.`);
}

function selectRemote() {
  const configured = process.env.SERIGRAPH_UPDATE_REMOTE?.trim();
  const remotes = git(['remote']).stdout.split('\n').filter(Boolean);
  if (configured) {
    if (!remotes.includes(configured)) {
      console.error(`Git remote "${configured}" does not exist.`);
      process.exit(1);
    }
    return configured;
  }
  if (remotes.includes('origin')) return 'origin';
  if (remotes.includes('client')) return 'client';
  if (remotes.length === 1) return remotes[0];
  console.error('No Git remote is configured. Add the Serigraph GitHub repository as "origin" first.');
  process.exit(1);
}

function update({ checkOnly = false } = {}) {
  if (!git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).ok) {
    console.error(`Serigraph is not in a Git checkout: ${ROOT}`);
    process.exit(1);
  }

  const branch = process.env.SERIGRAPH_UPDATE_BRANCH?.trim() || 'main';
  const currentBranch = git(['branch', '--show-current']).stdout;
  if (!currentBranch) {
    console.error(`The Serigraph checkout is detached. Switch to ${branch}, then run this command again.`);
    process.exit(1);
  }
  if (currentBranch !== branch) {
    console.error(`Serigraph is on branch "${currentBranch}". Switch to "${branch}", then run this command again.`);
    process.exit(1);
  }

  const changes = git(['status', '--porcelain', '--untracked-files=normal']).stdout;
  if (changes) {
    console.error('Serigraph has local changes. Commit, stash, or remove them before updating.');
    process.exit(1);
  }

  const remote = selectRemote();
  console.log(`Checking ${remote}/${branch}...`);
  git(['fetch', '--prune', remote, branch]);

  const counts = git(['rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`]).stdout
    .split(/\s+/)
    .map(Number);
  const [ahead, behind] = counts;
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    console.error('Could not compare the local and remote Serigraph versions.');
    process.exit(1);
  }
  if (ahead > 0) {
    console.error(`The local branch has ${ahead} commit${ahead === 1 ? '' : 's'} not on ${remote}/${branch}. Update stopped to protect that work.`);
    process.exit(1);
  }
  if (behind === 0) {
    console.log('Serigraph is already up to date.');
    return;
  }
  if (checkOnly) {
    console.log(`${behind} update commit${behind === 1 ? '' : 's'} available. Run "serigraph update" to apply ${behind === 1 ? 'it' : 'them'}.`);
    return;
  }

  git(['merge', '--ff-only', `${remote}/${branch}`]);
  console.log(`Serigraph updated by ${behind} commit${behind === 1 ? '' : 's'}. Restart the local server to use it.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h' || command == null) {
  usage();
} else if (command === 'update') {
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length) {
    console.error(`Unknown option: ${unknown[0]}`);
    usage();
    process.exit(1);
  }
  update({ checkOnly: args.includes('--check') });
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}
