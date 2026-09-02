"""出图用量计量（按平台用户）：每张成功出图记一行（day=北京日期, user, model）。

用户身份不走函数签名——auth 依赖解析用户时 set_current_user 注入 ContextVar，
后台任务（批量出图 job 的 asyncio 子任务）在请求上下文内创建，上下文快照
随任务携带，出图完成时仍能读到发起者。单机匿名模式记作 local。
只做精确计数，不做金额估算：全平台共用一把 DMX key，上游无法按平台用户出账。
"""

from __future__ import annotations

import sqlite3
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"
_TZ_BJ = timezone(timedelta(hours=8))

current_user: ContextVar[str] = ContextVar("usage_current_user", default="")


def set_current_user(name: str) -> None:
    current_user.set((name or "").strip())


def beijing_today() -> str:
    return datetime.now(_TZ_BJ).strftime("%Y-%m-%d")


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS image_usage ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " day TEXT NOT NULL, ts TEXT NOT NULL, user TEXT NOT NULL, model TEXT NOT NULL)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_image_usage_day ON image_usage(day)")
    return conn


def record_image(model: str, user: str | None = None) -> None:
    """成功出图记一行。user 缺省读请求上下文（后台任务沿用发起者快照）。"""
    who = (user if user is not None else current_user.get()).strip() or "未知"
    model = (model or "").strip() or "未知"
    now = datetime.now(_TZ_BJ)
    with _conn() as conn:
        conn.execute(
            "INSERT INTO image_usage (day, ts, user, model) VALUES (?, ?, ?, ?)",
            (now.strftime("%Y-%m-%d"), now.isoformat(timespec="seconds"), who, model),
        )


def image_stats() -> dict[str, Any]:
    """按用户聚合：今日（北京）/ 累计张数 + 模型分布（今日、累计各一组）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT user, model, day, COUNT(*) AS n FROM image_usage GROUP BY user, model, day"
        ).fetchall()
    today = beijing_today()
    users: dict[str, dict[str, Any]] = {}
    for r in rows:
        u = users.setdefault(
            r["user"],
            {"user": r["user"], "today": 0, "total": 0, "models_today": {}, "models_total": {}},
        )
        n = int(r["n"])
        u["total"] += n
        u["models_total"][r["model"]] = u["models_total"].get(r["model"], 0) + n
        if r["day"] == today:
            u["today"] += n
            u["models_today"][r["model"]] = u["models_today"].get(r["model"], 0) + n
    return {
        "today_date": today,
        "users": sorted(users.values(), key=lambda u: (-u["today"], -u["total"])),
    }
