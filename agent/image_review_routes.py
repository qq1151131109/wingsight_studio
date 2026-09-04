"""AI 艺术评审路由：发起/轮询/取消/忽略（script_review_routes 同式）。

前端经同源代理 /agent-service/projects/{pid}/image-review* 访问。
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

import auth
import image_review
import projects

router = APIRouter()

DEFAULT_TEXT_MODEL_PLACEHOLDER = ""  # 评审模型走 flow 内默认（gpt-5.6-luna）


def _job_or_404(pid: str, job_id: str) -> dict | None:
    view = image_review.get_review_view(job_id, include_findings=False)
    if view is None or view["projectId"] != pid:
        return None
    return view


@router.post("/projects/{pid}/image-review")
async def api_start_review(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    node_id = str(req.get("nodeId") or "").strip()
    title = str(req.get("title") or "").strip()
    image_url = str(req.get("imageUrl") or "").strip()
    model = str(req.get("model") or "").strip()
    if not node_id:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    if not image_url:
        return Response(status_code=400, content="该卡没有可评审的图片", media_type="text/plain")
    try:
        return image_review.start_review(pid, node_id, title, image_url, model)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    except RuntimeError as exc:
        return Response(status_code=503, content=str(exc), media_type="text/plain")


@router.get("/projects/{pid}/image-review/{job_id}")
async def api_get_review(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="评审任务不存在", media_type="text/plain")
    view = image_review.get_review_view(job_id)
    assert view is not None
    return view


@router.post("/projects/{pid}/image-review/{job_id}/findings/{finding_id}/dismiss")
async def api_dismiss_finding(pid: str, job_id: str, finding_id: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="评审任务不存在", media_type="text/plain")
    dismissed = bool(req.get("dismissed"))
    try:
        return image_review.set_finding_dismissed(job_id, finding_id, dismissed)
    except ValueError as exc:
        return Response(status_code=404, content=str(exc), media_type="text/plain")


@router.post("/projects/{pid}/image-review/{job_id}/cancel")
async def api_cancel_review(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="评审任务不存在", media_type="text/plain")
    try:
        image_review.cancel_review(job_id)
    except ValueError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")
    return {"ok": True}
