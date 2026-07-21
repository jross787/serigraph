# Serigraph Product Documents v1.1

- Status: Shipped
- Owner: Product & Engineering
- Last updated: 2026-07-18
- Canonical product graph: `maps/serigraph-prd.yaml`
- Canonical roadmap graph: `maps/serigraph-roadmap.yaml`

## Executive summary

Serigraph Product Documents turns a product plan into a living, inspectable graph. The same YAML source renders as a navigable map, professional PRD, outcome-led roadmap, deterministic readiness audit, prioritization portfolio, Markdown document, presentation, and portable standalone application.

The release builds on Serigraph's strongest differentiator: one compact source that humans, the application, and software agents can all read and write. Product intent does not live beside the map. It lives in the map, with stable identity and explicit relationships to evidence, objectives, requirements, proof, metrics, risks, and releases.

## Opportunity

Product truth usually fragments across narrative documents, diagrams, spreadsheets, tickets, research repositories, status decks, and individual memory. Each tool captures a useful slice, but no artifact can answer the complete review question:

> Why are we doing this, what exactly are we committing to, who owns it, when does it matter, what depends on it, how was it prioritized, and what proves it worked?

Generic diagram products make the visual layer flexible. Document products make prose flexible. Work trackers make execution state flexible. Serigraph's opportunity is to make the operating logic itself structured and portable, then generate the most useful reading surface for each audience.

## Product vision

Serigraph is the clearest path from observing how work actually happens to designing, shipping, and measuring a better operating system.

Product Documents establishes the planning foundation for that vision:

```text
Evidence → Problem → Objective → Requirement → Proof → Release → Metric
```

Every item is a stable graph node. Visible map edges explain the local narrative. Typed relations provide traceability across nested scopes without forcing every relationship onto the canvas.

## Users and jobs to be done

### Primary users

| User | Job | Current friction | Desired outcome |
|---|---|---|---|
| Product manager | Shape a coherent release and earn alignment | PRD, diagram, roadmap, and tickets drift apart | One product contract with traceable decisions and proof |
| Automation lead | Translate observed work into automation scope | Discovery findings are hard to connect to product and delivery choices | Map operational truth directly to requirements and measurable value |
| Engineer | Understand exactly what to build and why | Acceptance, dependencies, and rationale are scattered | Navigate from a requirement to context, tests, risks, and release |
| Executive reviewer | Assess sequence, risk, and expected value | Status decks hide source detail and uncertainty | Read a calm portfolio view and drill into any claim |
| Product operations | Improve planning quality and governance | Completeness is checked manually and inconsistently | Deterministic, inspectable readiness rules and durable artifacts |

### Jobs to be done

- When defining a product change, help me express it as a testable contract connected to an objective and evidence.
- When reviewing a roadmap, help me distinguish committed work, emerging bets, blockers, and unscheduled ideas.
- When priorities change, help me understand which requirements, proof, metrics, and milestones are affected.
- When publishing the plan, help me produce a portable artifact without reconciling another source.
- When a plan is incomplete, show the exact structural gap without inventing product facts.

## Goals

1. Make a professional PRD readable, testable, and presentable directly from a Serigraph graph.
2. Provide a useful roadmap over the same source with transparent priority inputs.
3. Establish cross-scope traceability as a stable product primitive.
4. Make release-readiness gaps inspectable and actionable.
5. Publish durable product documentation without a cloud dependency.
6. Preserve complete compatibility with existing operations maps.

## Non-goals

- Recreating a full rich-text editor.
- Replacing Jira, Linear, or GitHub as an execution tracker.
- Real-time multiplayer, user identity, notifications, or cloud permissions in v1.1.
- Resource-capacity planning or a full Gantt scheduler.
- Importing every general-purpose diagram format in v1.1.
- Using AI-generated evidence as product truth.
- Scoring factual product quality. Readiness evaluates structure only.

## Product principles

1. **The graph is the source.** Views never create a shadow planning model.
2. **Proof over polish.** Every important requirement can point to evidence and acceptance.
3. **Progressive disclosure.** The canvas stays calm; cross-scope relationships appear when useful.
4. **Explainable intelligence.** Scores and audits show their inputs and rules.
5. **Local ownership.** Product documents remain plain YAML and portable HTML/Markdown.
6. **Backwards compatibility.** Product features are optional; process maps behave exactly as before.

## Release scope

### Shipped capability 1 — Structured product-document model

Optional `document`, `planning`, and `relations` fields extend the public YAML contract.

Requirements:

