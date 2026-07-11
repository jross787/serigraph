// Transcript → Opsmap YAML extraction pipeline.
// callLLM is injected so tests run offline against fixtures; the server
// injects the real provider chain from server/llm.js.
import { parseMap } from '../shared/model.js';
import { collectProvenance } from '../shared/provenance.js';

export const MIN_TRANSCRIPT_CHARS = 120;
export const MAX_TRANSCRIPT_CHARS = 120_000;

// The extraction contract. Faithfulness rules are the point: emit only what
// the transcript supports, and flag inferences as inline YAML comments that
// survive the round-trip into the saved file.
export const SYSTEM_PROMPT = `You are an expert business-process analyst. You turn a meeting or discovery-call transcript into an Opsmap process map: one YAML document describing how the business operates.

## Output format (the complete contract)

Top level:
  name: <the business/process name — required>
  description: <one line — optional>
  nodes: <list of nodes — required>
  edges: <list of edges between TOP-LEVEL nodes — optional>

Each node:
  - id: kebab-case, unique across the ENTIRE file (letters, digits, - _ .; no spaces)
    type: one of exactly: process | decision | system | role | artifact
    label: display name (any text)
    description: 1–2 substantive sentences drawn from the transcript (optional but strongly preferred)
    children:            # optional nested sub-map INSIDE this node
      nodes: [...]       # same shape, any depth
      edges: [...]       # edges between this node's children only

The five types: process = a step/stage where work happens; decision = a branch point; system = software/tool/platform (use its real name from the transcript); role = a person/team/job function; artifact = a document or data object produced or consumed.

Edges connect SIBLINGS only — both from and to must be ids in the SAME nodes list (top level, or the same node's children). Show a handoff between things in different branches one level up, between their parents. Edges are directional: - from: a
  to: b
  label: what flows (optional, but REQUIRED on every edge leaving a decision — the outcome, e.g. "approved" / "declined").

## Faithfulness rules (non-negotiable)

- Emit ONLY what the transcript supports. Never invent steps, systems, roles, numbers, or names.
- When something is IMPLIED but never stated outright (a role obviously doing the work, an unnamed handoff, an uncertain ordering), you may include it — but you MUST flag it with an inline YAML comment on that item's id line (or the edge's from line):
    - id: insurance-coordinator  # inferred: handles verifications daily but title never stated
    - from: intake  # inferred: ordering implied by "after that"
  Keep the note under ~12 words. Do NOT comment things stated directly.
- Ignore content that is not part of the operating process: anecdotes, small talk, renovations, hiring stories, vendor complaints (unless the vendor is a system they operate with).
- Keep labels/descriptions in the transcript's language.
- Use the speaker's own terms for steps and systems; put verbatim-quote fragments inside descriptions where they help.

## Structure guidance

- Top level: the main flow, typically 6–14 nodes — the major stages plus the key roles, systems, and artifacts wired in with labeled edges.
- Use children for a stage's internal detail when the transcript gives 2+ sub-steps.
- Every decision node needs its branches as labeled outgoing edges (and the branch targets must exist).
- Rich maps mix all five types when the transcript supports them.

## Output rules

Output ONLY the YAML document — no prose, no markdown fences, no explanation. Start with "name:".
If the input is not really a transcript, or no operating process can be derived from it, output exactly one line instead:
ERROR: <one short line saying why>`;

export function buildPrompt(transcript) {
  return `Derive the Opsmap YAML map from this transcript.\n\n<transcript>\n${transcript}\n</transcript>`;
}

// strip markdown fences if the model added them despite instructions
export function stripFences(text) {
  let t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (m) t = m[1].trim();
  return t;
}

// Flatten provenance into the review-step display list.
export function collectFlags(doc, model) {
  const { nodes, edges } = collectProvenance(doc);
  const flags = [];
  for (const [id, note] of nodes) {
    flags.push({ kind: 'node', id, label: model?.byId.get(id)?.label ?? id, note });
  }
  for (const e of edges) {
    const scopeLabel = e.owner ? model?.byId.get(e.owner)?.label ?? e.owner : null;
    flags.push({
      kind: 'edge',
      id: `${e.from} → ${e.to}`,
      label: `${e.from} → ${e.to}${scopeLabel ? ` (in ${scopeLabel})` : ''}`,
      note: e.note,
    });
  }
  return flags;
}

function typeCounts(model) {
  const counts = { process: 0, decision: 0, system: 0, role: 0, artifact: 0 };
  for (const n of model.byId.values()) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return counts;
}

function maxDepth(model) {
  let d = 1;
  for (const n of model.byId.values()) d = Math.max(d, n.depth + 1);
  return d;
}

function countEdges(model) {
  let c = 0;
  (function walk(scope) {
    c += scope.edges.length;
    for (const n of scope.nodes) if (n.children) walk(n.children);
  })(model.root);
  return c;
}

// The pipeline: transcript → LLM → validate → (one corrective retry) →
// { source, review }. Throws ImportError with a user-safe message + status.
export class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function importTranscript(transcript, { llm }) {
  const text = String(transcript ?? '').trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) {
    throw new ImportError(422, `That's too short to derive a process from (${text.length} chars). Paste the full transcript — a few hundred words minimum.`);
  }
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new ImportError(413, `That transcript is very large (${Math.round(text.length / 1000)}k chars; limit ${MAX_TRANSCRIPT_CHARS / 1000}k). Split it and import the core process discussion.`);
  }

  let raw = await llm({ system: SYSTEM_PROMPT, prompt: buildPrompt(text) });
  let yaml = stripFences(raw);
  if (/^ERROR:/i.test(yaml)) {
    throw new ImportError(422, `Couldn't derive a process: ${yaml.replace(/^ERROR:\s*/i, '').split('\n')[0]}`);
  }

  let { doc, model, errors } = parseMap(yaml);
  if (errors.length) {
    // one corrective retry with the validator's feedback
    const feedback = errors.slice(0, 12).map((e) => `- ${e.message}${e.line ? ` (line ${e.line})` : ''}`).join('\n');
    raw = await llm({
      system: SYSTEM_PROMPT,
      prompt: `${buildPrompt(text)}\n\nYour previous attempt failed validation. Fix these problems and return the complete corrected YAML only:\n${feedback}\n\n<previous_attempt>\n${yaml}\n</previous_attempt>`,
    });
    yaml = stripFences(raw);
    if (/^ERROR:/i.test(yaml)) {
      throw new ImportError(422, `Couldn't derive a process: ${yaml.replace(/^ERROR:\s*/i, '').split('\n')[0]}`);
    }
    ({ doc, model, errors } = parseMap(yaml));
  }
  if (errors.length || !model) {
    const first = errors.slice(0, 3).map((e) => e.message).join(' · ');
    throw new ImportError(422, `The model couldn't produce a valid map after a retry. ${first ? `Validator said: ${first}` : ''}`);
  }

  // Canonicalize through the same serializer the editor uses, so the very
  // first visual edit produces a clean one-line diff (comment separators etc.
  // are normalized NOW, at birth, not on the user's first save).
  const canonical = doc.toString({ lineWidth: 0 });

  return {
    source: canonical.endsWith('\n') ? canonical : canonical + '\n',
    review: {
      name: model.name,
      nodeCount: model.nodeCount,
      edgeCount: countEdges(model),
      depth: maxDepth(model),
      types: typeCounts(model),
      flags: collectFlags(doc, model),
    },
  };
}
