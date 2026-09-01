// Agent Trail — live coding-agent sessions on the map.
// Each session wraps one harness CLI (claude | codex | omp) running a small
// coding task. The server owns the child processes, parses their JSON event
// streams into a shared step shape, and broadcasts changes over SSE.
import { spawn } from 'node:child_process';
import path from 'node:path';

export class AgentError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const HARNESS_KEYS = { claude: 'claude', codex: 'codex', omp: 'omp' };
const MAX_STEPS = 200;
const MAX_SESSIONS = 50;

const sessions = new Map();
let counter = 0;

// ── serialization ───────────────────────────────────────────────────
function stepOf(s) {
  return { at: s.at, kind: s.kind, label: s.label, detail: s.detail ?? '' };
}

export function listAgents() {
  return [...sessions.values()]
    .sort((a, b) => b.spawnAt - a.spawnAt)
    .map((s) => ({
      id: s.id,
      harness: s.harness,
      title: s.title,
      repoPath: s.repoPath,
      status: s.status,
      spawnAt: s.spawnAt,
      lastEventAt: s.lastEventAt,
      exitCode: s.exitCode,
      tasksTotal: s.tasksTotal,
      tasksDone: s.tasksDone,
      lastEditPath: s.lastEditPath,
      steps: s.steps.slice(-40).map(stepOf),
    }));
}

export function getAgent(id) {
  const s = sessions.get(id);
  if (!s) throw new AgentError(404, `no agent "${id}"`);
  return listAgents().find((a) => a.id === id);
}

// ── step parsing ────────────────────────────────────────────────────
// Map a harness-native event to the shared step shape. One function per
// harness keeps the quirks in one place.

function pushStep(s, kind, label, detail) {
  s.steps.push({ at: Date.now(), kind, label, detail: detail ?? '' });
  if (s.steps.length > MAX_STEPS) s.steps.splice(0, s.steps.length - MAX_STEPS);
  s.lastEventAt = Date.now();
  if (s.status === 'starting') s.status = 'working';
}

function shortSummary(value, max = 90) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// claude -p --output-format stream-json --verbose emits JSON objects per line:
// {type:'assistant', message:{content:[{type:'tool_use',name,input}]}} etc.
function parseClaudeLine(s, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        pushStep(s, 'message', shortSummary(block.text));
      } else if (block.type === 'tool_use') {
        const name = block.name ?? 'tool';
        const kind = name === 'Edit' || name === 'Write' || name === 'NotebookEdit' ? 'edit'
          : name === 'Read' ? 'read'
          : name === 'Bash' ? 'bash'
          : 'tool';
        const input = block.input ?? {};
        const detail = input.file_path ?? input.command ?? input.pattern ?? input.path ?? '';
        pushStep(s, kind, name, shortSummary(detail));
        if (kind === 'edit' && input.file_path) {
          s.lastEditPath = input.file_path;
          s.status = 'editing';
        }
      }
    }
  } else if (ev.type === 'user' && ev.toolUseResult) {
    s.tasksTotal += 1; s.tasksDone += 1;
  } else if (ev.type === 'result') {
    if (typeof ev.result === 'string' && ev.result.trim()) {
      pushStep(s, 'message', shortSummary(ev.result));
    }
  }
}

// codex exec --json emits JSONL: {type:'item.completed', item:{type, ...}}
function parseCodexLine(s, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'item.completed' && ev.item) {
    const item = ev.item;
    if (item.type === 'agent_message' && item.text?.trim()) {
      pushStep(s, 'message', shortSummary(item.text));
    } else if (item.type === 'command_execution') {
      pushStep(s, 'bash', 'Bash', shortSummary(item.command ?? item.aggregated_output ?? ''));
      s.tasksTotal += 1; s.tasksDone += 1;
    } else if (item.type === 'file_change') {
      const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean);
      pushStep(s, 'edit', 'Edit', shortSummary(paths.join(', ')));
      if (paths[0]) s.lastEditPath = paths[0];
      s.status = 'editing';
      s.tasksTotal += 1; s.tasksDone += 1;
    } else if (item.type === 'reasoning' && item.summary?.length) {
      pushStep(s, 'think', shortSummary(item.summary[0]?.text ?? 'thinking'));
    } else if (item.type === 'error' && item.message) {
      // harness warnings arrive as error items; keep them visible but calm
      if (!/bypass-hook-trust|Under-development/.test(item.message)) {
        pushStep(s, 'error', shortSummary(item.message));
      }
    }
  } else if (ev.type === 'turn.completed') {
    s.tasksTotal += 1; s.tasksDone += 1;
  }
}

