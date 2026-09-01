"""我的画风路由：CRUD（按用户隔离）+ 参考图反推（异步任务）。

前端经同源代理 /agent-service/styles* 访问（/api/v1 前缀与 topics 一致）。
预设 owner 才可改删；反推 = 画风反推 flow（gemini 视觉），远超 Next 代理
30s，走异步任务 + 轮询（同 prompt-optimize 范式）。
"""

from __future__ import annotations

from fastapi import APIRouter, Response

import auth
import skills
import style_presets as store

router = APIRouter()


@router.get("/styles")
def list_styles(user: auth.CurrentUser):
    return {"styles": store.list_style_presets(user.id)}


@router.post("/styles")
def create_style(req: dict, user: auth.CurrentUser):
    name = str(req.get("name") or "").strip()
    prompt = str(req.get("prompt") or "").strip()
    cover = str(req.get("coverUrl") or "").strip()
    if not name:
        return Response(status_code=400, content="画风名称不能为空", media_type="text/plain")
    if not prompt:
        return Response(status_code=400, content="画风描述不能为空", media_type="text/plain")
    try:
        style = store.create_style_preset(user.id, name[:80], prompt[:2000], cover[:500])
    except OverflowError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")
    return {"style": style}


@router.post("/styles/reverse")
async def reverse_style(req: dict, user: auth.CurrentUser):
    """从参考图反推画风描述：{imageUrls: [..]} → {jobId}，轮询 GET /styles/reverse/{jobId}。"""
    _ = user
    image_urls = req.get("imageUrls") if isinstance(req.get("imageUrls"), list) else []
    urls = [str(u) for u in image_urls if str(u).strip()]
    if not urls:
        return Response(status_code=400, content="画风反推需要至少一张参考图", media_type="text/plain")
    try:
        job_id = await skills.start_style_reverse_job(urls)
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc)[:300], media_type="text/plain")
    return {"jobId": job_id}


@router.get("/styles/reverse/{job_id}")
async def reverse_style_status(job_id: str, user: auth.CurrentUser):
    _ = user
    job = skills.get_style_reverse_job(job_id)
    if job is None:
        return Response(status_code=404, content="任务不存在", media_type="text/plain")
    return {"status": job["status"], "result": job.get("result"), "error": job.get("error")}


@router.patch("/styles/{style_id}")
def update_style(style_id: str, req: dict, user: auth.CurrentUser):
    fields: dict[str, str] = {}
    if "name" in req:
        fields["name"] = str(req.get("name") or "").strip()[:80]
    if "prompt" in req:
        fields["prompt"] = str(req.get("prompt") or "").strip()[:2000]
    if "coverUrl" in req:
        fields["cover_url"] = str(req.get("coverUrl") or "").strip()[:500]
    if fields.get("name") == "" or fields.get("prompt") == "":
        return Response(status_code=400, content="画风名称/描述不能为空", media_type="text/plain")
    style = store.update_style_preset(style_id, user.id, fields)
    if style is None:
        return Response(status_code=404, content="画风不存在", media_type="text/plain")
    return {"style": style}


@router.delete("/styles/{style_id}")
def delete_style(style_id: str, user: auth.CurrentUser):
    if not store.delete_style_preset(style_id, user.id):
        return Response(status_code=404, content="画风不存在", media_type="text/plain")
    return {"ok": True}
