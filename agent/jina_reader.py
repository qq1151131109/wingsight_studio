"""本地 Jina Reader（OSS）客户端：URL → markdown 正文。

部署：docker ghcr.io/jina-ai/reader:oss，默认 127.0.0.1:3000（juben 同款，
JINA_READER_BASE_URL 可覆盖；服务器未部署时连接失败自动走直抓，不阻塞）。
定位 = fetch_page_text 的**回退通道**：直抓（httpx）对 TLS 指纹级反爬
（知乎/academia）和 PDF 无能为力，Jina 内置无头浏览器能过大部分——
实测解锁 academia.edu 与学术 PDF（hanspub），知乎登录墙仍不可（军备竞赛
常态，靠多源冗余消化）。

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


async def fetch_markdown(url: str) -> str:
    """经本地 Jina Reader 抓正文，返回 markdown 文本。失败抛
    WebSourceUnreachableError / WebSourceContentError / httpx 异常。"""
    base = (os.environ.get("JINA_READER_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    endpoint = f"{base}/{url.strip()}"
    headers = {"Accept": "text/markdown"}
    api_key = os.environ.get("JINA_READER_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
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
                # 本地实例未部署（服务器环境）：直接放弃通道，让调用方走直抓
                raise WebSourceUnreachableError("Jina Reader 不可达（本地实例未部署？）") from exc
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                if attempt == 0:
                    await asyncio.sleep(0.3)
                    continue
                raise
    raise last_exc or RuntimeError("Jina Reader 请求未完成")


def enabled() -> bool:
    return bool((os.environ.get("JINA_READER_BASE_URL") or DEFAULT_BASE_URL).strip())


__all__ = [
    "fetch_markdown",
    "enabled",
    "WebSourceUnreachableError",
    "WebSourceContentError",
    "Any",
]
