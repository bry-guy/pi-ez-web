# Test layout

`npm test` runs each child with `--test-concurrency=2`; `run-suite.js` permits at most two child Node test processes, with one test file per child. This keeps the Git-backed integration tests bounded without changing runtime behavior.

The original server integration matrix included these Git route permutations. Their important contracts remain covered elsewhere:

| Removed route coverage | Retained coverage |
| --- | --- |
| Merge success, cleanup, dirty-worktree handling, and conflict rollback | `lifecycle-merge-*.test.js` |
| Worktree creation/removal and main-worktree safety | `server-project.test.js`, `workspaces-discovery.test.js`, `workspaces-safety.test.js` |
| Git context discovery and branch/worktree mechanics | `workspaces-discovery.test.js`, `workspaces-safety.test.js` |
| Push, pull, repeated switch, remote-branch, and shared-session permutations | Intentionally omitted as redundant integration permutations |

The lifecycle tests keep all close, merge, refusal, conflict, and parent/child archival assertions. Each test gets a fresh server and repository through `helpers/isolated-server-fixture.js`, preventing repository inventories from accumulating across cases.
