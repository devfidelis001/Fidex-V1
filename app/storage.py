"""The one shared database of the running backend.

Electron passes the user-data folder in the FIDEX_DATA_DIR environment variable. The database
file is <FIDEX_DATA_DIR>/db/fidex.sqlite. It is created when the backend starts (see main.py).
If it cannot be opened, the backend still runs and database requests answer DB_UNAVAILABLE;
every later request tries to open it again, so a temporary problem (for example a locked
folder) heals itself.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Mapping, Optional

from . import progress
from .database import Database
from .protocol import DB_UNAVAILABLE, RequestError

log = logging.getLogger("fidex.storage")

DATA_DIR_ENV = "FIDEX_DATA_DIR"
DB_FOLDER = "db"
DB_FILE = "fidex.sqlite"


class Storage:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._path: Optional[Path] = None
        self._db: Optional[Database] = None
        self._session_id: Optional[str] = None  # this run's row in app_sessions (Step 6)
        self.previous_ended_cleanly: Optional[bool] = None  # None = first ever run

    # ----- setup -----
    def configure(self, path: "str | Path | None") -> None:
        """Set (or clear) the database file location. Closes any database that is open."""
        self.close()
        with self._lock:
            self._path = Path(path) if path else None

    def init_from_environment(self, env: Optional[Mapping[str, str]] = None) -> bool:
        """Configure from FIDEX_DATA_DIR and open the database now. Never raises."""
        env = os.environ if env is None else env
        data_dir = (env.get(DATA_DIR_ENV) or "").strip()
        if not data_dir:
            log.warning("%s is not set; local storage is disabled", DATA_DIR_ENV)
            self.configure(None)
            return False
        if not Path(data_dir).is_absolute():
            log.error("%s must be an absolute path; local storage is disabled", DATA_DIR_ENV)
            self.configure(None)
            return False
        self.configure(Path(data_dir) / DB_FOLDER / DB_FILE)
        try:
            self.get()
        except RequestError as err:
            log.error("local storage could not be opened at startup: %s", err.message)
            return False
        log.info("local storage ready")
        return True

    # ----- use -----
    def get(self) -> Database:
        """The open database; opens it if needed. Raises RequestError(DB_UNAVAILABLE)."""
        with self._lock:
            if self._path is None:
                raise RequestError(DB_UNAVAILABLE, "Local storage is not configured.")
            if self._db is not None and self._db.is_open:
                return self._db
            db = Database(self._path)
            db.open()
            self._db = db
            if self._session_id is None:  # once per process, even if the database is reopened after a hiccup
                try:
                    session = progress.begin_session(db)
                    self._session_id = session["id"]
                    self.previous_ended_cleanly = session["previous_ended_cleanly"]
                except RequestError as err:
                    log.error("could not start a save-progress session: %s", err.message)
            return db

    def close(self) -> None:
        with self._lock:
            db, self._db = self._db, None
            sid, self._session_id = self._session_id, None
        if db is not None:
            if sid is not None and db.is_open:
                progress.end_session(db, sid)  # records a clean exit; a crash never reaches this line
            db.close()


storage = Storage()
