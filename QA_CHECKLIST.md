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
      `chrome://extensions` show the new icon (green Φ mark) — no blurry/
      mismatched icon at any size.
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
      confirm it renders consistently with the extension's own viewer.

## 6. Cross-platform / native host

- [ ] On a machine *without* Python pre-installed (or a fresh VM), attempt the
      native-host install flow (`native-host/install.sh` / `install.ps1`) and
      confirm what actually happens — this is a known, already-tracked gap
      (see `firl-infra/READINESS.md`'s "blocking packaging" section), so the
      goal here is to document the actual failure mode, not to fix it in this
      pass.
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

## Before actually submitting to the Chrome Web Store

This checklist covers functional/visual regressions from this round's
changes. It does **not** cover Store submission itself — see
`firl-infra/READINESS.md` for what's still deferred there (branch is ready to
package as of this round, but store listing assets, permission
justifications, and the native-messaging distribution question are still
open).
