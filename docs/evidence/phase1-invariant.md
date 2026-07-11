# Phase 1 — "no position data ⇒ identical rendering" proof

Method: render the same map on two servers in the same browser session —
port 4750 serving the pre-change code (git worktree at d758d31) and port 4700
serving the new code — and compare the rendered SVG element-by-element
(SHA-256 of each node group's outerHTML incl. container miniatures, each edge
group's outerHTML, and the viewport camera transform).

Maps with zero `position:` fields, at 1440×900, fresh loads:

| view                          | result |
|-------------------------------|--------|
| insurance (12 nodes, flat)    | viewport transform + full innerHTML hash byte-identical |
| stress-120 root (seed-7 map)  | all 8 node groups, all 8 edge groups, camera: identical |
| stress-120 in n1-1 (nested)   | all 8 node groups, all 8 edge groups, camera: identical |

stress-120 is regenerated deterministically:
  node tools/generate-map.mjs --nodes 120 --depth 3 --seed 7 --name "Stress 120" --out maps/stress-120.yaml

A drag writes exactly one line. From this session (docs/evidence/phase1-insurance-drag.diff):

  +    position: { x: 696, y: -295 }

— the only changed line in the file; all comments and single-line formatting
preserved (serializer runs with lineWidth: 0 so untouched long lines never
re-wrap); validator passes; releasing the pin returns the file byte-identical
to git HEAD.
