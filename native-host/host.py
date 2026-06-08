#!/usr/bin/env python3
"""
Colophon native messaging host.

Handles file-system and process operations the extension cannot do directly:
  CHECK_MODEL   — reports whether llamafile + model are present on disk
  DOWNLOAD_MODEL — downloads llamafile runtime and model GGUF to ~/.colophon/models/
  LAUNCH_MODEL  — starts llamafile as a background server on 127.0.0.1:8080
  STOP_MODEL    — terminates the running llamafile process

Protocol: Chrome native messaging (4-byte LE length prefix + UTF-8 JSON, stdio).

Security notes:
  - Incoming action validated against ALLOWED_ACTIONS allowlist.
  - No user-supplied data is passed to subprocess or used in file paths.
  - All paths are constructed from constants; no shell=True ever.
  - llamafile is bound to 127.0.0.1 only.
  - Downloads are HTTPS only.
  # TODO before production: add SHA-256 verification of downloaded binaries.
"""

import sys
import json
import struct
import os
import platform
import hashlib
import urllib.request
import urllib.error
import threading
import subprocess
import time
from pathlib import Path

# ── Constants ──────────────────────────────────────────────────────────────────

COLOPHON_DIR = Path.home() / ".colophon" / "models"
SERVER_PORT = 8080

# Llamafile 0.8.14 — update URL + verify hash when upgrading
LLAMAFILE_VERSION = "0.8.14"
LLAMAFILE_URL = (
    f"https://github.com/Mozilla-Ocho/llamafile/releases/download/"
    f"{LLAMAFILE_VERSION}/llamafile-{LLAMAFILE_VERSION}"
)

# Llama 3.2 1B Instruct Q4_K_M (~670 MB) — fast, good at writing tasks
MODEL_FILENAME = "Llama-3.2-1B-Instruct-Q4_K_M.gguf"
MODEL_URL = (
    "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/"
    "resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
)

ALLOWED_ACTIONS = {"CHECK_MODEL", "DOWNLOAD_MODEL", "LAUNCH_MODEL", "STOP_MODEL"}

# ── Global process reference ───────────────────────────────────────────────────

_llamafile_proc = None
_send_lock = threading.Lock()

# ── Native messaging I/O ──────────────────────────────────────────────────────

def send(message):
    """Write a length-prefixed JSON message to stdout (Chrome native protocol)."""
    data = json.dumps(message).encode("utf-8")
    with _send_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def recv():
    """Read one length-prefixed JSON message from stdin. Returns None on EOF."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    if length > 1_048_576:  # 1 MB sanity cap
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

# ── Path helpers ───────────────────────────────────────────────────────────────

def _llamafile_path():
    name = "llamafile.exe" if platform.system() == "Windows" else "llamafile"
    return COLOPHON_DIR / name


def _model_path():
    return COLOPHON_DIR / MODEL_FILENAME

# ── Action handlers ────────────────────────────────────────────────────────────

def handle_check_model():
    lf = _llamafile_path()
    model = _model_path()
    found = lf.exists() and model.exists()
    send({
        "action": "MODEL_STATUS",
        "found": found,
        "llamafile": str(lf),
        "model": str(model),
    })


def _download_file(url, dest, label):
    """
    Stream-download url → dest, emitting PROGRESS messages.
    Returns True on success, False on failure (ERROR already sent).
    """
    tmp = Path(str(dest) + ".tmp")
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": f"Colophon/{LLAMAFILE_VERSION}"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            last_pct = -1
            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = int(downloaded / total * 100)
                        if pct != last_pct:
                            send({"action": "PROGRESS", "label": label, "percent": pct})
                            last_pct = pct
        tmp.replace(dest)
        return True
    except Exception as exc:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        send({"action": "ERROR", "message": f"Download failed ({label}): {exc}"})
        return False


def handle_download_model():
    COLOPHON_DIR.mkdir(parents=True, exist_ok=True)

    lf = _llamafile_path()
    model = _model_path()

    # Step 1: llamafile runtime (~50 MB)
    if not lf.exists():
        send({"action": "PROGRESS", "label": "llamafile runtime", "percent": 0})
        if not _download_file(LLAMAFILE_URL, lf, "llamafile runtime"):
            return
        # Mark executable on POSIX
        if platform.system() != "Windows":
            lf.chmod(lf.stat().st_mode | 0o755)
    else:
        send({"action": "PROGRESS", "label": "llamafile runtime", "percent": 100})

    # Step 2: model GGUF (~670 MB)
    if not model.exists():
        send({"action": "PROGRESS", "label": "Llama 3.2 1B model", "percent": 0})
        if not _download_file(MODEL_URL, model, "Llama 3.2 1B model"):
            return
    else:
        send({"action": "PROGRESS", "label": "Llama 3.2 1B model", "percent": 100})

    send({"action": "DOWNLOAD_DONE"})


def handle_launch_model():
    global _llamafile_proc

    lf = _llamafile_path()
    model = _model_path()

    if not lf.exists() or not model.exists():
        send({"action": "ERROR", "message": "Model files not found. Download first."})
        return

    # Kill any existing server process
    if _llamafile_proc is not None and _llamafile_proc.poll() is None:
        _llamafile_proc.terminate()
        _llamafile_proc = None

    # Flags to keep llamafile off-screen on Windows
    creation_flags = 0
    if platform.system() == "Windows":
        creation_flags = subprocess.CREATE_NO_WINDOW

    cmd = [
        str(lf),
        "--model", str(model),
        "--server",
        "--port", str(SERVER_PORT),
        "--host", "127.0.0.1",   # never expose outside localhost
        "--threads", "2",
        "--ctx-size", "1024",    # enough for paragraph-level suggestions
        "--batch-size", "256",
        "--nobrowser",
    ]

    try:
        _llamafile_proc = subprocess.Popen(
            cmd,
            creationflags=creation_flags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        send({"action": "ERROR", "message": f"Failed to start llamafile: {exc}"})
        return

    # Poll /health until the server is ready (up to 30 s)
    health_url = f"http://127.0.0.1:{SERVER_PORT}/health"
    for _ in range(30):
        time.sleep(1)
        if _llamafile_proc.poll() is not None:
            send({"action": "ERROR", "message": "llamafile exited unexpectedly on startup."})
            return
        try:
            urllib.request.urlopen(health_url, timeout=2)
            send({"action": "LAUNCHED", "port": SERVER_PORT, "pid": _llamafile_proc.pid})
            return
        except Exception:
            pass

    send({"action": "ERROR", "message": "Timed out waiting for llamafile to start."})


def handle_stop_model():
    global _llamafile_proc
    if _llamafile_proc is not None:
        _llamafile_proc.terminate()
        _llamafile_proc = None
    send({"action": "STOPPED"})

# ── Main loop ──────────────────────────────────────────────────────────────────

def main():
    while True:
        msg = recv()
        if msg is None:
            break

        action = msg.get("action", "")
        if action not in ALLOWED_ACTIONS:
            send({"action": "ERROR", "message": f"Unknown action: {action}"})
            continue

        if action == "CHECK_MODEL":
            handle_check_model()
        elif action == "DOWNLOAD_MODEL":
            # Thread lets us stream progress while still reading stdin (e.g. STOP)
            threading.Thread(target=handle_download_model, daemon=True).start()
        elif action == "LAUNCH_MODEL":
            threading.Thread(target=handle_launch_model, daemon=True).start()
        elif action == "STOP_MODEL":
            handle_stop_model()


if __name__ == "__main__":
    main()
