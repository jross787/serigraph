# Opsmap

**The operating model as a file.** How a business actually runs — every function, stage, and handoff — kept as one plain YAML file and rendered as an elegantly zoomable graph of nested, typed nodes. Humans edit either side (canvas or text, comments survive); LLM agents read and write the same file; the economics of automating any step live right next to the step. Derive the first draft from a discovery-call transcript, review what was inferred, and hand the result to the agents that will eventually run it.

![Opsmap](docs/screenshot-1440.png)

## Run it

```
npm start
```

That's it. No `npm install`, no build step, no cloud — the only requirement is [Node.js](https://nodejs.org) 18+ (the two libraries Opsmap uses are vendored into the repo). Your browser opens on the seeded examples: **Summit Insurance**, an independent agency mapped from new prospect through bind, billing, claims, and renewal, and **Brightside Dental**, a map derived from a discovery-call transcript by the ✨ importer — nested sub-maps, live economics, and two still-unconfirmed inferences included, so every hero feature is visible before you've built anything.

> Port busy or don't want a browser popping open? `PORT=5000 npm start`, or `node server/main.js --no-open`.
>
> The server listens on **localhost only** (client data stays on your machine — see [docs/DATA-HANDLING.md](docs/DATA-HANDLING.md)). To share on your network deliberately: `node server/main.js --lan`.

## The one idea

**The file is the truth.** A map lives in `maps/<name>.yaml`. Edit it in the app and the file changes (your comments survive). Edit the file in your editor — or have an LLM agent rewrite it — and the canvas updates live. The whole format fits on one page: **[docs/FORMAT.md](docs/FORMAT.md)**. Hand that page to an LLM with a description of any business and the YAML it returns will render.

## Using the app

| Do this | Get this |
|---|---|
| **Double-click** a node with a badge (or press ⏎) | Zoom into its sub-map — any depth, breadcrumbs keep you oriented |
| **Esc** / ⌫ | Zoom back out one level |
| **⌘K** | Search every node at every level, jump straight to it |
| **Click** a node | Details: what happens here, outbound links (SOPs, repos, dashboards), sub-map |
| **`#id ⧉`** in the panel | Copy a deep link — paste it in a fresh tab, land zoomed on that node |
| **✨ Import** | Paste a meeting/discovery transcript → get a reviewable map: steps, decisions, roles, systems, artifacts — with inferred items flagged before anything is saved. Needs a model: `ANTHROPIC_API_KEY`, a logged-in `claude` CLI, or `OPSMAP_LLM_CMD` pointing at any local model |
| **$ Economics** | Give steps a monthly volume, human minutes × rate, and an agent cost/run — the map rolls up human vs. agent cost, savings, payback, and ROI live. Unknowns show "—" and never sneak into totals |
| **+ Node**, **Edit**, **→ Connect** | Build the map visually; every change is written back to the YAML |
| **Drag from the palette** (or double-click empty canvas) | Drop a new typed node exactly where you release — onto a container to nest it inside |
| **Drag a node** | Pin it exactly there — one `position: { x, y }` line in the YAML; click its pin badge to release back to auto-layout. Drag the background to pan |
| **Drag a node onto a container** | Move it into that sub-map — nesting rewritten in the file, crossing edges re-homed, never invalid. A drop bar moves it back out |
| **Drag from a node's ○ port** | Draw an edge to any sibling — release on it and the edge is in the file |
| **Templates** | Drop in reusable blocks (lead intake, incident response, invoice-to-cash…) and customize |
| **P** | Presentation mode — walk a client through the flow step by step |
| **⬇** | Download a standalone HTML file of the map — read-only, works offline, email it to anyone |
| **?** | All shortcuts |

## For LLM agents

- Read/write `maps/*.yaml` directly; the running app picks changes up instantly.
- The format contract: `docs/FORMAT.md` (that page alone is enough to write valid maps).
- Check work without the UI: `node tools/validate.mjs maps/your-map.yaml` — line-numbered errors, exit 0 on valid.
- Deep-link any node: `http://localhost:4700/#/map/<file>/node/<node-id>`.

## Project layout

```
maps/         your maps (YAML — the source of truth)
templates/    reusable process blocks (same format)
docs/         FORMAT.md — the file-format contract
app/          the web app (vanilla ES modules, no build)
server/       zero-dependency Node server (static + API + live reload + export)
shared/       parser/validator used by app, server, and tools
tools/        validate.mjs, generate-map.mjs (test-data generator)
vendor/       the two vendored libraries: yaml (comment-preserving) + dagre (layout)
tests/        npm test (node --test)
```

## Handy commands

```
npm test          # parser, edit round-trip, export tests
npm run validate  # validate every map and template
node tools/generate-map.mjs --nodes 300 --depth 4 --seed 7 --out maps/stress.yaml
```

## Roadmap

See **[docs/ROADMAP.md](docs/ROADMAP.md)** — the north star is the operating model file that consultants and AI agents both work from: close the trust loop around import, deepen the economics toward CFO-grade, make provenance evidence-grade, then the governed change loop (agents propose, humans approve, an audit trail records). Design decisions and the July 2026 review verdict live in **[docs/DESIGN.md](docs/DESIGN.md)**; what leaves your machine (and how to run fully local) in **[docs/DATA-HANDLING.md](docs/DATA-HANDLING.md)**.
