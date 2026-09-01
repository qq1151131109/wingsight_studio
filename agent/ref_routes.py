"""资产参考图调研路由：搜图任务（job+轮询）、候选列表、采纳、删除。

挂在 agent 根路径（项目域资源与 /projects/{pid}/assets 同式），
前端经同源代理 /agent-service/projects/{pid}/refs/* 访问。
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

import auth
import imgresearch
import projects

router = APIRouter()


def _pid_of(request: Request) -> str:
    return request.path_params["pid"]


@router.post("/projects/{pid}/refs/research")
async def api_start_ref_research(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    node_id = str(req.get("nodeId") or "").strip()
    queries = [str(q).strip() for q in (req.get("queries") or []) if str(q).strip()]
    asset = req.get("asset") if isinstance(req.get("asset"), dict) else {}
    if not node_id:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    if not queries and not str(asset.get("description") or "").strip():
        return Response(
            status_code=400,
            content="需要搜索词或资产描述（AI 生成搜索词模式下 description 必填）",
            media_type="text/plain",
        )
    if len(queries) > 5:
        queries = queries[:5]
    job_id = imgresearch.start_research_job(pid, node_id, queries, asset)
    return {"jobId": job_id}


@router.get("/projects/{pid}/refs/research/{job_id}")
def api_get_ref_research(pid: str, job_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    job = imgresearch.get_research_job(job_id)
    if job is None or job["projectId"] != pid:
        return Response(status_code=404, content="调研任务不存在（agent 可能已重启）", media_type="text/plain")
    return {
        "status": job["status"],
        "error": job["error"],
        "errors": job["errors"],
        "note": job.get("note", ""),
        "candidates": job["candidates"],
    }


@router.get("/projects/{pid}/refs/candidates")
def api_list_ref_candidates(pid: str, nodeId: str = "", user: auth.CurrentUser = None):  # type: ignore[assignment]
    projects.assert_access(user, pid)
    if not nodeId:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    return imgresearch.list_candidates(pid, nodeId)


@router.post("/projects/{pid}/refs/adopt")
def api_adopt_ref_candidates(pid: str, req: dict, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    node_id = str(req.get("nodeId") or "").strip()
    ids = [str(i) for i in (req.get("ids") or []) if str(i).strip()]
    if not node_id or not ids:
        return Response(status_code=400, content="缺少 nodeId 或 ids", media_type="text/plain")
    if len(ids) > imgresearch.MAX_ADOPT_PER_NODE:
        return Response(
            status_code=400,
            content=f"一次最多采纳 {imgresearch.MAX_ADOPT_PER_NODE} 张参考图",
            media_type="text/plain",
        )
    return {"candidates": imgresearch.mark_adopted(pid, node_id, ids)}


@router.delete("/projects/{pid}/refs/candidates/{cid}")
def api_delete_ref_candidate(pid: str, cid: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    ok = imgresearch.delete_candidate(pid, cid)
    return {"ok": ok} if ok else Response(status_code=404)
