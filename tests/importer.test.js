// Importer pipeline: offline tests with an injected fake LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importTranscript, ImportError, stripFences, MIN_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_CHARS } from '../server/importer.js';

const TRANSCRIPT = `Joe: So walk me through what happens when a new patient calls.
Karen: Sure — so the front desk takes the call, gets their insurance info, and um, Marisol checks eligibility in Dentrix before we ever book them. If it's an emergency we squeeze them in same day, otherwise they go on the regular schedule. After the visit the claim goes out, and if it's denied Dana reworks it and resubmits.
Joe: Who decides emergency versus routine?
Karen: Whoever answers, honestly — there's a checklist taped to the monitor.`;

const GOOD_YAML = `name: Brightside Dental — New Patient Flow
description: From first call through claim resubmission.
nodes:
  - id: intake-call
    type: process
    label: Front desk takes the call
    description: Front desk collects contact and insurance info on the first call.
  - id: marisol  # inferred: handles eligibility daily but title never stated
    type: role
    label: Insurance coordinator (Marisol)
  - id: dentrix
    type: system
    label: Dentrix
  - id: triage
    type: decision
    label: Emergency or routine?
    description: Whoever answers decides using the checklist taped to the monitor.
  - id: same-day
    type: process
    label: Same-day squeeze-in
  - id: schedule
    type: process
    label: Regular scheduling
  - id: claim
    type: process
    label: Submit claim
    children:
      nodes:
        - id: rework
          type: process
          label: Rework denied claim
        - id: dana  # inferred: reworks denials; billing role never named
          type: role
          label: Dana (billing)
      edges:
        - from: dana
          to: rework
  - id: checklist
    type: artifact
    label: Triage checklist
edges:
  - from: intake-call
    to: triage
  - from: marisol
    to: dentrix
    label: checks eligibility in
  - from: triage
    to: same-day
    label: emergency
  - from: triage
    to: schedule
    label: routine
  - from: schedule  # inferred: visit itself implied between scheduling and claim
    to: claim
`;

const fake = (responses) => {
  const calls = [];
  const fn = async ({ system, prompt }) => {
    calls.push({ system, prompt });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof r === 'function' ? r({ system, prompt }) : r;
  };
  fn.calls = calls;
  return fn;
};

test('happy path: valid YAML → source + review with provenance flags', async () => {
  const llm = fake([GOOD_YAML]);
  const { source, review } = await importTranscript(TRANSCRIPT, { llm });
  assert.equal(llm.calls.length, 1);
  assert.ok(llm.calls[0].system.includes('inferred'), 'system prompt teaches the flag convention');
  assert.ok(llm.calls[0].prompt.includes('Dentrix'), 'transcript in prompt');
  assert.ok(source.endsWith('\n'));
  assert.equal(review.name, 'Brightside Dental — New Patient Flow');
  assert.equal(review.nodeCount, 10);
  assert.equal(review.edgeCount, 6);
  assert.equal(review.depth, 2);
  assert.deepEqual(review.types, { process: 5, decision: 1, system: 1, role: 2, artifact: 1 });
  const flagIds = review.flags.map((f) => f.id).sort();
  assert.deepEqual(flagIds, ['dana', 'marisol', 'schedule → claim'].sort(), JSON.stringify(review.flags));
  const edgeFlag = review.flags.find((f) => f.kind === 'edge');
  assert.match(edgeFlag.note, /visit itself implied/);
});

test('markdown fences are stripped', async () => {
  const llm = fake(['```yaml\n' + GOOD_YAML + '\n```']);
  const { review } = await importTranscript(TRANSCRIPT, { llm });
  assert.equal(review.nodeCount, 10);
  assert.equal(stripFences('```\nname: X\n```'), 'name: X');
});

test('ERROR: sentinel becomes a clean 422', async () => {
  const llm = fake(['ERROR: this is a cookie recipe, not a business transcript']);
  await assert.rejects(
    () => importTranscript(TRANSCRIPT, { llm }),
    (e) => e instanceof ImportError && e.status === 422 && /cookie recipe/.test(e.message),
  );
});

test('invalid first output triggers ONE corrective retry with validator feedback', async () => {
  const bad = GOOD_YAML.replace('to: triage', 'to: no-such-node');
  const llm = fake([bad, GOOD_YAML]);
  const { review } = await importTranscript(TRANSCRIPT, { llm });
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].prompt, /failed validation/);
  assert.match(llm.calls[1].prompt, /no-such-node/);
  assert.match(llm.calls[1].prompt, /<previous_attempt>/);
  assert.equal(review.nodeCount, 10);
});

