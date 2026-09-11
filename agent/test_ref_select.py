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
    if isinstance(resp, dict):  # 完整形状（缺口台账）
        return json.dumps(resp, ensure_ascii=False)
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

    # A6. 缺口台账透传（A 档）：covered/missing 原样返回、多批按出现顺序保序去重
    _calls.clear(); _responses.clear()
    _responses.extend([
        {"recommended": [2], "note": "b1", "covered": ["村落全景"], "missing": ["巷道近景", "室内陈设"]},
        {"recommended": [55], "note": "b2", "covered": ["村落全景", "门楼细节"], "missing": ["室内陈设"]},
    ])
    out = await _select(60)
    expect(out["covered"] == ["村落全景", "门楼细节"], f"A6 covered 保序去重：{out['covered']}")
    expect(out["missing"] == ["巷道近景", "室内陈设"], f"A6 missing 保序去重：{out['missing']}")

    # A7. 模型不给缺口字段 / 给错形状 → 空列表，不炸终选（台账缺失不拦推荐）
    _calls.clear(); _responses.clear()
    _responses.append({"recommended": [1], "note": "no gap", "missing": "应该是数组但给了字符串"})
    out = await _select(8)
    expect(out["recommended"] == [1] and out["missing"] == [], f"A7 缺口字段异常当空：{out}")

    # A8. 缺口条目清洗：去空白、截断 60 字、上限 8 条
    _calls.clear(); _responses.clear()
    _responses.append({"recommended": [], "note": "",
                       "missing": ["  巷道 近景  "] + [f"维度{i}" for i in range(12)]})
    out = await _select(8)
    expect(out["missing"][0] == "巷道 近景", f"A8 条目压空白：{out['missing'][:2]}")
    expect(len(out["missing"]) == 8, f"A8 上限 8 条：{len(out['missing'])}")


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
expect(not imgresearch._prefilter_candidate(1280, 319, "新浪"), "短边 319 应拒（<320 硬线）")
expect(imgresearch._prefilter_candidate(550, 367, "新浪娱乐"), "老剧官方剧照 550x367 必须放行（漏斗实测教训）")
expect(imgresearch._prefilter_candidate(1280, 320, "新浪"), "短边 320 是放行线")
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
    # 每轮换新词：同词会被跨轮去重清空（fresh 为空就不终选），测不出补搜与判停
    n = len(plan_calls)
    return {"queries": [f"q{n}a", f"q{n}b", f"q{n}c"], "text_queries": [], "enough": False}


async def _fake_dl(url: str, referer: str = "") -> str:
    return f"/agent-service/assets/{Path(url).stem}.jpg"


async def _fake_select(asset: dict, candidates: list[dict]) -> dict:
    select_log.append([int(c["index"]) for c in candidates])
    resp = select_responses[len(select_log) - 1]
    if isinstance(resp, Exception):
        raise resp
    if isinstance(resp, dict):  # 完整形状（带缺口台账）
        return resp
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

# C5. 无进展判停：连续两轮零新推荐 → 停（搜索源给不出，不烧到 5 轮上限）
#     2026-09-12 端到端实测雪湾村：模型每轮都报「缺乏片场美术语境」，推荐恒 3 张
#     够不到判停线 4，旧逻辑白跑 5 轮 23 词
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.extend([[], []])
job = _mk_job("j5"); _reset_sem()
asyncio.run(imgresearch._run_research("j5", PID, "n6", [], {"name": "无进展资产", "type": "scene"}))
expect(job["status"] == "done", f"C5 任务应完成：{job.get('error')}")
expect(len(search_log) == 6, f"C5 两轮零推荐即停（不是跑满 5 轮 15 词）：{len(search_log)}")
expect(len(plan_calls) == 2, f"C5 planner 只叫两次：{len(plan_calls)}")
expect("零新推荐" in job.get("note", ""), f"C5 note 明说无进展判停：{job.get('note')}")

# C5b. 有进展就不触发：首轮 0 张、二轮 1 张 → 继续到三轮达标才停
# （二轮候选 index 是 6-11、三轮是 12-17——终选 index 是全局位次）
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.extend([[], [6], [12, 13, 14, 15]])
job = _mk_job("j5b"); _reset_sem()
asyncio.run(imgresearch._run_research("j5b", PID, "n7", [], {"name": "先无后有", "type": "scene"}))
expect(job["status"] == "done", f"C5b 任务应完成：{job.get('error')}")
expect(len(search_log) == 9, f"C5b 中途有进展不判停、跑到推荐达标：{len(search_log)}")

