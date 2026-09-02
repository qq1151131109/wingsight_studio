"""选题测试集构建：抓各平台近 5 年热门纪录片 → doc/topic-benchmark.md。

用途（用户指定的对标分析）：把各平台排名高/热度高的纪录片片名收进文档，
之后逐个对照我们的选题管线（语料采集 → 批量创意生成）做缺口分析——
是选题逻辑不对、还是数据源没覆盖、还是垂类缺失。

通道与请求预算（一次性分析工具，不在常规管线里）：
- TikHub（按请求计费）：B站/抖音/西瓜 按题材关键词抓真实播放/点赞，
  平台自带热度排序 → 结构化最好、噪声最低的主力通道；
- Serper（搜索）：节展获奖名单（IDFA/圣丹斯/奥斯卡/金红棉）、豆瓣年度
  高分、腾讯/Netflix 爆款——榜单页多为聚合页，条目从搜索结果标题+摘要
  规则抽取，标注"候选"供人工核对。

运行：cd agent && uv run python build_topic_benchmark.py
输出：doc/topic-benchmark.md（人读）+ doc/topic-benchmark.json（后续逐条
分析用结构化数据）。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

CURRENT_YEAR = date.today().year
YEARS = list(range(CURRENT_YEAR - 5, CURRENT_YEAR + 1))  # 近 5 年（含当年）

DOC_DIR = Path(__file__).resolve().parent.parent / "doc"

# TikHub 平台 × 题材关键词（1 关键词 1 请求/平台；预算 ≈ 平台数×词数）
# crime 一组给足关键词：罪案纪实内容的实际用词是 悬案/刑侦/大案/法医/警察，
# "犯罪纪录片"反而是低频说法（首轮统计 crime 偏低就是只给了这一个词）
TIKHUB_KEYWORDS: dict[str, tuple[str, ...]] = {
    "bilibili": (
        "纪录片", "人文纪录片", "历史纪录片", "美食纪录片", "自然纪录片",
        "社会纪录片", "医疗纪录片", "考古纪录片", "军事纪录片",
        "悬案", "刑侦纪录片", "大案纪实", "法医纪录片", "警察纪录片",
    ),
    "douyin": ("纪录片", "微纪录片", "人文纪录片", "美食纪录片", "悬案", "大案纪实"),
    "xigua": ("纪录片", "历史纪录片", "战争纪录片", "刑侦纪录片"),
}

# Serper 榜单查询（1 查询 1 请求）
def _search_queries() -> list[tuple[str, str]]:
    """(分组, 查询)。节展名单逐年查；聚合榜单一次查近年。"""
    queries: list[tuple[str, str]] = []
    for y in YEARS:
        queries.append(("节展·IDFA", f"IDFA 阿姆斯特丹国际纪录片节 获奖名单 {y}"))
        queries.append(("节展·圣丹斯", f"圣丹斯电影节 纪录片 获奖名单 {y}"))
        queries.append(("节展·奥斯卡", f"奥斯卡 最佳纪录片 提名名单 {y}"))
        queries.append(("节展·金红棉", f"中国广州国际纪录片节 金红棉 获奖名单 {y}"))
        queries.append(("豆瓣", f"豆瓣 年度榜单 纪录片 {y}"))
    queries.append(("豆瓣", "豆瓣 纪录片 高分 经典 近五年"))
    queries.append(("聚合", "近五年 最火 纪录片 豆瓣 B站 口碑"))
    queries.append(("聚合", "腾讯视频 纪录片 热门 爆款"))
    queries.append(("聚合", "Netflix Netflix 纪录片 爆款 近五年"))
    queries.append(("聚合", "国产纪录片 收视 现象级 近五年"))
    queries.append(("罪案", "悬案 纪录片 高分 推荐"))
    queries.append(("罪案", "刑侦 大案 纪录片 真实案件 豆瓣"))
    queries.append(("罪案", "守护解放西 类似 警察 纪录片"))
    return queries


# 垂类映射（关键词 → 我们的垂类；映射不到 = 覆盖缺口，正是要找的）
VERTICAL_RULES: list[tuple[str, str]] = [
    ("history", r"历史|考古|文物|王朝|朝代|故宫|敦煌|边疆|战争|战役|近代|党史|古城|文明|遗产|简牍|甲骨"),
    ("crime", r"罪案|案件|刑侦|悬案|侦探|法医|犯罪|司法|冤案|缉毒|诈骗|谋杀|侦查"
              r"|警察|公安|民警|解放西|巡逻|扫黑|命案|大案|重案|抓捕|审讯|庭审|监狱|律师|法庭|证据"),
    ("humanity", r"人物|人生|社会|人文|美食|舌尖|风味|城市|乡村|职场|教育|医疗|急诊|守护|打工|女性|家庭|口味|江湖|店铺|夜市"),
    ("science", r"自然|宇宙|太空|动物|植物|地球|海洋|科学|科技|工程|物理|能源|建造|机械|航天|深海|企鹅|野生动物|星球"),
]

# 爆款角度模板命中（topic-angle-gen 的模板库，粗匹配）
ANGLE_RULES: list[tuple[str, str]] = [
    ("一件物", r"文物|国宝|一件|之物|档案"),
    ("一个人", r"人物|大师|主厨|匠人|人生|生命|最后"),
    ("一个场域", r"急诊|守护|派出所|街头|夜市|工厂|学校|市场|书店"),
    ("过程叙事", r"建造|修复|诞生|诞生记|成长|24小时|日记"),
    ("档案考古", r"档案|解密|揭秘|真相|悬案|考据"),
    ("正义回归", r"平反|冤案|正义|追凶|缉凶"),
    ("悬念追查", r"谜|真相|悬案|失踪|追查|调查"),
    ("时代切片", r"年代|时代|九十年代|世纪|百年"),
]

_SITE_TAIL = re.compile(r"[-_|｜]\s*(豆瓣|哔哩哔哩|bilibili|腾讯视频|爱奇艺|网易|新浪|搜狐|知乎|百度百科|维基百科)(\.com|\.cn)?\s*$", re.IGNORECASE)
_YEAR_IN = re.compile(r"(19|20)\d{2}")


def clean_title(title: str) -> str:
    t = _SITE_TAIL.sub("", title.strip())
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def norm_key(title: str) -> str:
    keep = [ch for ch in title.lower() if ch.isalnum()]
    return "".join(keep)


def guess_vertical(text: str) -> str:
    for vertical, pattern in VERTICAL_RULES:
        if re.search(pattern, text):
            return vertical
    return "未覆盖"


def guess_angle(text: str) -> str:
    for angle, pattern in ANGLE_RULES:
        if re.search(pattern, text):
            return angle
    return ""


def guess_year(text: str) -> int | None:
    years = [int(y) for y in _YEAR_IN.findall(text)]
    recent = [y for y in years if CURRENT_YEAR - 6 <= y <= CURRENT_YEAR]
    return max(recent) if recent else None


def fmt_count(value: int | None) -> str:
    if not value or value <= 0:
        return "—"
    return f"{value / 10_000:.1f}万" if value >= 10_000 else str(value)


async def collect_tikhub() -> tuple[list[dict], list[str]]:
    """B站/抖音/西瓜 按关键词抓视频，聚成"系列"级（同一片名的多集合并）。"""
    api_key = os.environ.get("TIKHUB_API_KEY", "").strip()
    if not api_key:
        return [], ["未配置 TIKHUB_API_KEY，跳过平台热度采集"]
    import tikhub

    client = tikhub.TikHubClient(
        api_key=api_key,
        base_url=os.environ.get("TIKHUB_BASE_URL", "").strip() or tikhub.DEFAULT_TIKHUB_BASE_URL,
    )
    import httpx

    entries: list[dict] = []
    errors: list[str] = []
    requests_used = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as http:
        for platform, keywords in TIKHUB_KEYWORDS.items():
            for keyword in keywords:
                try:
                    items = await client.search_videos(platform, keyword, count=10)
                    requests_used += 1
                except Exception as exc:  # noqa: BLE001 - 单关键词失败跳过
                    errors.append(f"{platform}/{keyword}: {str(exc)[:80]}")
                    continue
                for it in items:
                    title = clean_title(str(it.get("title") or ""))
                    if len(title) < 4:
                        continue
                    entries.append(
                        {
                            "title": title,
                            "platform": platform,
                            "keyword": keyword,
                            "play": it.get("play_count") or 0,
                            "like": it.get("like_count") or 0,
                            "author": str(it.get("author") or ""),
                            "url": str(it.get("url") or ""),
                            "year": guess_year(title + " " + str(it.get("published_at") or "")),
                        }
                    )
                await asyncio.sleep(0.3)
    print(f"  TikHub: {requests_used} 请求，{len(entries)} 条视频")

    # 系列聚合：同一 normalized 前缀（去掉 集数/期/上下季 尾巴）合并，热度取最大播放
    series: dict[str, dict] = {}
    for e in entries:
        base = re.split(r"[（(]?(?:第?\s*\d+\s*[集期话季]|EP?\d+|上|下|中)[）)]?\s*$", e["title"])[0].strip()
        base = base or e["title"]
        key = f"{platform_key(e['platform'])}:{norm_key(base)}"
        cur = series.get(key)
        if cur is None:
            cur = {
                "title": base,
                "platform": e["platform"],
                "play": 0,
                "like": 0,
                "authors": set(),
                "url": e["url"],
                "year": e["year"],
                "episodes": 0,
            }
            series[key] = cur
        cur["play"] = max(cur["play"], e["play"] or 0)
        cur["like"] = max(cur["like"], e["like"] or 0)
        cur["episodes"] += 1
        if e["author"]:
            cur["authors"].add(e["author"])
        if e["year"]:
            cur["year"] = max(cur["year"] or 0, e["year"])
    out = []
    for cur in series.values():
        cur["authors"] = "、".join(sorted(cur["authors"])[:2])
        out.append(cur)
    out.sort(key=lambda x: -x["play"])
    return out, errors


def platform_key(platform: str) -> str:
    return {"bilibili": "bili", "douyin": "dy", "xigua": "xg"}.get(platform, platform)


async def collect_search() -> dict[str, list[dict]]:
    """节展/豆瓣/聚合榜单：搜索结果按组归并（聚合页标题即条目线索）。"""
    from websearch import web_search

    groups: dict[str, list[dict]] = defaultdict(list)
    queries = _search_queries()
    for i, (group, query) in enumerate(queries, 1):
        try:
            resp = await web_search(query)
        except Exception as exc:  # noqa: BLE001 - 单查询失败跳过
            print(f"  搜索失败 [{group}] {query}: {str(exc)[:80]}")
            continue
        for r in resp.get("results", [])[:8]:
            title = clean_title(str(r.get("title") or ""))
            if len(title) < 6:
                continue
            groups[group].append(
                {
                    "title": title,
                    "url": str(r.get("url") or ""),
                    "snippet": str(r.get("snippet") or "")[:200],
                    "query": query,
                    "year": guess_year(title + " " + str(r.get("snippet") or "")),
                }
            )
        print(f"  搜索 [{group}] {i}/{len(queries)}")
        await asyncio.sleep(0.4)
    return groups


def render_markdown(
    series: list[dict],
    search_groups: dict[str, list[dict]],
    errors: list[str],
) -> tuple[str, list[dict]]:
    lines: list[str] = []
    lines.append("# 选题测试集：各平台近 5 年热门纪录片")
    lines.append("")
    lines.append(f"> 抓取于 {date.today().isoformat()}。用途：逐个对照选题管线（语料 → 批量创意生成 → 深挖）")
    lines.append("> 做缺口分析——生成不出来的是选题逻辑问题、数据源问题、还是垂类缺失。")
    lines.append(f"> 抓取通道：TikHub（B站/抖音/西瓜真实播放热度，结构化最可靠）+ 搜索（节展名单/豆瓣年度榜单，")
    lines.append("> 条目从聚合页标题抽取，标 ⚠ 的需要人工核对片名）。")
    lines.append("")

    # 结构化合集（JSON 用）
    all_entries: list[dict] = []

    # --- 平台热度（TikHub）---
    lines.append("## 一、平台热度榜（TikHub 实抓，按最高播放排序）")
    lines.append("")
    if series:
        lines.append("| # | 片名/系列 | 平台 | 播放 | 点赞 | 集中条数 | 年份线索 | 垂类映射 | 角度模板 |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for i, s in enumerate(series[:60], 1):
            vertical = guess_vertical(s["title"])
            angle = guess_angle(s["title"])
            lines.append(
                f"| {i} | {s['title']} | {s['platform']} | {fmt_count(s['play'])} | {fmt_count(s['like'])} "
                f"| {s['episodes']} | {s['year'] or '—'} | {vertical} | {angle or '—'} |"
            )
            all_entries.append(
                {"tier": "平台热度", "title": s["title"], "platform": s["platform"],
                 "play": s["play"], "like": s["like"], "year": s["year"],
                 "vertical_guess": vertical, "angle_guess": angle, "url": s["url"]}
            )
    else:
        lines.append("（无数据）")
    if errors:
        lines.append("")
        lines.append(f"> 采集失败：{'；'.join(errors[:5])}")
    lines.append("")

    # --- 节展与榜单（搜索）---
    for group, label in (
        ("节展·IDFA", "二、IDFA 获奖名单（搜索抽取，⚠ 需人工核对）"),
        ("节展·圣丹斯", "三、圣丹斯纪录片获奖（搜索抽取）"),
        ("节展·奥斯卡", "四、奥斯卡最佳纪录片提名（搜索抽取）"),
        ("节展·金红棉", "五、广州国际纪录片节·金红棉（搜索抽取）"),
        ("豆瓣", "六、豆瓣年度高分（搜索抽取）"),
        ("聚合", "七、其他聚合榜单（腾讯/Netflix/现象级）"),
    ):
        items = search_groups.get(group) or []
        lines.append(f"## {label}")
        lines.append("")
        if not items:
            lines.append("（无结果）")
            lines.append("")
            continue
        seen: set[str] = set()
        for it in items:
            flag = "⚠ " if re.search(r"榜单|名单|合集|盘点|推荐|排行", it["title"]) else ""
            line_title = f"- {flag}{it['title']}"
            if it["year"]:
                line_title += f"（{it['year']}）"
            lines.append(line_title)
            key = norm_key(it["title"])
            if key in seen:
                continue
            seen.add(key)
            vertical = guess_vertical(it["title"] + " " + it["snippet"])
            all_entries.append(
                {"tier": group, "title": it["title"], "platform": group.split("·")[-1],
                 "play": None, "like": None, "year": it["year"],
                 "vertical_guess": vertical, "angle_guess": guess_angle(it["title"]),
                 "url": it["url"]}
            )
        lines.append("")

    # --- 覆盖统计 ---
    lines.append("## 八、覆盖缺口统计（自动）")
    lines.append("")
    by_vertical: dict[str, int] = defaultdict(int)
    by_angle: dict[str, int] = defaultdict(int)
    for e in all_entries:
        by_vertical[e["vertical_guess"]] += 1
        if e["angle_guess"]:
            by_angle[e["angle_guess"]] += 1
    lines.append("### 垂类分布（我们只有 history/crime/humanity/science 四垂类）")
    lines.append("")
    for vertical, n in sorted(by_vertical.items(), key=lambda kv: -kv[1]):
        mark = "" if vertical in ("history", "crime", "humanity", "science") else "  ← **我们没覆盖**"
        lines.append(f"- {vertical}: {n}{mark}")
    lines.append("")
    lines.append("### 角度模板命中")
    lines.append("")
    for angle, n in sorted(by_angle.items(), key=lambda kv: -kv[1]):
        lines.append(f"- {angle}: {n}")
    lines.append("")
    return "\n".join(lines), all_entries


async def main() -> None:
    print("① TikHub 平台热度采集…")
    series, errors = await collect_tikhub()
    print("② 搜索榜单采集…")
    search_groups = await collect_search()
    print("③ 渲染文档…")
    markdown, all_entries = render_markdown(series, search_groups, errors)
    DOC_DIR.mkdir(parents=True, exist_ok=True)
    md_path = DOC_DIR / "topic-benchmark.md"
    json_path = DOC_DIR / "topic-benchmark.json"
    md_path.write_text(markdown, encoding="utf-8")
    json_path.write_text(
        json.dumps({"builtAt": date.today().isoformat(), "entries": all_entries}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"✓ {md_path}（{len(all_entries)} 条条目）")
    print(f"✓ {json_path}")


if __name__ == "__main__":
    asyncio.run(main())
