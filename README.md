# Serigraph

**The operating model as a file.** Map how a business actually runs — every function, stage, handoff, cost assumption, and automation opportunity — in one plain YAML file, then use that same graph as an automation plan, product brief, and delivery roadmap. Serigraph renders nested, typed nodes on an elegantly zoomable canvas. Humans can edit the canvas or the text without losing comments; software agents read and write the same source; and the economics of automating a step live beside the step itself. A discovery-call transcript can become the first reviewable draft, with every inference kept visible until a human confirms it.

Current direction: **a living systems map to explore, observe, reconcile, and audit data across APIs and databases before operational agents.** Quick Glance views and detailed reports will share the same evidence. See the [roadmap](docs/ROADMAP.md#current-direction--september-5-2026) for the staged plan and the distinction between existing features and planned capabilities.

![Serigraph process map](docs/screenshot-1440.png)

## Run it

```sh
npm start
```

That is it: no `npm install`, build step, account, or cloud service. Serigraph requires [Node.js](https://nodejs.org) 18+; its two runtime libraries are vendored into the repository.

Use the map switcher, or open these seeded examples directly:

- [Summit Insurance](http://localhost:4700/#/map/insurance), an independent agency mapped from prospect through bind, billing, claims, and renewal.
- [Brightside Dental](http://localhost:4700/#/map/brightside-demo), a process derived from a discovery-call transcript, with nested sub-maps, live economics, and two still-unconfirmed inferences.
- [Meridian Funding](http://localhost:4700/#/map/lending), a four-level lending process from lead intake through servicing.

> Port busy or don't want a browser popping open? `PORT=5000 npm start`, or `node server/main.js --no-open`.
>
> The server listens on **localhost only** (client data stays on your machine — see [docs/DATA-HANDLING.md](docs/DATA-HANDLING.md)). To share on your network deliberately: `node server/main.js --lan`.

## Update it

Business maps can live in a separate private repository. See
[Private workspaces](docs/PRIVATE-WORKSPACES.md) for the external-library launch option.

Run this once from the Serigraph folder to add the `serigraph` command:

```sh
npm link
```

Then pull the latest version from GitHub with:

```sh
serigraph update
```

The update stops without changing files if the checkout has local work, is not on `main`, or cannot move forward cleanly. Use `serigraph update --check` to check for an update without applying it. You can also run `npm run update` from this folder without linking the command.

## Process maps and Freeform maps

Choose a mode when you create a map:

- **Process** maps work from step to step. They include decisions, owner lanes, path tracing, automation, cost, Flow, Brief, Roadmap, and Audit.
- **Freeform** maps systems, databases, APIs, people, documents, and other items. One shared element can appear in several groups without copying its facts.

Files without a `mode` field use Process mode. A populated map cannot switch modes because Process and Freeform files store their contents differently. Use the **Systems of Record** template to start a Freeform map.

## Use the mapping skill in another repo

Copy the entire [`skills/serigraph-mapping`](skills/serigraph-mapping/SKILL.md)
folder, including its `references/`, into that repo's
`.agents/skills/serigraph-mapping/` (check before replacing an existing skill).
It covers processes, systems, databases, APIs, shared ownership, connector
meanings and routing, catalogs, economics, product plans, review, and exports.
In this engine repo, `.agents/skills/serigraph-mapping` already links to it.

Invoke `$serigraph-mapping`, supply your source material, map destination, and
the absolute path to your Serigraph engine checkout. The destination repo does
not need to contain the engine. The skill can draft YAML without an engine, but
validation/preview/export need a current engine and Node.js 18+. Keep business
maps in the intended [private workspace](docs/PRIVATE-WORKSPACES.md).

## Portable exports

Open **File** on the map toolbar:

| Format | Use |
| --- | --- |
| Interactive HTML | One read-only file with the map, styles, JavaScript, and layout library included. Open in a current browser or host as a static page; no app installation needed. |
| SVG | Scalable, themed image of the current Map scope for READMEs, slides, and print. |
| PNG | Widely compatible image of the current Map scope, up to 2× resolution with a bounded pixel budget. |
| YAML | Editable, lossless map source including comments and nested details. |
| Markdown | Readable inventory, nested connections, ownership, catalog, and product documentation. |

From another repo, create HTML without running the app:

```sh
node /absolute/path/to/serigraph/tools/export.mjs /absolute/path/to/map.yaml --out /absolute/path/to/map.html
```

The output folder must already exist; existing files are not overwritten.
For GitHub, embed SVG/PNG in a README and serve interactive HTML through
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
GitHub's ordinary file view does not execute an HTML application.
See [Exports](docs/EXPORTS.md) for offline compatibility, scope, and privacy limits.

## Share through Workbench

Open a map, choose **Share & sync** from More actions or the toolbar's More menu, and paste a Workbench document link. Use an edit link when Serigraph needs to publish changes.

Serigraph adds one managed section to the Workbench document. That section contains the full YAML and a live map preview. Other document content stays in place. If the document already contains a different map, Serigraph asks which copy to keep.

While the map is open, edits move in both directions. If the local and Workbench copies change before they can sync, Serigraph stops and offers three choices: keep the local copy, keep the Workbench copy, or disconnect. Disconnecting keeps the local map and forgets the link in this browser without touching the Workbench document. Removing the managed section from Workbench disconnects an unchanged local map instead of silently adding it again.

An edit connection can create view, comment, suggest, or edit links for people and agents. Workbench enforces those permissions. Serigraph keeps the linked share key in this browser only; it never writes the key into YAML, the Workbench document, or a standalone export. See [Data handling](docs/DATA-HANDLING.md) before sharing a client map.

## One source, six useful views

The file is the truth. A graph lives in `maps/<name>.yaml`; visual edits write back to that file, file edits live-reload into the canvas, and YAML comments survive supported edits.

The view switcher turns that one graph into six working surfaces:

| View | What it is for |
|---|---|
| **Map** | Design the process or product story as a nested, navigable graph. |
| **Agents** | Launch claude, codex, or omp coding agents against a repo and watch their edits land on a live map. |
| **Flow** | Watch the operating model in motion: a rotatable 3D view where every node is a building and moving payloads are the work items, paced by the monthly volume recorded in the file. Lanes show how each handoff moves — API, file, manual re-entry, or event — and confirmed issues render loudly. Drag to rotate, ⌘-drag to pan, scroll to zoom, drag a building to move it, click a payload to inspect the handoff it represents, or trace a named flow one step at a time. |
| **Brief** | Read a graph-backed PRD with goals, problems, objectives, requirements, acceptance criteria, evidence, decisions, risks, and metrics. |
| **Roadmap** | See eligible planning nodes in Now, Next, Later, named-target, and Unscheduled lanes; filter by status, priority, owner, or text. |
| **Audit** | Run deterministic readiness checks for ownership, proof, traceability, priority, scheduling, dependencies, risk coverage, and cycles. |

For data-movement maps, open the seeded example: [Order Data Flow — Integration Demo](http://localhost:4700/#/map/data-flow-demo). Add `kind: api | file | manual | event` to an edge to state how the data moves, and `issue:` to record a confirmed problem — the Flow view styles the lanes and lists the issues.

Open the checked-in examples after starting the app:

- [Serigraph Product Documents PRD](http://localhost:4700/#/map/serigraph-prd)
- [Serigraph Product Roadmap](http://localhost:4700/#/map/serigraph-roadmap)

The detailed product contract is in [docs/PRODUCT-REQUIREMENTS.md](docs/PRODUCT-REQUIREMENTS.md), with the completed release evidence in [docs/RELEASE-VERIFICATION.md](docs/RELEASE-VERIFICATION.md). The PRD and roadmap above are not screenshots or duplicate planning stores: they are real Serigraph charts that dogfood the public YAML format.

## Projects

A project is a folder of portable maps: `projects/<slug>/` holds ordinary Serigraph map files plus one optional `projects.yaml` index — the project's display name, a description, the tile order, and a free-text tag per map. Maps that belong to no project stay in `maps/`. A map inside a project is an ordinary map in every way; only its id changes, to `<project>/<map>`.

The app boots to the [Projects home](http://localhost:4700/): one card per project with a tile per map, and ungrouped maps at the bottom. Create a project with **New project** beside **New map**, or by adding a `projects/<slug>/` folder yourself. Two seeded examples ship in the repository:

- [Atlas Logistics — Operations Review](http://localhost:4700/#/map/atlas-logistics/order-flow), a consulting engagement pairing an order-to-cash process with the [system landscape](http://localhost:4700/#/map/atlas-logistics/systems) behind it.
- [Serigraph Dogfood](http://localhost:4700/#/map/serigraph-dogfood/code-pipeline), Serigraph's own YAML → parse → validate → render → export pipeline mapped in Serigraph.

To move a map, open its row's context menu in the map switcher and choose **Move to project…**, then pick a project or **Root (no project)**. Old links keep working: the server answers the old id with the new one and the app follows it.

Use **Trash** on a project card, map tile, or map switcher row to remove it from the library. Serigraph moves the file or whole project folder into the local `.serigraph-trash/` folder. **Restore** returns it to the same path and stops if another map or project now uses that path. **Delete forever** removes it from disk and cannot be undone.

## Product documents

Any existing map can become a product document by adding an optional top-level `document:` block and optional `planning:` and `relations:` fields to its nodes. The original five visual node types remain unchanged; product semantics are a separate layer.

```yaml
name: Customer onboarding automation
document:
  kind: prd
  version: "1.1"
  status: planned
  owner: Product & Operations
  summary: Reduce onboarding delay without hiding compliance risk.
  goals:
    - Cut median onboarding time from five days to one.
  successMetrics:
    - 80% of eligible cases complete without manual re-entry.

nodes:
  - id: onboarding-objective
    type: process
    label: One-day onboarding
    owner: Product
    planning:
      type: objective
      status: planned
      priority: must

  - id: automate-handoff
    type: process
    label: Automate the verified handoff
    owner: Automation team
    planning:
      type: requirement
      status: planned
      priority: must
      phase: now
      target: 2026-Q4
      acceptance:
        - A verified case reaches the system of record exactly once.
      evidence:
        - Baseline map shows duplicate entry in two teams.
      rice:
        reach: 500
        impact: 2
        confidence: 80
        effort: 4
    relations:
      - to: onboarding-objective
        type: supports
```

RICE is transparent: `(reach × impact × confidence/100) ÷ effort`. All four inputs are required for a score; Roadmap ranking uses the full-precision value even when the display is rounded. Select **Score** on a roadmap card to edit the inputs.

From Brief, use **Edit document** to maintain document metadata and **Download Markdown** to publish a clean, portable PRD. **Share & export** can also produce a standalone read-only HTML application.

The complete schema, enums, validation rules, and examples are in [docs/FORMAT.md](docs/FORMAT.md). A reusable starting slice is available at [templates/product-requirement-slice.yaml](templates/product-requirement-slice.yaml).

## Using the map

| Do this | Get this |
|---|---|
| **Double-click** a node with a badge (or press ⏎) | Zoom into its sub-map — any depth, breadcrumbs keep you oriented |
| **Pan toward a connected group** | Keep exploring on the same canvas. Click its frame or any item inside it to make that group active. The minimap spans the full connected view |
| **Esc** / ⌫ | Zoom back out one level |
| **Zoom percentage** | Open preset sizes: Fit, 50%, 75%, 100%, 150%, or 200% |
| **-** beside the minimap | Hide the minimap; **+** shows it again |
| **Reopen a map** | Return to the camera position and zoom you left |
| **Filter Roadmap or Audit** | The filters you set are remembered for that map |
| **⌘K** | Search every node at every level, jump straight to it |
| **Click** a Process node | Inspect the step, product facts, links, related nodes, and its sub-map |
| **Click** a Freeform card | Inspect its shared definition and local group note. Every placement of that element is highlighted |
| **`#id ⧉`** in the inspector | Copy a deep link and open that exact node |
| **✨ Import** | Paste a meeting or discovery transcript and get a reviewable Process map. Inferred items stay marked until reviewed. This needs `ANTHROPIC_API_KEY`, a logged-in `claude` CLI, or `OPSMAP_LLM_CMD`. If none is configured, the dialog lists these three setup paths instead of failing without explanation. |
| **$ Economics** | Add monthly volume, human time and rate, and agent cost to Process steps. Unknown values stay out of totals |
| **Add step** | Add a new Process node |
| **Add item** | In a Freeform group, choose an existing shared element or create and place a new one |
| **Add group** | Add a top-level Freeform group |
| **Drag from the palette** | Drop a new typed item at that position |
| **Drag a card** | Pin it at that position. In Freeform, dragging into another group moves only that placement |
| **Drag from a card's port** | Draw an edge to another card in the same scope |
| **Shift+click** a node | Add or remove it in the selection |
| **Shift+drag** | Draw a box to select every node inside |
| **⌘C / ⌘V** | Copy and paste the selected nodes |
| **F2** | Rename the selected node |
| **Align** | Align or evenly space the selected nodes |
| **Remove from group** | Remove one Freeform placement while keeping the shared element and its other placements |
| **Delete shared element** | Remove the definition, all placements, and all connections after confirmation |
| **Templates** | Insert a reusable block that matches the current map mode |
| **Shift+P** | Enter presentation mode and walk through a Process flow |
| **File → Export** | Download interactive HTML, PNG, SVG, YAML, or Markdown; HTML runs without the app installed |
| **Share & sync** | Link the map to a Workbench document, create access links, copy a local deep link, or download a read-only standalone application |
| **?** | Open the shortcut reference |

## For software agents

- Read and write `maps/*.yaml` directly. The running app detects file changes.
- Use [docs/FORMAT.md](docs/FORMAT.md) as the complete public contract.
- Validate without opening the interface: `node tools/validate.mjs maps/your-map.yaml`.
- Deep-link a node: `http://localhost:4700/#/map/<file>/node/<node-id>`.
- In Freeform, define each identity once in `elements` and place it with `use` inside groups.
- Keep definition IDs stable. Process edges connect sibling nodes. Freeform group edges connect placements. Typed relations record cross-scope Process meaning or shared-element hierarchy.
- Do not infer missing evidence. Audit checks structure, not whether a claim is true.

## Project layout

```text
maps/         process maps and product documents (YAML, the source of truth)
templates/    reusable process and product blocks (the same graph format)
docs/         format contract, PRD, verification, and design records
app/          web application (vanilla ES modules, no build)
server/       zero-dependency Node server, API, live reload, and export
shared/       parser and validator used by app, server, and tools
tools/        validator and deterministic test-map generator
vendor/       vendored yaml and dagre libraries
tests/        Node test suite
```

The product and interface are named **Serigraph**. For backwards compatibility, the internal npm package, repository directory, import namespace, and browser storage keys retain the historical `opsmap` identifier. Treat `opsmap` as an implementation identifier, not the customer-facing brand.

## Handy commands

```sh
npm start          # serve Serigraph at http://localhost:4700
npm test           # run parser, editing, product-planning, and export tests
npm run validate   # validate every checked-in map and template
node tools/generate-map.mjs --nodes 300 --depth 4 --seed 7 --out maps/stress.yaml
```

## Backwards compatibility

Product-document fields are entirely optional. A file without `document:` is normalized as `document.kind: process`; nodes without `planning:` or `relations:` behave exactly as before. Existing visual types, edges, nesting, deep links, edit history, presentation, and standalone export require no migration.

## Roadmap

The forward roadmap is itself a Serigraph artifact: open [maps/serigraph-roadmap.yaml](maps/serigraph-roadmap.yaml) in the app's Roadmap view to review the Now, Next, and Later portfolio. The longer-range product strategy lives in **[docs/ROADMAP.md](docs/ROADMAP.md)**: close the trust loop around transcript import, deepen the economics toward CFO-grade, make provenance evidence-grade, then build the governed change loop where agents propose, humans approve, and an audit trail records.

Design decisions and the July 2026 review verdict live in **[docs/DESIGN.md](docs/DESIGN.md)**; what leaves your machine, and how to run fully local, is documented in **[docs/DATA-HANDLING.md](docs/DATA-HANDLING.md)**.
