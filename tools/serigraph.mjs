#!/usr/bin/env node
// serigraph install | update | status
//
// `install` sets up the same Serigraph on every Mac: a dedicated copy of the
// engine that stays on main, a background server that always runs it, an
// hourly update check, and the Serigraph app. The library of maps lives in one
// shared folder (for example in Google Drive), so every Mac sees the same files.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createUpdater } from '../server/updater.js';

const exec = promisify(execFile);
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support', 'Serigraph');
const ENGINE = path.join(SUPPORT, 'engine');
const CONFIG = path.join(SUPPORT, 'config.json');
const LOGS = path.join(SUPPORT, 'logs');
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
const APP = path.join(HOME, 'Applications', 'Serigraph.app');
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
  serigraph update [--check] [--restart]             Update the engine from GitHub (main)
  serigraph status                                   Show this Mac's setup

Install options:
  --port <number>          Local port for the background server (default ${DEFAULT_PORT})
  --allowed-host <name>    Also answer a reverse proxy on this Mac under this name
  --env-from <file>        Copy AI provider settings from an existing .env file once
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

// launchd agents do not inherit a shell PATH. Point them at a node path that
// survives Homebrew upgrades instead of a versioned Cellar path.
function stableNode() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (existsSync(candidate)) return candidate;
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
  await exec('launchctl', ['bootstrap', domain(), file]);
}

async function computerName() {
  try { return (await exec('scutil', ['--get', 'ComputerName'])).stdout.trim(); } catch { return os.hostname(); }
}

// The same inputs tools/build-mac-app.sh hashes into the app's Info.plist.
async function appSourceHash(root) {
  const parts = await Promise.all(['mac/Serigraph.swift', 'mac/make-icon.swift', 'tools/build-mac-app.sh']
    .map(file => fs.readFile(path.join(root, file))));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 16);
}

async function installedAppHash() {
  try {
    return (await exec('plutil', ['-extract', 'SerigraphSourceHash', 'raw', path.join(APP, 'Contents', 'Info.plist')])).stdout.trim();
  } catch { return null; }
}

async function buildApp(root) {
  console.log('Building Serigraph.app…');
  await exec(path.join(root, 'tools', 'build-mac-app.sh'), [APP], { timeout: 600_000 });
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
  const machineName = await computerName();

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

  const config = { version: 1, library, port, allowedHosts, machineName };
  await fs.writeFile(CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

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
    ProgramArguments: [node, path.join(ENGINE, 'tools', 'serigraph.mjs'), 'update', '--restart'],
    EnvironmentVariables: { PATH: PATH_ENV, SERIGRAPH_ROOT: ENGINE },
    StartInterval: 3600,
    RunAtLoad: true,
    ProcessType: 'Background',
    StandardOutPath: path.join(LOGS, 'update.log'),
    StandardErrorPath: path.join(LOGS, 'update.log'),
  }));

  if (!args.includes('--no-app')) await buildApp(ENGINE);
  const running = await waitForServer(port);
  const revision = (await git(ENGINE, ['rev-parse', '--short', 'HEAD']).catch(() => '')) || 'unknown';
  console.log(`
Serigraph is set up on ${machineName}.
  Library:  ${library}
  Engine:   ${ENGINE} (${revision})
  Address:  http://127.0.0.1:${port}/${allowedHosts.length ? `, and https://${allowedHosts[0]}/ through your proxy` : ''}
  App:      ${args.includes('--no-app') ? 'not built (--no-app)' : APP}
  Server:   ${running ? 'running' : `not answering yet. See ${path.join(LOGS, 'server.log')}`}
Updates install automatically every hour from GitHub main.`);
}

async function update(args) {
  const root = path.resolve(process.env.SERIGRAPH_ROOT || HERE);
  const updater = createUpdater({
    root,
    branch: process.env.SERIGRAPH_UPDATE_BRANCH?.trim() || 'main',
    remote: process.env.SERIGRAPH_UPDATE_REMOTE?.trim(),
  });
  const plan = await updater.check();
  const count = plan.behind;
  if (args.includes('--check')) {
    console.log(count ? `${count} update commit${count === 1 ? '' : 's'} available. Run "serigraph update" to apply.` : 'Serigraph is already up to date.');
    return;
  }
  const stamp = args.includes('--restart') ? `${new Date().toISOString()} ` : '';
  if (count) {
    await updater.apply(plan);
    console.log(`${stamp}Serigraph updated by ${count} commit${count === 1 ? '' : 's'}.`);
  } else if (!args.includes('--restart')) {
    console.log('Serigraph is already up to date.');
  }
  if (!args.includes('--restart')) {
    if (count) console.log('Restart the local server to use it.');
    return;
  }
  // The background updater: restart the server on new code, and rebuild the
  // app only when its own source changed.
  if (count) await exec('launchctl', ['kickstart', '-k', `${domain()}/${SERVER}`]).catch(() => {});
  if (existsSync(APP) && await installedAppHash() !== await appSourceHash(root)) {
    await buildApp(root);
    console.log(`${stamp}Rebuilt Serigraph.app.`);
  }
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
  else if (command === 'update' && args.every(arg => ['--check', '--restart'].includes(arg))) await update(args);
  else if (command === 'status') await status();
  else { console.error('Unknown command or option.'); usage(); process.exitCode = 1; }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
