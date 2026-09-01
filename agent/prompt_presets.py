"""我的提示词：prompt_presets 表 + /api/v1/prompt-presets CRUD 路由。

用户级提示词库（分组 + 文本），按账号隔离、owner 才可改删——原 localStorage
收藏（浏览器级）已升级为服务端存储（换设备/换账号可用）。内置预设仍是前端
硬编码清单（lib/prompt-library.ts），不落库。
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Response

import auth

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

MAX_PRESETS_PER_USER = 200

router = APIRouter()


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_prompt_presets_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS prompt_presets (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_presets_user
                ON prompt_presets(user_id, created_at);
            """
        )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "group": row["group_name"],
        "text": row["text"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_prompt_presets(user_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_presets WHERE user_id = ? ORDER BY created_at DESC, id",
            (user_id,),
        ).fetchall()
    return [_to_dict(r) for r in rows]


def create_prompt_preset(user_id: str, group: str, text: str) -> dict[str, Any]:
    with _conn() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM prompt_presets WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        if n >= MAX_PRESETS_PER_USER:
            raise OverflowError(f"每人最多保存 {MAX_PRESETS_PER_USER} 条自定义提示词")
        pid = uuid.uuid4().hex[:12]
        now = _now()
        conn.execute(
            "INSERT INTO prompt_presets (id, user_id, group_name, text, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (pid, user_id, group, text, now, now),
        )
    return {"id": pid, "group": group, "text": text, "createdAt": now, "updatedAt": now}


def update_prompt_preset(pid: str, user_id: str, fields: dict[str, str]) -> dict[str, Any] | None:
    if not fields:
        return get_prompt_preset(pid, user_id)
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE prompt_presets SET {cols}, updated_at = ? WHERE id = ? AND user_id = ?",
            (*fields.values(), _now(), pid, user_id),
        )
        if cur.rowcount == 0:
            return None
    return get_prompt_preset(pid, user_id)


def get_prompt_preset(pid: str, user_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM prompt_presets WHERE id = ? AND user_id = ?", (pid, user_id)
        ).fetchone()
    return _to_dict(row) if row else None


def delete_prompt_preset(pid: str, user_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM prompt_presets WHERE id = ? AND user_id = ?", (pid, user_id)
        )
    return cur.rowcount > 0


# ---------- 路由（前端经同源代理 /api/v1/prompt-presets* 访问） ----------


@router.get("/prompt-presets")
def list_presets(user: auth.CurrentUser):
    return {"presets": list_prompt_presets(user.id)}


@router.post("/prompt-presets")
def create_preset(req: dict, user: auth.CurrentUser):
    group = str(req.get("group") or "").strip()
    text = str(req.get("text") or "").strip()
    if not text:
        return Response(status_code=400, content="提示词内容不能为空", media_type="text/plain")
    try:
        return {"preset": create_prompt_preset(user.id, group[:20], text[:2000])}
    except OverflowError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")


@router.patch("/prompt-presets/{pid}")
def update_preset(pid: str, req: dict, user: auth.CurrentUser):
    fields: dict[str, str] = {}
    if "group" in req:
        fields["group_name"] = str(req.get("group") or "").strip()[:20]
    if "text" in req:
        fields["text"] = str(req.get("text") or "").strip()[:2000]
    if fields.get("text") == "":
        return Response(status_code=400, content="提示词内容不能为空", media_type="text/plain")
    preset = update_prompt_preset(pid, user.id, fields)
    if preset is None:
        return Response(status_code=404, content="提示词不存在", media_type="text/plain")
    return {"preset": preset}


@router.delete("/prompt-presets/{pid}")
def delete_preset(pid: str, user: auth.CurrentUser):
    if not delete_prompt_preset(pid, user.id):
        return Response(status_code=404, content="提示词不存在", media_type="text/plain")
    return {"ok": True}
