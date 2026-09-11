"""出图考据单测：画布 researchBrief → 出图载荷 visual_notes，以及真实题材的补考据。

运行：cd agent && uv run python test_asset_research_brief.py
不需要 langflow / LLM / 网络——临时库注入 + 考据函数换绑，只测纯函数。

覆盖两条注入路径（画布出图带 rid / 聊天出图只有资产名）、题材开关
（meta.factuality，缺省 real）、以及缺简报时的补考据与进程内缓存。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
from pathlib import Path

import eventbus
import imagejobs
import imgresearch
import skills

# ---------- 临时库（照 test_research.py 范式换绑 DB_PATH） ----------
_tmp = Path(tempfile.mkdtemp(prefix="ws-brief-test-"))
skills.DB_PATH = _tmp / "test.db"
# 考据条目（imgresearch.research_entries）也落同一个临时库：条目是出图注入的
# 权威来源，_entry_briefs / 补考据落库都走它
imgresearch.DB_PATH = skills.DB_PATH
imgresearch.init_ref_research_db()

PASS = [0]


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


def seed_canvas(project_id: str, nodes: list, meta: dict | None = None) -> None:
    conn = sqlite3.connect(str(skills.DB_PATH))
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS canvases ("
            "project_id TEXT PRIMARY KEY, nodes TEXT, meta TEXT)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO canvases (project_id, nodes, meta) VALUES (?, ?, ?)",
            (
                project_id,
                json.dumps(nodes, ensure_ascii=False),
                json.dumps(meta or {}, ensure_ascii=False),
            ),
        )
        conn.commit()
    finally:
        conn.close()


PID = "p-brief-1"
BRIEF_A = "明代文官补服为禽鸟纹，切勿用清代蟒袍。来源：故宫博物院"
BRIEF_B = "宋代点茶用黑釉建盏，非白瓷。来源：中国茶叶博物馆"

seed_canvas(
    PID,
    [
        {"id": "n_a", "data": {"nodeType": "character", "title": "沈大人", "researchBrief": BRIEF_A}},
        {"id": "n_b", "data": {"nodeType": "prop", "title": "茶盏", "researchBrief": BRIEF_B}},
        {"id": "n_c", "data": {"nodeType": "scene", "title": "荒山"}},
        {"id": "n_d", "data": {"nodeType": "character", "title": "空白简报", "researchBrief": "   "}},
    ],
)

# A. 读取：两张索引只收非空简报；空 project_id / 未知项目返回两张空表
by_id, by_title = skills._canvas_research_briefs(PID)
expect(by_id == {"n_a": BRIEF_A, "n_b": BRIEF_B}, f"按 id 索引应只含非空简报：{by_id}")
expect(by_title == {"沈大人": BRIEF_A, "茶盏": BRIEF_B}, f"按标题索引不符：{by_title}")
expect(skills._canvas_research_briefs("") == ({}, {}), "空 project_id 应返回两张空表")
expect(skills._canvas_research_briefs("p-不存在") == ({}, {}), "未知项目应返回两张空表")

# B. 注入：纯节点 id（资产卡直出 / 补资产图），与原有视觉要点共存
out = skills._inject_research_briefs(
    [{"rid": "n_a", "name": "沈大人", "visual_notes": "全局视觉风格：水墨"}], PID
)
expect(out[0]["visual_notes"].startswith("全局视觉风格：水墨"), "应保留原有 visual_notes")
expect(BRIEF_A in out[0]["visual_notes"], f"考据应并入 visual_notes：{out[0]['visual_notes']}")
expect("考据依据" in out[0]["visual_notes"], "应带「考据依据」标记")
expect("；" in out[0]["visual_notes"], "两段应以「；」分隔")

# C. 注入：{节点id}#{序号} 形态（图片卡 / 分镜行出图）剥离后命中
out = skills._inject_research_briefs([{"rid": "n_b#0", "visual_notes": ""}], PID)
expect(BRIEF_B in out[0]["visual_notes"], f"#序号 rid 应剥离后命中：{out}")

# D. 注入：聊天侧载荷没有 rid，按资产名命中
out = skills._inject_research_briefs(
    [{"name": "沈大人", "visual_notes": "全局视觉风格：水墨"}], PID
)
expect(BRIEF_A in out[0]["visual_notes"], f"聊天侧按资产名应命中：{out[0]}")

# E. 聊天侧资产名没匹配上 → 原样放行
shot = {"name": "路人甲", "visual_notes": "全局视觉风格：水墨"}
expect(skills._inject_research_briefs([shot], PID)[0] == shot, "未匹配资产不应被改动")

# F. 无简报的资产原样放行（不新增键、不改内容）
shot_c = {"rid": "n_c", "visual_notes": "全局视觉风格：水墨"}
expect(skills._inject_research_briefs([shot_c], PID)[0] == shot_c, "无简报资产不应被改动")

# G. 纯空白简报同样不注入
shot_d = {"rid": "n_d", "visual_notes": "全局视觉风格：水墨"}
expect(skills._inject_research_briefs([shot_d], PID)[0] == shot_d, "空白简报不应注入")

# H. camelCase 键名（前端载荷）沿用原键、保留原值
out = skills._inject_research_briefs(
    [{"rid": "n_a", "visualNotes": "全局视觉风格：油画"}], PID
)
expect("visualNotes" in out[0] and "visual_notes" not in out[0], f"应沿用原键名：{out[0]}")
expect(out[0]["visualNotes"].startswith("全局视觉风格：油画"), "原键值应保留")
expect(BRIEF_A in out[0]["visualNotes"], "考据应并入原键")

# I. 空 notes 时不产生前导「；」
out = skills._inject_research_briefs([{"rid": "n_a", "visual_notes": ""}], PID)
expect(out[0]["visual_notes"].startswith("考据依据"), f"空 notes 不应有前导分号：{out[0]}")

# J. project_id 为空 / 项目无简报：原样返回（不读库）
shots = [{"rid": "n_a", "visual_notes": "全局视觉风格：水墨"}]
expect(skills._inject_research_briefs(shots, "") == shots, "空 project_id 应原样返回")
shots = [{"rid": "n_x", "visual_notes": "全局视觉风格：水墨"}]
expect(skills._inject_research_briefs(shots, "p-空") == shots, "无简报项目应原样返回")

# K. 坏数据不炸（nodes 非列表 / 元素非 dict / data 非 dict）
seed_canvas("p-坏", [])
conn = sqlite3.connect(str(skills.DB_PATH))
try:
    conn.execute(
        "INSERT OR REPLACE INTO canvases (project_id, nodes, meta) VALUES (?, ?, '{}')",
        ("p-坏2", json.dumps(["不是对象", {"id": "x", "data": "不是对象"}])),
    )
    conn.commit()
finally:
    conn.close()
expect(skills._canvas_research_briefs("p-坏") == ({}, {}), "空 nodes 应返回两张空表")
expect(skills._canvas_research_briefs("p-坏2") == ({}, {}), "坏元素应跳过而不抛错")

# L. 线程 → 项目 解析（聊天侧注入的项目来源）
conn = sqlite3.connect(str(skills.DB_PATH))
try:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, project_id TEXT)"
    )
    conn.execute(
        "INSERT OR REPLACE INTO chat_threads (id, project_id) VALUES (?, ?)", ("t-1", PID)
    )
    conn.commit()
finally:
    conn.close()
expect(
    skills._project_id_from_config({"configurable": {"thread_id": "t-1"}}) == PID,
    "线程应解析出所属项目 id",
)
expect(
    skills._project_id_from_config({"configurable": {"thread_id": "t-无"}}) == "",
    "未知线程应返回空串",
)
expect(skills._project_id_from_config(None) == "", "空 config 应返回空串")

# M. 题材解析：缺省与脏值一律真实题材，只有显式 fiction 才跳过考据
seed_canvas("p-real", [], {})
seed_canvas("p-fiction", [], {"factuality": "fiction"})
seed_canvas("p-dirty", [], {"factuality": "动画"})
expect(skills._project_factuality("p-real") == "real", "无 meta 应默认真实题材")
expect(skills._project_factuality("p-fiction") == "fiction", "显式 fiction 应识别")
expect(skills._project_factuality("p-dirty") == "real", "脏值应回落真实题材")
expect(skills._project_factuality("") == "real", "空 project_id 应默认真实题材")

# ---------- 补考据（换绑单资产考据函数，不触网） ----------
orig_brief_for = skills._research_brief_for
calls: list = []


async def fake_brief_for(asset):
    calls.append(asset["name"])
    if asset["name"] == "会失败":
        raise RuntimeError("模拟搜索失败")
    return (
        "补出的考据：明代腰牌为铜制，刻官职与编号",
        [{"title": "明代腰牌考", "url": "https://example.com/pai", "domain": "example.com"}],
    )


skills._research_brief_for = fake_brief_for
skills._BRIEF_CACHE.clear()
brief_sem = asyncio.Semaphore(2)

# N. 补考据：跳过与幂等
shot_fiction = {"name": "动画角色", "visual_notes": "风格：日式动画"}
out = asyncio.run(
    skills._ensure_research_brief(shot_fiction, "p-fiction", "fiction", brief_sem)
)
expect(out == shot_fiction, "虚构题材应原样放行")
shot_has = {"name": "沈大人", "visual_notes": "考据依据（…）：旧简报"}
out = asyncio.run(skills._ensure_research_brief(shot_has, PID, "real", brief_sem))
expect(out == shot_has, "已带考据的载荷应原样放行（不重复搜）")
out = asyncio.run(skills._ensure_research_brief({"name": "X"}, "", "real", brief_sem))
expect(out == {"name": "X"}, "空 project_id 应放行")

# O. 补考据：真实题材无简报时现补，保留原要点
shot_new = {
    "name": "新道具",
    "description": "明代腰牌",
    "visual_notes": "全局视觉风格：水墨",
}
out = asyncio.run(skills._ensure_research_brief(shot_new, "p-real", "real", brief_sem))
expect("补出的考据" in out["visual_notes"], f"应补出考据：{out}")
expect("全局视觉风格：水墨" in out["visual_notes"], "原视觉要点应保留")

# P. 补考据：同资产再次出图走进程内缓存，不重复搜索
asyncio.run(skills._ensure_research_brief(shot_new, "p-real", "real", brief_sem))
expect(calls.count("新道具") == 1, f"缓存应生效（只搜一次）：{calls}")

# Q. 补考据：失败软放行（不拦出图）+ 留「未考证」痕（软失败不许无声）
shot_fail = {"name": "会失败", "visual_notes": "全局视觉风格：水墨"}
out = asyncio.run(skills._ensure_research_brief(shot_fail, "p-real", "real", brief_sem))
expect(
    out.get("visual_notes") == shot_fail["visual_notes"],
    "考据失败应原样放行（提示词不加料）",
)
expect(
    str(out.get("_researchNote") or "").startswith("未考证"),
    f"考据失败应留痕：{out.get('_researchNote')!r}",
)
expect("考据依据" not in str(out.get("visual_notes") or ""), "失败不该伪造考据依据")
# 成功路径不留痕（缓存命中走有简报分支）
out_ok = asyncio.run(skills._ensure_research_brief(shot_new, "p-real", "real", brief_sem))
expect("_researchNote" not in out_ok, "成功路径不带未考证标记")

# ---------- S. 考据条目：服务端落点、注入源、跨项目复用 ----------
# S1. 补考据成功即落条目（此前只活在进程内缓存里，重启即蒸发）
ents = imgresearch.list_entries("p-real")
expect(any(e["assetName"] == "新道具" for e in ents), f"补考据应落条目：{ents}")
e_new = next(e for e in ents if e["assetName"] == "新道具")
expect(
    bool(e_new["sources"]) and e_new["sources"][0]["domain"] == "example.com",
    f"条目应带来源底账：{e_new}",
)
expect(e_new["era"] == "", "无 era 口径的项目条目 era 为空（不复用域）")
expect("会失败" not in [e["assetName"] for e in ents], "搜索失败的资产不应落条目")

# S2. 条目本身是注入源：画布卡没有 researchBrief 也能进载荷
seed_canvas(
    "p-entry",
    [{"id": "n_e", "data": {"nodeType": "prop", "title": "腰牌"}}],
    {"era": "明代"},
)
imgresearch.upsert_entry(
    "p-entry",
    body="条目里的考据：铜制腰牌刻官职",
    node_id="n_e",
    asset_name="腰牌",
    asset_type="prop",
    era="明代",
)
out = skills._inject_research_briefs([{"rid": "n_e", "visual_notes": ""}], "p-entry")
expect("条目里的考据" in out[0]["visual_notes"], f"条目应能直接注入：{out}")

# S3. 复用查询：同 era + 同资产名才命中
seed_canvas("p-src", [], {"era": "明代"})
imgresearch.upsert_entry(
    "p-src",
    body="明代官服补子：文官用禽鸟、武官用走兽",
    node_id="n_c",
    asset_name="官服",
    asset_type="costume",
    era="明代",
)
brief, from_name = skills._reusable_brief("p-entry", "官服", "costume")
expect("文官用禽鸟" in brief, f"同 era 同名应命中复用：{brief!r}")
expect(from_name != "", "复用应能报出处（项目名缺失时退「同题材项目」）")
brief_same, _ = skills._reusable_brief("p-src", "官服", "costume")
expect(brief_same == "", "同项目条目不走跨项目复用（本项目注入已覆盖）")
brief_era, _ = skills._reusable_brief("p-entry", "官服", "shot")  # 版式类型不参与比
expect(brief_era != "", "载荷类型是版式（shot）时不拦——分镜行引用也吃得上条目")
brief_kind, _ = skills._reusable_brief("p-entry", "官服", "scene")  # 真类型不符
expect(brief_kind == "", "同名但都是资产四类且类型不同（scene vs costume）不复用")
seed_canvas("p-tang", [], {"era": "唐代"})
brief_tang, _ = skills._reusable_brief("p-tang", "官服", "costume")
expect(brief_tang == "", "era 不同绝不复用（宁可重搜，不可错用年代）")
brief_other, _ = skills._reusable_brief("p-tang", "官服甲", "costume")
expect(brief_other == "", "资产名不同不复用")
seed_canvas("p-noera", [], {})
brief_noera, _ = skills._reusable_brief("p-noera", "官服", "costume")
expect(brief_noera == "", "无 era 口径不复用")

# S4. 端到端：跨项目复用走进出图载荷，且不再触发搜索
skills._BRIEF_CACHE.clear()
seed_canvas("p-reuse", [], {"era": "明代"})
out = asyncio.run(
    skills._ensure_research_brief(
        {"name": "官服", "assetType": "costume"}, "p-reuse", "real", brief_sem
    )
)
expect("文官用禽鸟" in out["visual_notes"], f"应复用跨项目条目：{out}")
expect("复用《" in out["visual_notes"], "复用应标明出处")
expect(calls.count("官服") == 0, f"复用命中不该再搜：{calls}")

# S5. 主题考据按服务范围分发到成员资产（同一时代的所有资产拿同一套形制约束）
imgresearch.replace_topics(
    "p-entry", [{"title": "明代服制", "queries": ["q"], "nodeIds": ["n_e"]}]
)
imgresearch.upsert_entry(
    "p-entry",
    body="主题考据：明代文官补服用禽鸟、武官用走兽",
    asset_name="明代服制",
    asset_type="topic",
    era="明代",
    topic_key="明代服制",
)
out = skills._inject_research_briefs([{"rid": "n_e", "visual_notes": ""}], "p-entry")
expect("主题考据：明代文官补服用禽鸟" in out[0]["visual_notes"],
       f"主题考据应分发到服务卡：{out}")
expect("〈明代服制〉" in out[0]["visual_notes"], "分发应标明主题名（多主题可辨）")
expect("条目里的考据" in out[0]["visual_notes"], "本资产条目与主题条目应并存")

# S6. 主题考据注入之后，补考据不该再为它搜一次（真实链路的顺序：先注入再补缺）
skills._BRIEF_CACHE.clear()
seed_canvas("p-topic-only", [{"id": "n_t", "data": {"nodeType": "costume", "title": "补子"}}], {"era": "明代"})
imgresearch.replace_topics(
    "p-topic-only", [{"title": "明代服制", "queries": ["q"], "nodeIds": ["n_t"]}]
)
imgresearch.upsert_entry(
    "p-topic-only", body="主题考据：补子文禽武兽", asset_name="明代服制",
    asset_type="topic", era="明代", topic_key="明代服制",
)
shot_topic = skills._inject_research_briefs(
    [{"rid": "n_t", "name": "补子", "assetType": "costume", "visual_notes": ""}],
    "p-topic-only",
)[0]
expect("补子文禽武兽" in shot_topic["visual_notes"], f"主题考据应先注入载荷：{shot_topic}")
out = asyncio.run(
    skills._ensure_research_brief(shot_topic, "p-topic-only", "real", brief_sem)
)
expect(out == shot_topic, "已带考据依据应原样放行（主题考据也算已带）")
expect(calls.count("补子") == 0, f"主题已覆盖的资产不该再搜：{calls}")

skills._research_brief_for = orig_brief_for
skills._BRIEF_CACHE.clear()

# R. 端到端：start_storyboard_image_job 把简报注入到真正送出的出图载荷
captured: list = []
orig_gen = skills._generate_single_image
orig_pub, orig_run = eventbus.publish_job_event, asyncio.create_task
orig_create, orig_save, orig_finish = (
    imagejobs.create_job,
    imagejobs.save_item,
    imagejobs.finish_job,
)
orig_flow, orig_key = skills.IMAGEGEN_FLOW_ID, skills.DMX_API_KEY


async def fake_gen(shot, params=None):
    captured.append(shot)
    return {"ok": True, "imageUrl": "/agent-service/assets/ok.png"}


skills._generate_single_image = fake_gen
eventbus.publish_job_event = lambda *a, **k: None
imagejobs.create_job = lambda *a, **k: None
imagejobs.save_item = lambda *a, **k: None
imagejobs.finish_job = lambda *a, **k: None
skills.IMAGEGEN_FLOW_ID = "f-img"
skills.DMX_API_KEY = "test-key"


async def run_integration() -> None:
    job_id = await skills.start_storyboard_image_job(
        [
            {
                "rid": "n_a",
                "name": "沈大人",
                "description": "明代文官",
                "visual_notes": "全局视觉风格：水墨",
            }
        ],
        params=None,
        project_id=PID,
    )
    for _ in range(200):
        await asyncio.sleep(0.02)
        if skills.STORYBOARD_IMAGE_JOBS.get(job_id, {}).get("status") != "running":
            break


try:
    asyncio.run(run_integration())
finally:
    skills._generate_single_image = orig_gen
    eventbus.publish_job_event = orig_pub
    imagejobs.create_job, imagejobs.save_item, imagejobs.finish_job = (
        orig_create,
        orig_save,
        orig_finish,
    )
    skills.IMAGEGEN_FLOW_ID, skills.DMX_API_KEY = orig_flow, orig_key

expect(len(captured) == 1, f"应出图 1 次：{captured}")
expect(
    "考据依据" in captured[0]["visual_notes"],
    f"端到端载荷应带考据简报：{captured[0].get('visual_notes')}",
)
expect(BRIEF_A in captured[0]["visual_notes"], "考据内容应完整送达出图载荷")
expect("全局视觉风格：水墨" in captured[0]["visual_notes"], "原有视觉要点应保留")

# ---------- 画布参考卡注入（调研采纳的参考图 → agent 出图载荷） ----------
# 调研采纳的参考卡是「参考卡 → 资产卡」方向连线；服务端此前完全不读 edges，
# 参考图进不了聊天出图载荷（「调研 → 基于调研结果出图」在 agent 路径断掉）。


def seed_canvas_edges(project_id: str, nodes: list, edges: list) -> None:
    conn = sqlite3.connect(str(skills.DB_PATH))
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS canvases_edges ("
            "project_id TEXT PRIMARY KEY, nodes TEXT, edges TEXT)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO canvases_edges VALUES (?, ?, ?)",
            (project_id, json.dumps(nodes, ensure_ascii=False), json.dumps(edges)),
        )
        conn.commit()
    finally:
        conn.close()


# _canvas_ref_cards 读的是 canvases 表（列名为 nodes/edges），照实建一张同名表
conn = sqlite3.connect(str(skills.DB_PATH))
conn.execute("DROP TABLE IF EXISTS canvases")
conn.execute(
    "CREATE TABLE canvases (project_id TEXT PRIMARY KEY, nodes TEXT, edges TEXT, meta TEXT)"
)
conn.commit()
conn.close()

REF_PID = "p-refs-1"
_canvas_nodes = [
    {"id": "c1", "data": {"nodeType": "character", "title": "冯太后",
                          "imageUrl": "/agent-service/assets/ding.png"}},
    {"id": "r1", "data": {"nodeType": "image", "title": "北魏画像",
                          "imageUrl": "/agent-service/assets/r1.png", "refSource": "research"}},
    {"id": "r2", "data": {"nodeType": "image", "title": "陶俑",
                          "imageUrl": "/agent-service/assets/r2.png", "refSource": "research"}},
    {"id": "r3", "data": {"nodeType": "image", "title": "壁画",
                          "imageUrl": "/agent-service/assets/r3.png", "refSource": "research"}},
    {"id": "r4", "data": {"nodeType": "image", "title": "石刻",
                          "imageUrl": "/agent-service/assets/r4.png", "refSource": "research"}},
    {"id": "r5", "data": {"nodeType": "image", "title": "多余的一张",
                          "imageUrl": "/agent-service/assets/r5.png", "refSource": "research"}},
    {"id": "noimg", "data": {"nodeType": "image", "title": "没图的参考卡"}},
    {"id": "s1", "data": {"nodeType": "scene", "title": "朝堂",
                          "imageUrl": "/agent-service/assets/scene.png"}},
    {"id": "s2", "data": {"nodeType": "scene", "title": "朝堂·夜"}},
]
canvas_edges = [
    {"source": "r1", "target": "c1"}, {"source": "r2", "target": "c1"},
    {"source": "r3", "target": "c1"}, {"source": "r4", "target": "c1"},
    {"source": "r5", "target": "c1"}, {"source": "noimg", "target": "c1"},
    {"source": "s1", "target": "s2"},
]
conn = sqlite3.connect(str(skills.DB_PATH))
conn.execute(
    "INSERT OR REPLACE INTO canvases (project_id, nodes, edges, meta) VALUES (?, ?, ?, '{}')",
    (REF_PID, json.dumps(_canvas_nodes, ensure_ascii=False), json.dumps(canvas_edges)),
)
conn.commit()
conn.close()

# E. 收集：上游带图卡才收、refSource=research → type "reference"、上限 4；
#    资产卡无图（s2）也照样能收母场景图，标签按其 nodeType
refs_by_node, id_by_title = skills._canvas_ref_cards(REF_PID)
expect(list(refs_by_node.keys()) == ["c1", "s2"], f"两张卡应有参考：{refs_by_node}")
expect(len(refs_by_node["c1"]) == 4, f"参考上限 4（前端 slice(0,4) 同口径）：{refs_by_node['c1']}")
expect(
    refs_by_node["c1"][0] == ("/agent-service/assets/r1.png", "reference", "北魏画像"),
    f"调研参考卡标签应为 reference：{refs_by_node['c1'][0]}",
)
expect(
    refs_by_node["s2"] == [("/agent-service/assets/scene.png", "scene", "朝堂")],
    f"母场景变体应按 nodeType 标注：{refs_by_node.get('s2')}",
)
expect(skills._canvas_ref_cards("") == ({}, {}), "空 project_id 返回两张空表")
expect(skills._canvas_ref_cards("p-不存在") == ({}, {}), "未知项目返回两张空表")
expect(id_by_title.get("冯太后") == "c1" and id_by_title.get("朝堂·夜") == "s2",
       f"标题→节点 id 索引应含四类资产卡：{id_by_title}")

# F. 注入：rid 命中 / 聊天侧按名兜底 / 已带参考不覆盖
out = skills._inject_canvas_refs(
    [{"rid": "c1", "name": "冯太后", "description": "x"}], REF_PID
)
expect(len(out[0]["reference_images"]) == 4, f"rid 命中应补 4 张：{out[0]}")
expect(out[0]["reference_labels"][0] == {"type": "reference", "name": "北魏画像"},
       f"标签应与图一一对应：{out[0]['reference_labels']}")
out = skills._inject_canvas_refs([{"name": "冯太后", "description": "y"}], REF_PID)
expect(out[0]["reference_images"][0].endswith("r1.png"), f"聊天侧按名兜底：{out[0]}")
out = skills._inject_canvas_refs(
    [{"name": "冯太后", "reference_images": ["/keep.png"]}], REF_PID
)
expect(out[0]["reference_images"] == ["/keep.png"], "调用方显式带的参考优先，不叠加（防超上限）")
out = skills._inject_canvas_refs([{"name": "无关资产"}], REF_PID)
expect("reference_images" not in out[0], "无连线资产不应凭空产生参考")
out = skills._inject_canvas_refs([{"name": "冯太后"}], "")
expect("reference_images" not in out[0], "空项目应原样放行")

# G. 拆解名单：只收四类资产卡、要有标题（聊天路径补 existing 用）
roster = skills._canvas_asset_roster(REF_PID)
expect(
    {"type": "character", "name": "冯太后"} in roster
    and {"type": "scene", "name": "朝堂·夜"} in roster
    and all(r["type"] in ("character", "scene", "prop", "costume") for r in roster),
    f"名单口径不符：{roster}",
)
expect(skills._canvas_asset_roster("") == [], "空 project_id 名单为空")

# ---------- 造型图链（agent 侧入口：资格筛选 / 提示词同源 / 落卡 ops） ----------
import graph  # noqa: E402  （放在最后：graph 装配工具链，前面纯函数测试不依赖它）

# H. 提示词与前端 fillLookImages 逐字同源（两份实现必须共用一套措辞）
proto = skills._look_protocol("冯太后", "朝服", "十二旒冕服", True)
expect("参考图1（角色身份参考）：只继承脸型、五官、发型、体型比例" in proto,
       f"身份锁句丢失：{proto}")
expect("参考图2（服饰结构参考）：形制、材质、配色以该服饰图为准" in proto, "形制锁句丢失")
expect("不继承其白底、三视图或转面排版" in proto, "白底三视图防污染句丢失")
expect("画面为单幅全身造型图" in proto and "不做分格、并排多视图或转面陈列" in proto,
       "单幅版式自述丢失（缺它会被四格定妆契约带偏）")
expect(skills._look_protocol("冯太后", "常服", "", False).count("参考图2") == 0,
       "无服饰图时不应出现参考图2 的职责句")

# I. 资格筛选：无定妆照不出、已出图跳过、costumeId 解析服饰图
LOOK_PID = "p-look-1"
_look_nodes = [
    {"id": "c1", "style": {"width": 320, "height": 220},
     "position": {"x": 100, "y": 200},
     "data": {"nodeType": "character", "title": "冯太后",
              "imageUrl": "/agent-service/assets/ding.png",
              "gen": {"model": "m", "resolution": "2K"},
              "looks": [
                  {"label": "朝服", "description": "十二旒", "costumeId": "cos1"},
                  {"label": "常服", "description": "素色", "costumeId": "cos1",
                   "imageUrl": "/agent-service/assets/done.png", "nodeId": "n_done"},
              ]}},
    {"id": "c2", "data": {"nodeType": "character", "title": "无定妆照",
                          "looks": [{"label": "朝服"}]}},
    {"id": "cos1", "data": {"nodeType": "costume", "title": "北魏朝服",
                            "imageUrl": "/agent-service/assets/cos.png"}},
]
# 资格筛选走 skills 自己的画布读取（直读 canvases 表）；
# 落卡 ops 走 graph.projects.load_canvas——两处喂同一份画布数据
conn = sqlite3.connect(str(skills.DB_PATH))
conn.execute(
    "INSERT OR REPLACE INTO canvases (project_id, nodes, edges, meta) VALUES (?, ?, ?, '{}')",
    (LOOK_PID, json.dumps(_look_nodes, ensure_ascii=False), "[]"),
)
conn.commit()
conn.close()
graph.projects.project_id_of_thread = lambda tid: LOOK_PID
graph.projects.load_canvas = lambda pid, viewer=None: {"nodes": _look_nodes, "edges": []}
jobs = skills._look_jobs(LOOK_PID)
expect(len(jobs) == 1 and jobs[0]["label"] == "朝服",
       f"应只留「有定妆照且未出图」的造型：{jobs}")
expect(jobs[0]["charId"] == "c1" and jobs[0]["lookIdx"] == 0, "任务应带角色与造型序号")
expect(jobs[0]["identity"].endswith("ding.png"), "参考图1 应为角色定妆照")
expect(jobs[0]["costumeImg"].endswith("cos.png") and jobs[0]["costumeId"] == "cos1",
       "参考图2 应按 costumeId 解析出服饰结构图")
expect(skills._look_jobs(LOOK_PID, ["c2"]) == [],
       "圈定无定妆照的角色应无任务（没有身份锚点不出图）")

# J. 落卡 ops：造型卡 + 双连线 + 造型账回填 + 组框；位置不叠卡
_style_backup = skills._project_style_from_config
skills._project_style_from_config = lambda config=None: "水墨"
try:
    ops, notes = graph._build_look_card_ops(
        [
            {"charId": "c1", "charTitle": "冯太后", "lookIdx": 0, "label": "朝服",
             "description": "十二旒", "costumeId": "cos1", "costumeTitle": "北魏朝服",
             "identity": "/agent-service/assets/ding.png",
             "costumeImg": "/agent-service/assets/cos.png",
             "ok": True, "imageUrl": "/agent-service/assets/look0.png",
             "sentPrompt": skills._look_protocol("冯太后", "朝服", "十二旒", True),
             "finalPrompt": "实际发送的提示词"},
            {"charId": "c1", "charTitle": "冯太后", "lookIdx": 9, "label": "雨夜装",
             "ok": False, "error": "出图失败"},
        ],
        {"configurable": {"thread_id": "t1"}},
    )
finally:
    skills._project_style_from_config = _style_backup
adds = [o for o in ops if o["op"] == "add_node"]
expect(notes == [], f"角色卡在画布上时不应有告警：{notes}")
expect(len(adds) == 1 and adds[0]["nodeType"] == "image",
       f"失败项不落卡，只建成功的 1 张：{adds}")
expect(adds[0]["title"] == "冯太后·朝服" and adds[0]["status"] == "ready", f"卡面不符：{adds[0]}")
expect(adds[0]["genShot"]["assetType"] == "none", "造型图必须 none 直传（避四格定妆契约）")
expect(adds[0]["genShot"]["referenceImages"] == [
    "/agent-service/assets/ding.png", "/agent-service/assets/cos.png"],
    f"genShot 参考序列应为定妆照+服饰图：{adds[0]['genShot']['referenceImages']}")
expect(adds[0]["genShot"]["referenceLabels"] == [
    {"type": "character", "name": "冯太后"}, {"type": "costume", "name": "北魏朝服"}],
    f"参考职责标签不符：{adds[0]['genShot'].get('referenceLabels')}")
expect(adds[0]["position"]["x"] > 100, "造型卡应摆角色卡右侧")
conns = [o for o in ops if o["op"] == "connect_nodes"]
expect({(c["fromId"], c["toId"]) for c in conns} == {
    ("c1", adds[0]["id"]), ("cos1", adds[0]["id"])}, f"应有角色→造型卡、服饰→造型卡连线：{conns}")
upd = [o for o in ops if o["op"] == "update_node"]
expect(len(upd) == 1 and upd[0]["id"] == "c1", f"应回填角色卡造型账：{upd}")
looks_back = upd[0]["looks"]
expect(looks_back[0]["imageUrl"].endswith("look0.png") and looks_back[0]["nodeId"] == adds[0]["id"],
       f"造型账应回填 imageUrl/nodeId（幂等标记）：{looks_back}")
expect("雨夜装" not in [l.get("label") for l in looks_back],
       f"失败的造型不得进造型账：{looks_back}")
expect(looks_back[1].get("imageUrl") == "/agent-service/assets/done.png",
       "既有造型账（已出图的常服）应原样保留在回填里")
expect(not any(o["op"] == "group_nodes" for o in ops), "只有 1 张时不收组框（组框至少 2 个）")
ops2, _ = graph._build_look_card_ops(
    [
        {"charId": "c1", "charTitle": "冯太后", "lookIdx": 0, "label": "朝服",
         "costumeId": "", "costumeTitle": "", "identity": "/a/ding.png", "costumeImg": "",
         "ok": True, "imageUrl": "/a/l0.png", "sentPrompt": "p", "description": ""},
        {"charId": "c1", "charTitle": "冯太后", "lookIdx": 1, "label": "常服",
         "costumeId": "", "costumeTitle": "", "identity": "/a/ding.png", "costumeImg": "",
         "ok": True, "imageUrl": "/a/l1.png", "sentPrompt": "p", "description": ""},
    ],
    {"configurable": {"thread_id": "t1"}},
)
grp = [o for o in ops2 if o["op"] == "group_nodes"]
expect(len(grp) == 1 and grp[0]["title"] == "造型图" and len(grp[0]["ids"]) == 2,
       f"≥2 张应收「造型图」组框：{grp}")
_pos = [o["position"] for o in ops2 if o["op"] == "add_node"]
expect(_pos[0]["y"] != _pos[1]["y"], f"同角色多造型应纵向排开不叠卡：{_pos}")
_nolabel = graph._build_look_card_ops(
    [{"charId": "c1", "charTitle": "冯太后", "lookIdx": 0, "label": "朝服",
      "costumeId": "", "costumeTitle": "", "identity": "/a/ding.png", "costumeImg": "",
      "ok": True, "imageUrl": "/a/l0.png", "sentPrompt": "p", "description": ""}],
    {"configurable": {"thread_id": "t1"}},
)
_conns = [o for o in _nolabel[0] if o["op"] == "connect_nodes"]
expect(len(_conns) == 1, f"无绑定服饰时只应有角色→造型卡一条连线：{_conns}")
_missing = graph._build_look_card_ops(
    [{"charId": "nope", "charTitle": "不在画布", "lookIdx": 0, "label": "朝服",
      "ok": True, "imageUrl": "/a/x.png"}],
    {"configurable": {"thread_id": "t1"}},
)
expect(_missing[0] == [] and _missing[1], f"角色卡不在画布应告警且不产 ops：{_missing}")
expect(graph._build_look_card_ops([], {"configurable": {}})[1],
       "会话未绑定项目应告警")

# ---------- 资产卡落卡 ops（聊天出图回填资产卡媒体位） ----------
# 091101 事故：聊天侧出图只返回 image_url 文本，落卡靠模型手抄几十条
# update_node——52 张图出完画布还是空的，模型中间还口播「已落卡」。
ASSET_PID = "p-asset-1"
_asset_nodes = [
    {"id": "a1", "style": {"width": 288, "height": 214}, "position": {"x": 0, "y": 0},
     "data": {"nodeType": "character", "title": "武则天"}},
    {"id": "a2", "data": {"nodeType": "scene", "title": "长安 后宫 祈福殿"}},
    {"id": "a3", "data": {"nodeType": "prop", "title": "烛台",
                          "imageUrl": "/agent-service/assets/old.png"}},
    {"id": "sl1", "data": {"nodeType": "shotlist", "title": "分镜表"}},
]
conn = sqlite3.connect(str(skills.DB_PATH))
conn.execute(
    "INSERT OR REPLACE INTO canvases (project_id, nodes, edges, meta) VALUES (?, ?, ?, '{}')",
    (ASSET_PID, json.dumps(_asset_nodes, ensure_ascii=False), "[]"),
)
conn.commit()
conn.close()
graph.projects.project_id_of_thread = lambda tid: ASSET_PID
graph.projects.load_canvas = lambda pid, viewer=None: {"nodes": _asset_nodes, "edges": []}


def _asset_res(name, image_url, **kw):
    r = {"name": name, "ok": bool(image_url), "assetType": "character",
         "description": f"{name} 的设定", "visualNotes": "考据依据：唐初形制",
         "finalPrompt": f"{name} 实际发送提示词",
         "referenceImages": ["/agent-service/assets/ref.png"],
         "referenceLabels": [{"type": "reference", "name": "唐制参考"}]}
    if image_url:
        r["imageUrl"] = image_url
    else:
        r["error"] = "上游超时"
    r.update(kw)
    return r


skills._project_style_from_config = lambda config=None: "古装真人纪录片"
try:
    a_ops, a_notes, a_unres = graph._build_asset_card_ops(
        [
            _asset_res("武则天", "/agent-service/assets/w.png", nodeId="a1"),
            # 标题兜底：名字带空格差异也要认领（模型会归一场景名）
            _asset_res("长安后宫祈福殿", "/agent-service/assets/s.png", assetType="scene"),
            # 失败：卡上原有图 → 不改状态（别把已有的图换成重试面板）
            _asset_res("烛台", "", assetType="prop", nodeId="a3"),
            # 画布上没有这张卡 → 进 unresolved，不产 ops
            _asset_res("太平公主", "/agent-service/assets/t.png"),
            # 分镜图走 _build_shot_card_ops，不进资产账
            _asset_res("镜头1", "/agent-service/assets/shot.png", assetType="shot"),
            _asset_res("镜头2", "/agent-service/assets/shot2.png", shotlistId="sl1"),
        ],
        {"configurable": {"thread_id": "t1"}},
    )
finally:
    skills._project_style_from_config = _style_backup
expect(a_unres and [r["name"] for r in a_unres] == ["太平公主"],
       f"画布上无同名的资产才进 unresolved：{a_unres}")
expect([o["id"] for o in a_ops] == ["a1", "a2"],
       f"应只回填认领到的资产卡（失败且已有图的不动、分镜不进账）：{a_ops}")
expect(a_ops[0]["imageUrl"].endswith("w.png") and a_ops[0]["status"] == "ready",
       f"落卡 op 应挂图并置 ready：{a_ops[0]}")
expect(a_ops[0]["errorMessage"] == "", "落卡时应清掉上一轮的失败说明")
expect(a_ops[0]["genPrompt"] == "武则天 的设定", "genPrompt 应是用户原文（差分对照的基准）")
expect(a_ops[0]["genShot"]["finalPrompt"].endswith("实际发送提示词"),
       f"genShot 应带实际发送提示词（卡上查看/编辑重跑的数据源）：{a_ops[0]['genShot']}")
expect(a_ops[0]["genShot"]["visualNotes"].startswith("考据依据"),
       "genShot 应记注入后的视觉笔记（实际发出去的东西）")
expect(a_ops[0]["genShot"]["referenceLabels"] == [{"type": "reference", "name": "唐制参考"}],
       "参考职责标签应随 genShot 落卡")
expect(a_ops[0]["styleSnapshot"].endswith("古装真人纪录片"), "风格快照应随卡（与前端同款审计）")
expect(any("找不到同名的资产卡" in n for n in a_notes),
       f"未落卡资产应留告警（教 agent 建卡时带 genShot）：{a_notes}")
_nocanvas = graph._build_asset_card_ops([_asset_res("武则天", "/a/x.png")], {})
expect(_nocanvas[0] == [] and "未绑定项目" in _nocanvas[1][0],
       f"会话未绑定项目应告警且不产 ops：{_nocanvas[:2]}")
_nofail = graph._build_asset_card_ops(
    [_asset_res("烛台", "", assetType="prop", nodeId="a3")],
    {"configurable": {"thread_id": "t1"}},
)
expect(_nofail[0] == [], f"卡上已有图时失败不写 error 态（不藏旧图）：{_nofail[0]}")
_err_ops, _, _ = graph._build_asset_card_ops(
    [_asset_res("武则天", "", nodeId="a1")],
    {"configurable": {"thread_id": "t1"}},
)
expect(_err_ops and _err_ops[0]["status"] == "error" and "上游超时" in _err_ops[0]["errorMessage"],
       f"空卡出图失败应写 error 态（卡面给重试入口）：{_err_ops}")

# 工具接线：generate_asset_images 的返回串必须带 ops（而不是旧的「自行落卡」附录）——
# 这一段是事故的真正堵口（返回文本里没有 ops = 模型只能手抄）
import asyncio  # noqa: E402

_gen_backup = skills.generate_asset_images


async def _fake_gen(assets, config=None, params=None):
    return {
        "lines": "✓ 武则天｜image_url=/agent-service/assets/w.png",
        "results": [_asset_res("武则天", "/agent-service/assets/w.png", nodeId="a1")],
    }


skills.generate_asset_images = _fake_gen
try:
    out = asyncio.run(
        graph.generate_asset_images.coroutine(
            assets_json=json.dumps([{"type": "character", "name": "武则天",
                                     "description": "唐宫昭仪"}]),
            config={"configurable": {"thread_id": "t1"}},
        )
    )
finally:
    skills.generate_asset_images = _gen_backup
expect("资产卡落卡 ops 已生成" in out, f"返回串应带资产卡落卡 ops：{out[:120]}")
expect('"op": "update_node"' in out and "w.png" in out, "ops 应含把图挂回 a1 的 update_node")
expect("先经 canvas_ops 原样应用整批 ops，再向用户汇报" in out,
       "返回串必须教「先应用再汇报」（图出了≠卡上有，防口播已落卡）")

# L. 真跑 skills.generate_asset_images（出图函数 mock）：结构化结果必须把落卡
#    身份（node_id/assetType）与审计快照（注入后的 visual_notes/finalPrompt）带出来
_brief_backup = skills._ensure_research_brief
_single_backup = skills._generate_single_image
_flow_backup, _key_backup = skills.IMAGEGEN_FLOW_ID, skills.DMX_API_KEY
skills.IMAGEGEN_FLOW_ID, skills.DMX_API_KEY = "f-img", "test-key"


async def _passthrough_brief(shot, project_id, factuality, sem):
    return shot


async def _one_img(shot, params=None):
    return {
        "ok": True,
        "imageUrl": "/agent-service/assets/gen.png",
        "composedPrompt": "扩写后的提示词",
        "finalPrompt": "最终发送提示词",
    }


skills._ensure_research_brief = _passthrough_brief
skills._generate_single_image = _one_img
try:
    _res = asyncio.run(
        skills.generate_asset_images(
            [{"type": "character", "name": "武则天", "description": "唐宫昭仪",
              "node_id": "a1", "visual_notes": "宫装绛红"}],
            config=None,
        )
    )
finally:
    skills._ensure_research_brief = _brief_backup
    skills._generate_single_image = _single_backup
    skills.IMAGEGEN_FLOW_ID, skills.DMX_API_KEY = _flow_backup, _key_backup
_row = _res["results"][0]
expect(_row["nodeId"] == "a1" and _row["assetType"] == "character",
       f"结构化结果应带落卡身份：{_row}")
expect(_row["visualNotes"] == "宫装绛红", f"应带注入后的视觉笔记：{_row['visualNotes']}")
expect(_row["finalPrompt"] == "最终发送提示词" and _row["description"] == "唐宫昭仪",
       "应带最终提示词与用户原文（genShot 与 genPrompt 两个数据源）")
expect(_row["shotlistId"] == "", "非分镜资产不应有 shotlist 绑定")

print(f"✅ 出图考据注入与补考据 {PASS[0]} 项断言全部通过")
