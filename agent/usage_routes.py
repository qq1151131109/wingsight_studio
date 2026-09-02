"""出图用量查询（admin only）：按用户聚合的张数与模型分布，数据来自 usage.py。"""

from __future__ import annotations

from fastapi import APIRouter

import auth
import usage

router = APIRouter()


@router.get("/usage/images")
def image_usage(admin: auth.RequireAdmin):
    return usage.image_stats()


@router.get("/usage/images/daily")
def image_usage_daily(admin: auth.RequireAdmin, days: int = 14):
    return usage.image_daily(days)
