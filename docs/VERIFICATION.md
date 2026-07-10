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

## Re-running the checks

```
npm test                                  # 26 unit/regression tests
npm run validate                          # every map + template
node tools/generate-map.mjs --nodes 1000 --depth 8 --unicode --seed 9 --out maps/stress.yaml
```
