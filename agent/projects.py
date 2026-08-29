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
            CREATE TABLE IF NOT EXISTS chat_threads (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
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
            CREATE TABLE IF NOT EXISTS assets (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                url TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'upload',
                created_at TEXT NOT NULL,
                PRIMARY KEY (project_id, id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_url ON assets (project_id, url);
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
        _migrate_chat_to_threads(conn)


def _migrate_chat_to_threads(conn: sqlite3.Connection) -> None:
    """单会话 → 多会话迁移（幂等）：

    chat_messages 老主键 (project_id, seq) 不区分会话；重建为
    (project_id, thread_id, seq)，存量消息归入每个项目自动建的
    「历史会话」（标题取首条用户消息前 18 字，与前端自动标题规则一致）。
    """
    has_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_messages'"
    ).fetchone()
    if not has_table:
        return
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(chat_messages)")}
    if "thread_id" in cols:
        return
    rows = conn.execute(
        "SELECT project_id, seq, id, role, content, created_at FROM chat_messages"
        " ORDER BY project_id, seq"
    ).fetchall()
    conn.execute("ALTER TABLE chat_messages RENAME TO chat_messages_legacy")
    conn.execute(
        """
        CREATE TABLE chat_messages (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, thread_id, seq)
        )
        """
    )
    # 每个有消息的项目建一个默认会话，旧消息整体搬入
    by_project: Dict[str, List[sqlite3.Row]] = {}
    for r in rows:
        by_project.setdefault(r["project_id"], []).append(r)
    for pid, msgs in by_project.items():
        first_user = next((m for m in msgs if m["role"] == "user"), None)
        title = (first_user["content"][:18] if first_user else "历史会话") or "历史会话"
        tid = uuid.uuid4().hex[:12]
        created = msgs[0]["created_at"]
        conn.execute(
            "INSERT INTO chat_threads (id, project_id, title, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (tid, pid, title, created, msgs[-1]["created_at"]),
        )
        conn.executemany(
            "INSERT INTO chat_messages (project_id, thread_id, seq, id, role, content, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(pid, tid, m["seq"], m["id"], m["role"], m["content"], m["created_at"]) for m in msgs],
        )
    conn.execute("DROP TABLE chat_messages_legacy")


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
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM assets WHERE project_id = ?", (pid,))
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


# ---------- 聊天会话（多会话：threads + 按会话存消息） ----------

# 防御性上限：单条消息与整段历史的体积/条数封顶，避免流式期间异常膨胀
MAX_MESSAGES = 400
MAX_MESSAGE_CHARS = 20_000
AUTO_TITLE_CHARS = 18  # 自动标题长度（前端历史列表同款规则）


def _get_thread(
    conn: sqlite3.Connection, pid: str, tid: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM chat_threads WHERE id = ? AND project_id = ?", (tid, pid)
    ).fetchone()


def _assert_thread(conn: sqlite3.Connection, pid: str, tid: str) -> sqlite3.Row:
    row = _get_thread(conn, pid, tid)
    if row is None:
        import fastapi

        raise fastapi.HTTPException(status_code=404, detail="会话不存在")
    return row


def list_threads(pid: str, viewer: Any = ANON_VIEWER) -> List[Dict[str, Any]]:
    assert_access(viewer, pid)
    with _conn() as conn:
        rows = conn.execute(
            "SELECT t.id, t.title, t.updated_at, COUNT(m.seq) AS message_count"
            " FROM chat_threads t LEFT JOIN chat_messages m"
            " ON m.project_id = t.project_id AND m.thread_id = t.id"
            " WHERE t.project_id = ?"
            " GROUP BY t.id ORDER BY t.updated_at DESC",
            (pid,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_thread(pid: str, title: str = "", viewer: Any = ANON_VIEWER) -> Dict[str, Any]:
    assert_access(viewer, pid)
    tid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO chat_threads (id, project_id, title, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (tid, pid, title.strip()[:40], now, now),
        )
    return {"id": tid, "title": title.strip()[:40], "updated_at": now, "message_count": 0}


def rename_thread(pid: str, tid: str, title: str, viewer: Any = ANON_VIEWER) -> bool:
    with _conn() as conn:
        _assert_thread(conn, pid, tid)
        cur = conn.execute(
            "UPDATE chat_threads SET title = ? WHERE id = ? AND project_id = ?",
            (title.strip()[:40] or "未命名会话", tid, pid),
        )
    return cur.rowcount > 0


def delete_thread(pid: str, tid: str, viewer: Any = ANON_VIEWER) -> bool:
    assert_access(viewer, pid)
    with _conn() as conn:
        _assert_thread(conn, pid, tid)
        conn.execute(
            "DELETE FROM chat_messages WHERE project_id = ? AND thread_id = ?", (pid, tid)
        )
        cur = conn.execute(
            "DELETE FROM chat_threads WHERE id = ? AND project_id = ?", (tid, pid)
        )
    return cur.rowcount > 0


def load_chat_messages(
    pid: str, tid: str, viewer: Any = ANON_VIEWER
) -> List[Dict[str, Any]]:
    assert_access(viewer, pid)
    with _conn() as conn:
        _assert_thread(conn, pid, tid)
        rows = conn.execute(
            "SELECT id, role, content, created_at FROM chat_messages"
            " WHERE project_id = ? AND thread_id = ? ORDER BY seq",
            (pid, tid),
        ).fetchall()
    return [dict(r) for r in rows]


def save_chat_messages(
    pid: str, tid: str, messages: Any, viewer: Any = ANON_VIEWER
) -> List[Dict[str, Any]]:
    """整表覆盖（按会话）：重建 seq，touch 会话 updated_at，空标题时自动取首条用户消息。"""
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
        thread = _assert_thread(conn, pid, tid)
        conn.execute(
            "DELETE FROM chat_messages WHERE project_id = ? AND thread_id = ?", (pid, tid)
        )
        conn.executemany(
            "INSERT INTO chat_messages (project_id, thread_id, seq, id, role, content, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (pid, tid, i, it["id"], it["role"], it["content"], it["created_at"])
                for i, it in enumerate(items)
            ],
        )
        # 自动标题：无标题且有用户消息 → 取首条前 N 字（一次性，之后保留用户命名）
        title = thread["title"] or ""
        if not title:
            first_user = next((it["content"] for it in items if it["role"] == "user"), "")
            title = first_user[:AUTO_TITLE_CHARS].strip() or "未命名会话"
        conn.execute(
            "UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?",
            (title, now, tid),
        )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, pid))
    return items


# ---------- 素材库（生成历史自动入库 + 手动收藏；url 同项目内去重） ----------

ASSET_KINDS = ("image", "video", "audio")
MAX_ASSETS = 2000


def list_assets(pid: str, viewer: Any = ANON_VIEWER) -> List[Dict[str, Any]]:
    assert_access(viewer, pid)
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, kind, title, url, source, created_at FROM assets"
            " WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            (pid, MAX_ASSETS),
        ).fetchall()
    return [dict(r) for r in rows]


