// LLM provider chain for the transcript importer and the map assistant.
// Secrets never leave the server: the browser only ever calls our own API.
//
// Provider resolution:
//   0. OPSMAP_LLM_PROVIDER     — an explicit choice from AI settings wins
//   1. OPSMAP_MOCK_LLM=<file>  — canned response, for tests/offline demos
//   2. OPSMAP_LLM_CMD=<cmd>    — any local model over stdin/stdout
//   3. ANTHROPIC_API_KEY       — direct Claude API call
//   4. OPENROUTER_API_KEY      — OpenRouter (OpenAI-compatible)
//   5. OPENAI_API_KEY          — direct OpenAI API call
//   6. `claude` CLI on PATH    — zero-config local provider
//   7. none                    — AI features show a setup hint
// Models resolve at call time so AI settings can change them without a
// restart: OPSMAP_MODEL (chat), OPSMAP_VOICE_MODEL (transcription).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const API_TIMEOUT_MS = 240_000;
const CLI_TIMEOUT_MS = 300_000;

const chatModel = (kind) => {
  if (process.env.OPSMAP_MODEL) return process.env.OPSMAP_MODEL;
  if (kind === 'api') return 'claude-opus-4-8';
  if (kind === 'openrouter') return 'openai/gpt-4o';
  if (kind === 'openai') return 'gpt-4o';
  return 'opus'; // cli
};
const voiceModel = () => process.env.OPSMAP_VOICE_MODEL || 'whisper-1';

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
  // an explicit choice from AI settings wins over the auto chain
  const explicit = process.env.OPSMAP_LLM_PROVIDER;
  if (explicit === 'anthropic' && process.env.ANTHROPIC_API_KEY) return { kind: 'api', model: chatModel('api') };
  if (explicit === 'openrouter' && process.env.OPENROUTER_API_KEY) return { kind: 'openrouter', model: chatModel('openrouter') };
  if (explicit === 'openai' && process.env.OPENAI_API_KEY) return { kind: 'openai', model: chatModel('openai') };
  if (explicit === 'cli' && await hasClaudeCli()) return { kind: 'cli', model: chatModel('cli') };
  if (explicit) return { kind: 'misconfigured', model: explicit };
  if (process.env.ANTHROPIC_API_KEY) return { kind: 'api', model: chatModel('api') };
  if (process.env.OPENROUTER_API_KEY) return { kind: 'openrouter', model: chatModel('openrouter') };
  if (process.env.OPENAI_API_KEY) return { kind: 'openai', model: chatModel('openai') };
  if (await hasClaudeCli()) return { kind: 'cli', model: chatModel('cli') };
  return null;
}

// One text-in/text-out completion. Throws Error with a user-safe .message.
export async function callLLM({ system, prompt }) {
  const provider = await resolveProvider();
  if (!provider) {
    throw new Error('No LLM provider configured. Open AI settings in the app, or add a key to .env.');
  }
  if (provider.kind === 'misconfigured') {
    throw new Error(`AI settings picked "${provider.model}" but its key isn't set — check AI settings.`);
  }
  if (provider.kind === 'mock') return callMock();
  if (provider.kind === 'cmd') return callCmd({ system, prompt });
  if (provider.kind === 'openrouter') return callOpenAICompat({ system, prompt, base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY, name: 'OpenRouter', keyName: 'OPENROUTER_API_KEY', model: provider.model });
  if (provider.kind === 'openai') return callOpenAICompat({ system, prompt, base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY, name: 'OpenAI', keyName: 'OPENAI_API_KEY', model: provider.model });
  if (provider.kind === 'api') return callApi({ system, prompt, model: provider.model });
  return callCli({ system, prompt, model: provider.model });
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
async function callApi({ system, prompt, model }) {
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
        model,
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

// OpenAI-compatible chat API via fetch — serves both OpenAI and OpenRouter.
async function callOpenAICompat({ system, prompt, base, key, name, keyName, model }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
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
      : `Could not reach the ${name} API: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* opaque */ }
    if (res.status === 401) throw new Error(`The ${keyName} was rejected (401). Check the key in AI settings.`);
    if (res.status === 429) throw new Error(`Rate limited by the ${name} API — wait a minute and retry.`);
    throw new Error(`${name} API error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('The model returned an empty response — retry.');
  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error('The response was too large to emit — split the request and retry.');
  }
  return text;
}

// Speech-to-text via an OpenAI-compatible /audio/transcriptions endpoint.
// Voice provider: OPSMAP_VOICE_PROVIDER (openai|openrouter), else whichever
// key exists. Anthropic has no transcription API — the app falls back to the
// browser's built-in recognizer in that case.
export async function callTranscription({ audio, mime }) {
  const explicit = process.env.OPSMAP_VOICE_PROVIDER;
  let base, key, name;
  if (explicit === 'openai' || (!explicit && process.env.OPENAI_API_KEY)) {
    base = 'https://api.openai.com/v1'; key = process.env.OPENAI_API_KEY; name = 'OpenAI';
  } else if (explicit === 'openrouter' || (!explicit && process.env.OPENROUTER_API_KEY)) {
    base = 'https://openrouter.ai/api/v1'; key = process.env.OPENROUTER_API_KEY; name = 'OpenRouter';
  } else if (explicit === 'browser') {
    throw new Error('Voice is set to the browser recognizer — no API call needed.');
  }
  if (!base || !key) {
    throw new Error('API voice needs an OpenAI or OpenRouter key — add one in AI settings, or switch voice to Browser.');
  }
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), 'audio.webm');
  form.append('model', voiceModel());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let res;
  try {
    res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Transcription took too long — try a shorter clip.' : `Could not reach the ${name} API: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* opaque */ }
    throw new Error(`${name} transcription error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  const text = data?.text ?? '';
  if (!text.trim()) throw new Error('The transcription came back empty — try again.');
  return text;
}

// Local `claude` CLI in print mode. The prompt goes over stdin; the user's
// existing Claude Code credentials stay entirely on this machine. Tools are
// disabled (pure completion) and cwd is neutral so no project context leaks
// into the extraction.
async function callCli({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--model', model, '--tools', ''];
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
