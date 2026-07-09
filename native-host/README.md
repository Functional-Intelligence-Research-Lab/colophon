# Colophon Native Host — Setup

The native host lets the Colophon extension download and run a local AI model (llamafile)
on your machine, entirely optionally — recording and heuristic suggestions work without it.

## Requirements

- Chrome extension loaded
- **No Python required.** The host ships as a compiled binary (`colophon-host`/
  `colophon-host.exe`, built from `host.py` with Nuitka — see `build_native_host.py`), so
  there's no interpreter or dependency to install first.

## Install (one-time)

Open the Colophon side panel and click **"Download setup file"** under the local-AI
banner. This downloads two files: the platform-correct `colophon-host` binary (already
bundled inside the extension) and a small setup script
(`colophon-setup.bat`/`colophon-setup.command`). Run the setup script once — it unzips the
binary into `%APPDATA%\Colophon\native-host` / `~/.colophon/native-host`, and registers it
as a native-messaging host with Chrome. Then click "Check again" in the side panel.

There is no separate manual `install.sh`/`install.ps1` path anymore — the side panel flow
above is the only supported install path, since it no longer needs a system Python to
detect or fall back on.

## What the host does

| Action | Description |
| --- | --- |
| `CHECK_MODEL` | Reports whether llamafile + model GGUF are present in `~/.colophon/models/` |
| `DOWNLOAD_MODEL` | Downloads llamafile runtime and Llama 3.2 1B model (~720 MB total) |
| `LAUNCH_MODEL` | Starts llamafile as a local HTTP server on `127.0.0.1:8080` |
| `STOP_MODEL` | Stops the running server |

## Security

- All network calls are HTTPS only
- llamafile is bound to `127.0.0.1`
- No user data is sent anywhere; inference is 100% local
- The host only accepts the four actions above; anything else is rejected
- `host.py`'s source ships alongside the compiled binary in the extension package
  (`native-host/host.py`) for anyone to audit what actually runs

## Building the binaries

```bash
pip install nuitka
python3 build_native_host.py
```

Nuitka compiles for whatever OS it runs on — it does not cross-compile — so this needs to
run once per target platform. `.github/workflows/build-native-host.yml` does this on a
3-OS CI matrix; a maintainer downloads the resulting artifacts and commits them into
`native-host/bin/<platform>/` before cutting a release build.

## Uninstall

**Windows** — delete the registry key, then the installed binary directory:

```ps
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.colophon.llamahost" /f
```

```ps
%APPDATA%\Colophon\native-host\
```

**macOS/Linux** — delete whichever of these manifest files exist (Chrome and/or
Chromium, if both are installed):

```bash
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.colophon.llamahost.json
~/Library/Application Support/Chromium/NativeMessagingHosts/com.colophon.llamahost.json
~/.config/google-chrome/NativeMessagingHosts/com.colophon.llamahost.json
~/.config/chromium/NativeMessagingHosts/com.colophon.llamahost.json
```

Then remove `~/.colophon/native-host` (the installed binary). To also remove the
downloaded model (~720 MB), delete `~/.colophon/models/` (llamafile/llamafile.exe,
the GGUF model file, and `llamafile-stderr.log`).
