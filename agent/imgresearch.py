"""资产参考图调研：豆包搜图（火山）+ Wikimedia Commons 双渠道搜图，
候选下载落盘入库，调研任务异步 job + 轮询（Next 同源代理 30s 掐断，不能阻塞）。

一期人工筛选：搜回的候选由用户在面板勾选采纳，不做视觉模型自动复核。
渠道错误各自明报（errors 进任务结果），不静默降级——豆包 key 未配/额度尽
与 wikimedia 网络故障都能从面板看到。
"""

from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

import thumbs  # noqa: E402  (与 main.py 同式：dotenv 之后导入)
from skills import ASSETS_DIR

# 候选缩略图绝对 URL 前缀（终选 flow 经 http 下载；与 skills 出图参考同源）
ASSET_BASE_URL = os.environ.get("ASSET_BASE_URL", "http://127.0.0.1:8123")

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

# 豆包 SearchType=image 单次最多 5 条（接口上限）
VOLC_MAX_PER_QUERY = 5
# Commons API gsrlimit 上限 50，取 16 保查询速度
WIKIMEDIA_MAX_PER_QUERY = 16
# 单次调研任务最多入库候选数：2 轮 × 5 查询（豆包 25 + wikimedia 80/轮，
# 去重后 ~100）；终选模型 gpt-5.6-luna 上游单请求限 50 张图，分 2 批跑
MAX_CANDIDATES_PER_JOB = 100
# 采纳上限：对齐出图模型参考图上限的宽顶（seedream-5-pro 融合通道 10 张；
# 具体模型的真实上限在出图时按 models.max_references 校验明报）
MAX_ADOPT_PER_NODE = 10
_DOWNLOAD_TIMEOUT = httpx.Timeout(30.0)
# wikimedia 对同域并发敏感（juben 同域并发 2 的口径），整体并发 3
_DOWNLOAD_CONCURRENCY = 3
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
# wikimedia 批量下载常撞 429/5xx 限流，带退避重试（juben fetch 同口径）
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3
_ALLOWED_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}
_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
# wikimedia UA 政策要求带联系信息，否则容易被限流
_UA = "WingsightStudio/1.0 (reference-research; contact: admin@wingsight.local)"


