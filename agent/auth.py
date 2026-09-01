"""认证核心模块（移植自 juben/Wingsight 主项目 server/auth.py，适配裸 SQLite 存储）。

提供 JWT 签发/验证、Argon2 密码哈希、API Key（`wingsight-` 前缀 Bearer）认证。
设计要点（与 juben 一致）：
- ``AUTH_ENABLED`` 总开关：false/0/no/off 时全链路 bypass 返回匿名 admin，
  单人使用零登录成本；开启后走 env 管理员 + DB 用户双轨。
- DB 为准的角色刷新：JWT 带 uid 时每请求查库取 role/is_active，
  管理员改角色后旧 token 立即生效。
默认关闭认证（本工具单机单人场景）；多人使用时在 .env 开启。
"""

import hashlib
import logging
import os
import secrets
import sqlite3
import string
import time
import uuid
from collections import OrderedDict
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Query
from fastapi.security import OAuth2PasswordBearer
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)

# 与 projects.py 共用同一个 SQLite 文件
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "wingsight.db")

# 匿名/环境管理员的固定用户 id（与 juben 的 DEFAULT_USER_ID 约定一致）
DEFAULT_USER_ID = "default"


class CurrentUserInfo(BaseModel):
    """Current authenticated user info."""

    id: str
    sub: str
    role: str = "admin"
    via: str = "jwt"

    model_config = ConfigDict(frozen=True)


# ---------- env 解析 ----------

# 视为"关闭认证"的取值。空串不在内——.env 误写 `AUTH_ENABLED=` 应按显式值处理。
_AUTH_DISABLED_VALUES = frozenset({"false", "0", "no", "off"})
_ANONYMOUS_USER_SUB = "local"


def is_auth_enabled() -> bool:
    """wingsight-studio 默认关闭（单机单人）；多人部署显式设 AUTH_ENABLED=true。"""
    return os.environ.get("AUTH_ENABLED", "false").strip().lower() not in _AUTH_DISABLED_VALUES


def is_register_open() -> bool:
    """自助注册开关（默认关；管理员经 /admin/users 建号）。"""
    return os.environ.get("AUTH_REGISTER_OPEN", "false").strip().lower() in {"1", "true", "yes", "on"}


def _anonymous_user() -> CurrentUserInfo:
    return CurrentUserInfo(id=DEFAULT_USER_ID, sub=_ANONYMOUS_USER_SUB, role="admin", via="local")


# ---------- JWT ----------

TOKEN_EXPIRY_SECONDS = 7 * 24 * 3600  # 7 天
_cached_token_secret: str | None = None

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token", auto_error=False)


def get_token_secret() -> str:
    """优先 AUTH_TOKEN_SECRET env；否则进程内自动生成（重启即失效，宜显式配置）。"""
    global _cached_token_secret
    env_secret = os.environ.get("AUTH_TOKEN_SECRET")
    if env_secret:
        return env_secret
    if _cached_token_secret is None:
        _cached_token_secret = secrets.token_hex(32)
        logger.info("已自动生成 JWT 签名密钥（重启后 token 失效，建议配置 AUTH_TOKEN_SECRET）")
    return _cached_token_secret


def create_user_token(*, user_id: str, username: str, role: str) -> str:
    now = time.time()
    payload = {
        "uid": user_id,
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + TOKEN_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, get_token_secret(), algorithm="HS256")


def verify_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, get_token_secret(), algorithms=["HS256"])
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


# ---------- 密码 ----------

_password_hash = PasswordHash.recommended()
_cached_password_hash: str | None = None


def generate_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return _password_hash.verify(password, password_hash)


def _get_env_password_hash() -> str:
    global _cached_password_hash
    if _cached_password_hash is None:
        _cached_password_hash = _password_hash.hash(os.environ.get("AUTH_PASSWORD", ""))
    return _cached_password_hash


