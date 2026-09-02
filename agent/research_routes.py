"""深度调研路由：发起/确认/取消/状态/来源/gap 补研。

挂在 agent 根路径（项目域资源与 ref_routes 同式），
前端经同源代理 /agent-service/projects/{pid}/research* 访问。
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

import auth
import projects
import research

router = APIRouter()


def _pid_of(request: Request) -> str:
    return request.path_params["pid"]


def _job_or_404(pid: str, job_id: str) -> dict | None:
    view = research.get_job_view(job_id)
    if view is None or view["projectId"] != pid:
        return None
    return view


@router.post("/projects/{pid}/research")
async def api_start_research(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    topic = str(req.get("topic") or "").strip()
    brief = str(req.get("brief") or "").strip()
    depth = str(req.get("depth") or "standard").strip()
    if not topic:
        return Response(status_code=400, content="缺少 topic", media_type="text/plain")
    try:
        view = research.start_research(pid, topic, brief, depth)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    return view


@router.get("/projects/{pid}/research/{job_id}")
async def api_get_research(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    view = _job_or_404(pid, job_id)
    if view is None:
        return Response(status_code=404, content="调研任务不存在", media_type="text/plain")
    return view


@router.get("/projects/{pid}/research/{job_id}/sources")
async def api_list_sources(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="调研任务不存在", media_type="text/plain")
    return {"sources": research.list_sources(job_id)}


@router.post("/projects/{pid}/research/{job_id}/confirm")
async def api_confirm_research(pid: str, job_id: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="调研任务不存在", media_type="text/plain")
    plan = req.get("plan") if isinstance(req.get("plan"), dict) else None
    try:
        return research.confirm_plan(job_id, plan)
    except ValueError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")


@router.post("/projects/{pid}/research/{job_id}/cancel")
async def api_cancel_research(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="调研任务不存在", media_type="text/plain")
    try:
        research.cancel_research(job_id)
    except ValueError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")
    return {"ok": True}


@router.post("/projects/{pid}/research/{job_id}/gap")
async def api_gap_research(pid: str, job_id: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    if _job_or_404(pid, job_id) is None:
        return Response(status_code=404, content="调研任务不存在", media_type="text/plain")
    questions = [str(q) for q in (req.get("questions") or []) if str(q).strip()]
    if not questions:
        return Response(status_code=400, content="缺少补研问题 questions", media_type="text/plain")
    try:
        return research.start_gap(pid, job_id, questions)
    except ValueError as exc:
        return Response(status_code=409, content=str(exc), media_type="text/plain")
