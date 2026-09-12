# Map studio verification — September 12, 2026

Local implementation of the requested visual-language, authoring, and Frost
appearance pass. The design audit guided a targeted change to the existing map,
menus, and inspector, not a replacement application or a new runtime boundary.
The production renderer remains JavaScript; this pass does not add Wasm.

## Audit and changes

| Finding | Evidence before the change | Implemented response |
| --- | --- | --- |
| P1: a dragged stepped return path doubled back | Two independently routed legs revisited the segment beside an outside via; choosing explicit bottom attachments did not cure it | A bounded alternate-elbow search runs only for adjacent retraces. Exact vias and chosen attachment sides remain authoritative |
| P1: the template heading was behind the toolbar | At the desktop preview, panel top was 72 px and toolbar bottom was 112 px: 40 px overlap | Panels share toolbar/chrome spacing. Final desktop panel top 136 px, toolbar bottom 122 px |
| P2: object names and shapes did not explain intent | Add used different vocabularies by mode; applications, databases, and APIs looked alike | One shared nine-type vocabulary, hints, distinct silhouettes, and an in-app Map language guide |
| P2: a decision's question, description, and branch labels were easy to confuse | Branch authoring was separate from destination choice | One reviewed Outcomes list pairs labels with same-scope destinations; Apply is one undoable edit |
| P2: file operations competed with map tools | Import, Export, and History occupied separate toolbar positions | File groups save/load/export/history; More holds secondary tools, Templates, Appearance, and the guide |
| P2: requested material hierarchy was absent | Existing light/dark choices did not provide ivory controls over an opaque dark canvas | Optional Frost appearance, system typography, rounded controls, restrained blur, and solid map cards |

The [map-language document](MAP-LANGUAGE.md) records the protocol and limits.
Triangles are reserved for attention/warnings, not another business-object type.
Legacy unclassified connections are not silently assigned a meaning. Shapes,
colors, and declared transfers are not evidence of health or runtime authority.

## Scope and environment

- All live authoring used a newly created synthetic library outside Git. It
  contains an eleven-node service example covering all nine object types and
  all four connection meanings. The local preview is loopback-only; dotenv
  loading and the GitHub observation pilot were disabled.
- Browser checks used the Codex in-app browser at its normal 1216 × 1005
  viewport and a temporary 390 × 844 responsive override. The override was
  reset. The browser-testing CLI was unavailable; equivalent checks used the
  supported in-app browser controls.
- The user-provided screenshots were inspected but not copied into the engine.
  Synthetic browser captures were visually reviewed in the task. No business
  map YAML, private configuration, real source system, or production deployment
  was read or changed for this pass.
- Existing untracked workspace content was preserved. No commit, push, PR,
  package install, or deployment was performed.

## Interaction evidence

- **Return-path drag:** dragged the synthetic “Needs detail” label from roughly
  screen (954, 411) to (1064, 448). The saved via became (1061, 287), both
  attachments remained bottom, and the calculated route had zero adjacent
  retraces. Camera transform and every node transform were unchanged. One
  Undo restored the exact original rendered path and via.
- **Decision editing:** changed “Ready” to “Approved” through the Outcomes UI,
  applied, checked persistence, then undid it. Camera and node transforms were
  unchanged. A separate unapplied draft followed by ⌘S produced the explicit
  “Apply the inspector draft first” warning; the existing edge remained saved
  with its old label. Resetting the draft cleared its dirty state.
- **Connection meanings:** a selected association had no arrowhead; a selected
  data transfer had one arrowhead and computed dash pattern `6px, 4px`. Transfer
  method was saved separately. A reporting relationship was created with the
  Connect picker and two endpoint clicks. Escape cancelled a pending
  association after its origin was selected without adding an edge.
- **Object authoring:** Event, Data store, Interface/API, Concept, and Person/team
  were added through the actual form. The event was a 112-pixel circle; the
  database and interface had cylinder and hexagonal silhouettes. The resource
  inspector did not show an empty process-cost form.
- **Panel layout:** desktop Templates and inspector started 14 px below the
  toolbar. At 390 px width, Templates occupied x=8…382 with top=124 and toolbar
  bottom=112; its heading was visible. The narrow inspector stayed inside
  x=8…382 and y=407.875…836. Document views can scroll horizontally instead of
  forcing the header outside the viewport; measured page overflow was zero.
- **Appearance:** Paper changed the canvas to its light background; Night
  survived a reload; Frost was restored. Frost's canvas computed to opaque
  `rgb(34, 47, 44)`. Appearance does not modify YAML.
- **Guide and keyboard:** the guide opens with its heading visible and scroll
  position zero. Its heading and Done footer stay visible while the content
  scrolls, including at 390 px width. Shift+Tab from the initially focused
  heading stayed inside the dialog. Enter on an appearance choice selected it
  without prematurely dismissing the dialog.
- **Navigation and File:** Projects home showed only the synthetic library;
  reopening the map worked. File → Open map opened the existing map picker.
  SVG and PNG actions reached their success notifications. The downloaded
  files were not independently reopened: OS download-folder access was denied,
  and this browser did not expose the expected download event. This is not a
  claim of pixel-verified PNG/SVG files.
