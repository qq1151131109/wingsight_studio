"""项目与画布的服务端持久化（SQLite）。

projects + canvases + chat_messages 三张表：画布整体 JSON 存取，
聊天历史按消息行存取（与画布同为服务端唯一事实源，刷新/换设备可回填）。
前端经 /agent-service/projects/* 同源代理访问。

多用户（AUTH_ENABLED=true 时）：
- projects.owner_id 记录归属（默认 'default'，兼容单人时期的存量数据）
- projects.collaborators 是协作者用户名 JSON 数组（owner/admin 可管理）
- 访问规则（照搬 juben 的 _access.py 语义）：admin 全放行；owner 或协作者
  放行；其余 404（防探测枚举）。admin 的 id 即 'default'，存量项目归 admin
"""

import json
import re
import sqlite3
import uuid

import auth  # noqa: E402  (owner 用户名批量查询；auth 不反向依赖本模块，无环)

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
                meta TEXT NOT NULL DEFAULT '{}',
                revision INTEGER NOT NULL DEFAULT 1,
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
            -- 会话分支（2026-09-11 行业共识：「重新生成/编辑重发」产生新版本，旧版本
            -- 可 ‹ i/N › 切回，且模型上下文跟着切换的版本走——不是只改显示）。
            -- 一条 = 某一「轮」被放弃的那一版：turn_id 是该轮的用户消息 id，
            -- checkpoint_id 是它作为会话头时的 checkpoint（切回时据此复原上下文），
            -- messages 是那一版的助手消息（切回后前端直接渲染，不必重跑）。
            CREATE TABLE IF NOT EXISTS chat_branches (
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                messages TEXT NOT NULL DEFAULT '[]',
                checkpoint_id TEXT NOT NULL DEFAULT '',
                -- active=1：这一版就是会话当前头（切回来的那版保留原 idx = 位置稳定，
                -- 与 ChatGPT/Claude 一致：切回第 1 版就显示 1/2，而不是把它排到末尾）
                active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                PRIMARY KEY (thread_id, turn_id, idx)
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
        # 存量库升级：画布 meta 列（项目级画风等扩展配置，幂等）
        ccols = {r["name"] for r in conn.execute("PRAGMA table_info(canvases)")}
        if "meta" not in ccols:
            conn.execute("ALTER TABLE canvases ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'")
        if "revision" not in ccols:
            conn.execute("ALTER TABLE canvases ADD COLUMN revision INTEGER NOT NULL DEFAULT 1")
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
        title = (
            _fallback_title([dict(m) for m in msgs]) if first_user else "历史会话"
        ) or "历史会话"
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
    """admin → 全放行；其余仅 owner 与协作者（无权/不存在一律 404 防枚举，
    见 assert_access）。admin 的 user id 就是 'default'，单人时期存量项目
    天然归 admin 所有，无需迁移。"""
    if getattr(viewer, "role", "admin") == "admin":
        return True
    return row["owner_id"] == viewer.id or viewer.sub in _collaborators_of(row)


def project_id_of_thread(thread_id: str) -> str | None:
    """聊天会话 → 所属项目 id（后端工具定位项目用；未知线程返回 None）。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT project_id FROM chat_threads WHERE id = ?", (thread_id,)
        ).fetchone()
    return row["project_id"] if row else None


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
    # 批量补 owner 用户名（卡片展示；历史遗留 owner_id 如 default 不在用户表则原样透出）。
    # 协作者字段存的就是用户名（JWT sub=username，can_access 按用户名比对），直接透传。
    names = auth.usernames_by_ids([r["owner_id"] for r in visible])
    out: List[Dict[str, Any]] = []
    for r in visible:
        d = dict(r)
        d["collaborators"] = _collaborators_of(r)
        d["ownerName"] = names.get(r["owner_id"], r["owner_id"])
        d["collaboratorNames"] = _collaborators_of(r)
        # 前端按此隐藏重命名/删除等生命周期操作（协作者可见可分享但不管辖）
        d["canManage"] = (
            getattr(viewer, "role", "admin") == "admin" or r["owner_id"] == viewer.id
        )
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
    _require_owner(viewer, pid)
    with _conn() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.execute("DELETE FROM canvases WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (pid,))
        # 分支表按 thread_id 存（无 project_id 列），删线程前先把它们的行清掉，
        # 否则项目一删就留下再也无人认领的孤儿行
        conn.execute(
            "DELETE FROM chat_branches WHERE thread_id IN"
            " (SELECT id FROM chat_threads WHERE project_id = ?)",
            (pid,),
        )
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM assets WHERE project_id = ?", (pid,))
    return cur.rowcount > 0


def rename_project(pid: str, name: str, viewer: Any = ANON_VIEWER) -> bool:
    _require_owner(viewer, pid)
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
            "SELECT nodes, edges, viewport, meta, revision FROM canvases WHERE project_id = ?",
            (pid,),
        ).fetchone()
        if not row:
            return None
    return {
        "nodes": json.loads(row["nodes"]),
        "edges": json.loads(row["edges"]),
        "viewport": json.loads(row["viewport"]),
        "meta": json.loads(row["meta"] or "{}"),
        "revision": int(row["revision"] or 1),
    }


def save_canvas(
    pid: str,
    nodes: Any,
    edges: Any,
    viewport: Any,
    meta: Any = None,
    viewer: Any = ANON_VIEWER,
    expected_revision: int | None = None,
    force: bool = False,
) -> tuple[bool, int] | None:
    """保存画布。乐观锁：expected_revision 与当前不一致且未 force 时返回 None
    （调用方转 409 冲突）。成功返回 (True, 新 revision)。项目不存在返回 None。

    返回值：(True, rev) 成功｜None 冲突或项目不存在——冲突与缺失由调用方
    先行探测（load 一个不存在的项目会 404），这里用 None 模糊处理可接受。
    """
    assert_access(viewer, pid)
    now = _now()
    with _conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (pid,)
        ).fetchone()
        if not exists:
            return None
        row = conn.execute(
            "SELECT revision FROM canvases WHERE project_id = ?", (pid,)
        ).fetchone()
        current = int(row["revision"]) if row else 1
        if expected_revision is not None and not force and current != int(expected_revision):
            return (False, current)
        new_rev = current + 1
        if row:
            conn.execute(
                """
                UPDATE canvases SET nodes=?, edges=?, viewport=?, meta=?,
                    revision=?, updated_at=?
                WHERE project_id=?
                """,
                (
                    json.dumps(nodes, ensure_ascii=False),
                    json.dumps(edges, ensure_ascii=False),
                    json.dumps(viewport or {"x": 0, "y": 0, "zoom": 1}),
                    json.dumps(meta or {}, ensure_ascii=False),
                    new_rev,
                    now,
                    pid,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO canvases (project_id, nodes, edges, viewport, meta, revision, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pid,
                    json.dumps(nodes, ensure_ascii=False),
                    json.dumps(edges, ensure_ascii=False),
                    json.dumps(viewport or {"x": 0, "y": 0, "zoom": 1}),
                    json.dumps(meta or {}, ensure_ascii=False),
                    new_rev,
                    now,
                ),
            )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, pid))
    return (True, new_rev)


# ---------- 协作者（owner/admin 管理；协作者获得与 owner 同等编辑权） ----------


def list_collaborators(pid: str, viewer: Any = ANON_VIEWER) -> List[str]:
    return _collaborators_of(assert_access(viewer, pid))


def add_collaborator(pid: str, username: str, viewer: Any = ANON_VIEWER) -> List[str]:
    """有访问权即可分享（owner 与协作者同等），但只能添加真实存在的用户。"""
    row = assert_access(viewer, pid)
    collab = _collaborators_of(row)
    name = username.strip()
    if not name:
        return collab
    import auth

    if not any(u["username"] == name for u in auth.user_search(name)):
        import fastapi

        raise fastapi.HTTPException(status_code=404, detail="用户不存在")
    if name not in collab:
        collab.append(name)
        _write_collaborators(pid, collab)
    return collab


def remove_collaborator(pid: str, username: str, viewer: Any = ANON_VIEWER) -> List[str]:
    row = assert_access(viewer, pid)
    collab = [c for c in _collaborators_of(row) if c != username.strip()]
    _write_collaborators(pid, collab)
    return collab


def _require_owner(viewer: Any, pid: str) -> sqlite3.Row:
    """改名/删除等生命周期操作需要 owner 或 admin（协作者可分享但不管辖）。"""
    row = assert_access(viewer, pid)
    if getattr(viewer, "role", "admin") != "admin" and row["owner_id"] != viewer.id:
        import fastapi

        raise fastapi.HTTPException(status_code=403, detail="仅项目所有者可执行此操作")
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
# 客户端指定的会话 id 形制（与历史服务端生成规则一致：12~32 位十六进制）
_THREAD_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")

# 上下文界标（与前端 lib/chat/messageContext.ts 的 CTX_MARK/MANIFEST_MARK 同值）：
# 带附件/引用的用户消息正文是「显示文本 + 界标 + 人话段 + manifest」结构，机械
# 标题若直接切前 N 字会把界标当标题（「<<<WS-CTX>>> （用户未」——2026-09-12
# 纯附件发消息实报），取材前必须先剥壳
CTX_MARK = "<<<WS-CTX>>>"
MANIFEST_MARK = "<<<WS-MANIFEST>>>"


def _title_source_text(content: str) -> str:
    """机械标题的取材文本：界标消息取显示段；纯附件消息显示段为空时退附件名。"""
    text = str(content or "")
    if CTX_MARK not in text:
        return text
    display = text.split(CTX_MARK, 1)[0].strip()
    if display:
        return display
    if MANIFEST_MARK in text:
        try:
            data = json.loads(text.split(MANIFEST_MARK, 1)[1].strip())
            names = [
                str(a.get("name") or "").strip()
                for a in (data.get("attachments") or [])
                if isinstance(a, dict)
            ]
            names = [n for n in names if n]
            if names:
                return names[0]
        except Exception:  # noqa: BLE001 — manifest 形状异常走兜底文案
            pass
    return "附件消息"


def _fallback_title(messages: List[Dict[str, Any]]) -> str:
    """机械标题：首条用户消息的显示文本（或附件名）首行截断。"""
    first_user = next(
        (str(m.get("content") or "") for m in messages if m.get("role") == "user"), ""
    )
    src = _title_source_text(first_user)
    return (src.splitlines()[0].strip() if src else "")[:AUTO_TITLE_CHARS]


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
        first_users = conn.execute(
            "SELECT thread_id, content FROM chat_messages"
            " WHERE project_id = ? AND role = 'user' AND seq = 0",
            (pid,),
        ).fetchall()
    # 标题是否仍是机械产物随列表下发：前端页签靠它在 LLM 智能命名落库后
    # 及时重拉回显（会话内新建会话不刷新页面，标题升级只有这条通道可见）
    first_user_by_thread = {r["thread_id"]: r["content"] for r in first_users}
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        first_user = first_user_by_thread.get(d["id"])
        d["title_mechanical"] = thread_title_is_mechanical(
            str(d.get("title") or ""),
            (
                [{"role": "user", "content": first_user}]
                if first_user is not None
                else []
            ),
        )
        out.append(d)
    return out


def create_thread(
    pid: str, title: str = "", viewer: Any = ANON_VIEWER, tid: str = ""
) -> Dict[str, Any]:
    """建会话。tid 可由客户端指定（与 agent 侧 langgraph thread 同 id 的前提），
    非法或撞 id 时回退服务端生成。"""
    assert_access(viewer, pid)
    tid = (tid or "").strip()
    if not _THREAD_ID_RE.fullmatch(tid):
        tid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        try:
            conn.execute(
                "INSERT INTO chat_threads (id, project_id, title, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (tid, pid, title.strip()[:40], now, now),
            )
        except sqlite3.IntegrityError:
            tid = uuid.uuid4().hex[:12]
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
        # 分支表按 thread_id 存（没有 project_id 列），会话删除时一并清干净
        conn.execute("DELETE FROM chat_branches WHERE thread_id = ?", (tid,))
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


# ── 会话分支（‹ i/N › 版本切换，2026-09-11 行业共识）─────────────────────────
# 语义：一轮（= 一条用户消息）的答复可以有 N 个版本。「重新生成」时被放弃的那一版
# 连同**当时作为会话头的 checkpoint** 一起落库；切回旧版本时用那个 checkpoint 复原
# 模型上下文（Claude/ChatGPT 的分支切换是「显示与上下文一起切」，不是只改显示）。
# 当前生效的那一版不落库——它就是会话的实时头，需要时从 chat_messages 现算。


def turn_messages_after(messages: List[Dict[str, Any]], turn_id: str) -> List[Dict[str, Any]]:
    """取某轮（turn_id 那条用户消息）之后、下一条用户消息之前的消息 = 该轮答复。"""
    out: List[Dict[str, Any]] = []
    started = False
    for m in messages:
        if not started:
            if str(m.get("id") or "") == turn_id:
                started = True
            continue
        if str(m.get("role") or "") == "user":
            break
        out.append(m)
    return out


def save_branch(
    thread_id: str,
    turn_id: str,
    idx: int,
    messages: List[Dict[str, Any]],
    checkpoint_id: str,
    active: int = 0,
) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO chat_branches"
            " (thread_id, turn_id, idx, messages, checkpoint_id, active, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                thread_id,
                turn_id,
                int(idx),
                json.dumps(messages, ensure_ascii=False),
                str(checkpoint_id or ""),
                int(active),
                _now(),
            ),
        )


def list_branches(thread_id: str) -> List[Dict[str, Any]]:
    """该会话已落库的（被放弃的）分支版本，按轮、按序。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT turn_id, idx, messages, checkpoint_id, active FROM chat_branches"
            " WHERE thread_id = ? ORDER BY turn_id, idx",
            (thread_id,),
        ).fetchall()
    out: List[Dict[str, Any]] = []
    for r in rows:
        try:
            msgs = json.loads(r["messages"] or "[]")
        except (ValueError, TypeError):
            msgs = []
        out.append(
            {
                "turn_id": r["turn_id"],
                "idx": int(r["idx"]),
                "messages": msgs if isinstance(msgs, list) else [],
                "checkpoint_id": r["checkpoint_id"] or "",
                "active": int(r["active"] or 0) == 1,
            }
        )
    return out


