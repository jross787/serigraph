# Opsmap roadmap

**North star:** the flexibility of Lucidchart with the structure of Mermaid — a map you can *directly manipulate* like a visual tool, backed by a plain-text file that stays the single source of truth and reads/writes cleanly for humans and LLM agents. The thing Mermaid gets wrong (no drag-and-drop, no manual layout control) and the thing Lucid gets wrong (no diffable text backend) are exactly the two edges Opsmap is built to hold at once.

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

## Phase 4 — Vocabulary & polish (curated, from Mermaid)

- A few more **semantic node shapes** (datastore, event/trigger, sub-process) — kept small and meaningful, *not* an infinite shape library.
- **Icon / image on nodes** for at-a-glance scanning (a system's logo, a status icon).
- **Per-node style override** as an escape hatch when the type palette isn't enough.

## Phase 5 — Distribution & persistence

- **Hosted mode on Cloudflare** with login and cloud-saved maps (accounts, sync) — extends the deferred "read-only client shares."
- **Electron desktop app** — launchable, persistent, runs offline as a native app.

---

## Deliberately *not* doing

Lucid's power is also its bloat: infinite freeform shapes, manual coordinate fiddling as the norm, feature sprawl. Opsmap's differentiator is the curated, typed, text-backed structure. Keep the shape set semantic and small; keep auto-layout the default and manual positioning an override; keep the file diffable and agent-writable. That line is what stops "Mermaid structure" from eroding into "Lucid freeform."

We're already ahead of Mermaid on its worst friction — the write-text-then-re-render loop — via live file-sync plus visual editing. Don't lose it.
