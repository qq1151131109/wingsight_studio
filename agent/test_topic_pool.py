"""选题池单测：store 语义 + 生料生成管线（fake flow/搜索注入）+ 深挖/复查 + verdict 规则。

运行：cd agent && uv run python test_topic_pool.py
不需要 langflow / 网络 / agent 服务在跑——flow 与检索全部注 fake，
存储用临时库（monkeypatch topics.DB_PATH），维基语料按天缓存预置为空。
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import topics as store
import entities as entity_store
import tikhub
import topic_pool
import wikiday
import wikicategory
import podcastfeed
from topic_pool import TopicCurator, TopicRefreshService, auto_refresh_tick, get_auto_refresh, parse_verdict, set_auto_refresh

# ---------- 临时库与 fake flow id ----------

_tmp = Path(tempfile.mkdtemp(prefix="wstopic-test-"))
store.DB_PATH = _tmp / "test.db"
store.init_topics_db()
entity_store.DB_PATH = _tmp / "test.db"
entity_store.init_entities_db()
os.environ["LANGFLOW_TOPIC_IDEATE_FLOW_ID"] = "f-ideate"
os.environ["LANGFLOW_TOPIC_DIVERGE_FLOW_ID"] = "f-diverge"
os.environ["LANGFLOW_TOPIC_TRIAGE_FLOW_ID"] = "f-triage"
os.environ["LANGFLOW_TOPIC_PLAN_FLOW_ID"] = "f-plan"
os.environ["LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID"] = "f-followup"
os.environ["LANGFLOW_TOPIC_VERDICT_FLOW_ID"] = "f-verdict"
os.environ["LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID"] = "f-rescan-plan"
os.environ["LANGFLOW_TOPIC_ANGLE_FLOW_ID"] = "f-angle"
# 语料采集离线化：按天缓存预置为空列表（collect_wiki_corpus 短路，不打网络）
store.set_setting(wikicategory.CACHE_KEY, wikicategory.build_day_cache([]))


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

# 观察卡 + 生料卡 + 升级路径
t2 = store.create_topic(
    vertical="crime",
    title="某悬案重启侦查",
    title_fingerprint=__import__("topic_pool").fingerprint_of("某悬案重启侦查"),
    research={"evidence_level": "thin", "event": "警方重启侦查"},
)
expect(t2["stage"] == "verified" and t2["tags"] == [], "store 直建卡默认已深挖层、无标签")
raw = store.create_topic(
    vertical="crime",
    title="生料卡样例",
    title_fingerprint=__import__("topic_pool").fingerprint_of("生料卡样例"),
    summary="一句钩子",
    heat_evidence=[{"title": "原型条目", "url": "https://zh.wikipedia.org/wiki/x", "snippet": "", "source": "维基语料"}],
    stage="raw",
    tags=["民国", "悬案"],
)
expect(raw["stage"] == "raw" and raw["tags"] == ["民国", "悬案"], "生料卡应带 stage/tags 落库")
store.upgrade_card(raw["id"], title="新题", summary="新摘", angles=["角度"], research={"evidence_level": "strong"})
expect(store.get_topic(raw["id"])["stage"] == "verified", "深挖升级后应转已深挖")
expect(store.get_topic(t2["id"])["angles"] == [], "观察卡不受他卡升级影响")

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

# ---------- 维基大事记解析与周年算术 ----------

WT = """
==大事记==
* [[前44年]]：西塞罗开始发表一系列演讲，号召反对马克·安东尼。
* [[1192年]]：“狮心王”理查一世 (英格蘭)|理查一世与萨拉丁签订{{cite|迦法条约}}<ref>xx</ref>，结束第三次十字军东征。
* [[1945年]]：日本签署降伏文书，第二次世界大战正式结束。
* 2020年：某近年的事，不满 20 年不进周年池。
* [[1986年]]：某逢一事件，非逢五逢十不进周年池。
* 太短的行。

