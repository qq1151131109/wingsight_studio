"""媒体生成任务持久化（skills 的出图/出视频 job 落库层）。

内存任务表 agent 重启即丢：轮询端拿到 404 只能标「任务失效」让用户重试
——在途那张的出图费用已经花掉，重试等于重复计费（萧燕燕项目 agent 重启
杀掉在途批量出图的事故）。本层把任务与逐张结果写进 SQLite：重启后轮询
照常命中，已完成的图被前端恢复轮询收回，只有真正没跑完的镜头标中断。

表按任务类分（image_jobs / video_jobs，同 schema）；返回键历史遗留叫
images——轮询端读的是 items 数组形状，键名不改（改了两个前端轮询端
都要跟，收益为零）。

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

_TABLES = ("image_jobs", "video_jobs")


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    for t in _TABLES:
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS {t} ("
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


def create_job(job_id: str, rids: List[str], table: str = "image_jobs") -> None:
    """建任务行：全部镜头先落 pending 占位（ok=False 无 error）。"""
    items = {rid: {"rid": rid, "ok": False} for rid in rids}
    with _conn() as conn:
        conn.execute(f"DELETE FROM {table} WHERE updated_at < ?", (_cutoff(),))
        conn.execute(
            f"INSERT INTO {table} (job_id, status, total, items, created_at, updated_at)"
            " VALUES (?, 'running', ?, ?, ?, ?)",
            (job_id, len(rids), json.dumps(items, ensure_ascii=False), _now(), _now()),
        )


def save_item(
    job_id: str, rid: str, result: Dict[str, Any], table: str = "image_jobs"
) -> None:
    """单条结果落库（读改写整个 items JSON；任务并发 ≤30，10s busy_timeout 足够）。"""
    with _conn() as conn:
        row = conn.execute(
            f"SELECT items FROM {table} WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return
        items = json.loads(row["items"] or "{}")
        items[rid] = {"rid": rid, **result}
        conn.execute(
            f"UPDATE {table} SET items = ?, updated_at = ? WHERE job_id = ?",
            (json.dumps(items, ensure_ascii=False), _now(), job_id),
        )


def finish_job(
    job_id: str, status: str, items: Dict[str, Dict[str, Any]], table: str = "image_jobs"
) -> None:
    """任务终态：以内存里的完整结果为准权威落库（自愈中途漏写的单项）。"""
    with _conn() as conn:
        conn.execute(
            f"UPDATE {table} SET status = ?, items = ?, updated_at = ? WHERE job_id = ?",
            (status, json.dumps(items, ensure_ascii=False), _now(), job_id),
        )


def load_job(job_id: str, table: str = "image_jobs") -> Optional[Dict[str, Any]]:
    """读任务（轮询端在内存 miss 时调用）。running 行 = 重启遗留的孤儿：
    未完成项就地标中断、终态化后返回——前端按完成项收结果、按中断项报错，
    不再整任务 404 让用户全额重试。"""
    with _conn() as conn:
        row = conn.execute(
            f"SELECT job_id, status, items FROM {table} WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        status = str(row["status"])
        items = json.loads(row["items"] or "{}")
        if status == "running":
            finalized = _finalize_items(items)
            conn.execute(
                f"UPDATE {table} SET status = 'done', items = ?, updated_at = ? WHERE job_id = ?",
                (json.dumps(finalized, ensure_ascii=False), _now(), job_id),
            )
            status = "done"
            items = finalized
    return {"status": status, "images": items}


def _finalize_items(items: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """孤儿终态化：已完成（ok/error）原样保留，未完成标中断（计费已发生的
    完成项不丢，未知状态的在途项不自动重跑——重试即重复计费）。"""
    return {
        rid: (
            item
            if item.get("ok") or item.get("error")
            else {"rid": rid, "ok": False, "error": INTERRUPTED_ERROR}
        )
        for rid, item in items.items()
    }


def finalize_running_orphans() -> int:
    """启动清扫：两张表所有 running 孤儿批量终态化（main lifespan 调用）。

    agent 重启后进程内任务表全空，running 行必然是孤儿——就地终态化免得
    用户不回来轮询就一直装活。返回清扫行数（观测用）。"""
    n = 0
    with _conn() as conn:
        for table in _TABLES:
            rows = conn.execute(
                f"SELECT job_id, items FROM {table} WHERE status = 'running'"
            ).fetchall()
            for row in rows:
                items = json.loads(row["items"] or "{}")
                conn.execute(
                    f"UPDATE {table} SET status = 'done', items = ?, updated_at = ? WHERE job_id = ?",
                    (
                        json.dumps(_finalize_items(items), ensure_ascii=False),
                        _now(),
                        row["job_id"],
                    ),
                )
                n += 1
    return n


def _cutoff() -> str:
    return (datetime.now() - timedelta(days=7)).isoformat(timespec="seconds")