# C7. 缺口回流（A 档）：终选报的 missing 必须出现在下一轮 planner 的输入里——
#     这是「看缺口再搜」的命脉：没有它，补搜只是换角度重来
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.extend([
    {"recommended": [1], "note": "本批全是新闻配图",
     "covered": ["村落全景航拍"], "missing": ["巷道近景与铺地", "室内陈设"]},
    {"recommended": [6, 7, 8, 9], "note": "补齐", "covered": ["巷道近景"], "missing": []},
])
job = _mk_job("j6"); _reset_sem()
asyncio.run(imgresearch._run_research("j6", PID, "n8", [], {"name": "缺口回流", "type": "scene"}))
expect(job["status"] == "done", f"C7 任务应完成：{job.get('error')}")
expect(len(plan_calls) == 2, f"C7 应补搜一轮：{len(plan_calls)}")
_found = plan_calls[1][0]["found"]
expect("仍缺维度：巷道近景与铺地、室内陈设" in _found, f"C7 缺口必须进 planner 输入：{_found}")
expect("已覆盖维度：村落全景航拍" in _found, f"C7 已覆盖维度也要告知（防重复搜）：{_found}")
expect("终选推荐 1/6" in _found, f"C7 数量信号保留：{_found}")

# C6. 手填词：不跑 planner 不跑文路，全量手工词进首轮
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
select_responses.append([0, 3, 6, 5])
job = _mk_job("j4"); _reset_sem()
asyncio.run(
    imgresearch._run_research(
        "j4", PID, "n4", ["手词A", "手词B", "手词C", "手词D"], {"name": "手动", "type": "costume"}
    )
)
expect(job["status"] == "done", f"C6 任务应完成：{job.get('error')}")
expect(search_log == ["手词A", "手词B", "手词C", "手词D"], f"C6 手填词原样进首轮：{search_log}")
expect(plan_calls == [], f"C6 手动模式不跑 planner：{plan_calls}")
expect(job.get("researchBrief") == "", "C6 手动模式不跑文路")

# ───────────────── D. 来源页语境抓取（终选佐证，P4） ─────────────────

_d0 = PASS[0]


class _CtxResp:
    def __init__(
        self,
        text: str = "",
        ctype: str = "text/html; charset=utf-8",
        status: int = 200,
        raw: bytes | None = None,
        charset: str = "",
    ):
        self.text = text
        self.content = raw if raw is not None else text.encode("utf-8")
        self.charset_encoding = charset
        self.status_code = status
        self.headers = {"content-type": ctype}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _CtxClient:
    """按 URL 派发预制响应的假 httpx 客户端（_fetch_page_context 专用）。"""

    replies: dict[str, object] = {}

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url: str, headers=None):
        reply = self.replies.get(url, KeyError("no reply"))
        if isinstance(reply, Exception):
            raise reply
        return reply


_real_async_client = imgresearch.httpx.AsyncClient
imgresearch.httpx.AsyncClient = _CtxClient

# 摘要优先（meta description）
_meta_html = (
    '<html><head><meta name="description" content="1980年代浙南沿海村落的美术置景手记，'
    '含砖木老屋与窄巷的空间关系解析。"></head>'
    '<body><nav>首页 新闻 体育 财经</nav><p>' + "正文段落内容。" * 30 + "</p></body></html>"
)
# 无摘要 → 退正文段落，且要跳过长导航短行
_para_html = "<html><body><nav>首页 导航 登录 注册</nav><p>短</p><p>" + "美术设计置景特辑纪实。" * 12 + "</p></body></html>"
# GBK 页面（不声明 charset）：内容按 GBK 编码，期望不出现乱码
_gbk_text = '<html><head><meta name="description" content="温州一家人美术特辑：沿海村落置景与旧巷老屋。"></head></html>'
_gbk_html = _gbk_text.encode("gb18030")

_CtxClient.replies = {
    "http://ex.com/meta": _CtxResp(_meta_html),
    "http://ex.com/para": _CtxResp(_para_html),
    "http://ex.com/gbk": _CtxResp(raw=_gbk_html, charset=""),
    "http://ex.com/utf8decl": _CtxResp(raw=_gbk_text.encode("utf-8"), charset="utf-8"),
    "http://ex.com/pdf": _CtxResp("binary", ctype="application/pdf"),
    "http://ex.com/dead": _CtxResp(status=404),
}

