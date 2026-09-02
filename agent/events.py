"""按钮/操作埋点（自托管，产品数据分析用）：

前端 `trackEvent(name, props?)` 与全局 `[data-track]` 点击捕获都打到
`POST /api/v1/events`，落 SQLite events 表。只记事件名与粗粒度属性
（节点类型/生成种类等），**不记任何正文/提示词内容**。分析入口：
  - GET /api/v1/events/summary?days=30   按事件名聚合（count/last_at）
  - GET /api/v1/events/recent?name=&limit=  明细下钻（原始行）
表在首次写入时懒建（无独立 init 钩子，随首个事件自愈）。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

import auth

router = APIRouter()

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            user TEXT,
            name TEXT NOT NULL,
            project_id TEXT,
            props TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts)"
    )


class EventIn(BaseModel):
    name: str
    project_id: Optional[str] = None
    props: Optional[dict[str, Any]] = None


@router.post("/events")
async def record_event(req: EventIn, user: auth.CurrentUser) -> dict:
    name = req.name.strip()[:120]
    if not name:
        return {"ok": False}
    props = json.dumps(req.props, ensure_ascii=False)[:800] if req.props else None
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    with _conn() as conn:
        _ensure_table(conn)
        conn.execute(
            "INSERT INTO events (ts, user, name, project_id, props) VALUES (?,?,?,?,?)",
            (ts, str(getattr(user, "username", "") or ""), name, req.project_id, props),
        )
    return {"ok": True}


@router.get("/events/summary")
async def events_summary(user: auth.CurrentUser, days: int = 30) -> dict:
    """按事件名聚合：count / 今日 count / 最近一次时间。days 截窗口。"""
    since = (
        datetime.now(timezone.utc).astimezone() - timedelta(days=max(1, min(days, 365)))
    ).isoformat(timespec="seconds")
    with _conn() as conn:
        _ensure_table(conn)
        rows = conn.execute(
            """
            SELECT name,
                   COUNT(*) AS count,
                   SUM(CASE WHEN ts >= :today THEN 1 ELSE 0 END) AS today,
                   MAX(ts) AS last_at
            FROM events
            WHERE ts >= :since
            GROUP BY name
            ORDER BY count DESC
            """,
            {"since": since, "today": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")[:10]},
        ).fetchall()
    return {"days": days, "summary": [dict(r) for r in rows]}


@router.get("/events/recent")
async def events_recent(
    user: auth.CurrentUser, name: str = "", limit: int = 200
) -> dict:
    """明细下钻：可按事件名过滤，新→旧。props 是 JSON 字符串原样返回。"""
    limit = max(1, min(limit, 2000))
    with _conn() as conn:
        _ensure_table(conn)
        if name.strip():
            rows = conn.execute(
                "SELECT * FROM events WHERE name = ? ORDER BY id DESC LIMIT ?",
                (name.strip(), limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
    return {"events": [dict(r) for r in rows]}
