"""Jina Reader 两层客户端：URL → markdown 正文（本地 OSS / 官方 API 各自可调）。

层间编排上移到 research.fetch_page_text（知乎 TikHub → 本地 Jina 主路径 →
直抓回退 → 官方 API 收尾）；本模块只提供两层原语：
1. fetch_local：本地 OSS docker（ghcr.io/jina-ai/reader:oss，默认
   127.0.0.1:3000，JINA_READER_BASE_URL 可覆盖）——免费不限量，无头浏览器
   + 主内容提取，正文最干净；实例未在跑时连接失败，由调用方降直抓。
2. fetch_api：官方 API（https://r.jina.ai，JINA_READER_API_BASE_URL 可
   覆盖，**需 JINA_READER_API_KEY**）——免部署随处可用，按输出 token 计费
   （2026-09-11 口径 $0.05/百万 token、新 key 送 10M ≈ 数千次正文抓取）。
   无头浏览器集群+住宅代理，本地过不去的反爬（Cloudflare/地理封锁级）
   官方常常能过；直抓（httpx）对 TLS 指纹级反爬（知乎/academia）和 PDF
   无能为力，Jina 内置无头浏览器能过大部分——实测解锁 academia.edu 与
   学术 PDF（hanspub），知乎登录墙 TikHub 之外都不可（军备竞赛常态，
   靠多源冗余消化）。

错误分类（juben lib/web_search/jina.py 移植精简）：
- WebSourceUnreachableError：4xx——目标源永久不可抓，重试无效应换源
- WebSourceContentError：打开成功但正文是验证码/登录墙，不可作为来源
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:3000"
DEFAULT_API_BASE_URL = "https://r.jina.ai"
_TIMEOUT = httpx.Timeout(45.0)

# 4xx = 永久不可达（含付费层 402），与 5xx/超时等瞬时故障区分，防死循环重试
_PERMANENT_UNREACHABLE = frozenset({400, 401, 402, 403, 404, 410, 422, 451})

_ACCESS_BLOCK_MARKERS = (
    "请完成验证",
    "人机验证",
    "安全验证",
    "请先登录",
    "登录后阅读",
    "登录后查看",
    "访问被拒绝",
    "access denied",
    "verify you are human",
    "just a moment",
    "subscribe to continue",
    "sign in to continue",
    "paywall",
)


class WebSourceUnreachableError(ValueError):
    """目标源永久不可抓（4xx）。重试同一地址无效，应换源。"""


class WebSourceContentError(ValueError):
    """打开成功但正文是验证码/登录墙/错误页。"""


def _failure_reason(content: str) -> str | None:
    normalized = " ".join(content.split()).strip().lower()
    if not normalized:
        return "抓取结果为空"
    if len(normalized) < 80:
        return "正文过短"
    for marker in _ACCESS_BLOCK_MARKERS:
        if marker in normalized:
            return f"疑似拦截页（命中「{marker}」）"
    return None


def _strip_reader_header(text: str) -> str:
    """剥 Jina 输出头（Title:/URL Source:/Published Time:/Number of Pages:/
    Markdown Content:），只留正文。"""
    lines = text.splitlines()
    start = 0
    for i, line in enumerate(lines[:12]):
        s = line.strip()
        if s.startswith("Markdown Content:"):
            start = i + 1
            break
        if s and not (
            s.startswith(("Title:", "URL Source:", "Published Time:", "Number of Pages:", "Warning:"))
            or s.startswith("![image](")
        ):
            start = i
            break
    return "\n".join(lines[start:]).strip()


def _api_key() -> str:
    return os.environ.get("JINA_READER_API_KEY", "").strip()


async def _request_markdown(endpoint: str, headers: dict[str, str], tier: str) -> str:
    """单层请求：5xx/超时重试一次，4xx=永久不可达，正文过短/拦截页=内容错误。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                resp = await client.get(endpoint, headers=headers)
                if resp.status_code in _PERMANENT_UNREACHABLE:
                    raise WebSourceUnreachableError(f"Jina 4xx {resp.status_code}")
                resp.raise_for_status()
                content = _strip_reader_header(resp.text)
                if reason := _failure_reason(content):
                    raise WebSourceContentError(reason)
                return content
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                raise WebSourceUnreachableError(f"Jina {tier}不可达") from exc
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                if attempt == 0:
                    await asyncio.sleep(0.3)
                    continue
                raise
    raise last_exc or RuntimeError("Jina Reader 请求未完成")


async def fetch_local(url: str) -> str:
    """本地 OSS 实例层（主路径）。失败抛 WebSourceUnreachableError /
    WebSourceContentError / httpx 异常——是否降层由调用方编排。"""
    base = (os.environ.get("JINA_READER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    return await _request_markdown(f"{base}/{url.strip()}", {"Accept": "text/markdown"}, "本地实例")


def api_enabled() -> bool:
    """官方 API 层是否已配置（JINA_READER_API_KEY 非空）。"""
    return bool(_api_key())


async def fetch_api(url: str) -> str:
    """官方 API 层（收尾，烧 token）。未配 key 直接抛 WebSourceUnreachableError
    ——调用方应先 api_enabled() 判断，这里兜底防呆。"""
    key = _api_key()
    if not key:
        raise WebSourceUnreachableError("Jina 官方 API 层未配置（JINA_READER_API_KEY）")
    api_base = (os.environ.get("JINA_READER_API_BASE_URL") or DEFAULT_API_BASE_URL).rstrip("/")
    return await _request_markdown(
        f"{api_base}/{url.strip()}",
        {
            "Accept": "text/markdown",
            # 图片 markdown 链接对正文提取无价值，丢弃省输出 token（计费按输出算）
            "X-Retain-Images": "none",
            "Authorization": f"Bearer {key}",
        },
        "官方 API",
    )


def enabled() -> bool:
    return bool(
        (os.environ.get("JINA_READER_BASE_URL") or DEFAULT_BASE_URL).strip() or _api_key()
    )


__all__ = [
    "fetch_markdown",
    "enabled",
    "WebSourceUnreachableError",
    "WebSourceContentError",
    "Any",
]
