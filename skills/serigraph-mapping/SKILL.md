---
name: serigraph-mapping
description: Build or update evidence-based Serigraph maps from meeting transcripts, notes, system inventories, architecture descriptions, or process documents. Use this skill whenever the user asks to map systems, databases, APIs, owners, data flows, business processes, systems of record, or relationships in Serigraph, even if they only say "make a map" or "diagram this engagement."
compatibility: Requires a Serigraph repository with Node.js 18 or newer.
---

# Serigraph mapping

Create a real Serigraph YAML map that opens in the local app. Treat the source material as evidence. Do not fill gaps with vendor knowledge or plausible guesses.

## 1. Find the project and sources

1. Work from the Serigraph repository. Confirm that `package.json`, `shared/model.js`, `docs/FORMAT.md`, `maps/`, and `tools/validate.mjs` exist.
2. Read `docs/FORMAT.md` before writing YAML. Current repository files override this skill when the format changes.
3. Resolve every source path with file tools. If a required transcript or document is missing, search the named folder once using a narrow filename glob. If it is still missing, stop the map work and ask for the correct path. Never substitute memory or public product descriptions for missing source material.
4. Read all supplied sources before choosing the map structure.

## 2. Extract a small evidence ledger

Before writing YAML, list the confirmed facts you will encode:

- entities: systems, databases, APIs, documents, people, teams, decisions, or process steps;
- relationships: what moves, which direction it moves, and whether it is a read, write, export, sync, lookup, ownership link, or manual handoff;
- authority: which system is the source of truth for each record or measure;
- owners: the person or team accountable for each item;
- controls: reconciliation checks, approval gates, variance rules, access boundaries, and unresolved risks;
- uncertainty: facts that are unclear, disputed, or inferred.

Keep exact source names. Merge two names only when the sources clearly show they refer to the same thing.

## 3. Choose the mode

Use `mode: freeform` for system landscapes, architecture, data lineage, systems of record, ownership maps, and general diagrams.

Use process mode when the main question is the order of work, decisions, service-level targets, automation, or process cost. Process mode is the default, so omit `mode:` or write `mode: process`.

Do not force a system landscape into process semantics. Do not remove process fields from an existing map when switching its mode.

## 4. Model the map

### Freeform node types

- `item`: a neutral concept, domain, control, or grouping item
- `system`: an application or platform
- `database`: a database, warehouse, or data store
- `api`: an API or service interface
- `role`: a person, team, or accountable function
- `artifact`: a document, file, report, or data object

### Process node types

- `process`, `decision`, `system`, `role`, and `artifact`

### Relationship rules

- Draw a directed edge only when the source supports the direction.
- Use a short verb phrase for every meaningful edge label, such as `submits claims`, `writes payment status`, `exports nightly`, or `owns`.
- Keep systems, databases, and APIs separate when the sources distinguish them.
- Mark reporting copies as copies. Do not imply that a warehouse or dashboard is the source of truth unless the source says so.
- Put an accountable team in the node's `owner:` field when known. A `role` node is useful when ownership itself needs to appear on the canvas.
- Edges only connect siblings in one scope. Use a flat top level unless nesting clearly improves the user's question.
- Prefer automatic layout. Add `position:` only when browser review proves that the automatic layout obscures the story.

### Evidence and uncertainty

- Use descriptions to state what the source confirms, not generic product marketing.
- Preserve unresolved questions in descriptions or YAML comments.
- Prefix a YAML comment with `# inferred:` only when an inference is necessary and useful. State why it is uncertain.
- Never invent owners, update frequency, API behavior, table names, data fields, controls, or source-of-truth status.

## 5. Write the file

1. Create a descriptive kebab-case filename under `maps/`.
2. Do not overwrite an existing map unless the user asked to update it.
3. Keep IDs stable, short, and unique across the file.
4. Keep the top level in this order: `name`, `description`, `mode`, `document`, `costModel`, `nodes`, `edges`.
5. Use plain descriptions. Avoid promotional wording and unexplained acronyms.

A freeform starting shape:

```yaml
name: Client system landscape
description: Confirmed systems, owners, and data movement from the supplied source material.
mode: freeform
nodes:
  - id: source-system
    type: system
    label: Source System
    owner: Operations
    description: Source of truth for the confirmed record set.
  - id: reporting-store
    type: database
    label: Reporting Store
    description: Receives a reporting copy. It is not the source of truth.
edges:
  - from: source-system
    to: reporting-store
    label: exports reporting copy
```

## 6. Verify the result

1. Run `npm run validate` from the repository root.
2. Start or reuse the local Serigraph server.
3. Open `http://localhost:4700/#/map/<file-id>` in a browser.
4. Confirm the correct mode, node types, labels, edge directions, and readable layout.
5. Check the browser console for errors.
6. For freeform maps, confirm that process-only controls are hidden. For process maps, confirm that Add step, owner lanes, automation, and product views remain available.

## Output

Return:

- the map name and absolute file path;
- the mode and node count;
- a short list of unresolved questions or inferred facts;
- the exact validation and browser checks that passed;
- a local Serigraph link to the map.
