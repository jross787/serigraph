#!/usr/bin/env node
// serigraph install | update | status
//
// `install` sets up the same Serigraph on every Mac: a dedicated copy of the
// engine that stays on main, a background server that always runs it, an
// hourly update check, and the Serigraph app. The library of maps lives in one
// shared folder (for example in Google Drive), so every Mac sees the same files.
import { execFile } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createUpdater } from '../server/updater.js';
import { MAC_APP as APP, buildApp as buildMacApp } from '../server/mac-app.js';

const exec = promisify(execFile);
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support', 'Serigraph');
const ENGINE = path.join(SUPPORT, 'engine');
const CONFIG = path.join(SUPPORT, 'config.json');
const LOGS = path.join(SUPPORT, 'logs');
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
const SERVER = 'app.serigraph.server';
const UPDATE = 'app.serigraph.update';
const DEFAULT_PORT = 4747;
const DEFAULT_SOURCE = 'https://github.com/jross787/serigraph.git';
const PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const domain = () => `gui/${process.getuid()}`;

function usage() {
  console.log(`Usage:
  serigraph install --google-drive <account email>   Set up this Mac with a library in Google Drive
  serigraph install --library <folder>               Set up this Mac with a library in any folder
  serigraph update [--check]                         Update the engine from GitHub (main)
  serigraph status                                   Show this Mac's setup

Install options:
  --port <number>          Local port for the background server (default ${DEFAULT_PORT})
  --allowed-host <name>    Also answer a reverse proxy on this Mac under this name
  --env-from <file>        Copy AI provider settings from an existing .env file once
  --auto-updates           Install updates without asking (for a server-only Mac)
  --no-app                 Skip building Serigraph.app (for a server-only Mac)

Run install again at any time; it keeps your library and settings.`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

async function readConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG, 'utf8')); } catch { return null; }
}

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-c', `core.hooksPath=${os.devNull}`, ...args], {
    cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