def check_credentials(username: str, password: str) -> bool:
    """env 管理员凭据校验。即使用户名不匹配也执行哈希验证，防时序攻击。"""
    expected_username = os.environ.get("AUTH_USERNAME", "admin")
    # compare_digest 对非 ASCII str 会 TypeError，中文用户名必须先 UTF-8 编码
    username_ok = secrets.compare_digest(
        username.encode("utf-8"), expected_username.encode("utf-8")
    )
    password_ok = _password_hash.verify(password, _get_env_password_hash())
    return username_ok and password_ok


# ---------- SQLite 用户 / API Key 存储 ----------


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_auth_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                key_hash TEXT NOT NULL UNIQUE,
                key_prefix TEXT NOT NULL,
                user_id TEXT NOT NULL DEFAULT 'default',
                created_at TEXT NOT NULL,
                expires_at TEXT,
                last_used_at TEXT
            );
            """
        )


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def user_get_by_username(username: str, include_hash: bool = False) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row is None:
        return None
    d = dict(row)
    if not include_hash:
        d.pop("password_hash", None)
    return d


def user_get_by_id(user_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d.pop("password_hash", None)
    return d


def usernames_by_ids(user_ids: list[str]) -> dict[str, str]:
    """批量 id→username（项目列表 owner 展示用）；查不到的 id 不在返回里。"""
    ids = sorted({i for i in user_ids if i})
    if not ids:
        return {}
    with _conn() as conn:
        marks = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT id, username FROM users WHERE id IN ({marks})", ids
        ).fetchall()
    return {r["id"]: r["username"] for r in rows}


def user_create(username: str, password_hash: str, role: str = "member") -> dict:
    uid = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 1, ?, ?)",
            (uid, username, password_hash, role, now, now),
        )
    return {"id": uid, "username": username, "role": role, "is_active": True}


def user_list(include_inactive: bool = True) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, username, role, is_active, created_at, updated_at FROM users"
            + ("" if include_inactive else " WHERE is_active = 1")
            + " ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def user_search(username_fragment: str, limit: int = 20) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, username FROM users WHERE is_active = 1 AND username LIKE ?"
            " ORDER BY username LIMIT ?",
            (f"%{username_fragment}%", limit),
        ).fetchall()
    return [dict(r) for r in rows]


def user_update_fields(user_id: str, **fields: object) -> dict | None:
    if not fields:
        return None
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        cur = conn.execute(
            f"UPDATE users SET {sets}, updated_at = ? WHERE id = ?",
            (*fields.values(), _now(), user_id),
        )
        if cur.rowcount == 0:
            return None
    return user_get_by_id(user_id)


def user_count_active_admins() -> int:
    with _conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1"
        ).fetchone()
    return int(row["c"])


def user_ensure_default_admin(username: str, password_hash: str) -> None:
    """把 env 管理员账号落库（uid=default），使协作者等功能有真实用户行可用。"""
    with _conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM users WHERE id = ?", (DEFAULT_USER_ID,)
        ).fetchone()
        if exists:
            return
        now = _now()
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)"
            " VALUES (?, ?, ?, 'admin', 1, ?, ?)"
            " ON CONFLICT(id) DO NOTHING",
            (DEFAULT_USER_ID, username, password_hash, now, now),
        )


def api_key_get_by_hash(key_hash: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,)
        ).fetchone()
    return dict(row) if row else None


def api_key_create(
    name: str, key_hash: str, key_prefix: str, expires_at: str | None
) -> dict:
    now = _now()
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO api_keys (name, key_hash, key_prefix, created_at, expires_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (name, key_hash, key_prefix, now, expires_at),
        )
        kid = cur.lastrowid
    return {"id": kid, "name": name, "key_prefix": key_prefix, "created_at": now, "expires_at": expires_at}


def api_key_list() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, name, key_prefix, created_at, expires_at, last_used_at FROM api_keys"
            " ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def api_key_get_by_id(key_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    return dict(row) if row else None


def api_key_delete(key_id: int) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    return cur.rowcount > 0


def api_key_touch_last_used(key_hash: str) -> None:
    try:
        with _conn() as conn:
            conn.execute(
                "UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?",
                (_now(), key_hash),
            )
    except Exception:  # noqa: BLE001 —— 非致命
        logger.exception("更新 API Key last_used_at 失败（非致命）")


# ---------- 登录 ----------


def authenticate_user(username: str, password: str) -> CurrentUserInfo | None:
    """env 管理员优先，DB 用户 fallback；失败返回 None。"""
    if check_credentials(username, password):
        return CurrentUserInfo(id=DEFAULT_USER_ID, sub=username, role="admin")

    row = user_get_by_username(username, include_hash=True)
    if row is not None:
        stored = row.get("password_hash")
        if row.get("is_active") and isinstance(stored, str) and verify_password(password, stored):
            return CurrentUserInfo(
                id=str(row["id"]), sub=str(row["username"]), role=str(row["role"])
            )
    return None


# ---------- API Key 验证（LRU 缓存，逻辑照搬 juben） ----------

API_KEY_PREFIX = "wingsight-"
API_KEY_CACHE_TTL = 300  # 5 分钟
_api_key_cache: OrderedDict[str, tuple[dict | None, float]] = OrderedDict()
_API_KEY_CACHE_MAX = 512


def _hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def invalidate_api_key_cache(key_hash: str) -> None:
    _api_key_cache.pop(key_hash, None)


def _get_cached_api_key_payload(key_hash: str) -> tuple[bool, dict | None]:
    entry = _api_key_cache.get(key_hash)
    if entry is None:
        return False, None
    payload, expiry = entry
    if time.monotonic() > expiry:
        _api_key_cache.pop(key_hash, None)
        return False, None
    _api_key_cache.move_to_end(key_hash)
    return True, payload


def _set_api_key_cache(key_hash: str, payload: dict | None) -> None:
    if len(_api_key_cache) >= _API_KEY_CACHE_MAX:
        _api_key_cache.popitem(last=False)
    _api_key_cache[key_hash] = (payload, time.monotonic() + API_KEY_CACHE_TTL)


def _verify_api_key(token: str) -> dict | None:
    key_hash = _hash_api_key(token)
    hit, cached = _get_cached_api_key_payload(key_hash)
    if hit:
        return cached

    row = api_key_get_by_hash(key_hash)
    if row is None:
        _set_api_key_cache(key_hash, None)
        return None

    expires_at = row.get("expires_at")
    if expires_at:
        from datetime import datetime, timezone

        try:
            exp_dt = datetime.fromisoformat(expires_at)
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) >= exp_dt:
                _set_api_key_cache(key_hash, None)
                return None
        except (ValueError, TypeError):
            logger.warning("API Key expires_at 无法解析，忽略过期检查: %r", expires_at)

    payload = {"sub": f"apikey:{row['name']}", "via": "apikey"}
    _set_api_key_cache(key_hash, payload)
    api_key_touch_last_used(key_hash)
    return payload


# ---------- 请求侧依赖 ----------


def _verify_and_get_payload(token: str) -> dict:
    payload = verify_token(token)
    if payload is None:
        raise HTTPException(
            status_code=401,
            detail="token 无效或已过期",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


def _verify_and_get_payload_async(token: str) -> dict:
    if token.startswith(API_KEY_PREFIX):
        payload = _verify_api_key(token)
        if payload is None:
            raise HTTPException(
                status_code=401,
                detail="API Key 无效、已过期或不存在",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return payload
    return _verify_and_get_payload(token)


def _payload_to_user(payload: dict) -> CurrentUserInfo:
    sub = payload.get("sub", "")
    user_id = str(payload.get("uid") or DEFAULT_USER_ID)
    role = str(payload.get("role") or "admin")
    via = str(payload.get("via") or "jwt")
    return CurrentUserInfo(id=user_id, sub=sub, role=role, via=via)


def _resolve_current_user(payload: dict) -> CurrentUserInfo:
    """DB 用户（JWT 带 uid）以库内 role/is_active 为准——改角色即时生效。"""
    via = str(payload.get("via") or "jwt")
    if via == "apikey" or "uid" not in payload:
        return _payload_to_user(payload)

    user_id = str(payload["uid"])
    try:
        row = user_get_by_id(user_id)
    except Exception:  # noqa: BLE001 —— DB 短暂不可用回退 JWT claim，避免全站锁死
        logger.exception("加载用户 %s 失败，回退 JWT role claim", user_id)
        return _payload_to_user(payload)

    if row is None:
        # env 管理员签发的 uid=default 可能尚未落库；回退 claim 避免登录后立刻 401
        if user_id == DEFAULT_USER_ID:
            return _payload_to_user(payload)
        raise HTTPException(
            status_code=401,
            detail="用户不存在或已停用",
            headers={"WWW-Authenticate": "Bearer"},
        )
    sub = str(payload.get("sub") or row["username"])
    return CurrentUserInfo(id=str(row["id"]), sub=sub, role=str(row["role"]), via=via)


async def get_current_user(
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
) -> CurrentUserInfo:
    """标准认证依赖——JWT 与 API Key Bearer 均可；AUTH_ENABLED=false 时匿名 admin。"""
    if not is_auth_enabled():
        return _anonymous_user()
    if not token:
        raise HTTPException(
            status_code=401, detail="未认证", headers={"WWW-Authenticate": "Bearer"}
        )
    payload = _verify_and_get_payload_async(token)
    return _resolve_current_user(payload)


async def get_current_user_flexible(
    token: Annotated[str | None, Depends(oauth2_scheme)] = None,
    query_token: str | None = Query(None, alias="token"),
) -> CurrentUserInfo:
    """宽松认证依赖——额外支持 ?token= query（SSE/媒体标签等无法带 header 的场景）。"""
    if not is_auth_enabled():
        return _anonymous_user()
    raw = token or query_token
    if not raw:
        raise HTTPException(
            status_code=401, detail="缺少认证 token", headers={"WWW-Authenticate": "Bearer"}
        )
    payload = _verify_and_get_payload_async(raw)
    return _resolve_current_user(payload)


CurrentUser = Annotated[CurrentUserInfo, Depends(get_current_user)]
CurrentUserFlexible = Annotated[CurrentUserInfo, Depends(get_current_user_flexible)]


async def require_admin(user: CurrentUser) -> CurrentUserInfo:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin_required")
    return user


RequireAdmin = Annotated[CurrentUserInfo, Depends(require_admin)]


def ensure_auth_password(env_path: str | None = None) -> str:
    """AUTH_ENABLED 且未设 AUTH_PASSWORD 时自动生成并回写 .env（照搬 juben）。"""
    if not is_auth_enabled():
        return ""
    password = os.environ.get("AUTH_PASSWORD")
    if password:
        return password

    password = generate_password()
    os.environ["AUTH_PASSWORD"] = password

    from pathlib import Path

    if env_path is None:
        env_path = str(Path(__file__).resolve().parent.parent / ".env.local")
    env_file = Path(env_path)
    try:
        if env_file.exists():
            lines = env_file.read_text(encoding="utf-8").splitlines()
            new_lines = []
            found = False
            for line in lines:
                if not found and line.strip().startswith("AUTH_PASSWORD="):
                    new_lines.append(f"AUTH_PASSWORD={password}")
                    found = True
                else:
                    new_lines.append(line)
            if not found:
                new_lines.append(f"AUTH_PASSWORD={password}")
            content = "\n".join(new_lines) + "\n"
            with open(env_file, "r+", encoding="utf-8") as f:
                f.seek(0)
                f.write(content)
                f.truncate()
        else:
            env_file.write_text(f"AUTH_PASSWORD={password}\n", encoding="utf-8")
    except OSError:
        logger.warning("无法写入 %s，生成的密码仅本次进程有效", env_path)

    logger.warning("已自动生成认证密码，请查看 AUTH_PASSWORD 字段（%s）", env_path)
    return password
