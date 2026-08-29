"""项目与画布的服务端持久化（SQLite）。

projects + canvases + chat_messages 三张表：画布整体 JSON 存取，
聊天历史按消息行存取（与画布同为服务端唯一事实源，刷新/换设备可回填）。
前端经 /agent-service/projects/* 同源代理访问。

多用户（AUTH_ENABLED=true 时）：
- projects.owner_id 记录归属（默认 'default'，兼容单人时期的存量数据）
- projects.collaborators 是协作者用户名 JSON 数组（owner/admin 可管理）
- 访问规则（照搬 juben 的 _access.py 语义）：admin 全放行；owner_id='default'
  的存量项目全员可见；owner 或协作者放行；其余 404（防探测枚举）
"""

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

# 访问上下文的最小用户视图（auth.CurrentUserInfo 的 duck-typing 子集）
class _Viewer:
    def __init__(self, id: str, sub: str, role: str):  # noqa: A002 —— 与字段名一致
        self.id = id
        self.sub = sub
        self.role = role


ANON_VIEWER = _Viewer(id="default", sub="local", role="admin")


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvases (
                project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                nodes TEXT NOT NULL DEFAULT '[]',
                edges TEXT NOT NULL DEFAULT '[]',
                viewport TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (project_id, seq)
            );
            """
        )
        # 存量库升级：归属与协作者列（幂等）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}
        if "owner_id" not in cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'default'"
            )
        if "collaborators" not in cols:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN collaborators TEXT NOT NULL DEFAULT '[]'"
            )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _get_project_row(conn: sqlite3.Connection, pid: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()


def _collaborators_of(row: sqlite3.Row) -> List[str]:
    try:
        raw = json.loads(row["collaborators"] or "[]")
        return raw if isinstance(raw, list) else []
    except (ValueError, TypeError):
        return []


def can_access(viewer: Any, row: sqlite3.Row) -> bool:
    """admin → 全放行；存量无主项目（owner_id='default'）→ 全员可见；
    其余仅 owner 与协作者。"""
    if getattr(viewer, "role", "admin") == "admin":
        return True
    if row["owner_id"] == "default":
        return True
    return row["owner_id"] == viewer.id or viewer.sub in _collaborators_of(row)


def assert_access(viewer: Any, pid: str) -> sqlite3.Row:
    """按 pid 取项目行并校验访问权；无权/不存在一律 404（防枚举）。"""
    with _conn() as conn:
        row = _get_project_row(conn, pid)
    if row is None or not can_access(viewer, row):
        import fastapi

        raise fastapi.HTTPException(status_code=404, detail="项目不存在或无权访问")
    return row


def list_projects(viewer: Any = ANON_VIEWER) -> List[Dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at, owner_id, collaborators FROM projects"
            " ORDER BY updated_at DESC"
        ).fetchall()
    visible = [r for r in rows if can_access(viewer, r)]
    out: List[Dict[str, Any]] = []
    for r in visible:
        d = dict(r)
        d["collaborators"] = _collaborators_of(r)
        out.append(d)
    return out


def create_project(name: str, viewer: Any = ANON_VIEWER) -> Dict[str, str]:
    pid = uuid.uuid4().hex[:12]
    now = _now()
    # 关闭认证时归属记为 default（存量兼容）；开启后归属当前用户
    owner = "default" if getattr(viewer, "role", "admin") == "admin" and viewer.id == "default" else viewer.id
    with _conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at, owner_id, collaborators)"
            " VALUES (?, ?, ?, ?, ?, '[]')",
            (pid, name.strip() or "未命名项目", now, now, owner),
        )
    return {"id": pid, "name": name.strip() or "未命名项目", "updated_at": now}


def delete_project(pid: str, viewer: Any = ANON_VIEWER) -> bool:
    assert_access(viewer, pid)
    with _conn() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.execute("DELETE FROM canvases WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (pid,))
    return cur.rowcount > 0


def rename_project(pid: str, name: str, viewer: Any = ANON_VIEWER) -> bool:
    assert_access(viewer, pid)
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
            (name.strip() or "未命名项目", _now(), pid),
        )
    return cur.rowcount > 0


def load_canvas(pid: str, viewer: Any = ANON_VIEWER) -> Dict[str, Any] | None:
    assert_access(viewer, pid)
    with _conn() as conn:
        row = conn.execute(
            "SELECT nodes, edges, viewport FROM canvases WHERE project_id = ?", (pid,)
        ).fetchone()
        if not row:
            return None
    return {
        "nodes": json.loads(row["nodes"]),
        "edges": json.loads(row["edges"]),
        "viewport": json.loads(row["viewport"]),
    }


def save_canvas(pid: str, nodes: Any, edges: Any, viewport: Any, viewer: Any = ANON_VIEWER) -> bool:
    assert_access(viewer, pid)
    now = _now()
    with _conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (pid,)
        ).fetchone()
        if not exists:
            return False
        conn.execute(
            """
            INSERT INTO canvases (project_id, nodes, edges, viewport, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                nodes=excluded.nodes, edges=excluded.edges,
                viewport=excluded.viewport, updated_at=excluded.updated_at
            """,
            (
                pid,
                json.dumps(nodes, ensure_ascii=False),
                json.dumps(edges, ensure_ascii=False),
                json.dumps(viewport or {"x": 0, "y": 0, "zoom": 1}),
                now,
            ),
        )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, pid))
    return True


# ---------- 协作者（owner/admin 管理；协作者获得与 owner 同等编辑权） ----------


def list_collaborators(pid: str, viewer: Any = ANON_VIEWER) -> List[str]:
    return _collaborators_of(assert_access(viewer, pid))


def add_collaborator(pid: str, username: str, viewer: Any = ANON_VIEWER) -> List[str]:
    row = _require_owner(viewer, pid)
    collab = _collaborators_of(row)
    name = username.strip()
    if name and name not in collab:
        collab.append(name)
        _write_collaborators(pid, collab)
    return collab


def remove_collaborator(pid: str, username: str, viewer: Any = ANON_VIEWER) -> List[str]:
    row = _require_owner(viewer, pid)
    collab = [c for c in _collaborators_of(row) if c != username.strip()]
    _write_collaborators(pid, collab)
    return collab


def _require_owner(viewer: Any, pid: str) -> sqlite3.Row:
    """管理协作者需要 owner 或 admin。"""
    row = assert_access(viewer, pid)
    if getattr(viewer, "role", "admin") != "admin" and row["owner_id"] != viewer.id:
        import fastapi

        raise fastapi.HTTPException(status_code=403, detail="仅项目所有者可管理协作者")
    return row


def _write_collaborators(pid: str, collab: List[str]) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE projects SET collaborators = ?, updated_at = ? WHERE id = ?",
            (json.dumps(collab, ensure_ascii=False), _now(), pid),
        )


# ---------- 聊天历史（前端整表覆盖写，服务端只保可信字段） ----------

# 防御性上限：单条消息与整段历史的体积/条数封顶，避免流式期间异常膨胀
MAX_MESSAGES = 400
MAX_MESSAGE_CHARS = 20_000


def load_chat_messages(pid: str, viewer: Any = ANON_VIEWER) -> List[Dict[str, Any]]:
    assert_access(viewer, pid)
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, role, content, created_at FROM chat_messages"
            " WHERE project_id = ? ORDER BY seq",
            (pid,),
        ).fetchall()
    return [dict(r) for r in rows]


def save_chat_messages(
    pid: str, messages: Any, viewer: Any = ANON_VIEWER
) -> List[Dict[str, Any]]:
    """整表覆盖：以客户端发来的顺序重建（seq=0..n-1），事务内先删后插。"""
    assert_access(viewer, pid)
    items: List[Dict[str, str]] = []
    if isinstance(messages, list):
        for m in messages:
            if not isinstance(m, dict):
                continue
            mid = str(m.get("id") or uuid.uuid4().hex[:16])
            role = str(m.get("role") or "")
            content = str(m.get("content") or "")
            if role not in ("user", "assistant") or not content.strip():
                continue
            items.append(
                {
                    "id": mid[:64],
                    "role": role,
                    "content": content[:MAX_MESSAGE_CHARS],
                    "created_at": str(m.get("created_at") or _now())[:40],
                }
            )
    items = items[-MAX_MESSAGES:]
    now = _now()
    with _conn() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (pid,))
        conn.executemany(
            "INSERT INTO chat_messages (project_id, seq, id, role, content, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            [
                (pid, i, it["id"], it["role"], it["content"], it["created_at"])
                for i, it in enumerate(items)
            ],
        )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, pid))
    return items
