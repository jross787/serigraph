# Scoped delivery: map clarity and a public GitHub node

Scope: GitHub parent #16, tickets #17–#23. Implemented locally on
`codex/living-map-foundation`; not pushed. Ticket closure/publication remains a
separate handoff step. Existing unrelated direction documents were preserved.

## Delivered

| Ticket | Result |
| --- | --- |
| #17 | Drag preview and saved routing agree. New automatic bends stay stepped; explicit straight/angled/stepped/curved routes and legacy curves retain their meaning. |
| #18 | One local Phosphor SVG subset across application surfaces, with MIT license included in the app and standalone exports. No dependency or remote asset fetch. |
| #19 | Coherent control sizes, aligned spacing and earlier existing toolbar overflow. Inspection no longer recenters the map. Cards remain 200×64; edge labels remain 192×28. |
| #20 | Selected/focused connections identify endpoints, quiet unrelated paths, and expose full labels. Keyboard focus remains navigable; ambiguous parallel-edge changes clear selection rather than retarget it. |
| #21 | Explicit public-repository node binding and commit-qualified CI Glance; manual refresh, provenance, coverage and failure states. |
| #22 | Separate bounded PR/issue samples and on-demand checks for the captured PR head; no required-check or merge-readiness claim. |
| #23 | Foreground-only refresh, bounded cache/request budget, conditional reads, backoff, late-response rejection, independent PR staleness and focus preservation. |

Icon surface inventory: header and editing toolbar, type pickers, map cards/badges,
node/connection inspectors, catalog, menus/dialogs, search, presentation, Flow,
product-document acceptance markers, agent harness labels and empty/status states.
Brand marks, user text, shortcut notation and data-bearing graph geometry were not
replaced. Small muted path accents retain readable connection labels.

## Evidence and limits

- The full existing suite plus necessary additions passed: **259 tests**. Eight
  cases were added: one route regression and seven GitHub boundary/correctness/
  lifecycle cases. Subsequent small review fixes passed the relevant focused
  checks; no icon snapshot suite or framework was added.
- Browser checks used only an isolated synthetic library: Process and Freeform
  dragging, undo/reload, long labels, reverse fan-in, keyboard edge selection,
  stationary inspection, 1000px/conventional wider workspaces, light/dark icons,
  toolbar/type picker/inspector/Flow rendering and live Glance navigation.
- The app's public main SHA and Test/Pages runs agreed with GitHub. Its PR #13
  head and two returned check runs also agreed; no status contexts were returned.
  PRs were excluded from the issue sample. These are point-in-time observations,
  not assertions about the repository now.
- Controlled local-preview outage: the indicator changed to stale, retained its
  original fetch time and map position, and recovered after restart/reload.
  Automated synthetic checks cover rate limits, conditional requests, budget,
  head changes, hidden/map switches, recovery and late responses. No GitHub failure
  or mutation was induced for verification.
- No business files, PHI or private systems were accessed. The app reader uses no
  credentials, and no in-product agents were launched.
  The preview is a local development process, not a deployed monitoring service.
  Human approval of visual taste and production/private authorization are not
  claimed. Browser zoom settings beyond the tested working widths were not audited.

## Standards

Final re-review at `50bfc93` found no remaining scoped findings. The reviewer ran
the seven GitHub checks and independently confirmed that old PR evidence shows a
stale warning and only refreshes on explicit request. Export/full suites were not
rerun by that reviewer. Main-agent browser checks confirmed focus survives a real
Glance refresh and Tab moves past a selected node.

## Spec

Final re-review found no remaining actionable findings in the corrected head/cache
and keyboard-focus behavior. That reviewer inspected the regression changes
statically; the main agent performed the browser and focused-test verification.
This does not substitute for user visual approval or the unaudited zoom settings.

Review summary: Standards 0 remaining findings; Spec 0 remaining findings.

## Flagged, not expanded

1. Heavily obstructed automatic corridors can still fall back to diagonal routes
   and place a label near another card. A general obstacle router was explicitly
   out of scope; no business wording or pins were altered to hide this.
2. The existing 3D Flow renderer lacks database-specific coloring. This was
   visible on the synthetic database node; it was not expanded into a Flow redesign.

## Run / continue

See [GITHUB-PILOT.md](GITHUB-PILOT.md) for the explicit opt-in, binding storage,
read-only public scope and request limits. The committed example is
`maps/serigraph-development.yaml`. The current separate preview uses a temporary
synthetic library on port 4717; restart from the documented setup for a durable
development session. Do not repurpose the private business map as the demo.

Next handoff step is review and, if approved, publication of this slice. Another
connector, agent launch, dashboard, reconciliation engine or report system needs
a separate scoped request.