- **Read-only HTML:** a freshly generated synthetic export initially exposed a
  pre-existing missing `app/agents.js` import. Added that existing module to the
  bundle and extended the existing export test to check dependency closure.
  The rebuilt export rendered all eleven nodes, the event circle, and
  arrowless associations. Save was disabled; decision outcomes were readable
  with zero editable outcome controls.
- **Errors:** the editor's browser error log was empty in the final checks.
  The repaired standalone export rendered after the unresolved-module failure
  was corrected; no private live observations were part of that export.

## Automated checks

The complete test suite ran in an isolated copy of engine code, tests, templates,
FORMAT, and the four synthetic maps required by existing tests. The library did
not include the checkout's private/untracked project material. Provider keys and
library overrides were removed from that test process; test servers used
loopback and agent tests used the existing deterministic fake harness.

```sh
env -u SERIGRAPH_LIBRARY_DIR -u OPSMAP_ROOT -u OPSMAP_ENV_FILE \
  -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u ANTHROPIC_API_KEY \
  -u VENICE_API_KEY OPSMAP_SKIP_DOTENV=1 SERIGRAPH_GITHUB_PILOT=0 \
  node --test --test-concurrency=1 --test-reporter=spec
```

**Final result: 274 passed, 0 failed, 0 skipped.** The preceding parallel run
hit the existing four-second polling deadlines in fake-agent tests, followed by
a dependent cleanup failure. All five agent tests passed when rerun alone, and
the entire serial run passed. Their deadlines were not changed to obtain a pass.

Focused regression checks cover outside-via retraces, fixed side attachments,
shape boundaries, vocabulary validation, atomic decision edits, comment/route
preservation, Freeform placement scope, meaning-aware deduplication on moves,
exclusion of reporting/association edges from work paths, and bundled import
closure. Existing move/export tests were extended rather than duplicated.
JavaScript syntax checks and `git diff --check` also passed.

## Contrast samples and limits

Calculated text contrast from the final palette, including 94% ivory chrome
composited over the dark canvas:

| Sample | Ratio |
| --- | --- |
| Muted text on frosted panel | 5.11:1 |
| Faint text on frosted panel | 4.75:1 |
| Node label on card | 11.23:1 |
| Edge label on bubble | 10.00:1 |
| White text on primary action | 5.36:1 |

These are selected color-pair checks, not a full accessibility certification.
Reduced-motion rules are retained and reduced-transparency solid surfaces are
provided; actual OS preference toggles, assistive technology, Safari/Firefox,
physical touch devices, print output, and performance under mobile memory
pressure were not validated. Dense-map obstacle/label collision freedom is not
claimed. No remote CI or production acceptance was run.

Separate renderer experiments are outside this production change and are not
part of its acceptance evidence.

## Portable exports and reusable skill — follow-up

The mapping skill now separates source repo, map library, and engine checkout.
Its entrypoint and bundled modeling reference cover the implemented object,
connector, catalog, Process/Freeform, review, economics, planning, and export
features. Planned runtime capabilities remain explicitly separate. The skill
validator passed. A fresh agent followed it from an isolated destination folder
using only the synthetic system-notes fixture: the resulting ten-node Freeform
map passed the engine validator and retained unknown owners and flagged inferred
API-backend relationships. Browser validation was intentionally excluded from
that skill trial, not reported as a success.

The export follow-up adds an explicit-path, no-server HTML CLI; HTML generation
from the editor's applied source without saving; offline HTML-copy download;
scoped, neutral SVG/PNG image previews; bounded PNG allocation; and an all-map
Markdown inventory. Regression coverage extends the existing server, HTTP, and
product suites for portability, overwrite refusal, validation/library guards,
inert source embedding, and nested/shared catalog Markdown.

Browser verification used synthetic Process and Freeform maps only:

- The new File menu's HTML action reached its success notification. Generated
  standalone Process and Freeform pages were opened through the existing inline
  export route, then their loopback test server was stopped. Decision outcomes,
  nested group navigation, catalog search, native/canonical field details, and
  another HTML-copy download continued to work. Both standalone error logs were
  empty. No live source or provider was accessed.
- The actual image preview rendered a 2520 × 1370 PNG with all eleven synthetic
  nodes, theme colors, and no selection dimming or pin controls. Its Download
  PNG action reached its success notification. SVG preview and Download SVG
  also worked; editor camera and selected decision were unchanged.
- A nested Freeform scope with a negative-coordinate pin exported as 1076 × 297;
  its root overview exported as 292 × 222. Unopened child-coordinate spaces no
  longer inflate the overview image. Both nodes and the connector remained in
  the nested image.
- The original synthetic authoring map's SHA-256 stayed unchanged throughout.

The updated full suite passed **280 tests, 0 failed, 0 skipped**, on local Node
24 in an isolated synthetic-only engine copy using the serial command above.
The sample Process, Freeform+catalog, and economics snippets in the skill's
modeling reference were separately parsed successfully.

Limits: browser controls blocked `file://` navigation, so a fresh double-click
open and reopening the downloaded HTML copy were not verified. OS download files
were not reopened; the SVG/PNG previews use the same Blob bytes passed to the
download. Safari/Firefox, arbitrary hosting CSPs, GitHub Pages deployment, huge-map
memory pressure, and production were not tested. The stopped-server checks prove
offline interaction after load, not every browser/host's ability to load the file.
