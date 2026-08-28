# `@bry-guy/pi-sync`

Reusable client and Pi package from bry-guy for the `pi-syncd` v1 conversation
synchronization protocol. It wraps and extends Pi from
`@earendil-works/pi-coding-agent`. The package includes the native Pi JSONL adapter,
`/sync` extension,
and `synchronized-workspace` skill.

This vendored snapshot is based on the upstream revision recorded in
`UPSTREAM_COMMIT` and includes the pi-ez-web browser-host integration patch.
The extension expects `PI_SYNC_SERVER_URL` (or `PI_SYNC_URL`) and is intended
to be installed as a trusted Pi package. Use `/sync start` to enroll a local session,
`/sync` to open one, `/sync refresh` to pull the canonical copy, or
`/sync status` to inspect the binding. Synchronized names are sticky. Git
upstream, branch, and pushed-commit pointers travel with the session; the `/sync`
picker is limited to the current normalized repository remote when Git
information is available. Branch and commit mismatches are reported without
changing Git. Lease tokens are device-local state; they are never written to
synchronized session entries or Git metadata.
