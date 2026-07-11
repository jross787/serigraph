# Design decisions

Why this product is built the way it is. Each decision below was deliberate,
most were tested adversarially (see [VERIFICATION.md](VERIFICATION.md)), and
together they form the moat: **the operating model as living, machine-readable
text.** If a future change violates one of these, it should be an explicit
reversal, not an accident.

## 1. The file is the truth — not the canvas, not a database

A map is one plain YAML file. The canvas is a *view*. Humans can edit either
side; LLM agents read and write the same file; `git diff` shows exactly what
changed about how the business runs.

*Why:* every diagram tool before this one made you choose — visual freedom
with an opaque binary blob (Lucidchart, Visio, Miro), or diffable text with no
direct manipulation (Mermaid, Graphviz). Holding both edges at once is the
founding bet. It is also what makes the AI features honest: an agent that
proposes a process change produces a *reviewable text diff*, not a mutated
canvas.

*Consequences accepted:* concurrent multi-writer editing needs real machinery
later (Phase 8); files must stay human-readable, which caps how much data we
cram into them.

## 2. Comment-preserving edits, or the text edge is a lie

Every visual edit round-trips through a YAML Document API that preserves
comments and untouched formatting (`toString({ lineWidth: 0 })` so long lines
never re-wrap). A drag writes one line; a rename touches one field.

*Why:* if the app rewrites your file wholesale on every click, "text as
truth" collapses — hand-written comments are institutional knowledge, and a
noisy diff is an unreviewable diff. This constraint shaped the entire edit
pipeline (single `commit()` path, no second save route) and is enforced by
tests. Imported maps are canonicalized at creation so their first edit diffs
clean.

## 3. Five node types, and only five

`process`, `decision`, `system`, `role`, `artifact`. No shape library, no
freeform styling.

*Why:* the constraint is the product. A curated, typed vocabulary is what
keeps maps queryable by agents, comparable across clients, and honest as
documents — the moment we allow "just one more shape" we erode toward Lucid's
infinite-canvas soup, which is precisely the thing that can't be automated
against. Semantic additions (datastore, event) are a considered Phase 4
decision, not a style option.

## 4. Auto-layout is the default; everything manual is an optional override

dagre lays out every scope from structure alone. A dragged node writes one
`position: {x, y}` line; releasing the pin deletes it. Same pattern for all
presentation metadata: **structure is the source of truth, presentation is
additive and removable.** A file with no presentation fields must render
byte-identically to what it rendered before those features existed — we prove
this with DOM-hash comparisons on every phase.

