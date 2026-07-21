# How Serigraph was verified

Every requirement was tested by **fresh-context reviewers** — agents with no memory of the build, instructed to *disprove* each claim using trusted browser input (Playwright driving installed Chrome), in fresh clones of this repo, across four rounds. Fixes landed between rounds; the loop ran until reviewers came back empty-handed. This verification campaign predates the Serigraph rename; its technical evidence and conclusions are unchanged. Evidence lives in [docs/evidence/](evidence/).

## The done-bars, and how each was proven

| Requirement | How it was attacked | Evidence |
|---|---|---|
| Fresh clone → one command → seeded map | Cloned to a temp dir, ran only what the README says (no `npm install` exists to run), asserted HTTP 200 + 18 root nodes + zero console errors | `stranger-step2-level0-root.png` |
| Zoom to the deepest node and back | Mouse-only double-click descent to level 4 (Underwriting → Credit analysis → Tradeline review), Escape walk back — one level per press, verified at 1024/1440/1920px | `stranger-step2-level*.png`, `stranger-step3-after-3-escapes.png` |
| Add node + subnode + GitHub link via UI, persisted | Done through dialogs only; file then checked directly: node, nested child, link present; the diff was **+12/−0 lines** — all 9 hand-written YAML comments intact; validator passed | `stranger-step5-link-saved.png`, `stranger-lending-after-ui-edit.yaml` |
| Deep link in a fresh tab lands zoomed on the node | Pristine browser context → `#/map/lending/node/uwt-worksheet` → 4-level breadcrumb trail, node selected, detail open | `stranger-step6-deeplink-uwt-worksheet.png` |
| File edits show up on canvas | Shell-edited the YAML while the app was open: canvas updated in ~500ms; `git checkout` reverted it in ~250ms. Multi-tab: a rename in tab A appeared in tab B in 474ms | `stranger-step7-tabB-after-rename.png` |
| LLM + format doc → new business renders untouched | An agent was given **only** [FORMAT.md](FORMAT.md) plus prose describing a veterinary clinic. Its one-shot, never-edited YAML: 49 nodes, 3 levels, all five types — validator PASS, rendered perfectly | `coldtest-vet-clinic.yaml`, `coldtest-root.png`, `coldtest-surgery.png` |
| 300-node / 4-level map stays fluid | Generated map: first paint ~600ms, pan/zoom 0.07–0.17 ms/event (budget: 16ms) | reviewer logs |
| 1000 nodes / 8 levels / unicode | Loads in 540ms, mouse-dive to depth 8, search-jump from depth 8, RTL/emoji/CJK render and round-trip through UI edits unmangled | `adversarial-kraken-depth8.png`, `adversarial-unicode-kraken.png` |
| Malformed file → useful error | Broken YAML and structurally-wrong maps show a line-numbered error card (never a blank canvas); fixing the file on disk recovers the canvas live | `adversarial-malformed-error.png`, `adversarial-wrongish-error.png`, `adversarial-malformed-recovered.png` |
| 1440px / 375px, no broken layout | Programmatic bounding-box overlap/overflow checks plus screenshots at both sizes, with and without panels open | `stranger-step9-root-*.png` |
| Standalone HTML export | Single self-contained file renders from `file://`, dives work, editing is disabled | `adversarial-export-root.png`, `adversarial-export-dived.png` |

## What the loop caught (and fixed)

Round 1 found a **critical** bug invisible to synthetic-event testing: `setPointerCapture` made Chrome retarget clicks to the SVG, killing all real mouse interaction with nodes. It also found Escape double-pressing, a `deleteNode` no-op on list-form children, export corruption via `$&` in map content, and dead multi-tab sync. Round 2 confirmed those fixes and caught three defects *the fixes introduced* (transition wedge, a right-edge double-click dead zone, a drag-state leak). Round 3's interrupt storm caught stale input reaching fading transition layers. Round 4 re-ran the storm — 16/16 rounds plus 9 boundary races consistent, chords and real multi-touch clean, and a line-level review of the final diff (with 300-operation randomized interleavings) confirmed **zero new defects**. Round 4's only findings were two pre-existing minors: selecting an edge right after a node left a stale URL/panel (fixed and re-verified), and two *simultaneous* touches on the canvas resolve to the last one (accepted single-selection behavior).

## Phase 1 — pinned positions (drag to reposition, persisted)

Verified July 2026 with the same method: a fresh-context adversarial reviewer drove the running app through real browser input, and a second cold-context agent authored a pinned map from [FORMAT.md](FORMAT.md) alone. Evidence in [docs/evidence/phase1-*](evidence/).

