"""Wingsight 画布助手服务入口：FastAPI + AG-UI（LangGraph 适配）。

运行：cd agent && uv run uvicorn main:app --port 8123

认证（移植自 juben）：默认 AUTH_ENABLED=false 全链路匿名 admin（单人零登录）；
开启后项目/画布按归属隔离，登录与用户管理走 /api/v1/auth/*。
已知边界：AG-UI 根端点（"/"）与 /assets 静态文件未鉴权（资源名为随机 hex，
等价 capability URL）；后续可给 CopilotKit HttpAgent 加 headers 收紧。
"""

import json
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
import camera  # noqa: E402
import compose  # noqa: E402
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
        "vision": graph._vision_enabled(),
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
async def upload_asset(request: Request, user: auth.CurrentUser, name: str = "") -> dict:
    """粘贴/拖拽/附件上传：body 为二进制；返回同源可访问 URL。

    图片 ≤15MB、视频 ≤200MB、文档（pdf/txt/md/json/csv/srt/docx…）≤20MB。
    扩展名推断：mime 映射优先，认不出的再看 ?name= 原始文件名的后缀，
    仍无法确定则 415 拒收（避免存成错误的 .png 之类）。
    """
    import uuid as _uuid

    _ = user  # 认证关闭时为匿名 admin；开启后要求登录（软隔离，资源名随机不可猜）
    body = await request.body()
    if not body:
        return Response(status_code=400)  # type: ignore[return-value]
    ctype = (request.headers.get("content-type") or "image/png").split(";")[0].strip().lower()
    is_video = ctype.startswith("video/")
    is_image = ctype.startswith("image/")
    is_doc = not is_video and not is_image
    limit = 200 * 1024 * 1024 if is_video else 15 * 1024 * 1024 if is_image else 20 * 1024 * 1024
    if len(body) > limit:
        return Response(status_code=413)  # type: ignore[return-value]
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/webm": ".weba",
        "application/pdf": ".pdf",
        "application/json": ".json",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "text/plain": ".txt",
        "text/markdown": ".md",
        "text/csv": ".csv",
        "text/html": ".html",
        "text/xml": ".xml",
    }.get(ctype)
    if not ext and is_doc:
        # 文档类认不出 mime：从原始文件名借后缀（限定白名单，防可执行文件）
        suffix = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
        allowed = {".pdf", ".txt", ".md", ".json", ".csv", ".srt", ".docx", ".doc", ".rtf", ".xml", ".log"}
        ext = suffix if suffix in allowed else None
    if not ext:
        return Response(status_code=415)  # type: ignore[return-value]
    skills.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{_uuid.uuid4().hex[:12]}{ext}"
    (skills.ASSETS_DIR / fname).write_bytes(body)
    return {"url": f"/agent-service/assets/{fname}"}


@app.get("/camera-vocab")
def camera_vocab() -> dict:
    """摄影语汇库（导演台面板数据源）：机身档案 / 镜头语汇 / 布光语汇。"""
    return {
        "cameras": [
            {"id": name, "look": p["look"], "lenses": p["lenses"]}
            for name, p in camera.CAMERA_PROFILES.items()
        ],
        "lensHints": camera.LENS_HINTS,
        "lightHints": camera.LIGHT_HINTS,
    }


@app.get("/skills")
def list_skills() -> list:
    """结构化技能清单（聊天输入框 slash 菜单数据源）。"""
    return skills.list_skills_payload()


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
        pid,
        req.get("nodes", []),
        req.get("edges", []),
        req.get("viewport"),
        req.get("meta"),
        user,
    )
    return {"ok": ok} if ok else Response(status_code=404)


# ---------- 聊天会话（多会话；会话内消息整表覆盖写）----------


@app.get("/projects/{pid}/threads")
def api_list_threads(pid: str, user: auth.CurrentUser):
    return projects.list_threads(pid, user)


@app.post("/projects/{pid}/threads")
async def api_create_thread(
    pid: str, req: dict | None = None, user: auth.CurrentUser = None  # type: ignore[assignment]
):
    # body 可省（curl 空 POST 也要能建会话）
    return projects.create_thread(pid, str((req or {}).get("title", "")), user)


@app.patch("/projects/{pid}/threads/{tid}")
async def api_rename_thread(pid: str, tid: str, req: dict, user: auth.CurrentUser):
    ok = projects.rename_thread(pid, tid, str(req.get("title", "")), user)
    return {"ok": ok} if ok else Response(status_code=404)


@app.delete("/projects/{pid}/threads/{tid}")
def api_delete_thread(pid: str, tid: str, user: auth.CurrentUser):
    return {"ok": projects.delete_thread(pid, tid, user)}


@app.get("/projects/{pid}/threads/{tid}/messages")
def api_load_thread_messages(pid: str, tid: str, user: auth.CurrentUser):
    return projects.load_chat_messages(pid, tid, user)


@app.put("/projects/{pid}/threads/{tid}/messages")
async def api_save_thread_messages(pid: str, tid: str, req: dict, user: auth.CurrentUser):
    saved = projects.save_chat_messages(pid, tid, req.get("messages", []), user)
    return {"ok": True, "count": len(saved)}


# ---------- 素材库（生成历史自动入库；url 同项目内去重）----------


@app.get("/projects/{pid}/assets")
def api_list_assets(pid: str, user: auth.CurrentUser):
    return projects.list_assets(pid, user)


