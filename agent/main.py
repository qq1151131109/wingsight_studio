"""Wingsight 画布助手服务入口：FastAPI + AG-UI（LangGraph 适配）。

运行：cd agent && uv run uvicorn main:app --port 8123

认证（移植自 juben）：默认 AUTH_ENABLED=false 全链路匿名 admin（单人零登录）；
开启后项目/画布按归属隔离，登录与用户管理走 /api/v1/auth/*。
已知边界：AG-UI 根端点（"/"）与 /assets 静态文件未鉴权（资源名为随机 hex，
等价 capability URL）；后续可给 CopilotKit HttpAgent 加 headers 收紧。
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

# 配置优先级：agent/.env > 项目根 .env.local > 进程环境
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")
load_dotenv(_HERE.parent / ".env.local")

import auth  # noqa: E402  (在 dotenv 之后导入，读取最终环境变量)
import auth_routes  # noqa: E402
import graph  # noqa: E402
import projects  # noqa: E402
import skills  # noqa: E402

projects.init_db()
auth.init_auth_db()
auth.ensure_auth_password()


app = FastAPI(title="wingsight-agent")

app.add_middleware(
    CORSMiddleware,
    # agent 只绑定 127.0.0.1，外部不可直达；放开 origin 以兼容各种隧道/局域网来源
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 认证/用户/API Key（前端经 /api/v1 同源代理访问）
app.include_router(auth_routes.router, prefix="/api/v1")


agent = LangGraphAgent(
    name="default",
    graph=graph.graph,
    description="Wingsight 画布助手",
)

add_langgraph_fastapi_endpoint(app, agent, path="/")


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "model": os.environ.get("AGENT_MODEL", "deepseek-chat"),
        "base_url": os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        "skills": len(graph.skills.load_skill_registry()),
        "imagegen": bool(os.environ.get("LANGFLOW_IMAGEGEN_FLOW_ID")),
        "auth_enabled": auth.is_auth_enabled(),
    }


@app.get("/assets/{filename}")
def serve_asset(filename: str) -> FileResponse:
    """出图结果的静态暴露（前端经 /agent-service/assets/... 同源访问）。"""
    # 只允许纯文件名，杜绝路径穿越
    safe = Path(filename).name
    path = skills.ASSETS_DIR / safe
    if not path.is_file():
        return FileResponse(status_code=404, path="/dev/null")
    return FileResponse(path)


@app.post("/assets")
async def upload_asset(request: Request, user: auth.CurrentUser) -> dict:
    """粘贴/拖拽图片上传：body 为图片二进制；返回同源可访问 URL。"""
    import uuid as _uuid

    _ = user  # 认证关闭时为匿名 admin；开启后要求登录（软隔离，资源名随机不可猜）
    body = await request.body()
    if not body:
        return Response(status_code=400)  # type: ignore[return-value]
    if len(body) > 15 * 1024 * 1024:
        return Response(status_code=413)  # type: ignore[return-value]
    ctype = (request.headers.get("content-type") or "image/png").split(";")[0]
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }.get(ctype, ".png")
    skills.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{_uuid.uuid4().hex[:12]}{ext}"
    (skills.ASSETS_DIR / name).write_bytes(body)
    return {"url": f"/agent-service/assets/{name}"}


# ---------- 项目与画布持久化（前端经 /agent-service/projects/* 访问）----------


@app.get("/projects")
def api_list_projects(user: auth.CurrentUser):
    return projects.list_projects(user)


@app.post("/projects")
async def api_create_project(req: dict, user: auth.CurrentUser):
    return projects.create_project(str(req.get("name", "")), user)


@app.patch("/projects/{pid}")
async def api_rename_project(pid: str, req: dict, user: auth.CurrentUser):
    ok = projects.rename_project(pid, str(req.get("name", "")), user)
    return {"ok": ok} if ok else Response(status_code=404)


@app.delete("/projects/{pid}")
def api_delete_project(pid: str, user: auth.CurrentUser):
    return {"ok": projects.delete_project(pid, user)}


@app.get("/projects/{pid}/canvas")
def api_load_canvas(pid: str, user: auth.CurrentUser):
    data = projects.load_canvas(pid, user)
    if data is None:
        return Response(status_code=404)
    return data


@app.put("/projects/{pid}/canvas")
async def api_save_canvas(pid: str, req: dict, user: auth.CurrentUser):
    ok = projects.save_canvas(
        pid, req.get("nodes", []), req.get("edges", []), req.get("viewport"), user
    )
    return {"ok": ok} if ok else Response(status_code=404)


# ---------- 协作者（owner/admin 管理；协作者与 owner 同权编辑）----------


@app.get("/projects/{pid}/collaborators")
def api_list_collaborators(pid: str, user: auth.CurrentUser):
    return {"collaborators": projects.list_collaborators(pid, user)}


@app.post("/projects/{pid}/collaborators")
async def api_add_collaborator(pid: str, req: dict, user: auth.CurrentUser):
    return {"collaborators": projects.add_collaborator(pid, str(req.get("username", "")), user)}


@app.delete("/projects/{pid}/collaborators/{username}")
def api_remove_collaborator(pid: str, username: str, user: auth.CurrentUser):
    return {"collaborators": projects.remove_collaborator(pid, username, user)}
