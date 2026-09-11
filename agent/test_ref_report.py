"""考证报告单测：条目 → 报告（分节/来源底账/待补清单/era 口径）。

运行：cd agent && uv run python test_ref_report.py
不需要 langflow / LLM / 网络——临时库注入，只测纯函数。

背景：调研产物此前只活在 agent 内存（简报）与前端轮询回调（落卡）里，
生产库实测 23 个项目资产卡 researchBrief 全零、refSource 零命中。条目表是
服务端权威落点，报告是它的人读视图——本测试锁「报告如实反映库里的东西」。
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import tempfile
from pathlib import Path

import imgresearch
import jobstore

_tmp = Path(tempfile.mkdtemp(prefix="ws-report-test-"))
imgresearch.DB_PATH = _tmp / "test.db"
jobstore.DB_PATH = imgresearch.DB_PATH

PASS = [0]


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(imgresearch.DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def seed_project(pid: str, name: str) -> None:
    with _db() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT)"
        )
        c.execute("INSERT OR REPLACE INTO projects (id, name) VALUES (?, ?)", (pid, name))


def seed_canvas(pid: str, nodes: list, meta: dict | None = None) -> None:
    with _db() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS canvases ("
            "project_id TEXT PRIMARY KEY, nodes TEXT, meta TEXT)"
        )
        c.execute(
            "INSERT OR REPLACE INTO canvases (project_id, nodes, meta) VALUES (?,?,?)",
            (pid, json.dumps(nodes, ensure_ascii=False), json.dumps(meta or {}, ensure_ascii=False)),
        )


imgresearch.init_ref_research_db()

PID = "p-northwei"
seed_project(PID, "冯太后")
seed_canvas(
    PID,
    [
        {"id": "n_feng", "data": {"nodeType": "character", "title": "冯太后"}},
        {"id": "n_hall", "data": {"nodeType": "scene", "title": "平城朝堂"}},
        {"id": "n_robe", "data": {"nodeType": "costume", "title": "太后朝服"}},
        # 无考据的资产（报告「待补」段）
        {"id": "n_sword", "data": {"nodeType": "prop", "title": "环首刀"}},
        # 有已采纳参考图但无文字考据（早期调研简报未落库的形态）：真待补不该算它
        {"id": "n_chair", "data": {"nodeType": "prop", "title": "龙椅"}},
        # 空名卡不进报告（未命名资产不进 @ 名单，也不该进报告）
        {"id": "n_blank", "data": {"nodeType": "character", "title": ""}},
        # 非资产卡不进报告
        {"id": "n_topics", "data": {"nodeType": "note", "title": "选题池"}},
    ],
    {"era": "北魏·平城时期"},
)

imgresearch.upsert_entry(
    PID,
    body="北魏早期服饰窄袖交领，鲜卑辫发，勿用唐宋式样。",
    node_id="n_feng",
    asset_name="冯太后",
    asset_type="character",
    era="北魏·平城时期",
    sources=[
        {"title": "北魏服饰考", "url": "https://a.example/1", "domain": "a.example"},
        {"title": "平城考", "url": "https://b.example/2", "domain": "b.example"},
    ],
)
imgresearch.upsert_entry(
    PID,
    body="平城宫殿为夯土木构，雄浑简朴，无明清彩画。",
    node_id="n_hall",
    asset_name="平城朝堂",
    asset_type="scene",
    era="北魏·平城时期",
    sources=[{"title": "平城考古", "url": "https://a.example/3", "domain": "a.example"}],
)
# 改过名的资产：条目按旧名存，画布上是新名——靠 node_id 仍命中（改名不失联）
imgresearch.upsert_entry(
    PID,
    body="太后朝服用翟鸟纹，深衣制。",
    node_id="n_robe",
    asset_name="朝服（原名）",
    asset_type="costume",
    era="北魏·平城时期",
)
# 卡已删但条目还在：报告仍列出（条目不因卡没了就消失）
imgresearch.upsert_entry(
    PID,
    body="漆器以朱黑二色为主。",
    node_id="n_gone",
    asset_name="漆案",
    asset_type="prop",
    era="北魏·平城时期",
)

# 已采纳参考图（底账段）。最后一条挂在**已不在画布上**的节点上（卡删了、候选
# 还采纳着）：头部「覆盖 M 个」只该数画布资产，否则「覆盖 + 待补 = 资产数」对不上
with _db() as c:
    for i, (nid, title, dom) in enumerate(
        [
            ("n_feng", "冯太后像", "commons.wikimedia.org"),
            ("n_feng", "北魏壁画", "baike.baidu.com"),
            ("n_hall", "平城遗址", "baike.baidu.com"),
            ("n_chair", "龙椅实物", "chnmus.net"),
            ("n_gone", "漆案残件", "chnmus.net"),
        ]
    ):
        c.execute(
            """INSERT INTO ref_candidates (id, project_id, node_id, query, provider,
               title, page_url, source_domain, source_url, asset_url, width, height,
               adopted, recommended, rec_reason, created_at, idx_total)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,'',?,0)""",
            (
                f"c{i}",
                PID,
                nid,
                "q",
                "google",
                title,
                "https://page",
                dom,
                f"https://{dom}/src{i}",
                f"http://127.0.0.1:8123/assets/ref{i}.jpg",
                800,
                600,
                "2026-09-10T00:00:00.000Z",
            ),
        )

report = imgresearch.build_report(PID)
text = report["text"]

# A. 头部口径（三口径：2026-09-11 口径事故后，参考图家底与文字考据分开报，
#    「待补」只数缺参考图的真待办——旧「待补 70」把 52 个参考图调研成功的
#    资产也计成待补，用户读作「全部失败」）
expect(report["projectName"] == "冯太后", "报告应带项目名")
expect(report["era"] == "北魏·平城时期", "报告应带 era 口径")
expect("《冯太后》资产考证报告" in text, f"应有报告标题：{text[:80]}")
expect("时代/题材：北魏·平城时期" in text, "标题下应明标时代口径")
expect(
    "资产 5 个 ｜ 参考图已采纳 4 张、覆盖 3 个 ｜ 文字考据 3 个 ｜ 缺参考图待补 2 个" in text,
    f"头部应三口径如实分开报：{text.splitlines()[2] if len(text.splitlines())>2 else text}",
)

# A2. 头部算术自洽：覆盖 + 待补 = 资产数（覆盖只数画布上的卡——夹具里 n_gone
#     是「卡已删、候选仍采纳着」的孤儿，算进去就成了 4+2≠5 的自相矛盾）
_m = re.search(r"资产 (\d+) 个 ｜ .*覆盖 (\d+) 个 .*缺参考图待补 (\d+) 个", text)
expect(
    bool(_m) and int(_m.group(2)) + int(_m.group(3)) == int(_m.group(1)),
    f"覆盖 + 待补应等于资产数：{_m.groups() if _m else '头部不匹配'}",
)

# B. 考据事实分节（条目上卡）
expect("■ 冯太后（角色）" in text, "已考据资产应成节")
expect("鲜卑辫发" in text, "条目正文应进报告")
expect("—— 来源：a.example、b.example" in text, f"应按条目来源出底账：{text}")

# C. 改名资产靠 node_id 命中（不靠名字）
expect("■ 太后朝服（服饰）" in text, "改名资产应按 node_id 命中并显示新名")
expect("翟鸟纹" in text, "改名资产的条目正文应在")

# D. 删卡的条目仍列出
expect("漆案" in text, "卡已删除的条目仍应列出（条目不以卡的存在为前提）")
expect("■ 漆案（道具）（画布上已无此卡）" in text, f"删卡条目应标明：{text}")

# E. 待补清单分级（2026-09-11 定死）：待补 = 缺已采纳参考图的资产（这一类
#    才是「补调研」能救的）；有参考图无文字考据 = 次级说明不进按钮清单
expect("三、待补清单（缺参考图 2 个资产）" in text, f"应报真待补数量：{text}")
expect("· 环首刀（道具）" in text, "待补应点名到卡")
# 有文无图（091101 武则天项目的形态：文字考据全到、图路没跑过）——
# 旧口径漏掉整类、头部显示「覆盖 0 个 ｜ 待补 0 个」，恢复入口也不出现
expect(
    "· 太后朝服（服饰）——已有文字考据，只缺参考图" in text,
    f"有文无图的资产应进待补并标注只缺参考图：{[l for l in text.splitlines() if '太后朝服' in l]}",
)
expect(
    report["missing"] == [
        {"nodeId": "n_sword", "title": "环首刀", "nodeType": "prop"},
        {"nodeId": "n_chair", "title": "龙椅", "nodeType": "prop"},
    ],
    f"missing 保持文字维度全集：{report['missing']}",
)
expect(
    report["pendingAssets"] == [
        {"nodeId": "n_robe", "name": "太后朝服", "type": "costume"},
        {"nodeId": "n_sword", "name": "环首刀", "type": "prop"},
    ],
    f"真待办清单 = 缺参考图的（含只缺图的）：{report['pendingAssets']}",
)
expect("另有 1 个资产参考图已采纳、文字考据未存档" in text, "次级缺口应说明成因")
expect("龙椅" in text.split("另有 1 个资产参考图已采纳")[1][:120], "次级缺口应点名资产")
expect("不用重跑调研" in text, "次级缺口应指路（大纲/自动补考据），不误导重跑")
expect(
    not any(m["title"] == "" for m in report["missing"]),
    "空名资产卡不进待补（未命名资产不进 @ 名单）",
)
expect(
    not any(m["title"] == "选题池" for m in report["missing"]),
    "非资产卡不进待补",
)

# E2. 待补行带「上次失败」：jobstore 镜像里 error 项的错误透传到报告
jobstore.create_job("batch-err", "ref_batch", {"projectId": PID})
jobstore.finish_job(
    "batch-err",
    {
        "projectId": PID,
        "batchId": "batch-err",
        "items": [
            {
                "nodeId": "n_sword",
                "name": "环首刀",
                "status": "error",
                "error": "候选图全部下载失败（疑似外链防盗链）；下载：xxx：403",
                "retried": True,
            },
            {"nodeId": "n_feng", "name": "冯太后", "status": "done", "error": "", "retried": False},
        ],
    },
)
text2 = imgresearch.build_report(PID)["text"]
expect(
    "· 环首刀（道具）——上次失败：候选图全部下载失败" in text2,
    f"待补行应带上次失败原因：{[l for l in text2.splitlines() if '环首刀' in l]}",
)
expect(
    imgresearch.build_report("p-key")["text"].count("上次失败") == 0,
    "别的项目不受镜像串扰",
)

# F. 参考图底账
expect("二、参考图底账（已采纳 4 张）" in text, f"应报已采纳总数：{text}")
expect("■ 冯太后（2 张）" in text, "底账应按资产分组计张数")
expect("■ 龙椅（1 张）" in text, "只缺文字考据的资产也进底账（参考图家底是实的）")
expect("commons.wikimedia.org" in text, "底账应含来源域名")

# G. 结构化载荷（前端对账用）
expect(len(report["entries"]) == 4, f"条目应全量返回：{len(report['entries'])}")
adopted_nodes = {g["nodeId"] for g in report["adopted"]}
expect(adopted_nodes == {"n_feng", "n_hall", "n_chair", "n_gone"},
       f"采纳分组按节点全量返回（含画布外的孤儿，前端物化时自己过滤）：{adopted_nodes}")
expect(all(c["adopted"] for g in report["adopted"] for c in g["candidates"]),
       "采纳分组只含 adopted=1 的候选")

# H. 边界：空项目 / 未知项目不炸，且不虚构内容
empty = imgresearch.build_report("p-empty")
expect(empty["entries"] == [] and empty["missing"] == [], "空项目应给空报告")
expect("（暂无——在资产卡「找参考图」发起调研后" in empty["text"], "空项目报告应给人话引导")
expect("（画布资产的参考图已齐）" in empty["text"], "无资产时待补段应说明")
expect(imgresearch.build_report("p-不存在")["projectName"] == "", "未知项目应给空项目名")

# I. 归属键：有 node_id 用 id（改名不失联），无 id 按名归一（空格/标点不敏感）
imgresearch.upsert_entry(
    "p-key", body="v1", node_id="", asset_name="官 服", era="明代"
)
imgresearch.upsert_entry(
    "p-key", body="v2", node_id="", asset_name="官服。", era="明代"
)
key_entries = imgresearch.list_entries("p-key")
expect(len(key_entries) == 1, f"同名（标点空格差异）应覆盖不新增：{key_entries}")
expect(key_entries[0]["body"] == "v2", "重跑语义：后写覆盖前写")

# J. 主体全库唯一：同 era 同名归并成一条（后写覆盖），不同 era 各自成主体
imgresearch.upsert_entry("p-key", body="甲", node_id="n1", asset_name="官服", era="明代")
imgresearch.upsert_entry("p-key", body="乙", node_id="n2", asset_name="官服", era="明代")
entries = imgresearch.list_entries("p-key")
expect(len(entries) == 1, f"同名同 era 应归并成一个主体：{entries}")
expect(entries[0]["body"] == "乙", "主体唯一，后写覆盖前写")
expect(
    imgresearch.lookup_subject("明代", "asset", "官服")["body"] == "乙",
    "库里只有一条权威版本",
)
imgresearch.upsert_entry("p-key", body="宋制", node_id="n3", asset_name="官服", era="宋代")
expect(len(imgresearch.list_entries("p-key")) == 2, "不同 era 的同名资产是两个主体")
# 引用表：同一主体被多个节点引用各留一条（主体去重，引用不去重）
with imgresearch._conn() as _c:
    targets = {
        r[0]
        for r in _c.execute(
            "SELECT target_key FROM research_uses"
            " WHERE project_id='p-key' AND target_kind='node'"
        )
    }
expect(targets == {"n1", "n2", "n3"}, f"每个引用节点各留一条：{targets}")

# K. 空正文拒收（不写半条脏数据）
try:
    imgresearch.upsert_entry("p-key", body="   ", node_id="n3", asset_name="X")
    raise AssertionError("空正文应报错")
except ValueError:
    PASS[0] += 1

# ---------- L. 考证大纲（主题层） ----------
# L1. 整份替换与顺序
imgresearch.replace_topics(
    PID,
    [
        {"title": "北魏早期服制", "rationale": "角色与服饰共享同一套形制",
         "queries": ["北魏 服饰 形制", "鲜卑 发式"], "nodeIds": ["n_feng", "n_robe"]},
        {"title": "平城宫室形制", "queries": ["平城 宫殿 木构"], "nodeIds": ["n_hall"]},
    ],
)
topics = imgresearch.list_topics(PID)
expect([t["topicKey"] for t in topics] == ["北魏早期服制", "平城宫室形制"], f"主题应按建立序：{topics}")
expect(topics[0]["nodeIds"] == ["n_feng", "n_robe"], "主题应带服务卡")
expect(topics[0]["status"] == "planned", "新主题状态应为待执行")

# L2. 防幻觉：不存在的 node id 报错并列出可用卡
try:
    imgresearch.replace_topics(PID, [{"title": "X", "nodeIds": ["n_bogus"]}])
    raise AssertionError("不存在的 node id 应报错")
except ValueError as exc:
    expect("n_bogus" in str(exc) and "冯太后" in str(exc), f"报错要点名并给可用卡：{exc}")
    PASS[0] += 1

# L3/L4. 空大纲与重复主题键拒收
for bad, why in (([], "空大纲"), ([{"title": "A"}, {"title": "A。"}], "重复主题键")):
    try:
        imgresearch.replace_topics(PID, bad)
        raise AssertionError(f"{why} 应报错")
    except ValueError:
        PASS[0] += 1

# L5. 整份替换：重新提交只剩一个主题，另一个被删
imgresearch.replace_topics(PID, [{"title": "北魏早期服制", "nodeIds": ["n_feng"]}])
expect([t["topicKey"] for t in imgresearch.list_topics(PID)] == ["北魏早期服制"],
       "整份替换应删掉不在新大纲里的主题")

# L6. 大纲视图
outline = imgresearch.build_outline_report(PID)
expect("《冯太后》考证大纲" in outline["text"], f"应有标题：{outline['text'][:60]}")
expect("■ 北魏早期服制（服务 1 张卡 · 待执行）" in outline["text"], f"应报服务卡数与状态：{outline['text']}")
expect("未被任何主题覆盖的资产" in outline["text"] and "环首刀" in outline["text"],
       "应点名未被主题覆盖的资产（缺口清单）")
expect("环首刀" in [a["title"] for a in outline["uncovered"]],
       f"缺口应结构化返回：{outline['uncovered']}")
expect(len(outline["uncovered"]) == 4, "只服务 n_feng 的主题之下，另 4 张卡（含龙椅）都是缺口")

# L7. 主题执行产物 → 按服务范围分发（topic_briefs）
imgresearch.upsert_entry(
    PID, body="北魏早期服制：窄袖交领左衽，鲜卑辫发。", asset_name="北魏早期服制",
    asset_type="topic", era="北魏·平城时期", topic_key="北魏早期服制",
)
imgresearch.upsert_entry(
    PID, body="平城宫室：夯土台基木构。", asset_name="平城宫室形制",
    asset_type="topic", era="北魏·平城时期", topic_key="平城宫室形制",
)
by_node, by_name = imgresearch.topic_briefs(PID)
expect("北魏早期服制" in [t[0] for t in by_node.get("n_feng", [])], f"主题应分发到服务卡：{by_node}")
expect(by_node.get("n_robe", []) == [], f"已移出大纲的主题不再分发：{by_node.get('n_robe')}")
expect("冯太后" in by_name and by_name["冯太后"][0][0] == "北魏早期服制", "应按资产名也有索引")

# L7b. 主题执行命中库：记引用 + 标 reused，且一次搜索都不发（活引用不拷贝）
seed_project("p-src-topic", "宋辽项目")
seed_canvas(
    "p-src-topic",
    [{"id": "n_a", "data": {"nodeType": "character", "title": "宋将"}}],
    {"era": "宋辽"},
)
imgresearch.replace_topics("p-src-topic", [{"title": "宋辽甲胄", "nodeIds": ["n_a"]}])
imgresearch.upsert_entry(
    "p-src-topic", body="宋辽甲胄：步人甲以札叶连缀，重量惊人。", asset_name="宋辽甲胄",
    asset_type="topic", era="宋辽", topic_key="宋辽甲胄",
)
seed_canvas("p-reuse-topic", [{"id": "n_b", "data": {"nodeType": "character", "title": "宋兵"}}],
            {"era": "宋辽"})
imgresearch.replace_topics("p-reuse-topic", [{"title": "宋辽甲胄", "nodeIds": ["n_b"]}])


async def _boom(*_a, **_k):
    raise AssertionError("库命中不该再搜")


_orig_text = imgresearch._run_text_research
imgresearch._run_text_research = _boom
try:
    asyncio.run(
        imgresearch._run_topic("p-reuse-topic", "宋辽甲胄", asyncio.Semaphore(1))
    )
finally:
    imgresearch._run_text_research = _orig_text
_t = [x for x in imgresearch.list_topics("p-reuse-topic") if x["topicKey"] == "宋辽甲胄"][0]
expect(_t["status"] == "reused", f"库命中应标 reused：{_t}")
expect(_t["reusedFrom"] == "宋辽项目", f"出处应记项目名：{_t['reusedFrom']}")
rb_node, _ = imgresearch.topic_briefs("p-reuse-topic")
expect("札叶连缀" in (rb_node.get("n_b") or [["", ""]])[0][1],
       f"复用主题应分发源项目事实：{rb_node}")
# 源项目改进 → 引用方跟着变（活引用，不拷副本）
imgresearch.upsert_entry(
    "p-src-topic", body="宋辽甲胄：札叶连缀（修订：皮甲为主）。", asset_name="宋辽甲胄",
    asset_type="topic", era="宋辽", topic_key="宋辽甲胄",
)
rb_node2, _ = imgresearch.topic_briefs("p-reuse-topic")
expect("皮甲为主" in (rb_node2.get("n_b") or [["", ""]])[0][1], "源主体更新应传到引用方")
# 库命中之后重跑不重复执行（有产物即完成）
expect(imgresearch.run_topics("p-reuse-topic") == [], "已有主体引用的主题不进待办")
offline, _ = imgresearch.topic_briefs("p-no-such-project")
expect(offline == {}, "未知项目应给空索引")

# L8. 报告：大纲进第一节，段号顺移，参考图底账与待补仍在
# 前置：恢复成服务多张卡的大纲（第二轮替换——同一项目可以整份换计划）
imgresearch.replace_topics(
    PID,
    [
        {"title": "北魏早期服制", "queries": ["北魏 服饰 形制"], "nodeIds": ["n_feng", "n_robe"]},
        {"title": "平城宫室形制", "queries": ["平城 宫殿"], "nodeIds": ["n_hall"]},
    ],
)
report2 = imgresearch.build_report(PID)
expect("一、考证大纲（2 个主题 · 已完成 2）" in report2["text"], f"大纲应进报告首节：{report2['text'][:400]}")
expect("二、考据事实" in report2["text"], "资产考据段应顺移为第二节")
expect("三、参考图底账" in report2["text"] and "四、待补清单" in report2["text"], "其余段号顺移")
expect("＋主题考据〈北魏早期服制〉" in report2["text"], "资产段应指向服务它的主题考据")
expect("■ 冯太后（角色）" in report2["text"], "资产自己的条目仍在")

# L9. cardBriefs = 本资产条目 + 服务它的主题条目（卡上显示的 = 出图发出去的）
cb = report2["cardBriefs"]
expect("北魏早期服制" in cb.get("n_feng", ""), f"卡面简报应含主题考据：{cb.get('n_feng')}")
expect("鲜卑辫发" in cb.get("n_feng", "") and "窄袖交领" in cb.get("n_feng", ""),
       "卡面简报应既有资产自己的条目也有主题条目")
expect("北魏早期服制" in cb.get("n_robe", ""), "改名的服饰卡应按 node_id 拿到主题考据")
expect("n_sword" not in cb, "无任何考据的资产不进卡面简报")

# ---------- M. 「被主题覆盖」算已有考据 ----------
# 主题覆盖成员资产，但主题自己还没事实（没执行过）→ 成员卡仍算待补
imgresearch.replace_topics(
    PID,
    [
        {"title": "北魏早期服制", "queries": ["q"], "nodeIds": ["n_feng", "n_robe"]},
        {"title": "平城宫室形制", "queries": ["q"], "nodeIds": ["n_hall"]},
        {"title": "北魏兵器", "queries": ["q"], "nodeIds": ["n_sword"]},
        {"title": "北魏宫廷陈设", "queries": ["q"], "nodeIds": ["n_chair"]},
    ],
)
m1 = imgresearch.build_report(PID)
expect([m["nodeId"] for m in m1["missing"]] == ["n_sword", "n_chair"],
       f"主题没事实时成员卡仍待补：{m1['missing']}")
expect("四、待补清单（缺参考图 2 个资产）" in m1["text"], f"段号与计数应一致：{m1['text'][-300:]}")

# 主题有了事实 → 成员卡（哪怕没有自己的条目）不再进待补，报告里指向主题
imgresearch.upsert_entry(
    PID, body="北魏兵器：环首刀直刃长身，刀环作扁圆。", asset_name="北魏兵器",
    asset_type="topic", era="北魏·平城时期", topic_key="北魏兵器",
)
imgresearch.upsert_entry(
    PID, body="北魏宫廷陈设：帷帐矮榻，席地而坐。", asset_name="北魏宫廷陈设",
    asset_type="topic", era="北魏·平城时期", topic_key="北魏宫廷陈设",
)
m2 = imgresearch.build_report(PID)
expect(m2["missing"] == [], f"主题覆盖后不该再催用户：{m2['missing']}")
# 文字维度清零了，参考图维度照旧（这两张从没采纳过参考图）——两个维度互不掩盖
expect(
    [p["nodeId"] for p in m2["pendingAssets"]] == ["n_robe", "n_sword"],
    f"文字补齐不该把缺参考图的从待办里放走：{m2['pendingAssets']}",
)
expect("四、待补清单（缺参考图 2 个资产）" in m2["text"] and "（画布资产的参考图已齐）" not in m2["text"],
       f"待补非空时不该说已齐：{m2['text'][-300:]}")
expect("■ 环首刀（道具）" in m2["text"], "只有主题覆盖的卡也应成节")
expect("＋主题考据〈北魏兵器〉" in m2["text"], "该节应指向服务它的主题")
expect("环首刀直刃长身" in m2["cardBriefs"].get("n_sword", ""),
       f"只有主题覆盖的卡也要有卡面简报：{m2['cardBriefs'].get('n_sword')}")

# N. 取消采纳（删参考卡 = 这张参考不要了；候选行保留，仍在面板里可重新采纳）
adopted_before = imgresearch.adopted_by_node(PID)
c_first = adopted_before["n_feng"][0]
out_rows = imgresearch.unadopt_candidates(PID, "n_feng", [c_first["id"]])
expect(
    not next(c for c in out_rows if c["id"] == c_first["id"])["adopted"],
    "取消采纳后该候选 adopted 应为 0",
)
expect(
    len(imgresearch.adopted_by_node(PID)["n_feng"]) == len(adopted_before["n_feng"]) - 1,
    "已采纳分组应少一张（对账不会再物化它）",
)
expect(
    any(c["id"] == c_first["id"] for c in imgresearch.list_candidates(PID, "n_feng")),
    "候选行应保留（只摘采纳，不删候选）",
)
# 对账口径：卡被删后服务端也不该再把它算作采纳
expect(
    c_first["id"] not in {c["id"] for c in imgresearch.adopted_by_node(PID).get("n_feng", [])},
    "取消采纳的候选不得出现在 adopted_by_node",
)
# 幂等 / 容忍脏参数
imgresearch.unadopt_candidates(PID, "n_feng", [c_first["id"]])
expect(imgresearch.unadopt_candidates(PID, "n_feng", []) == imgresearch.list_candidates(PID, "n_feng"),
       "空 ids 应原样返回候选列表")
expect(imgresearch.unadopt_candidates(PID, "", ["x"]) == [], "空 node_id 返回空列表（不炸）")

print(f"✅ 考证报告 {PASS[0]} 项断言全部通过")
