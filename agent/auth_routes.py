"""认证/用户/API Key 路由（移植自 juben server/routers/auth.py 与 api_keys.py）。

挂载在 /api/v1 前缀下（与 juben 的路径约定一致），前端经 Next 同源代理
/api/v1/* → 127.0.0.1:8123/api/v1/* 访问。
"""

import logging
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field

import auth

logger = logging.getLogger(__name__)

router = APIRouter()

API_KEY_DEFAULT_EXPIRY_DAYS = 30


# ==================== 响应模型 ====================


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    role: str | None = None
    id: str | None = None


class VerifyResponse(BaseModel):
    valid: bool
    username: str
    role: str
    id: str | None = None


class AuthStatusResponse(BaseModel):
    enabled: bool
    register_open: bool


class UserInfo(BaseModel):
    id: str
    username: str
    role: str
    is_active: bool


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=8)


class RegisterResponse(TokenResponse):
    user: UserInfo


class CreateUserRequest(RegisterRequest):
    role: Literal["admin", "member"] = "member"


class UpdateUserRequest(BaseModel):
    role: Literal["admin", "member"] | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=1)


class CreateApiKeyRequest(BaseModel):
    name: str
    expires_days: int | None = Field(None, ge=0)  # None 默认 30 天，0 表示不过期


class CreateApiKeyResponse(BaseModel):
    id: int
    name: str
    key: str  # 完整 key，仅在创建时返回一次
    key_prefix: str
    created_at: str
    expires_at: str | None


class ApiKeyInfo(BaseModel):
    id: int
    name: str
    key_prefix: str
    created_at: str
    expires_at: str | None
    last_used_at: str | None


def _ensure_admin_row(admin: auth.CurrentUserInfo) -> None:
    """env 管理员首次调管理接口时落库，保证「最后一个 admin」保护有账可查。"""
    if admin.id != auth.DEFAULT_USER_ID:
        return
    auth.user_ensure_default_admin(
        username=admin.sub or os.environ.get("AUTH_USERNAME", "admin"),
        password_hash=auth.hash_password(os.environ.get("AUTH_PASSWORD", "")),
    )


def _require_jwt_auth(user: auth.CurrentUserInfo) -> None:
    """API Key 管理操作不允许由 API Key 本身执行。"""
    if user.sub.startswith("apikey:"):
        raise HTTPException(status_code=403, detail="jwt_auth_required")


def _generate_api_key() -> str:
    return f"{auth.API_KEY_PREFIX}{secrets.token_hex(16)}"


# ==================== 认证 ====================


@router.get("/auth/status", response_model=AuthStatusResponse)
async def auth_status():
    """前端 bootstrap 探针：enabled=false 时跳过登录直接进主界面。不要求认证。"""
    return AuthStatusResponse(enabled=auth.is_auth_enabled(), register_open=auth.is_register_open())


@router.post("/auth/token", response_model=TokenResponse)
async def login_for_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
):
    """OAuth2 标准表单登录。AUTH_ENABLED=false 时跳过校验直接发 token。"""
    user = auth.authenticate_user(form_data.username, form_data.password)
    if auth.is_auth_enabled() and user is None:
        logger.warning("登录失败: 用户名或密码错误 (用户: %s)", form_data.username)
        raise HTTPException(
            status_code=401,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if user is None:
        token = auth.create_user_token(
            user_id=auth.DEFAULT_USER_ID, username=form_data.username, role="admin"
        )
        role, user_id = "admin", None
    else:
        token = auth.create_user_token(user_id=user.id, username=user.sub, role=user.role)
        role, user_id = user.role, user.id
    logger.info("用户登录成功: %s", form_data.username)
    return TokenResponse(access_token=token, token_type="bearer", role=role, id=user_id)


@router.post("/auth/register", response_model=RegisterResponse)
async def register(req: RegisterRequest):
    """自助注册（AUTH_REGISTER_OPEN=true 开放；新账号一律 member）。"""
    if not auth.is_register_open():
        raise HTTPException(status_code=403, detail="注册未开放，请联系管理员创建账号")
    try:
        user = auth.user_create(
            username=req.username, password_hash=auth.hash_password(req.password)
        )
    except Exception:  # noqa: BLE001 —— UNIQUE 冲突等
        raise HTTPException(status_code=409, detail="用户名已存在")

    token = auth.create_user_token(
        user_id=user["id"], username=user["username"], role=user["role"]
    )
    return RegisterResponse(
        access_token=token,
        token_type="bearer",
        role=user["role"],
        user=UserInfo(**user),
    )


@router.get("/auth/verify", response_model=VerifyResponse)
async def verify(current_user: auth.CurrentUser):
    return VerifyResponse(
        valid=True, username=current_user.sub, role=current_user.role, id=current_user.id
    )


@router.post("/auth/change-password")
async def change_password(req: ChangePasswordRequest, user: auth.CurrentUser):
    """自助改密（仅 JWT 身份）：验当前密码后换 hash。

    admin（id=default）拒绝：其登录凭据优先走 env（check_credentials 的
    env 分支先于库），改库 hash 不生效——改 .env.local 的 AUTH_PASSWORD
    重启 agent 才是真的。"""
    _require_jwt_auth(user)
    if user.id == auth.DEFAULT_USER_ID:
        raise HTTPException(
            status_code=422, detail="admin 密码由服务端 .env.local 的 AUTH_PASSWORD 管理"
        )
    row = auth.user_get_by_username(user.sub, include_hash=True)
    if row is None or not auth.verify_password(
        req.current_password, row.get("password_hash") or ""
    ):
        raise HTTPException(status_code=400, detail="当前密码不正确")
    auth.user_update_fields(row["id"], password_hash=auth.hash_password(req.new_password))
    return {"ok": True}


# ==================== 用户管理 ====================


@router.get("/users")
async def list_users_light(current_user: auth.CurrentUser, q: str | None = None):
    """轻量用户检索（协作者选择器用；不返回密码/角色）。"""
    if q and q.strip():
        users = auth.user_search(q.strip())
    else:
        users = [
            {"id": u["id"], "username": u["username"]}
            for u in auth.user_list(include_inactive=False)
        ]
    return {"users": users}


@router.get("/admin/users")
async def list_users(admin: auth.RequireAdmin):
    _ensure_admin_row(admin)
    return {"users": auth.user_list(include_inactive=True)}


@router.post("/admin/users")
async def create_user(req: CreateUserRequest, admin: auth.RequireAdmin):
    _ensure_admin_row(admin)
    try:
        user = auth.user_create(
            username=req.username,
            password_hash=auth.hash_password(req.password),
            role=req.role,
        )
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=409, detail="用户名已存在")
    return {"user": user}


