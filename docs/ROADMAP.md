# Serigraph roadmap

## Current direction — September 5, 2026

**Serigraph is a living map of real systems, and eventually the place to direct narrowly scoped agents within them.** Understand what exists, see what is happening, investigate a bounded problem, approve a specific action, and verify its effect. Useful findings and decisions accumulate on the map.

The immediate product is a **read-only workspace to explore, observe, reconcile, and audit data across APIs and databases**. A quick **Glance** and a detailed **Report** are two levels of the same evidence, not separate products. Agent execution comes after that foundation, not alongside it. This section is the current delivery order; the older roadmap below is historical context, not a competing backlog. Roadmap items are proposals until their exit criteria are verified.

### Guiding principles

1. **One coherent workspace.** The graph explains relationships; one contextual inspector reveals details. Use tables for rows, a tree for JSON, and small charts for measurements. Glance, reconciliation details, and reports share the same scoped result and calculations. Do not turn every record into a node or build a separate app for each source.
2. **Universal experience, incremental coverage.** A small adapter translates each supported source into the same browsing experience. Prove one source end to end, then a different kind of source. Do not promise every database or API on day one.
3. **Truth before activity.** Distinguish declared, discovered, observed, and inferred information. Show origin, observation time, freshness, and coverage. Unknown is not healthy; an animation is not evidence of traffic.
4. **Keep structure portable and observations separate.** YAML remains authoritative for curated structure, bindings, and reasoning, not the current state of external systems. Live results do not silently rewrite the map. Raw records, telemetry, and credentials never become map content.
5. **Read narrowly, act explicitly.** Metadata first; records only through approved, bounded reads. The private runtime enforces access. A graph selection, imported specification, or agent prompt cannot grant permission.
6. **Elegance through restraint.** Preserve camera, selection, pins, and stable card sizing. Reveal detail progressively; use quiet surfaces and restrained, labeled status accents. Refreshes must not rearrange the map. The broader authoring, reasoning-lens, and alternative-exploration ambitions remain, but do not delay the viewer.
7. **Knowledge should accumulate.** Keep reviewed explanations, questions, decisions, and evidence references with the relevant map object. Retain resolved reasoning. Sensitive evidence stays in approved private storage, not generic examples or exports.
8. **Build the smallest complete slice.** Reuse the catalog, inspector, existing monitoring, and agent runtimes. No speculative framework, duplicate data model, or dependency without a concrete need. Reuse existing tests; add a test only for a necessary behavior not already covered. Flag unrelated work instead of taking it on.

### Explore, Glance, reconcile, report

The user journey is simple: **select a system or connection → Glance at its data and state → inspect or reconcile a bounded set → open the detailed Report → return to the same place on the map.**

- **Glance:** a compact contextual view of available figures, freshness, scope, and notable exceptions. It is immediately useful without losing the map; it does not require hover or silently launch a broad query. Unavailable or partial results remain explicit.
- **Reconcile:** compare two authorized sources using approved identity and field-matching rules. Explain matches, records observed on only one side, duplicates, conflicting values, and inconclusive comparisons. This is investigation, not automatic correction.
- **Report:** expand that same result into an audit snapshot with methods, scope, totals, exceptions, and evidence. No second calculation path and no silent fresh query that makes the report disagree with the Glance. An explicit rerun produces a new result.

The boundary is three parts:

| Part | Owns | Must not contain |
| --- | --- | --- |
| Generic Serigraph engine | Graph, inspector, catalog/result contracts, Glance/report rendering, reusable comparison logic, provenance, later run/approval UI | Business-specific maps, schemas, mappings, endpoint configuration, credentials, or real records |
| Private workspace | Business maps, curated catalog, connection references, metric and comparison definitions, and policy intent | Secret values or raw record/telemetry dumps in Git |
| Approved private runtime | Source adapters, credentials, enforced authorization, bounded reads/comparisons, redaction, scoped results/reports, and access audit | Implicit authority derived from the browser or map |

