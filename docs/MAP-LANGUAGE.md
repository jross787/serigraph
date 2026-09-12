# Map language

Serigraph uses one small vocabulary for process maps, organizational
relationships, and system landscapes. It is a Serigraph convention, not a claim
of BPMN/UML conformance. The same names appear in Add, the inspector, and
**More → Map language**. The exact portable fields are in [FORMAT.md](FORMAT.md).

## What a shape says

| Shape | Object | Naming cue |
| --- | --- | --- |
| Rounded rectangle | Step | A verb: Review request |
| Diamond | Decision | A question: Ready to proceed? |
| Circle | Event | Something occurred: Request received |
| Capsule | Person or team | The actor: Service team |
| Window | Application | The tool: Work console |
| Cylinder | Data store | The storage: Request database |
| Hexagon | Interface / API | The interface: Requests API |
| Folded document | Document or data | The input/output: Completion record |
| Neutral card | Concept | A thing without a more specific category |
| Stacked card | Group/sub-map | A boundary that contains more objects |

A description explains the object in the inspector. It is not a new node type
and not a branching rule. A decision is an object; each answer is a labeled
outgoing process-flow connection to another object in the same scope. More than
two outcomes and return paths are valid. No answer is guessed as Yes or No.

Triangles are reserved for warnings/attention, not business-object categories.
This pass does not add a triangle node or infer an issue from shape or color.
Category color, selection, declared risk, provenance, and observed health remain
different concepts. Unknown is not healthy.

Existing peer-card dimensions and pins remain stable. Events are new 112-pixel
circles. Diamonds and circles keep long descriptions and links in the inspector;
other ordinary cards retain compact authored summaries. Shapes do not grant
access to systems or trigger a model/runtime call.

## What a connection says

| Appearance | Meaning | Label cue |
| --- | --- | --- |
| Solid arrow | Process flow | What happens next; a decision's answer |
| Dashed arrow | Data transfer | The payload or declared delivery |
| Solid arrow toward manager/parent | Reports to | Organizational accountability |
| Plain line, no arrowhead | Association | Uses, supports, belongs with |

An arrowhead always communicates direction, not proof of execution. Process flow
and reporting lines are intentionally the same simple stroke; their explicit
meaning, endpoint categories, label, and inspector disambiguate them. A reporting
arrow goes **person/team → manager/parent**, regardless of screen orientation.

The separate `kind` field declares a data-transfer method: API, file, manual
entry, or event/webhook. An API *object* is an interface; an API *method* is how a
declared transfer would use one. Neither is a verified transfer. Process-path
tracing and the Flow scene exclude explicit associations/reporting lines.

Existing maps are not automatically reclassified. A missing `meaning` keeps the
existing arrow and says “meaning unspecified” in the inspector. Opening a map,
changing Appearance, or reading the guide does not rewrite its YAML. Different
meanings between the same endpoints are distinct relationships, not duplicates.

## Decisions and editing

Select a diamond. Its Outcomes list pairs each unique label with a destination
in the current scope. Add/remove rows or choose a different destination, then
**Apply outcomes**. Until Apply, it is an unsaved draft. Save/⌘S reminds you to
apply an open draft rather than claiming it was persisted. Applying the list is
one existing undoable save; Undo restores the previous list, routes, and labels.

Existing branch route overrides and YAML comments survive. Other outgoing
relationship meanings and incoming edges are untouched. In Freeform, this edits
only the current group's placement connections, not the shared definition or
its appearances in other groups. No workflow is executed.

## Menus and appearance

- **File:** Save, Open map, Load YAML, Import transcript, Save a YAML copy,
  PNG/SVG/interactive HTML/Markdown export, and version history. Applied changes continue
  to autosave through the same conflict-protected pipeline.
- **Add:** plain-language object names with a one-line explanation. At the
  Freeform root it adds a Group; inside a group it adds a shared-element
  placement. There is no second data model behind the shape picker.
- **Connect:** choose a meaning, then the origin and destination. Its inspector
  exposes meaning, label, endpoints, optional transfer method, attachment sides,
  and route shape separately.
- **More:** the visual-language guide, Templates, Appearance, and the existing
  secondary investigation/review tools.
- **Appearance:** Frost (warm ivory surfaces over an opaque dark canvas), Paper,
  or Night. The browser remembers the choice; it is not map data. Existing saved
  Paper/Night choices are respected; Frost is the default for a fresh browser.

Frost uses restrained translucency for controls, solid legible map cards, system
fonts, and existing reduced-motion behavior. A reduced-transparency preference
receives solid controls. The toolbar and floating panels share measured spacing;
panel titles start below the toolbar rather than underneath it.

## References and limits

Common shapes/edge styles were cross-checked against the
[Mermaid flowchart reference](https://mermaid.js.org/syntax/flowchart.html).
Serigraph's simpler meanings above are local product decisions, not definitions
borrowed wholesale from a diagram standard.

The outside-bend correction removes adjacent backtracking while retaining the
requested via point and attachment sides. It scores a bounded set of elbows;
it is not a general all-obstacle router or a guarantee that every dense map has
collision-free labels. See the [verification record](MAP-STUDIO-VERIFICATION.md)
and the [portable export guide](EXPORTS.md).
