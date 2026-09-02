"""播客 RSS → 已验证内容信号（每期节目 = 一个被市场验证过的人物故事）。

故事FM 一类叙事播客的每期都是"讲述人自述+编辑部把关"的现成故事，
与特稿同属 validated 信号：故事性已验证，选题管线判断的是纪录片化增量。
RSS 是播客的公开分发协议，无 key 无配额；单个 feed 失败跳过不拖累其它。
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (X11; Linux x86_64) Wingsight/1.0"  # feeds 子域对非浏览器 UA 返回空体
# 收录的叙事播客（名字 → RSS 地址）；只收"真实人物故事"形态的。
# 地址经 iTunes 目录 API 校验（官网 /feed/ 已废弃只剩导航页）
PODCAST_FEEDS: dict[str, str] = {
    "故事FM": "https://feeds.storyfm.cn/storyfm.xml",
}
# 每次采集取最近期数（信号是滚动的，旧期早已进过池）
EPISODES_PER_FEED = 10

_TAG = re.compile(r"<[^>]+>")


def _clean(text: str | None, limit: int) -> str:
    if not text:
        return ""
    plain = _TAG.sub("", text).strip()
    return plain[:limit]


def parse_feed(xml_text: str, feed_name: str, limit: int = EPISODES_PER_FEED) -> list[dict[str, str]]:
    """解析 RSS 2.0：取最近 limit 期的 {title, url, snippet}。"""
    root = ET.fromstring(xml_text)
    items: list[dict[str, str]] = []
    for node in root.iter("item"):
        title = _clean(node.findtext("title"), 120)
        if not title:
            continue
        items.append(
            {
                "title": title,
                "url": (node.findtext("link") or "").strip(),
                "snippet": _clean(node.findtext("description"), 200),
                "feed": feed_name,
            }
        )
        if len(items) >= limit:
            break
    return items


async def fetch_all_feeds() -> list[dict[str, str]]:
    """并发拉全部播客 feed；单 feed 失败记日志跳过。"""
    import asyncio

    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), headers={"User-Agent": UA}) as client:

        async def _one(name: str, url: str) -> list[dict[str, str]]:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                return parse_feed(resp.text, name)
            except Exception as exc:  # noqa: BLE001 - 单 feed 失败不拖累
                logger.warning("播客 feed 拉取失败 feed=%s: %s", name, str(exc)[:200])
                return []

        nested = await asyncio.gather(*(_one(name, url) for name, url in PODCAST_FEEDS.items()))
    return [item for batch in nested for item in batch]