| Claim | How it was attacked | Evidence |
|---|---|---|
| Drag writes exactly one `position: { x, y }` line | Drag → `git diff`: +1 line, all comments/formatting intact, validator PASS; reload → same spot (node transform identical pre/post) | `phase1-insurance-drag.diff`, `phase1-insurance-pinned.png` |
| No position data ⇒ identical rendering | Old code (worktree at previous HEAD) vs new code, same session: per-element SHA-256 of every node/edge group + camera — identical on insurance, stress-120 root, and a nested scope | `phase1-invariant.md` |
| Pinned + auto coexist on ≥100 nodes | Seed-7 120-node map with a pinned container, a pinned leaf, and a nested pin: auto nodes flow with zero rect overlaps against pins (programmatic check), long direct edges route to pins | `phase1-stress-root-mixed.png`, `phase1-stress-nested-pin.png`, `phase1-stress-120-pinned.yaml` |
| Per-scope positions survive dive/rise/reload | Pins in root + nested scopes; Escape out, double-click in, full reload: transforms byte-identical; container miniature keeps all children in-frame | reviewer log |
| Hand-edit coexistence | With a pin present, an unrelated node+edge added on disk: canvas live-updated, pin unmoved, new node auto-flowed, zero overlaps | reviewer log |
| Release returns to auto | Pin badge click and panel "Release to auto-layout": position line removed (file byte-identical to HEAD), node visibly returns | reviewer log |
| Undo/redo | Cmd+Z removes the pin line + node returns; Cmd+Shift+Z re-pins | reviewer log |
| Cold LLM can author pins from FORMAT.md alone | Agent read only FORMAT.md, wrote a 17-node roastery map with 4 deliberate pins (above-flow card, right-side column, nested below-siblings) — rendered exactly as it stated it intended | `phase1-coldtest-roastery.yaml`, `phase1-coldtest-roastery.png` |
| Break-it storm | Sub-4px drags stay clicks (no write); Escape cancels a drag; drags during transitions/presentation/connect-mode don't pin; negative coordinates persist and stay in camera fit; two pins on one spot allowed; 120-node drag ≤1.3 ms/move; zero console errors | reviewer log |

What the loop caught (fixed and re-verified): the YAML serializer re-wrapping long untouched lines at 80 columns (now `lineWidth: 0`); per-scope cameras bleeding across maps on hash navigation (now reset per map open — pre-existing, exposed by far-flung pins); `P` not exiting presentation mode (pre-existing); Escape mid-drag inconsistently rising a scope (now cancels the drag).

## Phase 2 — direct-manipulation authoring

Verified July 2026, same method: a fresh-context adversarial reviewer drove all four gestures with real pointer input against the running app, checking the YAML after every action. Full report: [evidence/phase2-review-report.md](evidence/phase2-review-report.md).

