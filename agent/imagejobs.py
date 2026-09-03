"""出图任务持久化（skills.STORYBOARD_IMAGE_JOBS 的落库层）。

内存任务表 agent 重启即丢：轮询端拿到 404 只能标「任务失效」让用户重试
——在途那张的出图费用已经花掉，重试等于重复计费（萧燕燕项目 agent 重启
杀掉在途批量出图的事故）。本层把任务与逐张结果写进 SQLite：重启后轮询
照常命中，已完成的图被前端恢复轮询收回，只有真正没跑完的镜头标中断。

孤儿回收：查询命中 status=running 但内存无此任务（重启遗留）时就地
终态化——未完成项标「生成中断」，已完成的结果原样保留。行按 7 天龄期
懒清理（建新任务时顺手删旧行，不设启动钩子）。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

INTERRUPTED_ERROR = "生成中断（agent 重启），可重试"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS image_jobs ("
        " job_id TEXT PRIMARY KEY,"
        " status TEXT NOT NULL,"
        " total INTEGER NOT NULL,"
        " items TEXT NOT NULL DEFAULT '{}',"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    return conn


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def create_job(job_id: str, rids: List[str]) -> None:
    """建任务行：全部镜头先落 pending 占位（ok=False 无 error）。"""
    items = {rid: {"rid": rid, "ok": False} for rid in rids}
    with _conn() as conn:
        conn.execute("DELETE FROM image_jobs WHERE updated_at < ?", (_cutoff(),))
        conn.execute(
            "INSERT INTO image_jobs (job_id, status, total, items, created_at, updated_at)"
            " VALUES (?, 'running', ?, ?, ?, ?)",
            (job_id, len(rids), json.dumps(items, ensure_ascii=False), _now(), _now()),
        )


def save_item(job_id: str, rid: str, result: Dict[str, Any]) -> None:
    """单张结果落库（读改写整个 items JSON；任务并发 ≤30，10s busy_timeout 足够）。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT items FROM image_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return
        items = json.loads(row["items"] or "{}")
        items[rid] = {"rid": rid, **result}
        conn.execute(
            "UPDATE image_jobs SET items = ?, updated_at = ? WHERE job_id = ?",
            (json.dumps(items, ensure_ascii=False), _now(), job_id),
        )


def finish_job(job_id: str, status: str, items: Dict[str, Dict[str, Any]]) -> None:
    """任务终态：以内存里的完整结果为准权威落库（自愈中途漏写的单项）。"""
    with _conn() as conn:
        conn.execute(
            "UPDATE image_jobs SET status = ?, items = ?, updated_at = ? WHERE job_id = ?",
            (status, json.dumps(items, ensure_ascii=False), _now(), job_id),
        )


def load_job(job_id: str) -> Optional[Dict[str, Any]]:
    """读任务（轮询端在内存 miss 时调用）。running 行 = 重启遗留的孤儿：
    未完成项就地标中断、终态化后返回——前端按完成项收图、按中断项报错，
    不再整任务 404 让用户全额重试。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT job_id, status, items FROM image_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        status = str(row["status"])
        items = json.loads(row["items"] or "{}")
        if status == "running":
            finalized = {
                rid: (
                    item
                    if item.get("ok") or item.get("error")
                    else {"rid": rid, "ok": False, "error": INTERRUPTED_ERROR}
                )
                for rid, item in items.items()
            }
            conn.execute(
                "UPDATE image_jobs SET status = 'done', items = ?, updated_at = ? WHERE job_id = ?",
                (json.dumps(finalized, ensure_ascii=False), _now(), job_id),
            )
            status = "done"
            items = finalized
    return {"status": status, "images": items}


def _cutoff() -> str:
    return (datetime.now() - timedelta(days=7)).isoformat(timespec="seconds")
