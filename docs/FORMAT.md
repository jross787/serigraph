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
- Positions are never written in the file — layout is automatic.

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
