"""我的画风存储：style_presets 表（裸 sqlite，与项目库同库不同表）。

用户自建画风预设（名称 + 画风描述 + 可选封面图），按用户隔离，owner 才可
改删；选中 = 把 prompt 填进项目画风（projectStyle 自由文本），画风闸与
注入链路不变。参考图反推（LLM）不在本模块，见 skills.start_style_reverse_job。
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

MAX_PRESETS_PER_USER = 200


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_style_presets_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS style_presets (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cover_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_style_presets_user
                ON style_presets(user_id, created_at);
            """
        )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "coverUrl": row["cover_url"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_style_presets(user_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM style_presets WHERE user_id = ? ORDER BY created_at DESC, id",
            (user_id,),
        ).fetchall()
    return [_to_dict(r) for r in rows]


def get_style_preset(pid: str, user_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM style_presets WHERE id = ? AND user_id = ?", (pid, user_id)
        ).fetchone()
    return _to_dict(row) if row else None


def create_style_preset(user_id: str, name: str, prompt: str, cover_url: str = "") -> dict[str, Any]:
    with _conn() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM style_presets WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        if n >= MAX_PRESETS_PER_USER:
            raise OverflowError(f"每人最多保存 {MAX_PRESETS_PER_USER} 条自定义画风")
        pid = uuid.uuid4().hex[:12]
        now = _now()
        conn.execute(
            "INSERT INTO style_presets (id, user_id, name, prompt, cover_url, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (pid, user_id, name, prompt, cover_url, now, now),
        )
    return {
        "id": pid,
        "name": name,
        "prompt": prompt,
        "coverUrl": cover_url,
        "createdAt": now,
        "updatedAt": now,
    }


def update_style_preset(pid: str, user_id: str, fields: dict[str, str]) -> dict[str, Any] | None:
    """按 id+user 更新（owner 才可改）；不存在返回 None。"""
    if not fields:
        return get_style_preset(pid, user_id)
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE style_presets SET {cols}, updated_at = ? WHERE id = ? AND user_id = ?",
            (*fields.values(), _now(), pid, user_id),
        )
        if cur.rowcount == 0:
            return None
    return get_style_preset(pid, user_id)


def delete_style_preset(pid: str, user_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM style_presets WHERE id = ? AND user_id = ?", (pid, user_id)
        )
    return cur.rowcount > 0
