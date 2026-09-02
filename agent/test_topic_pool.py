"""选题池单测：store 语义 + 管线编排（fake flow/搜索注入）+ verdict 规则。

运行：cd agent && uv run python test_topic_pool.py
不需要 langflow / 网络 / agent 服务在跑——flow 与检索全部注 fake，
存储用临时库（monkeypatch topics.DB_PATH）。
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import topics as store
import topic_pool
from topic_pool import TopicCurator, TopicRefreshService, auto_refresh_tick, get_auto_refresh, parse_verdict, set_auto_refresh

# ---------- 临时库与 fake flow id ----------

_tmp = Path(tempfile.mkdtemp(prefix="wstopic-test-"))
store.DB_PATH = _tmp / "test.db"
store.init_topics_db()
os.environ["LANGFLOW_TOPIC_TRIAGE_FLOW_ID"] = "f-triage"
os.environ["LANGFLOW_TOPIC_PLAN_FLOW_ID"] = "f-plan"
os.environ["LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID"] = "f-followup"
os.environ["LANGFLOW_TOPIC_VERDICT_FLOW_ID"] = "f-verdict"
os.environ["LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID"] = "f-rescan-plan"


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


# ---------- store：CRUD 与幂等 ----------

fp_a = store and __import__("topic_pool").fingerprint_of("河南商周遗址新出土甲骨")
fp_b = __import__("topic_pool").fingerprint_of("河南商周遗址新出土甲骨！")  # 标点不影响指纹
expect(fp_a == fp_b, "指纹应规范化标点")

t1 = store.create_topic(
    vertical="history",
    title="河南商周遗址新出土甲骨",
    title_fingerprint=fp_a,
    summary="摘要",
    angles=["角度一"],
    research={"evidence_level": "strong", "event": "出土甲骨百余片"},
)
expect(t1["status"] == "candidate" and t1["source"] == "material", "新卡应为 material 候选")
expect(store.exists_by_any_fingerprint([fp_b]), "同簇不同写法指纹应命中去重")

# 观察卡 + 升级路径
t2 = store.create_topic(
    vertical="crime",
    title="某悬案重启侦查",
    title_fingerprint=__import__("topic_pool").fingerprint_of("某悬案重启侦查"),
    research={"evidence_level": "thin", "event": "警方重启侦查"},
)
upgradable = store.find_upgradable_by_any_fingerprint([fp_a, __import__("topic_pool").fingerprint_of("某悬案重启侦查")])
expect(upgradable == t2["id"], "无角度的观察卡应可升级")
store.upgrade_card(upgradable, title="新题", summary="新摘", angles=["角度"], research={"evidence_level": "strong"})
expect(store.get_topic(t2["id"])["angles"] == ["角度"], "升级后应有角度")
expect(store.find_upgradable_by_any_fingerprint([fp_a]) is None, "有角度后不再可升级")

# dismiss 语义
expect(store.dismiss_topic(t1["id"]) == "ok", "candidate 可忽略")
expect(store.dismiss_topic(t1["id"]) == "conflict", "已忽略不可再忽略")
expect(store.dismiss_topic("nope") == "not_found", "不存在的卡 404 语义")

# adopt 条件更新
expect(store.adopt_topic(t2["id"], "proj1"), "candidate 可认领")
expect(not store.adopt_topic(t2["id"], "proj2"), "已认领不可重复认领")
expect(store.get_topic(t2["id"])["adoptedPid"] == "proj1", "认领应回链项目")

# 沉底归档
t3 = store.create_topic(
    vertical="history",
    title="三年前的老线索",
    title_fingerprint=__import__("topic_pool").fingerprint_of("三年前的老线索"),
)
with store._conn() as conn:
    conn.execute("UPDATE topics SET last_progress_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (t3["id"],))
expect(store.archive_stale(90) >= 1, "90 天无进展应沉底")
expect(store.get_topic(t3["id"])["status"] == "archived", "沉底后状态为 archived")

print("store 语义 ✓")

# ---------- 管线：fake flow + fake 搜索 ----------

SIGNALS = [
    {"index": 0, "title": "商周遗址新出土百余片甲骨", "platform": "web", "source": "材料窗口:考古新发现"},
    {"index": 1, "title": "某悬案当年经办人退休后自述疑点", "platform": "web", "source": "材料窗口:悬案旧案重审"},
]

TRIAGE_OUT = [
    # 采集序：history 4 种子 × 2 结果 = index 0-7，crime 从 index 8 起
    {"members": [0], "vertical": "history", "theme": "商周甲骨新发现", "reason": "新材料罕见"},
    {"members": [8], "vertical": "crime", "theme": "悬案经办人自述", "reason": "一手信源进场"},
]

VERDICT_STRONG = {
    "evidence_level": "strong",
    "title": "甲骨新证",
    "event": "遗址出土甲骨百余片",
    "why_now": "材料新公布",
    "summary": "一次出土百片",
    "angles": ["释读悬念", "考古人命运"],
    "material_base": "考古队直通",
    "competition_gap": "尚无纪录片进场",
    "unit_kind": "object",
    "viewing_question": "一片甲骨如何改写商周年表",
    "scale": "series",
    "series_thread": "一片甲骨一个故事",
}

VERDICT_THIN = {
    "evidence_level": "thin",
    "event": "经办人接受采访称有疑点",
    "gaps": ["无官方定性"],
    "observation": "等官方通报再立项",
}

# 复查（rescan）verdict 的输出：仍薄 → 升级场景再改写为强证据
RESCAN_VERDICT = {
    "evidence_level": "thin",
    "event": "重启侦查仍未有官方通报",
    "gaps": ["仍无官方通报"],
    "observation": "继续等待官方定性",
}


async def fake_flow_runner(flow_id: str, input_value: str) -> str:
    payload = json.loads(input_value)
    if flow_id == "f-triage":
        assert "listing" in payload, "研判载荷应含 listing"
        return json.dumps(TRIAGE_OUT, ensure_ascii=False)
    if flow_id == "f-plan":
        assert set(payload) == {"title", "theme", "reason"}, "规划载荷字段"
        return json.dumps([{"label": "事件核实", "query": f"{payload['title']} 经过"}], ensure_ascii=False)
    if flow_id == "f-rescan-plan":
        assert set(payload) == {"title", "event", "gaps", "observation"}, "复查规划载荷字段"
        return json.dumps([{"label": "缺口核查", "query": f"{payload['title']} 官方通报"}], ensure_ascii=False)
    if flow_id == "f-followup":
        assert "log" in payload, "追查载荷应含检索记录"
        return json.dumps({"done": True})
    if flow_id == "f-verdict":
        assert "evidencePack" in payload, "结论载荷应含证据包"
        if str(payload.get("reason", "")).startswith("观察卡复查"):
            assert "先前观察" in payload.get("priorContext", ""), "复查结论应带先前观察上下文"
            return json.dumps(RESCAN_VERDICT, ensure_ascii=False)
        return json.dumps(VERDICT_STRONG if "甲骨" in payload["title"] else VERDICT_THIN, ensure_ascii=False)
    raise AssertionError(f"未知 flow: {flow_id}")


# 种子查询 → 该查得到的真实感信号标题（材料窗口条目的 title 是搜索结果标题）
SIGNAL_TITLES = {
    "考古新发现": "河南某商周遗址新出土百余片甲骨",
    "出土简牍 整理公布": "里耶秦简新一批整理简牍公布",
    "历史档案 解密公开": "某国档案馆解密一批冷战时期档案",
    "史学研究 新成果 出版": "新研究推翻明代粮仓位置旧说",
    "悬案旧案重审": "某县悬案经办人退休后自述疑点",
    "再审改判 案件": "最高法再审改判一桩陈年旧案",
    "判决文书 公开 案件": "某待决案件判决文书首次公开",
    "案件档案 解密": "某历史案件档案解密移交地方",
}


async def fake_search(query: str) -> dict:
    title = SIGNAL_TITLES.get(query, f"结果：{query}")
    return {
        "query": query,
        "results": [
            {"title": title, "url": "https://example.com/a", "snippet": "snip", "provider": "tencent"},
            {"title": f"{title}（转载）", "url": "https://en.wikipedia.org/wiki/x", "snippet": "w", "provider": "wikipedia"},
        ],
    }


async def run_pipeline() -> None:
    curator = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
    result = await curator.run()
    expect(result.collected == 16, f"8 条种子查询 × 每查 2 结果应采到 16 条，实际 {result.collected}")
    expect(result.shortlisted == 2, f"研判应入围 2 条，实际 {result.shortlisted}")
    expect(result.created == 1, f"应产出 1 张建议卡，实际 {result.created}")
    expect(result.observed == 1, f"应产出 1 张观察卡，实际 {result.observed}")

    cards = store.list_topics(status="candidate")
    strong = [c for c in cards if c["research"].get("evidence_level") == "strong"]
    thin = [c for c in cards if c["research"].get("evidence_level") == "thin"]
    expect(len(strong) == 1 and len(thin) == 1, "池内应一强一弱各一张")
    expect(strong[0]["research"]["scale"] == "series" and strong[0]["research"]["series_thread"], "系列卡应带串珠问题")
    expect(strong[0]["research"]["source_map"], "信源底账应留痕")

    # 幂等：原样重跑不得产生重复卡
    again = await curator.run()
    expect(again.created == 0 and again.observed == 0, f"重跑不应新增卡：{again}")

    # 升级：观察卡遇到证据变硬的建议卡 → 升级而非新建
    global VERDICT_THIN
    VERDICT_THIN = dict(VERDICT_STRONG, title="悬案自述", angles=["自述"])
    curator2 = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
    third = await curator2.run()
    expect(third.upgraded == 1 and third.created == 0, f"观察卡应升级：{third}")

    print("管线编排 ✓")


asyncio.run(run_pipeline())


# ---------- verdict 规则 ----------

# series 缺串珠问题 → 降 single
card = parse_verdict(
    {"evidence_level": "strong", "title": "T", "angles": ["a"], "unit_kind": "case",
     "viewing_question": "q", "scale": "series", "series_thread": ""},
    "fb", [],
)
expect(card is not None and card["research"]["scale"] == "single", "series 无串珠应降 single")

# 自称 strong 但缺角度/单元 → 降观察
card = parse_verdict(
    {"evidence_level": "strong", "title": "T", "angles": [], "unit_kind": "nope",
     "viewing_question": "q", "scale": "single"},
    "fb", [],
)
expect(card is not None and not card["worth_it"] and card["title"] == "fb", "缺单元应降观察并回退热点标题")

# 坏输出
expect(parse_verdict("junk", "fb", []) is None, "非 dict 输出应返回 None")

print("verdict 规则 ✓")

# ---------- flow 调用：解析失败重试一次 ----------


async def run_call_flow_retry() -> None:
    calls = {"n": 0}

    async def flaky(flow_id: str, input_value: str) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            return '坏输出：他说"这不算 JSON"就完了'  # 未转义引号类坏输出
        return '[{"ok": true}]'

    curator = TopicCurator(flow_runner=flaky, search=fake_search)
    parsed = await curator._call_flow("verdict", {"x": 1})
    expect(parsed == [{"ok": True}] and calls["n"] == 2, f"坏输出应重试一次后成功：calls={calls['n']}")

    async def always_bad(flow_id: str, input_value: str) -> str:
        calls["n"] += 1
        return "始终不是 JSON"

    calls["n"] = 0
    curator2 = TopicCurator(flow_runner=always_bad, search=fake_search)
    try:
        await curator2._call_flow("plan", {"x": 1})
        raise SystemExit("两次坏输出应抛错")
    except RuntimeError as exc:
        expect("两次解析失败" in str(exc) and calls["n"] == 2, f"应恰好尝试两次后报错：{exc}")

    async def engine_error(flow_id: str, input_value: str) -> str:
        calls["n"] += 1
        return "（引擎错误：flow 不存在）"

    calls["n"] = 0
    curator3 = TopicCurator(flow_runner=engine_error, search=fake_search)
    try:
        await curator3._call_flow("verdict", {"x": 1})
        raise SystemExit("引擎错误应抛错")
    except RuntimeError:
        expect(calls["n"] == 1, f"确定性失败不应重试：calls={calls['n']}")

    print("flow 解析重试 ✓")


asyncio.run(run_call_flow_retry())


# ---------- verdict 新维度：人物锚点与情绪钩子 ----------

card = parse_verdict(
    {"evidence_level": "strong", "title": "T", "angles": ["a"], "unit_kind": "person",
     "viewing_question": "q", "scale": "single",
     "person_anchor": "发掘者陈瑞（苏峪口考古队）", "emotion": "小人物守出大发现"},
    "fb", [],
)
expect(card["research"]["person_anchor"] == "发掘者陈瑞（苏峪口考古队）", "人物锚点应入 research")
expect(card["research"]["emotion"] == "小人物守出大发现", "情绪钩子应入 research")

card_thin = parse_verdict(
    {"evidence_level": "thin", "event": "e", "gaps": ["g"], "observation": "o", "emotion": "等待真相"},
    "fb", [],
)
expect(card_thin["research"]["emotion"] == "等待真相", "观察卡情绪钩子应保留")
expect("person_anchor" not in card_thin["research"], "空人物锚点不应落字段")

print("verdict 新维度 ✓")

# ---------- store：复查候选与记录 ----------

t_res = store.create_topic(
    vertical="crime",
    title="待复查观察卡",
    title_fingerprint=topic_pool.fingerprint_of("待复查观察卡"),
    research={"evidence_level": "thin", "event": "案件重启", "gaps": ["无官方通报"], "observation": "先观察"},
)
expect(store.list_rescan_candidates(3) == [], "新建卡应被冷却挡在复查门外")
with store._conn() as conn:
    conn.execute("UPDATE topics SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (t_res["id"],))
cands = store.list_rescan_candidates(3)
expect(len(cands) == 1 and cands[0]["id"] == t_res["id"], "拨回建卡时间后应成为复查候选")
store.mark_rescanned(t_res["id"])
expect(store.list_rescan_candidates(3) == [], "复查后应再次被冷却挡住")

print("store 复查语义 ✓")


# ---------- 观察卡复查管线：缺口导向 → 仍薄留痕 / 证据变硬升级 ----------

async def run_rescan() -> None:
    t = store.create_topic(
        vertical="crime",
        title="悬案关键证人猝然离世",
        title_fingerprint=topic_pool.fingerprint_of("悬案关键证人猝然离世"),
        research={"evidence_level": "thin", "event": "证人突然离世", "gaps": ["死因未核实"], "observation": "等待尸检结论"},
    )
    with store._conn() as conn:
        conn.execute("UPDATE topics SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (t["id"],))
    summary = await TopicCurator(flow_runner=fake_flow_runner, search=fake_search).rescan_observations()
    expect(summary.rescanned == 1 and summary.upgraded == 0, f"应复查恰好一张薄卡：{summary}")
    got = store.get_topic(t["id"])
    expect(got["lastRescanAt"], "仍薄应记扫描时间")
    expect(len(got["research"]["source_map"]) == 1, "仍薄应把复查取证追加进信源底账")
    expect(got["research"]["event"] == "证人突然离世", "仍薄不覆写已核实事实")
    expect(got["angles"] == [], "仍薄不升级")

    global RESCAN_VERDICT
    RESCAN_VERDICT = dict(VERDICT_STRONG, title="猝逝的证人", angles=["死亡真相"], unit_kind="person", viewing_question="他到底怎么死的")
    with store._conn() as conn:
        conn.execute("UPDATE topics SET last_rescan_at = NULL WHERE id = ?", (t["id"],))
    summary2 = await TopicCurator(flow_runner=fake_flow_runner, search=fake_search).rescan_observations()
    expect(summary2.rescanned == 1 and summary2.upgraded == 1, f"证据变硬应升级：{summary2}")
    got2 = store.get_topic(t["id"])
    expect(got2["angles"] == ["死亡真相"] and got2["research"]["evidence_level"] == "strong", "升级后应为建议卡")

    # 手动深挖：job 注册表跑通 + 同卡在跑互斥
    topic_pool.SERVICE.curator = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
    t2 = store.create_topic(
        vertical="history",
        title="第二批简牍公布观察卡",
        title_fingerprint=topic_pool.fingerprint_of("第二批简牍公布观察卡"),
        research={"evidence_level": "thin", "event": "简牍公布", "gaps": ["整理者存争议"], "observation": ""},
    )
    job_id = topic_pool.start_rescan_job(store.get_topic(t2["id"]))
    expect(job_id, "手动深挖应能启动")
    for _ in range(200):
        job = topic_pool.get_rescan_job(job_id)
        if job["status"] != "running":
            break
        await asyncio.sleep(0.01)
    expect(job["status"] == "done" and job["outcome"] == "upgraded", f"手动深挖应完成并升级：{job}")

    topic_pool._rescan_inflight.add(t2["id"])
    expect(topic_pool.start_rescan_job(store.get_topic(t2["id"])) is None, "同卡复查在跑应拒绝重复启动")
    topic_pool._rescan_inflight.discard(t2["id"])

    # 服务 _run 把复查统计折进 last_run
    svc = TopicRefreshService(curator=TopicCurator(flow_runner=fake_flow_runner, search=fake_search))
    await svc._run()
    lr = svc.last_run()
    expect("rescanned" in lr and "rescanUpgraded" in lr, f"last_run 应含复查统计：{sorted(lr)}")

    print("观察卡复查 ✓")


asyncio.run(run_rescan())


# ---------- 每日定时刷新：开关 / 校验 / 触发判定 ----------

set_auto_refresh(enabled=True, time="00:00")
expect(get_auto_refresh() == {"enabled": True, "time": "00:00"}, "调度设置应能读写回环")


class _StubService:
    def __init__(self):
        self.calls = 0

    def start(self):
        self.calls += 1
        return True


stub = _StubService()
expect(auto_refresh_tick(stub) == "fired", "到点且当天未跑应触发")
expect(stub.calls == 1, "触发应调用 start")
expect(auto_refresh_tick(stub) == "skipped", "当天已跑不应重复触发")
expect(stub.calls == 1, "跳过不应调用 start")

set_auto_refresh(enabled=False, time="08:00")
expect(auto_refresh_tick(stub) == "idle", "开关关闭应 idle")


class _BusyService:
    def start(self):
        return False


set_auto_refresh(enabled=True, time="00:00")
store.set_setting(topic_pool.AUTO_REFRESH_LAST_DATE_KEY, "2000-01-01")
expect(auto_refresh_tick(_BusyService()) == "skipped", "与进行中的刷新撞车应跳过")
expect(store.get_setting(topic_pool.AUTO_REFRESH_LAST_DATE_KEY) == "2000-01-01", "撞车不落账，下一分钟重试")

try:
    set_auto_refresh(enabled=True, time="25:00")
    raise SystemExit("非法时刻应抛 ValueError")
except ValueError:
    pass

print("每日定时刷新 ✓")
print("\n全部通过 ✓")
