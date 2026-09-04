"""Wingsight 画布助手服务入口：FastAPI + AG-UI（LangGraph 适配）。

运行：cd agent && uv run uvicorn main:app --port 8123

认证（移植自 juben）：默认 AUTH_ENABLED=false 全链路匿名 admin（单人零登录）；
开启后项目/画布按归属隔离，登录与用户管理走 /api/v1/auth/*。
已知边界：AG-UI 根端点（"/"）与 /assets 静态文件未鉴权（资源名为随机 hex，
等价 capability URL）；后续可给 CopilotKit HttpAgent 加 headers 收紧。
"""

import json
import asyncio
import os
import re
from contextlib import asynccontextmanager
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

from starlette.concurrency import run_in_threadpool

import auth  # noqa: E402  (在 dotenv 之后导入，读取最终环境变量)
import auth_routes  # noqa: E402
import camera  # noqa: E402
import compose  # noqa: E402
import dmx_routes  # noqa: E402
import events  # noqa: E402
import usage_routes  # noqa: E402
import entities  # noqa: E402
import entity_routes  # noqa: E402
import graph  # noqa: E402
import imgresearch  # noqa: E402
import models  # noqa: E402
import projects  # noqa: E402
import prompt_presets  # noqa: E402
import ref_routes  # noqa: E402
import research  # noqa: E402
import research_routes  # noqa: E402
import script_review  # noqa: E402
import script_review_routes  # noqa: E402
import serper_routes  # noqa: E402
import skills  # noqa: E402
import style_presets  # noqa: E402
import style_routes  # noqa: E402
import thumbs  # noqa: E402
import topic_routes  # noqa: E402
import topic_pool  # noqa: E402  (选题池编排：调度循环从这里取)
import topics  # noqa: E402

projects.init_db()
topics.init_topics_db()
entities.init_entities_db()
style_presets.init_style_presets_db()
prompt_presets.init_prompt_presets_db()
imgresearch.init_ref_research_db()
imgresearch.init_serper_pool_db()
research.init_research_db()
script_review.init_review_db()
auth.init_auth_db()
auth.ensure_auth_password()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # 上轮刷新若被服务重启杀掉，把中断如实落进 last_run（前端"上次刷新中断"）；
    # 生料层可断点续跑（语料缓存+已喂指纹已落账）→ 自动续跑，重启节奏不丢进度
    if topic_pool.SERVICE.report_interrupted_run():
        topic_pool.SERVICE.start()
    # 深度调研同理：running/planning 孤儿标记 interrupted，证据保留可补研续跑
    research.report_interrupted_jobs()
    # 剧本审查：queued/running 孤儿标记 interrupted
    script_review.report_interrupted_jobs()
    # 选题池每日定时刷新（进程内 asyncio 轮询；关停随事件循环取消）
    scheduler = asyncio.create_task(topic_pool.auto_refresh_loop())
    try:
        yield
    finally:
        scheduler.cancel()


app = FastAPI(title="wingsight-agent", lifespan=_lifespan)

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
# 选题池（生产前漏斗，跨项目全局）
app.include_router(topic_routes.router, prefix="/api/v1")
# 实体库（跨选题知识节点，实体图谱地基）
app.include_router(entity_routes.router, prefix="/api/v1")
# 我的画风（用户自建画风预设 + 参考图反推）
app.include_router(style_routes.router, prefix="/api/v1")
# 我的提示词（用户级提示词库 CRUD）
app.include_router(prompt_presets.router, prefix="/api/v1")
# Serper 号池管理（调研搜索唯一渠道的 key 池，admin）
app.include_router(serper_routes.router, prefix="/api/v1")
# 资产参考图调研（项目域资源挂根路径）
app.include_router(ref_routes.router)
# 深度调研（项目域资源挂根路径）
app.include_router(research_routes.router)
# 剧本审查（项目域资源挂根路径）
app.include_router(script_review_routes.router)
# DMX 余额（顶栏实时显示，admin）
app.include_router(dmx_routes.router, prefix="/api/v1")
# 出图用量（按用户张数/模型分布，admin）
app.include_router(usage_routes.router, prefix="/api/v1")
# 按钮/操作埋点（数据分析）
app.include_router(events.router, prefix="/api/v1")


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


# 文件名是随机 hex、内容不可变 → 浏览器长缓存，二次进画布不再重下
_CACHE_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


