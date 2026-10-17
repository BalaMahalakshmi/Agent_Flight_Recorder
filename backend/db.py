"""SQLite storage for recorded agent runs."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from typing import Any


def _connect() -> sqlite3.Connection:
    return sqlite3.connect(os.environ.get("FR_DB", "flight.db"))


def init() -> None:
    """Create the runs table if it does not already exist."""
    with closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                data TEXT NOT NULL
            )
            """
        )
        connection.commit()


def save_run(run: dict[str, Any]) -> None:
    """Insert a run, replacing any saved run with the same ID."""
    run_id = run.get("id")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("A run must have a non-empty id.")

    created_at = run.get("created_at")
    if not isinstance(created_at, str):
        created_at = ""

    with closing(_connect()) as connection:
        connection.execute(
            """
            INSERT OR REPLACE INTO runs (id, created_at, data)
            VALUES (?, ?, ?)
            """,
            (run_id, created_at, json.dumps(run, ensure_ascii=False, default=str)),
        )
        connection.commit()


def get_run(run_id: str) -> dict[str, Any] | None:
    """Return one full run, or None if it does not exist."""
    with closing(_connect()) as connection:
        row = connection.execute(
            "SELECT data FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
    return json.loads(row[0]) if row else None


def list_runs() -> list[dict[str, Any]]:
    """Return newest runs first without their potentially large step lists."""
    with closing(_connect()) as connection:
        rows = connection.execute(
            "SELECT data FROM runs ORDER BY created_at DESC, rowid DESC"
        ).fetchall()

    runs = []
    for (data,) in rows:
        run = json.loads(data)
        run.pop("steps", None)
        runs.append(run)
    return runs
