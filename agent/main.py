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
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint

# 配置优先级：agent/.env > 项目根 .env.local > 进程环境
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")
load_dotenv(_HERE.parent / ".env.local")

# WS_DEBUG_HTTP=1：打开模型 HTTP 出站日志（诊断 provider 契约类 400 用——
# 「我们究竟发了什么」只有出站请求体能回答；默认关）
if os.environ.get("WS_DEBUG_HTTP"):
    import logging

    logging.basicConfig(level=logging.DEBUG)
    for _n in ("httpx", "httpcore", "openai", "langchain_openai"):
        logging.getLogger(_n).setLevel(logging.DEBUG)


from starlette.concurrency import run_in_threadpool

import auth  # noqa: E402  (在 dotenv 之后导入，读取最终环境变量)
import auth_routes  # noqa: E402
import camera  # noqa: E402
import compose  # noqa: E402
import dmx_routes  # noqa: E402
import doc_extract  # noqa: E402
import eventbus  # noqa: E402
import events  # noqa: E402
import free_images  # noqa: E402
import usage_routes  # noqa: E402
import entities  # noqa: E402
import entity_routes  # noqa: E402
import graph  # noqa: E402
import imgresearch  # noqa: E402
import imagejobs  # noqa: E402
import jobstore  # noqa: E402
import models  # noqa: E402
from typing import Any, Dict, List  # noqa: E402

import projects  # noqa: E402
import prompt_presets  # noqa: E402
import ref_routes  # noqa: E402
import research  # noqa: E402
import research_routes  # noqa: E402
import image_review  # noqa: E402
import image_review_routes  # noqa: E402
import tabular_import  # noqa: E402
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
image_review.init_review_db()
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
    # 艺术评审同理
    image_review.report_interrupted_jobs()
    # 出图/出视频批量任务（item 表）与拆解/分镜生成（jobstore）的 running
    # 孤儿批量终态化：进程都换了不可能还在跑，完成项保留、在途项标中断，
    # 不留僵尸 running 行装活（萧燕燕事故的启动侧补刀）
    try:
        imagejobs.finalize_running_orphans()
        jobstore.sweep_orphans()
    except Exception as exc:  # noqa: BLE001
        print(f"[startup] 任务孤儿清扫失败（不阻塞启动）: {exc}", flush=True)
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
app.include_router(image_review_routes.router)
# DMX 余额（顶栏实时显示，admin）
app.include_router(dmx_routes.router, prefix="/api/v1")
# 出图用量（按用户张数/模型分布，admin）
app.include_router(usage_routes.router, prefix="/api/v1")
# 按钮/操作埋点（数据分析）
app.include_router(events.router, prefix="/api/v1")


@app.get("/api/v1/events/stream")
async def api_events_stream(user: auth.CurrentUser):
    """后台任务事件流（SSE 常开通道）：调研/批量出图/拆解/审查的终态实时推送。

    AG-UI 轮次流之外唯一的推送通道（断线自动重连在客户端）；事件不重放，
    错过的终态由既有卡面状态轮询兜回。契约见 agent/eventbus.py 与
    lib/agent-events.ts。
    """
    return eventbus.sse_response()


agent = LangGraphAgent(
    name="default",
    graph=graph.graph,
    description="Wingsight 画布助手",
    # 单轮步数上限：LangGraph 默认 25 步（一次 chat_node + tool_node = 2 步），
    # 搜索型任务（「列一批选题」逐条核）会正当超限——2026-09-10 号池补 key 后
    # 实测 R6 场景在第 25 步抛 GraphRecursionError，整条请求崩掉、用户零产出
    # （不是「少答几句」）。抬到 80 并配宪法步数预算纪律（逐条搜=预算杀手，
    # 宽搜再交付）；env AGENT_RECURSION_LIMIT 可调。
    config={"recursion_limit": max(int(os.environ.get("AGENT_RECURSION_LIMIT", "80")), 25)},
)

