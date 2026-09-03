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
        # 生料/已深挖两态：存量卡都是深核管线的产物，默认 verified
        cols = {r[1] for r in conn.execute("PRAGMA table_info(topics)").fetchall()}
        if "stage" not in cols:
            conn.execute("ALTER TABLE topics ADD COLUMN stage TEXT NOT NULL DEFAULT 'verified'")
        if "tags_json" not in cols:
            conn.execute("ALTER TABLE topics ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'")
        # 成片推演（跟拍谁/追查什么/从哪到哪）：生料卡的成立性凭证，没有它不落库
        if "arc" not in cols:
            conn.execute("ALTER TABLE topics ADD COLUMN arc TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_topics_stage ON topics(stage)")


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
        "stage": row["stage"],
        "arc": row["arc"],
        "tags": json.loads(row["tags_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastProgressAt": row["last_progress_at"],
        "lastRescanAt": row["last_rescan_at"],
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
    stage: str = "verified",
    tags: list[str] | None = None,
    arc: str = "",
) -> dict[str, Any]:
    tid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO topics (id, vertical, source, title, title_fingerprint, summary,"
            " angles_json, heat_evidence_json, research_json, status, stage, tags_json, arc,"
            " last_progress_at, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)",
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
                stage,
                json.dumps(tags or [], ensure_ascii=False),
                arc,
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
    stage: str | None = None,
    q: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """status='all' 返回全部状态（前端按 status tab 自己分流）；stage 过滤生料/已深挖。"""
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
    if stage:
        sql += " AND stage = ?"
        params.append(stage)
    if q:
        sql += " AND (title LIKE ? OR summary LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with _conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_serialize(r) for r in rows]


def count_topics(status: str | None = None, stage: str | None = None) -> int:
    """池内计数（生料区"共 M 条"展示用；全表 COUNT，无分页）。"""
    sql = "SELECT COUNT(*) AS n FROM topics WHERE 1=1"
    params: list[Any] = []
    if status:
        sql += " AND status = ?"
        params.append(status)
    if stage:
        sql += " AND stage = ?"
        params.append(stage)
    with _conn() as conn:
        row = conn.execute(sql, params).fetchone()
    return int(row["n"]) if row else 0


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


def upgrade_card(
    topic_id: str,
    *,
    title: str,
    summary: str,
    angles: list[str],
    research: dict[str, Any],
) -> None:
    """深挖升级为建议卡：补题目、概要与讲法角度，替换取证包；生料→已深挖。"""
    now = _now()
    with _conn() as conn:
        conn.execute(
            "UPDATE topics SET title = ?, summary = ?, angles_json = ?, research_json = ?,"
            " stage = 'verified', last_progress_at = ?, updated_at = ? WHERE id = ?",
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


# ---------- 观察卡复查（重扫） ----------


def _is_thin(row: sqlite3.Row) -> bool:
    """薄卡判定看 evidence_level（verdict 的薄卡也可能带讲法角度，不能看 angles）。"""
    try:
        return json.loads(row["research_json"]).get("evidence_level") != "strong"
    except (json.JSONDecodeError, AttributeError):
        return True


def list_rescan_candidates(limit: int = 3, cooldown_hours: float = 24.0) -> list[dict[str, Any]]:
    """待复查观察卡：candidate 薄卡（仅已深挖 stage；生料卡深挖是导演点名的
    动作，不进自动轮转），建卡/上次复查过了冷却，最久未扫优先（轮转覆盖）。

    从未扫过的排最前（新观察卡尽快兑现"继续盯"的承诺），其余按上次扫描时间正序。
    """
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=cooldown_hours)).isoformat()
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM topics WHERE status = 'candidate' AND stage = 'verified'"
            " ORDER BY created_at DESC LIMIT 500"
        ).fetchall()
    candidates = [r for r in rows if _is_thin(r)]
    candidates = [
        r
        for r in candidates
        if r["created_at"] < cutoff and (r["last_rescan_at"] is None or r["last_rescan_at"] < cutoff)
    ]
    candidates.sort(
        key=lambda r: (r["last_rescan_at"] is not None, r["last_rescan_at"] or "", r["created_at"])
    )
    return [_serialize(r) for r in candidates[:limit]]


def mark_rescanned(topic_id: str) -> None:
    """记一次复查（异常路径也记，坏卡不卡住轮转队列），并刷新沉底计时。"""
    now = _now()
    with _conn() as conn:
        conn.execute(
            "UPDATE topics SET last_rescan_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?",
            (now, now, now, topic_id),
        )


def record_rescan(topic_id: str, log: list[dict[str, Any]]) -> None:
    """复查仍薄时的收尾：信源底账追加本次取证（信息只增不减），并记扫描时间。

    观察内容（event/gaps/observation）不覆写——旧缺口仍是缺口，缺口之外的
    新事实只能以取证留痕的方式进入底账。
    """
    row = get_topic_row(topic_id)
    if row is None:
        return
    research = json.loads(row["research_json"])
    research["source_map"] = list(research.get("source_map") or []) + list(log)
    now = _now()
    with _conn() as conn:
        conn.execute(
            "UPDATE topics SET research_json = ?, last_rescan_at = ?, last_progress_at = ?,"
            " updated_at = ? WHERE id = ?",
            (json.dumps(research, ensure_ascii=False), now, now, now, topic_id),
        )
