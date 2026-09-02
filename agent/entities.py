"""实体登记表：人物/物/案件/年代/地点的跨选题知识节点（实体图谱地基）。

实体只从管线证据里长出来（pull 不 push）：verdict 从证据中抽取具名实体，
这里负责归一（kind+名称指纹唯一、别名合并）、证据底账追加、与选题卡双向
关联。实体页纪律与选题卡一致：只存证据支撑的事实，不做无信源推断——
不做"上下五千年全量预填"，图谱在干活的地方生长。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

# 实体类型：与 verdict 的 unit_kind 同源，另加 place（遗址/地点/场域）
ENTITY_KINDS: tuple[str, ...] = ("person", "object", "case", "era", "place")
# 每实体保留的证据条目上限（信源底账，超出丢弃最旧）
EVIDENCE_CAP = 30


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_entities_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                name_fp TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                aliases_json TEXT NOT NULL DEFAULT '[]',
                evidence_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                UNIQUE(kind, name_fp)
            );
            CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
            CREATE TABLE IF NOT EXISTS topic_entities (
                topic_id TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (topic_id, entity_id)
            );
            CREATE INDEX IF NOT EXISTS idx_topic_entities_entity ON topic_entities(entity_id);
            """
        )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def entity_fp(name: str) -> str:
    """实体名指纹：规范化（去标点、小写）后 sha256——同名异写归一。"""
    keep = [ch for ch in name.lower() if ch.isalnum()]
    return hashlib.sha256("".join(keep).encode("utf-8")).hexdigest()


def _serialize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "summary": row["summary"],
        "aliases": json.loads(row["aliases_json"]),
        "evidence": json.loads(row["evidence_json"]),
        "topicCount": row["topic_count"] if "topic_count" in row.keys() else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastSeenAt": row["last_seen_at"],
    }


def _find_by_fps(conn: sqlite3.Connection, kind: str, fps: list[str]) -> sqlite3.Row | None:
    marks = ",".join("?" * len(fps))
    return conn.execute(
        f"SELECT * FROM entities WHERE kind = ? AND name_fp IN ({marks}) LIMIT 1", (kind, *fps)
    ).fetchone()


def upsert_entity(
    kind: str,
    name: str,
    *,
    summary: str = "",
    aliases: list[str] | None = None,
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """按 kind+名称指纹归一实体；已存在则合并别名、追加证据底账。

    summary 只增不改已有值（旧摘要是旧证据的产物）；evidence 按 url 去重。
    """
    kind = kind.strip().lower()
    name = name.strip()
    if kind not in ENTITY_KINDS:
        raise ValueError(f"未知实体类型: {kind}")
    if not name:
        raise ValueError("实体名不能为空")
    alias_list = [a.strip() for a in (aliases or []) if a.strip() and a.strip() != name]
    fps = [entity_fp(name)] + [entity_fp(a) for a in alias_list]
    now = _now()
    with _conn() as conn:
        row = _find_by_fps(conn, kind, fps)
        if row is None:
            entity_id = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO entities (id, kind, name, name_fp, summary, aliases_json,"
                " evidence_json, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    entity_id,
                    kind,
                    name,
                    entity_fp(name),
                    summary,
                    json.dumps(alias_list, ensure_ascii=False),
                    json.dumps((evidence or [])[:EVIDENCE_CAP], ensure_ascii=False),
                    now,
                    now,
                    now,
                ),
            )
        else:
            entity_id = row["id"]
            merged_aliases = list(json.loads(row["aliases_json"]))
            for candidate in [name, *alias_list]:
                if candidate != row["name"] and candidate not in merged_aliases:
                    merged_aliases.append(candidate)
            merged_evidence = list(json.loads(row["evidence_json"]))
            seen_urls = {str(e.get("url") or "") for e in merged_evidence}
            for item in evidence or []:
                url = str(item.get("url") or "")
                if url and url in seen_urls:
                    continue
                seen_urls.add(url)
                merged_evidence.append(item)
            new_summary = row["summary"] or summary
            conn.execute(
                "UPDATE entities SET aliases_json = ?, evidence_json = ?, summary = ?,"
                " updated_at = ?, last_seen_at = ? WHERE id = ?",
                (
                    json.dumps(merged_aliases, ensure_ascii=False),
                    json.dumps(merged_evidence[-EVIDENCE_CAP:], ensure_ascii=False),
                    new_summary,
                    now,
                    now,
                    entity_id,
                ),
            )
    return get_entity(entity_id)  # type: ignore[return-value]


def get_entity(entity_id: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM entities WHERE id = ?", (entity_id,)).fetchone()
    return _serialize(row) if row else None


def list_entities(
    *, kind: str | None = None, q: str | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    """实体浏览：按最近出现排序；kind 筛选、q 搜名称/摘要/别名。"""
    sql = (
        "SELECT e.*, (SELECT COUNT(*) FROM topic_entities te WHERE te.entity_id = e.id)"
        " AS topic_count FROM entities e WHERE 1=1"
    )
    params: list[Any] = []
    if kind:
        sql += " AND e.kind = ?"
        params.append(kind)
    if q:
        sql += " AND (e.name LIKE ? OR e.summary LIKE ? OR e.aliases_json LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like])
    sql += " ORDER BY e.last_seen_at DESC LIMIT ?"
    params.append(limit)
    with _conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_serialize(r) for r in rows]


def entities_for_topic(topic_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT e.* FROM entities e JOIN topic_entities te ON te.entity_id = e.id"
            " WHERE te.topic_id = ? ORDER BY e.name",
            (topic_id,),
        ).fetchall()
    return [_serialize(r) for r in rows]


def topics_for_entity(entity_id: str) -> list[dict[str, Any]]:
    """该实体关联的全部选题卡（含已认领/已忽略——实体的记忆比池面长）。"""
    import topics

    with _conn() as conn:
        rows = conn.execute(
            "SELECT t.* FROM topics t JOIN topic_entities te ON te.topic_id = t.id"
            " WHERE te.entity_id = ? ORDER BY t.created_at DESC",
            (entity_id,),
        ).fetchall()
    return [topics._serialize(r) for r in rows]


def link_topic(topic_id: str, entity_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO topic_entities (topic_id, entity_id, created_at) VALUES (?, ?, ?)",
            (topic_id, entity_id, _now()),
        )
