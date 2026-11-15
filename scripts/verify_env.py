"""Checks that the Python environment for FIDEX AI works. Prints a JSON line."""
import json
import platform
import sys

print(json.dumps({
    "python": platform.python_version(),
    "executable": sys.executable,
    "in_venv": sys.prefix != sys.base_prefix,
    "ok": sys.version_info >= (3, 10),
}))
