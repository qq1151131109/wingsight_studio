"""选题池策展管线（移植自 juben lib/topic_pool/curator，按铁律改造）。

采集 → LLM 全量研判 → LLM 规划迭代取证 → 证据驱动两级结论 → 幂等落库。

与 juben 的差异：四个 LLM 调用点（研判/调研规划/追查/verdict）全部走
Langflow flow（v1 阻塞 API，参数经 input_value 文本载荷注入），本模块只做
编排、检索执行与 JSON 解析——prompt 即任务知识，收敛在 agent/flows/ 的
flow 版本化源里，不在这里出现。

管线形态（与 juben 一致）：原始信号全量喂一次研判调用，由 LLM 聚类相关
信号（跨渠道共振是价值信号）、判垂类、输出带优先级的短名单；随后每条
线索进入 LLM 规划的迭代调研（规划查询 → 并行检索 → 看结果决定追查，
步数帽硬编码），verdict 按证据与信源纪律给出两级结论：

- 建议卡（evidence_level=strong）：事实可核、材料有入口——完整立项建议
- 观察卡（evidence_level=thin）：只有已核实事实、立项缺口与信源底账，
  不编片名不编讲法；下轮刷新证据变硬时自动升级为建议卡

指纹幂等保持在落库前：簇内任一成员指纹已在池中（含已认领/已忽略）即跳过。
外部依赖（flow 调用 / 搜索 / 仓储）全部经构造参数注入，测试注 fake。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable

import topics as store

logger = logging.getLogger(__name__)

# 垂类注册表：加垂类=加一条 spec（标签/边界/专属材料种子/色 token），零代码改动。
# 垂类清单随研判载荷下发，flow prompt 不写死垂类。不同垂类信源结构不同：
# history/crime 靠材料事件种子，humanity 的主信源是已验证内容流（特稿/播客），
# science 靠机构发布与论文报道——material_seeds 为空的垂类由跨垂类源供给。
@dataclass(frozen=True)
class VerticalSpec:
    id: str
    label: str
    color: str  # 前端色 token（垂类圆点）
    scope: str  # 一句话边界，进研判载荷供垂类裁决
    material_seeds: tuple[str, ...] = ()


VERTICAL_SPECS: dict[str, VerticalSpec] = {
    "history": VerticalSpec(
        id="history", label="历史", color="var(--color-cool)",
        scope="历史事件、历史人物、考古发现、文物、时代记忆（核心驱动是过去的事件与过去的人）",
        material_seeds=(
            "考古中国 发布会 {year}",
            "考古新发现 {year}",
            "出土简牍 整理公布 {year}",
            "历史档案 解密公开 {year}",
        ),
    ),
    "crime": VerticalSpec(
        id="crime", label="罪案", color="var(--color-danger)",
        scope="真实刑事案件、悬案旧案、司法与社会安全事件（核心驱动是案件与正义）",
        material_seeds=(
            "最高人民法院 典型案例 {year}",
            "再审改判 案件 {year}",
            "判决文书 公开 案件 {year}",
            "案件档案 解密 {year}",
        ),
    ),
    "humanity": VerticalSpec(
        id="humanity", label="人文", color="var(--color-warm)",
        scope="普通人的命运与当下社会生活：职业、教育、家庭、迁徙、口述记忆（核心驱动是当下的生活；特稿与叙事播客是主信源）",
    ),
    "science": VerticalSpec(
        id="science", label="科普", color="var(--color-good)",
        scope="自然科学新发现、技术进展、科学机构发布（核心驱动是世界的规律，人物服务于认知）",
        material_seeds=(
            "科学 重大发现 {year}",
            "中国科学院 重大成果 发布 {year}",
        ),
    ),
}
VERTICALS: tuple[str, ...] = tuple(VERTICAL_SPECS)
VERTICAL_LABELS: dict[str, str] = {k: v.label for k, v in VERTICAL_SPECS.items()}


def verticals_payload() -> list[dict[str, str]]:
    """垂类清单（进研判载荷与前端下发，prompt 不写死垂类）。"""
    return [{"id": v.id, "label": v.label, "scope": v.scope, "color": v.color} for v in VERTICAL_SPECS.values()]

# 单次刷新产出的选题卡上限（控制 LLM 与检索成本，宁少勿滥）
MAX_CARDS_PER_REFRESH = 8
# 研判调用喂入的原始条目上限（超出截断）；四源信号量约 170-250，留头部余量
TRIAGE_ITEMS_CAP = 300
# 研判整批失败时对半拆开各研判一次（损失跨半聚类，保住本轮产出）
_TRIAGE_SPLIT = 2
# 每条查询的检索结果条数上限
RESEARCH_RESULTS_CAP = 5
# 迭代调研的步数帽：首批 ≤4 查 + 追查 ≤3 查，成本有硬上界
RESEARCH_PLAN_MAX_QUERIES = 4
RESEARCH_FOLLOWUP_MAX_QUERIES = 3
# 每条材料种子查询接受的条目上限
MAX_ITEMS_PER_QUERY = 10
# 可拍单元类型：建议卡必须收成其一，归不出说明单元不清（降为观察卡）
UNIT_KINDS: tuple[str, ...] = ("person", "object", "case", "era")
# 体量形态；series 必须带串珠问题（series_thread），缺了诚实地按 single
SCALES: tuple[str, ...] = ("single", "series", "anthology")

# 已验证内容种子：特稿媒体（谷雨/极昼/人物等）的每篇报道都是"编辑部+
# 田野"双重把关过的人物选题，故事性已验证——管线判断纪录片化增量。
# 微信公众号无公开 RSS，走澎湃/腾讯新闻的分发镜像（通道实测可达）。
VALIDATED_SEED_QUERIES: tuple[str, ...] = (
    "极昼工作室 报道 {year}",
    "谷雨实验室 特稿 {year}",
    "人物杂志 报道 {year}",
    "人间 theLivings 故事 {year}",
)
# 对标片单种子：节展/海外已验证题材 → 国产化空白（名单页一条信号含多部
# 影片，研判负责拆解评估）。
BENCHMARK_SEED_QUERIES: tuple[str, ...] = (
    "IDFA 获奖纪录片 {year}",
    "圣丹斯 纪录片 获奖 {year}",
    "奥斯卡 最佳纪录片 提名 {year}",
    "BBC Storyville 纪录片 {year}",
)
# 周年窗口天数（提前量给调研与立项留时间；juben 同款 45-60 天取下沿）
ANNIVERSARY_WINDOW_DAYS = 45

# 观察卡复查（兑现"证据变硬时自动升级"的承诺）：每轮刷新尾部顺带取最久
# 未扫的几张薄卡做缺口导向小预算复查；也支持单卡手动深挖（异步任务）。
RESCAN_BATCH_SIZE = 3
RESCAN_PLAN_MAX_QUERIES = 3
RESCAN_FOLLOWUP_MAX_QUERIES = 2
# 同一张卡两次复查的最小间隔（含建卡到首次复查的冷却）；手动深挖不受限
RESCAN_COOLDOWN_HOURS = 24.0

# 同题市场实查（TikHub）：B站=纪录片存量+播放数、抖音=短视频消费侧（点赞为
# 热度）、西瓜=长片完整版存量、知乎=同题文章与赞同数（受众兴趣实证）。
# 每簇取证只查一次四平台并发各 5 条（按请求计费，单轮刷新 ≤8 簇 = ≤32 请求）。
# 未配 TIKHUB_API_KEY 时探针为 None，管线照旧（复查管线不实查，保持小预算）。
# 微信搜一搜（维护中）与小红书（需 Token 勾权限）待开通后加入。
MARKET_PROBE_PLATFORMS: tuple[str, ...] = ("bilibili", "douyin", "xigua", "zhihu")
MARKET_PROBE_COUNT = 5
MARKET_PROBE_LABELS: dict[str, str] = {"bilibili": "B站", "douyin": "抖音", "xigua": "西瓜", "zhihu": "知乎"}
# 知乎热榜（讨论热度信号）每次刷新取的条数——已从信号源降级（泛娱乐占比高、
# 快照不稳定），保留方法但默认不进采集矩阵
ZHIHU_HOT_LIMIT = 15
# 知乎沉淀讨论种子：按垂类搜高赞文章/回答——赞同数是"公众已验证兴趣"的
# 沉淀性证据（不追热榜快照，追长期被搜索、被赞同的内容）
ZHIHU_DISCUSSION_SEEDS: dict[str, tuple[str, ...]] = {
    "history": ("近代史 考据", "考古 解读", "历史 冷知识"),
    "crime": ("悬案 真相", "冤案 平反", "刑侦 细节"),
    "humanity": ("普通人的故事", "小城 生活", "职业 真实经历"),
    "science": ("科普 颠覆认知", "宇宙 未解之谜", "人体 冷知识"),
}
# 高赞阈值：低于此赞同数的条目不算"已验证兴趣"（噪声多）
ZHIHU_MIN_VOTES = 100

FLOW_IDS = {
    "triage": "LANGFLOW_TOPIC_TRIAGE_FLOW_ID",
    "plan": "LANGFLOW_TOPIC_PLAN_FLOW_ID",
    "followup": "LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID",
    "verdict": "LANGFLOW_TOPIC_VERDICT_FLOW_ID",
    "rescan_plan": "LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID",
}


def fingerprint_of(title: str) -> str:
    """规范化标题的 sha256，作为池内幂等去重键。"""
    keep = [ch for ch in title.lower() if ch.isalnum()]
    return hashlib.sha256("".join(keep).encode("utf-8")).hexdigest()


def _year_anchor() -> str:
    """种子年份锚：查询词拼上当年年份，避免同一批旧结果反复命中。"""
    return str(date.today().year)


FlowRunner = Callable[[str, str], Awaitable[str]]
SearchFn = Callable[[str], Awaitable[dict[str, Any]]]
# 市场探针：主题词 → 研究日志形态的同题实查条目（label/query/results）
MarketProbeFn = Callable[[str], Awaitable[list[dict[str, Any]]]]


def _fmt_count(value: int | None) -> str:
    """计数格式化：12345 → '1.2万'；None → '—'。"""
    if value is None or value <= 0:
        return "—"
    if value >= 10_000:
        return f"{value / 10_000:.1f}万"
    return str(value)


def _format_market_item(item: dict[str, Any]) -> str:
    parts: list[str] = []
    if item.get("play_count"):
        parts.append(f"播放 {_fmt_count(item['play_count'])}")
    if item.get("like_count"):
        parts.append(f"点赞 {_fmt_count(item['like_count'])}")
    if item.get("author"):
        parts.append(str(item["author"]))
    if item.get("published_at"):
        parts.append(str(item["published_at"]))
    text = " · ".join(parts)
    if item.get("excerpt"):
        text = f"{text}｜{item['excerpt']}" if text else str(item["excerpt"])
    return text


def build_market_probe() -> MarketProbeFn | None:
    """按环境构造同题市场探针；未配 TIKHUB_API_KEY 返回 None（管线照旧）。"""
    api_key = os.environ.get("TIKHUB_API_KEY", "").strip()
    if not api_key:
        return None
    import tikhub

    client = tikhub.TikHubClient(
        api_key=api_key,
        base_url=os.environ.get("TIKHUB_BASE_URL", "").strip() or tikhub.DEFAULT_TIKHUB_BASE_URL,
    )

    async def probe(keyword: str) -> list[dict[str, Any]]:
        outcomes = await asyncio.gather(
            *(client.search_videos(p, keyword, count=MARKET_PROBE_COUNT) for p in MARKET_PROBE_PLATFORMS),
            return_exceptions=True,
        )
        entries: list[dict[str, Any]] = []
        for platform, outcome in zip(MARKET_PROBE_PLATFORMS, outcomes):
            if isinstance(outcome, BaseException):
                logger.warning("同题市场实查失败 platform=%s keyword=%s: %s", platform, keyword[:40], str(outcome)[:150])
                continue
            entries.append(
                {
                    "label": f"同题实查:{MARKET_PROBE_LABELS[platform]}",
                    "query": keyword,
                    "results": [
                        {"title": str(it.get("title") or ""), "url": str(it.get("url") or ""), "snippet": _format_market_item(it)}
                        for it in outcome
                        if str(it.get("title") or "").strip()
                    ],
                }
            )
        return entries

    return probe


@dataclass
class TriagePick:
    """研判短名单的一项：一个主题簇及其价值判断。"""

    members: list[dict[str, Any]]
    member_fingerprints: list[str]
    vertical: str
    theme: str
    reason: str

    @property
    def primary_fingerprint(self) -> str:
        return self.member_fingerprints[0]


@dataclass
class CurateResult:
    """单次策展运行的外部可观测结果。"""

    collected: int = 0
    shortlisted: int = 0
    observed: int = 0
    created: int = 0
    upgraded: int = 0
    error: str = ""


@dataclass
class RescanSummary:
    """一轮观察卡复查的外部可观测结果。"""

    rescanned: int = 0  # 实际复查张数（含证据仍薄与结论失败的）
    upgraded: int = 0  # 证据变硬升级为建议卡的张数


class TopicCurator:
    """策展编排器：材料窗口采集 → flow 研判 → 逐项取证 → flow 结论 → 落库。"""

    def __init__(
        self,
        flow_runner: FlowRunner | None = None,
        search: SearchFn | None = None,
        market_probe: MarketProbeFn | None = None,
    ) -> None:
        # 默认接线：LLM 走 langflow 阻塞调用，检索走文本级联（懒导入，测试注 fake 不触发）；
        # 市场探针未显式注入且配了 key 时才构建（无 key 即 None，实查整段跳过）
        if flow_runner is None:
            import skills

            flow_runner = skills.run_flow_blocking
        if search is None:
            from websearch import web_search

            search = web_search
        if market_probe is None:
            market_probe = build_market_probe()
        self.flow_runner = flow_runner
        self.search = search
        self.market_probe = market_probe

    # --- flow 调用 -----------------------------------------------------------

    def _flow_id(self, key: str) -> str:
        flow_id = os.environ.get(FLOW_IDS[key], "").strip()
        if not flow_id:
            raise RuntimeError(f"未配置 {FLOW_IDS[key]}（选题 {key} flow）")
        return flow_id

    async def _call_flow(self, key: str, payload: dict[str, Any]) -> Any:
        """跑一个选题 flow 并宽容解析 JSON 输出。

        解析失败（LLM 输出坏 JSON，非确定性）原样重试一次再抛；flow 调用
        本身失败（配置/引擎问题，确定性）不重试直接抛。实测曾有 40% 的
        入围线索因单次坏输出被整条丢弃。
        """
        assert self.flow_runner is not None
        last_error: ValueError | None = None
        for attempt in (1, 2):
            text = await self.flow_runner(self._flow_id(key), json.dumps(payload, ensure_ascii=False))
            if text.startswith("（"):
                # skills.run_flow_blocking 的错误以全角括号包裹；正常 LLM 输出不会
                raise RuntimeError(f"选题 {key} flow 调用失败: {text[:200]}")
            try:
                return extract_json(text)
            except ValueError as exc:
                last_error = exc
                logger.warning("选题 %s flow 输出解析失败（第 %d 次）: %s", key, attempt, str(exc)[:200])
        raise RuntimeError(f"选题 {key} flow 输出两次解析失败: {last_error}")

    # --- 采集：五源信号矩阵（材料事件 / 周年 / 已验证内容 / 对标片单） ---------

    async def collect_material_window(self) -> list[dict[str, Any]]:
        """兼容旧测试面：材料事件采集（信号类型 material，按垂类注册表种子）。"""
        seeds = {
            vid: tuple(q.format(year=_year_anchor()) for q in spec.material_seeds)
            for vid, spec in VERTICAL_SPECS.items()
            if spec.material_seeds
        }
        return await self._collect_seed_queries(seeds, signal_type="material")

    async def _collect_seed_queries(
        self, seeds: dict[str | None, tuple[str, ...]], signal_type: str
    ) -> list[dict[str, Any]]:
        """按种子查询搜索并转信号条目；单条种子失败只跳过该条。"""
        if self.search is None:
            return []
        fetched_at = datetime.now(timezone.utc).isoformat()
        items: list[dict[str, Any]] = []
        for vertical, queries in seeds.items():
            for query in queries:
                try:
                    response = await self.search(query)
                except Exception as exc:  # noqa: BLE001 - 采集失败不中断策展
                    logger.warning("信号采集搜索失败 query=%s: %s", query, str(exc)[:200])
                    continue
                for result in response.get("results", [])[:MAX_ITEMS_PER_QUERY]:
                    title = str(result.get("title") or "").strip()
                    if not title:
                        continue
                    items.append(self._signal_of(title, result, source=f"种子:{query}", signal_type=signal_type, vertical_seed=vertical, fetched_at=fetched_at))
        return items

    def _signal_of(
        self,
        title: str,
        result: dict[str, Any],
        *,
        source: str,
        signal_type: str,
        vertical_seed: str | None,
        fetched_at: str,
        platform: str = "web",
        snippet: str = "",
    ) -> dict[str, Any]:
        return {
            "title": title,
            "platform": platform,
            "source": source,
            "url": result.get("url") or "",
            "provider": result.get("provider") or "",
            "vertical_seed": vertical_seed,
            "signal_type": signal_type,
            "snippet": (snippet or str(result.get("snippet") or "")).strip()[:160],
            "fetched_at": fetched_at,
        }

    async def collect_anniversaries(self) -> list[dict[str, Any]]:
        """周年信号（确定性时间信号，零 LLM）：维基大事记 → 逢五逢十 → 提前 45 天进池。

        窗口按起点日期缓存（同一天内多次刷新不重拉维基）。
        """
        import topics as settings_store
        import wikiday

        today = date.today()
        cache = wikiday.load_window_cache(settings_store.get_setting(wikiday.CACHE_KEY))
        events = cache.get("events") if cache and cache.get("start") == today.isoformat() else None
        if events is None:
            events = await wikiday.anniversary_window(start=today, days=ANNIVERSARY_WINDOW_DAYS)
            settings_store.set_setting(wikiday.CACHE_KEY, wikiday.build_window_cache(today, events))
        fetched_at = datetime.now(timezone.utc).isoformat()
        return [
            {
                "title": f"{e['text']}（{e['age']}周年，{e['date']}）",
                "platform": "calendar",
                "source": f"周年节点:{e['date']}",
                "url": "",
                "provider": "wikipedia",
                "vertical_seed": None,
                "signal_type": "anniversary",
                "snippet": f"{e['age']}周年节点：{e['text']}",
                "fetched_at": fetched_at,
            }
            for e in events
        ]

    async def collect_validated_content(self) -> list[dict[str, Any]]:
        """已验证内容信号：特稿镜像（搜索）+ 叙事播客（RSS），故事性已验证。"""
        items = await self._collect_seed_queries(
            {None: tuple(q.format(year=_year_anchor()) for q in VALIDATED_SEED_QUERIES)},
            signal_type="validated",
        )
        try:
            import podcastfeed

            episodes = await podcastfeed.fetch_all_feeds()
        except Exception as exc:  # noqa: BLE001 - 播客源失败不拖累特稿信号
            logger.warning("播客信号采集失败: %s", str(exc)[:200])
            episodes = []
        fetched_at = datetime.now(timezone.utc).isoformat()
        items.extend(
            self._signal_of(
                ep["title"],
                {"url": ep["url"], "snippet": ep["snippet"], "provider": "rss"},
                source=f"播客:{ep['feed']}",
                signal_type="validated",
                vertical_seed=None,
                fetched_at=fetched_at,
                platform="podcast",
            )
            for ep in episodes
        )
        return items

    async def collect_benchmarks(self) -> list[dict[str, Any]]:
        """对标片单信号：节展/海外已验证题材 → 国产化空白。"""
        return await self._collect_seed_queries(
            {None: tuple(q.format(year=_year_anchor()) for q in BENCHMARK_SEED_QUERIES)},
            signal_type="benchmark",
        )

    async def collect_zhihu_discussions(self) -> list[dict[str, Any]]:
        """知乎沉淀讨论信号：按垂类种子搜高赞文章/回答（TikHub，1 种子 1 请求）。

        赞同数 ≥ ZHIHU_MIN_VOTES 才算"公众已验证兴趣"——收的是长期沉淀的
        内容（谁在搜、什么被顶上去），不是热榜快照。归 validated：研判判断
        纪录片化增量，纯段子/复述无材料纵深的不入围。
        """
        api_key = os.environ.get("TIKHUB_API_KEY", "").strip()
        if not api_key:
            return []
        import tikhub

        client = tikhub.TikHubClient(
            api_key=api_key,
            base_url=os.environ.get("TIKHUB_BASE_URL", "").strip() or tikhub.DEFAULT_TIKHUB_BASE_URL,
        )
        fetched_at = datetime.now(timezone.utc).isoformat()
        signals: list[dict[str, Any]] = []
        for vertical, keywords in ZHIHU_DISCUSSION_SEEDS.items():
            for keyword in keywords:
                try:
                    articles = await client.search_videos("zhihu", keyword, count=10)
                except Exception as exc:  # noqa: BLE001 - 单种子失败不拖累
                    logger.warning("知乎讨论搜索失败 keyword=%s: %s", keyword, str(exc)[:150])
                    continue
                for art in articles:
                    votes = art.get("like_count") or 0
                    if votes < ZHIHU_MIN_VOTES:
                        continue
                    signals.append(
                        {
                            "title": str(art["title"]),
                            "platform": "zhihu",
                            "source": f"知乎高赞:{keyword}",
                            "url": art.get("url") or "",
                            "provider": "tikhub",
                            "vertical_seed": vertical,
                            "signal_type": "validated",
                            "snippet": f"赞同 {votes}｜{(art.get('excerpt') or '')[:100]}",
                            "fetched_at": fetched_at,
                        }
                    )
        return signals

    async def collect_signals(self) -> list[dict[str, Any]]:
        """聚合五源信号（材料/周年/已验证内容/对标/知乎高赞讨论）；全部失败才返回空。"""
        material, anniversary, validated, benchmark, zhihu = await asyncio.gather(
            self.collect_material_window(),
            self.collect_anniversaries(),
            self.collect_validated_content(),
            self.collect_benchmarks(),
            self.collect_zhihu_discussions(),
        )
        return material + anniversary + validated + benchmark + zhihu

    # --- 主流程 ---------------------------------------------------------------

    async def run(self) -> CurateResult:
        result = CurateResult()
        items = await self.collect_signals()
        result.collected = len(items)
        if not items:
            result.error = "信号采集为零条（搜索通道全部失败或无结果）"
            return result

        picks = (await self._triage(items))[:MAX_CARDS_PER_REFRESH]
        result.shortlisted = len(picks)
        if not picks:
            result.error = "研判未入围任何线索"
            return result

        for pick in picks:
            research_log = await self._research_candidate(pick)
            card = await self._generate_card(pick, research_log)
            if card is None:
                continue
            try:
                upgradable_id = store.find_upgradable_by_any_fingerprint(pick.member_fingerprints)
                if upgradable_id is not None:
                    # 已在池中：观察卡遇到证据变硬的建议卡时升级，其余保持
                    if card["worth_it"]:
                        store.upgrade_card(
                            upgradable_id,
                            title=card["title"],
                            summary=card["summary"],
                            angles=card["angles"],
                            research=card["research"],
                        )
                        result.upgraded += 1
                        logger.info("选题池观察卡升级 theme=%s", pick.theme[:50])
                    continue
                if store.exists_by_any_fingerprint(pick.member_fingerprints):
                    continue
                store.create_topic(
                    vertical=pick.vertical,
                    title=card["title"],
                    title_fingerprint=pick.primary_fingerprint,
                    summary=card["summary"],
                    angles=card["angles"],
                    heat_evidence=[_evidence_of(item) for item in pick.members],
                    research=card["research"],
                    source=str(pick.members[0].get("signal_type") or "material"),
                )
                if card["worth_it"]:
                    result.created += 1
                else:
                    result.observed += 1
            except Exception as exc:  # noqa: BLE001 - 唯一约束冲突/单卡落库失败不拖累其余
                logger.info("选题池落库跳过 fingerprint=%s: %s", pick.primary_fingerprint[:12], str(exc)[:120])
        return result

    # --- 研判：全量条目 → 聚类 + 垂类 + 价值排序的短名单 ---------------------

    async def _triage(self, items: list[dict[str, Any]]) -> list[TriagePick]:
        """LLM 全量研判；整批调用失败时对半拆开重试一轮，保住本轮产出。"""
        capped = items[:TRIAGE_ITEMS_CAP]
        picks = await self._triage_call(capped)
        if picks is None:
            logger.warning("选题池研判整批失败，降级为对半分批研判")
            picks = []
            midpoint = len(capped) // _TRIAGE_SPLIT
            for chunk in (capped[:midpoint], capped[midpoint:]):
                chunk_picks = await self._triage_call(chunk)
                if chunk_picks is not None:
                    picks.extend(chunk_picks)
        return picks

    async def _triage_call(self, items: list[dict[str, Any]]) -> list[TriagePick] | None:
        """一次研判调用；失败返回 None 由调用方决定降级。"""
        listing = [
            {
                "index": idx,
                "title": item["title"],
                "platform": item["platform"],
                "source": item["source"],
                "signal_type": item.get("signal_type") or "material",
                "snippet": item.get("snippet") or "",
            }
            for idx, item in enumerate(items)
        ]
        try:
            raw_picks = await self._call_flow("triage", {"listing": listing, "verticals": verticals_payload()})
        except Exception as exc:  # noqa: BLE001 - 研判失败降级分批
            logger.warning("选题池研判调用失败: %s", str(exc)[:200])
            return None
        picks: list[TriagePick] = []
        if not isinstance(raw_picks, list):
            return picks
        for raw in raw_picks:
            pick = _pick_of(raw, items)
            if pick is not None:
                picks.append(pick)
        return picks

    # --- 调研：LLM 规划的迭代取证 + 证据驱动的两级结论 -----------------------------

    async def _research_candidate(self, pick: TriagePick) -> list[dict[str, Any]]:
        """LLM 规划的迭代调研：计划查询 → 并行检索 → 看结果决定是否追查一轮。

        规划失败按零证据处理（结论自然降为观察）；查了什么、查到什么全程留痕。
        """
        if self.search is None:
            return []
        hot_title = pick.members[0]["title"]
        plan = await self._plan_queries(
            "plan",
            {"title": hot_title, "theme": pick.theme, "reason": pick.reason},
            RESEARCH_PLAN_MAX_QUERIES,
        )
        if not plan:
            return []
        log = await execute_queries(self.search, plan)

        followup = await self._plan_queries(
            "followup",
            {"title": hot_title, "log": _format_research_log(log)},
            RESEARCH_FOLLOWUP_MAX_QUERIES,
        )
        if followup:
            log.extend(await execute_queries(self.search, followup))

        # 同题市场实查：真实播放计数进证据包，让结论的"对家与差异"有实证
        if self.market_probe is not None:
            try:
                log.extend(await self.market_probe(pick.theme))
            except Exception as exc:  # noqa: BLE001 - 实查失败不拖累文字取证
                logger.warning("同题市场实查失败 theme=%s: %s", pick.theme[:50], str(exc)[:200])
        return log

    async def _plan_queries(self, key: str, payload: dict[str, Any], max_queries: int) -> list[dict[str, str]]:
        """一次 LLM 查询规划调用；输出 [{label, query}]，失败/坏输出/done 返回空。"""
        try:
            raw = await self._call_flow(key, payload)
        except Exception as exc:  # noqa: BLE001 - 规划失败按零查询处理
            logger.warning("选题池调研规划失败(%s): %s", key, str(exc)[:200])
            return []
        if isinstance(raw, dict) and raw.get("done") is True:
            return []
        queries: list[dict[str, str]] = []
        if isinstance(raw, list):
            for item in raw[:max_queries]:
                if not isinstance(item, dict):
                    continue
                label = str(item.get("label") or "").strip()
                query = str(item.get("query") or "").strip()
                if label and query:
                    queries.append({"label": label, "query": query})
        return queries

    async def _generate_card(
        self,
        pick: TriagePick,
        research_log: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """一次 verdict 调用产出证据驱动的两级结论；解析失败跳过该线索。"""
        try:
            card_raw = await self._call_flow(
                "verdict",
                {
                    "theme": pick.theme,
                    "reason": pick.reason,
                    "title": pick.members[0]["title"],
                    "priorContext": "",
                    "evidencePack": _format_research_log(research_log, with_empty_hint=True),
                },
            )
        except Exception as exc:  # noqa: BLE001 - 单项失败不影响其它线索
            logger.warning("选题池调研结论生成失败 theme=%s: %s", pick.theme[:50], str(exc)[:200])
            return None
        return parse_verdict(card_raw, pick.members[0]["title"], research_log)

    # --- 观察卡复查：冲着立项缺口去查，证据变硬就升级 -------------------------

    async def rescan_observations(self, limit: int = RESCAN_BATCH_SIZE) -> RescanSummary:
        """轮转复查最久未扫的观察卡（每轮刷新尾部顺带跑，与主策展同锁内串行）。"""
        summary = RescanSummary()
        if self.search is None:
            return summary  # 未配置检索就没有"盯"的能力，不空转 LLM
        if not os.environ.get(FLOW_IDS["rescan_plan"], "").strip():
            logger.warning("未配置 %s，本轮跳过观察卡复查", FLOW_IDS["rescan_plan"])
            return summary
        for topic in store.list_rescan_candidates(limit, cooldown_hours=RESCAN_COOLDOWN_HOURS):
            try:
                outcome = await self.rescan_one(topic)
            except Exception as exc:  # noqa: BLE001 - 单张失败不拖累整批
                logger.warning(
                    "选题池观察卡复查失败 title=%s: %s", str(topic.get("title", ""))[:50], str(exc)[:200]
                )
                try:
                    store.mark_rescanned(str(topic["id"]))
                except Exception:  # noqa: BLE001
                    logger.exception("选题池复查标记失败 topic=%s", topic.get("id"))
                outcome = "failed"
            summary.rescanned += 1
            if outcome == "upgraded":
                summary.upgraded += 1
        return summary

    async def rescan_one(self, topic: dict[str, Any]) -> str:
        """单张观察卡的缺口导向复查；返回 upgraded / thin / failed（failed 也记扫描）。"""
        topic_id = str(topic["id"])
        if topic_id in _rescan_inflight:
            return "busy"
        _rescan_inflight.add(topic_id)
        try:
            return await self._rescan_one(topic)
        finally:
            _rescan_inflight.discard(topic_id)

    async def _rescan_one(self, topic: dict[str, Any]) -> str:
        topic_id = str(topic["id"])
        research = topic.get("research") or {}
        title = str(topic["title"])
        event = str(research.get("event") or "").strip()
        gaps = [str(g).strip() for g in research.get("gaps") or [] if str(g).strip()]
        observation = str(research.get("observation") or "").strip()
        if not gaps:
            gaps = ["事件事实与材料入口复核"]  # 旧卡缺口缺失时的兜底复查方向

        plan = await self._plan_queries(
            "rescan_plan",
            {"title": title, "event": event or "（无）", "gaps": gaps, "observation": observation or "（无）"},
            RESCAN_PLAN_MAX_QUERIES,
        )
        log = await execute_queries(self.search, plan) if plan else []
        if log:
            followup = await self._plan_queries(
                "followup",
                {"title": title, "log": _format_research_log(log)},
                RESCAN_FOLLOWUP_MAX_QUERIES,
            )
            if followup:
                log.extend(await execute_queries(self.search, followup))

        card = await self._rescan_verdict(title, gaps, observation, log)
        if card is not None and card["worth_it"]:
            store.upgrade_card(
                topic_id,
                title=card["title"],
                summary=card["summary"],
                angles=card["angles"],
                research=card["research"],
            )
            logger.info("选题池观察卡复查升级 title=%s", title[:50])
            return "upgraded"
        if card is None:
            store.mark_rescanned(topic_id)  # 结论失败也记扫描：坏卡不卡住轮转队列
            return "failed"
        store.record_rescan(topic_id, log)  # 仍薄：信源底账追加，观察内容原地保留
        return "thin"

    async def _rescan_verdict(
        self,
        title: str,
        gaps: list[str],
        observation: str,
        log: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """复查结论复用初扫的 verdict 纪律；多给一段"先前观察"上下文，失败返回 None。"""
        prior_context = (
            "先前观察（本次为复查）：\n"
            f"- 观察结论：{observation or '（无）'}\n"
            f"- 立项缺口：{'；'.join(gaps)}\n"
            "本次复查重点：上面的缺口是否已被补上；新证据优先，旧结论里查无实据的部分维持不写。"
        )
        try:
            card_raw = await self._call_flow(
                "verdict",
                {
                    "theme": title,
                    "reason": "观察卡复查：先前的立项缺口是否已被补上",
                    "title": title,
                    "priorContext": prior_context,
                    "evidencePack": _format_research_log(log, with_empty_hint=True),
                },
            )
        except Exception as exc:  # noqa: BLE001 - 结论失败按仍不足处理
            logger.warning("选题池复查结论生成失败 title=%s: %s", title[:50], str(exc)[:200])
            return None
        return parse_verdict(card_raw, title, log)


async def execute_queries(search: SearchFn, queries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """并行执行一批查询；单条失败记空结果，不拖累整批。"""
    results = await asyncio.gather(
        *(search_one(search, query["query"]) for query in queries), return_exceptions=True
    )
    log: list[dict[str, Any]] = []
    for query, result in zip(queries, results):
        if isinstance(result, BaseException):
            logger.warning("选题池取证检索失败 query=%s: %s", query["query"], str(result)[:200])
            result = []
        log.append({"label": query["label"], "query": query["query"], "results": result})
    return log


async def search_one(search: SearchFn, query: str) -> list[dict[str, str]]:
    response = await search(query)
    return [
        {
            "title": str(r.get("title") or "").strip(),
            "url": str(r.get("url") or ""),
            "snippet": str(r.get("snippet") or "").strip(),
        }
        for r in response.get("results", [])[:RESEARCH_RESULTS_CAP]
        if str(r.get("title") or "").strip()
    ]


def parse_verdict(
    card_raw: Any,
    fallback_title: str,
    research_log: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """把 verdict JSON 规整为 {worth_it, title, summary, angles, research}。

    建议卡自称证据充分却给不出题目与角度：降为观察也不硬凑。观察卡沿用
    热点原文作题目（不编片名），认领/列表仍可用。坏输出返回 None。
    """
    if not isinstance(card_raw, dict):
        return None
    worth_it = str(card_raw.get("evidence_level", "")).strip().lower() == "strong"
    title = str(card_raw.get("title") or "").strip()
    summary = str(card_raw.get("summary") or card_raw.get("observation") or "").strip()
    raw_angles = card_raw.get("angles")
    angles = [str(a).strip() for a in raw_angles if str(a).strip()] if isinstance(raw_angles, list) else []
    unit_kind = str(card_raw.get("unit_kind") or "").strip().lower()
    viewing_question = str(card_raw.get("viewing_question") or "").strip()
    scale = str(card_raw.get("scale") or "").strip().lower()
    series_thread = str(card_raw.get("series_thread") or "").strip()
    # 爆款两把尺子（flow 输出新维度）：跟拍谁 + 观众为什么在意
    person_anchor = str(card_raw.get("person_anchor") or "").strip()
    emotion = str(card_raw.get("emotion") or "").strip()
    if scale not in SCALES:
        scale = "single"
    if scale == "series" and not series_thread:
        scale = "single"  # 没有串珠问题假设的系列是错觉，诚实地按单片
        series_thread = ""
    # 建议卡上架守卫：缺可拍单元或观看问题的卡与新闻卡无异，降为观察
    if worth_it and (not title or not angles or unit_kind not in UNIT_KINDS or not viewing_question):
        worth_it = False
        title = ""
        angles = []
    raw_gaps = card_raw.get("gaps")
    gaps = [str(g).strip() for g in raw_gaps if str(g).strip()] if isinstance(raw_gaps, list) else []
    research: dict[str, Any] = {
        "evidence_level": "strong" if worth_it else "thin",
        "event": str(card_raw.get("event") or "").strip(),
        "why_now": str(card_raw.get("why_now") or "").strip(),
        "material_base": str(card_raw.get("material_base") or "").strip(),
        "competition_gap": str(card_raw.get("competition_gap") or "").strip(),
        "gaps": gaps,
        "source_map": research_log,
    }
    if emotion:
        research["emotion"] = emotion
    if person_anchor:
        research["person_anchor"] = person_anchor
    if worth_it:
        research["unit_kind"] = unit_kind
        research["viewing_question"] = viewing_question
        research["scale"] = scale
        if series_thread:
            research["series_thread"] = series_thread
    return {
        "worth_it": worth_it,
        "title": title or fallback_title,
        "summary": summary,
        "angles": angles[:3],
        "research": research,
    }


def _pick_of(raw: Any, items: list[dict[str, Any]]) -> TriagePick | None:
    """解析研判输出的一项：成员序号合法、垂类合法才成簇。"""
    if not isinstance(raw, dict):
        return None
    vertical = str(raw.get("vertical", "")).strip().lower()
    theme = str(raw.get("theme") or "").strip()
    if vertical not in VERTICALS or not theme:
        return None
    raw_members = raw.get("members")
    if not isinstance(raw_members, list):
        return None
    members: list[dict[str, Any]] = []
    fingerprints: list[str] = []
    for index in raw_members:
        if not isinstance(index, int) or not 0 <= index < len(items):
            continue
        item = items[index]
        fingerprint = fingerprint_of(item["title"])
        if fingerprint in fingerprints:
            continue
        members.append(item)
        fingerprints.append(fingerprint)
    if not members:
        return None
    return TriagePick(
        members=members,
        member_fingerprints=fingerprints,
        vertical=vertical,
        theme=theme,
        reason=str(raw.get("reason") or "").strip(),
    )


def _format_research_log(log: list[dict[str, Any]], *, with_empty_hint: bool = False) -> str:
    """把调研记录（标签/查询/结果）格式化为 prompt 段落或快照文本。"""
    if not log:
        return "（未执行任何检索）" if with_empty_hint else ""
    lines: list[str] = []
    for entry in log:
        label = str(entry.get("label", ""))
        query = str(entry.get("query", ""))
        lines.append(f"【{label}｜查询：{query}】")
        results = entry.get("results") or []
        if not results:
            lines.append("（未检索到）")
            continue
        lines.extend(
            f"- {str(item.get('title', ''))}｜{str(item.get('snippet', ''))} {str(item.get('url', ''))}".strip()
            for item in results
        )
    return "\n".join(lines)


def _evidence_of(item: dict[str, Any]) -> dict[str, Any]:
    """热度依据：保留信号原文标题、来源渠道与原始链接，供核对与展示。"""
    return {
        "title": item["title"],
        "platform": item["platform"],
        "source": item["source"],
        "signal_type": item.get("signal_type") or "material",
        "url": item.get("url") or "",
        "provider": item.get("provider") or "",
        "fetched_at": item.get("fetched_at"),
    }


def extract_json(text: str) -> Any:
    """宽容解析 LLM 输出的 JSON（剥离代码围栏与前后缀文字）。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[-1]
        stripped = stripped.rsplit("```", 1)[0]
    starts = [i for i in (stripped.find("["), stripped.find("{")) if i >= 0]
    if not starts:
        raise ValueError(f"no JSON found in LLM output: {text[:100]}")
    start = min(starts)
    end = max(stripped.rfind("]"), stripped.rfind("}"))
    if end <= start:
        raise ValueError(f"unbalanced JSON in LLM output: {text[:100]}")
    return json.loads(stripped[start : end + 1])


