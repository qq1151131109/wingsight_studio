"""剧本审查路由：发起/轮询/取消/忽略/最新摘要。

挂在 agent 根路径（项目域资源与 research_routes 同式），
前端经同源代理 /agent-service/projects/{pid}/script-review* 访问。
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

import auth
import models
import projects
import script_review

router = APIRouter()

DEFAULT_TEXT_MODEL = next(
    (m["id"] for m in models.TEXT_MODELS if m.get("recommended")), "")


def _pid_of(request: Request) -> str:
    return request.path_params["pid"]


def _job_or_404(pid: str, job_id: str) -> dict | None:
    view = script_review.get_review_view(job_id, include_findings=False)
    if view is None or view["projectId"] != pid:
        return None
    return view


@router.post("/projects/{pid}/script-review")
async def api_start_review(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    node_id = str(req.get("nodeId") or "").strip()
    title = str(req.get("title") or "").strip()
    body = str(req.get("body") or "")
    dimensions = [str(d) for d in (req.get("dimensions") or [])]
    text_model = str(req.get("textModel") or "").strip() or DEFAULT_TEXT_MODEL
    if not node_id:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    if text_model and models.find_text_model(text_model) is None:
        return Response(status_code=400, content=f"未知文本模型：{text_model}", media_type="text/plain")
    try:
        return script_review.start_review(pid, node_id, title, body, dimensions, text_model)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")


@router.get("/projects/{pid}/script-review")
async def api_latest_review(pid: str, user: auth.CurrentUser, nodeId: str = ""):
    projects.assert_access(user, pid)
    if not nodeId:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    summary = script_review.latest_summary(pid, nodeId)
    if summary is None:
        return Response(status_code=404, content="该卡还没有审查记录", media_type="text/plain")
    return summary


@router.get("/projects/{pid}/script-review/{job_id}")
async def api_get_review(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="审查任务不存在", media_type="text/plain")
    view = script_review.get_review_view(job_id)
    assert view is not None
    return view


@router.post("/projects/{pid}/script-review/{job_id}/findings/{finding_id}/dismiss")
async def api_dismiss_finding(pid: str, job_id: str, finding_id: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="审查任务不存在", media_type="text/plain")
    dismissed = bool(req.get("dismissed"))
    try:
        return script_review.set_finding_dismissed(job_id, finding_id, dismissed)
    except ValueError as exc:
        return Response(status_code=404, content=str(exc), media_type="text/plain")


@router.post("/projects/{pid}/script-review/{job_id}/cancel")
async def api_cancel_review(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="审查任务不存在", media_type="text/plain")
    try:
        script_review.cancel_review(job_id)
    except ValueError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")
    return {"ok": True}