==节假日==
* 不该被解析的行
"""
events = wikiday.parse_day_wikitext(WT)
expect([e["year"] for e in events] == [-44, 1192, 1945, 2020, 1986], f"应解析 5 条年份行：{events}")
expect(all("[[" not in e["text"] and "<ref" not in e["text"] for e in events), "文本应剥维基标记")
kept = wikiday.anniversary_filter(events, on_year=2026)
ages = {e["age"] for e in kept}
# 前44年→2070 ✓、1986→40 ✓；1192→834 ✗、1945→81 ✗（非 5 的倍数）、2020→6 ✗（不足 20 年）
expect(ages == {2070, 40}, f"2026 年应只留逢五逢十且 ≥20 年：{sorted(ages)}")

cache = wikiday.load_window_cache(wikiday.build_window_cache(wikiday.date(2026, 9, 2), kept))
expect(cache["start"] == "2026-09-02" and cache["events"] == kept, "窗口缓存应回读一致")
expect(wikiday.load_window_cache(None) is None and wikiday.load_window_cache("junk") is None, "坏缓存应判无效")

print("wikiday 解析与周年算术 ✓")

# ---------- 播客 RSS 解析 ----------

RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>故事FM</title>
<item><title>一个守林人的三十年 | 故事FM</title><link>https://storyfm.cn/ep1</link>
<description>&lt;p&gt;他独自守着大山&lt;/p&gt;</description></item>
<item><title></title><link>https://storyfm.cn/ep2</link></item>
<item><title>第二期</title><link>https://storyfm.cn/ep3</link></item>
</channel></rss>"""
eps = podcastfeed.parse_feed(RSS, "故事FM")
expect(len(eps) == 2 and eps[0]["title"] == "一个守林人的三十年 | 故事FM", "空标题条目应丢弃")
expect(eps[0]["snippet"] == "他独自守着大山" and eps[0]["feed"] == "故事FM", "摘要应剥 HTML 标签")

print("播客 RSS 解析 ✓")

# ---------- TikHub 解析与市场实查 ----------

BILI_ENV = {"data": {"data": {"result": [
    {"type": "video", "title": "宁夏<em class=\"keyword\">苏峪口</em>发掘纪实", "bvid": "BV1abc",
     "author": "考古君", "play": 812345, "like": 9001, "pubdate": 1717300000},
    {"type": "article", "title": "专栏不是视频应跳过"},
]}}}
bili = tikhub._parse_bilibili(BILI_ENV)
expect(len(bili) == 1 and bili[0]["title"] == "宁夏苏峪口发掘纪实", "B站解析应剥高亮且只取视频")
expect(bili[0]["play_count"] == 812345 and bili[0]["published_at"], "B站播放数与日期应归一")

DOUYIN_ENV = {"data": {"aweme_list": [
    {"aweme_info": {"desc": "悬案追凶三十年", "aweme_id": "7x1", "share_url": "https://v.douyin.com/x",
                    "author": {"nickname": "央视频"}, "statistics": {"digg_count": 42921, "play_count": 0},
                    "create_time": 1717300000}},
]}}
dy = tikhub._parse_douyin(DOUYIN_ENV)
expect(len(dy) == 1 and dy[0]["like_count"] == 42921 and dy[0]["play_count"] is None, "抖音点赞有效、零播放归 None")

XG = {"data": {"results": [
    {"data": {"title": "考古纪录片全集", "group_id": "7g1", "user_info": {"name": "西瓜创客"},
              "video_detail_info": {"video_watch_count": 3263483}, "publish_time": 1717300000}},
]}}
xg = tikhub._parse_xigua(XG)
expect(xg[0]["play_count"] == 3263483 and xg[0]["url"] == "https://www.ixigua.com/7g1", "西瓜观看数与 URL 应归一")

