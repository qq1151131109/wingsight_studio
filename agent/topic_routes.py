"""选题池路由：刷新（异步任务）/ 列表 / 详情 / 忽略 / 认领。

前端经同源代理 /agent-service/topics* 访问。刷新跑完整策展管线（多次
flow 调用 + 多轮检索，远超 Next 代理 30s），必须异步任务 + 轮询。
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from fastapi import APIRouter, Response

import auth
import insights as insight_store
import projects
import topics as store
from topic_pool import (
    AUTO_REFRESH_LAST_DATE_KEY,
    FLOW_IDS,
    SERVICE,
    get_auto_refresh,
    get_deep_dive_job,
    get_rescan_job,
    set_auto_refresh,
    start_deep_dive_job,
    start_rescan_job,
    verticals_payload,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# 常规刷新只跑生料生成层，仅依赖 ideate flow
_IDEATE_FLOW_KEYS = ("ideate",)
# 深挖层（取证→verdict）依赖的 flow；angle 缺配时 verdict 自选角度，不拦
_DEEP_FLOW_KEYS = ("plan", "followup", "verdict")
_RESCAN_FLOW_KEYS = ("rescan_plan", "followup", "verdict")


def _require_flow_ids(keys: tuple[str, ...] = _IDEATE_FLOW_KEYS) -> str | None:
    missing = [FLOW_IDS[key] for key in keys if not os.environ.get(FLOW_IDS[key], "").strip()]
    return "、".join(missing) if missing else None


@router.post("/topics/refresh")
async def refresh_topics(user: auth.CurrentUser):
    """启动一次策展刷新（单飞）；已在跑时 409。"""
    _ = user
    missing = _require_flow_ids()
    if missing:
        return Response(status_code=503, content=f"未配置选题 flow id：{missing}", media_type="text/plain")
    if not SERVICE.start():
        return Response(status_code=409, content="已有刷新在跑", media_type="text/plain")
    return {"started": True}


@router.get("/topics")
def list_topics(
    user: auth.CurrentUser,
    status: str = "candidate",
    vertical: str | None = None,
    source: str | None = None,
    stage: str | None = None,
    q: str | None = None,
    limit: int = 200,
    offset: int = 0,
):
    _ = user
    filters = {"status": status, "vertical": vertical, "source": source, "stage": stage, "q": q}
    return {
        # 滚动分页：topics 是 offset 起的一页窗口，total 是同筛选下全量条数
        "topics": store.list_topics(limit=min(limit, 500), offset=max(offset, 0), **filters),
        "total": store.count_topics(**filters),
        "refreshing": SERVICE.refreshing,
        "lastRun": SERVICE.last_run(),
        "verticals": verticals_payload(),
        "counts": {
            "raw": store.count_topics(status="candidate", stage="raw"),
            "verified": store.count_topics(status="candidate", stage="verified"),
        },
    }


@router.get("/topics/schedule")
def get_schedule(user: auth.CurrentUser):
    """每日自动刷新的开关与时刻（进程内调度，存 app_settings）。"""
    _ = user
    return {
        "schedule": get_auto_refresh(),
        "lastAutoRunDate": store.get_setting(AUTO_REFRESH_LAST_DATE_KEY) or "",
    }


@router.put("/topics/schedule")
def put_schedule(payload: dict[str, Any], user: auth.CurrentUser):
    _ = user
    try:
        cfg = set_auto_refresh(enabled=bool(payload.get("enabled")), time=str(payload.get("time") or ""))
    except ValueError as exc:
        return Response(status_code=400, content=str(exc), media_type="text/plain")
    return {"schedule": cfg}


@router.get("/topics/insights")
def list_insights(user: auth.CurrentUser):
    """标杆拆解知识库（管理面板）：条目 + 聚合画像。

    声明在 /topics/{topic_id} 之前——否则 "insights" 会被当成 topic_id 吃掉。
    """
    _ = user
    return {
        "insights": insight_store.list_all(),
        "distribution": insight_store.distribution(),
        "statsLine": insight_store.stats_line(),
    }


@router.put("/topics/insights/{insight_id}")
def update_insight(insight_id: str, payload: dict[str, Any], user: auth.CurrentUser):
    """用户手工修订拆解（打 edited 标记，后续重拆不覆盖）。"""
    _ = user
    if not insight_store.update_insight(insight_id, payload):
        return Response(status_code=404, content="知识条目不存在或无可改字段", media_type="text/plain")
    return {"updated": True}


@router.delete("/topics/insights/{insight_id}")
def delete_insight(insight_id: str, user: auth.CurrentUser):
    _ = user
    if not insight_store.delete_insight(insight_id):
        return Response(status_code=404, content="知识条目不存在", media_type="text/plain")
    return {"deleted": True}


@router.post("/topics/{topic_id}/rescan")
async def rescan_topic(topic_id: str, user: auth.CurrentUser):
    """手动深挖一张观察卡：缺口导向小预算复查，异步任务 + 轮询（代理 30s 限制）。

    不拦「策展刷新进行中」：全量喂入的刷新一轮数小时，单卡复查与它共享的
    只有落库写入（SQLite 串行）与同卡互斥集（_rescan_inflight），无冲突。
    """
    _ = user
    missing = _require_flow_ids(_RESCAN_FLOW_KEYS)
    if missing:
        return Response(status_code=503, content=f"未配置选题 flow id：{missing}", media_type="text/plain")
    topic = store.get_topic(topic_id)
    if topic is None:
        return Response(status_code=404, content="选题不存在", media_type="text/plain")
    if topic["status"] != "candidate":
        return Response(status_code=409, content="仅候选状态可深挖", media_type="text/plain")
    if (topic.get("research") or {}).get("evidence_level") == "strong":
        return Response(status_code=400, content="建议卡证据已充分，无需深挖", media_type="text/plain")
    job_id = start_rescan_job(topic)
    if job_id is None:
        return Response(status_code=409, content="该卡已有复查在跑", media_type="text/plain")
    return {"jobId": job_id}


@router.get("/topics/rescan/{job_id}")
def get_rescan(job_id: str, user: auth.CurrentUser):
    _ = user
    job = get_rescan_job(job_id)
    if job is None:
        return Response(status_code=404, content="复查任务不存在（可能已完成较久被清理）", media_type="text/plain")
    return {"job": job}


@router.post("/topics/{topic_id}/deep-dive")
async def deep_dive_topic(topic_id: str, user: auth.CurrentUser):
    """导演点名深挖一张生料卡：全流程取证（含市场实查），异步任务 + 轮询。

    不拦「策展刷新进行中」：同 rescan，单卡任务与长刷新无共享冲突。
    """
    _ = user
    missing = _require_flow_ids(_DEEP_FLOW_KEYS)
    if missing:
        return Response(status_code=503, content=f"未配置选题 flow id：{missing}", media_type="text/plain")
    topic = store.get_topic(topic_id)
    if topic is None:
        return Response(status_code=404, content="选题不存在", media_type="text/plain")
    if topic["status"] != "candidate":
        return Response(status_code=409, content="仅候选状态可深挖", media_type="text/plain")
    job_id = start_deep_dive_job(topic)
    if job_id is None:
        return Response(status_code=409, content="该卡已在深挖中", media_type="text/plain")
    return {"jobId": job_id}


@router.get("/topics/deep-dive/{job_id}")
def get_deep_dive(job_id: str, user: auth.CurrentUser):
    _ = user
    job = get_deep_dive_job(job_id)
    if job is None:
        return Response(status_code=404, content="深挖任务不存在（可能已完成较久被清理）", media_type="text/plain")
    return {"job": job}


@router.get("/topics/{topic_id}")
def get_topic(topic_id: str, user: auth.CurrentUser):
    _ = user
    topic = store.get_topic(topic_id)
    if topic is None:
        return Response(status_code=404, content="选题不存在", media_type="text/plain")
    return {"topic": topic}


@router.post("/topics/{topic_id}/dismiss")
def dismiss_topic(topic_id: str, user: auth.CurrentUser):
    _ = user
    result = store.dismiss_topic(topic_id)
    if result == "not_found":
        return Response(status_code=404, content="选题不存在", media_type="text/plain")
    if result == "conflict":
        return Response(status_code=409, content="仅候选状态可忽略", media_type="text/plain")
    return {"ok": True}


def _topic_card_body(topic: dict[str, Any]) -> str:
    """选题内容落画布剧本卡的正文：生料卡写全迷你策划案，建议卡写立项建议，观察卡写观察记录。"""
    research = topic.get("research") or {}
    lines: list[str] = []
    if topic.get("stage") == "raw":
        lines.append(f"【情绪钩子】{topic.get('summary', '')}")
        if topic.get("arc"):
            lines.append(f"【成片推演】{topic['arc']}")
        episodes = topic.get("episodes") or []
        if episodes:
            lines.append("【分集构想】")
            lines.extend(f"- {e.get('title', '')}：{e.get('focus', '')}" for e in episodes)
        benchmarks = topic.get("benchmarks") or []
        if benchmarks:
            lines.append("【对标与差异】")
            lines.extend(f"- 《{b.get('title', '')}》{b.get('note', '')}" for b in benchmarks)
        if topic.get("audience"):
            lines.append(f"【目标观众】{topic['audience']}")
        evidence = topic.get("heatEvidence") or []
        if evidence:
            lines.append("【原型出处】")
            lines.extend(
                f"- {h.get('title', '')}{'（' + h['url'] + '）' if h.get('url') else ''}"
                for h in evidence
                if h.get("title")
            )
        lines.append("【下一步】深挖取证补信源底账，或直接开始拆解分镜")
    elif (research.get("evidence_level") or "") == "strong":
        lines.append(f"【事件】{research.get('event', '')}")
        if research.get("why_now"):
            lines.append(f"【为何是现在】{research['why_now']}")
        if topic.get("angles"):
            lines.append("【讲法角度】")
            lines.extend(f"- {a}" for a in topic["angles"])
        if research.get("material_base"):
            lines.append(f"【材料底数】{research['material_base']}")
        if research.get("person_anchor"):
            lines.append(f"【人物锚点】{research['person_anchor']}")
        if research.get("emotion"):
            lines.append(f"【情绪钩子】{research['emotion']}")
        if research.get("competition_gap"):
            lines.append(f"【对家与差异】{research['competition_gap']}")
        if research.get("viewing_question"):
            lines.append(f"【观看问题】{research['viewing_question']}")
        scale = research.get("scale") or "single"
        if scale == "series" and research.get("series_thread"):
            lines.append(f"【体量】系列（串珠问题：{research['series_thread']}）")
        else:
            lines.append(f"【体量】{'单片' if scale == 'single' else scale}")
    else:
        lines.append("（观察中的选题：证据尚薄，先立此存照）")
        if research.get("event"):
            lines.append(f"【已核实】{research['event']}")
        gaps = research.get("gaps") or []
        if gaps:
            lines.append("【立项缺口】")
            lines.extend(f"- {g}" for g in gaps)
        if research.get("observation"):
            lines.append(f"【观察记录】{research['observation']}")
    if research.get("source_map"):
        lines.append("")
        lines.append("（信源底账见选题池该卡的调研记录）")
    return "\n".join(lines)


def _rollback_project(pid: str) -> None:
    """认领失败的完整回滚：删项目及其从表，不留孤儿。"""
    with projects._conn() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.execute("DELETE FROM canvases WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (pid,))
        conn.execute("DELETE FROM assets WHERE project_id = ?", (pid,))


@router.post("/topics/{topic_id}/adopt")
async def adopt_topic(topic_id: str, user: auth.CurrentUser):
    """认领选题：建项目 + 选题快照落画布（剧本卡）+ 状态转 adopted。

    终态翻转用条件 UPDATE（仅 candidate 可转）防并发双认领；选题状态翻转
    失败（被并发认领）时回滚新建项目。
    """
    topic = store.get_topic(topic_id)
    if topic is None:
        return Response(status_code=404, content="选题不存在", media_type="text/plain")
    if topic["status"] != "candidate":
        return Response(status_code=409, content="仅候选状态可认领", media_type="text/plain")

    project = projects.create_project(topic["title"], user)
    pid = project["id"]
    try:
        node = {
            "id": uuid.uuid4().hex[:12],
            "type": "script",
            "position": {"x": 0, "y": 0},
            "data": {
                "nodeType": "script",
                "title": topic["title"],
                "body": _topic_card_body(topic),
                "locked": True,
            },
        }
        result = projects.save_canvas(
            pid,
            [node],
            [],
            {"x": 0, "y": 0, "zoom": 1},
            meta={"sourceTopic": {"id": topic["id"], "title": topic["title"], "vertical": topic["vertical"]}},
            viewer=user,
        )
        if result is None or not result[0]:
            raise RuntimeError("画布初始化失败")
        if not store.adopt_topic(topic_id, pid):
            # 并发对手已认领：回滚本项目，冲突上报
            _rollback_project(pid)
            return Response(status_code=409, content="该选题已被认领", media_type="text/plain")
    except Exception:
        logger.exception("选题认领收尾失败，回滚项目 %s", pid)
        _rollback_project(pid)
        raise
    return {"pid": pid, "name": project["name"]}
