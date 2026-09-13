# Private workspaces

Keep the generic application and a business's files in separate repositories.
Launch the engine with an absolute workspace path:

```sh
SERIGRAPH_LIBRARY_DIR=/absolute/path/to/private-workspace npm start
SERIGRAPH_LIBRARY_DIR=/absolute/path/to/private-workspace npm run validate
```

`maps/`, `projects/`, `.serigraph-trash/`, and `.env` resolve inside that workspace.
Application assets, built-in templates, and export code stay in the engine checkout.
Without this setting, the app uses its saved project-files folder, or the current
repository when no folder has been selected.
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

## Choosing a folder in the local app

**More actions → Project files** previews an existing absolute directory before
**Use folder & restart**. It changes the complete library root: `maps/`,
`projects/`, `.serigraph-trash/`, and `.env`. It never migrates or merges files.
Review the destination and explicitly trust its `.env` before restarting; those
settings may configure providers or opt-in runtimes. Launch-environment values
still take precedence over `.env`. The supervisor starts a fresh worker so the
previous library's file-loaded credentials do not carry into the new one.

Finish drafts, saves, sync, and AI/agent work and close other tabs/servers using
this installation first. Pending API work, agent processes, and other connected
tabs block the switch. Stale tabs cannot read or write the newly selected library
through ordinary APIs until reloaded. The switch opens Projects, not a same-named
map from another workspace. This is still a single-user storage boundary.

The path preference is a mode-600 JSON file outside the engine, under
`$XDG_CONFIG_HOME/serigraph/` (otherwise `~/.config/serigraph/`, or Windows
`%APPDATA%/serigraph/`). Its filename identifies the engine checkout, so separate
installations do not silently change each other's libraries. Trusted launchers
can choose `SERIGRAPH_PREFERENCES_FILE` explicitly. A corrupt preference or missing
saved directory fails closed; reconnect the directory, repair the preference, or
launch with an explicit `SERIGRAPH_LIBRARY_DIR` to recover.

Explicit `SERIGRAPH_LIBRARY_DIR`, `OPSMAP_ROOT`, `OPSMAP_MAPS_DIR`, or
`OPSMAP_ENV_FILE` launch settings lock this UI setting. Remove those overrides
and restart only if the installation should use the saved folder instead.
`SERIGRAPH_DISABLE_LIBRARY_SETTINGS=1` disables the control for managed installs.
LAN mode cannot change folders. Standalone exports have no folder controls.
The validator uses the same saved preference when no library is specified;
pass explicit approved filenames when validating a narrow scope.

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
