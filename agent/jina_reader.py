"""Jina Reader 双层客户端：URL → markdown 正文（本地 OSS → 官方 API）。

定位 = fetch_page_text 的**回退通道**，内部再分两层（调用方无感）：
1. 本地 OSS docker（ghcr.io/jina-ai/reader:oss，默认 127.0.0.1:3000，
   JINA_READER_BASE_URL 可覆盖）——免费不限量；实例未在跑时连接失败降层。
2. 官方 API（https://r.jina.ai，**配置 JINA_READER_API_KEY 才启用**，
   JINA_READER_API_BASE_URL 可覆盖）——免部署随处可用，按输出 token 计费
   （2026-09-11 口径 $0.05/百万 token、新 key 送 10M ≈ 数千次正文抓取），
   生产服务器没部署 docker 就靠这层兜住 Jina 级抓取。
本地判定不算终审：官方有无头浏览器集群与住宅代理，本地过不去的反爬
（Cloudflare/地理封锁级）官方常常能过；真 404 双层皆败，多烧一次调用
可忽略。直抓（httpx）对 TLS 指纹级反爬（知乎/academia）和 PDF 无能为力，
Jina 内置无头浏览器能过大部分——实测解锁 academia.edu 与学术 PDF（hanspub），
知乎登录墙两层都不可（军备竞赛常态，靠 TikHub 专项通道与多源冗余消化）。

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


async def fetch_markdown(url: str) -> str:
    """双层抓正文：本地 OSS 实例 → 官方 API。本地判定不算终审——官方的
    无头浏览器集群+住宅代理常能过本地过不去的反爬；官方层需
    JINA_READER_API_KEY，未配置时本地失败即终局。失败抛
    WebSourceUnreachableError / WebSourceContentError / httpx 异常。"""
    target = url.strip()
    local_error: Exception | None = None
    try:
        base = (os.environ.get("JINA_READER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        return await _request_markdown(f"{base}/{target}", {"Accept": "text/markdown"}, "本地实例")
    except Exception as exc:  # noqa: BLE001
        local_error = exc
    if not (key := _api_key()):
        raise local_error
    api_base = (os.environ.get("JINA_READER_API_BASE_URL") or DEFAULT_API_BASE_URL).rstrip("/")
    try:
        return await _request_markdown(
            f"{api_base}/{target}",
            {
                "Accept": "text/markdown",
                # 图片 markdown 链接对正文提取无价值，丢弃省输出 token（计费按输出算）
                "X-Retain-Images": "none",
                "Authorization": f"Bearer {key}",
            },
            "官方 API",
        )
    except Exception as exc:  # noqa: BLE001
        raise exc from local_error


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