_ctx = asyncio.run(imgresearch._fetch_page_context("http://ex.com/meta"))
expect(
    _ctx.startswith("1980年代浙南沿海村落的美术置景手记") and "首页 新闻" not in _ctx,
    f"D1 摘要优先、导航不进语境：{_ctx[:60]}",
)
_ctx2 = asyncio.run(imgresearch._fetch_page_context("http://ex.com/para"))
expect("美术设计置景特辑纪实" in _ctx2 and "导航" not in _ctx2, f"D2 无摘要退正文段落且跳过导航短行：{_ctx2[:50]}")
_ctx3 = asyncio.run(imgresearch._fetch_page_context("http://ex.com/gbk"))
expect(
    "温州一家人美术特辑" in _ctx3 and "\ufffd" not in _ctx3,
    f"D3 GBK 页面不乱码（resp.text 默认 UTF-8 曾整页乱码）：{_ctx3[:50]}",
)
expect(
    "温州一家人美术特辑" in asyncio.run(imgresearch._fetch_page_context("http://ex.com/utf8decl")),
    "D4 声明 utf-8 的正常解",
)
expect(asyncio.run(imgresearch._fetch_page_context("http://ex.com/pdf")) == "", "D5 非 html 返回空串")
expect(asyncio.run(imgresearch._fetch_page_context("http://ex.com/dead")) == "", "D6 HTTP 错误软失败空串")
expect(asyncio.run(imgresearch._fetch_page_context("")) == "", "D7 空 url 空串")
expect(asyncio.run(imgresearch._fetch_page_context("http://ex.com/none")) == "", "D8 网络异常软失败空串")
expect(len(asyncio.run(imgresearch._fetch_page_context("http://ex.com/meta"))) <= 200, "D9 语境长度仍受 200 字上限")

imgresearch.httpx.AsyncClient = _real_async_client
print(f"D 组（来源页语境抓取）通过：{PASS[0] - _d0}")

# ───────────── E. 终选载荷带 context（payload 契约） ─────────────

_e0 = PASS[0]
_rows = [
    {"assetUrl": "/agent-service/assets/aa11.jpg", "title": "t0", "pageContext": " " + "美术特辑" * 40 + " ",
     "width": 800, "height": 600, "provider": "google"},
    {"assetUrl": "/agent-service/assets/bb22.jpg", "title": "t1",
     "width": 800, "height": 600, "provider": "google"},
]
_payload = imgresearch._select_payload(_rows, start=6)
expect(_payload[0]["index"] == 6 and _payload[1]["index"] == 7, "E1 start 偏移全局位次")
expect(_payload[0]["context"] == "美术特辑" * 40 and len(_payload[0]["context"]) == 160, f"E2 pageContext 压空白入载荷：{len(_payload[0]['context'])}")
expect(_payload[1]["context"] == "", "E3 无语境的候选 context 为空串（不是缺字段）")
print(f"E 组（载荷契约）通过：{PASS[0] - _e0}")

# ───────────── F. 主流程：终选前抓语境进载荷（集成） ─────────────

_f0 = PASS[0]
ctx_calls: list[str] = []
_real_fpc = imgresearch._fetch_page_context


async def _fake_ctx(url: str) -> str:
    ctx_calls.append(url)
    return f"页面语境：{url}"


imgresearch._fetch_page_context = _fake_ctx
search_log.clear(); plan_calls.clear(); select_log.clear(); select_responses.clear()
_seen_ctx: list[list[str]] = []


async def _spy_select(asset: dict, candidates: list[dict]) -> dict:
    _seen_ctx.append([str(c.get("context")) for c in candidates])
    select_log.append([int(c["index"]) for c in candidates])
    return {"recommended": [0, 1, 2, 3], "note": "mock"}


skills.run_ref_select_flow = _spy_select
job = _mk_job("j5"); _reset_sem()
asyncio.run(imgresearch._run_research("j5", PID, "n5", [], {"name": "语境资产", "type": "scene"}))
expect(job["status"] == "done", f"F1 任务应完成：{job.get('error')}")
expect(len(ctx_calls) == 6, f"F2 每张候选都抓一次来源页语境：{len(ctx_calls)}")
expect(
    _seen_ctx and set(_seen_ctx[0]) == {"页面语境：http://ex.com/p"}, f"F3 语境全部进终选载荷：{_seen_ctx[:1]}"
)
skills.run_ref_select_flow = _fake_select
imgresearch._fetch_page_context = _real_fpc

print(f"F 组（主流程集成）通过：{PASS[0] - _f0}")

imgresearch.search_serper_images = _orig_search
imgresearch.download_image = _orig_dl
skills.run_ref_plan_flow = _orig_plan
skills.run_ref_select_flow = _orig_sel
asyncio.sleep = _real_sleep

print(f"C 组（先搜后判再补）通过：{PASS[0]}")
print(f"全部通过：{PASS[0]} 项")