ZH = {"data": {"data": [
    {"object": {"type": "article", "title": "南大碎尸案全新<em>真相</em>解读", "id": "2070", "votes": 2539,
                "author": {"name": "考据党"}, "excerpt": "档案与报道交叉核对…"}},
    {"object": {"type": "answer", "title": "回答对象应取问题标题", "id": "9", "voteup_count": 355,
                "author": {"name": "答主"}, "question": {"name": "南大碎尸案为什么20年没能告破？", "id": "888"}}},
    {"object": {"type": "article", "title": "", "id": "1"}},
]}}
zh = tikhub._parse_zhihu_articles(ZH)
expect(len(zh) == 2, f"空标题条目应丢弃：{len(zh)}")
expect(zh[0]["like_count"] == 2539 and zh[0]["url"].endswith("/p/2070") and zh[0]["kind"] == "article", "文章赞同数与 URL 应归一")
expect(zh[1]["title"] == "南大碎尸案为什么20年没能告破？" and zh[1]["url"].endswith("/question/888") and zh[1]["kind"] == "answer", "回答应取问题标题与问题 URL")

ZHOT = {"data": {"data": [
    {"target": {"title": "为啥中国男人不爱买皮鞋了？", "url": "https://zhihu.com/question/1"}, "detail_text": "749 万热度"},
]}}
hot = tikhub.parse_zhihu_hot(ZHOT)
expect(hot[0]["title"] == "为啥中国男人不爱买皮鞋了？" and hot[0]["heat_text"] == "749 万热度", "知乎热榜解析")

zh_snippet = topic_pool._format_market_item(zh[0])
expect("2539" in zh_snippet and "考据党" in zh_snippet and "档案与报道" in zh_snippet, f"知乎实查摘要应含赞同/作者/节选：{zh_snippet}")
expect(len(topic_pool.MARKET_PROBE_PLATFORMS) == 4 and "zhihu" in topic_pool.MARKET_PROBE_PLATFORMS, "实查平台应为四平台含知乎")
expect(topic_pool._fmt_count(12345) == "1.2万" and topic_pool._fmt_count(999) == "999" and topic_pool._fmt_count(None) == "—", "计数格式化")
snippet = topic_pool._format_market_item({"play_count": 3263483, "like_count": None, "author": "西瓜创客", "published_at": "2024-06-02"})
expect("326.3万" in snippet and "西瓜创客" in snippet, f"市场条目摘要应含计数与作者：{snippet}")

# 无 key 时探针为 None；有 key 时返回可调用（不真发请求）
os.environ.pop("TIKHUB_API_KEY", None)
expect(topic_pool.build_market_probe() is None, "无 key 探针应为 None")
os.environ["TIKHUB_API_KEY"] = "test-key"
try:
    probe = topic_pool.build_market_probe()
    expect(callable(probe), "有 key 应返回探针函数")
finally:
    os.environ.pop("TIKHUB_API_KEY", None)


# ---------- 知乎沉淀讨论信号采集（默认接线，客户端打桩） ----------


async def run_zhihu_discussion_signal() -> None:
    captured: list[str] = []

    async def fake_search(platform, keyword, *, count=5):
        captured.append(keyword)
        return [
            {"platform": "zhihu", "kind": "answer", "title": "南大碎尸案为什么20年没能告破？", "author": "考据党",
             "url": "https://www.zhihu.com/question/1", "play_count": None, "like_count": 355,
             "published_at": None, "excerpt": "档案与报道交叉核对…"},
            {"platform": "zhihu", "kind": "article", "title": "低赞段子文不算信号", "author": None,
             "url": None, "play_count": None, "like_count": 42, "published_at": None, "excerpt": ""},
        ]

    os.environ["TIKHUB_API_KEY"] = "test-key"
    orig_client = tikhub.TikHubClient
    tikhub.TikHubClient = lambda **kw: type("C", (), {"search_videos": staticmethod(fake_search)})()
    try:
        curator = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
        signals = await curator.collect_zhihu_discussions()
        expect(len(signals) == len(topic_pool.ZHIHU_DISCUSSION_SEEDS) * 3, f"每种子 1 条高赞（低赞被滤）：{len(signals)}")
        crime_signals = [s for s in signals if s["vertical_seed"] == "crime"]
        s = crime_signals[0]
        expect(s["signal_type"] == "validated" and "悬案 真相" in s["source"], f"信号应带种子来源标注：{s['source']}")
        expect("355" in s["snippet"], "信号应带赞同数")
        expect(len(captured) == len(topic_pool.ZHIHU_DISCUSSION_SEEDS) * 3, "每垂类 3 个种子各查一次")
    finally:
        tikhub.TikHubClient = orig_client
        os.environ.pop("TIKHUB_API_KEY", None)

    expect(await TopicCurator(flow_runner=fake_flow_runner, search=fake_search).collect_zhihu_discussions() == [], "无 key 应返回空")
    print("知乎沉淀讨论信号 ✓")


