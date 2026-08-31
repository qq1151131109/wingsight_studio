"""选题池存储：topics 表 + 刷新状态（裸 sqlite，与项目库同库不同表）。

topics 是跨项目的全局候选池（生产前漏斗），无归属隔离——所有用户共享
同一池子（与 juben 同语义）。title_fingerprint 唯一约束是幂等键：重复
刷新/并发刷新不得产生重复选题卡。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_topics_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                vertical TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'material',
                title TEXT NOT NULL,
                title_fingerprint TEXT NOT NULL UNIQUE,
                summary TEXT NOT NULL DEFAULT '',
                angles_json TEXT NOT NULL DEFAULT '[]',
                heat_evidence_json TEXT NOT NULL DEFAULT '[]',
                research_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'candidate',
                adopted_pid TEXT,
                last_progress_at TEXT NOT NULL,
                last_rescan_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_topics_status_created ON topics(status, created_at);
            CREATE INDEX IF NOT EXISTS idx_topics_vertical ON topics(vertical);
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


# ---------- 刷新状态（settings 键值） ----------


def get_setting(key: str) -> str | None:
    with _conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


# ---------- 仓储 ----------


def _serialize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "vertical": row["vertical"],
        "source": row["source"],
        "title": row["title"],
        "summary": row["summary"],
        "angles": json.loads(row["angles_json"]),
        "heatEvidence": json.loads(row["heat_evidence_json"]),
        "research": json.loads(row["research_json"]),
        "status": row["status"],
        "adoptedPid": row["adopted_pid"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastProgressAt": row["last_progress_at"],
    }


def create_topic(
    *,
    vertical: str,
    title: str,
    title_fingerprint: str,
    summary: str = "",
    angles: list[str] | None = None,
    heat_evidence: list[dict] | None = None,
    research: dict[str, Any] | None = None,
    source: str = "material",
) -> dict[str, Any]:
    tid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO topics (id, vertical, source, title, title_fingerprint, summary,"
            " angles_json, heat_evidence_json, research_json, status, last_progress_at,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)",
            (
                tid,
                vertical,
                source,
                title,
                title_fingerprint,
                summary,
                json.dumps(angles or [], ensure_ascii=False),
                json.dumps(heat_evidence or [], ensure_ascii=False),
                json.dumps(research or {}, ensure_ascii=False),
                now,
                now,
                now,
            ),
        )
    row = get_topic_row(tid)
    assert row is not None
    return _serialize(row)


def get_topic_row(topic_id: str) -> sqlite3.Row | None:
    with _conn() as conn:
        return conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()


def get_topic(topic_id: str) -> dict[str, Any] | None:
    row = get_topic_row(topic_id)
    return _serialize(row) if row else None


def list_topics(
    *,
    status: str | None = "candidate",
    vertical: str | None = None,
    source: str | None = None,
    q: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """status='all' 返回全部状态（前端按 status tab 自己分流）。"""
    sql = "SELECT * FROM topics WHERE 1=1"
    params: list[Any] = []
    if status and status != "all":
        sql += " AND status = ?"
        params.append(status)
    if vertical:
        sql += " AND vertical = ?"
        params.append(vertical)
    if source:
        sql += " AND source = ?"
        params.append(source)
    if q:
        sql += " AND (title LIKE ? OR summary LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with _conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_serialize(r) for r in rows]


def exists_by_any_fingerprint(fingerprints: list[str]) -> bool:
    """任一指纹已在池中（任何状态，含已认领/已忽略）即视为旧选题。"""
    if not fingerprints:
        return False
    marks = ",".join("?" * len(fingerprints))
    with _conn() as conn:
        row = conn.execute(
            f"SELECT 1 FROM topics WHERE title_fingerprint IN ({marks}) LIMIT 1",
            fingerprints,
        ).fetchone()
    return row is not None


def find_upgradable_by_any_fingerprint(fingerprints: list[str]) -> str | None:
    """返回"观察态 candidate"（无讲法角度）的选题 id：证据变硬时可升级。

    已是建议卡/已认领/已忽略都不算——由调用方走 create，唯一约束兜底幂等。
    """
    if not fingerprints:
        return None
    marks = ",".join("?" * len(fingerprints))
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT id, angles_json FROM topics"
            f" WHERE title_fingerprint IN ({marks}) AND status = 'candidate' LIMIT 50",
            fingerprints,
        ).fetchall()
    for row in rows:
        if not json.loads(row["angles_json"]):
            return row["id"]
    return None


def upgrade_card(
    topic_id: str,
    *,
    title: str,
    summary: str,
    angles: list[str],
    research: dict[str, Any],
) -> None:
    """观察卡升级为建议卡：补题目、概要与讲法角度，替换取证包。"""
    now = _now()
    with _conn() as conn:
        conn.execute(
            "UPDATE topics SET title = ?, summary = ?, angles_json = ?, research_json = ?,"
            " last_progress_at = ?, updated_at = ? WHERE id = ?",
            (
                title,
                summary,
                json.dumps(angles, ensure_ascii=False),
                json.dumps(research, ensure_ascii=False),
                now,
                now,
                topic_id,
            ),
        )


def dismiss_topic(topic_id: str) -> str:
    """candidate → dismissed。返回 'ok' | 'not_found' | 'conflict'。"""
    with _conn() as conn:
        row = conn.execute("SELECT status FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if row is None:
            return "not_found"
        if row["status"] != "candidate":
            return "conflict"
        conn.execute(
            "UPDATE topics SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'candidate'",
            (_now(), topic_id),
        )
    return "ok"


def adopt_topic(topic_id: str, pid: str) -> bool:
    """条件更新 candidate → adopted 并回链项目 id；False = 已被并发认领。"""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE topics SET status = 'adopted', adopted_pid = ?, updated_at = ?,"
            " last_progress_at = ? WHERE id = ? AND status = 'candidate'",
            (pid, _now(), _now(), topic_id),
        )
        return cur.rowcount > 0


def archive_stale(days: int = 90) -> int:
    """candidate 且 last_progress_at 超过 N 天的沉底归档（池面保持"现在能做什么"）。"""
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE topics SET status = 'archived', updated_at = ?"
            " WHERE status = 'candidate' AND last_progress_at < ?",
            (_now(), cutoff),
        )
        return cur.rowcount
