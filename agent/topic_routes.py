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
import projects
import topics as store
from topic_pool import FLOW_IDS, SERVICE

logger = logging.getLogger(__name__)
router = APIRouter()


def _require_flow_ids() -> str | None:
    missing = [env for env in FLOW_IDS.values() if not os.environ.get(env, "").strip()]
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
    q: str | None = None,
    limit: int = 200,
):
    _ = user
    return {
        "topics": store.list_topics(status=status, vertical=vertical, source=source, q=q, limit=min(limit, 500)),
        "refreshing": SERVICE.refreshing,
        "lastRun": SERVICE.last_run(),
    }


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
    """选题内容落画布剧本卡的正文：建议卡写全立项建议，观察卡写观察记录。"""
    research = topic.get("research") or {}
    lines: list[str] = []
    if (research.get("evidence_level") or "") == "strong":
        lines.append(f"【事件】{research.get('event', '')}")
        if research.get("why_now"):
            lines.append(f"【为何是现在】{research['why_now']}")
        if topic.get("angles"):
            lines.append("【讲法角度】")
            lines.extend(f"- {a}" for a in topic["angles"])
        if research.get("material_base"):
            lines.append(f"【材料底数】{research['material_base']}")
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
