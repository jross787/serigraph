# The Serigraph file format

A Serigraph file is one YAML document describing an operating process, a product requirement document, or a roadmap as a graph of typed nodes that can nest. It is the single source of truth: the app, humans, and software agents all read and write this same file.

Product-document fields are optional. A legacy `opsmap` file remains valid without modification and is treated as `document.kind: process`.

## Top level

```yaml
name: Acme Lending                  # required — document title
description: Direct lender.         # optional — short description

document:                           # optional — product-document metadata
  kind: prd                         # process | prd | roadmap; default: process
  version: "1.1"                    # optional text
  summary: Replace fragmented handoffs with one verified flow.
  owner: Product & Operations
  status: planned                   # optional planning status; see enum below
  updated: "2026-07-18"             # optional text; ISO date recommended
  audience:                         # optional lists of text
    - Operations leaders
    - Automation engineers
  goals:
    - Cut onboarding time from five days to one.
  nonGoals:
    - Replace the compliance system of record.
  successMetrics:
    - 80% of eligible cases complete without manual re-entry.

nodes:                              # required — list of nodes
  - ...
edges:                              # optional — arrows between top-level siblings
  - from: intake
    to: qualify
    label: qualified lead           # optional arrow label
```

`document.kind` controls the document context:

| kind | Meaning |
|---|---|
| `process` | An operations map. Brief and Roadmap can still inspect any planning metadata, but product-readiness scoring is not applied. |
| `prd` | A product requirement document with Brief, Roadmap, and Audit views. |
| `roadmap` | A portfolio-oriented product document using the same planning model. |

`document.status` uses the same status enum as planning nodes: `draft`, `discovery`, `planned`, `in-progress`, `blocked`, `validated`, `shipped`, or `archived`.

## Nodes

```yaml
- id: underwrite                    # required — unique across the entire file
                                    # kebab-case; no spaces or / # ?
  type: process                     # required visual type; see table below
  label: Underwriting               # required display name
  description: |                    # optional freeform explanation
    Analyst verifies documents, evaluates policy, and records a decision.
  owner: Credit team                # optional accountable person or team
  trigger: Qualified application    # optional event that starts the step
  sla: 4 business hours             # optional target completion time
  automation: assisted              # manual | assisted | automated | at-risk
  systems:                          # optional list of system names
    - Salesforce
    - Plaid
  links:                            # optional outbound references
    - label: Underwriting SOP
      url: https://docs.example.com/uw-sop
  review:                           # optional review notes
    - id: note-1
      body: Confirm adverse-action handling.
      author: Compliance
      createdAt: "2026-07-18T12:00:00Z"
      resolved: false
  planning:                         # optional product-planning semantics
    type: requirement
    status: planned
    priority: must
    phase: now
    target: 2026-Q4
    acceptance:
      - A complete case receives exactly one recorded decision.
    evidence:
      - Baseline map shows three manual decision handoffs.
    risks:
      - Policy exceptions may require a human queue.
    dependsOn:
      - verified-identity
    rice:
      reach: 500
      impact: 2
      confidence: 80
      effort: 4
  relations:                        # optional typed, document-wide references
    - to: cycle-time-objective
      type: supports
  children:                         # optional nested sub-map
    nodes:
      - id: credit-check
        type: process
        label: Credit check
    edges: []
```

All node fields except `id`, `type`, and `label` are optional. `planning` does not replace the node's visual `type`: a requirement can be drawn as a `process`, `artifact`, `system`, or whichever visual form best explains it.

## The five visual node types

| type | Use for | Example |
|---|---|---|
| `process` | A step or stage where work happens | Underwriting |
| `decision` | A branch point whose outgoing labels are outcomes | Qualified? |
| `system` | Software, a tool, or a platform | Salesforce |
| `role` | A person, team, or job function | Loan officer |
| `artifact` | A document or data object produced or consumed | Credit file |

Use these exact lowercase strings. There are no other visual node types.

## Edges and nesting