- Document metadata supports kind, version, summary, owner, status, update date, audience, goals, non-goals, and success metrics.
- Planning metadata supports semantic type, status, priority, phase, target, acceptance criteria, evidence, risk notes, dependencies, and RICE inputs.
- Typed relations connect any two stable nodes across nesting levels.
- Every enum, number, dependency, and relation target is validated with an actionable path and line number.
- Existing maps without product metadata remain valid and render as process maps.
- Edits, templates, comments, undo/redo, local revisions, live reload, and standalone export preserve product metadata.

Acceptance:

- Legacy fixture behavior is unchanged.
- Invalid confidence above 100 or effort at/below zero is rejected.
- Missing relation and dependency targets are rejected.
- Template insertion rewrites renamed relation/dependency IDs and preserves every planning field.

### Shipped capability 2 — Graph-backed PRD view

The Brief view generates a professional reading surface from the graph.

Requirements:

- Present executive summary, document state, owner, audience, goals, non-goals, success metrics, problem narrative, objectives, metrics, requirements, decisions, and risks.
- Show requirement owner, status, priority, target, acceptance count, acceptance criteria, RICE score, and related items.
- Navigate any requirement or relation to its exact map node.
- Clearly state when expected content is absent.
- Allow document-level metadata to be edited and saved visually.

Acceptance:

- The Serigraph PRD reads coherently without opening raw YAML.
- Clicking a nested relation lands at the exact related node and scope.
- Desktop and mobile layouts avoid clipped primary actions and unintended horizontal overflow.

### Shipped capability 3 — Outcome-led roadmap

The Roadmap view creates a portfolio over every eligible planning node.

Requirements:

- Group work into Now, Next, Later, named target periods, and Unscheduled.
- Display status, priority, owner, description, and full-precision RICE order.
- Combine status, priority, owner, and text filters.
- Preserve empty lanes so roadmap shape remains understandable under filters.
- Make blocked and shipped work visibly distinct.
- Locate the exact map node or open its priority editor from each card.

Acceptance:

- The checked-in roadmap contains at least ten future capabilities and all three standard horizons.
- Filter counts distinguish visible from total items.
- Equal scores resolve deterministically by priority, label, and stable ID.

### Shipped capability 4 — Cross-scope traceability and readiness

Typed relations and deterministic rules expose whether the product story holds together structurally.

Requirements:

- Support `informed-by`, `supports`, `satisfies`, `depends-on`, `validated-by`, `measured-by`, `mitigates`, `blocks`, and `delivers` relations.
- Show relation chips in the Brief view and preserve them in templates and exports.
- Audit document metadata, required planning types, ownership, acceptance criteria, priority, schedule, evidence, RICE completeness, objective traceability, metric links, risk mitigation, blockers, and dependency cycles.
- Return stable issue code, severity, title, explanation, and source node.
- Classify a document as Draft, Reviewable, or Ready.
- Exclude ordinary process maps from product-readiness scoring.

Acceptance:

- Complete and incomplete fixtures produce deterministic scores and issue sets.
- Fixing one issue removes that exact issue on refresh.
- Audit copy explicitly distinguishes structural readiness from factual validity.

### Shipped capability 5 — Transparent RICE prioritization

Requirements:

- Freeze the formula as `(reach × impact × confidence/100) ÷ effort`.
- Treat incomplete input as unscored.
- Reject confidence outside 0–100, negative values, and effort at/below zero.
- Separate display rounding from ranking precision.
- Preview the score while editing and persist all inputs to YAML.
- Use deterministic tie-breaking.

Acceptance:

- No valid interaction can display NaN or Infinity.
- Saving a score immediately updates the roadmap order.
- Undo restores the prior inputs and order.

### Shipped capability 6 — Product-document publishing

Requirements:

- Download a clean Markdown PRD containing document metadata, goals, metrics, requirements, acceptance criteria, evidence, risks, and readiness issues.
- Preserve all product views and navigation in standalone HTML.
- Keep user-authored content text-safe.
- Include the new product modules in the self-contained export bundle.

Acceptance:

- The generated Markdown can be reviewed in GitHub, Notion, email, or any plain-text workflow.
- Standalone HTML has no unresolved modules and exposes no editing controls.

### Shipped capability 7 — Serigraph-native dogfood artifacts

Requirements:

- Include a complete Serigraph PRD as an actual map.
- Include a roadmap with more than ten concrete capabilities across Now, Next, and Later as an actual map.
- Include a reusable product-requirement slice in the template library.
- Make the artifacts validate through the same public CLI as customer maps.

Acceptance:

