# Browser release checklist

Run `mise check` first, then run the mock server with `mise dev` and register
the checkout with `mise dev-project`. The DOM suite is automated, but jsdom
does not paint pixels; complete this click-through in a real browser before a
release.

- [ ] Empty chat and project session mount; desktop and 390px mobile layout.
- [ ] New chat, send, thinking π, streaming caret, completion, stop during
      thinking, steer, and follow-up.
- [ ] Bang command renders and remains present after a transcript reload.
- [ ] Tool and diff blocks expand/collapse; fork creates the child session,
      truncates before the selected message, and preserves the draft.
- [ ] Branch popover opens, switches, creates a branch, rejects occupied
      branches, and names the occupying session.
- [ ] Merge confirmation Go back, successful merge, dirty/error callout, and
      close confirmation/fallback selection.
- [ ] Repository picker opens, filters without losing focus, closes, and
      connects a repository from a row.
- [ ] Sidebar search filters projects, sessions, and chats without losing
      focus; keyboard Enter/Space activates rows/cards/headers.
- [ ] Model chip and Settings cycle the registry-backed mock models; changing
      sessions shows the correct model.
- [ ] File panel follows session, branch, merge, and project changes; directory
      rows toggle and file rows remain inert.
- [ ] Mobile drawer, scrims, mini rail, file sheet, and modal sheets behave at
      the target breakpoint.
- [ ] No console errors or page errors during the pass.

Record the date, browser, commit, and any skipped item in the release notes.
A passing `npm test`/`mise check` is necessary but does not replace this
visual pass or the credentialed `mise verify` gate.
