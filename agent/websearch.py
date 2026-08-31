"""文本搜索级联（移植自 juben lib/web_search，按本项目环境裁剪）。

多源并行取证：tencent / sonar 走 DMX 网关（/v1/responses），wikipedia 直连
MediaWiki API。通道列表由 TOPIC_SEARCH_PROVIDERS 配置（默认
"tencent,sonar,wikipedia"）；缺 DMX key 时网关通道视为未配置并跳过（通道
是并列证据源而非彼此兜底，全部通道异常才抛错——空结果是合法取证结论）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

logger = logging.getLogger(__name__)

DMX_RESPONSES_ENDPOINT = "https://www.dmxapi.cn/v1/responses"
DMX_CHANNEL_MODELS = {
    "tencent": "Tencent-Search",
    "sonar": "perplexity-sonar-ssvip",
}
_WIKIPEDIA_LANGUAGES = ("zh", "en")
_WIKIPEDIA_USER_AGENT = "Wingsight/1.0 (documentary research)"
# 每通道连续失败达到阈值即熔断，冷却后放一行探活——避免坏源拖死每次级联
_BREAKER_FAILURE_THRESHOLD = 3
_BREAKER_COOLDOWN_SECONDS = 120.0

_breakers: dict[str, dict[str, float]] = {}


def _enabled_providers() -> list[str]:
    raw = os.environ.get("TOPIC_SEARCH_PROVIDERS", "tencent,sonar,wikipedia")
    return [p.strip() for p in raw.split(",") if p.strip() in ("tencent", "sonar", "wikipedia")]


def _breaker_open(provider: str) -> bool:
    entry = _breakers.get(provider)
    if not entry or entry["failures"] < _BREAKER_FAILURE_THRESHOLD:
        return False
    if time.monotonic() - entry["opened_at"] < _BREAKER_COOLDOWN_SECONDS:
        return True
    # 冷却结束：放行一个探活请求（计数保留，成功则清零）
    entry["failures"] = _BREAKER_FAILURE_THRESHOLD - 1
    return False


def _record_failure(provider: str) -> None:
    entry = _breakers.setdefault(provider, {"failures": 0, "opened_at": -1.0})
    entry["failures"] += 1
    if entry["failures"] >= _BREAKER_FAILURE_THRESHOLD:
        entry["opened_at"] = time.monotonic()


def _record_success(provider: str) -> None:
    _breakers.pop(provider, None)


def _is_http_url(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


# ---------- DMX 网关通道（tencent / sonar） ----------


def _dmx_payload(channel: str, query: str) -> dict[str, Any]:
    # Tencent-Search 兼容字符串 input；Sonar 的 DMX 适配器要求消息数组
    input_value: str | list[dict[str, str]] = (
        query if channel == "tencent" else [{"role": "user", "content": query}]
    )
    return {"model": DMX_CHANNEL_MODELS[channel], "input": input_value}


async def _dmx_search(channel: str, query: str) -> list[dict[str, str]]:
    api_key = os.environ.get("DMX_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DMX_API_KEY 未配置")
    headers = {"Authorization": api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.post(DMX_RESPONSES_ENDPOINT, headers=headers, json=_dmx_payload(channel, query))
        resp.raise_for_status()
        payload = resp.json()
    if channel == "tencent":
        response = payload.get("Response")
        pages = response.get("Pages", []) if isinstance(response, dict) else []
        results: list[dict[str, str]] = []
        for page in pages:
            decoded = page
            if isinstance(page, str):
                try:
                    decoded = json.loads(page)
                except json.JSONDecodeError:
                    continue
            if not isinstance(decoded, dict):
                continue
            url = decoded.get("url")
            if not isinstance(url, str) or not _is_http_url(url):
                continue
            results.append(
                {
                    "title": str(decoded.get("title") or "").strip(),
                    "url": url,
                    "snippet": str(decoded.get("passage") or decoded.get("summary") or "").strip(),
                    "provider": channel,
                }
            )
        return [r for r in results if r["title"]]

    # sonar：答案正文 + url_citation 引用列表
    citations: list[dict[str, str]] = []
    seen: set[str] = set()

    def _collect(annotations: Any) -> None:
        for annotation in annotations or []:
            if not isinstance(annotation, dict):
                continue
            citation = annotation.get("url_citation")
            if not isinstance(citation, dict):
                citation = annotation
            url = citation.get("url")
            if isinstance(url, str) and _is_http_url(url) and url not in seen:
                seen.add(url)
                title = citation.get("title")
                citations.append(
                    {
                        "title": (title if isinstance(title, str) else "").strip() or url,
                        "url": url,
                        "snippet": "",
                        "provider": channel,
                    }
                )

    message = (payload.get("choices") or [{}])[0].get("message") if isinstance(payload.get("choices"), list) else {}
    if isinstance(message, dict):
        _collect(message.get("annotations"))
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict) and isinstance(item.get("content"), list):
                for block in item["content"]:
                    if isinstance(block, dict):
                        _collect(block.get("annotations"))
    return citations


# ---------- wikipedia 通道 ----------


def _clean_wikipedia_snippet(value: str) -> str:
    return value.replace("<span class=\"searchmatch\">", "**").replace("</span>", "").strip()


async def _wikipedia_search(query: str) -> list[dict[str, str]]:
    responses = await asyncio.gather(
        *(_wikipedia_search_language(lang, query) for lang in _WIKIPEDIA_LANGUAGES),
        return_exceptions=True,
    )
    results: list[dict[str, str]] = []
    failures = 0
    for response in responses:
        if isinstance(response, BaseException):
            failures += 1
            continue
        results.extend(response)
    if failures == len(_WIKIPEDIA_LANGUAGES):
        raise RuntimeError("Wikipedia 暂时不可用")
    return results


async def _wikipedia_search_language(language: str, query: str) -> list[dict[str, str]]:
    params = {
        "action": "query",
        "format": "json",
        "list": "search",
        "srsearch": query,
        "srprop": "snippet",
        "srlimit": "5",
        "utf8": "1",
    }
    headers = {"Accept": "application/json", "User-Agent": _WIKIPEDIA_USER_AGENT}
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
        resp = await client.get(f"https://{language}.wikipedia.org/w/api.php", params=params, headers=headers)
        resp.raise_for_status()
        payload = resp.json()
    items = payload.get("query", {}).get("search", []) if isinstance(payload, dict) else []
    results: list[dict[str, str]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        results.append(
            {
                "title": title,
                "url": f"https://{language}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}",
                "snippet": _clean_wikipedia_snippet(str(item.get("snippet") or "")),
                "provider": "wikipedia",
            }
        )
    return results


# ---------- 级联入口 ----------


async def web_search(query: str) -> dict[str, Any]:
    """多通道并行检索，按通道顺序交错归并。全部通道异常时抛错；
    部分成功/成功但零结果都如实返回。"""
    query = query.strip()
    if not query:
        raise ValueError("query 不能为空")
    outcomes = await asyncio.gather(
        *(_search_provider(name, query) for name in _enabled_providers()),
        return_exceptions=True,
    )
    merged: list[dict[str, str]] = []
    ok_any = False
    for name, outcome in zip(_enabled_providers(), outcomes):
        if isinstance(outcome, BaseException):
            logger.warning("web_search 通道失败 provider=%s query=%s: %s", name, query[:60], str(outcome)[:200])
            continue
        ok_any = True
        merged.extend(outcome)
    if not ok_any:
        raise RuntimeError(f"全部搜索通道不可用（query={query[:60]}）")
    return {"query": query, "results": merged}


async def _search_provider(name: str, query: str) -> list[dict[str, str]]:
    if _breaker_open(name):
        logger.warning("web_search 通道熔断中，跳过 provider=%s", name)
        return []
    try:
        if name in DMX_CHANNEL_MODELS:
            results = await _dmx_search(name, query)
        elif name == "wikipedia":
            results = await _wikipedia_search(query)
        else:  # pragma: no cover - _enabled_providers 已过滤
            raise ValueError(f"未知搜索通道: {name}")
    except Exception:
        _record_failure(name)
        raise
    _record_success(name)
    return results