// omp -p --mode json emits its own JSONL: {type:'message_end'|'tool_…'}
function parseOmpLine(s, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'agent_start') pushStep(s, 'think', 'Agent started');
  else if (ev.type === 'message_end' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        pushStep(s, 'message', shortSummary(block.text));
      } else if (block.type === 'tool_use' || block.type === 'toolInvocation') {
        const name = block.name ?? 'tool';
        const kind = /edit|write/i.test(name) ? 'edit' : /read/i.test(name) ? 'read' : /bash|shell/i.test(name) ? 'bash' : 'tool';
        const detail = block.input?.file_path ?? block.input?.command ?? block.input?.path ?? '';
        pushStep(s, kind, name, shortSummary(detail));
        if (kind === 'edit' && (block.input?.file_path ?? block.input?.path)) {
          s.lastEditPath = block.input.file_path ?? block.input.path;
          s.status = 'editing';
        }
      }
    }
  } else if (ev.type === 'tool_result' && ev.title) {
    pushStep(s, 'tool', shortSummary(ev.title, 60));
  }
}

const PARSERS = { claude: parseClaudeLine, codex: parseCodexLine, omp: parseOmpLine };

// OPSMAP_FAKE_HARNESS=1 swaps every spawner for a deterministic script so
// tests exercise the same plumbing without real CLIs.
function harnessCommand(harness, prompt, allowEdits) {
  if (process.env.OPSMAP_FAKE_HARNESS) {
    return { cmd: process.env.OPSMAP_FAKE_HARNESS, args: [], stdin: null, useShell: false };
  }
  if (harness === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (!allowEdits) args.push('--permission-mode', 'plan');
    return { cmd: 'claude', args, stdin: null, useShell: false };
  }
  if (harness === 'codex') {
    // `--` keeps a prompt that begins with a dash from being consumed as a
    // codex flag (e.g. "--help" would otherwise print help and exit 0)
    const args = ['exec', '--json', '-s', allowEdits ? 'workspace-write' : 'read-only', '--skip-git-repo-check', '--', prompt];
    return { cmd: 'codex', args, stdin: null, useShell: false };
  }
  const args = ['-p', prompt, '--mode', 'json'];
  if (!allowEdits) args.push('--approval-mode', 'always-ask');
  else args.push('--auto-approve');
  return { cmd: 'omp', args, stdin: null, useShell: false };
}

