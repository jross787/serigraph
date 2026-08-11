// AI settings: masked reads, safe .env writes, provider resolution.
// OPSMAP_ENV_FILE must point at a temp file before settings.js loads, so
// tests never touch the real .env.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENV_FILE = path.join(tmpdir(), `serigraph-test-env-${process.pid}`);
process.env.OPSMAP_ENV_FILE = ENV_FILE;
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPSMAP_LLM_PROVIDER', 'OPSMAP_MODEL', 'OPSMAP_VOICE_PROVIDER', 'OPSMAP_VOICE_MODEL']) {
  delete process.env[k];
}

let settings;
let llm;

before(async () => {
  settings = await import('../server/settings.js');
  llm = await import('../server/llm.js');
});

after(async () => {
  await fs.rm(ENV_FILE, { force: true });
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPSMAP_LLM_PROVIDER', 'OPSMAP_MODEL', 'OPSMAP_VOICE_PROVIDER', 'OPSMAP_VOICE_MODEL']) {
    delete process.env[k];
  }
});

test('write then read: masked, no key material in the response', async () => {
  const out = await settings.writeSettings({ openaiKey: 'sk-test-123', provider: 'openai', model: 'gpt-4o-mini' });
  assert.equal(out.openaiKeySet, true);
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-4o-mini');
  assert.ok(!JSON.stringify(out).includes('sk-test-123'), 'key never leaves the server');
  const file = await fs.readFile(ENV_FILE, 'utf8');
  assert.ok(file.includes('OPENAI_API_KEY=sk-test-123'));
  assert.ok(file.includes('OPSMAP_LLM_PROVIDER=openai'));
});

test('rewrites preserve comments and unmanaged keys', async () => {
  await fs.writeFile(ENV_FILE, '# my comment\nUNRELATED_THING=keep-me\nOPENAI_API_KEY=old\n');
  await settings.writeSettings({ openaiKey: 'new-key' });
  const file = await fs.readFile(ENV_FILE, 'utf8');
  assert.ok(file.includes('# my comment'));
  assert.ok(file.includes('UNRELATED_THING=keep-me'));
  assert.ok(file.includes('OPENAI_API_KEY=new-key'));
  assert.ok(!file.includes('old'), 'old key replaced');
  assert.equal((file.match(/OPENAI_API_KEY/g) ?? []).length, 1, 'no duplicate keys');
});

test('empty string removes a key from file and environment', async () => {
  await settings.writeSettings({ openaiKey: 'sk-gone' });
  assert.equal(process.env.OPENAI_API_KEY, 'sk-gone');
  await settings.writeSettings({ openaiKey: '' });
  const file = await fs.readFile(ENV_FILE, 'utf8');
  assert.ok(!file.includes('OPENAI_API_KEY'));
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

test('unknown provider is rejected without touching the file', async () => {
  await fs.writeFile(ENV_FILE, 'UNTOUCHED=1\n');
  await assert.rejects(settings.writeSettings({ provider: 'kimi' }), /Unknown provider/);
  assert.equal(await fs.readFile(ENV_FILE, 'utf8'), 'UNTOUCHED=1\n');
});

test('the .env file is private to the user', async () => {
  await settings.writeSettings({ openaiKey: 'sk-mode' });
  const stat = await fs.stat(ENV_FILE);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('provider resolution honors the explicit choice and reports misconfiguration', async () => {
  delete process.env.OPSMAP_LLM_PROVIDER;
  process.env.OPENAI_API_KEY = 'x';
  process.env.OPENROUTER_API_KEY = 'y';
  assert.equal((await llm.resolveProvider()).kind, 'openrouter', 'auto chain: openrouter beats openai when both keys exist');

  process.env.OPSMAP_LLM_PROVIDER = 'openai';
  assert.equal((await llm.resolveProvider()).kind, 'openai', 'explicit choice wins');

  process.env.OPSMAP_LLM_PROVIDER = 'anthropic';
  const p = await llm.resolveProvider();
  assert.equal(p.kind, 'misconfigured', 'explicit choice without a key is reported, not silent');
});
