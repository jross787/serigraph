# Serigraph: a precise workspace for thinking in maps

Status: proposal only. No implementation is authorized by this document.

Primary audience: Joe, building and reasoning through maps. Client presentation is a secondary benefit, not the organizing principle.

## The product promise

Open Serigraph, get an idea out of your head, see how it connects, investigate what is uncertain, and leave with a clearer next move. When you return, your reasoning is still there.

The ambition is a substantial improvement in clarity, fluency, and accumulated knowledge. “10X” is a directional ambition, not a verified productivity claim.

The core loop:

**Capture → connect → investigate → compare → decide → retain what you learned.**

Serigraph already has maps, hierarchy, direct editing, inference review, economics, AI, history, and document views. This plan makes those capabilities reinforce one another before expanding the product surface.

## What the current experience tells us

Read-only inspection covered Projects, the Atlas order-flow canvas and selected-node detail, its Brief view, and the Meridian map with 104 total nodes including nested content. Source review included the brand, design principles, roadmap, and current application shell. This was a desktop inspection, not a complete responsive or accessibility audit.

| Observation | Design implication |
| --- | --- |
| Six views, two rows of controls, contextual actions, an inspector, minimap, and economics compete for attention. | Give each control a clear home and reveal secondary capabilities in context. |
| Long map names truncate while view switches and tools occupy much of the top bar. | Identity and orientation must win space before secondary commands. |
| Atlas Brief displays empty PRD sections and “Not applicable” readiness. | Views should understand the document's purpose; a process map needs a process brief, not an empty product template. |
| A selected process emphasizes “Design automation” even when basic facts are incomplete. | Exploration and understanding should precede a proposed intervention. |
| The canvas uses small text, a conspicuous dotted background, repeated badges, and many edge labels. | Establish visual priority and reveal detail by zoom, selection, and chosen lens. |
| Projects emphasizes containers, node counts, status dots, and repeated Trash actions. | Help the user resume a thought, not just locate a file. |
| The app's indigo chrome and old mark differ from the documented emerald/Stack identity. | Bring the app into the current brand without importing marketing-page effects. |

## 1. Make the map the center of gravity

Use one persistent shell:

```text
Project / Map title       Perspective: Map ▾       Search / commands       Saved
──────────────────────────────────────────────────────────────────────────────
Collapsible outline       Canvas / chosen perspective       Context inspector
and saved lenses          Small creation tool group         One active panel
                          Minimal navigation controls       at a time
```

- One perspective selector replaces the six equally prominent tabs. Keep frequent perspectives easy to reach and keyboard accessible; do not simply bury capabilities.
- Make Brief meaningful for each document kind. Keep product-specific Roadmap and Audit available where applicable; offer explicit enablement elsewhere rather than walls of empty metrics.
- Keep Agents available as a workspace utility. A map-related run should also be reachable from its relevant node or proposal. Do not pretend unrelated repository runs belong to the current map.
- Use one contextual panel region for detail, review, or AI. Support a deliberate pin/split later only if real use warrants the lost canvas area.
- Preserve the existing Process/Freeform distinction without making structural mode switching an everyday visual priority.
- Retain map scope, selection, and camera on perspective changes. Opening an inspector must keep the selected item visible with the smallest necessary pan, not repeatedly reframe the whole map.
- Collapse navigation and secondary tools on narrow laptop windows before shrinking labels. On phones, prioritize reading, search, and quick capture; do not promise full diagram editing parity.

## 2. Give the app a distinctive, restrained visual language

Direction: a precise instrument, with generous working space and quiet controls.

- Adopt the documented Stack mark and emerald interaction accent. Emerald identifies action/selection, amber identifies uncertainty, red identifies destructive action or error. Preserve restrained node-category colors with non-color cues.
- Use neutral graphite and off-white surfaces with deliberately designed light and dark tokens. Check the accent's contrast in each theme rather than reusing a bright color everywhere.
- Use locally bundled Geist for interface text, with clear size/weight hierarchy; reserve Geist Mono for identifiers, figures, and source. Keep display typography largely out of working controls.
- Establish a small spacing, border, radius, icon, and elevation system. Remove competing outlines, arbitrary rounded containers, and redundant separators.
- Quiet the grid; prioritize readable node titles and paths. Keep labels concise and reveal secondary metadata on selection or in a lens.
- Make motion explain continuity: gentle drill-in, path focus, placement feedback, and panel transitions. Respect reduced motion. Avoid glass, decorative particles, ambient animation, and large marketing headings inside the app.

