"""参考图终选与调研判停单测（2026-09-12 P0-P3 修复的回归锁）。

运行：cd agent && uv run python test_ref_select.py
不需要 langflow / LLM / 网络——flow 调用与搜索下载全部 monkeypatch。

背景（091102 项目实锤）：终选模型按适配度排序的 recommended 被
sorted(set(...)) 销毁成搜索位次序，auto_adopt_top 实际抓「推荐集里位次
最靠前的 3 张」（采纳了千万工程现代照、漏掉模型想要的 80 年代图）；且
planner 只看标题判不了候选质量，按数量想象补搜成每资产 17.6 词、136 张
候选。本测试锁四件事：
  A. 终选输出保序（模型序=采纳序）+ 多批推荐集全局精排 + 精排降级
  B. 搜索层下载前预筛（短边/域名黑名单）
  C. 调研主流程「先搜后判再补」：首轮达标即停 / 不足带证据补搜 / 终选
     失败不盲搜 / 手填词不跑 planner 不跑文路
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
from pathlib import Path

import imgresearch
import jobstore
import skills

PASS = [0]


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


# 重试等待全走瞬时 sleep（fake 不需要真实间隔；asyncio.run 内部不用 sleep）
_real_sleep = asyncio.sleep


async def _fast_sleep(_s: float) -> None:
    return None


asyncio.sleep = _fast_sleep

# ───────────────────────── A. run_ref_select_flow ─────────────────────────

_orig_flow_id = skills.REF_SELECT_FLOW_ID
_orig_dmx = skills.DMX_API_KEY
_orig_rfb = skills.run_flow_blocking
skills.REF_SELECT_FLOW_ID = "f-select"
skills.DMX_API_KEY = "k-test"

_calls: list[list[int]] = []
_responses: list[object] = []


async def _fake_run_flow(flow_id: str, input_value: str = "", tweaks: dict | None = None):
    payload = json.loads((tweaks or {})["RefSelect-main"]["payload"])
    _calls.append([int(c["index"]) for c in payload["candidates"]])
    resp = _responses[len(_calls) - 1]
    if isinstance(resp, Exception):
        raise resp
    rec, note = resp  # type: ignore[misc]
    return json.dumps({"recommended": rec, "note": note}, ensure_ascii=False)


skills.run_flow_blocking = _fake_run_flow


def _cands(n: int) -> list[dict]:
    return [
        {"index": i, "title": f"t{i}", "width": 800, "height": 600, "provider": "google", "url": f"http://x/{i}.webp"}
        for i in range(n)
    ]


async def _group_a() -> None:
    async def _select(n: int) -> dict:
        return await skills.run_ref_select_flow({"name": "x"}, _cands(n))

    # A0. 空候选明报
    try:
        await _select(0)
        raise AssertionError("空候选应报错")
    except RuntimeError:
        PASS[0] += 1

    # A1. 单批保序：模型给 [7,3,9]，返回就是 [7,3,9]（修复前会被 sorted 成 [3,7,9]）
    _calls.clear(); _responses.clear(); _responses.append(([7, 3, 9], "n1"))
    out = await _select(8)
    expect(out["recommended"] == [7, 3, 9], f"单批应保模型序：{out['recommended']}")

    # A2. 保序去重：模型重复输出同一 index 只留首个位置
    _calls.clear(); _responses.clear(); _responses.append(([7, 7, 3], "n"))
    out = await _select(8)
    expect(out["recommended"] == [7, 3], f"重复 index 保序去重：{out['recommended']}")

    # A3. 多批全局精排：120 张 3 批 → 推荐集合成一批再排，top 名次是全局的
    _calls.clear(); _responses.clear()
    _responses.extend([([2, 0], "b1"), ([55, 51], "b2"), ([119], "b3"), ([55, 2], "rerank")])
    out = await _select(120)
    expect(len(_calls) == 4, f"应 3 批粗排 + 1 次精排：{len(_calls)}")
    expect(_calls[3] == [2, 0, 55, 51, 119], f"精排载荷=推荐集按粗排合并序：{_calls[3]}")
    expect(out["recommended"] == [55, 2, 0, 51, 119], f"精排序在前、其余垫尾：{out['recommended']}")
    expect("精排" in out["note"], f"note 应带精排说明：{out['note']}")

    # A4. 精排失败软降级为批序合并，note 明说（推荐不丢）
    _calls.clear(); _responses.clear()
    _responses.extend([
        ([2, 0], "b1"), ([55, 51], "b2"),
        RuntimeError("精排网络炸了"), RuntimeError("精排网络炸了"), RuntimeError("精排网络炸了"),
    ])
    out = await _select(60)  # 2 批 → 触发精排
    expect(out["recommended"] == [2, 0, 55, 51], f"精排失败按批序合并：{out['recommended']}")
    expect("精排失败" in out["note"], f"note 应明说精排失败：{out['note']}")

    # A5. 单批失败不拖垮其余批
    _calls.clear(); _responses.clear()
    _responses.extend([
        ([3], "b1"),
        RuntimeError("第2批炸了"), RuntimeError("第2批炸了"), RuntimeError("第2批炸了"),
    ])
    out = await _select(60)
    expect(out["recommended"] == [3], f"失败批的推荐不应混入：{out['recommended']}")
    expect("第2批" in out["note"], f"note 应记失败批：{out['note']}")


asyncio.run(_group_a())
skills.REF_SELECT_FLOW_ID = _orig_flow_id
skills.DMX_API_KEY = _orig_dmx
skills.run_flow_blocking = _orig_rfb
print(f"A 组（终选保序/精排）通过：{PASS[0]}")

# ───────────────────────── B. 下载前预筛（纯函数） ─────────────────────────

_b0 = PASS[0]
expect(imgresearch._prefilter_candidate(900, 1200, "人民图片- 人民网"), "正常尺寸应收")
expect(imgresearch._prefilter_candidate(800, 500, "Pinterest"), "图库域应收（不在黑名单）")
expect(not imgresearch._prefilter_candidate(300, 800, "搜狐"), "短边 300 应拒")
expect(not imgresearch._prefilter_candidate(1280, 399, "新浪"), "短边 399 应拒（<400 硬线）")
expect(imgresearch._prefilter_candidate(1280, 400, "新浪"), "短边 400 是放行线")
expect(imgresearch._prefilter_candidate(0, 0, "新华网"), "宽高元数据缺失应照收（终选还能裁量）")
expect(not imgresearch._prefilter_candidate(900, 1200, "trip.com"), "旅游电商域应拒")
expect(not imgresearch._prefilter_candidate(900, 1200, "马蜂窝-游记"), "黑名单子串匹配（中文域）")
expect(not imgresearch._prefilter_candidate(900, 1200, "www.3d66.com"), "素材站应拒")
expect(not imgresearch._prefilter_candidate(900, 1200, "携程旅行"), "携程应拒")
print(f"B 组（下载前预筛）通过：{PASS[0] - _b0}")

# ───────────────────── C. _run_research 先搜后判再补 ─────────────────────

_tmp = Path(tempfile.mkdtemp(prefix="ws-select-test-"))
imgresearch.DB_PATH = _tmp / "test.db"
jobstore.DB_PATH = imgresearch.DB_PATH
imgresearch.init_ref_research_db()
PID = "p-rounds"

with sqlite3.connect(str(imgresearch.DB_PATH)) as _c:
    _c.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT)")
    _c.execute("INSERT OR REPLACE INTO projects (id, name) VALUES (?, ?)", (PID, "判停测试"))
    _c.execute(
        "CREATE TABLE IF NOT EXISTS canvases (project_id TEXT PRIMARY KEY, nodes TEXT, meta TEXT)"
    )
    _c.execute(
        "INSERT OR REPLACE INTO canvases (project_id, nodes, meta) VALUES (?,?,?)",
        (PID, "[]", json.dumps({"era": "测试时代"}, ensure_ascii=False)),
    )


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(imgresearch.DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _mk_job(jid: str) -> dict:
    job = {
        "jobId": jid, "projectId": PID, "nodeId": "n1", "status": "running",
        "phase": "", "candidates": [], "errors": {}, "error": "", "note": "",
        "researchBrief": "",
    }
    imgresearch.REF_JOBS[jid] = job
    return job


def _reset_sem() -> None:
    # asyncio 原语绑定首个事件循环，跨 asyncio.run 复用会炸——每场景换新的
    imgresearch._GLOBAL_DOWNLOAD_SEM = asyncio.Semaphore(32)


search_log: list[str] = []
plan_calls: list[list[dict]] = []
select_log: list[list[int]] = []
select_responses: list[object] = []


async def _fake_search(q: str, limit: int = 10) -> list[dict]:
    search_log.append(q)
    return [
        {
            "provider": "google", "title": f"{q}-图{i}", "sourceUrl": f"http://ex.com/{q}-{i}.jpg",
            "pageUrl": "http://ex.com/p", "sourceDomain": "ex.com",
            "width": 900, "height": 1200,
        }
        for i in range(2)
    ]


async def _fake_plan(asset: dict, rounds: list[dict]) -> dict:
    plan_calls.append([dict(r) for r in rounds])
    # 二轮起换词：同词会被跨轮去重清空（found=无候选），测不出补搜
    qs = ["q1", "q2", "q3"] if len(plan_calls) == 1 else ["q4", "q5", "q6"]
    return {"queries": qs, "text_queries": [], "enough": False}


async def _fake_dl(url: str, referer: str = "") -> str:
    return f"/agent-service/assets/{Path(url).stem}.jpg"


async def _fake_select(asset: dict, candidates: list[dict]) -> dict:
    select_log.append([int(c["index"]) for c in candidates])
    resp = select_responses[len(select_log) - 1]
    if isinstance(resp, Exception):
        raise resp
    return {"recommended": list(resp), "note": "mock"}


_orig_search, _orig_dl = imgresearch.search_serper_images, imgresearch.download_image
_orig_plan, _orig_sel = skills.run_ref_plan_flow, skills.run_ref_select_flow
imgresearch.search_serper_images = _fake_search
imgresearch.download_image = _fake_dl
skills.run_ref_plan_flow = _fake_plan
skills.run_ref_select_flow = _fake_select

# C1. 首轮达标即停：3 词搜完终选推荐 4 张 ≥ 判停线，planner 只被叫一次
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.append([5, 2, 4, 1])
job = _mk_job("j1"); _reset_sem()
asyncio.run(imgresearch._run_research("j1", PID, "n1", [], {"name": "判停资产", "type": "character"}))
expect(job["status"] == "done", f"C1 任务应完成：{job.get('error')}")
expect(len(search_log) == 3, f"C1 首轮 3 词即停（修复前会补搜到十几词）：{search_log}")
expect(len(plan_calls) == 1, f"C1 planner 只叫一次：{len(plan_calls)}")
expect(select_log == [[0, 1, 2, 3, 4, 5]], f"C1 终选只看首轮候选：{select_log}")
with _db() as _c:
    rows = _c.execute(
        "SELECT idx_total, rec_rank, adopted FROM ref_candidates"
        " WHERE project_id=? AND node_id='n1' AND recommended=1 ORDER BY rec_rank", (PID,)
    ).fetchall()
expect(
    [(r["idx_total"], r["rec_rank"], r["adopted"]) for r in rows]
    == [(5, 1, 1), (2, 2, 1), (4, 3, 1), (1, 4, 0)],
    f"C1 采纳=模型序前 3、rec_rank=模型排序位：{[tuple(r) for r in rows]}",
)

# C2. 首轮不足带证据补搜：二轮 planner 摘要里带「终选推荐 1/6」，推荐累计达标即停
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.extend([[1], [10, 6, 8, 11]])
job = _mk_job("j2"); _reset_sem()
asyncio.run(imgresearch._run_research("j2", PID, "n2", [], {"name": "补搜资产", "type": "scene"}))
expect(job["status"] == "done", f"C2 任务应完成：{job.get('error')}")
expect(len(search_log) == 6, f"C2 两轮共 6 词：{search_log}")
expect(len(plan_calls) == 2, f"C2 planner 叫两次：{len(plan_calls)}")
expect(
    len(plan_calls[1]) == 1 and "终选推荐 1/6" in plan_calls[1][0]["found"],
    f"C2 补搜判据带推荐率证据：{plan_calls[1]}",
)
expect(select_log[1] == [6, 7, 8, 9, 10, 11], f"C2 二轮终选 index 接续全局位次：{select_log}")
with _db() as _c:
    adopted = [
        r["idx_total"]
        for r in _c.execute(
            "SELECT idx_total FROM ref_candidates WHERE project_id=? AND node_id='n2' AND adopted=1"
            " ORDER BY rec_rank", (PID,)
        ).fetchall()
    ]
expect(adopted == [1, 10, 6], f"C2 跨轮推荐序（轮序在前、轮内模型序）：{adopted}")

# C3. 终选失败不盲搜：保住首轮候选收工，错误明报（不再按数量想象补满 5 轮）
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.append(RuntimeError("看图模型全灭"))
job = _mk_job("j3"); _reset_sem()
asyncio.run(imgresearch._run_research("j3", PID, "n3", [], {"name": "终选故障", "type": "prop"}))
expect(job["status"] == "done", f"C3 候选在手不算任务失败：{job.get('status')}")
expect("终选" in job["errors"], f"C3 错误明报：{job['errors']}")
expect(len(search_log) == 3, f"C3 终选失败后不再盲搜：{search_log}")
with _db() as _c:
    n = _c.execute(
        "SELECT count(*) FROM ref_candidates WHERE project_id=? AND node_id='n3'", (PID,)
    ).fetchone()[0]
expect(n == 6, f"C3 首轮候选保留可手动采纳：{n}")

# C4. 手填词：不跑 planner 不跑文路，全量手工词进首轮
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.append([0, 3, 6, 5])
job = _mk_job("j4"); _reset_sem()
asyncio.run(
    imgresearch._run_research(
        "j4", PID, "n4", ["手词A", "手词B", "手词C", "手词D"], {"name": "手动", "type": "costume"}
    )
)
expect(job["status"] == "done", f"C4 任务应完成：{job.get('error')}")
expect(search_log == ["手词A", "手词B", "手词C", "手词D"], f"C4 手填词原样进首轮：{search_log}")
expect(plan_calls == [], f"C4 手动模式不跑 planner：{plan_calls}")
expect(job.get("researchBrief") == "", "C4 手动模式不跑文路")

imgresearch.search_serper_images = _orig_search
imgresearch.download_image = _orig_dl
skills.run_ref_plan_flow = _orig_plan
skills.run_ref_select_flow = _orig_sel
asyncio.sleep = _real_sleep

print(f"C 组（先搜后判再补）通过：{PASS[0]}")
print(f"全部通过：{PASS[0]} 项")
