"""TikHub 视频搜索客户端（移植自 juben tikhub_client，裁剪到选题市场实查所需）。

同题市场实查的数据通道：bilibili（存量最厚、播放数公开）/ douyin（短视频
消费侧，web 侧不回播放数、点赞为热度信号）/ xigua（长片完整版存量）。
计费按请求计：每簇取证只做一次三平台并发各 5 条，控制成本。

工程要点（juben 实录 + 本地 2026-09 实测）：
- 必须带浏览器 User-Agent，否则被 Cloudflare 浏览器完整性校验拦截（1010）
- douyin 的 v5 端点已拒参（400），改用 v1：POST /api/v1/douyin/search/fetch_video_search_v1，
  条目在 data.aweme_list[]，play_count 恒 0、digg_count 是有效热度
- 大陆可达走 api.tikhub.dev（主域 io 海外）；凭证只存根目录 .env.local
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIKHUB_BASE_URL = "https://api.tikhub.dev"
_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
MAX_SEARCH_ITEMS = 10
_ATTEMPTS = 2

_EM_TAG_RE = re.compile(r"<[^>]+>")
_MMSS_RE = re.compile(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$")


class TikHubError(RuntimeError):
    """TikHub 调用失败（网络 / 鉴权 / 结构异常）。"""


def _strip_html(text: str) -> str:
    return _EM_TAG_RE.sub("", text).strip()


def _int_or_none(value: Any) -> int | None:
    """计数归一：非正数与非法值统一 None（无信息量的 0 不冒充证据）。"""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _unix_seconds_to_date(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return datetime.fromtimestamp(value, tz=UTC).date().isoformat()


def _mmss_to_seconds(text: str) -> int | None:
    match = _MMSS_RE.match(text.strip())
    if not match:
        return None
    h, m, s = match.group(3), int(match.group(1)), int(match.group(2))
    return int(h) * 3600 + m * 60 + s if h is not None else m * 60 + s


def _parse_bilibili(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """B站综合搜索：data.data.result[] 仅取 type=video 条目。"""
    data = (envelope.get("data") or {}).get("data") or {}
    items: list[dict[str, Any]] = []
    for raw in data.get("result") or []:
        if not isinstance(raw, dict) or raw.get("type") != "video":
            continue
        title = _strip_html(str(raw.get("title") or ""))
        bvid = str(raw.get("bvid") or "").strip()
        if not title:
            continue
        items.append(
            {
                "platform": "bilibili",
                "title": title,
                "author": str(raw.get("author") or "").strip() or None,
                "url": f"https://www.bilibili.com/video/{bvid}" if bvid else None,
                "play_count": _int_or_none(raw.get("play")),
                "like_count": _int_or_none(raw.get("like")),
                "published_at": _unix_seconds_to_date(raw.get("pubdate")),
            }
        )
    return items


def _parse_douyin(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """抖音视频搜索 v1：data.aweme_list[]（play_count 恒 0，digg 为热度信号）。"""
    data = envelope.get("data") or {}
    items: list[dict[str, Any]] = []
    for raw in data.get("aweme_list") or []:
        aw = raw.get("aweme_info") if isinstance(raw, dict) and isinstance(raw.get("aweme_info"), dict) else raw
        if not isinstance(aw, dict):
            continue
        title = _strip_html(str(aw.get("desc") or "").replace("\n", " "))
        if not title:
            continue
        stats = aw.get("statistics") or {}
        aweme_id = str(aw.get("aweme_id") or "").strip()
        items.append(
            {
                "platform": "douyin",
                "title": title,
                "author": str((aw.get("author") or {}).get("nickname") or "").strip() or None,
                "url": str(aw.get("share_url") or "").strip() or (f"https://www.douyin.com/video/{aweme_id}" if aweme_id else None),
                "play_count": _int_or_none(stats.get("play_count")),
                "like_count": _int_or_none(stats.get("digg_count")),
                "published_at": _unix_seconds_to_date(aw.get("create_time")),
            }
        )
    return items


def _parse_xigua(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """西瓜视频搜索：data.results[].data（长片完整版存量；标题带 <em> 高亮）。"""
    data = envelope.get("data") or {}
    items: list[dict[str, Any]] = []
    for wrapper in data.get("results") or []:
        raw = wrapper.get("data") if isinstance(wrapper, dict) else None
        if not isinstance(raw, dict):
            continue
        title = _strip_html(str(raw.get("title") or ""))
        group_id = str(raw.get("group_id") or "").strip()
        if not title or not group_id:
            continue
        detail = raw.get("video_detail_info") if isinstance(raw.get("video_detail_info"), dict) else {}
        user_info = raw.get("user_info")
        items.append(
            {
                "platform": "xigua",
                "title": title,
                "author": str(user_info.get("name") if isinstance(user_info, dict) else user_info or "").strip() or None,
                "url": f"https://www.ixigua.com/{group_id}",
                "play_count": _int_or_none(detail.get("video_watch_count")),
                "like_count": None,
                "published_at": _unix_seconds_to_date(raw.get("publish_time")),
            }
        )
    return items


def _parse_zhihu_articles(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """知乎搜索 V3：data.data[].object，type=article（专栏文章）与 answer（问题回答）。

    沉淀性内容信号：赞同数（article.votes / answer.voteup_count）是公众兴趣
    的沉淀性验证，比热榜快照扎实。answer 对象内嵌 question（title 是问题
    句——用户真实关心的问法）。
    """
    data = envelope.get("data") or {}
    items: list[dict[str, Any]] = []
    for raw in data.get("data") or []:
        obj = raw.get("object") if isinstance(raw, dict) else None
        if not isinstance(obj, dict):
            obj = raw if isinstance(raw, dict) else None
        if not isinstance(obj, dict):
            continue
        kind = str(obj.get("type") or "")
        question = obj.get("question") if isinstance(obj.get("question"), dict) else {}
        if kind == "answer":
            title = _strip_html(str(question.get("name") or obj.get("title") or ""))
            obj_id = str(question.get("id") or "").strip()
            url = f"https://www.zhihu.com/question/{obj_id}" if obj_id else None
        else:
            title = _strip_html(str(obj.get("title") or ""))
            obj_id = str(obj.get("id") or "").strip()
            url = f"https://zhuanlan.zhihu.com/p/{obj_id}" if obj_id else None
        if not title:
            continue
        items.append(
            {
                "platform": "zhihu",
                "kind": kind or "article",
                "title": title,
                "author": str((obj.get("author") or {}).get("name") or "").strip() or None,
                "url": url,
                "play_count": None,
                "like_count": _int_or_none(obj.get("voteup_count") or obj.get("votes")),
                "published_at": None,
                "excerpt": _strip_html(str(obj.get("excerpt") or ""))[:120],
            }
        )
    return items


def parse_zhihu_hot(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """知乎热榜（保留：泛娱乐占比高，已从信号源降级，仅供需要时调用）。"""
    data = envelope.get("data") or {}
    items: list[dict[str, Any]] = []
    for raw in data.get("data") or []:
        target = raw.get("target") if isinstance(raw, dict) else None
        if not isinstance(target, dict):
            continue
        title = _strip_html(str(target.get("title") or ""))
        if not title:
            continue
        items.append(
            {
                "title": title,
                "url": str(target.get("url") or "").strip() or None,
                "heat_text": _strip_html(str(raw.get("detail_text") or "")),
            }
        )
    return items


_SEARCH_ENDPOINTS = {
    "bilibili": ("/api/v1/bilibili/web/fetch_general_search", _parse_bilibili),
    "douyin": ("/api/v1/douyin/search/fetch_video_search_v1", _parse_douyin),
    "xigua": ("/api/v1/xigua/app/v2/search_video", _parse_xigua),
    "zhihu": ("/api/v1/zhihu/web/fetch_article_search_v3", _parse_zhihu_articles),
}
# 向后兼容旧名（视频平台是主体，知乎是文章搜索）
_VIDEO_SEARCH = _SEARCH_ENDPOINTS


class TikHubClient:
    """异步 TikHub 视频搜索客户端；transport 仅供测试注入。"""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_TIKHUB_BASE_URL,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.transport = transport

    async def _get_json(self, client: httpx.AsyncClient, path: str) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(_ATTEMPTS):
            try:
                response = await client.get(path)
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # noqa: BLE001 - 重试后仍失败由调用方记录
                last_error = exc
                if attempt < _ATTEMPTS - 1:
                    await asyncio.sleep(1.5)
        raise TikHubError(f"{path} 调用失败: {last_error}")

    async def _post_json(self, client: httpx.AsyncClient, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(_ATTEMPTS):
            try:
                response = await client.post(path, json=payload)
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < _ATTEMPTS - 1:
                    await asyncio.sleep(1.5)
        raise TikHubError(f"{path} 调用失败: {last_error}")

    async def search_videos(self, platform: str, keyword: str, *, count: int = 5) -> list[dict[str, Any]]:
        """按关键词搜索单平台并归一（视频平台 + 知乎文章；当次快照）。"""
        entry = _SEARCH_ENDPOINTS.get(platform)
        if entry is None:
            raise TikHubError(f"unsupported search platform: {platform}")
        path, parser = entry
        kw = keyword.strip()
        if not kw:
            raise TikHubError("keyword must not be empty")
        limit = max(1, min(count, MAX_SEARCH_ITEMS))
        headers = {"Authorization": f"Bearer {self.api_key}", "User-Agent": _BROWSER_UA, "Accept": "application/json"}
        async with httpx.AsyncClient(
            base_url=self.base_url, headers=headers, timeout=self.timeout, transport=self.transport
        ) as client:
            if platform == "bilibili":
                query = urlencode({"keyword": kw, "order": "totalrank", "page": 1, "page_size": limit})
                envelope = await self._get_json(client, f"{path}?{query}")
            elif platform == "douyin":
                envelope = await self._post_json(client, path, {"keyword": kw, "count": limit, "cursor": 0})
            elif platform == "zhihu":
                query = urlencode({"keyword": kw})
                envelope = await self._get_json(client, f"{path}?{query}")
            else:  # xigua
                query = urlencode({"keyword": kw, "offset": 0, "order_type": 0})
                envelope = await self._get_json(client, f"{path}?{query}")
        return parser(envelope)[:limit]

    async def fetch_zhihu_hot(self, limit: int = 15) -> list[dict[str, Any]]:
        """知乎热榜（讨论热度信号源）；每轮刷新一次，1 请求。"""
        headers = {"Authorization": f"Bearer {self.api_key}", "User-Agent": _BROWSER_UA, "Accept": "application/json"}
        async with httpx.AsyncClient(
            base_url=self.base_url, headers=headers, timeout=self.timeout, transport=self.transport
        ) as client:
            envelope = await self._get_json(client, "/api/v1/zhihu/web/fetch_hot_list")
        return parse_zhihu_hot(envelope)[:limit]
