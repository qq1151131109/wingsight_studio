"""新闻发布 RSS 通道：机构/央媒/科普媒体的当日推流（零 key 零配额）。

定位：给材料通道补"当日新鲜"维度——搜索流拿回的是索引热门，RSS 是
真·当日发布（考古新发现/物种回归/大案通报天然自带「为何是现在」），
且官方一手源不经搜索引擎二手转引。

源分两类：原生 RSS 直连；澎湃/央视/果壳/知乎日报经本机 RSSHub
（docker 容器 rsshub，127.0.0.1:1200——镜像经 daocloud 前缀拉取）。
单 feed 失败跳过不拖累其它（RSSHub 挂了只丢它代理的源，原生源不受影响）。
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (X11; Linux x86_64) Wingsight/1.0"  # 部分央媒子域对非浏览器 UA 返回空体

# 收录源 102 个（2026-09-04/05 五轮探测逐一验证可用；按垂类分组）。
# 探测过但拒收：财联社电报（盘中快讯噪声）、国家地理 dailyphoto（图注无料）；
# 网络层整族不通：卫报/Pitchfork/BBC/CBC/DW/CNN/Deadline/Quartz/ICIJ/OCCRP/Bellingcat/大西洋月刊；
# 路由已死：新京报/果壳主站/澎湃频道/南方周末/B站纪录片分区/豆瓣精选/凤凰细分/央视财经；
# 微信公众号特稿（谷雨/极昼/人物）无官方 RSS，走知乎/搜索通道。
NEWS_FEEDS: dict[str, str] = {
    # --- 中文央媒（机构一手）---
    "中新网滚动": "https://www.chinanews.com/rss/scroll-news.xml",
    "中新网文化": "https://www.chinanews.com/rss/culture.xml",
    "中新网社会": "https://www.chinanews.com/rss/society.xml",
    "中新网财经": "https://www.chinanews.com/rss/finance.xml",
    "中新网国际": "https://www.chinanews.com/rss/world.xml",
    "中新网汽车": "https://www.chinanews.com/rss/auto.xml",
    "人民网文化": "http://www.people.com.cn/rss/culture.xml",
    "人民网社会": "http://www.people.com.cn/rss/society.xml",
    "人民网时政": "http://www.people.com.cn/rss/politics.xml",
    "人民网国际": "http://www.people.com.cn/rss/world.xml",
    "人民网军事": "http://www.people.com.cn/rss/military.xml",
    "人民网环保": "http://www.people.com.cn/rss/env.xml",
    "人民网教育": "http://www.people.com.cn/rss/edu.xml",
    "人民网理论": "http://www.people.com.cn/rss/theory.xml",
    "中国网新闻": "http://www.china.com.cn/rss/news.xml",
    # --- 中文深度/科普（经本机 RSSHub 代理）---
    "澎湃精选": "http://127.0.0.1:1200/thepaper/featured",
    "央视新闻联播": "http://127.0.0.1:1200/cctv/xwlb",
    "凤凰网资讯": "http://127.0.0.1:1200/ifeng/news",
    "财新最新": "http://127.0.0.1:1200/caixin/latest",
    "华尔街见闻": "http://127.0.0.1:1200/wallstreetcn/news",
    "联合早报": "http://127.0.0.1:1200/zaobao/realtime",
    "果壳科学人": "http://127.0.0.1:1200/guokr/scientific",
    "知乎日报": "http://127.0.0.1:1200/zhihu/daily",
    "钛媒体": "https://www.tmtpost.com/rss.xml",
    "爱范儿": "https://www.ifanr.com/feed",
    # --- 微信公众号提及流（RSSHub 搜狗微信搜索；按关键词搜"提及"而非订阅号，
    #     噪声偏高但转述文带原始故事种子；搜狗链接是临时跳转会过期；低频
    #     单次采集未触发验证码，勿高频调用）---
    "微信·谷雨实验室": "http://127.0.0.1:1200/wechat/sogou/谷雨实验室",
    "微信·真实故事计划": "http://127.0.0.1:1200/wechat/sogou/真实故事计划",
    "微信·人间theLivings": "http://127.0.0.1:1200/wechat/sogou/人间theLivings",
    "微信·南方人物周刊": "http://127.0.0.1:1200/wechat/sogou/南方人物周刊",
    "微信·非虚构写作": "http://127.0.0.1:1200/wechat/sogou/非虚构写作",
    "微信·纪录片": "http://127.0.0.1:1200/wechat/sogou/纪录片",
    "微信·纪录片导演": "http://127.0.0.1:1200/wechat/sogou/纪录片导演",
    "微信·丁香医生": "http://127.0.0.1:1200/wechat/sogou/丁香医生",
    # --- 科学（期刊/科普矩阵）---
    "Nature": "https://www.nature.com/nature.rss",
    "ScienceDaily": "https://www.sciencedaily.com/rss/all.xml",
    "ScienceDaily考古": "https://www.sciencedaily.com/rss/fossils_ruins.xml",
    "ScienceDaily动植物": "https://www.sciencedaily.com/rss/plants_animals.xml",
    "ScienceDaily地球气候": "https://www.sciencedaily.com/rss/earth_climate.xml",
    "ScienceDaily太空": "https://www.sciencedaily.com/rss/space_time.xml",
    "ScienceDaily脑科学": "https://www.sciencedaily.com/rss/mind_brain.xml",
    "ScienceDaily健康": "https://www.sciencedaily.com/rss/health_medicine.xml",
    "ScienceDaily物质能量": "https://www.sciencedaily.com/rss/matter_energy.xml",
    "ScienceDaily奇闻": "https://www.sciencedaily.com/rss/strange_offbeat.xml",
    "ScienceDaily计算机": "https://www.sciencedaily.com/rss/computers_math.xml",
    "ScienceDaily社会": "https://www.sciencedaily.com/rss/science_society.xml",
    "ScienceDaily生活": "https://www.sciencedaily.com/rss/living_well.xml",
    "ScienceDaily头条科学": "https://www.sciencedaily.com/rss/top/science.xml",
    "ScienceDaily头条环境": "https://www.sciencedaily.com/rss/top/environment.xml",
    "ScienceDaily头条健康": "https://www.sciencedaily.com/rss/top/health.xml",
    "NASA新闻": "https://www.nasa.gov/news-release/feed/",
    "ESA空间": "http://www.esa.int/rssfeed/Our_Activities/Space_News",
    "ESA对地观测": "http://www.esa.int/rssfeed/Our_Activities/Observing_the_Earth",
    "Space.com": "https://www.space.com/feeds/all",
    "LiveScience": "https://www.livescience.com/feeds/all",
    "Phys.org科学": "https://phys.org/rss-feed/science-news/",
    "Phys.org空间": "https://phys.org/rss-feed/space-news/",
    "Phys.org地球": "https://phys.org/rss-feed/earth-news/",
    "Phys.org生物": "https://phys.org/rss-feed/biology-news/",
    "Phys.org物理": "https://phys.org/rss-feed/physics-news/",
    "Phys.org化学": "https://phys.org/rss-feed/chemistry-news/",
    "UniverseToday": "https://www.universetoday.com/feed/",
    "EarthSky": "https://earthsky.org/feed",
    "STAT医疗": "https://www.statnews.com/feed/",
    "KFF健康": "https://kffhealthnews.org/feed/",
    # --- 历史/考古/人类学 ---
    "史密森尼杂志": "https://www.smithsonianmag.com/rss/latest_articles/",
    "Medievalists中世纪": "https://www.medievalists.net/feed/",
    "HNN历史": "https://historynewsnetwork.org/rss.xml",
    "世界历史百科": "https://www.worldhistory.org/rss/",
    "HistoryHit": "https://www.historyhit.com/feed/",
    "Sapiens人类学": "https://www.sapiens.org/feed/",
    "鹦鹉螺": "https://nautil.us/feed/",
    "Psyche心理": "https://psyche.co/feed/",
    # --- 自然/环境 ---
    "Mongabay自然": "https://news.mongabay.com/feed/",
    "Grist气候": "https://grist.org/feed/",
    "气候新闻ICN": "https://insideclimatenews.org/feed/",
    "欧洲再野化": "https://rewildingeurope.com/feed/",
    # --- 社会/长文特稿 ---
    "Aeon": "https://aeon.co/feed.rss",
    "Longreads": "https://longreads.com/feed/",
    "Narratively": "https://narratively.com/feed/",
    "Guernica": "https://www.guernicamag.com/feed/",
    "TheMarginalian": "https://www.themarginalian.org/feed/",
    # --- NPR 全家桶 ---
    "NPR国内": "https://www.npr.org/rss/rss.php?id=1001",
    "NPR全国": "https://www.npr.org/rss/rss.php?id=1006",
    "NPR国际": "https://www.npr.org/rss/rss.php?id=1004",
    "NPR科学": "https://www.npr.org/rss/rss.php?id=1007",
    "NPR文化": "https://www.npr.org/rss/rss.php?id=1008",
    "NPR图书": "https://www.npr.org/rss/rss.php?id=1032",
    "NPR影视": "https://www.npr.org/rss/rss.php?id=1045",
    "NPR美食": "https://www.npr.org/rss/rss.php?id=1051",
    "NPR音乐": "https://www.npr.org/rss/rss.php?id=1106",
    "NPR健康": "https://www.npr.org/rss/rss.php?id=1127",
    "NPR摄影": "https://www.npr.org/rss/rss.php?id=1057",
    # --- 音乐/影视 ---
    "滚石音乐": "https://www.rollingstone.com/music/music-news/feed/",
    "好莱坞报道": "https://www.hollywoodreporter.com/feed/",
    "IndieWire": "https://www.indiewire.com/feed/",
    "Consequence音乐": "https://consequence.net/feed/",
    "A.V.Club流行文化": "https://www.avclub.com/rss",
    # --- 美食/旅行 ---
    "Eater美食": "https://www.eater.com/rss/index.xml",
    "Roads&Kingdoms旅食": "https://roadsandkingdoms.com/feed/",
    "Skift旅游产业": "https://skift.com/feed/",
    "NatGeo旅行UK": "https://www.natgeotraveller.co.uk/feed/",
    # --- 财经 ---
    "CNBC头条": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "CNBC全球": "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    "CNBC商业": "https://www.cnbc.com/id/10001147/device/rss/rss.html",
    "CNBC科技": "https://www.cnbc.com/id/19854910/device/rss/rss.html",
    "CNBC健康": "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    "MarketWatch": "https://feeds.marketwatch.com/marketwatch/topstories/",
    # --- 军事/教育/国际综合 ---
    "MilitaryTimes": "https://www.militarytimes.com/arc/outboundfeeds/rss/",
    "Hechinger教育": "https://hechingerreport.org/feed/",
    "France24英文": "https://www.france24.com/en/rss",
    "France24文化": "https://www.france24.com/en/culture/rss",
    "France24环境": "https://www.france24.com/en/environment/rss",
    "France24亚太": "https://www.france24.com/en/asia-pacific/rss",
    "France24欧洲": "https://www.france24.com/en/europe/rss",
    "France24非洲": "https://www.france24.com/en/africa/rss",
}
# 每 feed 取最近条数（信号是滚动的，旧条早已进过池；上限防单一源刷屏；
# 102 源 × 15 ≈ 1500 条/日，URL 去重后落在 1100-1300）
ITEMS_PER_FEED = 15

_TAG = re.compile(r"<[^>]+>")
# 学术期刊 feed 的元数据条目（勘误/撤稿/音频导读），不是新闻线索
_JOURNAL_NOISE = re.compile(r"^(author correction|retraction|publisher note|addendum|editor'?s note|audio long read)", re.I)


def _clean(text: str | None, limit: int) -> str:
    if not text:
        return ""
    plain = _TAG.sub("", text).strip()
    return plain[:limit]


def _local(tag: str) -> str:
    """剥命名空间：'{http://…/Atom}entry' → 'entry'（RSS 2.0 与 Atom 统一处理）。"""
    return tag.rsplit("}", 1)[-1]


def parse_feed(xml_text: str, feed_name: str, limit: int = ITEMS_PER_FEED) -> list[dict[str, str]]:
    """解析 RSS 2.0 / Atom：取最近 limit 条的 {title, url, snippet}。"""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items: list[dict[str, str]] = []
    nodes = [e for e in root.iter() if _local(e.tag) in ("item", "entry")]
    for node in nodes:
        title = ""
        link = ""
        snippet = ""
        for child in node:
            tag = _local(child.tag)
            if tag == "title":
                title = _clean(child.text, 120)
            elif tag == "link":
                link = ((child.get("href") or child.text or "") if not link else link).strip()
            elif tag in ("description", "summary") and not snippet:
                snippet = _clean(child.text, 200)
        if not title or not link or _JOURNAL_NOISE.match(title):
            continue
        items.append({"title": title, "url": link, "snippet": snippet, "feed": feed_name})
        if len(items) >= limit:
            break
    return items


async def fetch_all_feeds() -> list[dict[str, str]]:
    """并发拉全部新闻 feed（限流 20 路）；单 feed 失败记日志跳过。"""
    import asyncio

    sem = asyncio.Semaphore(20)

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(20.0), headers={"User-Agent": UA}, follow_redirects=True
    ) as client:  # follow_redirects：Nature 间歇 303 到 cookie 授权页再跳回

        async def _one(name: str, url: str) -> list[dict[str, str]]:
            async with sem:
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    return parse_feed(resp.text, name)
                except Exception as exc:  # noqa: BLE001 - 单 feed 失败不拖累
                    logger.warning("新闻 feed 拉取失败 feed=%s: %s", name, str(exc)[:200])
                    return []

        nested = await asyncio.gather(*(_one(name, url) for name, url in NEWS_FEEDS.items()))
    return [item for batch in nested for item in batch]
