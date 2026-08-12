# Accessibility smoke contract

## Automated acceptance

`packages/vscode-extension/test/webview-assets_test.ts` and the controller and
transport tests enforce:

- conversation log, dialog, list/listitem, tablist/tab/tabpanel, menu, switch,
  alert, and status semantics;
- roving tab stops and arrow/Home/End navigation for inspector tabs and session
  markers;
- keyboard-visible message actions and focus-visible outlines;
- modal focus trapping and restoration to the invoking control;
- polite completion/status announcements and assertive permission/question
  regions;
- configurable Enter behavior;
- reduced decorative motion without hiding operational progress;
- forced-colors/high-contrast focus and selected-state boundaries;
- no action that is reachable only by pointer hover.

Run:

```sh
deno task test:harness:ux
```

## Extension Development Host smoke

This is the release smoke procedure for a platform screen reader; it does not
require a model request.

1. Enable VS Code Screen Reader Optimized mode and open OpenCode Chat in the
   sidebar and editor.
2. Tab through the header, session picker, conversation actions, inspector,
   composer, and right rail. Confirm every focused action has a name and no
   pointer-only action is missing.
3. Open and close session history, Needs Attention, attachment preview, the
   model picker, and **Send to multiple models** with keyboard only. Confirm
   focus is trapped while a modal is open and restored to a visible control
   after Escape.
4. Use arrow keys plus Home/End in inspector tabs and session markers. Confirm
   one roving tab stop and the selected/current state are announced. Repeat in
   the multi-model checkbox list and confirm Space does not lose focus.
5. Trigger synthetic streaming, completion, error, permission, question,
   reconnect, and queued-message states. Confirm announcements are concise and
   do not reread the full transcript.
6. Load one older-history page, start and cancel **Load all**, and confirm focus
   moves into the transcript when the history controls disappear. Mark all
   Needs Attention items as read and confirm they remain listed as acknowledged
   while the unread badge clears.
7. Change `opencodeWorkbench.enterBehavior` between `send` and `newline` and
   verify Enter, Shift+Enter, and Ctrl/Cmd+Enter.
8. Repeat in a VS Code high-contrast theme and with reduced motion enabled.
9. Open **Changes**, choose **Review all changes**, and confirm a native
   multi-file editor opens with named before/current resources rather than
   Untitled documents. Mark one file reviewed, modify its reported patch, and
   confirm the acknowledgement clears. Open **Timeline** for a workspace file.
   For an external-file edit, confirm the transcript identifies the patch-only
   review path and does not claim to open a native file comparison.

The repository gate proves the semantic and state-transition contract in a
headless environment. Actual speech output varies by VS Code, OS, and assistive
technology, so this platform smoke remains part of release validation rather
than a claim that can be fabricated by unit tests.
