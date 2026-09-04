"""维基百科"X月X日"大事记 → 周年信号（确定性时间信号，零 LLM 零搜索成本）。

纪录片选题的经典提前量信号：逢五逢十周年。数据源是中文维基的日期页
"大事记"段（每页数十条结构化"年份：事件"）；周年算术由代码保证，
不信任任何模型的日期记忆（juben anniversary 的纪律）。

拉取窗口默认未来 45 天（给调研与立项留提前量），按窗口起点日期缓存
（周年事件是确定性数据，同一天内多次刷新不重拉）。
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import httpx

_API = "https://zh.wikipedia.org/w/api.php"
_UA = "Wingsight/1.0 (documentary research)"
# 周年筛：距事件至少 10 年（十周年即成立性节点）且逢五逢十
MIN_AGE_YEARS = 10
# 大事记段里的年份行：`* [[前44年]]：…` / `* 1752年：…` / `* [[1945年]]，…`
_YEAR_LINE = re.compile(r"^\*+\s*(?:\[\[)?(前\d{1,4}|\d{1,4})(?:\]\]|年)")
# 行内维基标记 → 纯文本（[[a|b]] 取 b，[[a]] 取 a，其余标记剥除）
_LINK = re.compile(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]")
_BRACES = re.compile(r"\{\{[^}]*\}\}")
_REF = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", re.DOTALL)


@dataclass
class DayEvents:
    """一个日期的大事记（解析自维基日期页 wikitext）。"""

    month: int
    day: int
    events: list[dict[str, Any]]  # [{year: int（公元前为负）, text: str}]


def parse_day_wikitext(wikitext: str) -> list[dict[str, Any]]:
    """从日期页 wikitext 切出"大事记"段并解析年份行。"""
    m = re.search(r"==\s*大事记\s*==\n(.*?)(?=\n==[^=])", wikitext, re.DOTALL)
    section = m.group(1) if m else ""
    events: list[dict[str, Any]] = []
    for line in section.splitlines():
        year_m = _YEAR_LINE.match(line)
        if not year_m:
            continue
        raw_year = year_m.group(1)
        year = -int(raw_year[1:]) if raw_year.startswith("前") else int(raw_year)
        text = _LINK.sub(r"\1", line)
        text = _BRACES.sub("", text)
        text = _REF.sub("", text)
        text = re.sub(r"^[\*\s\[\]]+|[\[\]]", "", text).strip()
        if len(text) < 8:  # 过短的行（残缺/占位）不成事件
            continue
        events.append({"year": year, "text": text})
    return events


def anniversary_filter(events: list[dict[str, Any]], on_year: int) -> list[dict[str, Any]]:
    """逢五逢十 + 最小年头过滤；给命中事件补周年数（age）。"""
    kept: list[dict[str, Any]] = []
    for event in events:
        age = on_year - event["year"]
        if age >= MIN_AGE_YEARS and age % 5 == 0:
            kept.append({**event, "age": age})
    return kept


async def fetch_day(client: httpx.AsyncClient, month: int, day: int) -> DayEvents:
    """拉单个日期页的大事记。"""
    resp = await client.get(
        _API,
        params={
            "action": "parse",
            "page": f"{month}月{day}日",
            "prop": "wikitext",
            "format": "json",
        },
    )
    resp.raise_for_status()
    payload = resp.json()
    wikitext = payload.get("parse", {}).get("wikitext", {}).get("*", "")
    return DayEvents(month=month, day=day, events=parse_day_wikitext(wikitext))


async def anniversary_window(
    start: date | None = None,
    days: int = 45,
    max_concurrency: int = 8,
) -> list[dict[str, Any]]:
    """未来 N 天窗口内的逢五逢十周年事件。

    返回 [{text, year, age, date}]（date=周年到来的具体日期），按日期排序。
    单页失败跳过该日（周年池是长期供给，一天缺口下轮补上）。
    """
    start = start or date.today()
    targets = [start + timedelta(days=offset) for offset in range(1, days + 1)]
    sem = asyncio.Semaphore(max_concurrency)

    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0), headers={"User-Agent": _UA}) as client:

        async def _one(d: date) -> DayEvents | None:
            async with sem:
                try:
                    return await fetch_day(client, d.month, d.day)
                except Exception:  # noqa: BLE001 - 单日失败不拖累窗口
                    return None

        results = await asyncio.gather(*(_one(d) for d in targets))

    out: list[dict[str, Any]] = []
    for target, result in zip(targets, results):
        if result is None:
            continue
        for event in anniversary_filter(result.events, target.year):
            out.append({**event, "date": target.isoformat()})
    out.sort(key=lambda e: e["date"])
    return out


# ---------- 窗口缓存（app_settings 键值，窗口起点日期为粒度） ----------

CACHE_KEY = "topic_pool_wikiday_cache"


def load_window_cache(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        cache = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return cache if isinstance(cache, dict) and cache.get("start") else None


def build_window_cache(start: date, events: list[dict[str, Any]]) -> str:
    return json.dumps(
        {"start": start.isoformat(), "builtAt": date.today().isoformat(), "events": events},
        ensure_ascii=False,
    )
