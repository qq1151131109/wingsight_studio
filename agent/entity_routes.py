"""实体库路由：浏览 / 详情（含关联选题）。

前端经同源代理 /api/v1/entities* 访问。实体是跨选题的知识节点，
详情页展示证据底账与全部关联选题（含已认领/已忽略——实体的记忆比池面长）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response

import auth
import entities as store

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/entities")
def list_entities(
    user: auth.CurrentUser,
    kind: str | None = None,
    q: str | None = None,
    limit: int = 100,
):
    _ = user
    return {"entities": store.list_entities(kind=kind, q=q, limit=min(limit, 300))}


@router.get("/entities/{entity_id}")
def get_entity(entity_id: str, user: auth.CurrentUser):
    _ = user
    entity = store.get_entity(entity_id)
    if entity is None:
        return Response(status_code=404, content="实体不存在", media_type="text/plain")
    return {"entity": entity, "topics": store.topics_for_entity(entity_id)}
