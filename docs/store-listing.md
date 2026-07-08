# Chrome Web Store listing copy

Reference copy for the Store submission form — permission justifications and the
`nativeMessaging` explanation the review process asks for. See `firl-infra/READINESS.md`
for the rest of the submission checklist.

## nativeMessaging explanation

Colophon can optionally run its AI writing assistance (paraphrase, grammar, brainstorm
suggestions) entirely on your own computer instead of sending text to a cloud API. Doing
that requires a small companion program (the "native host") — Chrome extensions can't
launch programs on your machine directly, and `nativeMessaging` is the permission that lets
the extension start this companion and exchange messages with it over your machine's local
pipe.

This is entirely optional. Recording your writing session and the heuristic suggestions
(long-sentence, filler-word, repetition checks) work with no companion program at all. Only
the local-AI assist features need it, and the extension works normally without them if you
skip setup or decline the permission's effects.

The companion's full source ships inside the extension package at `native-host/host.py`
(the compiled binary you actually run is built from this exact file via Nuitka — see
`native-host/build_native_host.py`), so a reviewer or a technical journalist can verify
directly what it does: it downloads exactly two files (the `llamafile` runtime and a small
GGUF model) over HTTPS from their official sources, binds the resulting local model server
to `127.0.0.1` only (never reachable from your network), and accepts exactly four actions
(`CHECK_MODEL`, `DOWNLOAD_MODEL`, `LAUNCH_MODEL`, `STOP_MODEL`) — anything else is rejected.
It never sends anything to Colophon's own servers or anywhere else.

## Permission justifications

**`nativeMessaging`** — see the explanation above. Powers the optional local-AI companion
program; recording and heuristic suggestions do not require it.

**`scripting`** — used to (re-)inject the content script into a Google Docs tab that was
already open before the extension was installed or reloaded. Chrome does not automatically
inject content scripts into pre-existing tabs, so without this permission a user would have
to manually refresh every open Doc tab after installing.

**`downloads`** — used for two user-initiated actions only, never automatically: exporting
a recorded session as a `.twff` file to the user's Downloads folder, and staging the
native-host setup files (the platform binary + a small setup script) during the optional
local-AI setup flow described above.

**`contextMenus`** — adds a right-click menu entry inside Google Docs for starting or
stopping a recording session without needing to open the toolbar popup.

**Host permission: `https://docs.google.com/*`** — Colophon's entire feature set (recording
writing activity, heuristic suggestions, AI-interaction detection) only operates inside
Google Docs. No other site is requested or accessed.