def get_branch(thread_id: str, turn_id: str, idx: int) -> Dict[str, Any] | None:
    for b in list_branches(thread_id):
        if b["turn_id"] == turn_id and b["idx"] == int(idx):
            return b
    return None


def next_branch_idx(thread_id: str, turn_id: str) -> int:
    with _conn() as conn:
        row = conn.execute(
            "SELECT MAX(idx) AS m FROM chat_branches WHERE thread_id = ? AND turn_id = ?",
            (thread_id, turn_id),
        ).fetchone()
    return int(row["m"] or 0) + 1


def set_branch_active(thread_id: str, turn_id: str, idx: int, active: bool) -> None:
    """把某一版标为/取消「当前头」。切回的版本**保留原 idx**——位置稳定，
    前端显示 1/2 而不是把它排到末尾（ChatGPT/Claude 同口径）。"""
    with _conn() as conn:
        conn.execute(
            "UPDATE chat_branches SET active = ?"
            " WHERE thread_id = ? AND turn_id = ? AND idx = ?",
            (1 if active else 0, thread_id, turn_id, int(idx)),
        )


def clear_branch_active(thread_id: str, turn_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE chat_branches SET active = 0 WHERE thread_id = ? AND turn_id = ?",
            (thread_id, turn_id),
        )


