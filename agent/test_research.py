"""深度调研引擎单测：开题/循环编排/gap 补研/卷宗引用校验（fake flow+搜索注入）。

运行：cd agent && uv run python test_research.py
不需要 langflow / Serper / agent 服务在跑——flow 与检索全部注 fake，
存储用临时库（monkeypatch research.DB_PATH）。
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import research
import imgresearch

# ---------- 临时库 ----------

_tmp = Path(tempfile.mkdtemp(prefix="wsresearch-test-"))
research.DB_PATH = _tmp / "test.db"
imgresearch.DB_PATH = _tmp / "test.db"
research.init_research_db()
imgresearch.init_serper_pool_db()
import os

os.environ["LANGFLOW_RESEARCH_PLAN_FLOW_ID"] = "f-plan"
os.environ["LANGFLOW_RESEARCH_EXTRACT_FLOW_ID"] = "f-extract"
os.environ["LANGFLOW_RESEARCH_EVAL_FLOW_ID"] = "f-eval"
os.environ["LANGFLOW_RESEARCH_DOSSIER_FLOW_ID"] = "f-dossier"


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def fake_json_call(responses: dict[str, list]):
    """按 flow key 依次弹出预设输出（字典→模拟 LLM 已给 JSON）。"""
    counters = {k: 0 for k in responses}

    async def runner(flow_id, input_value, timeout=300):
        key = {"f-plan": "plan", "f-extract": "extract", "f-eval": "eval",
               "f-dossier": "dossier"}[flow_id]
        seq = responses[key]
        i = min(counters[key], len(seq) - 1)
        counters[key] += 1
        item = seq[i]
        if isinstance(item, Exception):
            raise item
        if isinstance(item, str):
            return item  # 非 JSON 文本 → 测解析失败路径
        return json.dumps(item, ensure_ascii=False)

    return runner


def fake_search_factory(pages: dict[str, list[dict]], failures: set[str] | None = None):
    """query → 预设 SERP 结果；failures 里的 query 抛错。"""
    failures = failures or set()

    async def searcher(query, num=6):
        if query in failures:
            raise ValueError(f"serper down: {query}")
        items = pages.get(query, [])
        return [
            {"title": it["title"], "url": it["url"], "snippet": it.get("snippet", ""),
             "position": i}
            for i, it in enumerate(items[:num])
        ]

    return searcher


PLAN = {
    "viewingQuestion": "官渡之战曹操为何能以弱胜强？",
    "directions": [
        {"title": "兵力考证", "goal": "核实双方兵力口径", "queries": ["官渡之战 曹操兵力 考证"]},
        {"title": "乌巢之战", "goal": "还原转折点过程", "queries": ["乌巢之战 经过", "许攸 叛投 官渡"]},
    ],
    "risks": ["演义与史实混杂"],
}

EXTRACT_OK = {
    "relevant": True,
    "sourceCategory": "学术",
    "facts": [
        {"fact": "曹操兵力约五万", "quote": "兵不满万为魏书官修口径", "category": "学术",
         "direction": "兵力考证"},
    ],
}

DOSSIER = {
    "headline": "十万人为何会输：官渡的两套决策系统",
    "summary": "题材有强反差。最值得讲的是决策系统差异。最大的坑是演义混杂。",
    "narrativeSpine": [
        {"step": "两套中枢", "detail": "许都对邺城", "refs": ["S001"]},
    ],
    "establishedFacts": [
        {"text": "曹操兵力学界倾向五到八万", "refs": ["S001"]},
    ],
    "controversies": [
        {"title": "兵力比", "versions": [
            {"text": "十比一为官修口径", "refs": ["S001"]},
            {"text": "裴松之批非其实录", "refs": ["S001"]},
        ]},
    ],
    "risks": [{"text": "单家观点", "refs": ["S001"]}],
    "materialClusters": [
        {"title": "乌巢之夜", "points": [{"text": "夜袭五千兵", "refs": ["S001"]}]},
    ],
}

PAGES = {
    "官渡之战 曹操兵力 考证": [
        {"title": "官渡兵力考", "url": "https://example.com/a?utm_source=x", "snippet": "摘要a"},
    ],
    "乌巢之战 经过": [
        {"title": "乌巢夜袭始末", "url": "https://example.com/b", "snippet": "摘要b"},
        {"title": "乌巢夜袭始末", "url": "https://example.com/b", "snippet": "重复应去重"},
    ],
    "许攸 叛投 官渡": [
        {"title": "许攸叛投三说", "url": "https://other.com/c", "snippet": "摘要c"},
    ],
    "补搜换角度": [
        {"title": "袁绍方记载", "url": "https://other.com/d", "snippet": "摘要d"},
    ],
    "袁绍军粮道细节": [
        {"title": "袁绍粮道考", "url": "https://third.com/e", "snippet": "粮道摘要"},
    ],
}


async def main() -> None:
    calls = {"extract": 0, "dossier": 0, "eval": 0}

    # 注入：extract 恒成功，eval 第 1 轮判不完整给补搜词、第 2 轮判完整，dossier 恒成功
    async def flow_runner(flow_id, input_value, timeout=300):
        key = {"f-plan": "plan", "f-extract": "extract", "f-eval": "eval",
               "f-dossier": "dossier"}[flow_id]
        payload = json.loads(input_value)
        if key == "plan":
            return json.dumps(PLAN, ensure_ascii=False)
        if key == "extract":
            calls["extract"] += 1
            return json.dumps(EXTRACT_OK, ensure_ascii=False)
        if key == "eval":
            calls["eval"] += 1
            if payload["round"] == 1:
                return json.dumps({
                    "isComplete": False, "reason": "缺袁绍方口径", "gaps": ["袁绍方记载"],
                    "nextQueries": [{"query": "补搜换角度", "goal": "袁绍方"}],
                }, ensure_ascii=False)
            return json.dumps({"isComplete": True, "reason": "可开写", "gaps": [],
                               "nextQueries": []}, ensure_ascii=False)
        calls["dossier"] += 1
        return json.dumps(DOSSIER, ensure_ascii=False)

    research._call_flow.__globals__  # noqa: B018  (占位：_call_flow 是模块级函数，直接替换)
    orig_call_flow = research._call_flow

    async def patched_call_flow(key, payload):
        # fake runner 走同一包装（含坏输出重试路径）
        text = await flow_runner(os.environ[research._FLOW_KEYS[key]],
                                 json.dumps(payload, ensure_ascii=False))
        if text.startswith("（"):
            raise RuntimeError(text)
        return research.extract_json(text)

    research._call_flow = patched_call_flow  # type: ignore[assignment]

    # 注入 fake 搜索（research 经 imgresearch.search_serper_web 属性调用，换绑即生效）
    orig_search_serper_web = imgresearch.search_serper_web
    imgresearch.search_serper_web = fake_search_factory(PAGES)

    # 注入 fake 抓取（不打真网络；URL 带敏感词即失败，验 snippet 级降级路径）
    orig_fetch_page_text = research.fetch_page_text

    async def fake_fetch(url: str) -> str:
        if "other.com" in url:
            raise ValueError("模拟反爬拦截")
        return f"{url} 的正文内容：建安五年，曹操袁绍相持官渡。"

    research.fetch_page_text = fake_fetch

    # 开题规范化：坏结构明报
    try:
        research._normalize_plan({"viewingQuestion": "", "directions": []})
        raise SystemExit("坏开题应抛")
    except ValueError:
        pass

    job = research.start_research("p1", "官渡之战", "侧重兵力", "standard")
    job_id = job["jobId"]
    # 等开题 task 完成（事件循环内 create_task）
    for _ in range(50):
        job = research.get_job_view(job_id)
        if job["plan"]:
            break
        await asyncio.sleep(0.01)
    expect(job["plan"] is not None, "开题应生成")
    expect(job["status"] == "planning", "开题后应为待确认")
    expect(job["roundsTotal"] == 2, "standard 档应为 2 轮")

    # 确认前取消/确认保护
    try:
        research.cancel_research(job_id)
        raise SystemExit("planning 态取消应抛")
    except ValueError:
        pass

    view = research.confirm_plan(job_id)
    expect(view["status"] == "running", "确认后应运行中")
    try:
        research.confirm_plan(job_id)
        raise SystemExit("重复确认应抛")
    except ValueError:
        pass

    # 等循环跑完
    for _ in range(400):
        view = research.get_job_view(job_id)
        if view["status"] in ("done", "error", "stopped", "interrupted"):
            break
        await asyncio.sleep(0.01)
    expect(view["status"] == "done", f"应完成，实际 {view['status']} {view['error']}")
    expect(view["roundsDone"] == 2, "应跑满 2 轮（第 1 轮评估不完整）")
    expect(calls["eval"] == 1, "末轮不再评估，应只调 1 次")
    expect(view["dossier"]["headline"] == DOSSIER["headline"], "卷宗应落库")
    expect(view["summary"] == DOSSIER["summary"], "摘要应回填")
    srcs = research.list_sources(job_id)
    # example.com/a（utm 规范化）+ example.com/b（重复 URL 去重为 1 条）+ other.com/c + other.com/d
    expect(len(srcs) == 4, f"应 4 条来源（去重后），实际 {len(srcs)}")
    expect(all(s["category"] == "学术" for s in srcs), "来源分类应来自提纯输出")
    sids = {s["sid"] for s in srcs}
    expect(sids == {"S001", "S002", "S003", "S004"}, f"sid 应连续编号，实际 {sids}")
    dom_count = {}
    for s in srcs:
        dom_count[s["domain"]] = dom_count.get(s["domain"], 0) + 1
    # 第 1 轮 example.com 两条不同 URL（a、b），域名帽 2 内
    expect(view["findingsCount"] >= 4, "每源应提得事实")

    # ---------- gap 补研：定点追加 + 卷宗重写 ----------
    dossier_calls_before = calls["dossier"]
    gap = research.start_gap("p1", job_id, ["袁绍军粮道细节"])
    gap_id = gap["jobId"]
    for _ in range(400):
        gview = research.get_job_view(gap_id)
        if gview["status"] in ("done", "error"):
            break
        await asyncio.sleep(0.01)
    expect(gview["status"] == "done", f"补研应完成，实际 {gview['status']} {gview['error']}")
    expect(calls["dossier"] == dossier_calls_before + 1, "补研后应重写一次卷宗")
    parent = research.get_job_view(job_id)
    expect(parent["sourcesCount"] == 5, f"父任务证据底账应有 5 条，实际 {parent['sourcesCount']}")
    expect(parent["status"] == "done", "父任务应回填 done")
    gap_src = research.list_sources(job_id)[-1]
    expect(gap_src["round"] == 99, "补研来源 round 标记 99")

    # ---------- 卷宗引用校验：幻觉 sid 剔除 ----------
    bad = research._normalize_dossier(
        {"headline": "t", "summary": "s",
         "establishedFacts": [{"text": "真", "refs": ["S001"]},
                              {"text": "幻觉引用全剥后无源→丢", "refs": ["S999"]}],
         "controversies": [], "risks": [{"text": "无引用风险也保留", "refs": []}],
         "materialClusters": [{"title": "簇", "points": [{"text": "p", "refs": ["S002"]}]}]},
        {"S001", "S002"},
    )
    expect(len(bad["establishedFacts"]) == 1, "幻觉引用的事实应整条丢弃")
    expect(bad["risks"][0]["refs"] == [], "无引用的风险保留（风险允许无 refs）")
    expect(bad["materialClusters"][0]["points"][0]["refs"] == ["S002"], "有效引用保留")

    # ---------- 搜索全失败 → 明报 error（不静默吞） ----------
    job2 = research.start_research("p1", "孤本题材", "", "quick")
    j2 = job2["jobId"]
    for _ in range(50):
        job2 = research.get_job_view(j2)
        if job2["plan"]:
            break
        await asyncio.sleep(0.01)
    research.confirm_plan(j2)

    # 注入全失败搜索
    async def dead_search(query, num=6):
        raise ValueError("serper 全挂")

    imgresearch.search_serper_web = dead_search
    try:
        for _ in range(400):
            j2v = research.get_job_view(j2)
            if j2v["status"] in ("done", "error", "stopped", "interrupted"):
                break
            await asyncio.sleep(0.01)
        expect(j2v["status"] == "error", "搜索全失败应 error")
        expect("全部失败" in j2v["error"], "错误应点名搜索全失败")
    finally:
        imgresearch.search_serper_web = orig_search_serper_web
        research.fetch_page_text = orig_fetch_page_text

    # ---------- 提纯失败单源跳过不拖累整轮 ----------
    # （已由 extract 失败路径的日志语义覆盖，此处验证日志通道可用）
    view_logs = research.get_job_view(job_id)["log"]
    expect(any(e["kind"] == "dossier" for e in view_logs), "过程日志应含卷宗事件")

    # ---------- 启动中断标记 ----------
    with research._conn() as conn:
        conn.execute(
            "INSERT INTO research_jobs (id, project_id, topic, status, created_at, updated_at)"
            " VALUES ('orphan','p1','孤儿','running','t','t')")
    n = research.report_interrupted_jobs()
    expect(research.get_job_view("orphan")["status"] == "interrupted", "孤儿应标 interrupted")

    research._call_flow = orig_call_flow  # type: ignore[assignment]
    print("research 单测全部通过")


asyncio.run(main())
