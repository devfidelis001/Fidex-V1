"""FIDEX AI backend entry point.

Started by the Electron main process (never by hand during normal use):

    python -u -m app.main          (working directory: the backend/ folder)

stdout carries protocol messages only. Logs go to stderr, which Electron records.
"""
from __future__ import annotations

import logging
import sys


def main() -> int:
    if sys.version_info < (3, 10):
        sys.stderr.write("FIDEX AI backend needs Python 3.10 or newer (found %s).\n" % sys.version.split()[0])
        return 2

    # Keep the real stdout for protocol messages, then point `sys.stdout` at stderr so a stray
    # print() anywhere in the backend can never corrupt the protocol stream.
    protocol_out = sys.stdout.buffer
    protocol_in = sys.stdin.buffer
    sys.stdout = sys.stderr

    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from .server import Server  # imported late so the version check above always runs first
    from .storage import storage

    # Create/open the local database before saying "ready". A problem here is logged and shows up
    # as DB_UNAVAILABLE on database requests; it never stops the backend from starting.
    storage.init_from_environment()

    from . import ai

    ai.warmup_in_background()  # load the Ollama model now, while the app is starting

    try:
        return Server(protocol_in, protocol_out).serve()
    except KeyboardInterrupt:
        return 0
    except Exception:
        logging.getLogger("fidex.backend").exception("backend stopped unexpectedly")
        return 1
    finally:
        storage.close()


if __name__ == "__main__":
    sys.exit(main())