# ---------- 刷新编排：单飞 + 后台任务 + 结果落 settings ----------

RUN_STATE_KEY = "topic_pool_run_state"  # 刷新运行态标记（服务重启后被杀可被检测）


class TopicRefreshService:
    """选题池刷新服务：单飞守卫 + 后台 asyncio 任务 + 结果持久化。"""

    def __init__(self, curator: TopicCurator | None = None) -> None:
        self.curator = curator or TopicCurator()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[CurateResult] | None = None

    @property
    def refreshing(self) -> bool:
        return self._lock.locked()

    def last_run(self) -> dict[str, Any]:
        raw = store.get_setting("topic_pool_last_run")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def start(self) -> bool:
        """启动一次刷新；已有刷新在跑时返回 False（单飞）。"""
        if self._lock.locked():
            return False
        # 运行态落账先于任务启动：服务重启杀任务后可检测出"被中断"
        store.set_setting(RUN_STATE_KEY, json.dumps({"startedAt": datetime.now(timezone.utc).isoformat()}))
        self._task = asyncio.create_task(self._run())
        return True

    async def _run(self) -> CurateResult:
        try:
            async with self._lock:
                result = await self.curator.run()
                # 刷新尾部顺带轮转复查观察卡（锁内串行，防与手动深挖同卡双跑）
                try:
                    rescan = await self.curator.rescan_observations()
                except Exception:  # noqa: BLE001 - 复查失败不拖累主刷新的结果记录
                    logger.exception("选题池观察卡轮转复查失败")
                    rescan = RescanSummary()
            store.archive_stale(90)
            store.set_setting(
                "topic_pool_last_run",
                json.dumps(
                    {
                        "finishedAt": datetime.now(timezone.utc).isoformat(),
                        "rescanned": rescan.rescanned,
                        "rescanUpgraded": rescan.upgraded,
                        **result.__dict__,
                    },
                    ensure_ascii=False,
                ),
            )
            return result
        finally:
            store.set_setting(RUN_STATE_KEY, "")

    def report_interrupted_run(self) -> None:
        """启动期检测：上轮刷新留有运行态标记 = 被服务重启杀掉，把中断落进 last_run。

        只在标记晚于 lastRun.finishedAt 时记（更早的标记属于已正常完成的旧轮）。
        """
        raw = store.get_setting(RUN_STATE_KEY)
        if not raw:
            return
        try:
            state = json.loads(raw)
        except json.JSONDecodeError:
            store.set_setting(RUN_STATE_KEY, "")
            return
        started_at = str(state.get("startedAt") or "")
        last = self.last_run()
        already = max(str(last.get("finishedAt") or ""), str(last.get("interruptedAt") or ""))
        if started_at and started_at > already:
            last["interruptedAt"] = started_at
            last["error"] = f"刷新于 {started_at} 被中断（服务重启），本轮产出可能不完整"
            last.pop("finishedAt", None)
            store.set_setting("topic_pool_last_run", json.dumps(last, ensure_ascii=False))
            logger.warning("检测到被中断的选题池刷新：startedAt=%s", started_at)
        store.set_setting(RUN_STATE_KEY, "")


