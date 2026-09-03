"""选题测试集构建 v2：各题材 × 高分/高评价/高热度 纪录片标题 → doc/topic-benchmark.md。

用途（用户指定的对标分析）：把各平台排名高/热度高的纪录片片名按类目收进
文档，之后逐个对照我们的选题管线（语料采集 → 批量创意生成）做缺口分析——
是选题逻辑不对、还是数据源没覆盖、还是垂类缺失。

v2 相对 v1 的修正（用户指出统计偏差后研究的结果）：
- 题材×双查询矩阵：13 类题材各跑「豆瓣高分」（评价维度）+「爆款热门」
  （热度维度）两条查询，类目不再靠一个通用词碰运气；
- 评分量化：豆瓣评分就在搜索摘要里（"豆瓣 9.4"），抽成结构化 rating，
  "高评价"从形容词变成可排序的字段；
- 文档按类目组织：每个题材一节，合并 该题材的搜索条目 + TikHub 热度条目，
  评分优先、播放次之排序；
- 知名 IP 直接锚（风味人间/守护解放西…）防止头部作品漏网。

通道与请求预算（一次性分析工具，不在常规管线里）：
- TikHub（按请求计费）：B站/抖音/西瓜 平台真实播放数据；
- Serper：题材双查询矩阵 + 节展获奖名单（IDFA/圣丹斯/奥斯卡/艾美/金红棉）。

运行：cd agent && uv run python build_topic_benchmark.py
输出：doc/topic-benchmark.md（人读）+ doc/topic-benchmark.json（逐条分析用）。
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

# --- 题材注册表：顺序即文档顺序 -------------------------------------------
# (题材名, 豆瓣高分查询, 爆款热门查询)；两条查询保证"高评价"+"高热度"双维度
GENRE_QUERIES: list[tuple[str, str, str]] = [
    ("罪案法治", "豆瓣 悬案 刑侦 纪录片 高分", "刑侦 大案 纪录片 真实案件 热门"),
    ("历史考古", "豆瓣 历史考古 纪录片 高分", "历史 考古纪录片 爆款 热门"),
    ("美食", "豆瓣 美食纪录片 高分", "美食纪录片 爆款 热门"),
    ("自然动物", "豆瓣 自然动物纪录片 高分", "自然动物 纪录片 爆款 BBC"),
    ("社会人文", "豆瓣 社会人文 纪录片 高分", "人文 社会纪实 纪录片 热门"),
    ("科技工程", "豆瓣 科技 纪录片 高分", "科技 工程 建造 纪录片 热门"),
    ("医疗救援", "豆瓣 医疗 急诊 纪录片 高分", "医疗 急救 纪录片 热门"),
    ("军事战争", "豆瓣 军事战争 纪录片 高分", "军事 战争 纪录片 热门"),
    ("旅行地理", "豆瓣 旅行地理 纪录片 高分", "旅行 地理 纪录片 热门"),
    ("音乐艺术", "豆瓣 音乐 艺术 纪录片 高分", "音乐 美术 设计 纪录片 热门"),
    ("体育竞技", "豆瓣 体育 纪录片 高分", "体育 竞技 纪录片 热门"),
    ("财经商业", "豆瓣 财经商业 纪录片 高分", "财经 商业 创业 纪录片 热门"),
    ("儿童教育", "豆瓣 儿童 纪录片 高分", "儿童 科普 纪录片 热门"),
]
GENRE_NAMES = [g for g, _, _ in GENRE_QUERIES]

# TikHub 平台 × 题材关键词（与题材注册表对齐；IP 名直接锚防头部漏网）
TIKHUB_KEYWORDS: dict[str, tuple[str, ...]] = {
    "bilibili": (
        "纪录片", "人文纪录片", "社会纪录片", "医疗纪录片",
        "历史纪录片", "考古纪录片", "悬案", "刑侦纪录片", "大案纪实", "法医纪录片", "警察纪录片",
        "美食纪录片", "自然纪录片", "野生动物", "海洋纪录片", "科技纪录片", "军事纪录片",
        "央视纪录片", "旅行纪录片",
        "风味人间", "舌尖上的中国", "守护解放西", "人生一串", "但是还有书籍", "我在故宫修文物",
    ),
    "douyin": ("纪录片", "微纪录片", "人文纪录片", "美食纪录片", "悬案", "大案纪实"),
    "xigua": ("纪录片", "历史纪录片", "战争纪录片", "刑侦纪录片"),
}


def _search_queries() -> list[tuple[str, str]]:
    """(分组, 查询)。组名决定文档归属：题材·X / 热门·X / 节展·X / 豆瓣聚合。"""
    queries: list[tuple[str, str]] = []
    for genre, douban_q, hot_q in GENRE_QUERIES:
        queries.append((f"题材·{genre}", douban_q))
        queries.append((f"热门·{genre}", hot_q))
    for y in YEARS:
        queries.append(("节展·IDFA", f"IDFA 阿姆斯特丹国际纪录片节 获奖名单 {y}"))
        queries.append(("节展·圣丹斯", f"圣丹斯电影节 纪录片 获奖名单 {y}"))
        queries.append(("节展·奥斯卡", f"奥斯卡 最佳纪录片 提名名单 {y}"))
        queries.append(("节展·艾美", f"新闻与纪录片艾美奖 获奖名单 {y}"))
        queries.append(("节展·金红棉", f"中国广州国际纪录片节 金红棉 获奖名单 {y}"))
    queries.append(("聚合", "豆瓣 年度榜单 纪录片 近五年"))
    queries.append(("聚合", "近五年 最火 纪录片 口碑 现象级"))
    queries.append(("聚合", "腾讯视频 纪录片 热门 爆款"))
    queries.append(("聚合", "Netflix 纪录片 爆款 近五年"))
    queries.append(("聚合", "央视 纪录频道 年度 纪录片"))
    return queries


# 垂类映射（关键词 → 我们的垂类；映射不到 = 覆盖缺口，正是要找的）
VERTICAL_RULES: list[tuple[str, str]] = [
    ("history", r"历史|考古|文物|王朝|朝代|故宫|敦煌|边疆|战争|战役|近代|党史|古城|文明|遗产|简牍|甲骨|国宝|修复"),
    ("crime", r"罪案|案件|刑侦|悬案|侦探|法医|犯罪|司法|冤案|缉毒|诈骗|谋杀|侦查"
              r"|警察|公安|民警|解放西|巡逻|扫黑|命案|大案|重案|抓捕|审讯|庭审|监狱|律师|法庭|证据"),
    ("humanity", r"人物|人生|社会|人文|美食|舌尖|风味|城市|乡村|职场|教育|医疗|急诊|守护|打工|女性|家庭|口味|江湖|店铺|夜市"
                 r"|地理|旅行|手艺|非遗|民俗|方言|设计"),
    ("science", r"自然|宇宙|太空|动物|植物|地球|海洋|科学|科技|工程|物理|能源|建造|机械|航天|深海|企鹅|野生动物|星球"
                r"|科普|生态|极地|冰川|恐龙|昆虫|行星"),
]

# 题材维度（独立于我们四垂类：先看市场真实的题材热度分布，再谈覆盖）
GENRE_RULES: list[tuple[str, str]] = [
    ("罪案法治", r"罪案|案件|刑侦|悬案|法医|犯罪|司法|冤案|警察|公安|民警|解放西|巡逻|扫黑|命案|大案|重案|抓捕|审讯|庭审|监狱|缉毒|侦探|法庭|证据"),
    ("历史考古", r"历史|考古|文物|王朝|朝代|故宫|敦煌|战争|战役|近代|古城|文明|遗产|简牍|甲骨|国宝"),
    ("美食", r"美食|舌尖|风味|口味|川菜|湘菜|下饭|夜市|小吃|厨|菜"),
    ("自然动物", r"自然|动物|野生动物|海洋|地球|星球|极地|冰川|恐龙|昆虫|生态|荒野|狩猎|大猫"),
    ("科技工程", r"科技|工程|航天|机械|建造|能源|物理|飞船|火箭|航母|国防科工|超级武器"),
    ("社会人文", r"人文|人物|人生|社会|职场|教育|女性|家庭|打工|乡村|城市|田野|手艺|非遗|民俗|方言|口述"),
    ("医疗救援", r"医疗|急诊|救护|医生|医院|手术|护理"),
    ("军事战争", r"军事|战争|战役|武器|抗战|解放战争|朝鲜|二战|军演|演训|部队"),
    ("旅行地理", r"旅行|地理|江湖|行走|边疆|路线|自驾|城市漫游"),
    ("音乐艺术", r"音乐|乐队|艺术|美术|画家|设计|书籍|文学|诗歌"),
    ("体育竞技", r"体育|足球|篮球|奥运|冠军|电竞|拳|马拉松"),
    ("财经商业", r"财经|商业|公司|创业|资本|股市|厂|产业"),
    ("儿童教育", r"儿童|幼儿|启蒙|动画科普"),
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
# 清单聚合文（"7部神仙级美食纪录片"）——它自身的豆瓣评分会污染影片评分字段，
# 必须打标：逐条分析时这类条目是"待拆包的容器"，不是影片
_LISTICLE = re.compile(r"\d+\s*部|\d+\s*个|必码|必看|码住|合集|盘点|推荐|收藏|片单|榜单|值得看")
# 豆瓣评分抽取：摘要/标题里的 "豆瓣 9.4" / "评分 9.2" / "9.7分"
_RATING_PATTERNS = [
    re.compile(r"豆瓣\s*[:：]?\s*([89](?:\.\d)?|10)\s*分?"),
    re.compile(r"评分\s*[:：]?\s*([89](?:\.\d)?|10)"),
    re.compile(r"([89]\.\d)\s*分"),
]


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
    return "自动归不出（待人工）"


def guess_genre(text: str) -> str:
    for genre, pattern in GENRE_RULES:
        if re.search(pattern, text):
            return genre
    return "自动归不出（待人工）"


def guess_angle(text: str) -> str:
    for angle, pattern in ANGLE_RULES:
        if re.search(pattern, text):
            return angle
    return ""


def guess_year(text: str) -> int | None:
    years = [int(y) for y in _YEAR_IN.findall(text)]
    recent = [y for y in years if CURRENT_YEAR - 6 <= y <= CURRENT_YEAR]
    return max(recent) if recent else None


def parse_rating(text: str) -> float | None:
    for pattern in _RATING_PATTERNS:
        m = pattern.search(text)
        if m:
            try:
                value = float(m.group(1))
                if 7.5 <= value <= 10:
                    return value
            except ValueError:
                continue
    return None


def is_listicle(title: str) -> bool:
    return bool(_LISTICLE.search(title))


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
                "episodes": 0,
                "url": e["url"],
                "year": e["year"],
            }
            series[key] = cur
        cur["play"] = max(cur["play"], e["play"] or 0)
        cur["like"] = max(cur["like"], e["like"] or 0)
        cur["episodes"] += 1
        if e["year"]:
            cur["year"] = max(cur["year"] or 0, e["year"])
    out = sorted(series.values(), key=lambda x: -x["play"])
    return out, errors


def platform_key(platform: str) -> str:
    return {"bilibili": "bili", "douyin": "dy", "xigua": "xg"}.get(platform, platform)


async def collect_search() -> dict[str, list[dict]]:
    """全部搜索查询：结果按组归并，条目带评分抽取。"""
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
            snippet = str(r.get("snippet") or "")[:220]
            if len(title) < 6:
                continue
            groups[group].append(
                {
                    "title": title,
                    "url": str(r.get("url") or ""),
                    "snippet": snippet,
                    "query": query,
                    "rating": parse_rating(title + " " + snippet),
                    "year": guess_year(title + " " + snippet),
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
    lines.append("# 选题测试集：各题材 高分 / 高评价 / 高热度 纪录片")
    lines.append("")
    lines.append(f"> 抓取于 {date.today().isoformat()}。用途：逐个对照选题管线（语料 → 批量创意生成 → 深挖）")
    lines.append("> 做缺口分析——生成不出来的是选题逻辑问题、数据源问题、还是垂类缺失。")
    lines.append("> 维度说明：**评分**=豆瓣评分（搜索摘要抽取，⭐ 标注的需人工核对）；")
    lines.append("> **播放**=TikHub 平台实抓最高播放；节展条目=奖项背书的「高评价」。")
    lines.append("")

    all_entries: list[dict] = []

    # --- 各类目清单（核心）：题材 → 高分搜索 + 热门搜索 + TikHub 热度合并 ---
    lines.append("## 一、各类目清单（每类：高分/获奖优先，热门播放次之）")
    lines.append("")
    genre_tikhub: dict[str, list[dict]] = defaultdict(list)
    for s in series:
        genre_tikhub[guess_genre(s["title"])].append(s)
    for genre in GENRE_NAMES:
        douban = search_groups.get(f"题材·{genre}", [])
        hot = search_groups.get(f"热门·{genre}", [])
        tiks = genre_tikhub.get(genre, [])
        if not douban and not hot and not tiks:
            continue
        lines.append(f"### {genre}")
        lines.append("")
        lines.append("| 标题 | 维度 | 评分/播放 | 年份 | 角度模板 |")
        lines.append("|---|---|---|---|---|")
        rows: list[tuple[float, str]] = []
        seen: set[str] = set()
        genre_entries: list[dict] = []
        for it in sorted(douban, key=lambda x: -(x["rating"] or 0)):
            key = norm_key(it["title"])
            if key in seen:
                continue
            seen.add(key)
            score = it["rating"] or 0
            listicle = is_listicle(it["title"])
            dim = "高分清单⚠" if listicle else "高分搜索"
            star = f"⭐{it['rating']}⚠" if (it["rating"] and listicle) else (str(it["rating"]) if it["rating"] else "—")
            rows.append((score + 0.5, f"| {('⚠ ' if listicle else '') + it['title'][:46]} | {dim} | {star} | {it['year'] or '—'} | {guess_angle(it['title']) or '—'} |"))
            genre_entries.append({"genre": genre, "dim": dim, "title": it["title"], "rating": it["rating"], "play": None, "year": it["year"], "url": it["url"]})
        for it in hot:
            key = norm_key(it["title"])
            if key in seen:
                continue
            seen.add(key)
            rows.append((0.4, f"| {it['title'][:46]} | 热门搜索 | — | {it['year'] or '—'} | {guess_angle(it['title']) or '—'} |"))
            genre_entries.append({"genre": genre, "dim": "热门搜索", "title": it["title"], "rating": None, "play": None, "year": it["year"], "url": it["url"]})
        for s in tiks:
            key = norm_key(s["title"])
            if key in seen:
                continue
            seen.add(key)
            rows.append((min(s["play"] / 10_000, 5.0), f"| {s['title'][:46]} | 平台热度 | {fmt_count(s['play'])} | {s['year'] or '—'} | {guess_angle(s['title']) or '—'} |"))
            genre_entries.append({"genre": genre, "dim": "平台热度", "title": s["title"], "rating": None, "play": s["play"], "year": s["year"], "url": s["url"]})
        rows.sort(key=lambda x: -x[0])
        lines.extend(row for _, row in rows[:18])
        lines.append("")
        all_entries.extend(genre_entries)

    # --- 平台热度总榜 ---
    lines.append("## 二、平台热度总榜（TikHub 实抓，按最高播放排序，前 40）")
    lines.append("")
    if series:
        lines.append("| # | 片名/系列 | 平台 | 播放 | 点赞 | 年份 | 题材 |")
        lines.append("|---|---|---|---|---|---|---|")
        for i, s in enumerate(series[:40], 1):
            genre = guess_genre(s["title"])
            lines.append(
                f"| {i} | {s['title']} | {s['platform']} | {fmt_count(s['play'])} | {fmt_count(s['like'])} "
                f"| {s['year'] or '—'} | {genre} |"
            )
            all_entries.append(
                {"tier": "平台热度", "title": s["title"], "platform": s["platform"],
                 "play": s["play"], "like": s["like"], "year": s["year"],
                 "genre": genre, "vertical_guess": guess_vertical(s["title"]),
                 "angle_guess": guess_angle(s["title"]), "url": s["url"]}
            )
    if errors:
        lines.append("")
        lines.append(f"> 采集失败：{'；'.join(errors[:5])}")
    lines.append("")

    # --- 节展获奖 ---
    for group, label in (
        ("节展·IDFA", "三、IDFA 获奖名单（搜索抽取，⚠ 需人工核对）"),
        ("节展·圣丹斯", "四、圣丹斯纪录片获奖（搜索抽取）"),
        ("节展·奥斯卡", "五、奥斯卡最佳纪录片提名（搜索抽取）"),
        ("节展·艾美", "六、新闻与纪录片艾美奖（搜索抽取）"),
        ("节展·金红棉", "七、广州国际纪录片节·金红棉（搜索抽取）"),
        ("聚合", "八、其他聚合榜单（豆瓣年度/腾讯/Netflix/央视）"),
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
            if it["rating"]:
                line_title += f" ⭐{it['rating']}"
            lines.append(line_title)
            key = norm_key(it["title"])
            if key in seen:
                continue
            seen.add(key)
            all_entries.append(
                {"tier": group, "title": it["title"], "platform": group.split("·")[-1],
                 "play": None, "like": None, "year": it["year"], "rating": it["rating"],
                 "genre": guess_genre(it["title"] + " " + it["snippet"]),
                 "vertical_guess": guess_vertical(it["title"] + " " + it["snippet"]),
                 "angle_guess": guess_angle(it["title"]),
                 "url": it["url"]}
            )
        lines.append("")

    # --- 覆盖统计 ---
    lines.append("## 九、覆盖缺口统计（自动，关键词规则粗分类；结论以人工逐条为准）")
    lines.append("")
    by_genre: dict[str, int] = defaultdict(int)
    genre_play: dict[str, int] = defaultdict(int)
    rated_by_genre: dict[str, int] = defaultdict(int)
    by_vertical: dict[str, int] = defaultdict(int)
    for e in all_entries:
        g = e.get("genre") or guess_genre(e["title"])
        by_genre[g] += 1
        if e.get("play"):
            genre_play[g] += e["play"]
        if e.get("rating"):
            rated_by_genre[g] += 1
        by_vertical[e.get("vertical_guess") or guess_vertical(e["title"])] += 1
    lines.append("### 题材分布（条数 · 播放合计 · 高分条数；先看市场要什么，再谈我们有什么）")
    lines.append("")
    for genre, n in sorted(by_genre.items(), key=lambda kv: -kv[1]):
        lines.append(
            f"- {genre}: {n} 条 · 播放合计 {fmt_count(genre_play.get(genre, 0))}"
            f" · 高分条目 {rated_by_genre.get(genre, 0)}"
        )
    lines.append("")
    lines.append("### 垂类映射（我们只有 history/crime/humanity/science 四垂类）")
    lines.append("")
    for vertical, n in sorted(by_vertical.items(), key=lambda kv: -kv[1]):
        mark = "" if vertical in ("history", "crime", "humanity", "science") else "  ← 归不进现有垂类"
        lines.append(f"- {vertical}: {n}{mark}")
    lines.append("")
    return "\n".join(lines), all_entries


async def _collect() -> tuple[list[dict], dict[str, list[dict]], list[str]]:
    print("① TikHub 平台热度采集…")
    series, errors = await collect_tikhub()
    print("② 搜索榜单采集（题材×双查询 + 节展 + 聚合）…")
    search_groups = await collect_search()
    return series, search_groups, errors


CACHE = DOC_DIR / ".benchmark-cache.json"


async def main() -> None:
    # 当日缓存：渲染逻辑可随意迭代，采集一天只跑一次（删缓存强制重抓）
    series = search_groups = errors = None
    if CACHE.exists():
        try:
            cache = json.loads(CACHE.read_text(encoding="utf-8"))
            if cache.get("day") == date.today().isoformat():
                series, search_groups, errors = cache["series"], cache["search_groups"], cache["errors"]
                print(f"当日缓存命中（{len(series)} 系列 / {sum(len(v) for v in search_groups.values())} 搜索条），跳过采集")
        except Exception:  # noqa: BLE001 - 坏缓存按无缓存处理
            series = None
    if series is None:
        series, search_groups, errors = await _collect()
        DOC_DIR.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(
            json.dumps(
                {"day": date.today().isoformat(), "series": series, "search_groups": search_groups, "errors": errors},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    print("③ 渲染文档…")
    markdown, all_entries = render_markdown(series, search_groups, errors)
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