print("TikHub 解析与市场实查 ✓")


# ---------- 管线：fake flow + fake 搜索 ----------

# 批量生成 flow 的输出在 fake_flow_runner 里按语料动态构造（选题标题锚定语料
# 原文，sourceIndex 指回批次内序号），此处只放 verdict/角度的静态桩。

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
    "entities": [{"kind": "case", "name": "某悬案", "summary": ""}],
}

# 角度生成器的候选方案输出
ANGLE_OUT = [
    {"template": "一件物", "angle": "以一片刻辞甲骨为透镜看商周之争", "viewing_question": "一片甲骨能改写年表吗", "unit_kind": "object"},
    {"template": "一个人", "angle": "发掘负责人的三十年田野", "viewing_question": "一个人怎么啃一块遗址", "unit_kind": "person"},
]

# 复查（rescan）verdict 的输出：仍薄 → 升级场景再改写为强证据
RESCAN_VERDICT = {
    "evidence_level": "thin",
    "event": "重启侦查仍未有官方通报",
    "gaps": ["仍无官方通报"],
    "observation": "继续等待官方定性",
}


async def fake_flow_runner(flow_id: str, input_value: str, tweaks=None) -> str:
    payload = json.loads(input_value)
    if flow_id == "f-diverge":
        assert "corpus" in payload, "发散载荷应含线索清单"
        out = []
        for item in payload["corpus"]:
            # 每条线索发散三个方向（人物/制度/工艺轴）
            out.append({
                "sourceIndex": item["index"],
                "directions": [
                    {"name": "人物方向", "sketch": f"跟拍{item['title']}的当事人与传承者"},
                    {"name": "制度方向", "sketch": f"追查{item['title']}背后的制度与行业变迁"},
                    {"name": "工艺方向", "sketch": f"拆解{item['title']}涉及的手艺与技术过程"},
                ],
            })
        return json.dumps(out, ensure_ascii=False)
    if flow_id == "f-ideate":
        assert "directions" in payload and "verticals" in payload, "收敛载荷应含方向清单与垂类"
        out = []
        for j, d in enumerate(payload["directions"]):
            # 每个方向收敛成一张卡（标题锚定方向 sketch 保跨轮稳定）；垂类按序交替
            vertical = "history" if j % 2 == 0 else "crime"
            out.append({
                "title": f"选题：{d['sketch']}",
                "hook": f"钩子{j}",
                "prototype": "原型概括",
                "arc": f"题眼：{d['name']}背后的大主题；跟拍：相关当事人；弧线：从起点到现状",
                "vertical": vertical,
                "tags": ["测试标签"],
                "sourceIndex": j,
            })
        out.append({"title": "无源卡", "hook": "h", "vertical": "history", "tags": []})  # 缺 arc → 成立性闸拒绝
        out.append({"title": "垂类卡", "hook": "h", "vertical": "sports", "sourceIndex": 0})  # 非法垂类 → 跳过
        out.append({"title": "无推演卡", "hook": "一条钩子", "vertical": "history", "sourceIndex": 0})  # 缺 arc → 拒绝
        out.append({"title": "复读卡", "hook": "他守了它三十年，如今它要消失", "arc": "他守了它三十年，如今它要消失",
                    "vertical": "crime", "sourceIndex": 1})  # arc 复读 hook（无过程推演）→ 拒绝
        return json.dumps(out, ensure_ascii=False)
    if flow_id == "f-plan":
        assert set(payload) == {"title", "theme", "reason"}, "规划载荷字段"
        return json.dumps([{"label": "事件核实", "query": f"{payload['title']} 经过"}], ensure_ascii=False)
    if flow_id == "f-angle":
        assert set(payload) == {"title", "theme", "evidencePack"}, "角度载荷字段"
        return json.dumps(ANGLE_OUT, ensure_ascii=False)
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
        if "甲骨" in payload["title"]:
            assert "angleOptions" in payload, "角度 flow 已配置时结论载荷应带候选角度"
            out = dict(VERDICT_STRONG, chosen_template="一件物", entities=[
                {"kind": "object", "name": "刻辞甲骨", "summary": "遗址出土甲骨百余片"},
                {"kind": "person", "name": "徐廷", "summary": "长白山遗址群负责人"},
                {"kind": "plant", "name": "不该收的种类", "summary": ""},
            ])
            return json.dumps(out, ensure_ascii=False)
        return json.dumps(VERDICT_THIN, ensure_ascii=False)
    raise AssertionError(f"未知 flow: {flow_id}")


