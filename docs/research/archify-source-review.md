# Archify and Serigraph: usefulness comparison

Reviewed 2026-09-09. Scope: Archify public source and the current Serigraph implementation at `8ff0100`, including its working-copy roadmap. No third-party code was installed or executed, no tests were run, and no private business maps or live systems were inspected. This is a source-backed assessment, not a browser bake-off. Recommendations below are proposals, not implementation approval or a replacement delivery order.

## Recommendation for Serigraph

Serigraph does not need to become Archify. It needs to make a persistent, editable map as easy to understand, question, and explain as Archify makes a generated artifact. Preserve YAML, shared elements, the catalog, direct editing and the contextual inspector. Add a focused explanation and verification layer around them; do not introduce a second authoritative JSON model or another diagram application.

### What already exists

- Typed, validated, comment-preserving YAML with Process and Freeform modes; nested scopes and reusable Freeform elements. [Model](../../shared/model.js), [format](../FORMAT.md).
- Direct node/connection editing, pinned positions, search, deep links, review notes, history and reviewed AI edits. [Workbench](../../app/workbench.js), [controller](../../app/controller.js), [AI proposal UI](../../app/ui.js).
- Light/dark themes, minimap, SVG/PNG downloads, and self-contained read-only HTML. These are foundations to improve, not missing features. [Canvas export](../../app/canvas.js), [image export](../../app/workbench.js), [standalone export](../../server/export.js).
- A declared data catalog and a tightly bounded public GitHub observation pilot. Neither is a general live database/API explorer. [Catalog](../../app/catalog.js), [pilot scope](../GITHUB-PILOT.md).

### The material gaps

| Outcome | Current Serigraph evidence | Required change |
| --- | --- | --- |
| Read connections without untangling the canvas | `routeAutomaticEdges` handles clear horizontal fan-in corridors; deliberately falls back for obstructions, fan-out, bundles and custom paths. Some geometry tests exist. | Extend routing and label-clearance checks selectively. Diagnose collisions, ambiguous attachment and clipping without moving pins. Use a strict publish/export gate for accepted artifacts, not a rule that prevents saving an unfinished working map. |
| Explore a systems map | `visibleToolGroups` hides the path probe in Freeform. Existing BFS searches one current scope. | Reuse the probe for Freeform, add upstream/downstream reach and clearly identified exact paths. Preserve scope and distinguish graph declarations from observed transfers. Repeated placements and group links must not manufacture connectivity. |
| Ask what the map means | `server/chat.js` explicitly rejects non-editing requests. | Add an answer-only path grounded in selected map facts and approved evidence. Answers cite objects and state unknowns; proposed modifications remain a separate Apply workflow. This need not launch operational agents. |
| Inspect why a claim is believed | Inference comments, links, planning evidence strings and review notes exist, but not revision-verified source/claim records. | Add a small structured evidence reference contract: source/revision or capture time, relevant location, assertion and review state. Distinguish reference existence, claim support, coverage and runtime observation. Reuse the mapping skill and existing validated-draft flow for source-to-map creation. |
| Explain one useful scenario and return to it | Present uses topological order of the current scope. URL state identifies map/scope/node, not named paths, lenses or chapters. | Add named views referencing existing objects and selected paths, then explicit short story chapters. Preserve camera/selection on exit. Export the chosen explanation with context; use finite, reader-triggered motion, never pretend it is observed traffic. |
| Review a meaningful change | History stores up to 30 local source snapshots; AI proposals show a summary and Apply. | Compare two validated map revisions: added/removed objects, changed relationships/owners/claims, separately from movement/routing. Reuse existing review/save/conflict handling. This is map change review, not record reconciliation or proof of safe deployment. |
| Match all diagram semantics literally | Process and Freeform represent workflows and system/data relationships, but are not dedicated sequence or lifecycle models. | If repeated use requires it, add explicit message order/returns or state-transition/event semantics and focused renderers. These cannot safely be inferred from a generic graph or supplied by a new color preset. Defer until a concrete use case justifies them. |