function deriveTitle(prompt) {
  const first = String(prompt ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'Agent task';
  return shortSummary(first, 64);
}

export function spawnAgent({ harness, prompt, repoPath, allowEdits = false }, { onEvent } = {}) {
  if (!HARNESS_KEYS[harness]) throw new AgentError(400, `harness must be one of: ${Object.keys(HARNESS_KEYS).join(', ')}`);
  const text = String(prompt ?? '').trim();
  if (!text) throw new AgentError(400, 'prompt is required');
  if (text.length > 8000) throw new AgentError(413, 'keep the prompt under 8,000 characters');

  if (sessions.size >= MAX_SESSIONS) {
    const oldestDone = [...sessions.values()].filter((s) => s.done).sort((a, b) => a.spawnAt - b.spawnAt)[0];
    if (!oldestDone) throw new AgentError(429, 'Too many agents running — stop one first.');
    sessions.delete(oldestDone.id);
  }

  let cwd;
  try { cwd = repoPath ? path.resolve(repoPath) : process.cwd(); } catch { cwd = process.cwd(); }
  if (!cwd || cwd.length < 2) throw new AgentError(400, 'invalid repo path');

  const id = `agent-${Date.now().toString(36)}-${(++counter).toString(36)}`;
  const session = {
    id, harness,
    title: deriveTitle(text),
    repoPath: cwd,
    status: 'starting',
    spawnAt: Date.now(),
    lastEventAt: Date.now(),
    exitCode: null,
    tasksTotal: 0,
    tasksDone: 0,
    lastEditPath: null,
    steps: [],
    done: false,
  };
  sessions.set(id, session);

  const { cmd, args } = harnessCommand(harness, text, allowEdits);
  let child;
  try {
    child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    session.status = 'error';
    session.done = true;
    session.exitCode = -1;
    pushStep(session, 'error', `Could not start ${harness}: ${e.message}`);
    throw new AgentError(500, `Could not start ${harness}: ${e.message}`);
  }
  session.child = child;

  const parser = PARSERS[harness];
  let buffer = '';
  // a single line without a newline must not grow without bound (a stuck or
  // malicious harness could stream forever); oversized lines are dropped and
  // reported once, then input resumes at the next newline
  const MAX_LINE = 1_000_000; // ~1 MB — real JSON events stay far below this
  let droppedOversize = false;
  const handleLine = (line) => {
    if (!line.trim()) return;
    try { parser(session, line); } catch { /* a bad event line never kills the session */ }
    onEvent?.({ type: 'agents-changed', id });
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (droppedOversize) {
        // this closing newline ends the dropped line — resume normal parsing
        droppedOversize = false;
        continue;
      }
      handleLine(line);
    }
    if (!droppedOversize && buffer.length > MAX_LINE) {
      droppedOversize = true;
      buffer = '';
      pushStep(session, 'error', `discarded an output line over ${MAX_LINE} bytes`);
      onEvent?.({ type: 'agents-changed', id });
    }
  });
  let errBuffer = '';
  child.stderr.on('data', (chunk) => {
    errBuffer += chunk.toString();
    if (errBuffer.length > 8000) errBuffer = errBuffer.slice(-8000);
  });
  child.on('error', (e) => {
    session.status = 'error';
    session.done = true;
    pushStep(session, 'error', `Could not run ${harness}: ${e.message}`);
    onEvent?.({ type: 'agents-changed', id });
  });
  child.on('close', (code) => {
    if (buffer.trim()) handleLine(buffer);
    session.done = true;
    session.exitCode = code;
    // a user-requested stop is a stop, not a failure: the child exits by
    // signal (code null) because we killed it
    if (session.status !== 'stopped') {
      session.status = session.status === 'error' || code !== 0 ? 'error' : 'done';
    }
    if (session.status === 'error') {
      const tail = shortSummary(errBuffer.split('\n').filter(Boolean).pop() ?? `exit ${code}`);
      pushStep(session, 'error', tail);
    }
    session.child = null;
    onEvent?.({ type: 'agents-changed', id });
  });

  return getAgent(id);
}
export async function stopAgent(id) {
  const s = sessions.get(id);
  if (!s) throw new AgentError(404, `no agent "${id}"`);
  if (s.done || !s.child) {
    if (!s.done) { s.done = true; s.status = 'stopped'; }
    return getAgent(id);
  }
  s.status = 'stopped';
  const child = s.child;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 3000);
    child.once('close', () => { clearTimeout(killTimer); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(killTimer); resolve(); }
  });
  return getAgent(id);
}

export function forgetAgent(id) {
  const s = sessions.get(id);
  if (!s) throw new AgentError(404, `no agent "${id}"`);
  if (!s.done && s.child) throw new AgentError(409, 'stop the agent before removing it');
  sessions.delete(id);
}

// server shutdown path: SIGKILL every live child. A coding agent launched
// with edit rights must not outlive the server that owns it.
export function killAllAgents() {
  for (const s of sessions.values()) {
    if (s.child) {
      try { s.child.kill('SIGKILL'); } catch { /* already gone */ }
      s.child = null;
    }
    if (!s.done) { s.done = true; if (s.status !== 'error') s.status = 'stopped'; }
  }
}

