# The Opsmap file format

An Opsmap file is one YAML document describing how a business operates, as a graph of typed nodes that can nest. It is the single source of truth: the app, humans, and LLM agents all read and write this same file. Everything below is the complete contract — a file that follows it will render.

## Top level

```yaml
name: Acme Lending              # required — the map's title
description: Direct lender; leads arrive by email.   # optional, one line
nodes:                          # required — list of nodes (see below)
  - ...
edges:                          # optional — arrows between top-level nodes
  - from: intake                # id of the source node
    to: qualify                 # id of the target node
    label: qualified lead       # optional — text on the arrow
```

## Nodes

```yaml
- id: underwrite                # required — unique across the ENTIRE file.
                                #   kebab-case: letters, digits, "-", "_", "."
                                #   No spaces. Never reuse an id, even in nested levels.
- type: process                 # required — exactly one of the five types below
  label: Underwriting           # required — display name (any text, emoji ok)
  description: |                # optional — freeform "what happens here", multiline ok
    Analyst pulls credit, verifies bank statements, and issues
    a decision within 4 business hours.
  links:                        # optional — outbound references
    - label: Underwriting SOP
      url: https://docs.example.com/uw-sop
  children:                     # optional — a nested sub-map INSIDE this node.
    nodes:                      #   Same shape as the top level: nodes + edges.
      - id: credit-check        #   Children can have children, any depth.
        type: process
        label: Credit check
    edges: []                   #   edges here connect this node's children
```

## The five node types

| type       | use for                                            | example                    |
|------------|----------------------------------------------------|----------------------------|
| `process`  | a step or stage where work happens                 | "Underwriting"             |
| `decision` | a branch point; outgoing edge labels are outcomes  | "Qualified?"               |
| `system`   | software, tool, or platform                        | "Salesforce", "LOS"        |
| `role`     | a person, team, or job function                    | "Loan Officer"             |
| `artifact` | a document or data object produced/consumed        | "Term Sheet", "Credit File"|

Use these exact lowercase strings. There are no other types.

## Edges (the rules)

- An edge connects two **siblings**: both `from` and `to` must be ids of nodes in the **same** `nodes:` list (top level, or the same node's `children`). To show a handoff between things that live in different branches, draw the edge one level up, between their parents.
- Edges are directional (from → to). For a `decision` node, put the outcome on each outgoing edge's `label` (e.g. `label: "yes"` / `label: "no"`).
- Layout is automatic — you never need to write positions. A node can optionally be **pinned** to a fixed spot with a `position` field (see below); everything else keeps flowing automatically around it.
- **When the app re-nests a node** (dragging it into or out of a container), any edge that would stop connecting siblings is not deleted wholesale and never left invalid — it is **re-homed**: the edge moves to the nearest scope that contains both endpoints, and each endpoint is rewritten to its ancestor-or-self in that scope (so a handoff into a sub-map becomes a handoff to the sub-map's container, keeping its label and direction). An edge that would become a self-loop this way, or an exact duplicate of an edge already there, is removed instead. Edges wholly inside the moved node's own sub-map move with it unchanged.

## Pinned positions (optional)

By default the app lays every scope out automatically, and dragging a node in the app pins it by writing this field. You can also author it by hand:

```yaml
- id: quote
  type: process
  label: Quote & rate
  position: { x: 340, y: 120 }    # pin this node's CENTER at these coordinates
```

The rules:

- `x`/`y` place the node's **center**, in the layout coordinates of the scope (the `nodes:` list) the node belongs to. Each scope — the top level, and every `children` sub-map — has its own independent coordinate plane.
- Units are canvas pixels at 100% zoom: `x` grows to the right, `y` grows **downward**. Negative values are allowed. Auto-laid nodes start near `(0, 0)` and flow right/down, so a pin at `{ x: 0, y: -300 }` sits above the auto-laid content, and `{ x: 900, y: 400 }` sits right-and-below of a small map's flow.
- Node boxes are roughly 120–290 units wide and 48–130 tall (sized to their label). Keep pinned centers at least ~200 units apart horizontally and ~100 vertically so they don't crowd.
- To place something relative to the auto-laid content, estimate its footprint: flows run mostly left-to-right, each sequential step adding ~250–300 units of width and each parallel branch ~90–130 units of height. A 10-node flat map typically spans ~1500–2500 wide × ~200–600 tall from `(0,0)`. When in doubt, overshoot — the camera always zooms to fit everything, so a pin well clear of the flow is safer than one that lands on top of it.
- A parent's own `position` never shifts its children: every `children` sub-map keeps its own plane starting near `(0, 0)` regardless of where any ancestor is pinned.
- A pinned node holds its exact spot. Unpinned nodes keep flowing automatically and are pushed clear of pinned ones; edges route automatically in both cases. Pinning or unpinning one node never changes what's written for any other node.
- **Remove the field to un-pin** — the node returns to automatic layout. (In the app: drag a node to pin it; click its pin badge, or "Release to auto-layout" in the detail panel, to remove it.)
- Write it exactly as a map of two numbers — `position: { x: 340, y: 120 }`. Anything else (a list, a string, a missing coordinate) is a validation error.

## A complete minimal file

```yaml
name: Espresso Cart
nodes:
  - id: take-order
    type: process
    label: Take order
    children:
      nodes:
        - id: barista
          type: role
          label: Barista
        - id: pos
          type: system
          label: Square POS
      edges:
        - from: barista
          to: pos
          label: keys order into
  - id: paid
    type: decision
    label: Paid?
  - id: receipt
    type: artifact
    label: Receipt
edges:
  - from: take-order
    to: paid
  - from: paid
    to: receipt
    label: "yes"
```

## Checklist for generated files

1. Every node has `id`, `type`, `label`; every id is unique file-wide; no spaces in ids.
2. Every `type` is one of: `process`, `decision`, `system`, `role`, `artifact`.
3. Every edge's `from`/`to` name sibling ids in the same list.
4. Rich maps mix types: processes for flow, plus the roles who do them, systems they use, and artifacts they produce — connected with labeled edges.
5. Put real substance in `description` — that text is what makes the map useful.
6. Omit `position` unless a node genuinely needs a fixed spot; when used, it's exactly `position: { x: <number>, y: <number> }` (the node's center; y grows downward).