SERVICE = TopicRefreshService()

# 手动深挖/自动轮转共用：正在复查的观察卡 id（防同卡双跑，跨两条路径互斥）
_rescan_inflight: set[str] = set()


# ---------- 手动深挖：单卡复查异步任务（jobId 轮询，先例 imgresearch.REF_JOBS） ----------

RESCAN_JOBS: dict[str, dict[str, Any]] = {}


def start_rescan_job(topic: dict[str, Any]) -> str | None:
    """启动单卡深挖任务；该卡已有复查在跑时返回 None。"""
    topic_id = str(topic["id"])
    if topic_id in _rescan_inflight:
        return None
    job_id = uuid.uuid4().hex[:12]
    RESCAN_JOBS[job_id] = {
        "jobId": job_id,
        "topicId": topic_id,
        "status": "running",
        "outcome": "",
        "error": "",
    }
    task = asyncio.create_task(_run_rescan_job(job_id, topic))
    _prune_rescan_jobs(task)
    return job_id


async def _run_rescan_job(job_id: str, topic: dict[str, Any]) -> None:
    job = RESCAN_JOBS.get(job_id)
    if job is None:
        return
    try:
        job["outcome"] = await SERVICE.curator.rescan_one(topic)
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 - 任务结果如实上报
        job["status"] = "error"
        job["error"] = str(exc)[:300]
        logger.exception("选题池手动深挖失败 topic=%s", str(topic.get("title", ""))[:50])


