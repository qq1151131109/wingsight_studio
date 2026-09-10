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
        "phase": job.get("phase", ""),
        "error": job["error"],
        "errors": job["errors"],
        "note": job.get("note", ""),
        "researchBrief": job.get("researchBrief", ""),
        "candidates": job["candidates"],
    }


@router.post("/projects/{pid}/refs/batch-research")
async def api_start_batch_ref_research(pid: str, req: dict, user: auth.CurrentUser):
    """批量调研（拆解链后）：assets 串行逐个跑单资产调研，返回 batchId。"""
    projects.assert_access(user, pid)
    assets_in = req.get("assets")
    if not isinstance(assets_in, list) or not assets_in:
        return Response(status_code=400, content="assets 不能为空", media_type="text/plain")
    if len(assets_in) > 150:
        return Response(status_code=400, content="单批最多 150 个资产", media_type="text/plain")
    assets: list[dict[str, Any]] = []
    for a in assets_in:
        if not isinstance(a, dict):
            continue
        node_id = str(a.get("nodeId") or "").strip()
        name = str(a.get("name") or "").strip()
        if not node_id or not name:
            continue
        assets.append(
            {
                "nodeId": node_id,
                "name": name[:60],
                "type": str(a.get("type") or "character"),
                "description": str(a.get("description") or "")[:600],
            }
        )
    if not assets:
        return Response(status_code=400, content="assets 缺少有效项（需 nodeId+name）", media_type="text/plain")
    return {"batchId": imgresearch.start_batch_research(pid, assets)}


@router.get("/projects/{pid}/refs/batch-research/{batch_id}")
def api_get_batch_ref_research(pid: str, batch_id: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    batch = imgresearch.get_batch_research_job(batch_id)
    if batch is None or batch["projectId"] != pid:
        return Response(status_code=404, content="批量调研任务不存在（agent 可能已重启）", media_type="text/plain")
    return {
        "status": batch["status"],
        "total": batch["total"],
        "done": batch["done"],
        "current": batch["current"],
        "items": batch["items"],
    }


@router.get("/projects/{pid}/refs/report")
def api_ref_report(pid: str, user: auth.CurrentUser):
    """项目考证报告：条目（按资产）+ 已采纳参考图底账 + 待补考据清单 + 报告正文。

    服务端权威——条目在简报产出时即入库（imgresearch.upsert_entry），报告由
    它拼装；画布上的报告卡与资产卡简报是这份数据的呈现，打开项目对账一次
    即可自愈（不再依赖前端轮询窗口，见「考证条目与报告」节注释）。"""
    projects.assert_access(user, pid)
    return imgresearch.build_report(pid)


@router.get("/projects/{pid}/refs/outline")
def api_get_ref_outline(pid: str, user: auth.CurrentUser):
    """考证大纲：主题（检索词 + 服务哪些卡 + 状态 + 已有事实）。"""
    projects.assert_access(user, pid)
    return imgresearch.build_outline_report(pid)


@router.post("/projects/{pid}/refs/outline")
async def api_set_ref_outline(pid: str, req: dict, user: auth.CurrentUser):
    """整份替换考证大纲（主题 → 检索词 → 服务哪些卡）。

    节点 id 不在画布上报错并列出可用卡清单（防幻觉，同 research_asset_references
    口径）；空大纲 400——没有要考据的题材就别建大纲。"""
    projects.assert_access(user, pid)
    topics = req.get("topics")
    if not isinstance(topics, list):
        return Response(
            status_code=400, content="topics 必须是数组", media_type="text/plain"
        )
    try:
        imgresearch.replace_topics(pid, topics)
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    return imgresearch.build_outline_report(pid)


@router.post("/projects/{pid}/refs/outline/run")
async def api_run_ref_outline(pid: str, req: dict, user: auth.CurrentUser):
    """执行大纲主题（缺省=全部未完成的）：并发跑，状态写回主题行（大纲即进度板）。"""
    projects.assert_access(user, pid)
    keys_in = req.get("topicKeys")
    keys = (
        [str(k).strip() for k in keys_in if str(k).strip()]
        if isinstance(keys_in, list)
        else None
    )
    if keys is not None:
        known = {t["topicKey"] for t in imgresearch.list_topics(pid)}
        unknown = [k for k in keys if k not in known]
        if unknown:
            return Response(
                status_code=400,
                content=f"大纲里没有这些主题：{'、'.join(unknown)}；现有主题：{'、'.join(sorted(known)) or '（空）'}",
                media_type="text/plain",
            )
    started = imgresearch.run_topics(pid, keys)
    if not started:
        return Response(
            status_code=400,
            content="没有可执行的主题（大纲为空，或指定主题都已完成）",
            media_type="text/plain",
        )
    return {"started": started, "outline": imgresearch.build_outline_report(pid)}


@router.get("/projects/{pid}/refs/candidates")
def api_list_ref_candidates(pid: str, nodeId: str = "", user: auth.CurrentUser = None):  # type: ignore[assignment]
    projects.assert_access(user, pid)
    if not nodeId:
        return Response(status_code=400, content="缺少 nodeId", media_type="text/plain")
    return imgresearch.list_candidates(pid, nodeId)


@router.get("/projects/{pid}/refs/candidate-summary")
def api_ref_candidate_summary(pid: str, user: auth.CurrentUser):
    projects.assert_access(user, pid)
    return imgresearch.candidate_summary(pid)


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
