# Serigraph roadmap

**North star:** the operating model file — how a *business* runs, kept as one plain, diffable YAML file that consultants, the app, and LLM agents all read and write. Derived from a discovery call, priced by honest human-vs-agent economics, reviewed through provenance flags, and eventually governed while agents execute against it.

*(Earlier framing — "Lucid's flexibility with Mermaid's structure" — is retired: the July 2026 review found text↔visual editors are now table stakes (Mermaid Chart Visual Editor, D2 Studio, Eraser). What no one else holds is the combination above: business ontology + comment-preserving text + economics + provenance, local-first. See [DESIGN.md](DESIGN.md) § Direction.)*

**Design principle that governs everything below:** structure is the source of truth; presentation is optional metadata layered on top. Auto-layout is the default. Anything a user does by hand (a pinned position, a color rule, a saved view) is an *override* written back to the file additively, and can always be removed to return to the automatic behavior. No feature is allowed to force presentation data into a file that didn't ask for it.

---

## Phase 1 — Manual layout adjustment with persistence  ·  *✅ shipped*

The most-requested gap: Mermaid-style auto-layout you can't override. Let a user **drag a node to reposition it and have that position persist** across reloads and file edits, while auto-layout stays the default and the YAML structure is untouched.

- Drag places a node; its position is written back to the file as a small optional field on that node.
- Pinned nodes hold their spot; un-pinned nodes auto-flow around them; edges keep routing automatically.
- A gesture releases a node back to auto-layout (removes the field).
- Positions are per-scope, coordinate-stable, and round-trip through the existing comment-preserving YAML pipeline.
- The position format is documented in `FORMAT.md` as part of the public contract.

*This is the foundation for all of Phase 2 — every drag gesture depends on "a node can own a position that's saved to the file."*