# 种子查询 → 该查得到的真实感信号标题（材料种子已带年份锚；未知查询返回空，
# 管线测试只喂材料流——多源聚合另有专测）
_Y = topic_pool._year_anchor()
SIGNAL_TITLES = {
    f"考古中国 发布会 {_Y}": "考古中国发布会通报重要进展",
    f"考古新发现 {_Y}": "河南某商周遗址新出土百余片甲骨",
    f"出土简牍 整理公布 {_Y}": "里耶秦简新一批整理简牍公布",
    f"历史档案 解密公开 {_Y}": "某国档案馆解密一批冷战时期档案",
    f"最高人民法院 典型案例 {_Y}": "最高法发布年度典型案例",
    f"再审改判 案件 {_Y}": "某悬案当年经办人退休后自述疑点",
    f"判决文书 公开 案件 {_Y}": "某待决案件判决文书首次公开",
    f"案件档案 解密 {_Y}": "某历史案件档案解密移交地方",
    f"科学 重大发现 {_Y}": "某重大科学发现公布",
    f"中国科学院 重大成果 发布 {_Y}": "中科院发布年度重大成果",
}


async def fake_search(query: str) -> dict:
    title = SIGNAL_TITLES.get(query)
    if title is None:
        return {"query": query, "results": []}
    return {
        "query": query,
        "results": [
            {"title": title, "url": "https://example.com/a", "snippet": "snip", "provider": "tencent"},
        ],
    }


# 管线测试离线化：周年窗口与播客源打空桩（多源聚合在专测里覆盖）
async def _empty_window(start=None, days=45, max_concurrency=8):
    return []


async def _empty_feeds():
    return []


wikiday.anniversary_window = _empty_window
podcastfeed.fetch_all_feeds = _empty_feeds

asyncio.run(run_zhihu_discussion_signal())


