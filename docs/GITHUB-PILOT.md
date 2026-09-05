# Public GitHub node pilot

Enable explicitly: `SERIGRAPH_GITHUB_PILOT=1 npm start`. Open **Serigraph development**,
select its repository node, and choose **Connect jross787/serigraph**. Use a separate
development library, not a private business map. For an external library, copy the
generic `maps/serigraph-development.yaml` there before starting the engine.

This pilot permits only `jross787/serigraph`, branch `main`, through fixed GitHub
metadata operations. It uses no credentials, ambient GitHub token, remote icon
requests, or dependency installation. It cannot write to GitHub. It is not a
private-source authorization boundary, agent harness, or universal connector SDK.

## Small contract

- Binding: browser-local node IDs under `serigraph:github:<libraryId>:<mapId>`.
  The opaque server library identity prevents reconnecting another workspace with
  the same map ID. Disconnect removes the binding. Copying a map does not copy it.
- Observation: source repository/branch, observed head SHA and capture time,
  source commit/run times, fetch time, bounded run metadata, and coverage limits.
- Rendering: the node indicator and existing inspector read the same ephemeral
  result. Changes do not serialize into YAML, resize cards, or move the camera.
  Standalone HTML, SVG/PNG export and print omit live observations.
- Transport: server-side GETs to fixed `api.github.com` paths, no redirects,
  8-second timeout and 512 KiB maximum per response. Returned text is untrusted;
  source links are constructed from the approved repository and validated IDs.
  Raw responses, logs, artifacts, attachments and credentials are not stored.

Current CI means runs whose SHA equals the captured branch head, not an inference
from the latest successful run. Only the newest run per workflow in the bounded
sample contributes to its summary. Missing checks are unknown. Source event time
and fetch time are different; neither a passing sample nor API connectivity proves
production health or merge readiness. Reads are not an atomic GitHub snapshot.

## Verification

Use a synthetic development library for browser checks. The automated checks use
synthetic responses for head qualification, private/invalid/oversized/denied reads,
safe links and response minimization. Reuse the existing standalone export and
geometry checks. Do not commit raw API responses or private source data.

The September 5 local app read was compared directly with the public repository:
its observed head and the Test / Pages workflow identities and conclusions agreed.
This verifies the public read, not private authentication or production health.