add_langgraph_fastapi_endpoint(app, agent, path="/")


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "model": os.environ.get("AGENT_MODEL", "deepseek-flash"),
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


@app.get("/previews/{filename}")
def serve_preview(filename: str) -> FileResponse:
    """放大展示的中间档（1600 长边 webp）；缺失时现场生成。

    高缩放（hires）此前直接拉 2K/4K 原图（3~7MB/张），是画布载重最大单项；
    需要原始分辨率的场景（灯箱/下载/裁剪）仍走 /assets 原图。
    """
    path = thumbs.ensure_preview(filename)
    if path is None:
        return Response(status_code=404)  # type: ignore[return-value]
    return FileResponse(path, headers=_CACHE_IMMUTABLE)


@app.post("/extract-text")
async def extract_text(request: Request, user: auth.CurrentUser, name: str = "") -> dict:
    """文档文本提取（聊天附件 doc/docx/rtf/pdf/xlsx/xls 用）：body 为二进制、
    ?name= 带原始文件名，返回 {text}。实现体在 `doc_extract`——表类（xlsx/xls）
    转 Markdown 表格，失败原样明报中文原因，不静默降级。"""
    _ = user
    body = await request.body()
    fname = (name or request.query_params.get("name") or "").strip()
    try:
        text = await doc_extract.extract_text(fname, body)
    except doc_extract.DocExtractError as exc:
        return Response(status_code=exc.status, content=exc.message, media_type="text/plain")
    return {"text": text}


