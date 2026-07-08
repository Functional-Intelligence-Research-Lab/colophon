#!/usr/bin/env python3
"""
One-off test exercising host.py's real _download_file() against a local HTTP
server, confirming: (1) a correct expected hash installs the file normally,
(2) a wrong expected hash rejects it and does not leave a partial file
behind. Not part of the regular test suite — a manual verification script.
"""
import hashlib
import http.server
import importlib.util
import shutil
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("host", HERE / "host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def start_server(directory):
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **kw)
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def main():
    tmpdir = Path(tempfile.mkdtemp())
    try:
        content = b"fake binary content for testing" * 1000
        real_hash = hashlib.sha256(content).hexdigest()
        (tmpdir / "testfile.bin").write_bytes(content)

        server, port = start_server(tmpdir)
        url = f"http://127.0.0.1:{port}/testfile.bin"

        # capture sent messages instead of writing to real stdout
        sent = []
        host.send = lambda msg: sent.append(msg)

        dest_ok = tmpdir / "installed_ok.bin"
        ok = host._download_file(url, dest_ok, "test file (correct hash)", real_hash)
        assert ok is True, "expected correct-hash download to succeed"
        assert dest_ok.exists(), "expected file to be installed on correct hash"
        print("PASS: correct hash -> installed")

        sent.clear()
        dest_bad = tmpdir / "installed_bad.bin"
        wrong_hash = "0" * 64
        ok = host._download_file(url, dest_bad, "test file (wrong hash)", wrong_hash)
        assert ok is False, "expected wrong-hash download to fail"
        assert not dest_bad.exists(), "expected NO file installed on hash mismatch"
        assert not (tmpdir / "installed_bad.bin.tmp").exists(), "expected .tmp cleaned up"
        assert any(m.get("action") == "ERROR" and "verification failed" in m.get("message", "") for m in sent), \
            f"expected a verification-failed ERROR message, got: {sent}"
        print("PASS: wrong hash -> rejected, no file installed, ERROR sent")

        server.shutdown()
        print("\nAll hash-verification tests passed.")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
