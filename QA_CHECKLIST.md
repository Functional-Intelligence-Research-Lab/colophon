# Manual QA checklist — before treating this as a release candidate

This covers what I could *not* verify myself this round: I don't have a way to
authenticate to Google, load a live unpacked extension in a real browser, or
drive an actual Google Docs session from here. Everything below needs a real
Chrome + Google account. What I *did* verify directly: `npm run check` passes
clean (0 lint errors/warnings, 60/60 tests, build succeeds), and every fix in
this round was checked against a rendered preview (the popup via
`tools/preview/popup-preview.html`, and static snapshots of the side panel and
viewer) — but a rendered preview isn't the same as real usage inside Google
Docs with real AI providers.

## 1. Fresh install

- [ ] `nvm use` (picks up `.nvmrc`), `npm run build`, load `dist/` as an
      unpacked extension in a clean Chrome profile.
- [ ] Confirm the toolbar icon and the extension's entry in
      `chrome://extensions` show the new icon (round circle badge) — no
      blurry/mismatched icon at any size, and check it reads clearly at the
      smallest (16px) toolbar size.
- [ ] Open the popup with no active Google Doc tab — confirm it doesn't error,
      and the "Start recording" button is disabled with a sensible tooltip.

## 2. Recording a real session

- [ ] Open a real Google Doc, start recording.
- [ ] Type a long, ordinary paragraph (over 30 words in one sentence, and a
      keyword repeated 3+ times) and wait through a 30-second pause. Confirm
      exactly **one** heuristic suggestion appears per real issue — reopen the
      side panel a few times over a couple of minutes of continued typing and
      confirm the *same* still-present issue does **not** reappear as a
      duplicate event (this is the re-logging fix from this round — the
      easiest way to regress it silently).
- [ ] Paste a paragraph from an external source (e.g. from a browser tab, not
      copied from within the same doc) — confirm a paste event logs.
- [ ] Type a sentence containing "every", "justice", or "adjust" in isolation
      (no other filler words nearby) and confirm it does **not** trigger a
      filler-words suggestion (the substring-match bug fix).
- [ ] Use the side panel's Paraphrase/Grammar/Brainstorm quick actions against
      a real AI backend (local model or Gemini, whichever is configured) and
      confirm each produces a real suggestion card, and Insert/Accept actually
      applies it to the document.
- [ ] If Gemini's native "Help me write" is available in your account, trigger
      it and confirm it's detected — this exercises the
      `looksLikeGeminiSuggestion` regression fix from the branch merge.

## 3. Suggestions UX

- [ ] With 2+ heuristic suggestions queued, click "Review" on an *older* item
      in the timeline (not the most recent) — confirm the suggestions panel
      shows *that specific* suggestion, not whatever was last in the queue.
- [ ] With multiple suggestions queued, click "Dismiss all" — confirm the
      queue clears and the count badge disappears.
- [ ] Confirm "Next" (›) still cycles through remaining suggestions one at a
      time after a partial dismiss.

## 4. Popup verdict banner

- [ ] Before any recording: banner reads "Nothing recorded yet" (neutral).
- [ ] After a session that's mostly your own typing: banner reads "mostly
      original" with the green leaf icon.
- [ ] After a session with a roughly even mix of typing/AI/paste: banner reads
      "a mix of you and AI" (neutral gray).
- [ ] After a session where AI-derived content is the majority: banner reads
      "mostly AI-assisted" with the amber warning-triangle icon.

## 5. Export / viewer

- [ ] Click "Export" in the popup — confirm the label swaps to "Exporting…"
      then "Exported ✓" and back, and a real `.twff` file downloads.
- [ ] Click "Viewer" in the popup — confirm it opens the extension's own
      viewer (`viewer/viewer.html?live=1`) with the live session, showing the
      real brand logo in the header (not a placeholder/broken image).
- [ ] Open the exported `.twff` file at `colophon.firl.nl/viewer` too, and
      confirm it renders consistently with the extension's own viewer — both
      now share the same drift-correction engine (`lib/annotate.js`), so
      highlighting should match closely.
