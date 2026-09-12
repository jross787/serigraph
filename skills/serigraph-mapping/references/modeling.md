# Modeling reference

Read the sections needed for the current map. These examples are synthetic; the
selected engine's `docs/FORMAT.md` and parser define its installed contract.

## Process maps, decisions, and API handoffs

Process mode uses ordinary `nodes` and sibling `edges`. IDs are unique throughout
the file. Separate the application, interface, and storage when evidence does.

```yaml
name: Service request flow
mode: process
nodes:
  - { id: received, type: event, label: Request received }
  - id: review
    type: process
    label: Review request
    owner: Service team
    trigger: A request enters the queue
    sla: One business day
    systems: [Work console]
  - { id: ready, type: decision, label: Ready to proceed? }
  - { id: fulfill, type: process, label: Fulfill request }
  - { id: console, type: system, label: Work console }
  - { id: request-api, type: api, label: Requests API }
  - { id: request-store, type: database, label: Request database }
edges:
  - { from: received, to: review, meaning: flow }
  - { from: review, to: ready, meaning: flow }
  - { from: ready, to: fulfill, meaning: flow, label: Ready }
  - { from: ready, to: review, meaning: flow, label: Needs detail }
  - { from: review, to: console, meaning: association, label: Uses }
  - { from: console, to: request-api, meaning: data, kind: api, label: Submits request }
  - { from: request-api, to: request-store, meaning: data, label: Persists request }
```

These are declarations, not successful calls or verified persistence. A database
write is not necessarily `kind: api` merely because its source is an API node.
Retain only source-supported facts in a real map. A nested Process node has
`children: { nodes: [...], edges: [...] }`; its edges name immediate children,
not cousins or parent-scope resources. Use a parent-level handoff or a supported
typed relation for cross-scope meaning.

## Freeform systems, ownership, and shared identity

Use Freeform for architecture and systems-of-record maps, including data flows
that do not require the Process-only Flow view. Define each identity once and
place it in one or more groups:

```yaml
name: Service systems
mode: freeform
elements:
  - { id: service-team, type: role, label: Service team }
  - { id: platform-team, type: role, label: Platform team }
  - id: console
    type: system
    label: Work console
    owners:
      - { to: service-team, role: business }
      - { to: platform-team, role: technical }
  - id: request-api
    type: api
    label: Requests API
    relations:
      - { to: console, type: part-of }
  - id: request-store
    type: database
    label: Request database
    description: Authoritative accepted requests in this synthetic example.
  - id: reporting-store
    type: database
    label: Reporting store
    description: Reporting copies, not authoritative request changes.
nodes:
  - id: operations
    type: item
    label: Operations
    children:
      nodes:
        - { use: service-team }
        - { use: console, note: Request entry and review }
        - { use: request-api }
        - { use: request-store }
      edges:
        - { from: service-team, to: console, meaning: association, label: Uses }
        - { from: console, to: request-api, meaning: data, kind: api, label: Submits requests }
        - { from: request-api, to: request-store, meaning: data, label: Persists requests }
  - id: reporting
    type: item
    label: Reporting
    children:
      nodes:
        - { use: request-store, note: Origin of reporting copies }
        - { use: reporting-store }
      edges:
        - { from: request-store, to: reporting-store, meaning: data, kind: file, label: Reporting copy }
edges:
  - { from: operations, to: reporting, meaning: data, label: Supplies reporting data }
```

- Root nodes are groups with `children`, even if empty. A definition alone does
  not place an element on the canvas.
- Shared elements cannot own `children`, `note`, or `position`.
- Placements contain only `use`, optional `note`, and optional `position`. The
  same identity appears at most once per group, but may appear in many groups.
- Group edges name placed element IDs; root edges name groups.
- `owners` targets shared `role` elements using `owner`, `business`, `technical`,
  or `data-steward`. Process maps use the ordinary text `owner` field.
- Shared hierarchy uses `part-of`, `member-of`, `variant-of`. A `reports-to`
  canvas edge is a separate organizational relationship.
- Duplicate an identity only for a real difference, not to show another context.

## API and database catalogs

An API node names an interface; `kind: api` describes a handoff; `dataExplorer`
describes assets and field mappings. None configures a live connection. Add this
top-level block to the Freeform example only when supported by the evidence:

```yaml
dataExplorer:
  objects:
    - { id: request-records, system: request-store, sourceName: requests, entityType: request, authority: originating }
    - { id: report-records, system: reporting-store, sourceName: request_report, entityType: request, authority: analytical }
  canonicalFields:
    - { id: request-id, label: Request ID, entityType: request, dataType: string }
  fieldBindings:
    - { object: request-records, sourceField: request_id, sourceDataType: uuid, canonicalField: request-id }
    - { object: report-records, sourceField: REQUEST_ID, sourceDataType: varchar, canonicalField: request-id }
  flows:
    - { id: report-copy, from: request-records, to: report-records, method: file, label: Reporting copy }
```