| Claim | How it was attacked | Result |
|---|---|---|
| Palette drop creates exactly the intended node | Drop on empty canvas → diff is only id/type/label/`position`; comments intact; panel opens in edit mode, label focused (selection 0–12 verified); rename+Save = label-only diff | PASS |
| Container/leaf/off-canvas drops behave per spec | Onto container n5 → nested child, **no** position, count chip 9→10; onto leaf → toast + byte-identical file; onto toolbar → nothing; chip click → dialog with type preselected | PASS |
| Double-click empty canvas creates; presentation mode never does | Pinned process node at point, one-undo removal; in present mode dblclick falls back to fit, palette `display:none`, 0/8 ports visible | PASS |
| Re-nest IN rewrites nesting + re-homes edges | n3→n1: root edge `n6→n3` rewritten **in place** to `n6→n1`; validator PASS; one Cmd+Z → byte-for-byte pristine | PASS |
| Re-nest OUT via the drop bar | n1-3 out of n1: 3 inner edges re-homed to root with labels/directions kept; two same-endpoint edges with different labels both survived (not "exact duplicates"); one undo → pristine | PASS |
| Whole-subtree moves stay sound | Container n1 (3 levels) nested into n5 → 4-level map, root edge rewritten, opposite-direction edge kept; validator PASS; one undo → pristine | PASS |
| Cycles unreachable | A container's descendants render only inside it, where the container itself never renders — no drop target exists; ancestry guard in code as defense in depth | PASS |
| Connect-by-drag | Port on hover; port→node wrote exactly `from/to`; edge auto-selected with label prompt; label save = separate commit (undo #1 label, undo #2 edge); release on empty/source = no write | PASS |
| Gestures + hand-edits coexist | Palette create + re-nest + connect in one session, then a hand-added node on disk: live update, auto-flow, full-reload persistence, validator PASS (122 nodes) | PASS |
| Phase-1 regressions | Pan, pin (one-line diff), badge release, zoom, select, search, presentation walk — zero stray writes, zero console errors | PASS |

Findings: **no defects**; two UX nits (Escape didn't cancel panel edit mode; port-drag cancel was silent vs click-connect's toast) — both fixed and re-verified in-session. The edge re-homing policy exercised here is documented in [FORMAT.md](FORMAT.md).

## Phase 6 — transcript → map (✨ Import)

Verified July 2026 (overnight build). The LLM call sits behind a provider chain (mock file → `OPSMAP_LLM_CMD` → `ANTHROPIC_API_KEY` → `claude` CLI) so the whole pipeline runs offline; extraction quality was measured by giving fresh-context agents ONLY the server's `SYSTEM_PROMPT` plus a transcript — exactly what the live API call sends.

| Claim | How it was attacked | Result |
|---|---|---|
| 3 varied fixture transcripts extract with zero hand-edits | Dental clinic / mortgage lender / SaaS support-desk transcripts (900–1,400 words, messy speech, planted implications + red herrings) → extraction → validator, no repairs allowed | 35-, 33-, 40-node maps, all five types, labeled decision branches — **3× PASS untouched** |
| An unseen transcript gets the same quality with no code change | A transcript the builder never saw (commercial landscaping/snow-removal, written by an independent agent) → same extraction | **37-node, 2-level map, PASS with zero hand-edits** (`phase6-unseen-terranorth*`) |
| Inferred ≠ heard | Transcripts planted implied-but-unstated facts; the review step must flag them | Flags matched the planted list (e.g. an unnamed insurance-coordinator role, a hedged "two days" estimate); `# inferred:`/`# uncertain:` comments persist in the saved YAML |
| Review before saving | UI drive: paste → progress → review (counts, type mix, flagged inferences, name) → create | Nothing written to maps/ until "Create map"; Back/Discard leave no trace |
| Bad inputs never crash | empty / 11-char / 160k-char / wrong-shape body / non-English via curl + UI | Clean 4xx messages each time; non-English transcript flows through; zero console errors |
| Model failure paths | Unit tests with a fake LLM: fenced output, ERROR: sentinel, invalid YAML → one corrective retry with validator feedback → still-invalid → clean 422 | 7 pipeline tests green |
| Secrets stay server-side | Browser only ever calls `/api/import`; keys/tokens live in the server process env; the importer button self-disables with a setup hint when no provider is configured | Verified by code path + `/api/import/status` probe |

## Phase 7 — human-vs-agent economics

Verified July 2026 by a fresh-context adversarial reviewer who **recomputed every number by hand from the YAML** before comparing against the UI — per-node chips, panel summaries, and the roll-up bar all matched across 13 checkpoints (initial costing, default-rate fallback, assumption changes, exclusions, zero-runs, negative-savings, giant-setup, live disk edits). Full detail in the reviewer table inside the morning report.

| Claim | How it was attacked | Result |
|---|---|---|
| Formulas correct end-to-end | Independent hand computation of per-run, monthly, savings, payback (incl. ceil-to-days display), first-year ROI, coverage counts at every depth | Every value matched |
| Change one assumption → whole map recalculates | runs 200→100 on one node; all six downstream figures re-derived by hand | Matched live, no reload |
| Unknowns are excluded, never zero | Removing one required field flipped the node to a dashed "incomplete" chip, out of totals (its setup too), listed + clickable in the panel | No silent zeros anywhere |
| Inputs persist and survive reload | Panel saves → exact `cost:` block in the file (flow-style one-liners); disk edits appear live; Cmd+Z reverts in one step | PASS |
| Bad inputs | negative → error toast + no write; `1e3` accepted as 1000; `abc` blocked; runs 0 valid ($0/mo, included); 1e9 runs → no NaN/Infinity | PASS |
| No-cost maps unchanged | insurance renders with no chips/bar; **byte-identical DOM hash old-code vs new-code** for insurance and the 120-node map (`phase67-invariant`) | PASS |
| Works in exports | Standalone HTML renders chips + economics read-only | PASS |
| Cold author from FORMAT.md alone | An agent that read ONLY FORMAT.md wrote a 13-node costed+pinned returns-department map and predicted the totals by hand: human $7,696 / agent $573 / savings $7,123 / setup $7,200 / payback ≈1.01 mo / "4 of 6 steps costed" | **UI matched all six predictions** (`phase7-coldtest-returns.yaml`); the ambiguities it flagged are now clarified in FORMAT.md |

What the loop caught (fixed and re-verified): the first panel save normalized comment-separator whitespace on untouched lines — imported maps are now canonicalized at birth so their diffs stay clean, and the behavior is documented for hand-written files; compact/full currency formatters disagreed on the minus glyph; compact formatting lacked a ≥$1B tier and rounded $22.2k to $22k; FORMAT.md now pins down Σ setup's domain, the coverage count, `runs: 0` semantics, missing-defaultRate behavior, and payback edge wording; the export toolbar no longer shows the Import button.

A final clean-clone "stranger" run (fresh `git clone` → README → both features end-to-end at 1440px and 375px, all arithmetic re-verified by hand, zero console errors) surfaced the one real UX gap: inferred flags were invisible in the app after saving. Now every flagged node wears an amber ⚑ badge, both the node and edge panels show the note with a **✓ Mark confirmed** action that strips the `# inferred:` comment from the file (one commit = one undo), and invalid cost inputs are highlighted inline, not just toasted. Accepted as-is: zoom-to-fit keeps whole-map visibility over label legibility on very wide maps (press 0 / zoom in), and the collapsed bar's compact rounding defers to the exact expanded breakdown.

## Re-running the checks

```
npm test                                  # 65 unit/regression tests
npm run validate                          # every map + template
node tools/generate-map.mjs --nodes 1000 --depth 8 --unicode --seed 9 --out maps/stress.yaml
OPSMAP_MOCK_LLM=tests/fixtures/extractions/dental-clinic.yaml npm start   # importer E2E without a key
```