async def run_signal_matrix() -> None:
    """多源聚合专测：四类采集器各自的信号标注与形态（独立 fake，不依赖上面）。"""
    year = topic_pool._year_anchor()
    matrix_titles = {
        f"考古中国 发布会 {year}": "考古中国发布会通报重要进展",
        f"考古新发现 {year}": "河南某商周遗址新出土百余片甲骨",
        f"出土简牍 整理公布 {year}": "里耶秦简新一批整理简牍公布",
        f"历史档案 解密公开 {year}": "某国档案馆解密一批冷战时期档案",
        f"最高人民法院 典型案例 {year}": "最高法发布典型案例",
        f"再审改判 案件 {year}": "最高法再审改判一桩陈年旧案",
        f"判决文书 公开 案件 {year}": "某待决案件判决文书首次公开",
        f"案件档案 解密 {year}": "某历史案件档案解密移交地方",
        f"科学 重大发现 {year}": "某重大科学发现公布",
        f"中国科学院 重大成果 发布 {year}": "中科院发布年度重大成果",
        f"极昼工作室 报道 {year}": "极昼：外嫁女的胜诉之后",
        f"谷雨实验室 特稿 {year}": "谷雨：一个守灯塔的人",
        f"人物杂志 报道 {year}": "人物：退出大厂去修文物的年轻人",
        f"人间 theLivings 故事 {year}": "人间：我的父亲是刑警",
        f"IDFA 获奖纪录片 {year}": "IDFA获奖名单揭晓",
        f"圣丹斯 纪录片 获奖 {year}": "圣丹斯纪录片单元获奖名单",
        f"奥斯卡 最佳纪录片 提名 {year}": "奥斯卡最佳纪录片短名单公布",
        f"BBC Storyville 纪录片 {year}": "BBC Storyville新片单",
    }

    async def matrix_search(query: str) -> dict:
        return {
            "query": query,
            "results": [{"title": matrix_titles[query], "url": "https://example.com/a", "snippet": "snip", "provider": "tencent"}],
        }

    async def one_anniversary(start=None, days=45, max_concurrency=8):
        return [{"year": 1945, "text": "日本签署降伏文书，二战正式结束", "age": 81, "date": "2026-09-03"}]

    async def one_feed():
        return [{"title": "故事FM：一个守林人的三十年", "url": "https://storyfm.cn/ep1", "snippet": "守山", "feed": "故事FM"}]

    saved = (wikiday.anniversary_window, podcastfeed.fetch_all_feeds)
    wikiday.anniversary_window, podcastfeed.fetch_all_feeds = one_anniversary, one_feed
    try:
        curator = TopicCurator(flow_runner=fake_flow_runner, search=matrix_search)
        signals = await curator.collect_signals()
        by_type: dict[str, list[dict]] = {}
        for s in signals:
            by_type.setdefault(s["signal_type"], []).append(s)
        expect(len(by_type.get("material", [])) == 10, f"材料信号应 10 条（history4+crime4+science2）：{len(by_type.get('material', []))}")
        expect(len(by_type.get("validated", [])) == 5, f"已验证信号应特稿 4 + 播客 1：{len(by_type.get('validated', []))}")
        expect(len(by_type.get("benchmark", [])) == 4, f"对标信号应 4 条：{len(by_type.get('benchmark', []))}")
        expect(len(by_type.get("anniversary", [])) == 1, "周年信号应 1 条")
        expect(signals[0]["snippet"] == "snip", "搜索信号应带 snippet")
        pod = [s for s in by_type["validated"] if s["platform"] == "podcast"]
        expect(pod and pod[0]["source"] == "播客:故事FM", "播客信号应标注来源")
        ann = by_type["anniversary"][0]
        expect("81周年" in ann["title"] and ann["platform"] == "calendar", f"周年信号应带周年数：{ann['title']}")
    finally:
        wikiday.anniversary_window, podcastfeed.fetch_all_feeds = saved

    print("多源信号聚合 ✓")


asyncio.run(run_signal_matrix())


async def run_ideate() -> None:
    store.set_setting(wikiday.CACHE_KEY, "")  # 清掉多源专测留下的周年缓存

    curator = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
    result = await curator.run()
    expect(result.collected == 10, f"10 条材料种子（含 science2）× 每查 1 结果应采到 10 条，实际 {result.collected}")
    expect(result.batches == 2, f"10 条线索按 5 条/批应跑 2 次发散：{result.batches}")
    expect(result.directions == 30, f"每条线索发散 3 方向应得 30 个方向：{result.directions}")
    expect(result.created == 30, f"30 个方向各收敛一卡应产出 30 张生料卡：{result.created}")
    # 拒绝口径：每个收敛批带 3 条被拒样本（缺 arc ×2 + 复读卡）× 2 批 = 6；
    # 垂类卡在 arc 闸之前就被非法垂类拦下，不计入
    expect(result.rejected == 6, f"缺 arc 与 arc 复读 hook 的条目应被成立性闸拦下：{result.rejected}")
    expect(result.duplicates == 0, f"首轮无重复：{result.duplicates}")

    cards = store.list_topics(status="candidate", stage="raw")
    expect(len(cards) == 30, f"池内生料卡应 30 张：{len(cards)}")
    expect(all(c["stage"] == "raw" and c["tags"] == ["测试标签"] for c in cards), "生料卡应带 stage/tags")
    expect(all(len(c["arc"]) >= 12 and "题眼" in c["arc"][:12] for c in cards), "生料卡 arc 必须带题眼三段式（小事闸）")
    expect(all(len(c["heatEvidence"]) == 1 and c["heatEvidence"][0]["url"] for c in cards), "生料卡应锚定真实原型出处")
    anchor = next(c for c in cards if "甲骨" in c["title"])
    expect("甲骨" in anchor["heatEvidence"][0]["title"], "原型出处应回指线索条目（经方向对象透传）")
    anchor_cards = [c for c in cards if "甲骨" in c["title"]]
    expect(
        all(c["summary"].startswith("钩子") for c in anchor_cards),
        "生料卡摘要应为钩子",
    )
    expect(len(anchor_cards) == 3, f"同一线索的三个发散方向都应落卡：{len(anchor_cards)}")
    expect(len({c["title"] for c in anchor_cards}) == 3, "同线索不同方向的卡不应重样")

    # 幂等：原样重跑，当日已喂语料全部被消费指纹拦下 → 轮空不重喂
    again = await curator.run()
    expect(again.created == 0 and again.error.startswith("当日语料已全部喂过"), f"重跑应轮空：{again}")

    print("生料生成管线 ✓")


