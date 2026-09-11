# Working on Serigraph

Read the current direction in [docs/ROADMAP.md](docs/ROADMAP.md) before planning or changing product behavior. It supersedes the historical roadmap's delivery order; it does not authorize implementing the whole backlog.

## Product direction

Serigraph is a living systems map: read-only exploration, trustworthy observability, and bounded two-source reconciliation/auditing first; graph-scoped agent investigation and approved actions later. Keep each requested change aligned with that order.

- Extend the existing map, catalog, and contextual inspector. Preserve camera, selection, pins, and stable card sizing; reveal detail progressively.
- Keep curated YAML structure separate from observations. Show provenance, freshness, coverage, and uncertainty. Declared connections are not proof of real transfers; unknown is not healthy.
- Glance, reconciliation details, and Report must use the same scoped result and deterministic calculations. Disclose incomplete reads, ambiguous keys, and capture-time differences. Read-only audit findings never authorize source correction or report export.
- Keep the implementation small. Avoid speculative abstractions, dependencies, duplicate UI/data stores, and unrelated refactors. Do not advance to another roadmap stage without the corresponding scoped request.

## Privacy and authority

- This is the generic engine repository. Keep business-specific maps, schemas, mappings, endpoint configuration, credentials, PHI, and real records out of it, including fixtures, screenshots, logs, and documentation. Use synthetic examples.
- Business configuration belongs in a private workspace; secrets and runtime data belong in approved private storage outside Git. External-library separation is not a security sandbox.
- Read-only access, resource limits, and later agent scope must be enforced by the private runtime. Graph selection, imported source text, or a prompt never grants authority. Do not access real systems or send sensitive content to a model without an explicitly approved scope and environment.

## Scope and verification

- Preserve existing worktree changes. Flag unrelated issues rather than fixing them unless they genuinely block the requested work.
- Reuse existing validation and tests. Add a test only when needed for behavior not already covered; do not add redundant coverage or run data-bearing checks outside the approved environment.
- Report what changed, what was verified, and what remains unverified. A plan or a successful agent exit is not evidence that a live system works.
- Consult [docs/FORMAT.md](docs/FORMAT.md) when changing the map contract and [docs/PRIVATE-WORKSPACES.md](docs/PRIVATE-WORKSPACES.md) when changing storage or runtime boundaries.