# ---------- 存储 ----------


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_ref_research_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ref_candidates (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                query TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                page_url TEXT NOT NULL DEFAULT '',
                source_domain TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL,
                asset_url TEXT NOT NULL DEFAULT '',
                width INTEGER NOT NULL DEFAULT 0,
                height INTEGER NOT NULL DEFAULT 0,
                adopted INTEGER NOT NULL DEFAULT 0,
                recommended INTEGER NOT NULL DEFAULT 0,
                rec_reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                idx_total INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ref_candidates_node
                ON ref_candidates(project_id, node_id, idx_total);
            """
        )
        # 已建旧表补列（新列不允许静默缺失）
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ref_candidates)").fetchall()}
        for col, ddl in (
            ("recommended", "ALTER TABLE ref_candidates ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0"),
            ("rec_reason", "ALTER TABLE ref_candidates ADD COLUMN rec_reason TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in cols:
                conn.execute(ddl)


def _to_dict(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "nodeId": r["node_id"],
        "query": r["query"],
        "provider": r["provider"],
        "title": r["title"],
        "pageUrl": r["page_url"],
        "sourceDomain": r["source_domain"],
        "sourceUrl": r["source_url"],
        "assetUrl": r["asset_url"],
        "width": r["width"],
        "height": r["height"],
        "adopted": bool(r["adopted"]),
        "recommended": bool(r["recommended"]),
        "recReason": r["rec_reason"],
        "createdAt": r["created_at"],
    }


def list_candidates(project_id: str, node_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM ref_candidates WHERE project_id = ? AND node_id = ?"
            " ORDER BY adopted DESC, idx_total DESC, created_at DESC",
            (project_id, node_id),
        ).fetchall()
    return [_to_dict(r) for r in rows]


def mark_adopted(
    project_id: str, node_id: str, ids: list[str]
) -> list[dict[str, Any]]:
    if not ids:
        return []
    with _conn() as conn:
        conn.executemany(
            "UPDATE ref_candidates SET adopted = 1 WHERE id = ?"
            " AND project_id = ? AND node_id = ?",
            [(cid, project_id, node_id) for cid in ids],
        )
        rows = conn.execute(
            "SELECT * FROM ref_candidates WHERE project_id = ? AND node_id = ?"
            " AND id IN (%s)" % ",".join("?" * len(ids)),
            [project_id, node_id, *ids],
        ).fetchall()
    return [_to_dict(r) for r in rows]


def delete_candidate(project_id: str, cid: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM ref_candidates WHERE id = ? AND project_id = ?",
            (cid, project_id),
        )
    return cur.rowcount > 0


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------- 渠道一：豆包搜图（火山引擎 Custom 版） ----------

_VOLC_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search"
# ResponseMetadata.Error.CodeN → 业务错误分类（HTTP 200 也可能是业务错误）
_VOLC_ERR_AUTH = {10401}
_VOLC_ERR_UNCONFIGURED = {10402, 10403}
_VOLC_ERR_QUOTA = {10406, 10412}
_VOLC_ERR_RATE = {700429}


async def search_volc_images(query: str, limit: int = VOLC_MAX_PER_QUERY) -> list[dict[str, Any]]:
    api_key = os.environ.get("VOLC_SEARCH_API_KEY", "").strip()
    if not api_key:
        raise ValueError("豆包搜图未配置：请在根目录 .env.local 填 VOLC_SEARCH_API_KEY")
    payload = {"Query": query, "SearchType": "image", "Count": max(1, min(limit, VOLC_MAX_PER_QUERY))}
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": _UA}
    async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT) as client:
        resp = await client.post(_VOLC_ENDPOINT, headers=headers, json=payload)
    try:
        data = resp.json()
    except ValueError as exc:
        raise ValueError(f"豆包搜图返回非 JSON（HTTP {resp.status_code}）") from exc
    if not isinstance(data, dict):
        raise ValueError("豆包搜图返回格式异常")
    meta = data.get("ResponseMetadata")
    if isinstance(meta, dict) and isinstance(meta.get("Error"), dict):
        err = meta["Error"]
        code_raw = err.get("CodeN")
        try:
            code = int(code_raw) if code_raw is not None else None
        except (TypeError, ValueError):
            code = None
        msg = str(err.get("Message") or "")
        if code in _VOLC_ERR_AUTH:
            raise ValueError(f"豆包搜图鉴权失败（{code}）：{msg}")
        if code in _VOLC_ERR_QUOTA:
            raise ValueError(f"豆包搜图额度不足（{code}）：{msg}")
        if code in _VOLC_ERR_RATE:
            raise ValueError(f"豆包搜图请求受限（{code}）：{msg}")
        if code in _VOLC_ERR_UNCONFIGURED:
            raise ValueError(f"豆包搜图服务未开通（{code}）：{msg}")
        raise ValueError(f"豆包搜图失败（{code}）：{msg}")
    result = data.get("Result")
    images = result.get("ImageResults") if isinstance(result, dict) else None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in images or []:
        if not isinstance(item, dict):
            continue
        info = item.get("Image")
        if not isinstance(info, dict):
            continue
        url = str(info.get("Url") or "").strip()
        if not url:
            continue
        key = _dedupe_key(url)
        if key in seen:
            continue
        seen.add(key)
        page_url = str(item.get("Url") or "").strip()
        out.append(
            {
                "provider": "豆包搜图",
                "title": str(item.get("Title") or "").strip() or url,
                "sourceUrl": url,
                "pageUrl": page_url,
                "sourceDomain": _domain(url),
                "width": _int_or_zero(info.get("Width")),
                "height": _int_or_zero(info.get("Height")),
            }
        )
        if len(out) >= limit:
            break
    return out


# ---------- 渠道二：Wikimedia Commons（免 key，公版/自由版权图库） ----------

_WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"
# 古籍扫描（CADAL 等）mime 以 image/ 开头但不是位图，不能进候选
_NON_BITMAP_MIME = ("vnd.djvu", "x.djvu", "svg+xml")


async def search_wikimedia_images(query: str, limit: int = WIKIMEDIA_MAX_PER_QUERY) -> list[dict[str, Any]]:
    results = await _wikimedia_request(query, limit)
    if results:
        return results
    # 0 结果降级：Commons 文件名以英文/专名为主，全文多词 AND 常无命中；
    # intitle: 只匹配标题绕开 PDF 正文（juben 同款改写策略）
    words = [w for w in re.split(r"[\s　]+", query.strip()) if w]
    variants: list[str] = []
    if len(words) >= 2:
        variants.append(f"intitle:{words[0]} {words[1]}")
    if words:
        variants.append(f"intitle:{words[0]}")
    for rewritten in variants:
        results = await _wikimedia_request(rewritten, limit)
        if results:
            return results
    return []


async def _wikimedia_request(search_query: str, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "action": "query",
        "generator": "search",
        "gsrnamespace": 6,
        "gsrsearch": search_query,
        "gsrlimit": max(1, min(limit, 50)),
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "iiurlwidth": 300,
        "format": "json",
        "formatversion": 2,
    }
    headers = {"User-Agent": _UA}
    data: dict[str, Any] = {}
    for attempt in range(_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT) as client:
                resp = await client.get(_WIKIMEDIA_API, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            break
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            raise
    pages = (data.get("query") or {}).get("pages")
    if not isinstance(pages, list):
        return []
    pages = [p for p in pages if isinstance(p, dict)]
    pages.sort(key=lambda p: int(p.get("index") or 0))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        title = str(page.get("title") or "")
        infos = page.get("imageinfo")
        if not isinstance(infos, list) or not infos or not isinstance(infos[0], dict):
            continue
        info = infos[0]
        mime = str(info.get("mime") or "")
        url = str(info.get("url") or "").strip()
        if not url or not mime.startswith("image/"):
            continue
        if any(suffix in mime for suffix in _NON_BITMAP_MIME):
            continue
        key = _dedupe_key(url)
        if key in seen:
            continue
        seen.add(key)
        display = title.removeprefix("File:").strip() or url
        page_url = str(info.get("descriptionurl") or "")
        if not page_url and title:
            page_url = f"https://commons.wikimedia.org/wiki/{title.replace(' ', '_')}"
        out.append(
            {
                "provider": "wikimedia",
                "title": display,
                "sourceUrl": url,
                "pageUrl": page_url,
                "sourceDomain": _domain(page_url or url),
                "width": _int_or_zero(info.get("width")),
                "height": _int_or_zero(info.get("height")),
            }
        )
        if len(out) >= limit:
            break
    return out


# ---------- 下载落盘（外链有防盗链/时效，必须存本地才能喂出图） ----------


async def download_image(url: str, referer: str = "") -> str:
    """下载图片到素材目录，返回 /agent-service/assets/{fname}；失败抛异常。"""
    headers = {"User-Agent": _UA}
    if referer:
        headers["Referer"] = referer
    last_error: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                if ctype not in _ALLOWED_MIMES:
                    raise ValueError(f"非位图内容（{ctype or '未知类型'}，疑似防盗链页）")
                body = resp.content
            if len(body) > _MAX_IMAGE_BYTES:
                raise ValueError(f"图片超过 {_MAX_IMAGE_BYTES // 1024 // 1024}MB 上限")
            if not body:
                raise ValueError("空响应")
            ext = _EXT_BY_MIME.get(ctype, ".jpg")
            fname = f"{uuid.uuid4().hex[:12]}{ext}"
            (ASSETS_DIR / fname).write_bytes(body)
            await asyncio.to_thread(thumbs.make_for, fname)
            return f"/agent-service/assets/{fname}"
        except httpx.HTTPStatusError as exc:
            last_error = exc
            if exc.response.status_code in _RETRYABLE_STATUS and attempt < _MAX_ATTEMPTS - 1:
                await asyncio.sleep(2.0 * (attempt + 1))
                continue
            raise
    raise last_error  # type: ignore[misc]


# ---------- 调研任务（异步 job + 轮询） ----------

REF_JOBS: dict[str, dict[str, Any]] = {}


def get_research_job(job_id: str) -> dict[str, Any] | None:
    return REF_JOBS.get(job_id)


def start_research_job(
    project_id: str,
    node_id: str,
    queries: list[str],
    asset: dict[str, Any] | None = None,
) -> str:
    job_id = uuid.uuid4().hex[:12]
    REF_JOBS[job_id] = {
        "jobId": job_id,
        "projectId": project_id,
        "nodeId": node_id,
        "status": "running",
        "candidates": [],
        "errors": {},
        "error": "",
        "note": "",
    }
    task = asyncio.create_task(
        _run_research(job_id, project_id, node_id, queries, asset or {})
    )
    _prune_jobs(task)
    return job_id


# ---------- 批量调研（拆解链后对多个资产串行调研；防打爆搜索配额） ----------

BATCH_JOBS: dict[str, dict[str, Any]] = {}
# 队列并发 = 1：豆包免费配额按次计，批量调研串行跑，失败不影响后续资产
BATCH_CONCURRENCY = 1


def start_batch_research(
    project_id: str, assets: list[dict[str, Any]]
) -> str:
    """assets: [{nodeId, name, type, description}]；返回 batchId。

    逐资产串行跑单资产调研（AI 出词→双渠道搜→终选），每项结果记入
    items；某资产失败只记该条 error，不中断整批。"""
    batch_id = uuid.uuid4().hex[:12]
    BATCH_JOBS[batch_id] = {
        "batchId": batch_id,
        "projectId": project_id,
        "status": "running",
        "total": len(assets),
        "done": 0,
        "current": assets[0]["name"] if assets else "",
        "items": [
            {"nodeId": a["nodeId"], "name": a["name"], "status": "pending", "error": ""}
            for a in assets
        ],
    }
    task = asyncio.create_task(_run_batch(batch_id, project_id, assets))
    _prune_jobs(task)
    return batch_id


def get_batch_research_job(batch_id: str) -> dict[str, Any] | None:
    return BATCH_JOBS.get(batch_id)


async def _run_batch(
    batch_id: str, project_id: str, assets: list[dict[str, Any]]
) -> None:
    batch = BATCH_JOBS.get(batch_id)
    if batch is None:
        return
    sem = asyncio.Semaphore(BATCH_CONCURRENCY)
    for i, a in enumerate(assets):
        node_id = str(a.get("nodeId") or "")
        name = str(a.get("name") or "")
        batch["current"] = name
        batch["items"][i]["status"] = "running"
        try:
            async with sem:
                job_id = start_research_job(
                    project_id,
                    node_id,
                    [],
                    {
                        "name": name,
                        "type": str(a.get("type") or "character"),
                        "description": str(a.get("description") or ""),
                    },
                )
                # 串行等本资产调研结束（轮询 REF_JOBS 终态）
                while True:
                    job = REF_JOBS.get(job_id)
                    if job is None or job["status"] != "running":
                        break
                    await asyncio.sleep(1.0)
                job = REF_JOBS.get(job_id) or {}
                if job.get("status") == "error" or job.get("error"):
                    batch["items"][i].update(
                        status="error", error=str(job.get("error") or "")[:160]
                    )
                else:
                    batch["items"][i].update(status="done", error="")
        except Exception as exc:  # noqa: BLE001 单资产失败不中断整批
            batch["items"][i].update(status="error", error=str(exc)[:160])
        batch["done"] = i + 1
    batch["status"] = "done"
    batch["current"] = ""


def _prune_jobs(task: asyncio.Task) -> None:
    def _cleanup(t: asyncio.Task) -> None:
        done = [k for k, v in REF_JOBS.items() if v["status"] in ("done", "error")]
        if len(done) > 50:
            for k in done[:-50]:
                REF_JOBS.pop(k, None)

    task.add_done_callback(_cleanup)


async def _run_research(
    job_id: str,
    project_id: str,
    node_id: str,
    queries: list[str],
    asset: dict[str, Any],
) -> None:
    """调研主流程：搜索（≤2 轮，planner 判定补搜）→ LLM 终选 → 落库。

    手填 queries 时首轮用手工词；否则每轮由 planner flow 生成考据向搜索词
    （第二轮起带已完成轮次摘要，自动换角度）。整体受 110s 死线约束。"""
    import skills

    job = REF_JOBS.get(job_id)
    if job is None:
        return
    errors: dict[str, str] = {}
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    rounds: list[dict[str, Any]] = []
    manual = bool(queries)
    try:
        for round_num in (1, 2):
            if round_num == 1:
                # 首轮：手填词直用；AI 模式由 planner 出词
                round_queries = queries if manual else (await skills.run_ref_plan_flow(asset, []))["queries"]
            else:
                plan = await skills.run_ref_plan_flow(asset, rounds)
                if plan["enough"]:
                    break
                round_queries = plan["queries"]
            for query in round_queries:
                channel_results = await asyncio.gather(
                    _guarded(search_volc_images(query), "豆包搜图", errors),
                    _guarded(search_wikimedia_images(query), "wikimedia", errors),
                )
                for items in channel_results:
                    for item in items:
                        key = _dedupe_key(item["sourceUrl"])
                        if key in seen:
                            continue
                        seen.add(key)
                        item["query"] = query
                        merged.append(item)
                await asyncio.sleep(1.0)  # 查询间隔，缓解 wikimedia API 限流
            rounds.append({"queries": round_queries, "found": _rounds_summary(merged)})
        if not merged:
            if errors:
                raise RuntimeError("；".join(f"{k}：{v}" for k, v in errors.items()))
            job["status"] = "done"
            job["error"] = "两个渠道都没有搜到候选图，请换个关键词"
            return
        merged = merged[:MAX_CANDIDATES_PER_JOB]
        # 并发下载（信号量限速）；单张失败不拖垮整批，失败者不入库。
        # 整体 110s 死线：超时取消在途下载，保留已完成部分（前端轮询 120s 截止）
        sem = asyncio.Semaphore(_DOWNLOAD_CONCURRENCY)
        dl_errors: list[str] = []

        async def _fetch(item: dict[str, Any]) -> None:
            async with sem:
                try:
                    item["assetUrl"] = await download_image(item["sourceUrl"], item.get("pageUrl") or "")
                except Exception as exc:  # noqa: BLE001 单张下载失败留痕不入库
                    dl_errors.append(f"{item.get('title') or item['sourceUrl']}：{str(exc)[:80]}")

        try:
            await asyncio.wait_for(
                asyncio.gather(*[_fetch(item) for item in merged]), timeout=110.0
            )
        except (asyncio.TimeoutError, TimeoutError):
            dl_errors.append("整体下载超时，仅保留已完成部分")
        if dl_errors:
            errors["下载"] = "；".join(dl_errors[:3]) + ("…" if len(dl_errors) > 3 else "")
        rows = [m for m in merged if m.get("assetUrl")]
        if not rows:
            raise RuntimeError(
                "候选图全部下载失败（疑似外链防盗链）；" + "；".join(f"{k}：{v}" for k, v in errors.items())
            )
        _insert_candidates(project_id, node_id, rows)
        # LLM 终选（失败只记 errors，不影响候选展示与人工采纳）
        try:
            selection = await skills.run_ref_select_flow(asset, _select_payload(rows))
            _apply_recommendation(project_id, node_id, rows, selection)
            job["note"] = selection.get("note") or ""
        except Exception as exc:  # noqa: BLE001
            errors["终选"] = str(exc)[:160]
        job["candidates"] = list_candidates(project_id, node_id)
        job["errors"] = errors
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 任务级失败明报
        job["status"] = "error"
        job["error"] = str(exc)[:300]


def _rounds_summary(merged: list[dict[str, Any]]) -> str:
    """已完成轮次的候选摘要（planner 判「够不够」的依据，抽样 15 条）。"""
    if not merged:
        return "无候选"
    return "；".join(
        f"{m.get('provider')}|{str(m.get('title') or '')[:40]}|{m.get('width')}x{m.get('height')}"
        for m in merged[:15]
    )


def _select_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """终选载荷：缩略图 URL（512px webp，够判断且省 token）+ 元数据。

    全量候选进终选：skills.run_ref_select_flow 侧按 DMX gemini 通道
    单轮 4 张上限自动分批（每批 ≤4）再合并推荐。"""
    out: list[dict[str, Any]] = []
    for i, m in enumerate(rows):
        stem = Path(m["assetUrl"]).stem
        out.append(
            {
                "index": i,
                "title": m.get("title") or "",
                "width": m.get("width") or 0,
                "height": m.get("height") or 0,
                "provider": m.get("provider") or "",
                "url": f"{ASSET_BASE_URL}/thumbs/{stem}.webp",
            }
        )
    return out


def _apply_recommendation(
    project_id: str,
    node_id: str,
    rows: list[dict[str, Any]],
    selection: dict[str, Any],
) -> None:
    """把终选结果回填 ref_candidates.recommended（按 source_url 匹配行）。"""
    rec_idx = set(selection.get("recommended") or [])
    note = selection.get("note") or ""
    with _conn() as conn:
        for i, m in enumerate(rows):
            conn.execute(
                "UPDATE ref_candidates SET recommended = ?, rec_reason = ?"
                " WHERE project_id = ? AND node_id = ? AND source_url = ?",
                (1 if i in rec_idx else 0, note, project_id, node_id, m["sourceUrl"][:800]),
            )


def _insert_candidates(project_id: str, node_id: str, rows: list[dict[str, Any]]) -> None:
    base = _now()
    with _conn() as conn:
        for i, m in enumerate(rows):
            cid = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO ref_candidates (id, project_id, node_id, query, provider,"
                " title, page_url, source_domain, source_url, asset_url, width, height,"
                " adopted, recommended, rec_reason, created_at, idx_total)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,'',?,?)",
                (
                    cid,
                    project_id,
                    node_id,
                    m.get("query") or "",
                    m.get("provider") or "",
                    (m.get("title") or "")[:200],
                    (m.get("pageUrl") or "")[:500],
                    (m.get("sourceDomain") or "")[:100],
                    m["sourceUrl"][:800],
                    m["assetUrl"],
                    int(m.get("width") or 0),
                    int(m.get("height") or 0),
                    base,
                    i,
                ),
            )


async def _guarded(coro: Any, channel: str, errors: dict[str, str]) -> list[dict[str, Any]]:
    """单渠道失败只记 errors（面板明报），不让另一渠道白跑。"""
    try:
        return await coro
    except Exception as exc:  # noqa: BLE001
        errors[channel] = str(exc)[:160]
        return []


def _dedupe_key(url: str) -> str:
    p = urlparse(url)
    return f"{p.netloc.lower()}{p.path}"


def _domain(url: str) -> str:
    return urlparse(url).netloc or ""


def _int_or_zero(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return 0