asyncio.run(run_ideate())


async def run_deep_dive() -> None:
    """点名深挖：证据足升级已深挖建议卡；证据薄底账留痕、卡仍是生料。"""
    cards = store.list_topics(status="candidate", stage="raw")
    jiagu = next(c for c in cards if "甲骨" in c["title"])
    other = next(c for c in cards if "甲骨" not in c["title"])

    curator = TopicCurator(flow_runner=fake_flow_runner, search=fake_search)
    outcome = await curator.deep_dive_one(store.get_topic(jiagu["id"]))
    expect(outcome == "upgraded", f"甲骨卡深挖应升级：{outcome}")
    got = store.get_topic(jiagu["id"])
    expect(got["stage"] == "verified" and got["angles"], "升级后应转已深挖并带角度")
    expect(got["research"]["evidence_level"] == "strong", "升级卡应为强证据")
    expect(got["research"]["chosen_template"] == "一件物", "深挖也应贯通角度择优")

    outcome2 = await curator.deep_dive_one(store.get_topic(other["id"]))
    expect(outcome2 == "thin", f"非甲骨卡深挖应仍薄：{outcome2}")
    got2 = store.get_topic(other["id"])
    expect(got2["stage"] == "raw", "证据仍薄应保持生料态")
    expect(got2["research"]["source_map"], "仍薄应把取证记入信源底账")

    # 同卡互斥：在跑的卡拒绝重复启动深挖任务
    topic_pool._rescan_inflight.add(other["id"])
    expect(topic_pool.start_deep_dive_job(store.get_topic(other["id"])) is None, "同卡在跑应拒绝重复启动")
    topic_pool._rescan_inflight.discard(other["id"])

    print("点名深挖 ✓")


