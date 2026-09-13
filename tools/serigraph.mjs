#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpdater } from '../server/updater.js';

const root = path.resolve(process.env.SERIGRAPH_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const updater = createUpdater({
  root,
  branch: process.env.SERIGRAPH_UPDATE_BRANCH?.trim() || 'main',
  remote: process.env.SERIGRAPH_UPDATE_REMOTE?.trim(),
});

function usage() {
  console.log(`Usage: serigraph update [--check]

Fetch the configured Serigraph Git branch (main by default).
  --check   Report updates without changing application files
  --help    Show this help

Updates require a clean checkout and a fast-forward. They never autostash
local work or overwrite ignored files. Restart the server after updating.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h' || command == null || (command === 'update' && args.includes('--help'))) {
  usage();
} else if (command !== 'update' || args.some(arg => arg !== '--check')) {
  console.error('Unknown command or option.');
  usage();
  process.exitCode = 1;
} else {
  try {
    const plan = await updater.check();
    const count = plan.behind;
    if (!count) console.log('Serigraph is already up to date.');
    else if (args.includes('--check')) console.log(`${count} update commit${count === 1 ? '' : 's'} available. Run "serigraph update" to apply.`);
    else {
      await updater.apply(plan);
      console.log(`Serigraph updated by ${count} commit${count === 1 ? '' : 's'}. Restart the local server to use it.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
