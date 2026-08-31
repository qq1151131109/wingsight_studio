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
from topic_pool import TopicCurator, parse_verdict

# ---------- 临时库与 fake flow id ----------

_tmp = Path(tempfile.mkdtemp(prefix="wstopic-test-"))
store.DB_PATH = _tmp / "test.db"
store.init_topics_db()
os.environ["LANGFLOW_TOPIC_TRIAGE_FLOW_ID"] = "f-triage"
os.environ["LANGFLOW_TOPIC_PLAN_FLOW_ID"] = "f-plan"
os.environ["LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID"] = "f-followup"
os.environ["LANGFLOW_TOPIC_VERDICT_FLOW_ID"] = "f-verdict"


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


async def fake_flow_runner(flow_id: str, input_value: str) -> str:
    payload = json.loads(input_value)
    if flow_id == "f-triage":
        assert "listing" in payload, "研判载荷应含 listing"
        return json.dumps(TRIAGE_OUT, ensure_ascii=False)
    if flow_id == "f-plan":
        assert set(payload) == {"title", "theme", "reason"}, "规划载荷字段"
        return json.dumps([{"label": "事件核实", "query": f"{payload['title']} 经过"}], ensure_ascii=False)
    if flow_id == "f-followup":
        assert "log" in payload, "追查载荷应含检索记录"
        return json.dumps({"done": True})
    if flow_id == "f-verdict":
        assert "evidencePack" in payload, "结论载荷应含证据包"
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
print("\n全部通过 ✓")