@app.get("/assets/{filename}")
def serve_asset(filename: str) -> FileResponse:
    """出图结果的静态暴露（前端经 /agent-service/assets/... 同源访问）。"""
    # 只允许纯文件名，杜绝路径穿越
    safe = Path(filename).name
    path = skills.ASSETS_DIR / safe
    if not path.is_file():
        return Response(status_code=404)  # type: ignore[return-value]
    return FileResponse(path, headers=_CACHE_IMMUTABLE)


@app.get("/thumbs/{filename}")
def serve_thumb(filename: str) -> FileResponse:
    """图片缩略图（小尺寸展示用）；缺失时从同名原图现场生成，历史资产自愈。"""
    path = thumbs.ensure(filename)
    if path is None:
        return Response(status_code=404)  # type: ignore[return-value]
    return FileResponse(path, headers=_CACHE_IMMUTABLE)


@app.post("/assets")
async def upload_asset(request: Request, user: auth.CurrentUser, name: str = "") -> dict:
    """粘贴/拖拽/附件上传：body 为二进制；返回同源可访问 URL。

    图片 ≤50MB（4K PNG 常见 10-25MB，15MB 曾把正常工作图全挡下）、
    视频 ≤200MB、文档（pdf/txt/md/json/csv/srt/docx…）≤20MB。
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
    limit = 200 * 1024 * 1024 if is_video else 50 * 1024 * 1024 if is_image else 20 * 1024 * 1024
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
    if is_image:
        await run_in_threadpool(thumbs.make_for, fname)
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


@app.get("/capabilities")
def api_capabilities(user: auth.CurrentUser):
    """技能清单（聊天「技能」面板数据源，Claude Code 同构：技能 = SKILL.md
    操作手册，助手执行对应任务时自动采用）。Langflow 生成管线是工具不是
    技能，不进此列表（入口 = 输入条打 /，数据源 /skills）。
    can_edit：admin 才能编辑/新建技能。"""
    skills_list = []
    for m in graph.load_skill_meta():
        try:
            body = (graph.SKILLS_DIR / m["name"] / "SKILL.md").read_text(
                encoding="utf-8"
            )
        except OSError:
            body = ""
        skills_list.append(
            {"name": m["name"], "description": m["description"], "body": body}
        )
    return {
        "skills": skills_list,
        "can_edit": getattr(user, "role", "") == "admin",
    }


def _skill_body_ok(name: str, body: str) -> str | None:
    """校验 SKILL.md 正文：frontmatter 必须有 name+description 且 name 与
    目录一致（spec 要求，read_skill 按名寻径）。返回错误原因或 None。"""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", body, re.S)
    if not m:
        return "缺少 frontmatter（--- 开头的 name/description 块）"
    fields = dict(re.findall(r"^(\w+):\s*(.+?)\s*$", m.group(1), re.M))
    if not fields.get("name") or not fields.get("description"):
        return "frontmatter 缺少 name 或 description"
    if fields["name"] != name:
        return f"frontmatter name（{fields['name']}）必须与目录名（{name}）一致"
    return None


@app.put("/capabilities/skills/{name}")
async def api_update_skill(name: str, req: dict, user: auth.CurrentUser):
    """管理员直接编辑一份手册技能（raw SKILL.md 全文）。保存后热刷新目录，
    免重启 agent。"""
    if getattr(user, "role", "") != "admin":
        return Response(status_code=403, content="仅管理员可编辑技能")
    body = str(req.get("body") or "")
    d = graph.SKILLS_DIR / name.strip()
    if not d.is_dir() or not d.resolve().is_relative_to(graph.SKILLS_DIR.resolve()):
        return Response(status_code=404, content=f"手册 {name} 不存在")
    if err := _skill_body_ok(name, body):
        return Response(status_code=400, content=err, media_type="text/plain")
    (d / "SKILL.md").write_text(body, encoding="utf-8")
    graph.refresh_skill_meta()
    return {"ok": True}


@app.post("/capabilities/skills")
async def api_create_skill(req: dict, user: auth.CurrentUser):
    """管理员新建一份手册技能（自动生成 frontmatter）。name 需是小写
    字母/数字/连字符（Agent Skills 规范）。"""
    if getattr(user, "role", "") != "admin":
        return Response(status_code=403, content="仅管理员可新建技能")
    name = str(req.get("name") or "").strip()
    description = str(req.get("description") or "").strip()
    body = str(req.get("body") or "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,63}", name):
        return Response(
            status_code=400,
            content="name 需为小写字母/数字/连字符，2-64 字符（如 historical-research）",
            media_type="text/plain",
        )
    if not description:
        return Response(status_code=400, content="description 不能为空", media_type="text/plain")
    d = graph.SKILLS_DIR / name
    if d.exists():
        return Response(status_code=409, content=f"技能 {name} 已存在", media_type="text/plain")
    d.mkdir(parents=True)
    content = f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"
    (d / "SKILL.md").write_text(content, encoding="utf-8")
    graph.refresh_skill_meta()
    return {"ok": True, "name": name}


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
    """乐观锁保存：带 revision 时与当前不一致返回 409（前端提示冲突）；
    force=true 跳过检查（用户显式选择覆盖）。

    保存前按 id 去重 nodes/edges：多会话并发时快照交错会产生重复条目，
    重复 id 会让前端 React key 冲突、渲染塌掉。"""
    def _dedupe(items: list) -> list:
        seen: set = set()
        out = []
        for item in items:
            iid = item.get("id") if isinstance(item, dict) else None
            if iid is None or iid in seen:
                continue
            seen.add(iid)
            out.append(item)
        return out

    nodes = _dedupe(req.get("nodes", []))
    node_ids = {n.get("id") for n in nodes}
    edges = _dedupe(req.get("edges", []))
    edges = [e for e in edges if e.get("source") in node_ids and e.get("target") in node_ids]
    result = projects.save_canvas(
        pid,
        nodes,
        edges,
        req.get("viewport"),
        req.get("meta"),
        user,
        expected_revision=req.get("revision"),
        force=bool(req.get("force")),
    )
    if result is None:
        return Response(status_code=404)
    ok, rev = result
    if not ok:
        return Response(
            status_code=409,
            content=json.dumps({"error": "revision_conflict", "revision": rev}),
            media_type="application/json",
        )
    return {"ok": True, "revision": rev}


# ---------- 聊天会话（多会话；会话内消息整表覆盖写）----------


@app.get("/projects/{pid}/threads")
def api_list_threads(pid: str, user: auth.CurrentUser):
    return projects.list_threads(pid, user)


@app.post("/projects/{pid}/threads")
async def api_create_thread(
    pid: str, req: dict | None = None, user: auth.CurrentUser = None  # type: ignore[assignment]
):
    # body 可省（curl 空 POST 也要能建会话）；id 由客户端指定时与 agent 侧
    # langgraph thread 同 id（UI 会话 ↔ 模型记忆一一对应的前提）
    return projects.create_thread(
        pid, str((req or {}).get("title", "")), user, str((req or {}).get("id", ""))
    )


@app.patch("/projects/{pid}/threads/{tid}")
async def api_rename_thread(pid: str, tid: str, req: dict, user: auth.CurrentUser):
    ok = projects.rename_thread(pid, tid, str(req.get("title", "")), user)
    return {"ok": ok} if ok else Response(status_code=404)


@app.delete("/projects/{pid}/threads/{tid}")
async def api_delete_thread(pid: str, tid: str, user: auth.CurrentUser):
    ok = projects.delete_thread(pid, tid, user)
    if ok:
        # 会话删了，agent 侧 checkpoint 一并清（历史遗留值清除而非静默叠加）
        try:
            await graph.checkpointer.adelete_thread(tid)
        except Exception as e:  # noqa: BLE001
            print(f"[checkpoint 清理失败] tid={tid} {type(e).__name__}: {e}", flush=True)
    return {"ok": ok}


@app.post("/chat/cancel")
async def api_chat_cancel(req: dict, user: auth.CurrentUser):
    """取消会话在途的后端工具（出图/拆解/技能调用）——「停止」「切会话」透传；
    带 jobId 时只取消该任务（任务面板的逐任务取消）。"""
    n = skills.cancel_chat_runs(
        str(req.get("threadId") or ""), str(req.get("jobId") or "")
    )
    return {"ok": True, "cancelled": n}


@app.get("/chat/jobs")
def api_chat_jobs(user: auth.CurrentUser, threadId: str = ""):
    """会话在途长任务清单（任务面板数据源：kind/title/done/total）。"""
    return skills.list_chat_jobs(threadId)


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


@app.post("/storyboard/generate")
async def api_storyboard_generate(req: dict, user: auth.CurrentUser):
    """分镜表生成：启动异步任务立即返回 jobId（代理 30s 限制，前端轮询）。"""
    script = str(req.get("script") or "").strip()
    if not script:
        return Response(status_code=400, content="剧本内容为空", media_type="text/plain")
    try:
        # 未选模型 → 目录默认（DEFAULT_TEXT_MODEL_ID），不再回落 flow 出厂 glm
        text_model = models.resolve_text_model(req.get("model")) or models.DEFAULT_TEXT_MODEL_ID
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        job_id = await skills.start_storyboard_gen_job(
            script,
            shot_count=req.get("shotCount"),
            duration_seconds=req.get("durationSeconds"),
            visual_style=str(req.get("visualStyle") or ""),
            assets=req.get("assets") if isinstance(req.get("assets"), list) else None,
            model=text_model or "",
        )
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc), media_type="text/plain")
    return {"jobId": job_id}


@app.get("/storyboard/generate/{job_id}")
async def api_storyboard_generate_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_storyboard_gen_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    if job["status"] == "done" and job.get("error"):
        return {"status": "done", "error": job["error"], "rows": None}
    return {"status": job["status"], "rows": job.get("rows")}


@app.post("/prompt/optimize")
async def api_prompt_optimize(req: dict, user: auth.CurrentUser):
    """提示词 AI 辅助（面板 ✦ 双态按钮）：mode 由前端显式路由，直连对应 flow
    不经聊天。异步任务（Next 代理 30s 掐断长请求），前端轮询 GET。

    req: {mode: "optimize"|"reversal", prompt?, imageUrls?, contextNotes?, model?}
    mode=optimize 优化扩写：prompt 必填（model 可覆盖文本模型）；
    mode=reversal 看图反推：imageUrls 必填。
    """
    mode = str(req.get("mode") or "").strip()
    prompt = str(req.get("prompt") or "").strip()
    image_urls = req.get("imageUrls") if isinstance(req.get("imageUrls"), list) else []
    context_notes = str(req.get("contextNotes") or "")
    if mode not in ("optimize", "reversal"):
        return Response(status_code=400, content="mode 必须是 optimize 或 reversal", media_type="text/plain")
    if mode == "optimize" and not prompt:
        return Response(status_code=400, content="优化扩写需要非空提示词", media_type="text/plain")
    if mode == "reversal" and not image_urls:
        return Response(status_code=400, content="看图反推需要至少一张参考图", media_type="text/plain")
    try:
        # 扩写态未选模型 → 目录默认；看图反推固定视觉模型，不吃文本默认
        text_model = models.resolve_text_model(req.get("model")) or (
            models.DEFAULT_TEXT_MODEL_ID if mode == "optimize" else None
        )
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        job_id = await skills.start_prompt_optimize_job(
            mode, prompt, image_urls, context_notes, model=text_model or ""
        )
    except RuntimeError as exc:
        return Response(status_code=502, content=str(exc)[:300], media_type="text/plain")
    return {"jobId": job_id}


@app.get("/prompt/optimize/{job_id}")
async def api_prompt_optimize_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_prompt_optimize_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "result": job.get("result"), "error": job.get("error")}


@app.post("/text/rewrite")
async def api_text_rewrite(req: dict, user: auth.CurrentUser):
    """文本撰写/改写（画布文本卡/剧本卡底部输入条直连管线，不经聊天 LLM）：
    卡片级模型在此生效（data.textModel → resolve，聊天主循环不走这里）。
    异步任务（Next 代理 30s 掐断长请求），前端轮询 GET。

    req: {instruction, body?, context?, model?}——instruction 必填；
    body 空=直接创作；context=引用卡/上游内容的前置拼装文本。
    """
    instruction = str(req.get("instruction") or "").strip()
    body = str(req.get("body") or "")
    context = str(req.get("context") or "")
    if not instruction:
        return Response(status_code=400, content="撰写/改写需要非空指令", media_type="text/plain")
    try:
        # 未选模型 → 目录默认（DEFAULT_TEXT_MODEL_ID），不再回落 flow 出厂 glm
        text_model = models.resolve_text_model(req.get("model")) or models.DEFAULT_TEXT_MODEL_ID
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        job_id = await skills.start_text_rewrite_job(
            instruction, body, context, model=text_model or ""
        )
    except RuntimeError as exc:
        return Response(status_code=502, content=str(exc)[:300], media_type="text/plain")
    return {"jobId": job_id}


@app.get("/text/rewrite/{job_id}")
async def api_text_rewrite_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_text_rewrite_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "result": job.get("result"), "error": job.get("error")}


@app.get("/models/image")
async def api_image_models(user: auth.CurrentUser):
    """图像模型目录（实探验证清单，见 agent/models.py）。前端出图设置渲染。"""
    return {"models": models.image_models_payload()}


@app.get("/models/text")
async def api_text_models(user: auth.CurrentUser):
    """文本模型目录（DMX 网关 chat 探针验证，见 agent/models.py）。
    剧本/分镜表/拆解等文本生成的模型选择渲染。"""
    return {"models": models.text_models_payload(), "default": models.DEFAULT_TEXT_MODEL_ID}


@app.post("/storyboard/images")
async def api_storyboard_images(req: dict, user: auth.CurrentUser):
    """分镜行批量出图：启动异步任务立即返回 jobId（Next 代理 30s 会掐断
    长请求，无法阻塞等完）。前端轮询 GET /storyboard/images/{jobId}。

    req: {shots: [{rid, name, description, visual_notes?, aspect?,
                   params?: {model?, resolution?, aspect?}}],
          params?: {model?, resolution?, aspect?}}
    镜头级 params/aspect 覆盖请求级（卡片级覆盖），逐镜头合并预校验。
    """
    shots = req.get("shots") or []
    if not isinstance(shots, list) or not shots:
        return Response(status_code=400, content="shots 为空", media_type="text/plain")
    if len(shots) > 200:
        return Response(
            status_code=400,
            content=f"一次批量最多 200 张（收到 {len(shots)} 张），请分批出图",
            media_type="text/plain",
        )
    try:
        params = models.resolve_imagegen_params(req.get("params"))
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    # 请求级画幅（卡片 data.gen.aspect 经 startShotImageJob params）落到
    # 无显式画幅的镜头上，随镜头级画幅一起进任务预检（不合法 400 点名，
    # 绝不静默丢弃让用户以为画幅生效了）
    raw_params = req.get("params")
    req_aspect = (
        str((raw_params or {}).get("aspect") or "").strip()
        if isinstance(raw_params, dict)
        else ""
    )
    if req_aspect:
        for s in shots:
            if isinstance(s, dict) and not str(s.get("aspect") or "").strip():
                s["aspect"] = req_aspect
    try:
        job_id = await skills.start_storyboard_image_job(shots, params=params)
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc), media_type="text/plain")
    except ValueError as exc:
        # 逐镜头参数合并预校验失败（模型/档位组合不合法），整批明报
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    return {"jobId": job_id}


@app.get("/storyboard/images/{job_id}")
async def api_storyboard_images_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_storyboard_image_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "images": list(job["images"].values())}


@app.delete("/storyboard/images/{job_id}")
async def api_storyboard_images_cancel(job_id: str, user: auth.CurrentUser):
    """取消出图任务：未开跑的镜头跳过，在途的中止底层 http 请求（不再计费）。"""
    if not skills.cancel_storyboard_image_job(job_id):
        return Response(status_code=409, content="任务不存在或已结束", media_type="text/plain")
    return {"ok": True}

@app.post("/assets/decompose")
async def api_assets_decompose(req: dict, user: auth.CurrentUser):
    """剧本/分镜稿 → 结构化资产清单（异步任务：Next 代理 30s 掐断长请求，
    三路拆解 flow 并发跑不完 30s）。立即返回 jobId，前端轮询
    GET /assets/decompose/{jobId}。不经聊天 LLM。

    req: {script: str, existing?: [{type, name}], auto_looks?: bool,
          visual_style?: str}
    auto_looks=True：拆解后自动跑角色出图链（定妆照 → 逐 Look），
    整链可能数分钟，前端按 phase/progress 显示进度。
    """
    script = str(req.get("script") or "").strip()
    if not script:
        return Response(status_code=400, content="script 为空", media_type="text/plain")
    existing = req.get("existing") if isinstance(req.get("existing"), list) else None
    auto_looks = bool(req.get("auto_looks"))
    visual_style = str(req.get("visual_style") or "")
    try:
        params = models.resolve_imagegen_params(req.get("params"))
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        # 未选模型 → 目录默认（DEFAULT_TEXT_MODEL_ID），不再回落 flow 出厂 glm
        text_model = models.resolve_text_model(req.get("text_model")) or models.DEFAULT_TEXT_MODEL_ID
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        job_id = await skills.start_decompose_job(
            script,
            existing=existing,
            auto_looks=auto_looks,
            visual_style=visual_style,
            params=params,
            text_model=text_model or "",
        )
    except RuntimeError as exc:
        return Response(status_code=502, content=str(exc)[:300], media_type="text/plain")
    return {"jobId": job_id}


@app.get("/assets/decompose/{job_id}")
async def api_assets_decompose_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_decompose_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    if job["status"] == "done" and job.get("error"):
        return {"status": "done", "phase": "done", "error": job["error"], "assets": None}
    return {
        "status": job["status"],
        "phase": job.get("phase"),
        "progress": job.get("progress"),
        "images_note": job.get("images_note"),
        "assets": job.get("assets"),
        "errors": job.get("errors"),
    }


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
