"""维基类别页语料采集（MediaWiki categorymembers）：生料选题层的结构性主粮。

类别页成员 = 权威、带引用的存量条目（遗址/遗产/人物/案件…），单类可达
数百条且检索免费——区别于搜索种子（按年锚碰线索、有配额成本）。类别
成员多藏在年代/学部子类里，故做一层子类展开；空类别/缺失类别静默跳过。

按天轮转：成员池按（类别, 当天日期）确定性洗牌后切片，同一天内多次刷新
取同一片（配合同名缓存不重拉），跨天自然换一片，池子不会被同一批语料
反复喂养；卡片级指纹去重兜底同题不重复入库。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random  # noqa: F401 - 预留给非确定性采样
from datetime import date, datetime, timezone
from typing import Any

import httpx

_API = "https://zh.wikipedia.org/w/api.php"
_UA = "Wingsight/1.0 (documentary research)"
# 垂类 → 候选类别（不带 Category: 前缀；不存在的类别静默跳过，量级靠多备几类。
# 类别名经 allcategories 前缀发现核实过；空类别自动跳过）
# zh dump 的类目名简繁混存：候选类别同时给简/繁两种写法，缺的自动跳过
WIKI_CATEGORIES: dict[str, tuple[str, ...]] = {
    "history": ("中国世界遗产", "中國世界遺產", "中国考古学文化", "中國考古學文化", "中国古代制度", "中國古代制度", "中国石窟"),
    "crime": ("中华人民共和国案件",),
    "science": ("中国科学院院士", "中國科學院院士", "中国科学家", "中國科學家", "中国发明家", "中國發明家"),
    "food": ("菜系", "小吃", "食材", "中国茶", "中國茶"),
    "nature": ("中国山脉", "中国河流", "中国自然保护区", "中國自然保護區", "中国自然保护区"),
    "music": ("中国音乐人", "中國音樂人", "中国戏曲", "中國戲曲", "中国音乐史", "中國音樂史", "中国美术", "中國美術", "中国书画家", "中國書畫家", "中国演员", "中國演員"),
    "finance": ("中国企业家", "中國企業家", "中国经济人物", "中國經濟人物", "中国经济史", "中國經濟史"),
    "travel": ("中国旅游景点", "中國旅遊景點"),
    "military": ("中国战争", "中國戰爭", "中国军事人物", "中國軍事人物"),
}
# 单类别单日切片上限（类别成员经子类展开后可达数百，切片+按天轮转保证
# 同日多轮刷新各喂新料；全部耗尽后次日换片）
CORPUS_PER_CATEGORY_CAP = 120
# 子类展开层数：1（年代/学部子类才是成员主体；两层会拖长请求链）
SUBCAT_EXPAND = True


async def _api_get(client: httpx.AsyncClient, params: dict[str, Any]) -> dict[str, Any] | None:
    """带重试的 MediaWiki 查询；非 JSON（限流/瞬时错误）重试后放弃返回 None。"""
    for attempt in range(3):
        try:
            resp = await client.get(_API, params=params)
            if resp.status_code == 200 and "application/json" in resp.headers.get("content-type", ""):
                return resp.json()
        except Exception:  # noqa: BLE001 - 瞬时网络错误重试
            pass
        await asyncio.sleep(0.8 * (attempt + 1))
    return None


async def _members(client: httpx.AsyncClient, category: str, cmtype: str) -> list[str]:
    """拉一个类别的成员标题（page=条目页，subcat=子类别）。"""
    data = await _api_get(
        client,
        {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmlimit": 500,
            "cmtype": cmtype,
            "format": "json",
        },
    )
    if not data:
        return []
    return [
        str(m["title"])
        for m in data.get("query", {}).get("categorymembers", [])
        if str(m.get("title") or "").strip()
    ]


async def collect_category(client: httpx.AsyncClient, category: str) -> list[str]:
    """一个类别的语料条目：直属页 + 子类展开一层的页。"""
    titles = await _members(client, category, "page")
    if SUBCAT_EXPAND:
        subcats = await _members(client, category, "subcat")
        for subcat in subcats[:20]:
            bare = subcat.removeprefix("Category:")
            if bare == category:
                continue
            child = await _members(client, bare, "page")
            titles.extend(t for t in child if not t.startswith("Category:"))
            await asyncio.sleep(0.2)  # 对维基礼貌：子类请求间隔
    seen: set[str] = set()
    unique: list[str] = []
    for t in titles:
        if t.startswith("Category:") or t.startswith("Wikipedia:") or t in seen:
            continue
        seen.add(t)
        unique.append(t)
    return unique


def day_slice(category: str, titles: list[str], cap: int, today: date | None = None) -> list[str]:
    """按（类别, 当天）确定性洗牌后取前 cap 条：同天稳定、跨天轮转。"""
    if not titles:
        return []
    today = today or date.today()
    seed = int(hashlib.sha256(f"{category}|{today.isoformat()}".encode()).hexdigest()[:8], 16)
    shuffled = sorted(titles, key=lambda t: hashlib.sha256(f"{seed}|{t}".encode()).hexdigest())
    return shuffled[:cap]


async def collect_corpus(per_category_cap: int = CORPUS_PER_CATEGORY_CAP) -> list[dict[str, Any]]:
    """全垂类语料信号条目（与其他信号同形，signal_type=corpus）。

    优先走本地离线库（wikidump：官方 dump 导入，零网络零限流、全量成员）；
    离线库不可用时回退 MediaWiki API（单类切片限流，180s 总闸由调用方控）。
    条目只有标题没有摘要（类别成员不带正文）——生成 flow 靠标题发掘选题，
    原型出处链接指向维基条目页。
    """
    fetched_at = datetime.now(timezone.utc).isoformat()
    signals: list[dict[str, Any]] = []
    import wikidump

    offline = wikidump.is_available()
    if offline:
        print("  维基语料：离线库模式")
    else:
        print("  维基语料：API 模式（离线库未建，uv run python wikidump.py build）")
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), headers={"User-Agent": _UA}) as client:
        for vertical, categories in WIKI_CATEGORIES.items():
            for category in categories:
                if offline:
                    # 离线库：直属成员 + 两层子类展开（零请求成本，量级从几十到几千；
                    # 轮转交给调用方的当日消费去重）
                    titles = set(wikidump.category_members(category))
                    for sub in wikidump.category_subcategories(category)[:20]:
                        if sub == category:
                            continue
                        titles |= set(wikidump.category_members(sub))
                        for sub2 in wikidump.category_subcategories(sub)[:10]:
                            if sub2 != sub:
                                titles |= set(wikidump.category_members(sub2))
                    titles = sorted(titles)
                else:
                    titles = await collect_category(client, category)
                if not titles:
                    continue
                # 离线库全量成员零请求成本，交给调用方的当日消费去重做轮转；
                # API 模式请求有成本，才需要按天切片限流
                sliced = titles if offline else day_slice(category, titles, per_category_cap)
                for title in sliced:
                    signals.append(
                        {
                            "title": title,
                            "platform": "wiki",
                            "source": f"维基语料:{category}",
                            "url": f"https://zh.wikipedia.org/wiki/{title}",
                            "provider": "wikipedia",
                            "vertical_seed": vertical,
                            "signal_type": "corpus",
                            "snippet": "",
                            "fetched_at": fetched_at,
                        }
                    )
                await asyncio.sleep(0.3)
    return signals


# ---------- 当日缓存（app_settings 键值；同一天多次刷新不重拉维基） ----------

CACHE_KEY = "topic_pool_wikicat_cache"


def load_day_cache(raw: str | None) -> list[dict[str, Any]] | None:
    if not raw:
        return None
    try:
        cache = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(cache, dict) or cache.get("day") != date.today().isoformat():
        return None
    items = cache.get("signals")
    return items if isinstance(items, list) else None


def build_day_cache(signals: list[dict[str, Any]]) -> str:
    return json.dumps(
        {"day": date.today().isoformat(), "signals": signals},
        ensure_ascii=False,
    )
