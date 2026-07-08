#!/usr/bin/env python3
"""
Builds a standalone, no-Python-required binary of host.py using Nuitka.

Run once per target OS (Nuitka compiles for the platform it runs on, it does
not cross-compile) — see .github/workflows/build-native-host.yml for the
3-OS matrix that produces all platform artifacts.

Usage:
    pip install nuitka
    python3 build_native_host.py

Output: native-host/bin/<platform>/colophon-host[.exe] (a standalone directory
of files, not a single-file executable — --onefile re-extracts itself into a
temp dir on every launch, which is exactly the startup-latency cost this
avoids) plus native-host/bin/<platform>/colophon-host.zip, the distributable
artifact the extension bundles and unpacks during native-host setup.
"""

import platform
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
HOST_PY = HERE / "host.py"
BUILD_DIR = HERE / "build"

PLATFORM_NAMES = {"Linux": "linux", "Darwin": "mac", "Windows": "win"}


def platform_name():
    system = platform.system()
    name = PLATFORM_NAMES.get(system)
    if not name:
        raise SystemExit(f"Unsupported platform: {system}")
    return name


def main():
    plat = platform_name()
    out_dir = HERE / "bin" / plat
    out_dir.mkdir(parents=True, exist_ok=True)

    binary_name = "colophon-host.exe" if plat == "win" else "colophon-host"

    print(f"[build_native_host] Compiling host.py for {plat} with Nuitka...")
    subprocess.run(
        [
            sys.executable, "-m", "nuitka",
            "--standalone",
            f"--output-dir={BUILD_DIR}",
            "--output-filename=" + binary_name,
            "--remove-output",
            "--assume-yes-for-downloads",
            str(HOST_PY),
        ],
        check=True,
        cwd=HERE,
    )

    dist_dir = BUILD_DIR / "host.dist"
    if not dist_dir.exists():
        raise SystemExit(f"Expected Nuitka output at {dist_dir}, not found")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(dist_dir, out_dir)

    # Zip to a staging path OUTSIDE out_dir, then move it in — zipping a
    # directory into a file placed inside that same directory makes the zip
    # include itself as it grows, producing a runaway self-referential archive.
    staging_zip = shutil.make_archive(str(HERE / "bin" / f"{plat}-colophon-host"), "zip", root_dir=out_dir)
    zip_path = out_dir / "colophon-host.zip"
    shutil.move(staging_zip, zip_path)
    print(f"[build_native_host] Wrote {zip_path}")


if __name__ == "__main__":
    main()
