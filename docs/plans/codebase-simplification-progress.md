# Simplification closeout checklist

Branch: `feature/codebase-simplification`. Approved scope: [original plan](codebase-simplification.md).

Latest code: `c6fa425`. Node 22 `npm test` at `af11318` (R2–R5): **278/278**, zero failures/cancellations/skips, exit 0 (`.pi/validation/r2-r5-full.{log,exit}`); `c6fa425` changes one CSS rule only (no JS/test change). Independent review of R2–R5: one finding (`.session-mode`/`.session-context-row` lost borders) — verified as dead CSS with no markup users and deleted in `5420ec7`; all other areas confirmed. Further section-by-section CSS consolidation beyond the reset removal is intentionally not pursued: visual risk without behavioral gain. Earlier gates (R1 277/277, A1 batches, C/D/H/A items) remain complete. No push, main merge, deployment, installs, or production/configuration changes are authorized.

## Done

- [x] C1–C6: fail-closed Git status, archive parsing/rollback reporting, concurrent close, stale selection, device-flow races, settings/extension drafts.
- [x] D1–D5: unused code/state/modal removal, documentation cleanup, native isolated test runner.
- [x] H1–H2: reproducible packaging (Playwright retained), exact restart cwd verification. Live-provider verification remains unperformed.
- [x] A2–A4: legacy merge retirement, v1 status-fallback retirement, image-publish test gate. Remote CI is not claimed.
- [x] A1 completed stages: async parsers/readers and state snapshots, repository admission, push/pull, branch creation, switch/main return.

## Remaining — frozen scope

- [x] A1 batch 1: async `merge-local` **and standalone branch deletion**, including discovery, preparation, merge, rehome/bindings, removal/deletion and cleanup. Preserve admission, fail-closed status, late streaming/sync/workspace guards, reporter/error contracts and files/refs on refusal. Reload authoritative bindings across awaits; rehome failure prevents source cleanup.
- [x] A1 batch 2: async legacy worktree/stash transfer request path; preserve tracked, untracked, staged changes and explicit force behavior. Failed target application cleans up only unused newly created worktrees; failed source restoration retains the backup stash and target.
- [x] R1: split server route registration by resource using one plain dependencies object; preserve exact route inventory. Six logical move commits each remain below approximately 800 changed lines; the facade retains per-build admission/sync/auth closures.
- [x] R2 (`2b36a03`): panels split into seven component modules with registration beside classes; `panels.js` stays an import facade. PWA test walks the ESM graph against the shell cache; real service-worker install + offline reload registered all components; settings, files, extension-draft and session-picker flows passed; 8/8 baseline screenshots byte-identical.
- [x] R3 (`6d294f7`): `applyEvent` delegates to `applyUiEvent` (early-return UI families) and `applyTranscriptEvent` (sequenced switch); sequence gate, trailing refresh and notify unchanged and synchronous.
- [x] R4 (`70e2575`): pure compaction/tool/diff record builders extracted; emissions, live-record maps and settlement stay in `_onEvent`. R2–R4 focused suites 54/54.
- [x] R5 (`af11318`, `c6fa425`): global `border: 0 !important` reset removed with the suppressed non-button border declarations and restoration `!important`s; a `:where()` reset covers UA-bordered form elements. Computed borders for every element matched across 60 states (375/1280 × dark/light × 15 UI states); 56/60 screenshots byte-identical, the 4 file-panel differences come from live mock Git status. A hover/focus sweep of 168 controls caught one cascade change (session-picker danger button hover), fixed in `c6fa425` and re-verified at 0 differences.

Nothing is silently deferred. Any proposed scope deferral needs user agreement.

## Execution and completion

One implementation owner. Reuse helpers/fixtures; no unrelated fixes or architecture. Focused Node 22 tests use two workers during editing, one bounded independent exact-diff review per cohesive batch, one integrated full suite (600-second allowance) per batch. Completed gates are not repeated without changed code or contrary evidence. Failures require captured diagnostics and a specific correction/hypothesis before another attempt; external blockers get a precise report.

Done means all remaining checkboxes resolved, reviewed code committed locally, final suite green, and one concise handoff. Historical ledger is preserved in Git at `22547b1` and locally at `.pi/validation/codebase-simplification-history.md`; all `.pi/validation` evidence remains untracked and preserved.
