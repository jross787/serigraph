# How Opsmap was verified

Every requirement was tested by **fresh-context reviewers** — agents with no memory of the build, instructed to *disprove* each claim using trusted browser input (Playwright driving installed Chrome), in fresh clones of this repo, across four rounds. Fixes landed between rounds; the loop ran until reviewers came back empty-handed. Evidence lives in [docs/evidence/](evidence/).

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

## Re-running the checks

```
npm test                                  # 34 unit/regression tests
npm run validate                          # every map + template
node tools/generate-map.mjs --nodes 1000 --depth 8 --unicode --seed 9 --out maps/stress.yaml
```
