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

PRs and issues are separate first-page samples of up to 10 updated entries. The
issues endpoint includes PRs; those are excluded, so this page is not a total or
proof there are no other issues. Individual list failures remain unavailable.
PR check inspection first reads that PR's current head, then at most 10 check runs
and 10 status contexts for that SHA. Required/merge-ref coverage remains unknown.
Refreshing a list that changes or no longer covers the inspected head invalidates
its current interpretation. Details are on demand, not fetched for every PR.
GitHub's summary endpoints may include body fields in their JSON; the reader
discards them and makes no requests for comments, diffs, logs or attachments.

## Refresh and limits

- One 10-minute timer runs only with a bound map open in the foreground Map view.
  Hidden tabs, another view/map, removal of the last binding, and home stop it.
  Browser requests are aborted and late results discarded. An already-started
  bounded server read may finish for another consumer; the server never polls.
- Manual/automatic reads share in-flight work and a 60-second snapshot cache.
  Cached results keep their original fetch time. ETags conditionally validate up
  to 24 small metadata-only endpoint entries; at most 8 snapshots are retained in
  process memory, with no database or persistence.
- Each repository refresh takes at most 5 GitHub requests; one inspected PR takes
  at most 3. The process enforces 40 requests per rolling hour, including conditional
  requests. Ten-minute polling normally uses 30/hour, leaving a small manual budget.
  Other tools on the same IP can still consume GitHub's unauthenticated allowance.
- Rate-limit/reset and Retry-After headers pause reads. Other failures use bounded
  exponential backoff. No browser retries before the reported pause expires;
  automatic retries remain conservative. Old successful data retains its timestamp,
  an observation older than 10 minutes is stale, and fetch failure is not CI failure.
- Open inspector sections and camera stay put across refresh. PR evidence is
  fetched on demand and explicitly names its captured head and time; a subsequent
  list that no longer covers that head invalidates it.

The source API behavior follows GitHub's [workflow run documentation](https://docs.github.com/en/rest/actions/workflow-runs)
and [rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Verification

Use a synthetic development library for browser checks. The automated checks use
synthetic responses for head qualification, private/invalid/oversized/denied reads,
safe links, response minimization, issue/PR separation, PR head qualification,
conditional caching, deduplication, budget/backoff/recovery and hidden/map-switch
late-response handling. Reuse the existing standalone export and
geometry checks. Do not commit raw API responses or private source data.

The September 5 local app read was compared directly with the public repository:
its observed head and the Test / Pages workflow identities and conclusions agreed.
This verifies the public read, not private authentication or production health.
