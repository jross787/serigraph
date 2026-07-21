# Serigraph Product Documents v1.1 — Release verification

- Verified: 2026-07-18
- Decision: **Ship**
- Canonical PRD: `maps/serigraph-prd.yaml`
- Canonical roadmap: `maps/serigraph-roadmap.yaml`

## Release evidence

| Gate | Result | Evidence |
|---|---:|---|
| Automated test suite | 102 / 102 passing | Parser, editor, model, direct manipulation, import, economics, product intelligence, HTTP security, CLI, and standalone export |
| Public artifact validation | 12 / 12 passing | Five maps and seven templates validated through `npm run validate` |
| JavaScript syntax | Passing | Every module in `app/`, `server/`, and `shared/` checked with Node |
| Patch hygiene | Passing | `git diff --check` reports no whitespace errors |
| 1,000-item product analysis | 8.14 ms local smoke | Roadmap construction plus 8,013 readiness checks; target is under 100 ms |
| Product PRD | Ready · 100 / 100 | 23 planning nodes, 8 shipped requirements, no readiness issues |
| Product roadmap | Ready · 100 / 100 | 20 requirement capabilities; 23 roadmap items across 8 Now, 8 Next, and 7 Later |
| Legacy compatibility | Passing | The 104-node lending process map and all legacy regression tests remain valid |

## Browser acceptance

The real checked-in artifacts were exercised in the local Serigraph application, not in a separate prototype.

- Desktop Brief, Roadmap, Audit, and Map views render and navigate at 1280 × 720 and 1440 × 900 in light and dark appearance.
- The 390 × 844 mobile Brief and Audit have no page-level horizontal overflow. Roadmap lanes keep intentional horizontal scrolling inside the lane viewport.
- Context actions are absent before selection and expose Open/Link, Edit, Connect, Automate, and More only after a unit is clicked.
- Brief relations navigate to exact nested and cross-scope nodes while preserving incoming and outgoing semantic direction.
- Roadmap status, priority, owner, and text filters combine correctly; reset and audit filters preserve keyboard focus.
- Requirement facts distinguish roadmap horizon from target period. Evidence, risks, acceptance criteria, and traceability remain readable on the source card.
- Incomplete RICE inputs remain unscored, show `Needs inputs`, block Save, and never write partial data.
- Malformed relation text produces an actionable `type -> node-id` error and leaves the source unchanged.
- The document editor fits the mobile viewport, scrolls its body independently, and keeps every field label associated with its control.
- The standalone artifact retains Map, Brief, Roadmap, Audit, search, presentation, traceability, and Markdown publishing while omitting Unit, Connect, Add step, document editing, and score editing.

## Shipped product capabilities

1. Backwards-compatible product-document, planning, relation, dependency, and RICE schema.
2. Graph-backed professional PRD with editable document metadata.
3. Outcome-led roadmap with stable lanes, combined filters, and deterministic ordering.
4. Cross-scope traceability with exact source navigation and portable relation semantics.
5. Deterministic readiness audit with locatable, severity-ranked issues.
6. Transparent RICE prioritization with safe validation and undo-compatible persistence.
7. Markdown and self-contained, read-only HTML publishing.
8. Serigraph-native PRD, 20-capability roadmap, and reusable requirement-slice template.

## Known boundaries

This release intentionally does not include cloud identity, live multiplayer, assignment notifications, execution-tracker synchronization, capacity planning, or broad diagram-format import. Those bets remain explicit roadmap work rather than partial controls in the shipped interface.
