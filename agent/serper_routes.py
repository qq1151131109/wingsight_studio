"""Serper 号池管理（admin）：批量录入 / 清单（打码）/ 删除。

调研搜索的唯一渠道是 Serper 号池（imgresearch.serper_keys 表）；
key 额度耗尽/无效由搜索路径自动作废，这里只做录入与查看。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

import auth
import imgresearch

router = APIRouter()


@router.get("/serper-keys")
def list_serper_keys(admin: auth.RequireAdmin):
    keys = imgresearch.serper_pool_list()
    return {
        "keys": keys,
        "active": sum(1 for k in keys if k["status"] == "active"),
    }


@router.post("/serper-keys")
async def add_serper_keys(req: dict, admin: auth.RequireAdmin):
    raw = req.get("keys") if isinstance(req, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        raise HTTPException(status_code=400, detail="keys 不能为空（多个 key 每行一个）")
    keys = [k.strip() for k in raw.replace("\r", "\n").splitlines() if k.strip()]
    if not keys:
        raise HTTPException(status_code=400, detail="没有有效的 key")
    if any(len(k) < 20 for k in keys):
        raise HTTPException(status_code=400, detail="key 格式可疑（长度不足 20），请检查粘贴内容")
    result = imgresearch.serper_pool_add_keys(keys)
    return result


@router.delete("/serper-keys/{key_id}")
def delete_serper_key(key_id: str, admin: auth.RequireAdmin):
    ok = imgresearch.serper_pool_delete(key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="key 不存在")
    return {"ok": True}