@router.patch("/admin/users/{user_id}")
async def update_user(user_id: str, req: UpdateUserRequest, admin: auth.RequireAdmin):
    _ensure_admin_row(admin)
    fields: dict[str, object] = {}
    if req.role is not None:
        fields["role"] = req.role
    if req.is_active is not None:
        fields["is_active"] = req.is_active
    if req.password is not None:
        fields["password_hash"] = auth.hash_password(req.password)

    if not fields:
        raise HTTPException(status_code=422, detail="no_fields_to_update")
    if user_id == admin.id and fields.get("is_active") is False:
        raise HTTPException(status_code=422, detail="cannot_disable_self")

    target = auth.user_get_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    if (
        target["role"] == "admin"
        and target["is_active"]
        and (fields.get("is_active") is False or fields.get("role") == "member")
    ):
        if auth.user_count_active_admins() <= 1:
            raise HTTPException(status_code=422, detail="cannot_demote_last_admin")
    user = auth.user_update_fields(user_id, **fields)
    return {"user": user}


# ==================== API Key ====================


@router.post("/api-keys", status_code=201)
async def create_api_key(body: CreateApiKeyRequest, user: auth.CurrentUser):
    """创建 API Key。完整 key 仅在响应中出现一次，之后无法再查看。"""
    _require_jwt_auth(user)
    key = _generate_api_key()
    key_hash = auth._hash_api_key(key)
    key_prefix = key[: len(auth.API_KEY_PREFIX) + 4]

    if body.expires_days == 0:
        expires_at: datetime | None = None
    elif body.expires_days is not None:
        expires_at = datetime.now(UTC) + timedelta(days=body.expires_days)
    else:
        expires_at = datetime.now(UTC) + timedelta(days=API_KEY_DEFAULT_EXPIRY_DAYS)

    try:
        row = auth.api_key_create(
            name=body.name,
            key_hash=key_hash,
            key_prefix=key_prefix,
            expires_at=expires_at.isoformat() if expires_at else None,
        )
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=409, detail=f"API Key 名称已存在：{body.name}")

    return CreateApiKeyResponse(key=key, **row)


@router.get("/api-keys")
async def list_api_keys(user: auth.CurrentUser) -> list[ApiKeyInfo]:
    _require_jwt_auth(user)
    return [ApiKeyInfo(**row) for row in auth.api_key_list()]


@router.delete("/api-keys/{key_id}", status_code=204)
async def delete_api_key(key_id: int, user: auth.CurrentUser) -> None:
    """吊销 API Key；先失效缓存再删库，避免宽限窗口。"""
    _require_jwt_auth(user)
    row = auth.api_key_get_by_id(key_id)
    if row is None:
        raise HTTPException(status_code=404, detail="api_key_not_found")
    auth.invalidate_api_key_cache(row["key_hash"])
    if not auth.api_key_delete(key_id):
        raise HTTPException(status_code=404, detail="api_key_not_found")