Shipped as: drag a node to pin it (`position: { x, y }` = the node's center in its scope's plane, one line in the file); background drag still pans; pin badge / detail panel release the override; dagre still lays out the full graph so pinning never reshuffles siblings, auto nodes are pushed clear of pins, and edges touching a moved node route directly. Contract documented in [FORMAT.md](FORMAT.md); verification in [VERIFICATION.md](VERIFICATION.md#phase-1--pinned-positions-drag-to-reposition-persisted).

## Phase 2 — Direct-manipulation authoring  ·  *✅ shipped*

Turn the canvas into a full Lucid-style editor, built on Phase 1's position persistence.

- **Shape / node palette toolbar** — a floating palette of the five node types you drag onto the canvas (vs. only the `+ Node` dialog).
- **Drag-to-place** new nodes at a dropped location; double-click empty canvas to create.
- **Drag-to-reparent** — drag a node into a container to move it into that sub-map (rewrites nesting).
- **Connect-by-drag from node ports** — drag from a node edge to another to draw an edge, with the auto line-routing already in place.

Shipped as: palette drop creates a typed node pinned at the drop point (onto a container = created inside it, auto-laid; plain click = the dialog with that type preselected); double-click empty canvas creates a pinned process node; dragging a node onto a container re-nests it and a top drop bar moves it out one level — edges that would cross scopes are **re-homed** to the nearest scope containing both endpoints (each endpoint rewritten to its ancestor-or-self there; self-loops and exact duplicates removed) so no gesture can write an invalid file, with the policy documented in [FORMAT.md](FORMAT.md); dragging from a node's right-edge port to any sibling draws an edge. Every gesture is one comment-preserving commit = one undo. Verification in [VERIFICATION.md](VERIFICATION.md#phase-2--direct-manipulation-authoring).

## Phase 3 — The live, data-bound spec

Make the map reflect reality, not just document it. Aligns with the already-scoped "live node status from CRMs/GitHub."

- **Conditional formatting** — rules in the file that color/badge nodes by a field (e.g. `status: blocked` → red).
- **Data linking** — bind a node to an external source (CSV, GitHub issue, CRM record) and auto-refresh its status/label.
- **Views / layers** — saved filters that show or hide subsets ("just systems", "just what Ops owns"), toggleable in presentation mode.

## Phase 4 — Vocabulary & polish (curated, from Mermaid)  ·  *deprioritized (July 2026 review)*

*Shapes are the most commoditized surface in the category, and every addition erodes the typed-vocabulary contract that keeps maps machine-readable. Nothing here ships before the trust loop (import review queue, edge-flag rendering) and economics depth (ranges, review minutes, scenario compare) do.*

- A few more **semantic node shapes** (datastore, event/trigger, sub-process) — kept small and meaningful, *not* an infinite shape library.
- **Icon / image on nodes** for at-a-glance scanning (a system's logo, a status icon).
- **Per-node style override** as an escape hatch when the type palette isn't enough.

## Phase 5 — Distribution & persistence  ·  *re-scoped (July 2026 review)*

*Full hosted accounts/sync would recreate every disadvantage against Miro/Lucid. The slice that matters is the consultant's follow-up email: a one-command "publish this map read-only to a URL" client portal. Electron only if consultants ask for it.*

- **Hosted mode on Cloudflare** with login and cloud-saved maps (accounts, sync) — extends the deferred "read-only client shares."
- **Electron desktop app** — launchable, persistent, runs offline as a native app.

## Phase 6 — AI-native authoring  ·  *transcript import ✅ shipped*

The map builds itself from how a business is *described*, not just drawn.

- **Transcript → map (discovery import)** — paste or upload a meeting / discovery-call transcript and derive the process (steps, decisions, roles, systems, artifacts, handoffs) into reviewable Serigraph YAML, with low-confidence inferences flagged for the user to confirm. This is the consultant's core workflow, productized.
- **In-canvas copilot** — "find the bottleneck", "draft the servicing sub-map", "where's the compliance risk".
- **Agent scaffolding** — from a node's spec, generate the automation/agent stub that runs that step.

Shipped as: ✨ Import — paste a transcript, the server derives the map through a provider chain (`ANTHROPIC_API_KEY` → logged-in `claude` CLI → `OPSMAP_LLM_CMD` for any local model; secrets never reach the browser, and the button explains itself when no provider is configured). The extraction emits only what the transcript supports; implied items carry `# inferred:` comments that persist in the YAML, and a review step (counts, type mix, flagged inferences) gates the save. Invalid model output gets one corrective retry against the validator, then a clean error. Copilot and agent scaffolding remain open.

## Phase 7 — The economic & operational model  ·  *economics ✅ shipped*

Turn the map from documentation into a decision tool — what a process *costs* and what automating it *saves*.

- **Human-vs-agent economics** — per-node human run cost (time × loaded rate × volume) vs. agent run cost; rolled up across the map into total cost, savings, ROI, and payback. Recalculates live; stored as optional YAML fields.
- **Simulation** — push volumes through the map to find bottlenecks, capacity limits, cycle time, and cost-per-stage.
- **Automation coverage / gap analysis** — what's manual vs. automated, where agents already run, and the highest-ROI automation opportunities. (Builds on Phase 3 data-linking for live actuals.)

Shipped as: optional `cost:` inputs per node (`runs`/month, `human: {minutes, rate}`, `agent: {perRun, setup}`) plus a one-line `costModel:` for currency and a default rate — documented with the formulas in [FORMAT.md](FORMAT.md). Every number is computed live in `shared/cost.js` (app, tests, and standalone exports share it): per-node chips on the canvas, a cost editor in the detail panel, and a map-level economics bar with human vs. agent totals, savings, payback, first-year ROI, and a coverage indicator. Unknowns render as "—" and are excluded from totals — never silently zero. Simulation and gap analysis remain open.

## Phase 8 — Enterprise platform & the agent substrate  ·  *re-scoped (July 2026 review)*

Where the 10X lives: the map as a governed, machine-readable operating model that AI agents run on. **Foundational — gets a plan-first approval before any code.**

*Re-scope: the five-lens review split this phase in two. **8a — the governed change loop** (MCP server over local maps: read/query + propose-diff → a human approves a semantic visual diff → audit trail) is the product, and is cheap because the backend is text and the validator already exists; its prerequisites are versioned writes (`If-Match`/409 + mutator replay) and the localhost-bind hardening shipped in July 2026. **8b — platform plumbing** (SSO/SCIM, subtree RBAC, residency, real-time presence) is commodity infrastructure that Pega/Signavio/Celonis already own; it waits for a named design partner whose procurement demands it, and gets bought rather than built where possible.*

- **MCP / agent API over the map** — any LLM or agent can query it, propose diffs, or bind to a node as its job. The map becomes the control plane agents operate through. This is the moat no diffable-text-less competitor can copy.
- **Multi-user, hosted** — real-time collaboration (presence, comments, @mentions), accounts/workspaces, SSO (SAML/OIDC), SCIM, RBAC with node/subtree-level permissions.
- **Git-grade governance** — version history, branch/diff, PR-style review and approval of process changes, immutable audit trail — nearly free because the backend is already text.
- **Security & deployment** — encryption, audit logs, data residency, a self-host / on-prem option, and client-facing read-only portals.
- **Packaging** — hosted SaaS as the enterprise vehicle; the Electron build as the offline/consultant companion.

*Current build (overnight): the two hero features from Phase 6 (transcript import) and Phase 7 (human-vs-agent economics). Phase 8 is the platform bet and gets its own plan-first prompt.*

---

## Deliberately *not* doing

Lucid's power is also its bloat: infinite freeform shapes, manual coordinate fiddling as the norm, feature sprawl. Serigraph's differentiator is the curated, typed, text-backed structure. Keep the shape set semantic and small; keep auto-layout the default and manual positioning an override; keep the file diffable and agent-writable. That line is what stops "Mermaid structure" from eroding into "Lucid freeform."

We're already ahead of Mermaid on its worst friction — the write-text-then-re-render loop — via live file-sync plus visual editing. Don't lose it.
