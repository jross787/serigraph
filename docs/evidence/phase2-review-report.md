# Phase 2 adversarial review — full report

Fresh-context reviewer (no memory of the build), real pointer input via browser automation
against the running app at 1440×900 (plus a 375px palette check), July 2026. Maps were
restored and re-validated after every scenario; final `git status` showed only the Phase 2
source changes, and both maps byte-identical to pristine.

## What was verified (attack-by-attack)

- **A. Palette → empty canvas (insurance):** Decision chip dropped at empty canvas →
  `id: new-decision / type: decision / label / position: {x:1009, y:-214}` was the ONLY diff;
  header comment and blank lines intact; panel opened in edit mode with label input focused
  and fully selected (verified `activeElement`, selStart 0/selEnd 12); typed rename + Save
  produced a label-only change; validator PASS.
- **B. Palette special drops (stress-120):** onto container n5 → `new-role` nested as a
  direct child, **no position**, count chip 9→10. Onto leaf n6 → toast "Drop on empty canvas
  — or on a container to nest inside it", file byte-identical. Drop over toolbar → nothing
  written, no dialog. Plain click on Role chip → Add-node dialog with **Role preselected**;
  cancelled cleanly.
- **C. Double-click empty canvas:** pinned process node at the point, select+rename flow;
  **one** Cmd+Z restored the file byte-for-byte. In presentation mode: double-click did NOT
  create (fell back to zoom-to-fit, file unchanged), palette is `display:none`, 0 of 8 ports
  visible on hover.
- **D. Reparent IN:** n3 → n1: n3 nested under n1; root edge `n6→n3` rewritten **in place**
  to `n6→n1` (list position preserved); validator PASS; **one** undo → byte-for-byte pristine.
- **E. Reparent OUT:** dove into n1, dragged n1-3 onto the move-out bar: n1-3 lifted to root,
  its 3 inner edges re-homed exactly per the FORMAT.md policy — `n1-1→n1-3` ⇒ `n1→n1-3`;
  `n1-3→n1-4 "in stock"` ⇒ `n1-3→n1 "in stock"`; `n1-3→n1-11 "backordered"` ⇒
  `n1-3→n1 "backordered"` (labels/directions kept; the two same-endpoint edges with different
  labels correctly both survived — not "exact duplicates"). Toast reported "· 3 edges
  re-linked". Validator PASS; one undo → pristine.
- **F. Cycle guard:** legal nest n1→n5 moved the whole 3-level subtree (map became 4 levels),
  rewrote root `n1→n4` in place to `n5→n4`, and correctly kept the opposite-direction
  `n4→n5 "true"`; validator PASS; one undo → pristine. **Cycle attempts are unreachable via
  UI**: inside n1's scope only n1-1…n1-15 render — n1 itself is never a drop target
  (confirmed by DOM enumeration), and the ancestry check in canvas.js rejects candidates
  whose ancestry contains the dragged node (defense in depth).
- **G. Connect-by-drag (insurance):** port appears on hover (~11.6 CSS px); port→"Billing &
  payment" wrote exactly `from: prospect / to: billing`, edge auto-selected with the
  label-prompt panel; label save = separate commit; **undo #1 removed only the label,
  undo #2 removed the edge**, file pristine. Port-drag to empty canvas and back onto the
  source: **no write** in either case.
- **H. Mixed-scope coexistence (stress-120):** palette create at root (pinned) + reparent
  n3→n1 (edge rewrite) + connect n2→n8 all coexisted in one diff; a hand-added root node
  written to disk (with an inline `# comment`) appeared **live** on canvas, auto-flowed
  unpinned; full reload persisted everything; validator PASS (122 nodes); restored pristine.
- **I. Regression sweep (insurance):** background drag pans (exact +100/−70 offset); node
  drag pins with a **one-line** diff; pin-badge click releases (file pristine); wheel pans;
  ctrl/cmd+wheel zooms; click-select opens panel; Cmd+K search works (click-pick and
  Enter-pick); presentation walks steps and P exits; **zero stray map writes**.
- **J. Console:** no console messages at all (no errors) after the entire session.
- Extra: phone-width (375px) palette renders as the horizontal bottom strip as specced.

## Findings

No DEFECTS. Two NITs, both fixed and re-verified in-session:

1. Escape while the detail panel was in edit mode (label focused after a create) did nothing —
   now cancels edit mode back to the view panel.
2. Cancelling a port-drag (release on source/empty) was silent while click-Connect showed
   "Connect cancelled" — the drag path now shows the same toast.

## Final state (restoration proof)

`git diff maps/insurance.yaml` empty; `maps/stress-120.yaml` byte-identical to the pristine
seed-7 generation; validator:

```
PASS maps/insurance.yaml — "Summit Insurance — Agency Operations", 12 nodes, 1 level(s) deep
PASS maps/stress-120.yaml — "Stress 120", 120 nodes, 3 level(s) deep
```
