# Colophon Native Host — Setup

script has been replaced with a more automated installer on the side panel (keeping this doc for now in case anyone wants to do it manually)

The native host lets the Colophon extension download and run a local AI model (llamafile) on your machine.

## Requirements

- >=Python 3.8
- Chrome extension loaded

## Install (one-time)

### Windows

```powershell
cd native-host
.\install.ps1
```

### macOS / Linux

```bash
cd native-host
bash install.sh
```

Both scripts will:

1. Ask for your Colophon extension ID (find it in `chrome://extensions`)
2. Register the host with Chrome so the extension can talk to it

After installing, reload Colophon in `chrome://extensions`.

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

## Uninstall

**Windows** — delete the registry key:

```ps
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.colophon.llamahost
```

**macOS/Linux** — delete:

```bash
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.colophon.llamahost.json
```

or

```bash
~/.config/google-chrome/NativeMessagingHosts/com.colophon.llamahost.json
```

To also remove the downloaded model (~720 MB), delete `~/.colophon/` .