def _prune_rescan_jobs(task: asyncio.Task) -> None:
    def _cleanup(t: asyncio.Task) -> None:
        done = [k for k, v in RESCAN_JOBS.items() if v["status"] in ("done", "error")]
        if len(done) > 50:
            for key in done[:-50]:
                RESCAN_JOBS.pop(key, None)

    task.add_done_callback(_cleanup)


def get_rescan_job(job_id: str) -> dict[str, Any] | None:
    return RESCAN_JOBS.get(job_id)


# ---------- 每日定时刷新（进程内调度，开关/时刻走 app_settings） ----------

AUTO_REFRESH_KEY = "topic_pool_auto_refresh"  # JSON {"enabled": bool, "time": "HH:MM"}
AUTO_REFRESH_LAST_DATE_KEY = "topic_pool_last_auto_run"  # "YYYY-MM-DD"，防重启后当天重复触发


def get_auto_refresh() -> dict[str, Any]:
    cfg: dict[str, Any] = {"enabled": False, "time": "08:00"}
    raw = store.get_setting(AUTO_REFRESH_KEY)
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return cfg
        if isinstance(parsed, dict):
            cfg["enabled"] = bool(parsed.get("enabled"))
            cfg["time"] = str(parsed.get("time") or cfg["time"])
    return cfg


