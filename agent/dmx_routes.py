"""DMX 余额查询（admin only）：读 .env.local 的 DMX 凭证，走 DMX 的
OpenAI 兼容 billing 端点。注意语义是 one-api 内核的（字段名照搬 OpenAI，
含义不同）：subscription.hard_limit_usd = 剩余额度，usage.total_usage
（伪装成"美分"）= 已用；quota/500000 换算出来是人民币（DMX 官方文档口径
见 doc.dmxapi.com/yuer.html）。服务端缓存 60s，多开页面/多管理员不重复打上游。
今日消耗：上游 usage 端点无视日期参数只回累计值，故按北京日界在本地做
基线差分——跨日后首次查询把当时累计值落进 app_settings 作当日基线
（页面开着时轮询 60s 内即滚基线，午夜后一两分钟的消耗会缺计，可接受）。
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException

import auth
import topics

router = APIRouter()

_CACHE: dict = {"at": 0.0, "data": None}
_CACHE_TTL = 30.0
_BASELINE_KEY = "dmx_usage_baseline"
_TZ_BJ = timezone(timedelta(hours=8))


def _beijing_today() -> str:
    return datetime.now(_TZ_BJ).strftime("%Y-%m-%d")


def _load_baseline() -> dict:
    raw = topics.get_setting(_BASELINE_KEY)
    if raw:
        try:
            b = json.loads(raw)
            if isinstance(b, dict) and isinstance(b.get("date"), str) and isinstance(b.get("cum_used"), (int, float)):
                return b
        except ValueError:
            pass
    return {"date": "", "cum_used": 0.0}


@router.get("/dmx/balance")
async def dmx_balance(admin: auth.RequireAdmin):
    now = time.time()
    cached = _CACHE["data"]
    if cached is not None and now - _CACHE["at"] < _CACHE_TTL:
        return cached

    base = (os.environ.get("DMX_BASE_URL") or "").rstrip("/")
    key = os.environ.get("DMX_API_KEY") or ""
    if not base or not key:
        raise HTTPException(status_code=404, detail="未配置 DMX 凭证（.env.local 的 DMX_BASE_URL / DMX_API_KEY）")

    headers = {"Authorization": f"Bearer {key}"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            sub = await client.get(f"{base}/dashboard/billing/subscription", headers=headers)
            usage = await client.get(f"{base}/dashboard/billing/usage", headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"DMX 不可达：{exc}") from exc
    if sub.status_code != 200 or usage.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"DMX 余额接口异常（subscription {sub.status_code} / usage {usage.status_code}）",
        )
    try:
        remaining = float(sub.json().get("hard_limit_usd") or 0)
        used = float(usage.json().get("total_usage") or 0) / 100
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="DMX 余额响应解析失败") from exc

    # 今日消耗（北京日界基线差分；跨日后首次查询滚动基线）
    today = _beijing_today()
    baseline = _load_baseline()
    if baseline["date"] != today:
        baseline = {"date": today, "cum_used": used}
        topics.set_setting(_BASELINE_KEY, json.dumps(baseline, ensure_ascii=False))
    today_used = max(0.0, used - float(baseline["cum_used"]))

    data = {
        "remaining": round(remaining, 2),
        "used": round(used, 2),
        "today_used": round(today_used, 2),
        "today_date": today,
        "currency": "CNY",
        "checked_at": int(now),
    }
    _CACHE["at"] = now
    _CACHE["data"] = data
    return data