This follows the app-specific boundaries in `BRAND.md`, not the site's full visual treatment.

## 3. Make building feel like thinking

Extend existing authoring and search rather than adding another editor.

- Add a lightweight capture surface: jot a thought or paste a short outline without completing a form. Retain drafts with the map, clearly separate from established facts; deliberately promote them into typed nodes or questions.
- Offer high-value contextual operations: add the next connected step, insert between two steps, create an alternative branch, and group a selection into a sub-map.
- Make the command palette understand actions and map entities: “connect to…”, “show upstream”, “find unanswered questions”, “focus this system”. Ordinary search must remain fast and predictable.
- Keep one selection model across pointer, keyboard, box selection, and scope navigation. Make rename, copy, paste, connect, delete, and undo consistent in Process and Freeform.
- Preserve one gesture per undo step. Preview structural changes when their consequences are not obvious.
- Keep auto-layout the default. Preserve intentional manual placement; avoid whole-map rearrangement after every small edit.

Delight comes from maintaining the user's train of thought: a newly added step is immediately ready to name; an insertion previews its connections; undo restores the exact prior structure; a shortcut appears at the moment it would help.

## 4. Turn the canvas into a reasoning tool

Make a small set of lenses work exceptionally well:

1. **Flow:** emphasize the selected path and its immediate upstream/downstream dependencies.
2. **Questions:** show inferred claims, missing evidence, and unresolved questions without implying that every optional blank field is a defect.
3. **Ownership and systems:** reveal handoffs, responsibilities, and shared dependencies.
4. **Economics:** reveal documented time, cost, coverage, and assumptions only when that is the question being asked.

Lenses are views of the same model, not duplicated maps. They must explain what is hidden and reset in one action. Allow saving a useful scope/filter combination for return visits.

At overview zoom, emphasize stages, major paths, and selected signals. At working zoom, show titles and key context. At detail zoom or selection, reveal evidence and fields. Start with a few explicit levels rather than complex adaptive behavior.

The inspector should answer: What is this? Why do I believe it? What connects to it? What remains unresolved? What could I do next?

## 5. Make knowledge compound

“Accretive” means the next session starts with more usable understanding, not simply more nodes.

- Let a claim or decision retain its source, relevant excerpt/link, date, and confirmation state. Distinguish observation, inference, proposal, and decision without inventing precision scores.
- Attach open questions to the affected part of the map. Resolving a question preserves its answer and rationale rather than deleting the history of the reasoning.
- Add a concise project re-entry view: continue where you stopped, your pinned next question, and changes since the last accepted baseline. No gamified activity totals or universal project-health score.
- Build on history with semantic summaries: a responsibility changed, a dependency was added, an assumption was confirmed. Link each summary back to the affected object.
- Reuse confirmed patterns deliberately. Start with explicit copy/template behavior; any future linked reuse must show scope, provenance, detach behavior, and update consequences. Never silently share client facts across projects.

Persist substantive knowledge in the portable model. Keep UI preferences such as panel width and camera separate. Use small, backward-compatible schema additions, stable identifiers, and round-trip preservation; do not introduce a hidden competing knowledge store.

## 6. Let AI assist the reasoning, then propose changes

- Ground questions in the current selection and map: “What depends on this?”, “Where is this claim supported?”, “What information would change this decision?”
- Show which evidence or node supports an answer, and say when the map cannot answer it.
- Present proposed edits on the canvas and as a concise semantic change list before approval. Distinguish additions, removals, changed assumptions, and downstream effects.
- Use the same validated, version-aware save path as manual edits. A conflict is not success; an unapproved proposal is not the current model.
- Start with whole-proposal approval. Offer partial approval only when dependency validation makes the selected subset coherent.
- Keep agent execution explicit about scope, permissions, state, and stop behavior. The product should remain fully useful without an AI provider.

## 7. Make alternatives safe to explore

Build on existing economics and scenario work rather than adding a second calculator.

- Compare the accepted baseline with one proposed alternative first.
- Show changed structure, assumptions, estimated time/cost, and what remains unknown together.
- Separate measured inputs from estimates. Display coverage and supported ranges; never turn missing values into zero or imply that a simulation is a forecast.
- Record why an alternative was accepted or rejected. Approval should create a traceable change, not silently rewrite the baseline.
- Link later observations to the original expectation so the map can show what was learned.

