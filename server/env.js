// Repo root + .env loading, shared by every server module that reads secrets
// at import time. It must run before server/llm.js snapshots OPSMAP_LLM_CMD,
// so llm.js imports this module for its side effect before anything else.
//
// Real environment variables always win; the file only fills gaps. Set
// OPSMAP_SKIP_DOTENV=1 in child processes (tests) that must stay hermetic.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.OPSMAP_ROOT
  ? path.resolve(process.env.OPSMAP_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Set this in the launching environment, not in .env: it determines which
// workspace's .env is read. Application assets always remain under ROOT.
export const LIBRARY_ROOT = process.env.SERIGRAPH_LIBRARY_DIR
  ? path.resolve(process.env.SERIGRAPH_LIBRARY_DIR)
  : ROOT;
export const ENV_PATH = process.env.OPSMAP_ENV_FILE
  ? path.resolve(process.env.OPSMAP_ENV_FILE)
  : path.join(LIBRARY_ROOT, '.env');

if (!process.env.OPSMAP_SKIP_DOTENV) {
  try {
    const envFile = await fs.readFile(ENV_PATH, 'utf8');
    for (const line of envFile.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch { /* no .env — fine */ }
}
