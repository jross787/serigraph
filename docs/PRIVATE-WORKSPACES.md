# Private workspaces

Keep the generic application and a business's files in separate repositories.
Launch the engine with an absolute workspace path:

```sh
SERIGRAPH_LIBRARY_DIR=/absolute/path/to/private-workspace npm start
SERIGRAPH_LIBRARY_DIR=/absolute/path/to/private-workspace npm run validate
```

`maps/`, `projects/`, `.serigraph-trash/`, and `.env` resolve inside that workspace.
Application assets, built-in templates, and export code stay in the engine checkout.
Without this setting, the current repository remains the default library.
Set it in the launching environment, not inside `.env`, because it selects that file.
Private launchers can require `serigraph.externalLibraryVersion: 1` in the engine's
`package.json` and fail closed on older engines that ignore this setting.
`OPSMAP_ENV_FILE` and the older `OPSMAP_MAPS_DIR` remain explicit overrides.
`OPSMAP_ROOT` still overrides the application root; it is not the private-library setting.

This is storage separation, not a security sandbox or multi-user authorization.
Run locally. Explicit exports, AI requests, agents, and share actions can still send
map content outside the workspace; only use approved destinations. Start the engine
with the private workspace as its working directory if agents should default there.
Keep `.env`, trash, runtime observations, credentials, and real records out of Git.

Saved Workbench connections are scoped to an opaque library identity. Old unscoped
links are retained in browser storage but never automatically reconnected; reconnect
them explicitly through Share & sync after upgrading. An open tab is pinned to its
library, and the server rejects stale-library API requests after a workspace switch.
Reload before using the newly selected workspace.

## Catalog boundary

A Freeform map may carry `dataExplorer` with `objects`, `canonicalFields`,
`fieldBindings`, and `flows`. It describes where data is intended to live and move.
Serigraph preserves this extension and validates identities and references before
saving: object systems must be shared elements, bindings must reference known
objects/fields, and flows must reference known objects. Consumer-specific schema
rules still belong to the consumer's validator.

An external runtime can read the same file without keeping a second catalog copy.
Runtime responses should identify the catalog revision they used and distinguish
observed, inferred, unknown, and stale state. Catalog metadata alone is not proof
that an API is healthy, a record exists, or a transfer happened.

## Browsing a catalog

Open a map with `dataExplorer` and choose **Data catalog** in the top bar, or
select a system and choose **Explore data** in its inspector. The read-only panel
searches systems, objects, source-field names, and canonical fields. Open an object
to inspect its field mappings and declared connections; choose a canonical field
to find its other locations, or a connection to inspect the linked object.
**Show system on map** locates the object's system without leaving the catalog.
Closing the panel preserves the map's scope and selection. Maps without catalog
metadata do not show these controls.

This uses the catalog already loaded with the map; it makes no Explorer requests
and does not write catalog data. Mappings, authority labels, and connections are
declarations, not proof of actual records, transfers, or health. Live polling,
connector credentials, embedded record investigations, and authentication remain
separate, unfinished work.