// launchd agents do not inherit a shell PATH. Use the node that runs this
// installer, through Homebrew's per-formula link so an upgrade that removes
// the versioned Cellar folder does not break the agents.
function stableNode() {
  const cellar = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (cellar) {
    const linked = path.join(cellar[1], 'opt', cellar[2], 'bin', 'node');
    if (existsSync(linked)) return linked;
  }
  return process.execPath;
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(value, indent) {
  const pad = '  '.repeat(indent);
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (Array.isArray(value)) return `${pad}<array>\n${value.map(item => plistValue(item, indent + 1)).join('\n')}\n${pad}</array>`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${pad}  <key>${xml(key)}</key>\n${plistValue(item, indent + 1)}`);
    return `${pad}<dict>\n${entries.join('\n')}\n${pad}</dict>`;
  }
  return `${pad}<string>${xml(value)}</string>`;
}
const plist = dict => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(dict, 0)}
</plist>
`;

async function loadAgent(label, contents) {
  const file = path.join(AGENTS, `${label}.plist`);
  await fs.mkdir(AGENTS, { recursive: true });
  await fs.writeFile(file, contents);
  await exec('launchctl', ['bootout', `${domain()}/${label}`]).catch(() => {});
  // launchd can still be stopping the old copy right after bootout.
  for (let attempt = 1; ; attempt++) {
    try { await exec('launchctl', ['bootstrap', domain(), file]); return; }
    catch (error) {
      if (attempt >= 10) throw new Error(`Could not start ${label}: ${error.stderr?.trim() || error.message}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

async function computerName() {
  try { return (await exec('scutil', ['--get', 'ComputerName'])).stdout.trim(); } catch { return os.hostname(); }
}

// The person's name, as collaborators on a shared map see it.
async function fullName() {
  try { return (await exec('id', ['-F'])).stdout.trim() || os.userInfo().username; } catch { return os.userInfo().username; }
}

async function buildApp(root) {
  console.log('Building Serigraph.app…');
  await buildMacApp(root);
}

async function answering(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/maps`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await answering(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function install(args) {
  if (process.platform !== 'darwin') throw new Error('serigraph install sets up macOS. On other systems, run npm start.');
  const previous = await readConfig();
  const account = option(args, '--google-drive');
  let library = option(args, '--library');
  if (account) {
    const drive = path.join(HOME, 'Library', 'CloudStorage', `GoogleDrive-${account}`, 'My Drive');
    if (!existsSync(drive)) throw new Error(`Google Drive for ${account} isn't on this Mac yet. Open Google Drive, sign in as ${account}, then run this again.`);
    library = path.join(drive, 'Serigraph');
  }
  library = library ? path.resolve(library.replace(/^~(?=\/)/, HOME)) : previous?.library;
  if (!library) throw new Error('Choose where the library lives: --google-drive <account email> or --library <folder>.');
  const port = Number(option(args, '--port') ?? previous?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be a number from 1024 to 65535.');
  const allowedHost = option(args, '--allowed-host');
  const allowedHosts = allowedHost ? [allowedHost.toLowerCase()] : previous?.allowedHosts ?? [];
  const envFrom = option(args, '--env-from');
  const updates = args.includes('--auto-updates') ? 'auto' : previous?.updates === 'auto' ? 'auto' : 'ask';
  const machineName = await computerName();
  const userName = await fullName();

  await fs.mkdir(LOGS, { recursive: true, mode: 0o700 });
  await fs.chmod(SUPPORT, 0o700);

  if (!existsSync(path.join(ENGINE, '.git'))) {
    let source = DEFAULT_SOURCE;
    try { source = await git(HERE, ['remote', 'get-url', 'origin']); } catch { /* not a clone */ }
    console.log(`Copying the engine from ${source}…`);
    await git(SUPPORT, ['clone', '--quiet', '--branch', 'main', source, ENGINE]);
  } else {
    try {
      const updater = createUpdater({ root: ENGINE, branch: 'main' });
      const plan = await updater.check();
      if (plan.behind) { await updater.apply(plan); console.log(`Updated the engine by ${plan.behind} commit${plan.behind === 1 ? '' : 's'}.`); }
    } catch (error) { console.warn(`Engine update skipped: ${error.message}`); }
  }

  await fs.mkdir(path.join(library, 'maps'), { recursive: true });
  await fs.mkdir(path.join(library, 'projects'), { recursive: true });

  // Provider keys stay on this Mac, never in the shared library.
  const envFile = path.join(SUPPORT, '.env');
  if (!existsSync(envFile)) {
    const seed = envFrom ? await fs.readFile(path.resolve(envFrom), 'utf8') : '';
    await fs.writeFile(envFile, seed, { mode: 0o600 });
    if (envFrom) console.log(`Copied AI provider settings from ${envFrom}.`);
  }

  const config = { version: 1, library, port, allowedHosts, machineName, userName, updates };
  await fs.writeFile(CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  // Build the app before the hourly updater starts, so the two never build at once.
  if (!args.includes('--no-app')) await buildApp(ENGINE);

  const node = stableNode();
  await loadAgent(SERVER, plist({
    Label: SERVER,
    ProgramArguments: [node, path.join(ENGINE, 'server', 'main.js'), '--no-open'],
    WorkingDirectory: HOME,
    EnvironmentVariables: {
      PATH: PATH_ENV,
      PORT: String(port),
      SERIGRAPH_LIBRARY_DIR: library,
      OPSMAP_ENV_FILE: envFile,
      SERIGRAPH_PREFERENCES_FILE: path.join(SUPPORT, 'preferences.json'),
      SERIGRAPH_MACHINE_NAME: machineName,
      SERIGRAPH_USER_NAME: userName,
      SERIGRAPH_CONFIG_FILE: CONFIG,
      SERIGRAPH_ALLOWED_HOSTS: allowedHosts.length ? allowedHosts.join(',') : undefined,
      OPSMAP_NO_OPEN: '1',
      SERIGRAPH_MANAGED: '1',
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 20,
    ProcessType: 'Interactive',
    StandardOutPath: path.join(LOGS, 'server.log'),
    StandardErrorPath: path.join(LOGS, 'server.log'),
  }));
  await loadAgent(UPDATE, plist({
    Label: UPDATE,
    ProgramArguments: [node, path.join(ENGINE, 'tools', 'serigraph.mjs'), 'update', '--background'],
    EnvironmentVariables: { PATH: PATH_ENV, SERIGRAPH_ROOT: ENGINE },
    StartInterval: 3600,
    RunAtLoad: true,
    ProcessType: 'Background',
    StandardOutPath: path.join(LOGS, 'update.log'),
    StandardErrorPath: path.join(LOGS, 'update.log'),
  }));

  const running = await waitForServer(port);
  const revision = (await git(ENGINE, ['rev-parse', '--short', 'HEAD']).catch(() => '')) || 'unknown';
  console.log(`
Serigraph is set up on ${machineName}.
  Library:  ${library}
  Engine:   ${ENGINE} (${revision})
  Address:  http://127.0.0.1:${port}/${allowedHosts.length ? `, and https://${allowedHosts[0]}/ through your proxy` : ''}
  App:      ${args.includes('--no-app') ? 'not built (--no-app)' : APP}
  Server:   ${running ? 'running' : `not answering yet. See ${path.join(LOGS, 'server.log')}`}
${updates === 'auto' ? 'Updates install automatically from GitHub main.' : 'Serigraph checks GitHub every hour and offers each update with an Update Now button.'}`);
}

async function update(args) {
  const root = path.resolve(process.env.SERIGRAPH_ROOT || HERE);
  const updater = createUpdater({
    root,
    branch: process.env.SERIGRAPH_UPDATE_BRANCH?.trim() || 'main',
    remote: process.env.SERIGRAPH_UPDATE_REMOTE?.trim(),
  });
  // The hourly background run installs only on a Mac set to update
  // automatically; everywhere else the app offers the update instead.
  const background = args.includes('--background');
  if (background && (await readConfig())?.updates !== 'auto') return;
  const plan = await updater.check();
  const count = plan.behind;
  const stamp = background ? `${new Date().toISOString()} ` : '';
  if (args.includes('--check')) {
    console.log(count ? `${count} update commit${count === 1 ? '' : 's'} available. Run "serigraph update" to apply.` : 'Serigraph is already up to date.');
    return;
  }
  if (!count) {
    if (!background) console.log('Serigraph is already up to date.');
    return;
  }
  await updater.apply(plan);
  console.log(`${stamp}Serigraph updated by ${count} commit${count === 1 ? '' : 's'}.`);
  // The restarted server rebuilds Serigraph.app itself if the update changed it.
  if (background) await exec('launchctl', ['kickstart', '-k', `${domain()}/${SERVER}`]).catch(() => {});
  else console.log('Restart the local server to use it.');
}

async function status() {
  const config = await readConfig();
  if (!config) { console.log('Serigraph is not installed on this Mac. Run: serigraph install --google-drive <account email>'); return; }
  const revision = await git(ENGINE, ['rev-parse', '--short', 'HEAD']).catch(() => 'missing');
  const running = await answering(config.port);
  console.log(`Computer: ${config.machineName}
Library:  ${config.library}${existsSync(config.library) ? '' : '  (not available on this Mac right now)'}
Engine:   ${ENGINE} (${revision})
Server:   ${running ? `running at http://127.0.0.1:${config.port}/` : 'not answering'}
App:      ${existsSync(APP) ? APP : 'not built'}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === '--help' || command === '-h' || args.includes('--help')) usage();
  else if (command === 'install') await install(args);
  else if (command === 'update' && args.every(arg => ['--check', '--background'].includes(arg))) await update(args);
  else if (command === 'status') await status();
  else { console.error('Unknown command or option.'); usage(); process.exitCode = 1; }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
