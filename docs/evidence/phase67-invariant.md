# "No new fields ⇒ identical render" invariant — Phases 6+7

Method: the pre-change code (git worktree at HEAD `613b1f8`) and the overnight
working tree served the same maps on two ports in one browser session
(1440×900, fresh module loads, fit camera). SHA-256 over the rendered
`#viewport` transform + full innerHTML:

| view | old code (HEAD) | new code | match |
|---|---|---|---|
| insurance root | `09b1a0b2bf4e227f…c1c0efc5` (18,330 bytes) | same hash, same bytes | ✅ byte-identical |
| stress-120 root (120 nodes) | `76fe3c04536a0d02…2fbe7121` (34,199 bytes) | same hash, same bytes | ✅ byte-identical |

Neither map carries `cost:`, `costModel:`, or importer output — the new
features are purely additive. (Full hashes in the session log; the check is
reproducible with the worktree + two-port method described above.)