Local implementation seams: [routing](../../app/layout.js), [probe and Freeform tool visibility](../../app/workbench.js), [AI edit-only contract](../../server/chat.js), [provenance](../../shared/provenance.js), [presentation](../../app/present.js), [URL state](../../app/routes.js), [history](../../app/controller.js), [schema-only CLI validation](../../tools/validate.mjs), [existing fan-in tests](../../tests/position.test.js).

### Small foundations before broad features

1. **Connection identity.** Generic map edges normalize without a stable ID and many interactions use scope plus array index. Named paths, evidence anchors and semantic deltas need stable connection references, including parallel edges. Design a backward-compatible contract and reviewed migration; do not use endpoint names or array positions as durable identity. Catalog flows already have IDs and must remain distinct from visual edges.
2. **Pure scoped graph queries.** Move the existing path calculation behind a small reusable, deterministic query boundary when adding reach. Explicitly distinguish a shared element from its placement, and structural ownership from transfer edges. Start in one scope; require explicit semantics before crossing scopes.
3. **View definitions, not copied maps.** Saved explanations should reference canonical objects and connections. Keep presentation choices separate from structural facts and runtime observations. Sequence/lifecycle views may need additional authored facts, not just a projection of existing edges.
4. **Artifact quality, not architecture truth.** Extend the current validator with bounded render diagnostics and last-good delivery. A geometry pass does not certify that the architecture description is correct. Keep unfinished map editing permissive and show warnings; enforce the agreed quality contract at explicit delivery.

### Proposed delivery sequence

This is a bounded optional parity track. The current [roadmap](../ROADMAP.md) still names one approved metadata source as the next implementation slice; choosing this track first requires a separate scoped decision.

1. **One excellent systems-map inspection loop.** Improve troublesome connection routing; enable a scope-safe Freeform probe and upstream/downstream inspection in the existing inspector. Reuse current selection and camera behavior. Gate: on a synthetic branching/converging map, a user can identify an exact declared path, inspect each connection, handle cycles/no-route cases, then return to the unchanged canvas. Check keyboard access, long labels, pins and reload.
2. **Explain and retain.** Add structured evidence references and answer-only map questions, followed by one named view/story using those same objects. Gate: a reader can distinguish supported statements from inference, follow an explanation, close it and resume the exact map context. No sensitive evidence leaves approved storage or goes to an unapproved model.
3. **Deliver and review.** Add canonical-versus-contextual export semantics and geometry acceptance receipts, then a two-revision semantic diff once connection identities are stable. Gate: delivery matches the accepted revision; invalid candidates preserve the last accepted artifact; moves/reroutes do not masquerade as semantic change; proposals never apply themselves.
4. **Add only needed diagram specializations.** A genuine sequence or lifecycle mode is additional scope, not a prerequisite to making the current systems workspace highly useful. Video export, brand-mark collections and multiple visual presets are lower priorities than the above loop.

The operational differentiator remains the existing roadmap: one authorized metadata source, a second source type, honest observations, then bounded reconciliation with a shared Glance/Report result. Archify parity does not require building that whole stack first, and animations or source links must not be presented as a substitute for it.

### Practical acceptance benchmark

Use the same public or synthetic 8–12-component system in both products, with a fork, a convergence, one cycle, a disconnected item, parallel connections and long labels. Judge whether a new reader can identify the main flow, explain one dependency, inspect its supporting source, recognize what is unknown, follow a saved explanation and share a readable artifact. Add one edited revision to test change review. These are proposed checks, not results obtained in this assessment. Serigraph should additionally preserve editable shared facts, pins and context across the journey.

No framework rewrite, broad connector platform, separate graph store, automatic source correction or Archify installation is recommended by this assessment. Borrow small contracts and algorithms selectively after compatibility review; the Archify viewer is not a drop-in editor component.

## Archify source evidence