*Why:* it keeps files minimal (agents shouldn't have to invent coordinates),
keeps rendering deterministic, and means no feature can hold the file format
hostage.

## 5. Edges connect siblings only; re-nesting re-homes them

An edge lives in the scope where both endpoints live. When a node moves into
a container, edges that would cross scopes are rewritten to the nearest scope
containing both endpoints (endpoint → its ancestor-or-self there), and
self-loops/exact duplicates are dropped — documented in FORMAT.md.

*Why:* cross-scope spaghetti is what makes big diagrams unreadable and
un-analyzable. Sibling-only edges give every scope a self-contained story and
make roll-ups (counts, costs, later simulation) well-defined. The re-homing
policy exists so no drag can ever write an invalid file.

## 6. Unknown is never zero

A cost field you didn't fill in renders as "—" and excludes the node from
totals entirely (its setup cost too). Savings therefore always equals human
minus agent *over the same nodes*. Coverage is stated on the bar ("4 of 23
steps costed") so partial data can't masquerade as a complete answer.

*Why:* the economics feature is a decision tool; the fastest way to lose a
CFO is one silently-fabricated number. This rule survived an adversarial
reviewer who hand-recomputed every figure and a cold agent who predicted the
roll-up from the docs alone.

## 7. Provenance is a comment, not a schema field

The AI importer marks anything implied-but-not-stated with an inline
`# inferred: <why>` comment. The app renders these as ⚑ badges with a
"Mark confirmed" action that simply deletes the comment.

*Why:* it composes perfectly with decisions 1 and 2 — the flag lives in the
file, survives every edit, shows up in `git diff`, costs nothing when absent,
and confirming a fact is the most natural possible operation: removing the
doubt. No parallel metadata store to drift out of sync.

## 8. Never fabricate — the importer emits only what the transcript supports

The extraction contract instructs the model to include implied items *only*
with a provenance flag, ignore red herrings (anecdotes, tangents), keep the
transcript's language, and answer `ERROR:` when no process exists. Output is
validated; one corrective retry with validator feedback; then a clean error.
A review step (counts, type mix, flagged inferences) gates every save.

*Why:* consultants stake their reputation on these maps. A map that invents
a step is worse than no map. "Reviewable before saved" is the difference
between an AI feature and an AI liability.

## 9. Secrets stay server-side; the app works with no key at all

The browser only ever calls `/api/import`. The LLM provider chain lives in
the server process: mock file → `OPSMAP_LLM_CMD` (any local model over
stdin/stdout) → `ANTHROPIC_API_KEY` → logged-in `claude` CLI. No provider →
the Import button explains setup. Everything else — economics included — is
pure local math and runs offline forever.

*Why:* local-first is a security posture, not a limitation: client operating
data and meeting transcripts are among the most sensitive documents a
business has. The pluggable command provider means an air-gapped shop can run
a local model and never send a byte out.

## 10. Zero runtime dependencies, one command

`npm start`. No install step, no build, no lockfile churn. The only libraries
are vendored (`yaml`, `dagre`) and loaded as plain modules.

*Why:* the audience includes non-engineers; "clone and run" has to survive
years of ecosystem drift. It also forces implementation discipline — every
feature is small enough to own outright. The standalone HTML export (a whole
map + viewer in one file you can email) falls out of the same discipline.

## 11. Verification is fresh-context and adversarial

Every phase ships only after reviewer agents with no memory of the build try
to break it with real input, hand-recomputed numbers, and hostile edge cases —
and after a "cold" agent proves the docs alone are enough to author valid
files. Evidence lives in [docs/evidence/](evidence/).

*Why:* a tool whose pitch is "trustworthy single source of truth" cannot
ship on the builder's own happy-path testing.

---

*The one-sentence test for new work:* does it make the file more valuable as
the single machine-readable description of how the business runs — for the
human who reviews it, the CFO who prices it, and the agent that will
eventually execute against it? If not, it doesn't belong.

---

## Direction (July 2026 five-lens review)

Five independent reviewers — market analyst, enterprise buyer, UX critic,
architect, feature auditor — examined the whole product. Their verdicts
converged, and this section is the synthesis the roadmap now follows.

**What this product is.** One loop, for one persona: the AI-automation
consultant. Record the discovery call → derive the map → review what was
inferred → price the automation → hand the same file to the agents that build
and eventually run it. Every shipped feature that serves that loop earned its
place; the features that serve "diagram tool parity" are done and closed.

**What it is not.** A Mermaid/Lucid competitor. Text↔visual editing with AI
drafting is table stakes in 2026 (Mermaid Chart Visual Editor, D2 Studio,
Eraser). The unoccupied ground is narrower and better: a *business* ontology
(not boxes), comment-preserving text (not export formats), honest per-step
human-vs-agent economics (nobody attaches this to the map), and provenance
that travels in the file. Positioning language that benchmarks against
diagram editors is retired.

**The order of work the review demands:**

1. **Close the trust loop before adding anything.** The moments the product
   earns or loses a consultant's confidence are underbuilt relative to the
   canvas: the import review step should be a real review (preview + editable
   list, not a stats card), edge-level flags must render like node flags, a
   global "N unconfirmed" indicator, no silent no-ops (short-transcript
   Derive, keyboard-dead ⌘K), visible save state. Polish here beats any new
   surface.
2. **Deepen economics toward CFO-grade.** Point estimates read as a sales
   artifact. Planned fields: an automation fraction, residual human review
   minutes, agent maintenance; ranges that roll up as ranges; before/after
   scenario comparison; the ROI story included in the standalone export —
   which is the artifact a consultant actually sells. The "unknown is never
   zero" discipline stays the foundation for all of it.
3. **Make provenance evidence-grade.** Every inferred node should be able to
   point at the transcript span that supports it. "Every box traceable to a
   sentence the client said" is the defensible claim; a sparkle button is not.
4. **The governed change loop is the endgame — and it is small.** An MCP
   server over local maps: agents query and *propose* diffs, a human approves
   a semantic visual diff, an audit trail records it. Prerequisites already
   identified: versioned writes (`If-Match`/409 with mutator replay) and the
   localhost hardening (shipped). The enterprise plumbing around it
   (SSO/SCIM/RBAC/residency) is explicitly deferred — bought, not built,
   when a real customer demands it.
5. **Sharing is the open end of the loop.** Today the consultant's follow-up
   email is a static HTML attachment. One thin slice — publish a read-only
   map to a URL — converts every export recipient into a viewer and makes a
   paid pilot possible. Full hosted accounts stay off the table.

**Stopped (won't happen without an explicit reversal here):** more node
shapes and per-node styling (Phase 4 as scoped); hosted accounts/sync as
scoped in Phase 5; the Phase 8 enterprise checklist beyond the MCP slice;
"moat" language for the text backend — it is a wedge, and it stays sharp only
while the loop above keeps compounding.
