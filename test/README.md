# Test layout

`npm test` runs top-level `*.test.js` files with Node's test runner, capped at two concurrent processes. Each file remains isolated in its own process, keeping environment changes and Git-backed fixtures separate.

The original server integration matrix included these Git route permutations. Their important contracts remain covered elsewhere:

| Removed route coverage | Retained coverage |
| --- | --- |
| Merge success, cleanup, dirty-worktree handling, and conflict rollback | `lifecycle-merge-*.test.js` |
| Worktree creation/removal and main-worktree safety | `server-project.test.js`, `workspaces-discovery.test.js`, `workspaces-safety.test.js` |
| Git context discovery and branch/worktree mechanics | `workspaces-discovery.test.js`, `workspaces-safety.test.js` |
| Push, pull, repeated switch, remote-branch, and shared-session permutations | Intentionally omitted as redundant integration permutations |

The lifecycle tests keep all close, merge, refusal, conflict, and parent/child archival assertions. Each test gets a fresh server and repository through `helpers/isolated-server-fixture.js`, preventing repository inventories from accumulating across cases.