Snapshot: default-branch commit [`10722002bb8777ecb639d93c49586fae4adf3ae4`](https://github.com/tt-a1i/archify/commit/10722002bb8777ecb639d93c49586fae4adf3ae4), committed 2026-09-08. Package version is `2.17.0-dev.1`; the roadmap explicitly calls this a development line, not a stable release. “Implemented” below means present in this source snapshot, not independently exercised or verified in a released ZIP. [Package](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/package.json), [roadmap](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/ROADMAP.md).

## Bottom line

Archify is an agent-authored diagram compiler plus a substantial standalone reader, not merely a diagramming prompt. Its useful patterns are deterministic artifact acceptance, revision-pinned source references, explicit authored-graph exploration, and change classification that separates semantic changes from geometry. None of those establishes live system behavior. The following five implementation seams were inspected, alongside concrete test assertions.

## Five implementation seams

### 1. CLI: typed modes and last-good delivery

[`archify/bin/archify.mjs`](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/bin/archify.mjs) dispatches Architecture, Workflow, Sequence, Data Flow, and Lifecycle to separate renderers. `deliver` freezes input bytes into a same-directory staging snapshot, renders and checks a candidate, then renames only the accepted artifact into place. Receipts include specification/artifact SHA-256, byte counts, check counts, and composition findings. Failed artifact checks preserve the previous output. Structured diagnostics identify a rule, subject, evidence, and supported fixes; this is not an automatic repair service. See especially `commandDeliver`, lines 821–1140.

### 2. Geometry: deterministic routing and quality gates

[`geometry.mjs`](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/renderers/shared/geometry.mjs) implements edge/rectangle intersection, label-to-route clearance, crossings, ambiguous shared corridors, border runs, route-segment budgets, and automatic endpoint spreading. `cleanFlowProblems` rejects routes through unrelated opaque nodes independent of quality profile. Stricter composition gates are profile-dependent; for example, label-route clearance is gated by `showcase`. `automaticPortSpread` sorts by counterpart position with stable identity tie-breakers and skips explicit routing controls. See lines 340–406, 901–949, and 1214–1272.

This is bounded layout automation, not arbitrary graph auto-layout. Importantly, it is also not entirely manual: the documented Workflow v2 compiler solves measured logical columns and intrinsic bounds, preserves hard pins, and reports infeasible constraints. Optional semantic checks declare permitted roots/terminals and required edges/paths; they check authored topology, not whether it matches reality. These workflow details were checked against the [renderer contract](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/renderers/workflow/README.md), not independently audited end-to-end in its solver.

### 3. Repository evidence: verified references, not verified claims

[`repository-evidence.mjs`](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/renderers/shared/repository-evidence.mjs) supports optional Architecture component `sources` plus repository metadata. It requires a full commit SHA, matching local Git root/origin, an available commit, valid repository-relative paths, existing blobs, and in-range line references. GitHub/Gitee web links are revision-pinned; `local-only` retains local verification without generated web links, including for supported internal origin forms. Ordinary diagrams need no source evidence.

Critical boundary: these checks establish reference identity and existence. They do **not** establish that the cited code entails a node label, proves an edge, covers the whole repository, or matches deployed behavior. The verifier reads Git objects; it is not a source-discovery or semantic-entailment engine. Private source metadata still needs its own sharing policy even when links are disabled.

### 4. Shared viewer: focus, reach, routes, lenses, stories, exports

[`assets/template.html`](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/assets/template.html) contains the reader runtime, not separate applications for each mode:

- **Focus/search:** stable semantic IDs, node labels, contextual facts and source references. The [viewer contract](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/references/viewer-runtime.md) also documents URL-restorable focus and progressive reading detail.
- **Reach:** breadth-first upstream/downstream traversal, minimum depths, cycle handling, and deduplicated relationship fragments (`computeReachability`, lines 7597–7645). It operates on the artifact's authored graph, not live dependencies.
- **Routes:** a shortest directed path by hop count with exact selected edge references (`shortestDirectedPath`, lines 13229–13255). No route is inferred from visual proximity; this is not enumeration of every possible path.
- **Lenses:** one selected semantic kind highlights touching relationships; two kinds count/highlight authored relationships in each direction (`applySelection`, lines 14326–14395). These are relationship counts, not measured traffic volumes.
- **Stories:** authored `meta.views` chapters, not a generated topological tour. `storyStep` classifies adjacent stops as forward, reverse, multiple, or grouped/no direct edge (lines 9826–9863). Chapter order does not manufacture connectivity. The contract limits chapters to five and playback to reader-started, bounded motion.
- **Exports:** canonical SVG, raster and WebM dispatch is implemented (`runExport`, lines 6953–6998). Canonical clones strip focus/route/story/lens overlays; route/reach share cards are explicitly contextual derivatives. The contract lists PNG/JPEG/WebP, dual-theme SVG, trace-enabled WebM, and 1200×630 cards. Browser/clipboard/recording support can fail; export success is not a visual-quality or source-truth certificate.

### 5. Architecture Delta: identity-first snapshot comparison

[`architecture-delta.mjs`](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/delta/architecture-delta.mjs) canonicalizes authored Architecture v1 snapshots and classifies additions, removals, semantic/topology changes, evidence changes, moves and reroutes. Presentation changes are separate. Comparison requires stable component/connection IDs, at least one shared component ID, and unambiguous boundary identity derived from `kind + label`; it rejects mismatched repositories instead of guessing identity. See lines 59–76, 83–167, and 232–335.

The CLI validates both snapshots and produces Before / Delta / After HTML plus a machine receipt. Proof level is `authored` unless both sides have verified pinned evidence. This is a finite, enumerated-field comparator—not a generic code diff, observed-data reconciliation, causal model, risk assessment, or merge-safety decision. Its receipt's `completeness: complete` describes the comparison contract, not completeness of system discovery.

## Concrete tests inspected, not run

- [Authored reachability tests, lines 44–92](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/test/authored-reachability.test.mjs#L44-L92): five-mode emission, cycle-safe BFS depths, duplicate-fragment handling and export cleanup. Several assertions inspect generated/source strings; this is not equivalent to browser execution.
- [Repository evidence tests, lines 377–409 and 518–565](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/test/repository-evidence.test.mjs#L377-L409): pinned links/receipt assertions; wrong origin, escaping/missing paths and impossible lines are rejected while preserving prior output.
- [Delta tests, lines 28–69 and 129–148](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/test/architecture-delta.test.mjs#L28-L69): semantic versus geometry classifications, including mixed changes; missing relationship IDs and unrelated component identities fail closed.

## Creation workflow, scope and possible reuse

The [skill](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/archify/SKILL.md) asks an agent to choose one mode, read its schema/example, author compact JSON, validate, make narrowly diagnosed repairs, and deliver. It separates deterministic acceptance, browser evidence, and perceptual review. Mermaid input is interpreted by the agent into new IR; it is not an automatic Mermaid parser. Hosted sharing, general-purpose auto-layout, and WYSIWYG editing are outside the documented current scope. [README scope](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/README.md#reference-and-scope).

Plausible reuse options for the parent to assess—not implementation authorization or a prescribed sequence:

1. Adopt the **acceptance protocol**: exact input/output identity, last-good preservation, structured repair receipts, and separate browser/perceptual evidence.
2. Adapt selected **geometry predicates** and stable endpoint spreading behind existing layout behavior; do not replace a camera/layout model wholesale.
3. Borrow **reference verification semantics**, visibly distinguishing “reference checked” from “claim supported,” coverage, and runtime observation.
4. Borrow **authored query/story contracts** and canonical-versus-contextual export separation before duplicating viewer UI or export formats.
5. Consider **semantic delta classification** only where stable identities and explicit compared-field scope already exist; do not call it operational reconciliation.

Direct code reuse would need compatibility review. The viewer is a large shared HTML runtime, not an obviously drop-in UI library. The repository uses the [MIT license](https://github.com/tt-a1i/archify/blob/10722002bb8777ecb639d93c49586fae4adf3ae4/LICENSE); preserve applicable notices and review bundled third-party assets separately. No assessment here establishes released-package parity, current CI success, security certification, production reliability, or suitability for private runtime data.