def get_active_branch(thread_id: str, turn_id: str) -> Dict[str, Any] | None:
    for b in list_branches(thread_id):
        if b["turn_id"] == turn_id and b["active"]:
            return b
    return None


def thread_title_is_mechanical(title: str, messages: list) -> bool:
    """标题是否仍是机器产物（空 / 「未命名会话」遗留 / 首条用户消息的截断前缀
    或界标时代的显示段截断）——LLM 智能命名的触发条件。用户手动命名后标题
    不再是机械形态，天然免打扰。"""
    if not title or title == "未命名会话":
        return True
    first_user = next(
        (str(m.get("content") or "") for m in messages if m.get("role") == "user"), ""
    )
    if bool(first_user) and first_user.startswith(title):
        return True
    # 界标消息的机械标题取自显示段/附件名，不再满足 startswith（正文以界标或
    # 人话段开头）——与 _fallback_title 的产物比对
    return bool(first_user) and title == _fallback_title(messages)


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
            # reasoning（思考行）2026-09-12 起随会话落库：刷新回放对齐 codex
            # rollout / opencode part 持久化；下一轮 run input 回传给服务端重建
            # AIMessage.reasoning_content（DeepSeek 思考模式硬要求）
            if role not in ("user", "assistant", "reasoning") or not content.strip():
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
        # 自动标题（过渡态）：无标题且有用户消息 → 取首条显示文本（界标消息
        # 剥壳，纯附件退附件名）首行截断；首组对话完成后由 LLM 智能命名升级
        # （见 main.py 保存端点的后台任务）。不落「未命名会话」字面量——它会让
        # 后续命名逻辑误判"已有标题"而永不改名
        title = thread["title"] or ""
        if not title:
            title = _fallback_title(items)
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
