# Design decisions informed by Lucidchart review themes

This is not a feature checklist. It records the recurring friction themes we
used to set the product direction for Serigraph: an operations map should remain
legible, portable, and easy to operate when it becomes the shared source of
truth for an automation program.

| Recurring review theme | Serigraph response |
| --- | --- |
| Large or multi-layered diagrams can become slow or hard to orient. | Semantic level-of-detail removes secondary node copy at overview zoom, while the minimap, owner lanes, and Path probe make a specific flow legible without hiding its surrounding context. |
| Advanced diagramming functions can be hard to discover. | The grouped tool rail makes the editing vocabulary visible: move, make, connect, structure, and inspect. Every tool has a tooltip, shortcut, and a single-purpose mode. |
| Collaboration, permissions, and review context can be cumbersome. | Review notes live with the YAML node they describe, have a clear resolved/open state, and support deep links directly to the step in question. |
| Teams want exportability and object limits can force an upgrade. | The map remains plain YAML, offers a direct YAML download and a self-contained HTML export, and has no artificial object cap. |
| Mobile editing and selection can be limited. | At small widths, the tool rail becomes a touch dock and inspectors/review trails become bottom sheets rather than overflowing desktop panels. |
| People ask for clearer version comparison/recovery. | Every successful local edit, undo, and redo records a browser-local recovery point; the latest 30 are available from Revision recovery. |

## Sources consulted

- G2, [Lucid Visual Collaboration Suite reviews — pros and cons](https://www.g2.com/products/lucid-software-inc-lucid-visual-collaboration-suite/reviews?qs=pros-and-cons): repeated comments about complexity, permissions, large diagrams, offline use, and version comparison.
- Capterra, [Lucidchart reviews](https://www.capterra.com/p/146136/Lucidchart/): reported performance and speed issues for large diagrams and slower connections.
- Apple App Store, [Lucidchart reviews](https://apps.apple.com/au/app/611543423?platform=iphone&see-all=reviews): reported iPad limitations and difficulty with grouping, resizing, and sharing.
- Reddit, [Lucidchart alternative discussion](https://www.reddit.com/r/salesforce/comments/1sqgo20/lucidchart_alternative/): pricing and data-compliance concerns raised by practitioners.
- Reddit, [export error discussion](https://www.reddit.com/r/software/comments/1l5wyk2): export friction on a larger image test.

The sources are directional qualitative feedback rather than a scientific
ranking. Each response above is deliberately useful even when the underlying
complaint is experienced by only part of a team.