@app.post("/assets")
async def upload_asset(request: Request, user: auth.CurrentUser, name: str = "") -> dict:
    """粘贴/拖拽/附件上传：body 为二进制；返回同源可访问 URL。

    图片 ≤50MB（4K PNG 常见 10-25MB，15MB 曾把正常工作图全挡下）、
    视频 ≤200MB、文档（pdf/txt/md/json/csv/srt/vtt/ass/docx…）≤20MB。
    图片除 png/jpg/webp/gif 外收 avif/bmp/tiff/svg；HEIC/HEIF（iPhone 实拍）
    落盘前转 JPEG——服务器 ffmpeg 无 libheif、Chrome 也解不了 HEIC。
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
        "image/avif": ".avif",
        "image/bmp": ".bmp",
        "image/x-ms-bmp": ".bmp",
        "image/tiff": ".tiff",
        "image/svg+xml": ".svg",
        # HEIC/HEIF 落盘前转 JPEG（见下），这里只用来放行
        "image/heic": ".heic",
        "image/heif": ".heif",
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
        "text/vtt": ".vtt",
        "text/x-ssa": ".ssa",
        "text/x-ass": ".ass",
    }.get(ctype)
    if not ext and is_doc:
        # 文档类认不出 mime：从原始文件名借后缀（限定白名单，防可执行文件）
        suffix = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
        allowed = {
            ".pdf", ".txt", ".md", ".markdown", ".json", ".csv", ".srt", ".vtt", ".ass", ".ssa",
            ".docx", ".doc", ".rtf", ".xml", ".log",
        }
        ext = suffix if suffix in allowed else None
    if not ext:
        return Response(status_code=415)  # type: ignore[return-value]
    if ext in (".heic", ".heif"):
        try:
            body = await run_in_threadpool(thumbs.heic_to_jpeg, body)
        except Exception as exc:  # noqa: BLE001
            return Response(
                status_code=422,
                content=f"HEIC 转换失败：{type(exc).__name__}: {exc}",
                media_type="text/plain",
            )
        ext = ".jpg"
    skills.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{_uuid.uuid4().hex[:12]}{ext}"
    (skills.ASSETS_DIR / fname).write_bytes(body)
    if is_image:
        await run_in_threadpool(thumbs.make_for, fname)
    return {"url": f"/agent-service/assets/{fname}"}


@app.get("/camera-vocab")
def camera_vocab() -> dict:
    """摄影语汇库（导演台/机位/打光面板数据源）：机身档案 / 镜头语汇 /
    布光预设（结构化，2026-09-04 起打光弹窗与导演台布光区同源消费）。"""
    return {
        "cameras": [
            {"id": name, "look": p["look"], "lenses": p["lenses"]}
            for name, p in camera.CAMERA_PROFILES.items()
        ],
        "lensHints": camera.LENS_HINTS,
        "lightHints": camera.LIGHT_HINTS,
        "lightPresets": camera.LIGHT_PRESETS,
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


@app.post("/chat/regenerate")
async def api_chat_regenerate(req: dict, user: auth.CurrentUser):
    """重新生成：把指定消息之前的 checkpoint 分叉成会话当前头。

    前端「重新生成」= 本端点 fork + 截断本地历史 + 正常发起一轮 run。为什么
    必须 fork（2026-09-09 实测）：客户端单纯截断历史重跑时，ag_ui_langgraph 的
    is_continuation 判定把「子集消息」当成续跑（补全工具调用场景），不触发它的
    time-travel 分叉——旧回答仍留在 checkpoint 里，模型下一轮能逐字复述出被
    「删掉」的答案。fork 后旧回答从模型上下文真正消失，与界面所见一致。

    **分支落库（2026-09-11 行业共识「旧版本可 ‹ i/N › 切回」）**：fork 之前先把
    「被放弃的这一版」存档——助手消息（前端传 turnMessages，缺省读库里该轮消息）
    + 它作为会话头时的 checkpoint id。切回旧版时用那个 checkpoint 复原模型上下文
    （Claude/ChatGPT 的分支切换是显示与上下文一起切，不是只改显示）。
    """
    thread_id = str(req.get("threadId") or "")
    message_id = str(req.get("messageId") or "")
    if not thread_id or not message_id:
        raise HTTPException(status_code=400, detail="threadId 与 messageId 必填")
    config = {"configurable": {"thread_id": thread_id}}
    try:
        ckpt = await agent.get_checkpoint_before_message(message_id, thread_id, config)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=f"找不到该消息的检查点：{e}") from e
    if ckpt is None:
        raise HTTPException(status_code=404, detail="找不到该消息的检查点")
    # 存档要在 fork 之前做：要的是「当前头」的状态，不是 fork 点的
    try:
        await _archive_current_branch(thread_id, message_id, req.get("turnMessages"))
    except Exception as e:  # noqa: BLE001
        # 存档失败不该拦住重新生成（用户的主诉是重跑这一轮）；落日志供排查
        print(f"[分支] 存档失败（不阻止重新生成）：{e}", flush=True)
    next_nodes = getattr(ckpt, "next", None) or ()
    await agent.graph.aupdate_state(
        ckpt.config,
        ckpt.values,
        as_node=next_nodes[0] if next_nodes else "__start__",
    )
    return {"ok": True}


async def _archive_current_branch(
    thread_id: str, turn_id: str, turn_messages: Any = None
) -> None:
    """把「当前生效的这一版」存档为该轮的下一个版本（切回时的退路）。

    - 助手消息：优先用前端传来的 `turnMessages`（它手上是实时的）；缺省读库里该轮
      消息（chat_messages 由 ChatPersistence 持续落库）。两者都没有就不存档——
      没有内容可切回。
    - checkpoint：当前头的 checkpoint id。切回该版本时用 aget_state + aupdate_state
      把会话头挪回那一版（与框架 prepare_regenerate_stream 同手法）。
    """
    state = await agent.graph.aget_state({"configurable": {"thread_id": thread_id}})
    try:
        ckpt_id = str(state.config["configurable"].get("checkpoint_id") or "")
    except (KeyError, TypeError, AttributeError):
        ckpt_id = ""
    if not ckpt_id:
        raise RuntimeError("拿不到当前头的 checkpoint id")
    msgs: List[Dict[str, Any]] = []
    if isinstance(turn_messages, list):
        for m in turn_messages:
            if isinstance(m, dict) and str(m.get("role") or "") == "assistant":
                msgs.append(
                    {
                        "id": str(m.get("id") or ""),
                        "role": "assistant",
                        "content": str(m.get("content") or ""),
                    }
                )
    if not msgs:
        pid = projects.project_id_of_thread(thread_id)
        if pid:
            msgs = projects.turn_messages_after(
                projects.load_chat_messages(pid, thread_id), turn_id
            )
    if not msgs:
        return
    live = projects.get_active_branch(thread_id, turn_id)
    if live is not None:
        # 当前头是一条已存档的行（= 切回来的那一版）→ 就地更新它的内容与检查点，
        # 保留它的 idx：位置稳定（切回第 1 版仍显示第 1 版）
        projects.save_branch(
            thread_id, turn_id, live["idx"], msgs, ckpt_id, active=0
        )
    else:
        projects.save_branch(
            thread_id, turn_id, projects.next_branch_idx(thread_id, turn_id), msgs, ckpt_id
        )
    projects.clear_branch_active(thread_id, turn_id)


@app.get("/chat/branches")
def api_chat_branches(threadId: str, user: auth.CurrentUser):
    """该会话各轮的版本清单（前端 ‹ i/N › 的数据源）。

    被放弃的版本取自 chat_branches；**当前生效的那一版不落库**——它就是会话的实时
    头，这里从 chat_messages 现算（前端一直在落库），编号接在存档版本之后。
    只返回有 ≥2 版的轮（单版轮不需要切换器）。
    """
    tid = str(threadId or "")
    if not tid:
        raise HTTPException(status_code=400, detail="threadId 必填")
    pid = projects.project_id_of_thread(tid)
    if not pid:
        raise HTTPException(status_code=404, detail="会话不存在")
    stored = projects.load_chat_messages(pid, tid, user)
    turns: Dict[str, Dict[str, Any]] = {}
    for b in projects.list_branches(tid):
        t = turns.setdefault(b["turn_id"], {"turnId": b["turn_id"], "versions": []})
        t["versions"].append(
            {"idx": b["idx"], "active": b["active"], "messages": b["messages"]}
        )
    # 没有 active 行 = 当前版本是刚生成的那一版（还没被放弃过）→ 从 chat_messages
    # 现算，编号接在末尾。已被切回的版本有自己的行（active=1），不在此追加
    for m in stored:
        if str(m.get("role") or "") != "user":
            continue
        turn_id = str(m.get("id") or "")
        t = turns.get(turn_id)
        if t is not None and any(v["active"] for v in t["versions"]):
            continue
        live = projects.turn_messages_after(stored, turn_id)
        if not live:
            continue
        t = turns.setdefault(turn_id, {"turnId": turn_id, "versions": []})
        t["versions"].append(
            {
                "idx": max([v["idx"] for v in t["versions"]] or [0]) + 1,
                "active": True,
                "messages": live,
            }
        )
    out = [t for t in turns.values() if len(t["versions"]) > 1]
    for t in out:
        t["versions"].sort(key=lambda v: v["idx"])
    return {"turns": out}


@app.post("/chat/branch")
async def api_chat_branch(req: dict, user: auth.CurrentUser):
    """切到某个历史版本：显示与模型上下文一起切（行业共识）。

    ① 先把「当前生效版本」按与 regenerate 相同的手法存档，保证还能切回来；
    ② 用目标版本的 checkpoint 把会话头挪过去（aget_state → aupdate_state）；
    ③ 返回该版本的助手消息：前端直接上屏，不重跑、不烧额度。
    """
    thread_id = str(req.get("threadId") or "")
    turn_id = str(req.get("turnId") or "")
    try:
        idx = int(req.get("idx"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="idx 必须是整数") from None
    if not thread_id or not turn_id:
        raise HTTPException(status_code=400, detail="threadId 与 turnId 必填")
    rec = projects.get_branch(thread_id, turn_id, idx)
    if rec is None:
        raise HTTPException(status_code=404, detail="该版本不存在（可能已被新版本取代）")
    if not projects.project_id_of_thread(thread_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    try:
        await _archive_current_branch(thread_id, turn_id, req.get("turnMessages"))
    except Exception as e:  # noqa: BLE001
        print(f"[分支] 切换前存档失败（不阻止切换）：{e}", flush=True)
    ckpt_id = rec.get("checkpoint_id") or ""
    if not ckpt_id:
        raise HTTPException(status_code=409, detail="该版本没有可复原的检查点")
    try:
        state = await agent.graph.aget_state(
            {"configurable": {"thread_id": thread_id, "checkpoint_id": ckpt_id}}
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=f"找不到该版本的检查点：{e}") from e
    next_nodes = getattr(state, "next", None) or ()
    # config 显式构造，**必须带 checkpoint_ns**：aget_state 回来的 config 不带它，
    # 而 aupdate_state 内部写 writes 时我们的 checkpointer 直接索引该键
    # （实测 KeyError: 'checkpoint_ns'，500）。缺省命名空间是空串。
    ns = ""
    try:
        ns = str((state.config or {}).get("configurable", {}).get("checkpoint_ns") or "")
    except (AttributeError, TypeError):
        ns = ""
    await agent.graph.aupdate_state(
        {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": ns,
                "checkpoint_id": ckpt_id,
            }
        },
        state.values,
        as_node=next_nodes[0] if next_nodes else "__start__",
    )
    # 目标版本已成为会话当前头：标 active 并**保留它的 idx**（位置稳定，
    # 切回第 1 版就显示 1/2，而不是被排到末尾）
    projects.set_branch_active(thread_id, turn_id, idx, True)
    return {"ok": True, "messages": rec["messages"]}


@app.get("/projects/{pid}/threads/{tid}/messages")
def api_load_thread_messages(pid: str, tid: str, user: auth.CurrentUser):
    return projects.load_chat_messages(pid, tid, user)


# 智能命名在途集合：防抖保存高频到达，同会话只跑一个命名任务
_TITLE_INFLIGHT: set[str] = set()


async def _smart_title_task(pid: str, tid: str, user: auth.CurrentUser) -> None:
    """首组对话完成后给会话起 6-14 字标题（graph.generate_thread_title）。
    落库前重查：用户可能已手动命名（机械标题判定不过就放弃）。"""
    try:
        msgs = projects.load_chat_messages(pid, tid, user)
        first_user = next((m for m in msgs if m["role"] == "user"), None)
        first_ai = next((m for m in msgs if m["role"] == "assistant"), None)
        if not first_user or not first_ai:
            return
        current = next(
            (t.get("title") or "" for t in projects.list_threads(pid, user) if t.get("id") == tid),
            "",
        )
        if not projects.thread_title_is_mechanical(current, msgs):
            return  # 用户已命名或 LLM 已命名
        title = await graph.generate_thread_title(first_user["content"], first_ai["content"])
        if title:
            projects.rename_thread(pid, tid, title, user)
    except Exception:  # noqa: BLE001
        pass  # 命名失败保留过渡标题（首条消息截断），下次保存再试
    finally:
        _TITLE_INFLIGHT.discard(tid)


@app.put("/projects/{pid}/threads/{tid}/messages")
async def api_save_thread_messages(pid: str, tid: str, req: dict, user: auth.CurrentUser):
    saved = projects.save_chat_messages(pid, tid, req.get("messages", []), user)
    # 首组对话齐了且标题仍是机器产物 → 后台智能命名（fire-and-forget）
    has_u = any(m["role"] == "user" for m in saved)
    has_a = any(m["role"] == "assistant" for m in saved)
    if (
        has_u
        and has_a
        and tid not in _TITLE_INFLIGHT
        and projects.thread_title_is_mechanical(
            next(
                (
                    t.get("title") or ""
                    for t in projects.list_threads(pid, user)
                    if t.get("id") == tid
                ),
                "",
            ),
            saved,
        )
    ):
        _TITLE_INFLIGHT.add(tid)
        asyncio.create_task(_smart_title_task(pid, tid, user))
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


@app.post("/import/tabular")
async def api_import_tabular(file: UploadFile, user: auth.CurrentUser):
    """分镜/提示词表格解析：xlsx/xls/ods/csv/txt → 统一行结构（前端列映射后批量建卡）。"""
    _ = user
    raw = await file.read()
    try:
        return tabular_import.parse_tabular(file.filename or "", raw)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")


@app.post("/video/extract-audio")
def api_extract_audio(req: dict, user: auth.CurrentUser):
    """视频提音轨（mp3）：视频卡工具条直连，产物落音频卡（配音/BGM 素材化）。"""
    url = str(req.get("videoUrl") or "").strip()
    if not url:
        return Response(status_code=400, content="videoUrl 为空", media_type="text/plain")
    try:
        audio_url = compose.extract_audio(url)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    except Exception as exc:  # ffmpeg 失败（无音轨/解码错）
        return Response(status_code=500, content=str(exc), media_type="text/plain")
    return {"audioUrl": audio_url}


@app.post("/video/trim")
def api_trim_video(req: dict, user: auth.CurrentUser):
    """截取视频片段（mp4 重编码精确剪）：视频卡「截取片段」直连，产物落新视频卡。"""
    url = str(req.get("videoUrl") or "").strip()
    start = req.get("start")
    end = req.get("end")
    if not url or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return Response(status_code=400, content="参数缺失（videoUrl/start/end）", media_type="text/plain")
    try:
        clip_url = compose.trim_video(url, float(start), float(end))
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    except Exception as exc:  # ffmpeg 失败
        return Response(status_code=500, content=str(exc), media_type="text/plain")
    return {"clipUrl": clip_url}


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
    return {
        "status": job["status"],
        "rows": job.get("rows"),
        "missingAssets": job.get("missingAssets"),
    }


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


@app.get("/models/video")
async def api_video_models(user: auth.CurrentUser):
    """视频模型目录（BigModel CogVideoX 系实探验证，见 agent/models.py）。"""
    return {"models": models.video_models_payload(), "default": models.DEFAULT_VIDEO_MODEL_ID}


@app.post("/storyboard/videos")
async def api_storyboard_videos(req: dict, user: auth.CurrentUser):
    """分镜行批量出视频：异步任务立即返回 jobId（同批量出图范式，Next 代理
    30s 掐长请求）。前端轮询 GET /storyboard/videos/{jobId}。

    req: {shots: [{rid, name, prompt(运动描述，必填), imageUrl?(首帧图),
                   params?: {model, size?, duration?, fps?, quality?, with_audio?}}],
          params?: {model, size?, ...}, project_id}
    params 请求级默认，镜头级覆盖；逐镜头合并预校验，非法组合 400 点名。
    i2v（带 imageUrl）不传 size 时上游按原图比例自适配。
    """
    shots = req.get("shots") or []
    if not isinstance(shots, list) or not shots:
        return Response(status_code=400, content="shots 为空", media_type="text/plain")
    if len(shots) > 60:
        return Response(
            status_code=400,
            content=f"一次批量最多 60 条视频（收到 {len(shots)} 条），请分批生成",
            media_type="text/plain",
        )
    try:
        params = models.resolve_video_params(req.get("params"))
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    try:
        job_id = await skills.start_storyboard_video_job(
            shots, params=params, project_id=str(req.get("project_id") or "")
        )
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc), media_type="text/plain")
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    return {"jobId": job_id}


@app.get("/storyboard/videos/{job_id}")
async def api_storyboard_videos_status(job_id: str, user: auth.CurrentUser):
    job = skills.get_storyboard_video_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "images": list(job["images"].values())}


@app.delete("/storyboard/videos/{job_id}")
async def api_storyboard_videos_cancel(job_id: str, user: auth.CurrentUser):
    """取消出视频任务：未开跑的镜头跳过，在途的中止底层请求（不再计费）。"""
    if not skills.cancel_storyboard_video_job(job_id):
        return Response(status_code=409, content="任务不存在或已结束", media_type="text/plain")
    return {"ok": True}


@app.post("/free-images")
async def api_free_image_generate(req: dict, user: auth.CurrentUser):
    """自由生图批次（juben ImageStudio 移植）：不受画风/资产约束，一次点击
    多模型并行，每模型一行任务。立即返回 {batchId, items}；前端轮询 GET。

    req: {project_id, prompt, aspect?, resolution?, quality?, models: [目录 id],
          reference_images?: [/agent-service/assets/... url]}
    校验失败 400 中文点名（模型/画幅/档位/质量档/参考上限），绝不静默换默认。
    """
    try:
        return await free_images.create_batch(
            str(req.get("project_id") or ""),
            str(req.get("prompt") or ""),
            str(req.get("aspect") or ""),
            str(req.get("resolution") or ""),
            str(req.get("quality") or ""),
            [str(m) for m in (req.get("models") or []) if str(m).strip()],
            [str(u) for u in (req.get("reference_images") or []) if str(u).strip()],
            user,
        )
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")


@app.get("/free-images")
def api_free_image_list(project_id: str, user: auth.CurrentUser):
    """画廊数据源（3 秒轮询）：项目内批次倒序，含在途/失败/完成全态。
    不带 finalPrompt（每行最多 3000 字，随轮询下发是纯流量浪费）。"""
    projects.assert_access(user, project_id)
    return {"items": free_images.list_free_images(project_id)}


@app.get("/free-images/{item_id}")
def api_free_image_item(item_id: str, user: auth.CurrentUser):
    """单条详情（含 finalPrompt「实际发送的提示词」）：Lightbox 打开时按条拉。"""
    item = free_images.get_item(item_id)
    if item is None:
        return Response(status_code=404)
    projects.assert_access(user, str(item.get("projectId") or ""))
    return item


@app.post("/storyboard/images")
async def api_storyboard_images(req: dict, user: auth.CurrentUser):
    """分镜行批量出图：启动异步任务立即返回 jobId（Next 代理 30s 会掐断
    长请求，无法阻塞等完）。前端轮询 GET /storyboard/images/{jobId}。

    req: {shots: [{rid, name, description, visual_notes?, aspect?,
                   params?: {model?, resolution?, quality?, aspect?}}],
          params?: {model?, resolution?, quality?, aspect?}}
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
        job_id = await skills.start_storyboard_image_job(
            shots, params=params, project_id=str(req.get("project_id") or "")
        )
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
    return {
        "status": job["status"],
        "images": list(job["images"].values()),
        # ref_gap：本批**实际带参考图**为空的项（真实题材才有）——画布侧提示
        # 「这批没有实物参考，只有文字考据约束形制」；画布直出不经过 agent，
        # 用户拿不到聊天侧那句提醒（agent 重启后从持久层恢复的 job 无该字段，
        # 给空数组不影响轮询）
        "ref_gap": job.get("refGap") or [],
    }


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
            project_id=str(req.get("project_id") or ""),
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
        # 中断也带回 partial assets（agent 重启孤儿 checkpoint 过的设定图）：
        # 前端把已生成的图照常落卡、错误如实转达——不是全有或全无；
        # 拆解期普通失败 assets 本就是 None，行为不变
        return {
            "status": "done",
            "phase": "done",
            "error": job["error"],
            "assets": job.get("assets"),
        }
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
