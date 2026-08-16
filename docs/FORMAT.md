# The Serigraph file format

A Serigraph file is one YAML document describing a freeform map, an operating process, a product requirement document, or a roadmap as a graph of typed nodes that can nest. It is the single source of truth: the app, humans, and software agents all read and write this same file.

The top-level `mode` chooses the editing surface. Files without `mode` remain valid and use process mode. Product-document fields are optional.

## Top level

```yaml
name: Acme Lending                  # required, document title
description: Direct lender.         # optional, short description
mode: process                       # optional: process | freeform; default: process
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

elements:                           # Freeform only: shared element definitions
  - ...
nodes:                              # process nodes, or Freeform groups
  - ...
edges:                              # optional arrows between top-level siblings
  - from: intake
    to: qualify
    label: qualified lead           # optional arrow label
```

`mode` controls the map editor:

| mode | Meaning |
|---|---|
| `process` | The operations editor with process node types, owner lanes, path tracing, automation, cost, and product views. |
| `freeform` | A generic map for systems, databases, APIs, people, documents, and other items. |

Choose the mode when you create a map. A map with content cannot switch modes in the app because the two modes use different storage rules. Files without `mode` use Process mode.

## Freeform shared elements and placements

A Freeform map separates the facts about an element from the places where it appears:

- `elements` holds each shared definition once.
- Top-level `nodes` are groups that organize the canvas.
- A `use` entry places one shared element inside a group.
- `note` and `position` belong to that one placement.
- A group's `edges` connect placements inside that group.

```yaml
name: Data landscape
mode: freeform

elements:
  - id: data-team
    type: role
    label: Data Team
  - id: looker
    type: system
    label: Looker
    description: Shared reporting and semantic layer.
    owners:
      - to: data-team
        role: technical
  - id: looker-api
    type: api
    label: Looker API
    relations:
      - to: looker
        type: part-of

nodes:
  - id: analytics
    type: item
    label: Analytics
    children:
      nodes:
        - use: looker
          note: Business dashboards
          position: { x: 120, y: 80 }
        - use: looker-api
      edges:
        - from: looker
          to: looker-api
          label: exposes
  - id: controls
    type: item
    label: Controls
    children:
      nodes:
        - use: looker
          note: Approved control views
      edges: []

edges:
  - from: analytics
    to: controls
    label: supplies reports
```

`looker` has one identity in this file. Both cards use its type, label, description, owners, links, and hierarchy relations. Editing those fields from either card changes the shared definition. Each card keeps its own note and position.

Freeform rules:

1. Every shared element needs a unique `id`, `type`, and `label` in `elements`.
2. A top-level node is a group. It needs `children` even when the group is empty.
3. A placement must be inside a group and must use `use: <element-id>`.
4. The same element can appear in many groups, but only once in each group.
5. A placement can contain only `use`, `note`, and `position`. Edit shared facts in `elements`.
6. An element cannot contain `children`, `note`, or `position`.
7. A group edge can connect only placements in that group. A top-level edge can connect only groups.
8. Removing a placement leaves the shared element and its other placements intact.
9. Deleting a shared element removes every placement and every connection that names it.
10. Use a separate shared element when identity facts differ. Link a real variant with `variant-of`.

`owners` links a shared element or a group to shared `role` elements:

```yaml
owners:
  - to: data-team
    role: data-steward
```

The owner role must be `owner`, `business`, `technical`, or `data-steward`. The `to` target must be a shared element with `type: role`.

Freeform hierarchy uses `relations` on shared elements. The supported types are `part-of`, `member-of`, and `variant-of`. Each target must be another shared element. Groups stay separate from item hierarchy.

`document.kind` controls the document context:

| kind | Meaning |
|---|---|
| `process` | An operations map. Brief and Roadmap can still inspect any planning metadata, but product-readiness scoring is not applied. |
| `prd` | A product requirement document with Brief, Roadmap, and Audit views. |
| `roadmap` | A portfolio-oriented product document using the same planning model. |

`document.status` uses the same status enum as planning nodes: `draft`, `discovery`, `planned`, `in-progress`, `blocked`, `validated`, `shipped`, or `archived`.

## Process map nodes

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
  flowPosition: { col: 2, row: 1 }  # optional pin on the Flow view's ground grid
  children:                         # optional nested sub-map
    nodes:
      - id: credit-check
        type: process
        label: Credit check
    edges: []
