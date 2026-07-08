#!/usr/bin/env python3
"""
Native-messaging smoke test: sends a CHECK_MODEL frame to a host process over
stdin/stdout (the same 4-byte-LE-length-prefixed JSON protocol Chrome uses)
and prints the response + wall-clock round-trip time.

Usage: python3 smoke_test.py <path-to-host-binary-or-script> [python3]
"""
import json
import struct
import subprocess
import sys
import time


def send_and_receive(cmd):
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    msg = json.dumps({"action": "CHECK_MODEL"}).encode("utf-8")
    start = time.monotonic()
    proc.stdin.write(struct.pack("<I", len(msg)))
    proc.stdin.write(msg)
    proc.stdin.flush()

    raw_len = proc.stdout.read(4)
    if len(raw_len) < 4:
        err = proc.stderr.read().decode(errors="replace")
        raise RuntimeError(f"No response (stderr: {err})")
    (length,) = struct.unpack("<I", raw_len)
    body = json.loads(proc.stdout.read(length).decode("utf-8"))
    elapsed = time.monotonic() - start

    proc.stdin.close()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

    return body, elapsed


def main():
    target = sys.argv[1]
    cmd = [target] if len(sys.argv) < 3 else [sys.argv[2], target]

    print(f"Testing: {' '.join(cmd)}")
    body, elapsed = send_and_receive(cmd)
    print(f"Response: {body}")
    print(f"Round-trip: {elapsed * 1000:.1f} ms")

    assert body.get("action") == "MODEL_STATUS", f"Unexpected response: {body}"
    print("OK — well-formed MODEL_STATUS response.")


if __name__ == "__main__":
    main()