- [ ] Click "Export Annotated PDF" in the extension's viewer and confirm: the
      highlighted spans line up with the actual AI/paste/paraphrase text (not
      offset or overlapping neighboring text), the legend only lists
      categories actually present, and if any events couldn't be matched
      they show up in an "Unlocated events" appendix rather than silently
      vanishing. If your browser blocks the pop-up, confirm a visible error
      appears in the viewer instead of nothing happening.

## 6. Cross-platform / native host

- [ ] On a machine *without* Python pre-installed (or a fresh VM), use the
      side panel's "Download setup file" flow and confirm it completes with
      no Python install prompt anywhere — the native host now ships as a
      compiled binary (`native-host/build_native_host.py`, Nuitka), so this
      should just work on a bare machine. Test on Windows and macOS too —
      only a Linux build has been produced and tested so far.
- [ ] Confirm the extension still works normally (recording, heuristics,
      export) with the native host *not* installed — local-model-dependent
      features should degrade gracefully, not break the rest of the UI.

## 7. Edge cases

- [ ] A very long document (5,000+ words) — confirm heuristics still run
      without noticeably freezing the tab, and the side panel timeline stays
      responsive.
- [ ] A non-Google-Docs page — confirm the popup shows a sensible disabled
      state rather than erroring.
- [ ] Offline / native host unreachable — confirm error states are handled
      (the model-availability dot, any error cards) without leaving the UI in
      a stuck "loading" state.

## 8. Visual consistency spot-check

- [ ] Open the popup, side panel, and viewer side by side. Confirm the own/AI/
      paste colors match across all three (green/purple/amber, consistent
      with colophon.firl.nl's palette) — this was a real, confirmed bug before
      this round (4 different purples, 6 different greens across just the
      popup).
- [ ] Confirm the settings gear looks identical in the popup and the side
      panel (same glyph, not two different icon styles).
- [ ] Open the Settings page and confirm "Gemini API key" shows a dimmed,
      disabled "Soon" state and can't be selected.

## 9. Clean uninstall (reset to a truly clean state before re-testing fresh install)

Needed between repeated fresh-install QA passes so leftover state from a previous run
doesn't mask a real bug (or fake a pass). Native-messaging host id is
`com.colophon.llamahost` throughout.

- [ ] Remove the extension via `chrome://extensions` — this clears all of
      `chrome.storage.local` (`settings`, `session`, `sessions`, `currentSession`,
      `authorId`, `llamafilePort`). No IndexedDB/localStorage is used anywhere in this
      extension, so nothing else persists in the browser after this step.
- [ ] Remove the native-messaging registration + installed host binary:
  - **macOS/Linux**: delete whichever of these exist —
    `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.colophon.llamahost.json`,
    `~/Library/Application Support/Chromium/NativeMessagingHosts/com.colophon.llamahost.json`,
    `~/.config/google-chrome/NativeMessagingHosts/com.colophon.llamahost.json`,
    `~/.config/chromium/NativeMessagingHosts/com.colophon.llamahost.json` — then
    `rm -rf ~/.colophon/native-host`.
  - **Windows**:
    `reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.colophon.llamahost" /f`,
    then delete `%APPDATA%\Colophon\native-host\`.
  - See `native-host/README.md`'s "Uninstall" section for the authoritative version of
    these steps.
- [ ] Remove the downloaded local model: `rm -rf ~/.colophon/models` (the llamafile/
      llamafile.exe runtime, the ~770 MB GGUF model, `llamafile-stderr.log`, and any
      stray `*.tmp` partial downloads left by an interrupted install).
- [ ] Before rebuilding from scratch, run `rm -rf dist` first. `npm run build` does
      **not** clean `dist/` — it only copies files in, so stale artifacts from an older
      build silently persist (e.g. a leftover `dist/native-host/install.sh`/
      `install.ps1` from before those legacy scripts were removed from source). Confirm
      a fresh `dist/native-host/` contains no `install.sh`/`install.ps1` after rebuilding.

## Before actually submitting to the Chrome Web Store

This checklist covers functional/visual regressions from this round's
changes. It does **not** cover Store submission itself — see
`firl-infra/READINESS.md` for what's still deferred there (branch is ready to
package as of this round, but store listing assets, permission
justifications, and the native-messaging distribution question are still
open).