```

All process-node fields except `id`, `type`, and `label` are optional. `planning` does not replace the node's visual `type`: a requirement can be drawn as a `process`, `artifact`, `system`, or whichever visual form best explains it.

`flowPosition` pins a node to a `{ col, row }` cell on the Flow view's ground grid. It is optional, additive, and removable: add it to any node, and delete it to return the node to automatic Flow placement. Only the Flow view reads it; every other view ignores it.

## Visual node types

| type | Shown in | Use for | Example |
|---|---|---|---|
| `process` | Process | A step or stage where work happens | Underwriting |
| `decision` | Process | A branch point whose outgoing labels are outcomes | Qualified? |
| `system` | Both | Software, a tool, or a platform | Salesforce |
| `role` | Both | A person, team, or job function | Loan officer |
| `artifact` | Both | A document or data object | Credit file |
| `item` | Freeform | Any neutral thing or concept | Customer domain |
| `database` | Freeform | A database, warehouse, or data store | Customer database |
| `api` | Freeform | An API or service interface | Customer API |

Use these exact lowercase strings. The app shows the process or freeform subset in its add controls.

## Edges and nesting

- A Process edge connects two siblings. Both `from` and `to` must name nodes in the same `nodes` list.
- A Freeform group edge connects two placements in that group's `children.nodes` list. It names the shared element IDs from their `use` fields.
- A top-level Freeform edge connects two groups.
- Edges are directional. Put optional text in `label`.
- `kind` states how data moves between the two nodes: `api` for an API call, `file` for a file transfer, `manual` for manual re-entry, or `event` for an event or webhook. Any other value is a validation error.
- `issue` records a confirmed problem on the handoff, and the app renders it loudly. Write it as plain text; a blank value is ignored.
- Process node IDs, Freeform element IDs, and Freeform group IDs are unique across the file. A Freeform `use` can repeat in different groups because it is a placement, not a new definition.
- Use a typed relation when the relationship crosses Process scopes or describes Freeform item hierarchy.
- Layout is automatic. A Process node or Freeform placement can have a fixed `position`.
- When the app moves a Process node between scopes, it moves each affected edge to the nearest valid scope. It rewrites each endpoint to the node that represents that branch in the new scope. Self-loops and exact duplicates are removed.

For example:

```yaml
edges:
  - from: intake
    to: underwrite
    kind: manual          # api | file | manual | event
    issue: Re-keyed from the quote PDF; typos confirmed in 3% of cases.
```

## Pinned positions (optional)

By default the app lays every scope out automatically, and dragging a node in the app pins it by writing this field. You can also author it by hand:

```yaml
- id: quote
  type: process
  label: Quote & rate
  position: { x: 340, y: 120 }    # pin this node's CENTER at these coordinates
```

The rules:

- `x` and `y` place the card's center in its current scope. Each scope has its own coordinate plane.
- Units are canvas pixels at 100% zoom. `x` grows right and `y` grows down. Negative values are allowed.
- Node boxes are roughly 120 to 290 units wide and 48 to 130 units tall. Keep pinned centers at least 200 units apart horizontally and 100 units apart vertically.
- A Process node stores `position` on that node. A Freeform card stores `position` on its `use` placement. A shared Freeform element cannot have a position.
- A parent's position never shifts its children. Every `children` map has its own plane.
- A pinned card holds its exact spot. Unpinned cards stay in automatic layout.
- Remove `position` to return the card to automatic layout. In the app, click its pin badge or select **Release to auto-layout**.
- Write the field as `position: { x: 340, y: 120 }`. Any other shape is a validation error.

## Pinned edge routes (optional)

Edges route automatically, and dragging an edge line in the app pins its route by writing a `via` point on that edge. An optional `route` field picks the shape of the line. You can also author both by hand:

```yaml
edges:
  - from: quote
    to: bind
    label: approved
    route: stepped              # curved | straight | angled | stepped
    via: { x: 700, y: 40 }      # bend through these coordinates
```

The rules:

- `route` is one of four shapes. `curved` draws a smooth cable through the via. `angled` draws two straight runs with a rounded corner at the via. `stepped` draws stairs whose middle riser passes through the via. `straight` draws a direct line and ignores the via.
- A `via` with no `route` renders as `curved`. A `route` with no `via` seeds its bend at the midpoint of the direct route.
- `via` lives in the same coordinate plane as the scope's node `position` values.
- Parallel edges between the same two nodes render as one cable bundle that fans out on hover; an edge with a `via` or `route` always renders on its own.
- In the app, pick the shape under **Route** in the edge panel. Choose **Auto**, or click the badge on the line, to return to automatic routing.
- Write `via` as `via: { x: 700, y: 40 }`. Any other shape is a validation error, and so is an unknown `route`.

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

## Process and product relations

In Process maps, canvas `edges` and typed `relations` solve different problems:

- An `edge` is a visible arrow between sibling nodes in the same `nodes` list.
- A `relation` records meaning between any two stable node IDs in the document. The nodes can be in different nested scopes. Product views show these relations without drawing every one on the canvas.

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

- Process maps keep their existing schema and behavior.
- Files without `mode` use Process mode.
- `document`, `planning`, and Process `relations` remain optional.
- Without `document`, the parser supplies empty metadata with `kind: process`. Opening the file does not rewrite its source.
- Existing Process node types, automation metadata, links, review notes, children, and edges keep their meaning.
- Freeform maps now use the `elements` and `use` model described above. An older Freeform file that stores a separate node definition inside each group must be migrated.
- The product and interface are named Serigraph. The internal npm package, repository directory, import namespace, and browser storage keys retain the historical `opsmap` name.

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

1. The file has a non-empty `name` and a valid `mode`.
2. A Process node has a unique `id`, `type`, and `label`.
3. A Freeform map stores shared definitions in `elements`. Its top-level `nodes` are groups, and each child placement uses `use`.
4. A Freeform placement appears inside a group and contains only `use`, `note`, and `position`.
5. Every enum uses an exact supported value.
6. Every edge connects entries in one scope. A Freeform group edge names elements placed in that group.
7. Every Process relation and planning dependency names an existing node.
8. Every Freeform hierarchy relation names a shared element. Every owner link names a shared role element.
9. RICE values are finite numbers. Confidence is 0 through 100 and effort is greater than zero.
10. Product requirements include the known owner, acceptance checks, evidence, priority, status, schedule, and objective relation.
11. Omit `position` unless a card needs a fixed spot. Use `position: { x: <number>, y: <number> }`.
12. Cost values must be zero or greater. Omit an unknown instead of guessing.
13. Descriptions and evidence must contain useful facts. Mark inferred facts as provenance comments until a person confirms them.