@app.post("/projects/{pid}/assets")
async def api_save_asset(pid: str, req: dict, user: auth.CurrentUser):
    return projects.save_asset(
        pid,
        str(req.get("kind", "")),
        str(req.get("title", "")),
        str(req.get("url", "")),
        str(req.get("source", "upload")),
        user,
    )


@app.delete("/projects/{pid}/assets/{aid}")
def api_delete_asset(pid: str, aid: str, user: auth.CurrentUser):
    return {"ok": projects.delete_asset(pid, aid, user)}


# ---------- 视频合成（compose 卡按钮直连；ffmpeg 拼接本地资产）----------


@app.post("/projects/{pid}/compose")
def api_compose(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    urls = req.get("urls")
    if not isinstance(urls, list) or len(urls) == 0 or len(urls) > compose.MAX_SOURCES:
        return Response(status_code=400)
    try:
        url = compose.compose_videos([str(u) for u in urls])
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    except Exception as exc:  # ffmpeg 失败等
        return Response(status_code=500, content=str(exc), media_type="text/plain")
    return {"url": url}


# ---------- 分镜表生成（shotlist 卡按钮直连 langflow；剧本→rows）----------


def _parse_shot_rows(text: str) -> list[dict]:
    """从 flow 输出文本中解析分镜 JSON 数组（容错：剥围栏、截取首尾括号）。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip()
        if t.startswith("json"):
            t = t[4:].lstrip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("输出里没有 JSON 数组")
    arr = json.loads(t[start : end + 1])
    rows = []
    for i, it in enumerate(arr):
        if not isinstance(it, dict):
            continue
        rows.append(
            {
                "rid": f"r{i + 1}",
                "shotSize": str(it.get("shotSize") or ""),
                "cameraMove": str(it.get("cameraMove") or ""),
                "duration": str(it.get("duration") or ""),
                "action": str(it.get("action") or ""),
                "lighting": str(it.get("lighting") or ""),
                "sound": str(it.get("sound") or ""),
                "dialogue": str(it.get("dialogue") or ""),
            }
        )
    return rows


@app.post("/storyboard/generate")
async def api_storyboard_generate(req: dict, user: auth.CurrentUser):
    script = str(req.get("script") or "").strip()
    if not script:
        return Response(status_code=400, content="剧本内容为空", media_type="text/plain")
    flow_id = os.environ.get("LANGFLOW_SHOTLIST_FLOW_ID", "")
    if not flow_id:
        return Response(
            status_code=503,
            content="未配置 LANGFLOW_SHOTLIST_FLOW_ID（flow 见 agent/flows/shotlist-generate.json）",
            media_type="text/plain",
        )
    parts = []
    if req.get("shotCount"):
        parts.append(f"镜头数：{int(req['shotCount'])}")
    if req.get("durationSeconds"):
        parts.append(f"单镜时长：{int(req['durationSeconds'])} 秒")
    if str(req.get("visualStyle") or "").strip():
        parts.append(f"全局视觉风格：{str(req['visualStyle']).strip()}")
    parts.append("剧本：")
    parts.append(script)
    text = await skills.run_flow_blocking(flow_id, input_value="\n".join(parts))
    try:
        rows = _parse_shot_rows(text)
    except (ValueError, json.JSONDecodeError) as exc:
        return Response(
            status_code=502,
            content=f"分镜解析失败（{exc}）：{text[:200]}",
            media_type="text/plain",
        )
    if not rows:
        return Response(status_code=502, content="分镜解析为空", media_type="text/plain")
    return {"rows": rows}


@app.post("/storyboard/images")
async def api_storyboard_images(req: dict, user: auth.CurrentUser):
    """分镜行批量出图：启动异步任务立即返回 jobId（Next 代理 30s 会掐断
    长请求，无法阻塞等完）。前端轮询 GET /storyboard/images/{jobId}。

    req: {shots: [{rid, name, description, visual_notes?}]}
    """
    shots = req.get("shots") or []
    if not isinstance(shots, list) or not shots:
        return Response(status_code=400, content="shots 为空", media_type="text/plain")
    shots = shots[:24]  # 上限保护：一次批量最多 24 镜
    try:
        job_id = await skills.start_storyboard_image_job(shots)
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc), media_type="text/plain")
    return {"jobId": job_id}


@app.get("/storyboard/images/{job_id}")
async def api_storyboard_images_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_storyboard_image_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "images": list(job["images"].values())}


@app.post("/assets/decompose")
async def api_assets_decompose(req: dict, user: auth.CurrentUser):
    """剧本/分镜稿 → 结构化资产清单（直连拆解 flow，不经聊天 LLM）。

    req: {script: str}
    返回 {assets: [{type: character|scene|prop, name, description, visual_notes}]}
    """
    script = str(req.get("script") or "").strip()
    if not script:
        return Response(status_code=400, content="script 为空", media_type="text/plain")
    existing = req.get("existing") if isinstance(req.get("existing"), list) else None
    try:
        assets, errors = await skills.decompose_script_assets(script, existing=existing)
    except RuntimeError as exc:
        return Response(status_code=502, content=str(exc)[:300], media_type="text/plain")
    if not assets:
        detail = "；".join(f"{t}: {e}" for t, e in errors.items()) or "剧本里没有拆出任何资产"
        return Response(status_code=502, content=detail[:300], media_type="text/plain")
    return {"assets": assets, "errors": errors}


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
