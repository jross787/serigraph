// The map assistant: an instruction plus the current map goes in, a complete
// updated map comes out. Same discipline as the importer — the model's output
// is validated against the real schema, one corrective retry with validator
// feedback, then a clean error. Nothing is saved server-side; the client
// reviews the proposal before applying it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap } from '../shared/model.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let formatSpec = null;
async function loadFormatSpec() {
  if (formatSpec == null) {
    formatSpec = await fs.readFile(path.join(ROOT, 'docs', 'FORMAT.md'), 'utf8');
  }
  return formatSpec;
}

const SYSTEM_PROMPT = `You are the editor inside Serigraph, a process-mapping tool. The user describes a change to their map and you return the complete updated map as YAML.

Rules:
- Return ONLY the complete updated YAML document. No code fences, no commentary, no questions, no leading or trailing prose.
- Preserve everything the instruction does not touch: ids, labels, descriptions, comments, ordering, and formatting style.
- Keep every existing id stable so deep links and references survive. New nodes get short kebab-case ids that do not collide.
- When you must infer a fact the user did not state, mark it with an inline "# inferred: <why>" comment, never silently.
- If the message is not a map-editing request, or the request is impossible to honor in this format, reply with exactly one line: ERROR: <one short reason>.
- The map format specification follows in full. Obey it exactly.

<format>
%s
</format>`;

export class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Accept the model's YAML even when it wraps the answer in fences despite
// being told not to.
function stripFences(text) {
  let out = String(text || '').trim();
  const fenced = out.match(/^```(?:yaml|yml)?\s*\n([\s\S]*?)\n?```\s*$/i);
  if (fenced) out = fenced[1].trim();
  return out;
}

function buildPrompt({ source, instruction, history, focus }) {
  const prior = (history ?? [])
    .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
    .join('\n');
  const focusBlock = focus && typeof focus.id === 'string' && typeof focus.summary === 'string'
    ? `\nThe user has this node selected and is talking about it:\n<focus_node id="${focus.id}">\n${focus.summary.slice(0, 2000)}\n</focus_node>\nMake the change primarily about this node unless the request says otherwise. Keep its id "${focus.id}" stable.\n`
    : '';
  return `${prior ? `Earlier in this conversation:\n${prior}\n\n` : ''}<current_map>\n${source}\n</current_map>\n${focusBlock}\nThe user's request: ${instruction}\n\nReturn the complete updated map YAML only.`;
}

function validate(yaml) {
  const { errors } = parseMap(yaml);
  return errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message);
}

export async function chatEdit(body, { llm }) {
  const source = typeof body?.source === 'string' ? body.source : '';
  const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
  if (!source.trim()) throw new ChatError(400, 'Missing the current map source.');
  if (!instruction) throw new ChatError(400, 'Missing an instruction.');
  if (source.length > 200_000) throw new ChatError(413, 'The map is too large to edit by chat (200 KB limit).');
  if (instruction.length > 4_000) throw new ChatError(413, 'Keep the instruction under 4,000 characters.');

  const system = SYSTEM_PROMPT.replace('%s', await loadFormatSpec());
  const prompt = buildPrompt({ source, instruction, history: body?.history, focus: body?.focus });

  let yaml = stripFences(await llm({ system, prompt }));
  if (/^ERROR:/i.test(yaml)) {
    throw new ChatError(422, yaml.replace(/^ERROR:\s*/i, '').split('\n')[0]);
  }
  let problems = validate(yaml);
  if (problems.length) {
    // one corrective retry with the validator's feedback
    yaml = stripFences(await llm({
      system,
      prompt: `${prompt}\n\nYour previous attempt failed validation. Fix these problems and return the complete corrected YAML only:\n${problems.join('\n')}\n\n<previous_attempt>\n${yaml}\n</previous_attempt>`,
    }));
    if (/^ERROR:/i.test(yaml)) {
      throw new ChatError(422, yaml.replace(/^ERROR:\s*/i, '').split('\n')[0]);
    }
    const second = validate(yaml);
    if (second.length) {
      throw new ChatError(422, `The model couldn't produce a valid map after a retry. Validator said: ${second[0]}`);
    }
  }
  return { source: yaml };
}
