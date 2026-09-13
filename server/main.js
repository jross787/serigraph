// Keep a small launcher alive while an explicitly approved update restarts
// the HTTP worker. No shell, detached replacement, port hopping on restart,
// or automatic retry loop. The launch environment and cwd stay unchanged.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./http-server.js', import.meta.url));
let child;
let stopping = false;
let port = null;
let stopTimer;

function launch(restarting = false) {
  let restartRequested = false;
  const worker = child = fork(entry, process.argv.slice(2), {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...(restarting ? { PORT: String(port), OPSMAP_NO_OPEN: '1', SERIGRAPH_RESTART: '1' } : {}),
    },
  });
  worker.on('message', message => {
    if (message?.type === 'ready' && Number.isInteger(message.port)) port = message.port;
    if (message?.type === 'restart' && port && !stopping) restartRequested = true;
  });
  worker.on('error', () => { console.error('[serigraph] Could not start the server.'); });
  worker.on('exit', code => {
    clearTimeout(stopTimer);
    if (restartRequested && code === 0 && !stopping) launch(true);
    else process.exit(stopping ? 0 : code || 1);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  child?.kill(signal);
  stopTimer = setTimeout(() => child?.kill('SIGKILL'), 5000);
  stopTimer.unref();
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
launch();