Defer multi-scenario optimization and simulation expansion until this single-alternative workflow is useful in practice.

## Delivery sequence and gates

| Slice | Work | Completion gate |
| --- | --- | --- |
| 0. Validate the direction | Prototype the shell, selected-node inspector, and question lens against Atlas and Meridian. Record the current effort for the core tasks below. | Joe can identify where to capture, investigate, and resume without a narrated tour. Agree on the direction before broad UI implementation. |
| 1. One exceptional map workspace | Fix the known trust defects, establish shared visual tokens, simplify the shell, stabilize selection/camera, and implement connected-step/insert interactions. | Build, navigate, edit, undo, reload, and recover a conflict without lost work. The 27-node and 104-node examples remain intelligible. |
| 2. Reason and return | Add the capture surface, contextual inspector, question/path lenses, saved context, and re-entry view. | Capture a thought, connect it, attach a question, leave, and resume the exact thread of work. No duplicate facts or second persistence model. |
| 3. Propose and learn | Add evidence-grounded proposals, one-alternative comparison, semantic decision history, and outcome follow-up. | Compare, approve/reject, and revisit a proposal with its assumptions and rationale intact. Unknown economics remain explicit. |
| 4. Refine and selectively extend | Improve document-specific briefs, reader/export consistency, deliberate pattern reuse, and performance based on observed use. | Each extension supports a repeated task; secondary features do not re-expand the default shell. |

Do not perform a framework rewrite. Retain the local-first, low-dependency architecture. Refactor the shared selection, mutation, save/conflict, and panel-state boundaries only as needed to make behavior consistent.

The known trust backlog includes unsafe conflict actions, remote-update/save races, false save-success propagation, external-revert handling, Freeform copy/delete, edge-selection failures, inconsistent selection, agent descendant termination, and output-buffer bounds. Verify their current state before implementation. They belong in the foundation, not underneath a cosmetic finish.

## What we should intentionally not build now

- A broad task-management system, social activity feed, or generic dashboard.
- More equally prominent top-level views or a large shape library.
- A separate AI chat destination that loses the current map context.
- More 3D effects, decorative motion, or presentation features before everyday authoring is excellent.
- Accounts, real-time multiplayer, or enterprise administration without a demonstrated need.
- Automatic cross-project knowledge merging or unsupported automation-readiness/ROI scores.
- A new framework or design-system dependency just to implement visual consistency.

Existing features need not be deleted to reduce clutter. Reposition, clarify, or conditionally expose them first.

## How to judge whether this worked

Measure against the current app on the same maps and device; these are proposed acceptance targets, not existing results.

- Capture a short thought in one entry interaction without required categorization.
- Add a connected step without opening a full form; insert between steps without manually rebuilding both edges.
- Reach a known node from search and return to the previous scope without losing orientation.
- Identify an unsupported claim and inspect its evidence within two navigational actions from the relevant lens.
- Resume the last working context in one action from Projects.
- Preserve work through save conflicts, external edits, undo, reload, and invalid proposals.
- Keep common local interactions visibly responsive; set numerical latency budgets after measuring the current device and representative maps. Avoid performance promises based on synthetic node counts alone.
- Support keyboard operation, visible focus, readable contrast, reduced motion, and click/tap alternatives for dragging. Check target sizing against WCAG 2.2, including its spacing and other exceptions. See [dragging alternatives](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) and [target sizing](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Validate light/dark, common laptop widths, long labels, nested maps, Process/Freeform, and empty/error/loading states. Test reader behavior separately on narrow screens.

Tests should protect the promises, not inflate counts: keep substantive existing coverage, add focused regression tests for the known failures, and use a small browser journey suite for capture → connect → investigate → undo/reload and proposal → conflict → recovery. Replace vacuous/duplicate helper tests only after their useful assertions have a behavioral home. Use a few representative visual checks, not a snapshot for every component variation.

## Recommended first commitment

Approve and prototype **one exceptional map workspace**: a coherent shell, beautiful readable canvas, predictable editing, and a context panel that helps answer the next question. Use real maps, keep the change set bounded, and test it in a real working session before expanding the product.

The long-term differentiator is not the number of things Serigraph can display. It is how well a portable map preserves and improves the user's understanding.
