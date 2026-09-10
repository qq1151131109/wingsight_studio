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

# Q. 补考据：失败软放行（不拦出图）
shot_fail = {"name": "会失败", "visual_notes": "全局视觉风格：水墨"}
out = asyncio.run(skills._ensure_research_brief(shot_fail, "p-real", "real", brief_sem))
expect(out == shot_fail, "考据失败应原样放行")

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

print(f"✅ 出图考据注入与补考据 {PASS[0]} 项断言全部通过")
