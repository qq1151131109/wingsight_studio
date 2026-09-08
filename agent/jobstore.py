"""通用异步任务持久层：拆解 / 分镜表生成等长任务的落库。

image/video 批量任务是 item 形状的专用表（imagejobs.py 的 image_jobs /
video_jobs），不走这里——同库不同表。本层面向「单结果 + 阶段进度」型任务：
状态 JSON 整存整取，拆解的自动出图链逐图 checkpoint（重启后已花钱生成的
设定图随 partial 结果收回，只有真正没跑完的部分标中断）。

孤儿语义（与 imagejobs 同款）：查询命中 status=running 但进程内存无此任务
（重启遗留）时就地终态化——state 里已有的产物（assets/image_url 等）原样
保留，error 写「生成中断（agent 重启）」。启动清扫 sweep_orphans() 把三张
表的 running 孤儿一次性终态化（进程都换了不可能还在跑，不留僵尸行装活）。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

INTERRUPTED_ERROR = "生成中断（agent 重启），可重试"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS async_jobs ("
        " job_id TEXT PRIMARY KEY,"
        " kind TEXT NOT NULL,"
        " status TEXT NOT NULL,"
        " state TEXT NOT NULL DEFAULT '{}',"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    return conn


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def create_job(job_id: str, kind: str, state: Dict[str, Any]) -> None:
    """建任务行（status=running，state 为任务内存态的 JSON 镜像）。"""
    with _conn() as conn:
        conn.execute("DELETE FROM async_jobs WHERE updated_at < ?", (_cutoff(),))
        conn.execute(
            "INSERT INTO async_jobs (job_id, kind, status, state, created_at, updated_at)"
            " VALUES (?, ?, 'running', ?, ?, ?)",
            (job_id, kind, _dump(state), _now(), _now()),
        )


def save_state(job_id: str, state: Dict[str, Any]) -> None:
    """checkpoint：整状态重写（拆解产物 tens of KB，逐图一次写足够便宜）。"""
    with _conn() as conn:
        conn.execute(
            "UPDATE async_jobs SET state = ?, updated_at = ? WHERE job_id = ? AND status = 'running'",
            (_dump(state), _now(), job_id),
        )


def finish_job(job_id: str, state: Dict[str, Any]) -> None:
    """终态权威落库（以内存完整结果为准）。"""
    with _conn() as conn:
        conn.execute(
            "UPDATE async_jobs SET status = 'done', state = ?, updated_at = ? WHERE job_id = ?",
            (_dump(state), _now(), job_id),
        )


def load_job(job_id: str) -> Optional[Dict[str, Any]]:
    """读任务（轮询端内存 miss 时调用）。

    返回 {"status", **state}（与各任务内存态同形状，端点直接透传）；
    running 行 = 重启孤儿 → 就地终态化（已有产物保留、补中断 error）。
    """
    with _conn() as conn:
        row = conn.execute(
            "SELECT status, state FROM async_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        status = str(row["status"])
        state = json.loads(row["state"] or "{}")
        if status == "running":
            if not str(state.get("error") or "").strip():
                state["error"] = INTERRUPTED_ERROR
            status = "done"
            conn.execute(
                "UPDATE async_jobs SET status = 'done', state = ?, updated_at = ? WHERE job_id = ?",
                (_dump(state), _now(), job_id),
            )
        # status 列权威在后：镜像 state 里若带旧的 status 键（内存态原样落库）
        # 不允许盖掉真实终态
        return {**state, "status": status}


def sweep_orphans() -> int:
    """启动清扫：async_jobs 的 running 孤儿全部终态化（产物保留+中断标记）。

    返回清扫行数（观测用）。image_jobs / video_jobs 的同款清扫在
    imagejobs.finalize_running_orphans（各表 finalize 语义不同：item 表按
    单项打中断标记，本表整状态补 error）。
    """
    n = 0
    with _conn() as conn:
        rows = conn.execute(
            "SELECT job_id, state FROM async_jobs WHERE status = 'running'"
        ).fetchall()
        for row in rows:
            state = json.loads(row["state"] or "{}")
            if not str(state.get("error") or "").strip():
                state["error"] = INTERRUPTED_ERROR
            conn.execute(
                "UPDATE async_jobs SET status = 'done', state = ?, updated_at = ? WHERE job_id = ?",
                (_dump(state), _now(), row["job_id"]),
            )
            n += 1
    return n


def _dump(state: Dict[str, Any]) -> str:
    return json.dumps(state, ensure_ascii=False, default=str)


def _cutoff() -> str:
    return (datetime.now() - timedelta(days=7)).isoformat(timespec="seconds")
