"""认证与项目隔离的后端冒烟测试（不经浏览器，FastAPI TestClient 直测）。

运行：cd agent && uv run python ../scripts/auth-smoke-test.py
使用临时数据库，不污染 data/wingsight.db。
"""

import json
import os
import sys
import tempfile
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
sys.path.insert(0, str(AGENT_DIR))

# ---------- 在 import main 之前设置测试环境 ----------

os.environ.update(
    AUTH_ENABLED="false",
    AUTH_TOKEN_SECRET="smoke-test-secret",
    AUTH_USERNAME="admin",
    AUTH_PASSWORD="admin-pass-123",
    AUTH_REGISTER_OPEN="false",
)

import auth  # noqa: E402
import projects  # noqa: E402

# 数据库指向临时文件（auth._conn / projects._conn 每次读取模块级 DB_PATH）
_TMP = tempfile.mkdtemp(prefix="wingsight-auth-test-")
auth.DB_PATH = str(Path(_TMP) / "test.db")
projects.DB_PATH = Path(_TMP) / "test.db"

import main  # noqa: E402  (import 时以临时库初始化)

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

PASS = 0
FAIL = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {extra}")


def enable_auth(on: bool) -> None:
    os.environ["AUTH_ENABLED"] = "true" if on else "false"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(username: str, password: str):
    r = client.post("/api/v1/auth/token", data={"username": username, "password": password})
    return r


print("== 场景 1：AUTH_ENABLED=false（默认，单人模式）==")
r = client.get("/api/v1/auth/status")
check("status 显示未启用", r.status_code == 200 and r.json()["enabled"] is False)
r = client.get("/projects")
check("匿名可直接列项目", r.status_code == 200)
r = login("whoever", "whatever")
check("任意凭据可换 token", r.status_code == 200 and r.json()["access_token"])

print("== 场景 2：开启认证 ==")
enable_auth(True)

r = client.get("/projects")
check("无 token 访问项目 → 401", r.status_code == 401)
r = login("admin", "wrong-password")
check("错误密码 → 401", r.status_code == 401)

r = login("admin", "admin-pass-123")
check("env 管理员登录", r.status_code == 200 and r.json()["role"] == "admin")
admin_token = r.json()["access_token"]
r = client.get("/api/v1/auth/verify", headers=bearer(admin_token))
check("token 校验通过", r.status_code == 200 and r.json()["username"] == "admin")

r = client.post("/api/v1/auth/register", json={"username": "eve", "password": "x"})
check("注册未开放 → 403", r.status_code == 403)

# admin 建两个 member
for name in ("alice", "bob"):
    r = client.post(
        "/api/v1/admin/users",
        json={"username": name, "password": f"pass-{name}", "role": "member"},
        headers=bearer(admin_token),
    )
    check(f"admin 创建用户 {name}", r.status_code == 200)
r = client.post(
    "/api/v1/admin/users",
    json={"username": "alice", "password": "dup", "role": "member"},
    headers=bearer(admin_token),
)
check("重复用户名 → 409", r.status_code == 409)

alice_token = login("alice", "pass-alice").json()["access_token"]
bob_token = login("bob", "pass-bob").json()["access_token"]

print("== 场景 3：项目归属与隔离 ==")
# alice 建项目
r = client.post("/projects", json={"name": "爱丽丝的片子"}, headers=bearer(alice_token))
check("alice 建项目", r.status_code == 200)
pid = r.json()["id"]

r = client.get("/projects", headers=bearer(alice_token))
check("alice 能看到自己的项目", any(p["id"] == pid for p in r.json()))
r = client.get("/projects", headers=bearer(bob_token))
check("bob 看不到 alice 的项目", not any(p["id"] == pid for p in r.json()))
r = client.get(f"/projects/{pid}/canvas", headers=bearer(bob_token))
check("bob 取画布 → 404（防枚举）", r.status_code == 404)
r = client.put(
    f"/projects/{pid}/canvas",
    json={"nodes": [], "edges": [], "viewport": {}},
    headers=bearer(bob_token),
)
check("bob 存画布 → 404", r.status_code == 404)