The runtime can be an existing private data-explorer backend; it does not need a second user interface. Promote only genuinely reusable adapter code into the generic engine, without business configuration or data. [External libraries](PRIVATE-WORKSPACES.md) already separate map storage, but are not a security sandbox or authorization layer.

Start with a small capability-based adapter contract, shaped by the first two real integrations rather than a plugin platform:

- **Browse:** list permitted tables, views, endpoints, and other assets, with paging and source-qualified identities.
- **Describe:** return fields, native types, documented constraints, and declared relationships; preserve source-specific detail instead of flattening everything to strings.
- **Preview:** optionally return a bounded page of approved rows or a JSON response. Advertise supported filters and paging; reject unsupported operations clearly.
- **Observe:** optionally return measurements and event/trace references from an available signal source. A source without telemetry must say so.

Each response identifies workspace, environment, source, asset, and applicable catalog revision; separates source event time from fetch time; and reports truncation, freshness, coverage, and safe errors. Connection identity is not a display name. Do not merge similarly named fields or infer joins from a shared canonical label. Server-side policy determines which capabilities a caller may use.

**First two source types:**

- **PostgreSQL:** browse metadata through restricted credentials, starting with `information_schema`; add PostgreSQL-specific catalog queries only for needed native details. The standard views describe database objects but do not cover all PostgreSQL-specific features. [PostgreSQL documentation](https://www.postgresql.org/docs/current/information-schema.html).
- **REST/OpenAPI:** use the API description to discover documented operations and schemas. OpenAPI describes an HTTP interface; Serigraph must separately establish whether a permitted operation actually works. Declare supported specification versions and expose unsupported features. An API without a description gets a small explicit binding, not guessed discovery. [OpenAPI specification](https://spec.openapis.org/oas/latest.html).

For telemetry, read the organization's existing monitoring backend and reuse OpenTelemetry signal concepts where useful: metrics, traces, and logs describe different aspects of runtime behavior. This does not require building a telemetry warehouse or treating OpenTelemetry as a universal query API. [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/).

### Delivery order and gates

#### 1. Browse one real database — next

Extend the existing catalog/inspector with a PostgreSQL metadata adapter behind an approved private runtime. Search tables and columns, inspect their source definitions, and explicitly bind selected assets to existing map elements. Discovery must not flood the graph or overwrite curated mappings. Show metadata drift for review rather than silently accepting it.

Before a live connection, establish a restricted source role, approved connection target, authenticated/authorized runtime access, request timeouts and resource limits, and safe error handling. Schema names and descriptions can also be sensitive. Use synthetic fixtures in the generic repository; private source validation belongs in the approved environment.

**Done when:** a user can find a real field, identify its exact source and system, and refresh its schema from the map. Permission denial, an unavailable source, partial discovery, and an outdated snapshot are distinguishable. No record reads or agent access in this slice.

#### 2. Browse an API through the same inspector

Add one REST/OpenAPI adapter and the shared table/JSON result surface. Enable previews only for specifically approved database reads and API operations. Use field/row restrictions, bounded pages, timeouts, cancellation, and redaction before results or logs cross the runtime boundary. Merely calling something `SELECT` or `GET` is not the access-control policy.

Connection destinations, operations, specification references, and redirects must be explicitly constrained. Imported descriptions and returned content are untrusted data, never executable instructions or permission to fetch arbitrary URLs. Keep credentials server-side. Disable automatic record persistence and sharing/export of live results by default.

**Done when:** the same interaction browses one database and one API, displays an authorized bounded result, and clearly explains unavailable capabilities. Existing map navigation remains intact. No arbitrary SQL console, API request workbench, or cross-source query engine.

At this stage, Glance can show source/schema freshness and an approved preview. Comparison figures appear only when an actual comparison result is available. Do not add placeholder healthy states or invented counts.

#### 3. Make one mapped process observably live

Bind a small, useful set of source-backed signals to real nodes and handoffs: for example last successful delivery, backlog age, and error rate. Start with explicit refresh; add bounded refresh intervals and failure backoff only where the signal warrants it. Preserve measurement units, time windows, definitions, and coverage. A newly fetched response containing old data is still old data.

Keep connectivity, data freshness, and business/process health separate. A reachable API does not prove delivery; a missing event does not prove failure. Healthy/degraded judgments require explicit criteria. When telemetry is unavailable, show unknown or stale, preserve the last observation's timestamp, and link to the source evidence where authorized. Isolate caches by access scope and invalidate access when permission is revoked.

**Done when:** the map answers what is happening, where it is measured, and how recently it was observed. Controlled failures and stale feeds produce honest states. The same selected scope and time window drive the inspector's details and the map's status.

#### 4. Reconcile two sources, with Glance and Report

First validate the catalog against one authorized record across a known path. Correlate only through verified keys or trace identifiers, scoped to the correct environment and tenant. Show observed events, transformations, and source references; distinguish a declared relationship from proof that this record crossed it. Neither matching field names nor an HTTP success response proves destination persistence.

Then deliver **one record type, two sources, one bounded period**, with one shared comparison result behind Glance, exception details, and Report. This is core read-only product scope before agents. Its pilot can follow stage 2 without waiting for every live signal in stage 3, provided access, freshness, and coverage are established.

The private comparison definition specifies source identities, environment/tenant, what one row represents, keys and expected match cardinality, filters, time window, fields, normalization rules, tolerances, and any allowed delivery lag. Do not choose an authoritative source implicitly. Missing or non-unique keys produce explicit exceptions, not guessed joins or duplicated totals. Distinguish null, missing, and empty values according to the approved rules. Matching and calculations are deterministic; AI may explain findings but does not decide whether records match.

The runtime must account for paging, limits, exclusions, and source consistency. Record both sources' capture times and snapshot/watermark identifiers where available. If comparable snapshots cannot be obtained, disclose the time skew and possible changes during collection. A preview or truncated read cannot certify the whole population; mark the result partial or inconclusive and state its denominator. A record observed on only one side is not automatically proof of a failed transfer.

- **Glance:** show comparison scope, capture times, coverage, counts, and the highest-priority exceptions, with a clear path to inspect them. A partial result cannot receive an unqualified all-clear.
- **Report:** use the same result ID and include definition/rule version, source and capture references, filters/window, coverage, totals, exception details, and limits on the conclusion. Preserve the approved evidence needed to explain the result under an explicit private retention policy; do not claim reproducibility from changing live sources alone.
- **Privacy:** report generation, retention, and export need explicit authorization and redaction appropriate to their destination. Access to an on-screen preview does not grant permission to publish or persist it. Keep results, evidence, sensitive identifiers, and reports in approved private storage, outside Git; no new results in portable map exports.

PHI or other sensitive records must be handled only by the separately authorized agent/operator in an approved private environment. Treat previews, trace IDs, URLs, logs, and evidence references as potentially sensitive. Define retention and redaction there; return only approved, sanitized findings to general planning work.

**Done when:** a user can inspect one evidenced record path, run the bounded comparison, understand its exceptions in Glance, and open a report with identical counts and traceable methods. Partial reads, ambiguous matches, and time-skew limitations stay visible in both views. Neither source is changed. No synchronization, migration, automatic repair, general-purpose BI builder, or estate-wide reconciliation platform in this slice.

#### 5. Investigate with one bounded agent — only after observability

Launch a read-only investigation from a selected node or path. The run receives the same authorized observations the user can inspect, along with their provenance and freshness. Bind its run ID to stable graph identities and the relevant map revision, not screen coordinates or spawn order. Show its scope, tool activity, evidence, time/cost budget, status, and stop control on the map.

Before enabling this, require runtime-enforced resource/tool/network limits, isolated credentials, explicit data/model-destination policy, access revocation, and durable audit in approved private storage. Stop must cancel descendant work and revoke further access; it cannot promise to undo completed external actions. A prompt restriction or coarse CLI read-only flag is not sufficient containment. Do not pass ambient credentials wholesale.

**Done when:** an agent can answer one operational question with evidence, cannot access outside its approved scope, can be stopped, and leaves an inspectable run record. Reuse a proven execution harness rather than build a new agent framework. No autonomous spawning or repairs.

#### 6. Approve narrow actions, verify outcomes

Add one explicitly permitted action for one proven use case. Show exact targets, proposed change, preconditions, and likely impact before approval. Write permission is separate from read permission. Expired scope or changed preconditions requires revalidation; retries must not duplicate effects. Offer rollback only when the operation genuinely supports it.

**Done when:** a human can approve the bounded action and see independent source evidence of its result. An agent exiting successfully is not proof of a successful business outcome. Retain reviewed findings and rationale on the map without copying sensitive payloads into it.

### What exists, what does not

As inspected on September 5, 2026:

- The [catalog panel](../app/catalog.js) already searches declared objects, fields, mappings, and connections. It explicitly labels itself metadata, not live, and makes no connector calls. Extend this surface rather than replacing it.
- [Private workspaces](PRIVATE-WORKSPACES.md) separate business map storage from generic application assets. This is not authorization to access real records or send them to an AI provider.
- The [agent runner](../server/agents.js) provides a local CLI launch/event-feed starting point. It is not yet the graph-scoped, durably audited, credential-isolated operational harness described above.
- Live source adapters, authorized result previews, trustworthy process signals, real-record tracing, and the shared Glance/reconciliation/Report result remain planned. This roadmap does not claim them shipped.

### Visual clarity required for the data workflow

Uniform cards are a useful baseline, but readable relationships matter more than uniform boxes. Keep this a targeted map-legibility pass, not a visual rewrite:

- Route connections around unrelated cards and give converging paths identifiable entry points. A label must visibly belong to its own path, not appear attached to a neighboring system.
- Keep labels compact and avoid collisions with lines and cards. Reveal complete descriptions through selection/focus and the inspector; do not silently change business meaning or make detail hover-only.
- Make the selected path and its endpoints unmistakable. Subdue unrelated connections during inspection while preserving sufficient contrast and a way back to the full map.
- Keep type colors, selected state, and observed health visually distinct. Reduce grid, border, and shadow competition; do not use color alone to communicate state. Do not imply live status before evidence exists.
- Preserve pins, camera, selection, and meaningful map structure. Define acceptance on generic synthetic maps with converging edges, long labels, and keyboard selection; verify actual interaction and contrast separately from screenshot critique.

### Scope boundary and immediate handoff

The next implementation is **stage 1 only: one metadata source → existing catalog/inspector → one explicit map binding**, including the access boundary required to use it safely. Confirm the actual database type before adding a driver; PostgreSQL is the proposed first adapter, not a claim about every deployment. Use synthetic development data until the private operator supplies an approved connection and validation results.

Private setup must identify the exact environment, source owner, credential/access scope, allowed metadata/record classes, approved execution/model destinations, and retention rules. Do not put these values or real schemas in this repository. The record-validation handoff remains separate; this plan does not authorize a general-purpose agent to retrieve sensitive data.

Defer additional database families, GraphQL, connector marketplaces, arbitrary query builders, a telemetry storage platform, workflow scheduling, multi-agent orchestration, broad automated remediation, and unrelated visual/architecture rewrites. If something outside the slice is needed, flag it and obtain direction unless it truly blocks the approved work. Neither a roadmap stage nor an old backlog item is permission to implement it without a scoped request.

---

## Historical roadmap — preserved, not the current delivery order

The framing, priorities, and status notes below describe earlier planning. The September 2026 direction above supersedes their priority order and separates portable map declarations from observed runtime truth. Historical competitive claims and release notes have not been revalidated for this update.

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
