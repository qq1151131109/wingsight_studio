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
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import topics as store

logger = logging.getLogger(__name__)

VERTICALS: tuple[str, ...] = ("history", "crime")
VERTICAL_LABELS: dict[str, str] = {"history": "历史", "crime": "罪案"}

# 单次刷新产出的选题卡上限（控制 LLM 与检索成本，宁少勿滥）
MAX_CARDS_PER_REFRESH = 8
# 研判调用喂入的原始条目上限（超出截断）
TRIAGE_ITEMS_CAP = 200
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

# 每垂类固定材料事件种子（只收"材料事件"：新出土/新公布/新判决/新研究/
# 新档案解密；泛事件舆情只产新闻卡，不收）
MATERIAL_SEED_QUERIES: dict[str, tuple[str, ...]] = {
    "history": ("考古新发现", "出土简牍 整理公布", "历史档案 解密公开", "史学研究 新成果 出版"),
    "crime": ("悬案旧案重审", "再审改判 案件", "判决文书 公开 案件", "案件档案 解密"),
}

# 观察卡复查（兑现"证据变硬时自动升级"的承诺）：每轮刷新尾部顺带取最久
# 未扫的几张薄卡做缺口导向小预算复查；也支持单卡手动深挖（异步任务）。
RESCAN_BATCH_SIZE = 3
RESCAN_PLAN_MAX_QUERIES = 3
RESCAN_FOLLOWUP_MAX_QUERIES = 2
# 同一张卡两次复查的最小间隔（含建卡到首次复查的冷却）；手动深挖不受限
RESCAN_COOLDOWN_HOURS = 24.0

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


FlowRunner = Callable[[str, str], Awaitable[str]]
SearchFn = Callable[[str], Awaitable[dict[str, Any]]]


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
    ) -> None:
        # 默认接线：LLM 走 langflow 阻塞调用，检索走文本级联（懒导入，测试注 fake 不触发）
        if flow_runner is None:
            import skills

            flow_runner = skills.run_flow_blocking
        if search is None:
            from websearch import web_search

            search = web_search
        self.flow_runner = flow_runner
        self.search = search

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

    # --- 采集 ----------------------------------------------------------------

    async def collect_material_window(self) -> list[dict[str, Any]]:
        """材料窗口源：按垂类种子查询搜索，结果标题转原始条目。

        单条种子查询失败只跳过该条（多源采集的既有语义），全部失败时
        collected=0 由上层如实报错。
        """
        if self.search is None:
            return []
        fetched_at = datetime.now(timezone.utc).isoformat()
        items: list[dict[str, Any]] = []
        for vertical, seeds in MATERIAL_SEED_QUERIES.items():
            for query in seeds:
                try:
                    response = await self.search(query)
                except Exception as exc:  # noqa: BLE001 - 采集失败不中断策展
                    logger.warning("材料窗口搜索失败 query=%s: %s", query, str(exc)[:200])
                    continue
                for result in response.get("results", [])[:MAX_ITEMS_PER_QUERY]:
                    title = str(result.get("title") or "").strip()
                    if not title:
                        continue
                    items.append(
                        {
                            "title": title,
                            "platform": "web",
                            "source": f"材料窗口:{query}",
                            "url": result.get("url") or "",
                            "provider": result.get("provider") or "",
                            "vertical_seed": vertical,
                            "fetched_at": fetched_at,
                        }
                    )
        return items

    # --- 主流程 ---------------------------------------------------------------

    async def run(self) -> CurateResult:
        result = CurateResult()
        items = await self.collect_material_window()
        result.collected = len(items)
        if not items:
            result.error = "材料窗口采集为零条（搜索通道全部失败或无结果）"
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
                    source="material",
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
            }
            for idx, item in enumerate(items)
        ]
        try:
            raw_picks = await self._call_flow("triage", {"listing": listing})
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
        self._task = asyncio.create_task(self._run())
        return True

    async def _run(self) -> CurateResult:
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
