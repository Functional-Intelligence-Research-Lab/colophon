#!/usr/bin/env python3
"""
tools/validate.py — Colophon .twff validator

Validates a .twff export file:
  1. Extracts meta/process-log.json from the ZIP
  2. Verifies the per-event SHA-256 hash chain (SPEC §5.2)
  3. Checks structural rules (session_start first, session_end last, chronological)

Usage:
    python tools/validate.py path/to/session.twff
    python tools/validate.py path/to/session.json   # bare process-log.json also accepted

For full JSON Schema validation, use the validator in the twff repo:
    python ../twff/spec/verification/validate_examples.py <file>

Exit codes:  0 = valid   1 = invalid   2 = usage error
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path


# ── Colours ───────────────────────────────────────────────────────────────────

def _green(s): return f"\033[32m{s}\033[0m"
def _red(s):   return f"\033[31m{s}\033[0m"
def _yellow(s): return f"\033[33m{s}\033[0m"
def ok(msg):   return f"{_green('✓')} {msg}"
def fail(msg): return f"{_red('✗')} {msg}"
def warn(msg): return f"{_yellow('⚠')} {msg}"


# ── Hash chain ────────────────────────────────────────────────────────────────

def _event_hash(event: dict, prev: str, session_id: str) -> str:
    payload = {k: v for k, v in event.items() if k != '_hash'}
    payload_json = json.dumps(payload, separators=(',', ':'), sort_keys=True)
    raw = (payload_json + '|' + prev + '|' + session_id).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def verify_chain(log: dict) -> list[str]:
    messages = []
    session_id = log.get('session_id', '')
    events = log.get('events', [])
    prev = ''
    all_ok = True

    for i, event in enumerate(events):
        stored   = event.get('_hash', '')
        expected = _event_hash(event, prev, session_id)
        if stored and stored != expected:
            all_ok = False
            messages.append(fail(
                f"Event {i} ({event.get('type')!r}): hash mismatch\n"
                f"  expected: {expected}\n"
                f"  stored:   {stored}"
            ))
        prev = stored or expected

    integrity = log.get('_integrity', {})
    head = integrity.get('head_hash', '')
    if head and head != prev:
        all_ok = False
        messages.append(fail(f"_integrity.head_hash mismatch"))
    elif not head:
        messages.append(warn("No _integrity block — hash chain not anchored"))

    if all_ok:
        messages.append(ok(f"Hash chain intact ({len(events)} events)"))
    return messages


def verify_structure(log: dict) -> list[str]:
    messages = []
    events = log.get('events', [])

    if not events:
        messages.append(warn("No events"))
        return messages

    if events[0].get('type') != 'session_start':
        messages.append(fail("First event is not session_start"))
    else:
        messages.append(ok("session_start is first"))

    if events[-1].get('type') != 'session_end':
        messages.append(fail("Last event is not session_end"))
    else:
        messages.append(ok("session_end is last"))

    ts = [e.get('timestamp', '') for e in events]
    if ts == sorted(ts):
        messages.append(ok("Events are chronological"))
    else:
        messages.append(fail("Events are NOT in chronological order"))

    return messages


# ── Load ──────────────────────────────────────────────────────────────────────

def load_log(path: Path) -> dict:
    if path.suffix == '.twff':
        with zipfile.ZipFile(path) as zf:
            with zf.open('meta/process-log.json') as f:
                return json.load(f)
    else:
        with open(path) as f:
            return json.load(f)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: python {sys.argv[0]} <file.twff|process-log.json>")
        return 2

    path = Path(sys.argv[1])
    if not path.exists():
        print(fail(f"File not found: {path}"))
        return 1

    try:
        log = load_log(path)
    except (json.JSONDecodeError, KeyError, zipfile.BadZipFile) as e:
        print(fail(f"Could not read log: {e}"))
        return 1

    print(f"\n{path.name}")
    print("─" * 50)

    passed = True
    for msg in verify_structure(log) + verify_chain(log):
        print(" ", msg)
        if msg.startswith(_red('✗')):
            passed = False

    print()
    if passed:
        print(ok("Valid TWFF export"))
        return 0
    else:
        print(fail("Validation failed — see above"))
        return 1


if __name__ == '__main__':
    sys.exit(main())