test('invalid twice → 422 with validator detail, never a crash', async () => {
  const bad = 'name: X\nnodes:\n  - id: a\n    type: wizard\n    label: A\n';
  const llm = fake([bad, bad]);
  await assert.rejects(
    () => importTranscript(TRANSCRIPT, { llm }),
    (e) => e instanceof ImportError && e.status === 422 && /wizard/.test(e.message),
  );
  assert.equal(llm.calls.length, 2);
});

test('too-short and too-long transcripts fail fast without calling the LLM', async () => {
  const llm = fake([GOOD_YAML]);
  await assert.rejects(
    () => importTranscript('hello', { llm }),
    (e) => e instanceof ImportError && e.status === 422 && /too short/i.test(e.message),
  );
  await assert.rejects(
    () => importTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS + 1), { llm }),
    (e) => e instanceof ImportError && e.status === 413 && /large/i.test(e.message),
  );
  assert.equal(llm.calls.length, 0);
  assert.ok(MIN_TRANSCRIPT_CHARS > 0);
});

test('fixture transcripts are realistic sizes for the pipeline', async () => {
  const { promises: fs } = await import('node:fs');
  for (const f of ['dental-clinic.txt', 'mortgage-lender.txt', 'saas-support.txt']) {
    const text = await fs.readFile(new URL(`./fixtures/transcripts/${f}`, import.meta.url), 'utf8');
    assert.ok(text.length > MIN_TRANSCRIPT_CHARS * 10, `${f} is a real transcript`);
    assert.ok(text.length < MAX_TRANSCRIPT_CHARS, `${f} under the cap`);
    assert.match(text, /Joe:/, `${f} has speaker labels`);
  }
});

test('flag comments must START the comment: passing mentions are never flags', async () => {
  const { parseMap } = await import('../shared/model.js');
  const { collectProvenance, FLAG_RE } = await import('../shared/provenance.js');
  const src = `name: F
nodes:
  - id: a  # see the assumptions doc for rates
    type: process
    label: A
  - id: b  # uncertainty is high here per Karen
    type: process
    label: B
  - id: c  # inferred: implied by the schedule
    type: process
    label: C
`;
  const { doc, errors } = parseMap(src);
  assert.deepEqual(errors, []);
  const prov = collectProvenance(doc);
  assert.deepEqual([...prov.nodes.keys()], ['c'], 'only the real flag is collected');
  assert.equal(prov.nodes.get('c'), 'implied by the schedule');
  assert.ok(!FLAG_RE.test(' see the assumptions doc'), 'mid-comment mention is not a flag');
  assert.ok(FLAG_RE.test(' Assumption: rate carried over'), 'leading keyword still matches');
});

test('confirming a flag strips only that comment; file stays valid', async () => {
  const { parseMap } = await import('../shared/model.js');
  const { collectProvenance } = await import('../shared/provenance.js');
  const { state } = await import('../app/state.js');
  const edit = await import('../app/edit.js');
  const src = `# keeper comment
name: F
nodes:
  - id: a  # inferred: role implied but never named
    type: role
    label: A
  - id: b
    type: process
    label: B # keeper inline
edges:
  - from: b  # uncertain: ordering hedged
    to: a
`;
  const { doc, model, errors } = parseMap(src);
  assert.deepEqual(errors, []);
  state.doc = doc; state.model = model; state.standalone = false;
  assert.equal(collectProvenance(doc).nodes.get('a'), 'role implied but never named');
  assert.equal(collectProvenance(doc).edges.length, 1);

  edit.confirmNodeFlag('a');
  edit.confirmEdgeFlag(null, 0);
  const out = doc.toString({ lineWidth: 0 });
  const re = parseMap(out);
  assert.deepEqual(re.errors, []);
  assert.ok(!out.includes('inferred'), 'node flag comment gone');
  assert.ok(!out.includes('uncertain'), 'edge flag comment gone');
  assert.ok(out.includes('# keeper comment'), 'unrelated comments intact');
  assert.ok(out.includes('# keeper inline'), 'unrelated inline comment intact');
  assert.equal(collectProvenance(doc).nodes.size, 0);
  assert.equal(collectProvenance(doc).edges.length, 0);
  assert.throws(() => edit.confirmNodeFlag('a'), /no provenance flag/);
});