- Map switching exposes the PRD and roadmap immediately.
- Artifact tests enforce minimum roadmap count and shipped capability identity.

## Functional requirements

| ID | Requirement | Priority | Evidence |
|---|---|---:|---|
| FR-01 | Existing process maps load with no migration | Must | Legacy parser and UI regression suite |
| FR-02 | Product metadata parses into a normalized model | Must | Model tests |
| FR-03 | Visual edits persist product metadata without losing comments | Must | Edit round-trip tests |
| FR-04 | Cross-scope relations validate and navigate | Must | Parser, artifact, and browser checks |
| FR-05 | Brief view generates a complete product narrative | Must | Product-document tests and dogfood review |
| FR-06 | Roadmap groups and filters planning items deterministically | Must | Roadmap unit tests and browser checks |
| FR-07 | Readiness returns stable, inspectable issues | Must | Audit unit tests |
| FR-08 | RICE calculation never emits non-finite values | Must | Prioritization unit tests |
| FR-09 | Markdown and portable HTML preserve product content | Should | Export tests |
| FR-10 | Deep links continue to identify the exact source node | Must | Existing navigation plus browser checks |
| FR-11 | Product views support standalone read-only use | Should | Standalone browser verification |
| FR-12 | Product artifacts validate through the public CLI | Must | Release validation command |

## Data contract

The schema is fully optional and backwards-compatible:

```yaml
document:
  kind: process | prd | roadmap
  version: "1.1"
  status: draft | discovery | planned | in-progress | blocked | validated | shipped | archived
  owner: Product
  updated: "2026-07-18"
  summary: A concise executive statement.
  audience: []
  goals: []
  nonGoals: []
  successMetrics: []

nodes:
  - id: stable-id
    type: process
    label: Visible shape label
    planning:
      type: objective | problem | requirement | milestone | metric | risk | decision | research | release
      status: planned
      priority: must | should | could | wont
      phase: now | next | later
      target: 2026-Q4
      acceptance: []
      evidence: []
      risks: []
      dependsOn: []
      rice:
        reach: 100
        impact: 3
        confidence: 80
        effort: 4
    relations:
      - to: another-stable-id
        type: supports
```

The five visual node types remain unchanged. `planning.type` supplies product meaning without fragmenting the visual language or breaking process semantics.

## Primary experience flows

### Author and review a requirement

1. Open or create a PRD map.
2. Add a node; product-planning fields appear automatically.
3. Define planning type, owner, priority, status, phase, acceptance, evidence, dependencies, and relations.
4. Review the node in Brief view.
5. Locate related objective or proof directly on the map.
6. Open Audit and resolve structural gaps.

### Prioritize the roadmap

1. Open Roadmap view.
2. Filter by owner, status, priority, or text.
3. Open the score editor on an item.
4. Enter RICE inputs and inspect the live formula result.
5. Save; the card reorders using full precision.
6. Use undo if the priority change should be reverted.

### Publish the product contract

1. Review Brief and Audit.
2. Download Markdown for prose-first review.
3. Download standalone HTML for an interactive read-only artifact.
4. Recipients navigate the product graph without the original repository.

## UX requirements

- Product views must conform to the existing Quiet Instrument design language: calm hierarchy, compact controls, warm reading surface, restrained color, and utilitarian detail.
- View switching must be obvious, reversible, and free of document mutations.
- Product cards must expose source-node identity and one-click map navigation.
- Missing content uses explicit empty copy rather than placeholder invention.
- Roadmap horizontal scrolling is intentional; other layouts must not overflow horizontally.
- All filters, card actions, dialogs, and view controls are keyboard reachable.
- Reduced-motion preferences remain honored.
- Mobile target viewport is 390 × 844.

## Non-functional requirements

### Performance

- Parsing, roadmap building, RICE scoring, and readiness analysis are deterministic and linear or near-linear in graph size.
- The 1,000-item domain analysis smoke test should complete within 100 ms on a contemporary development machine.
- Filtering reuses the normalized model and does not write to YAML.

### Reliability

- The existing atomic mutate → validate → save → refresh pipeline remains the only write path.
- A failed save restores the last valid source.
- Product views never maintain a second authoritative state.

### Security and content safety

- User content is inserted as text nodes, not interpreted HTML.
- Markdown generation removes raw angle brackets and escapes Markdown control characters to avoid accidental embedded markup.
- Relation and dependency targets must resolve to existing stable IDs.
- No new network service, credential, analytics SDK, or third-party runtime is introduced.

### Accessibility