- An edge connects two **siblings**: both `from` and `to` must be ids of nodes in the **same** `nodes:` list (top level, or the same node's `children`). To show a handoff between things that live in different branches, draw the edge one level up, between their parents.
- Edges are directional (from → to). For a `decision` node, put the outcome on each outgoing edge's `label` (e.g. `label: "yes"` / `label: "no"`).
- Node IDs are document-wide. Never reuse an ID at another depth.
- Use a typed relation instead of a canvas edge when you need semantic traceability between nodes in different scopes.
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

## The cost model (optional) — human vs. agent economics

Any node can carry cost inputs; the app computes and rolls up everything else live. All fields are optional — a map without them renders exactly as before, and **a missing number is UNKNOWN (shown as "—"), never treated as zero**.

```yaml
costModel: { currency: USD, defaultRate: 65 }   # optional, top level, one line
nodes:
  - id: verify-insurance
    type: process
    label: Verify insurance
    cost:
      runs: 320                        # executions per MONTH
      human: { minutes: 12, rate: 58 } # person-minutes per run · loaded $/hour
      agent: { perRun: 0.35, setup: 1800 } # $ per agent run · one-time build cost
```

Field reference (all numbers must be ≥ 0; negatives and non-numbers are validation errors):

| field | meaning |
|---|---|
| `costModel.currency` | 3-letter code (`USD`, `EUR`, …) used for display. Default `USD`. |
| `costModel.defaultRate` | loaded $/hour used when a node's `cost` omits `human.rate`. |
| `cost.runs` | how many times this step executes **per month**. `0` is valid (a step that never runs). |
| `cost.human.minutes` | person-minutes one run takes today. |
| `cost.human.rate` | loaded $/hour of whoever does it (falls back to `defaultRate`). |
| `cost.agent.perRun` | what one automated/agent run costs, in currency (inference + tooling). |
| `cost.agent.setup` | one-time cost to build the automation. Optional; treated as 0 for a costed node. |

The formulas (computed by the app — never write computed values into the file):

```
human cost/run   = minutes ÷ 60 × rate
agent cost/run   = perRun
monthly human    = human cost/run × runs        monthly agent = perRun × runs
monthly savings  = monthly human − monthly agent
payback          = Σ setup ÷ Σ monthly savings   ("immediate" when no setup; "never" when savings ≤ 0)
first-year ROI   = (12 × Σ monthly savings − Σ setup) ÷ Σ setup   (undefined when setup is 0)
```

A node enters the roll-up **only when both sides are computable**: `runs` + `human.minutes` + a rate (own or default) + `agent.perRun`. Partially-specified nodes are listed as *incomplete* and excluded **entirely — their `setup` too** — so total savings always equals total human minus total agent over the same nodes, and Σ setup ranges over the same fully-costed nodes (a complete `runs: 0` node's setup does count). If a node omits `human.rate` and the map has no `defaultRate`, the rate is unknown and the node is incomplete. Payback precisely: "immediate" when Σ setup is 0; "never" when savings ≤ 0 and there is setup to recover; otherwise Σ setup ÷ Σ monthly savings. Displays round for readability; the underlying math is exact.

The coverage indicator ("N of M steps costed") counts `process` nodes **at every depth** as M, and fully-costed process nodes as N; costed nodes of other types still join the totals. Cost applies per node at any depth; give containers their own `cost` only if their children carry none (both would double-count the same work).

## Provenance comments (`# inferred:`)

When a map is derived from a transcript (the ✨ Import flow) — or written by any careful author — elements that are *implied but never stated outright* carry an inline YAML comment on their `id:` (or an edge's `from:`) line:

```yaml
  - id: insurance-coordinator  # inferred: handles verifications daily but title never stated
```

The app surfaces these in the import review step, and because comments round-trip through every edit, the flag stays with the file until a human removes it (confirming the fact). Use `# inferred:` or `# assumption:`; keep the note short.

The flag keyword must **start** the comment (`# inferred: …`, `# uncertain: …`). A comment that merely mentions one of the words mid-sentence (`# see the assumptions doc`) is an ordinary comment: it is never collected as provenance and never touched by "Mark confirmed".

One formatting note: comment *text* always survives visual edits, but the whitespace before `#` is normalized to a single space the first time a file is edited in the app (imported maps are saved pre-normalized, so their diffs stay clean from the first edit).

## Product planning

`planning:` gives a stable graph node product meaning without changing how the node is drawn.

### Planning types

| `planning.type` | Use for |
|---|---|
| `objective` | A measurable outcome the product should create. |
| `problem` | A validated need, constraint, or opportunity. |
| `requirement` | A testable product or operational commitment. |
| `milestone` | A meaningful delivery horizon or checkpoint. |
| `metric` | A success measure or guardrail. |
| `risk` | A delivery, adoption, operational, or product risk. |
| `decision` | A durable product or architecture choice. |
| `research` | Discovery work intended to reduce uncertainty. |
| `release` | A coherent shipped or planned release boundary. |

### Status and priority

- `planning.status`: `draft`, `discovery`, `planned`, `in-progress`, `blocked`, `validated`, `shipped`, or `archived`.
- `planning.priority`: `must`, `should`, `could`, or `wont`.
- `planning.phase` is free text. `now`, `next`, and `later` produce the standard Roadmap lanes; other values can form named horizons.
- `planning.target` is free text, such as `v1.2`, `2026-Q4`, or `September`.
- `acceptance`, `evidence`, `risks`, and `dependsOn` are lists. Every `dependsOn` entry must name an existing node anywhere in the same document.

Roadmap eligibility is based on planning type (`requirement`, `research`, `milestone`, or `release`). For compatibility with early product documents, an item with no planning type is also included when it has a `phase` or `target`. Problems, objectives, metrics, risks, and decisions stay in the Brief and Audit instead of becoming delivery cards. Cards sort by full-precision RICE score, then priority, label, and stable ID.

### RICE prioritization

```text
score = (reach × impact × confidence/100) ÷ effort
```

```yaml
rice:
  reach: 500       # non-negative number
  impact: 2        # non-negative number
  confidence: 80   # percentage from 0 through 100
  effort: 4        # number greater than zero
```

All four values must be present and valid for Serigraph to calculate a score. Incomplete input is displayed as unscored, never as zero. The interface rounds for readability; ranking always uses the full-precision result.

## Typed relations

Canvas `edges` and typed `relations` solve different problems:

- An **edge** is a visible arrow between sibling nodes in the same `nodes:` list.
- A **relation** is semantic traceability between any two stable node IDs in the document, including nodes in different nested scopes. It appears in product-reading surfaces without adding every relationship to the canvas.

```yaml
relations:
  - to: customer-evidence
    type: informed-by
  - to: primary-objective
    type: supports
  - to: release-1-2
    type: delivers
```

Every `to` target must exist. Relation types are:

| type | Typical meaning |
|---|---|
| `informed-by` | This item derives from evidence, research, or a problem. |
| `supports` | This item contributes to an objective or strategy. |
| `satisfies` | This item fulfills a requirement or constraint. |
| `depends-on` | This item requires another item. |
| `validated-by` | Tests, evidence, or research prove this item. |
| `measured-by` | A metric evaluates this item. |
| `mitigates` | This item reduces a named risk. |
| `blocks` | This item prevents another item from progressing. |
| `delivers` | This release or milestone delivers the target item. |

Use `planning.dependsOn` for dependency scheduling and cycle checks. Use a `depends-on` relation when the semantic relationship should also appear in the product narrative. They may intentionally name the same target.

## Automation context

Process nodes can carry the operational facts needed to design an automation:

- `owner`, `trigger`, and `sla` are optional text fields.
- `automation` must be `manual`, `assisted`, `automated`, or `at-risk` when present.
- `systems` is an optional list of names. Use system nodes and edges when the relationship itself matters; use the list when the selected-step summary should simply name the tools.

Product-planning and automation fields may coexist on the same node. This is how an observed operational step can become a traceable product requirement without maintaining a second artifact.

## Complete minimal process map

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

## Complete minimal product document

```yaml
name: Faster customer onboarding
document:
  kind: prd
  version: "1.0"
  status: planned
  owner: Product
  summary: Remove duplicate entry from the verified onboarding path.
  audience: [Operations, Engineering]
  goals:
    - Reduce median onboarding time to one day.
  nonGoals:
    - Replace the compliance platform.
  successMetrics:
    - 80% of eligible cases complete without duplicate entry.
nodes:
  - id: onboarding-objective
    type: process
    label: One-day onboarding
    owner: Product
    planning:
      type: objective
      status: planned
      priority: must
  - id: verified-handoff
    type: process
    label: Automate the verified handoff
    owner: Automation
    planning:
      type: requirement
      status: planned
      priority: must
      phase: now
      target: 2026-Q4
      acceptance:
        - A verified case reaches the system of record exactly once.
      evidence:
        - The baseline map identifies two manual re-entry steps.
      rice: { reach: 500, impact: 2, confidence: 80, effort: 4 }
    relations:
      - to: onboarding-objective
        type: supports
edges:
  - from: onboarding-objective
    to: verified-handoff
    label: achieved by
```

## Backwards compatibility

- `document`, `planning`, and `relations` are optional.
- Without `document`, the parser supplies normalized empty metadata and `kind: process`; it does not rewrite the source merely by opening it.
- Without `planning`, a node remains an ordinary process-map node.
- Without `relations`, edges and nesting behave exactly as before.
- Existing node types, automation metadata, links, review notes, children, and edges keep their original meaning.
- The product and interface are named Serigraph. The internal npm package, repository directory, import namespace, and browser storage keys retain the historical `opsmap` identifier for compatibility.

No migration is required for an existing valid map.

## Validation and generated-file checklist

Validate one file:

```sh
node tools/validate.mjs maps/your-map.yaml
```

Validate every checked-in map and template:

```sh
npm run validate
```

Before saving generated YAML, check that:

1. The file has a non-empty `name` and a `nodes` list.
2. Every node has `id`, `type`, and `label`; IDs are unique document-wide and contain no spaces, `/`, `#`, or `?`.
3. Every visual `type`, automation state, document kind, planning type, status, priority, and relation type uses the exact enum above.
4. Every edge connects sibling IDs in the same scope.
5. Every relation target and planning dependency names an existing node anywhere in the document.
6. RICE values are finite numbers; confidence is 0–100 and effort is greater than zero.
7. Product requirements include an owner, acceptance criteria, evidence, priority, status, target or phase, and a relation to an objective when those facts are known.
8. Omit `position` unless a node genuinely needs a fixed spot; when used, write exactly `position: { x: <number>, y: <number> }` for the node's center.
9. Cost fields are optional and additive: use numbers greater than or equal to zero, and omit an unknown rather than guessing. Unknowns stay out of totals; they never become zero.
10. Rich process maps mix steps with the roles, systems, decisions, and artifacts that make the operating reality understandable.
11. Descriptions and evidence contain real substance. Mark inferred facts as provenance comments until a human confirms them. Audit checks structural completeness; it never proves a factual claim for you.