def save_asset(
    pid: str,
    kind: str,
    title: str,
    url: str,
    source: str = "upload",
    viewer: Any = ANON_VIEWER,
) -> Dict[str, Any]:
    """入库（幂等）：url 已存在时直接返回既有记录，不重复插入。"""
    assert_access(viewer, pid)
    if kind not in ASSET_KINDS:
        import fastapi

        raise fastapi.HTTPException(status_code=400, detail=f"kind 必须是 {'/'.join(ASSET_KINDS)}")
    u = str(url or "").strip()
    # 只收本服务资产与公网 URL（防 file:// 等伪协议入库）
    if not (u.startswith("/agent-service/assets/") or u.startswith(("http://", "https://"))):
        import fastapi

        raise fastapi.HTTPException(status_code=400, detail="url 必须是本服务资产或 http(s) 地址")
    src = "generation" if source == "generation" else "upload"
    aid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO assets (project_id, id, kind, title, url, source, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (pid, aid, kind, (title or "").strip()[:80], u, src, now),
        )
        row = conn.execute(
            "SELECT id, kind, title, url, source, created_at FROM assets"
            " WHERE project_id = ? AND url = ?",
            (pid, u),
        ).fetchone()
    return (
        dict(row)
        if row
        else {"id": aid, "kind": kind, "title": title, "url": u, "source": src, "created_at": now}
    )


def delete_asset(pid: str, aid: str, viewer: Any = ANON_VIEWER) -> bool:
    assert_access(viewer, pid)
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM assets WHERE project_id = ? AND id = ?", (pid, aid)
        )
    return cur.rowcount > 0
