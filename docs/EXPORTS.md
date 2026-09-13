# Portable map exports

Use the map toolbar's **File** menu. Export creates a snapshot, not a published
page, a live connection, a source correction, or an operational audit report.
Applied edits are included; unapplied inspector/dialog drafts are not. HTML
generation does not save the map or read sibling map files.

## Interactive HTML

**Export interactive map · HTML** downloads one self-contained, read-only file.
It embeds the whole YAML source, CSS, icons, Dagre, and application modules.
There is no CDN, app-server, account, build step, or adjacent asset folder needed
to explore that file. Share & sync also offers **Download interactive HTML**.
The exported viewer can download another HTML copy without contacting a server.

The viewer retains map navigation, nested scopes, search, inspectors, declared
catalog data, and the applicable Process views. Editing, server-side AI import,
agents, synchronization, and live observations are unavailable. Flow animation
is illustrative, not captured telemetry. Explicit external reference links still
need network access when opened; they are not bundled copies of those sites.

Open the file in a current browser that supports ES modules, import maps, and
JavaScript `data:` module URLs. [Import maps are widely supported in modern browsers](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap);
older browsers, restrictive CSP/sandbox settings, email
attachments, and many document-preview panes may block execution. Download and
open the file in a browser, or use an ordinary static host. Read-only is not
redaction, encryption, or an access-control boundary.

### Generate from another repository

```sh
node /absolute/path/to/serigraph/tools/export.mjs /absolute/path/to/library/maps/request-flow.yaml --out /absolute/path/to/output/request-flow.html
```

Requires Node.js 18+ and a current Serigraph checkout. No server, installation,
provider settings, or current-working-directory convention is required. The tool
validates only the supplied file. The destination folder must already exist;
an existing output produces an error and is left intact. Choose another filename.

The legacy `/export/<map-id>.html` URL exports the saved file on disk;
`?preview=1` displays it inline. The legacy `/export/project/<slug>.html` URL
embeds the lead map plus project-index metadata, **not every sibling map's
source**. Use separate map exports when handing off a multi-map project.

## SVG and PNG

Each image action opens a preview with **Open full-size preview** and a
**Download SVG/PNG** button. The preview and download use the same image bytes.

Images capture the **current Map scope**, including its rendered sub-map
thumbnails and peer context, not every unopened scope on separate pages and not
Flow's 3D scene. Pan/zoom does not crop the export. Navigate to the desired scope
first. Current theme colors and fonts travel in SVG; no page stylesheet is needed.
Selection, focus dimming, path-probe highlights, edit controls, and live GitHub
observation badges are excluded without changing the editor's selection or camera.

SVG stays sharp at any scale and is useful in repository READMEs and print.
PNG is broadly supported by presentation, chat, and document tools. PNG uses up
to 2× resolution, capped at 8192 pixels per side and roughly 16 megapixels to
bound browser canvas memory. Larger maps downscale; choose SVG for maximum
detail. Both include a background matching the current map theme.

Board notes and freeform text use native SVG text, including their Markdown
typography. Fonts use local fallback stacks, so exact faces may vary by machine.
Resize clipped notes (or use **Fit text**) before exporting; image exports show
the authored block size. Resize/anchor handles are omitted from image exports.

## YAML and Markdown

YAML preserves the complete authoring source, comments, IDs, catalog metadata,
and layout overrides. It is the backup/interchange format.

Markdown provides a readable all-scope inventory, owners, relations, review
notes, placement notes, connections, and declared catalog mappings. Product
maps also include their Brief/requirements content.
Board annotations appear as fenced Markdown source so literal HTML/image syntax
does not become active content when the documentation is opened.
It is not a lossless format: use YAML for exact comments, layout, and all optional authoring fields. The
existing Brief-only **Download Markdown** remains available for a focused PRD.

## GitHub and privacy

Use an SVG/PNG in a README, for example `![Request flow](request-flow.svg)`.
GitHub's repository file view displays source or a supported preview; it does
not run an uploaded HTML application's JavaScript. Use
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
or another static host for the interactive file. Pages hosting is a separate,
explicit publishing decision; exporting does not configure it.

HTML and YAML contain the whole map, including nested descriptions, comments,
links, ownership, review notes, and declared data catalog. Markdown includes
substantial metadata too. Inspect the artifact before sharing, especially when
the visible canvas looks innocuous. Runtime observations, provider credentials,
browser-local history, and Workbench share keys are not added by the exporter;
secrets or records already authored in YAML would still be included.

Never put business-specific maps, schemas, endpoint configuration, credentials,
PHI, or real records into the public engine repo or public hosting. Use approved
private destinations. Confirm access and deployment separately from a successful
local download.