asyncio.run(run_deep_dive())


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

    async def flaky(flow_id: str, input_value: str, tweaks=None) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            return '坏输出：他说"这不算 JSON"就完了'  # 未转义引号类坏输出
        return '[{"ok": true}]'

    curator = TopicCurator(flow_runner=flaky, search=fake_search)
    parsed = await curator._call_flow("verdict", {"x": 1})
    expect(parsed == [{"ok": True}] and calls["n"] == 2, f"坏输出应重试一次后成功：calls={calls['n']}")

    async def always_bad(flow_id: str, input_value: str, tweaks=None) -> str:
        calls["n"] += 1
        return "始终不是 JSON"

    calls["n"] = 0
    curator2 = TopicCurator(flow_runner=always_bad, search=fake_search)
    try:
        await curator2._call_flow("plan", {"x": 1})
        raise SystemExit("两次坏输出应抛错")
    except RuntimeError as exc:
        expect("两次解析失败" in str(exc) and calls["n"] == 2, f"应恰好尝试两次后报错：{exc}")

    async def engine_error(flow_id: str, input_value: str, tweaks=None) -> str:
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
raw_res = store.create_topic(
    vertical="history",
    title="生料卡不进自动复查",
    title_fingerprint=topic_pool.fingerprint_of("生料卡不进自动复查"),
    stage="raw",
)
with store._conn() as conn:
    conn.execute("UPDATE topics SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (raw_res["id"],))
expect(all(c["id"] != raw_res["id"] for c in store.list_rescan_candidates(3)), "生料卡不进自动复查轮转")
store.mark_rescanned(t_res["id"])
expect(store.list_rescan_candidates(3) == [], "复查后应再次被冷却挡住")

print("store 复查语义 ✓")

# ---------- 实体库 store：归一 / 别名 / 证据底账 ----------

e1 = entity_store.upsert_entity("person", "张德芳", summary="悬泉汉简整理人", evidence=[{"title": "报道A", "url": "https://e.com/a"}])
e2 = entity_store.upsert_entity("person", "张德芳", summary="", evidence=[{"title": "报道B", "url": "https://e.com/b"}, {"title": "报道A重发", "url": "https://e.com/a"}])
expect(e1["id"] == e2["id"], "同名同类型应归一")
expect(e2["summary"] == "悬泉汉简整理人", "已有 summary 不被空值覆盖")
expect(len(e2["evidence"]) == 2, "证据应按 url 去重追加")
e3 = entity_store.upsert_entity("person", "老张", aliases=["张德芳"], summary="")
expect(e3["id"] == e1["id"], "别名命中应归一到同一实体")
expect("老张" in e3["aliases"], "新名应并入别名")
expect(entity_store.upsert_entity("object", "张德芳")["id"] != e1["id"], "不同 kind 同名不归一")
expect(entity_store.list_entities(kind="person", q="悬泉")[0]["name"] == "张德芳", "搜索应命中摘要")
expect(len(entity_store.list_entities(kind="place")) == 0, "kind 筛选应生效")

print("实体库 store ✓")


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


# ---------- 刷新运行态：中断检测 ----------


class _NeverFinishesCurator:
    """卡死型 curator：验证 finally 清标记与中断落账。"""

    class _Stuck(Exception):
        pass

    async def run(self):
        await asyncio.sleep(3600)

    async def rescan_observations(self):
        return topic_pool.RescanSummary()


async def run_interrupted_state() -> None:
    svc = TopicRefreshService(curator=_NeverFinishesCurator())
    expect(svc.start(), "应能启动")
    expect(store.get_setting(topic_pool.RUN_STATE_KEY), "启动即写运行态标记")
    await asyncio.sleep(0.05)  # 让任务进入 run()
    task = svc._task
    assert task is not None
    task.cancel()  # 模拟服务重启杀任务（不触发 finally 之外的清理路径）
    try:
        await task
    except asyncio.CancelledError:
        pass
    # cancel 走 finally → 标记应已清；人为再放一个"孤儿标记"模拟硬杀（SIGTERM 无 finally）
    store.set_setting(topic_pool.RUN_STATE_KEY, json.dumps({"startedAt": "2099-01-01T00:00:00+00:00"}))
    svc.report_interrupted_run()
    lr = svc.last_run()
    expect("被中断" in str(lr.get("error", "")) and "finishedAt" not in lr, f"孤儿标记应落中断账：{lr}")
    expect(store.get_setting(topic_pool.RUN_STATE_KEY) in (None, ""), "检测后应清标记")
    # 早于已记录中断的标记（旧轮残留）不覆盖 2099 那次的账
    store.set_setting(topic_pool.RUN_STATE_KEY, json.dumps({"startedAt": "2000-01-01T00:00:00+00:00"}))
    svc.report_interrupted_run()
    expect(svc.last_run().get("interruptedAt") == "2099-01-01T00:00:00+00:00", "旧标记不应覆盖新中断账")
    # 坏 JSON 标记：清掉即可不报错
    store.set_setting(topic_pool.RUN_STATE_KEY, "{broken")
    svc.report_interrupted_run()
    expect(store.get_setting(topic_pool.RUN_STATE_KEY) in (None, ""), "坏标记应被清")
    print("刷新运行态中断检测 ✓")


asyncio.run(run_interrupted_state())


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