- View navigation uses named buttons and `aria-pressed` state.
- Audit filters and readiness progress are labeled.
- Roadmap card actions are keyboard reachable and retain visible focus.
- Dialogs identify their title, modal state, and initial focus.
- Color is never the only indicator for status or severity.

## Analytics and success measures

The release does not introduce telemetry, so initial success is evaluated through structured usability sessions and artifact quality:

| Measure | Target | Method |
|---|---:|---|
| Time to understand release purpose | < 5 minutes | Moderated review |
| Time to answer why/what/who/when/proof for one requirement | < 30 seconds | Task test |
| Shipped requirements with owner, priority, acceptance, and objective relation | 100% | Readiness audit |
| Active roadmap items with owner, status, target, evidence, and RICE | ≥ 90% | Roadmap audit |
| Existing process-map regression | 0 failures | Automated suite |
| Product artifact validity | 100% | CLI validation |

## Test and release strategy

### Automated gates

- Parser coverage for document metadata, planning semantics, typed relations, validation boundaries, and legacy compatibility.
- Comment-preserving edit coverage for planning fields, relations, document metadata, clearing, key order, and template ID rewrites.
- Pure tests for RICE formula, display, roadmap grouping/filtering/order, Markdown generation, readiness issues, dependency cycles, and process-map exclusion.
- Artifact tests for the real Serigraph PRD, roadmap, minimum roadmap item count, and shipped capability set.
- Standalone export tests for every new module and embedded product source.
- Public CLI validation for every checked-in map and template.

### Browser gates

- Open PRD, switch among Map, Brief, Roadmap, and Audit.
- Navigate from a requirement/relation/audit issue to the exact map node.
- Edit product metadata and RICE; reload and verify persistence.
- Combine and reset roadmap filters, including an empty result.
- Exercise desktop and 390px mobile layouts.
- Verify standalone product views are read-only.
- Check console for errors and inspect light/dark surfaces.

### Release decision

Release only when:

1. Every automated test passes.
2. Every checked-in map/template validates.
3. The real PRD and roadmap open and function locally.
4. All five named killer features have direct acceptance evidence.
5. No P0–P2 visual or interaction defect remains in the core product-document flow.

## Rollout

1. Ship product fields as optional schema additions.
2. Include the dogfood PRD and roadmap as discoverable sample maps.
3. Preserve process-map default behavior and Map view on load.
4. Use five design partners to test comprehension and authoring before prioritizing collaboration or integrations.
5. Review readiness rules after real use; add checks only when they improve a concrete planning decision.

## Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Structural completeness is mistaken for product truth | Teams optimize for the score | Explicit language, inspectable rules, evidence fields, no AI completeness claim |
| Planning metadata makes YAML intimidating | Local-first advantage weakens | Optional fields, sensible UI defaults, templates, concise format docs |
| Generic diagram parity distracts from the wedge | Roadmap loses differentiation | Prioritize capture, live truth, traceability, automation, and outcomes |
| Cross-scope relations become visual noise | Map loses calmness | Keep relations out of layout and reveal them contextually |
| Whole-file last-write-wins limits collaboration | Conflicting edits can overwrite | Keep v1.1 local-first; make cloud identity/conflict handling an explicit later platform project |
| Dogfood artifacts become stale | Product documentation loses credibility | Artifact tests and release checklist enforce current shipped IDs and roadmap count |

## Roadmap

The authoritative roadmap is `maps/serigraph-roadmap.yaml` and is designed to be read in Serigraph's Roadmap view.

### Now — shipped in v1.1

1. Product-document schema
2. Living PRD view
3. Roadmap portfolio lanes
4. Cross-scope traceability
5. Product readiness gate
6. RICE prioritization lab
7. Product-document publishing

### Next — observe and connect

8. Process Capture
9. Live operational data
10. Assigned review and approvals
11. Decision records
12. Change impact analysis
13. Visual version comparison
14. Jira, Linear, and GitHub synchronization

### Later — learn and govern

15. AI Product and Process Architect
16. Operational scenario simulation
17. Portfolio roll-up
18. Outcome observability
19. Enterprise governance
20. Diagram and document interoperability

## Open product decisions

- Whether typed relations should eventually appear as an optional canvas overlay or remain contextual only.
- Whether roadmap phase should remain free text beyond Now/Next/Later or gain a stricter planning-period model.
- Whether RICE should be one available prioritization model among several rather than the permanent default.
- Which live system connector best validates the next wedge: CRM, work tracker, spreadsheet, or analytics source.
- How local-first documents should participate in future team identity and conflict resolution without sacrificing file ownership.