def set_auto_refresh(*, enabled: bool, time: str) -> dict[str, Any]:
    if not _valid_hhmm(time):
        raise ValueError("time 必须是 HH:MM（24 小时制）")
    cfg = {"enabled": bool(enabled), "time": time}
    store.set_setting(AUTO_REFRESH_KEY, json.dumps(cfg, ensure_ascii=False))
    return cfg


def _valid_hhmm(value: str) -> bool:
    if len(value) != 5 or value[2] != ":":
        return False
    hh, mm = value[:2], value[3:]
    return hh.isdigit() and mm.isdigit() and int(hh) <= 23 and int(mm) <= 59


def auto_refresh_tick(service: TopicRefreshService | None = None) -> str:
    """单次调度判定：开关开、当天未跑、已到点 → 触发一轮策展。

    返回 'fired' / 'skipped' / 'idle'。错过点（agent 重启晚于设定时刻）当天
    仍会补跑一次；与手动刷新撞车时下一分钟重试，当天仍会补上。
    """
    service = service or SERVICE
    cfg = get_auto_refresh()
    if not cfg["enabled"]:
        return "idle"
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    if store.get_setting(AUTO_REFRESH_LAST_DATE_KEY) == today:
        return "skipped"
    if now.strftime("%H:%M") < cfg["time"]:
        return "skipped"
    if not service.start():
        return "skipped"  # 已有刷新在跑：日期不落账，下一分钟重试
    store.set_setting(AUTO_REFRESH_LAST_DATE_KEY, today)
    logger.info("选题池每日定时刷新已触发")
    return "fired"


async def auto_refresh_loop(interval_seconds: float = 60.0) -> None:
    """常驻调度循环：每分钟判定一次，自身异常只记日志不禁用。"""
    while True:
        try:
            auto_refresh_tick()
        except Exception:  # noqa: BLE001
            logger.exception("选题池定时刷新调度异常")
        await asyncio.sleep(interval_seconds)