r = client.get("/projects", headers=bearer(admin_token))
check("admin 全量可见", any(p["id"] == pid for p in r.json()))
r = client.put(
    f"/projects/{pid}/canvas",
    json={"nodes": [{"id": "n1"}], "edges": [], "viewport": {"x": 1}},
    headers=bearer(admin_token),
)
check("admin 可存他人项目画布", r.status_code == 200)

print("== 场景 4：协作者共享 ==")
r = client.post(
    f"/projects/{pid}/collaborators", json={"username": "bob"}, headers=bearer(bob_token)
)
check("局外人碰协作者接口 → 404（防枚举）", r.status_code == 404)
r = client.post(
    f"/projects/{pid}/collaborators", json={"username": "bob"}, headers=bearer(alice_token)
)
check("owner 添加协作者 bob", r.status_code == 200 and "bob" in r.json()["collaborators"])
r = client.post(
    f"/projects/{pid}/collaborators", json={"username": "bob"}, headers=bearer(bob_token)
)
check("协作者（非 owner）管理名册 → 403", r.status_code == 403)
r = client.get("/projects", headers=bearer(bob_token))
check("协作者 bob 现在可见项目", any(p["id"] == pid for p in r.json()))
r = client.put(
    f"/projects/{pid}/canvas",
    json={"nodes": [{"id": "n2"}], "edges": [], "viewport": {}},
    headers=bearer(bob_token),
)
check("协作者可编辑画布", r.status_code == 200)
r = client.delete(f"/projects/{pid}/collaborators/bob", headers=bearer(alice_token))
check("owner 移除协作者", r.status_code == 200 and "bob" not in r.json()["collaborators"])
r = client.get("/projects", headers=bearer(bob_token))
check("移除后 bob 失去可见性", not any(p["id"] == pid for p in r.json()))

print("== 场景 5：存量项目全员可见（向后兼容）==")
r = client.post("/projects", json={"name": "legacy"}, headers=bearer(admin_token))
legacy_pid = r.json()["id"]
r = client.get("/projects", headers=bearer(bob_token))
check("owner=default 的存量项目 bob 可见", any(p["id"] == legacy_pid for p in r.json()))

print("== 场景 6：API Key ==")
r = client.post("/api/v1/api-keys", json={"name": "ci"}, headers=bearer(alice_token))
check("创建 API Key 返回完整 key 一次", r.status_code == 201 and r.json()["key"].startswith("wingsight-"))
api_key = r.json()["key"]
r = client.get("/api/v1/auth/verify", headers=bearer(api_key))
check("API Key 可当 Bearer 用", r.status_code == 200 and r.json()["username"].startswith("apikey:"))
r = client.get("/api/v1/api-keys", headers=bearer(api_key))
check("API Key 不能管理 API Key → 403", r.status_code == 403)
kid = client.get("/api/v1/api-keys", headers=bearer(alice_token)).json()[0]["id"]
r = client.delete(f"/api/v1/api-keys/{kid}", headers=bearer(alice_token))
check("吊销 API Key", r.status_code == 204)
r = client.get("/api/v1/auth/verify", headers=bearer(api_key))
check("吊销后立即失效（缓存已清）", r.status_code == 401)

print("== 场景 7：管理保护规则 ==")
r = client.get("/api/v1/admin/users", headers=bearer(alice_token))
check("member 访问管理接口 → 403", r.status_code == 403)
r = client.patch(
    "/api/v1/admin/users/default", json={"is_active": False}, headers=bearer(admin_token)
)
check("不能停用自己 → 422", r.status_code == 422)

# 收尾：关掉认证，验证回到单人模式
enable_auth(False)
r = client.get("/projects")
check("关闭后恢复匿名访问", r.status_code == 200)

print(f"\n结果：{PASS} 通过，{FAIL} 失败")
sys.exit(1 if FAIL else 0)
