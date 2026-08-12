// AI settings: provider, keys, and model choices. Keys are written to the
// .env file at the repo root (gitignored, mode 600) so the double-clicked
// Mac app picks them up without a shell. The GET view is masked — a saved
// key never comes back to the browser.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// overridable so tests never touch the real .env
const ENV_PATH = process.env.OPSMAP_ENV_FILE || path.join(ROOT, '.env');

// keys the settings panel manages; everything else in .env is preserved
const KEY_FIELDS = {
  anthropicKey: 'ANTHROPIC_API_KEY',
  openaiKey: 'OPENAI_API_KEY',
  openrouterKey: 'OPENROUTER_API_KEY',
  veniceKey: 'VENICE_API_KEY',
  provider: 'OPSMAP_LLM_PROVIDER',
  model: 'OPSMAP_MODEL',
  voiceProvider: 'OPSMAP_VOICE_PROVIDER',
  voiceModel: 'OPSMAP_VOICE_MODEL',
};

export const PROVIDERS = ['auto', 'anthropic', 'openai', 'openrouter', 'venice', 'cli'];
export const VOICE_PROVIDERS = ['browser', 'api'];

async function readEnvLines() {
  try {
    return (await fs.readFile(ENV_PATH, 'utf8')).split('\n');
  } catch {
    return [];
  }
}

function parseEnv(lines) {
  const map = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2].replace(/^["']|["']$/g, ''));
  }
  return map;
}

export async function readSettings() {
  const file = parseEnv(await readEnvLines());
  const get = (envKey) => process.env[envKey] ?? file.get(envKey) ?? '';
  return {
    provider: get('OPSMAP_LLM_PROVIDER') || 'auto',
    model: get('OPSMAP_MODEL'),
    voiceProvider: get('OPSMAP_VOICE_PROVIDER') || 'browser',
    voiceModel: get('OPSMAP_VOICE_MODEL'),
    anthropicKeySet: !!get('ANTHROPIC_API_KEY'),
    openaiKeySet: !!get('OPENAI_API_KEY'),
    openrouterKeySet: !!get('OPENROUTER_API_KEY'),
    veniceKeySet: !!get('VENICE_API_KEY'),
  };
}

// patch rules: undefined leaves a value alone; '' removes it; anything else
// sets it. Applies to process.env immediately and rewrites .env, preserving
// comments and unmanaged keys.
export async function writeSettings(patch) {
  const updates = new Map();
  if (patch.provider !== undefined) {
    if (patch.provider !== '' && !PROVIDERS.includes(patch.provider)) throw new Error('Unknown provider.');
    updates.set('OPSMAP_LLM_PROVIDER', patch.provider === 'auto' ? '' : patch.provider);
  }
  if (patch.voiceProvider !== undefined) {
    if (patch.voiceProvider !== '' && !VOICE_PROVIDERS.includes(patch.voiceProvider)) throw new Error('Unknown voice provider.');
    updates.set('OPSMAP_VOICE_PROVIDER', patch.voiceProvider === 'browser' ? '' : patch.voiceProvider);
  }
  if (patch.model !== undefined) updates.set('OPSMAP_MODEL', String(patch.model).trim());
  if (patch.voiceModel !== undefined) updates.set('OPSMAP_VOICE_MODEL', String(patch.voiceModel).trim());
  for (const field of ['anthropicKey', 'openaiKey', 'openrouterKey', 'veniceKey']) {
    if (patch[field] !== undefined) updates.set(KEY_FIELDS[field], String(patch[field]).trim());
  }

  const lines = await readEnvLines();
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !updates.has(m[1])) return line;
    seen.add(m[1]);
    const value = updates.get(m[1]);
    return value === '' ? null : `${m[1]}=${value}`;
  }).filter((line) => line !== null);
  for (const [key, value] of updates) {
    if (!seen.has(key) && value !== '') out.push(`${key}=${value}`);
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  await fs.writeFile(ENV_PATH, text, { mode: 0o600 });

  for (const [key, value] of updates) {
    if (value === '') delete process.env[key];
    else process.env[key] = value;
  }
  return readSettings();
}