`objects` and `flows` are required lists; empty lists are valid. The other two
lists are optional. All shown fields on each row are required non-empty text.
Object systems reference shared elements; bindings reference known objects and
canonical fields; flows reference known objects. IDs are unique per collection,
and a binding's `object` + `sourceField` pair is unique. `authority` and `method`
here are text, not canvas edge enums. State unknowns explicitly instead of guessing
authority, types, joins, or mappings. A common canonical label is not proof of
equivalent keys or permission to join records.

Catalog search, field locations, declared connections, and Show system on map
use this same metadata. Exporting a map includes it. Observations, credentials,
row previews, and comparisons belong in approved private runtime/storage.

## Geometry and links

Prefer auto-layout; preserve existing authored pins. Process pins live on nodes,
Freeform pins on placements: `position: { x: 340, y: 120 }` identifies the object's
center in scope coordinates, not its top-left or screen location. Flow's optional
`flowPosition: { col, row }` is a separate Process-view override.

Optional geometry on an ordinary edge:

```yaml
from: console
to: request-api
meaning: data
kind: api
label: Submits request
route: stepped
via: { x: 620, y: 60 }
fromSide: right
toSide: top
```

Stepped uses both bend coordinates; straight ignores a bend; a via without a
route remains curved. Omit a side for automatic attachment. Route Auto clears
route/bend, not explicit sides. Long labels stay intact in YAML/inspector even
when visually shortened. Do not claim general all-obstacle routing.

`links: [{ label, url }]` holds approved references. Ordinary cards launch the
first safe absolute HTTP(S) link; diamond/circle links stay in the inspector.
Put the intended launch link first. Private URLs and identifiers travel in
exports; a link never grants permission to fetch it.

## Economics and automation

When known, `automation` is `manual`, `assisted`, `automated`, or `at-risk`; omit
it for unassessed work. Owner/trigger/SLA/systems provide context, not execution.
The automation lens explores opportunities without implementing them.

```yaml
costModel: { currency: USD, defaultRate: 65 }
nodes:
  - id: review
    type: process
    label: Review request
    cost:
      runs: 320
      human: { minutes: 12, rate: 58 }
      agent: { perRun: 0.35, setup: 1800 }
```

This snippet needs a top-level `name` to be a complete map. Values are synthetic,
not recommended estimates. Runs are monthly; minutes are per run; rate is hourly;
agent cost is per run; setup is one-time. All numbers must be finite/non-negative.
Zero is valid and missing is unknown. Both human and agent sides must be computable
before a node enters totals. The engine calculates totals, savings, payback, and
ROI; do not write computed totals or count the same work on parent and children.

## Product planning and review

Top-level `document` supports `kind: process | prd | roadmap`, optional version,
summary, owner, status, updated, and text lists audience/goals/nonGoals/successMetrics.
Document kind does not change the storage mode.

Optional Process-node `planning` fields:

- `type`: `objective`, `problem`, `requirement`, `milestone`, `metric`, `risk`,
  `decision`, `research`, `release`.
- `status`: `draft`, `discovery`, `planned`, `in-progress`, `blocked`, `validated`,
  `shipped`, `archived`; document status uses the same enum.
- `priority`: `must`, `should`, `could`, `wont`.
- `phase`/`target`: text; now/next/later are standard horizons.
- `acceptance`, `evidence`, `risks`, `dependsOn`: lists; dependencies name existing
  nodes. Record supplied facts rather than manufacturing readiness.
- `rice`: reach/impact are non-negative, confidence is 0–100, effort is positive.
  All four are required for `(reach * impact * confidence / 100) / effort`.

Process `relations` use `{ to: <node-id>, type: <meaning> }` across scopes:
`informed-by`, `supports`, `satisfies`, `depends-on`, `validated-by`, `measured-by`,
`mitigates`, `blocks`, `delivers`. Keep `planning.dependsOn` for scheduling/cycle
checks even when a semantic depends-on relation is also useful.

`review: [{ id, body, author, createdAt, resolved }]` records review notes. Preserve
the real author/time, not an invented reviewer. Provenance comments on node `id`
or edge `from` can start with `# inferred:`, `# assumption:`, or `# uncertain:`.
Unknown facts may instead be explicit questions. Removing a flag requires evidence,
not merely a successful parser or readiness score.

## Projects

Store related files in `projects/<slug>/<map>.yaml`. An optional `projects.yaml`
index supplies display metadata; it is not an ordinary map:

```yaml
name: Service review
description: Process and systems views of one engagement.
order: [request-flow, systems]
tags:
  request-flow: Process
  systems: Architecture
```

Index entries use file slugs without extensions. Project map IDs are `<slug>/<map>`;
root `maps/<map>.yaml` IDs are `<map>`. Preserve filenames when updating.
