// LLM provider chain for the transcript importer. Secrets never leave the
// server: the browser only ever calls our own /api/import endpoint.
//
// Provider resolution (first match wins):
//   1. OPSMAP_MOCK_LLM=<file>   — canned response, for tests/offline demos
//   2. OPSMAP_LLM_CMD=<cmd>     — any local model: shell command, prompt on
//                                 stdin, completion on stdout (ollama, llama.cpp…)
//   3. ANTHROPIC_API_KEY        — direct Claude API call (Node's global fetch)
//   4. OPENAI_API_KEY           — direct OpenAI API call (Node's global fetch)
//   5. `claude` CLI on PATH     — zero-config local provider; uses the user's
//                                 existing Claude Code login, spawned server-side
//   6. none                     — importer disabled; UI shows a setup hint
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const API_MODEL = process.env.OPSMAP_MODEL || 'claude-opus-4-8';
const CLI_MODEL = process.env.OPSMAP_MODEL || 'opus';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const API_TIMEOUT_MS = 240_000;
const CLI_TIMEOUT_MS = 300_000;

let cliAvailable = null; // lazily probed, cached
async function hasClaudeCli() {
  if (cliAvailable != null) return cliAvailable;
  cliAvailable = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn('claude', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      const t = setTimeout(() => { p.kill('SIGKILL'); finish(false); }, 8000);
      p.on('exit', (code) => { clearTimeout(t); finish(code === 0); });
      p.on('error', () => { clearTimeout(t); finish(false); });
    } catch { finish(false); }
  });
  return cliAvailable;
}

export async function resolveProvider() {
  if (process.env.OPSMAP_MOCK_LLM) return { kind: 'mock', model: 'mock' };
  if (process.env.OPSMAP_LLM_CMD) return { kind: 'cmd', model: process.env.OPSMAP_LLM_CMD.split(/\s+/)[0] };
  if (process.env.ANTHROPIC_API_KEY) return { kind: 'api', model: API_MODEL };
  if (process.env.OPENAI_API_KEY) return { kind: 'openai', model: OPENAI_MODEL };
  if (await hasClaudeCli()) return { kind: 'cli', model: CLI_MODEL };
  return null;
}

// One text-in/text-out completion. Throws Error with a user-safe .message.
export async function callLLM({ system, prompt }) {
  const provider = await resolveProvider();
  if (!provider) {
    throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, log in the claude CLI, or set OPSMAP_LLM_CMD.');
  }
  if (provider.kind === 'mock') return callMock();
  if (provider.kind === 'cmd') return callCmd({ system, prompt });
  if (provider.kind === 'openai') return callOpenAI({ system, prompt });
  if (provider.kind === 'api') return callApi({ system, prompt });
  return callCli({ system, prompt });
}

// Generic local-model escape hatch: run a shell command, write the prompt to
// its stdin, read the completion from stdout. e.g. OPSMAP_LLM_CMD="ollama run llama3.1"
async function callCmd({ system, prompt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OPSMAP_LLM_CMD, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.env.TMPDIR || '/tmp',
    });
    let out = '', errOut = '', settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('OPSMAP_LLM_CMD took too long (>5 min).'));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => finish(reject, new Error(`OPSMAP_LLM_CMD failed to start: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) finish(reject, new Error(`OPSMAP_LLM_CMD failed (exit ${code}): ${errOut.trim().slice(0, 300)}`));
      else if (!out.trim()) finish(reject, new Error('OPSMAP_LLM_CMD returned nothing.'));
      else finish(resolve, out);
    });
    child.stdin.write(`${system}\n\n${prompt}`);
    child.stdin.end();
  });
}

async function callMock() {
  try {
    return await fs.readFile(process.env.OPSMAP_MOCK_LLM, 'utf8');
  } catch (e) {
    throw new Error(`OPSMAP_MOCK_LLM file unreadable: ${e.message}`);
  }
}

// Direct Claude API via fetch — the project is zero-dependency by design, so
// no SDK; the request shape follows the Messages API (see docs/IMPORTER.md).
async function callApi({ system, prompt }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: API_MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'The model took too long (>4 min) — try a shorter transcript.'
      : `Could not reach the Claude API: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* opaque */ }
    if (res.status === 401) throw new Error('The ANTHROPIC_API_KEY was rejected (401). Check the key.');
    if (res.status === 429) throw new Error('Rate limited by the Claude API — wait a minute and retry.');
    throw new Error(`Claude API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined this transcript. Remove any sensitive content and retry.');
  }
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new Error('The model returned an empty response — retry.');
  if (data.stop_reason === 'max_tokens') {
    throw new Error('The transcript produced a map too large to emit — split the transcript and import in parts.');
  }
  return text;
}

// Direct OpenAI API via fetch — same zero-dependency approach as callApi.
async function callOpenAI({ system, prompt }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_completion_tokens: 16000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'The model took too long (>4 min) — try a shorter request.'
      : `Could not reach the OpenAI API: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* opaque */ }
    if (res.status === 401) throw new Error('The OPENAI_API_KEY was rejected (401). Check the key.');
    if (res.status === 429) throw new Error('Rate limited by the OpenAI API — wait a minute and retry.');
    throw new Error(`OpenAI API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('The model returned an empty response — retry.');
  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error('The response was too large to emit — split the request and retry.');
  }
  return text;
}

// Local `claude` CLI in print mode. The prompt goes over stdin; the user's
// existing Claude Code credentials stay entirely on this machine. Tools are
// disabled (pure completion) and cwd is neutral so no project context leaks
// into the extraction.
async function callCli({ system, prompt }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--model', CLI_MODEL, '--tools', ''];
    if (system) args.push('--append-system-prompt', system);
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.env.TMPDIR || '/tmp',
    });
    let out = '', errOut = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('The local claude CLI took too long (>5 min) — try a shorter transcript.'));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => finish(reject, new Error(`Could not run the claude CLI: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(`claude CLI failed (exit ${code}): ${errOut.trim().slice(0, 300) || 'no error output'}`));
      } else if (!out.trim()) {
        finish(reject, new Error('The claude CLI returned an empty response — retry.'));
      } else {
        finish(resolve, out);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
