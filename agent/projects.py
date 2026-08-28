"""项目与画布的服务端持久化（SQLite）。

单机单用户假设下的最薄实现：projects + canvases 两张表，画布整体 JSON 存取。
前端经 /agent-service/projects/* 同源代理访问。
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvases (
                project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                nodes TEXT NOT NULL DEFAULT '[]',
                edges TEXT NOT NULL DEFAULT '[]',
                viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
                updated_at TEXT NOT NULL
            );
            """
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_projects() -> List[Dict[str, str]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def create_project(name: str) -> Dict[str, str]:
    pid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (pid, name.strip() or "未命名项目", now, now),
        )
    return {"id": pid, "name": name.strip() or "未命名项目", "updated_at": now}


def delete_project(pid: str) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.execute("DELETE FROM canvases WHERE project_id = ?", (pid,))
    return cur.rowcount > 0


def rename_project(pid: str, name: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            (name.strip() or "未命名项目", _now(), pid),
        )
    return cur.rowcount > 0


def load_canvas(pid: str) -> Dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT nodes, edges, viewport FROM canvases WHERE project_id = ?", (pid,)
        ).fetchone()
        if not row:
            return None
    return {
        "nodes": json.loads(row["nodes"]),
        "edges": json.loads(row["edges"]),
        "viewport": json.loads(row["viewport"]),
    }


def save_canvas(pid: str, nodes: Any, edges: Any, viewport: Any) -> bool:
    now = _now()
    with _conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (pid,)
        ).fetchone()
        if not exists:
            return False
        conn.execute(
            """
            INSERT INTO canvases (project_id, nodes, edges, viewport, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                nodes=excluded.nodes, edges=excluded.edges,
                viewport=excluded.viewport, updated_at=excluded.updated_at
            """,
            (
                pid,
                json.dumps(nodes, ensure_ascii=False),
                json.dumps(edges, ensure_ascii=False),
                json.dumps(viewport or {"x": 0, "y": 0, "zoom": 1}),
                now,
            ),
        )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, pid))
    return True
