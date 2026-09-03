"""资产参考图调研：Serper 号池（Google 图片搜索）搜图，候选下载落盘入库，
调研任务异步 job + 轮询（Next 同源代理 30s 掐断，不能阻塞）。

搜索词由 planner flow 生成（手填可覆盖），LLM 终选推荐；采纳权在用户。
号池 round-robin 轮转，401/403（无效/额度耗尽）自动作废换下一个 key，
429 限速换 key 重试；号池管理在 /api/v1/serper-keys（管理后台）。
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

# Serper /images 单次最多 10 条（接口上限）
SERPER_MAX_PER_QUERY = 10
# 迭代轮数上限（质量优先）：每轮结束 planner 依据全部轮次历史判 enough，
# 不够则换角度补搜；上限只是防失控安全网，通常 2-3 轮即够
MAX_RESEARCH_ROUNDS = 5
# 单次调研任务最多入库候选数：5 轮 × 5 查询 × 10 条（去重后 ≤250）；
# 终选模型 gpt-5.6-luna 上游单请求限 50 张图，自动分批跑
MAX_CANDIDATES_PER_JOB = 250
# 采纳上限：对齐出图模型参考图上限的宽顶（seedream-5-pro 融合通道 10 张；
# 具体模型的真实上限在出图时按 models.max_references 校验明报）
MAX_ADOPT_PER_NODE = 10
_DOWNLOAD_TIMEOUT = httpx.Timeout(30.0)
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


def candidate_summary(project_id: str) -> list[dict[str, Any]]:
    """按资产汇总候选计数：资产卡「N 张参考候选待选」徽标的数据源（一次
    请求拿全项目，避免每卡各拉一遍候选列表）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT node_id, COUNT(*) AS total,"
            " COALESCE(SUM(adopted), 0) AS adopted,"
            " COALESCE(SUM(recommended), 0) AS recommended"
            " FROM ref_candidates WHERE project_id = ? GROUP BY node_id",
            (project_id,),
        ).fetchall()
    return [
        {
            "nodeId": r["node_id"],
            "total": r["total"],
            "adopted": r["adopted"],
            "recommended": r["recommended"],
        }
        for r in rows
    ]


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


# ---------- 搜索渠道：Serper 号池（serper.dev 中转的 Google 图片搜索） ----------

_SERPER_IMAGES_ENDPOINT = "https://google.serper.dev/images"
# 号池轮转指针（单事件循环，无需锁）
_SERPER_RR = 0


def init_serper_pool_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS serper_keys (
                id TEXT PRIMARY KEY,
                api_key TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'active',
                used_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                exhausted_at TEXT
            );
            """
        )


def _active_serper_keys() -> list[sqlite3.Row]:
    with _conn() as conn:
        return conn.execute(
            "SELECT * FROM serper_keys WHERE status = 'active' ORDER BY created_at, id"
        ).fetchall()


def serper_pool_add_keys(keys: list[str]) -> dict[str, int]:
    """批量入池（按 key 去重），返回 {added, duplicated}。"""
    added = duplicated = 0
    now = _now()
    with _conn() as conn:
        for k in keys:
            k = k.strip()
            if not k:
                continue
            if conn.execute("SELECT 1 FROM serper_keys WHERE api_key = ?", (k,)).fetchone():
                duplicated += 1
                continue
            conn.execute(
                "INSERT INTO serper_keys (id, api_key, status, used_count, created_at)"
                " VALUES (?,?,'active',0,?)",
                (uuid.uuid4().hex[:12], k, now),
            )
            added += 1
    return {"added": added, "duplicated": duplicated}


def serper_pool_list() -> list[dict[str, Any]]:
    """号池清单（key 打码，绝不整串下发浏览器）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM serper_keys ORDER BY status, created_at"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "masked": (r["api_key"][:6] + "…" + r["api_key"][-4:]) if len(r["api_key"]) > 12 else "…",
            "status": r["status"],
            "usedCount": r["used_count"],
            "createdAt": r["created_at"],
            "exhaustedAt": r["exhausted_at"],
        }
        for r in rows
    ]


def serper_pool_delete(key_id: str) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM serper_keys WHERE id = ?", (key_id,))
    return cur.rowcount > 0


def _mark_serper_exhausted(key_id: str) -> None:
    """额度耗尽/无效的 key 直接作废（号池语义：用完即弃）。"""
    with _conn() as conn:
        conn.execute(
            "UPDATE serper_keys SET status = 'exhausted', exhausted_at = ?"
            " WHERE id = ? AND status = 'active'",
            (_now(), key_id),
        )


def _bump_serper_used(key_id: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE serper_keys SET used_count = used_count + 1 WHERE id = ?", (key_id,)
        )


async def search_serper_images(query: str, limit: int = SERPER_MAX_PER_QUERY) -> list[dict[str, Any]]:
    """Google 图片搜索经 Serper 号池：结构化 imageUrl/宽高/来源域/来源页。

    号池 round-robin 轮转：401/403 = key 无效或额度耗尽 → 该 key 自动作废
    并立即换下一个；429 = 限速 → 换下一个 key 重试（不作废）。号池为空或
    全部 key 不可用时明报（提示到管理后台补 key），不静默。"""
    global _SERPER_RR
    body = {"q": query, "num": max(1, min(limit, 10))}
    actives = _active_serper_keys()
    if not actives:
        raise ValueError("Serper 号池为空：请在管理后台「Serper 号池」添加 API key（serper.dev，注册送 2500 次）")
    last_error: Exception | None = None
    # 尝试遍历一圈活 key（429/作废换 key 在同一轮里消化）
    for _ in range(len(actives)):
        _SERPER_RR = (_SERPER_RR + 1) % len(actives)
        entry = actives[_SERPER_RR]
        headers = {"X-API-KEY": entry["api_key"], "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT) as client:
            resp = await client.post(_SERPER_IMAGES_ENDPOINT, headers=headers, json=body)
        if resp.status_code in (401, 403):
            # 无效 key / 额度耗尽：作废并换下一个（号池语义）
            _mark_serper_exhausted(entry["id"])
            last_error = ValueError(
                f"Serper key {entry['api_key'][:6]}… 已作废（HTTP {resp.status_code}：无效或额度耗尽）"
            )
            actives = _active_serper_keys()
            if not actives:
                break
            _SERPER_RR %= len(actives)
            continue
        if resp.status_code == 429:
            # 限速：换 key 重试，不作废
            last_error = ValueError("Serper 请求受限（HTTP 429）")
            continue
        if resp.status_code >= 400:
            raise ValueError(f"Serper 搜索失败（HTTP {resp.status_code}）：{resp.text[:120]}")
        _bump_serper_used(entry["id"])
        data = resp.json()
        images = data.get("images") if isinstance(data, dict) else None
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in images or []:
            if not isinstance(item, dict):
                continue
            url = str(item.get("imageUrl") or "").strip()
            if not url:
                continue
            key = _dedupe_key(url)
            if key in seen:
                continue
            seen.add(key)
            page_url = str(item.get("link") or "").strip()
            out.append(
                {
                    "provider": "google",
                    "title": str(item.get("title") or "").strip() or url,
                    "sourceUrl": url,
                    "pageUrl": page_url,
                    "sourceDomain": str(item.get("source") or "").strip() or _domain(page_url or url),
                    "width": _int_or_zero(item.get("imageWidth")),
                    "height": _int_or_zero(item.get("imageHeight")),
                }
            )
            if len(out) >= limit:
                break
        return out
    raise last_error  # type: ignore[misc]


_SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search"


async def search_serper_web(query: str, num: int = 6) -> list[dict[str, Any]]:
    """Google 网页搜索经 Serper 号池（深度调研的统一搜索通道）。

    返回 organic 结果 [{title, url, snippet, position}]，中文语境
    （hl=zh-cn / gl=cn）。号池语义与图片搜索一致：401/403 作废换 key、
    429 限速换 key，号池为空明报。
    """
    global _SERPER_RR
    body = {"q": query, "num": max(1, min(num, 10)), "hl": "zh-cn", "gl": "cn"}
    actives = _active_serper_keys()
    if not actives:
        raise ValueError("Serper 号池为空：请在管理后台「Serper 号池」添加 API key（serper.dev，注册送 2500 次）")
    last_error: Exception | None = None
    for _ in range(len(actives)):
        _SERPER_RR = (_SERPER_RR + 1) % len(actives)
        entry = actives[_SERPER_RR]
        headers = {"X-API-KEY": entry["api_key"], "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT) as client:
            resp = await client.post(_SERPER_SEARCH_ENDPOINT, headers=headers, json=body)
        if resp.status_code in (401, 403) or (
            resp.status_code == 400 and "credit" in resp.text.lower()
        ):
            _mark_serper_exhausted(entry["id"])
            last_error = ValueError(
                f"Serper key {entry['api_key'][:6]}… 已作废（HTTP {resp.status_code}：无效或额度耗尽）"
            )
            actives = _active_serper_keys()
            if not actives:
                break
            _SERPER_RR %= len(actives)
            continue
        if resp.status_code == 429:
            last_error = ValueError("Serper 请求受限（HTTP 429）")
            continue
        if resp.status_code >= 400:
            raise ValueError(f"Serper 网页搜索失败（HTTP {resp.status_code}）：{resp.text[:120]}")
        _bump_serper_used(entry["id"])
        data = resp.json()
        organic = data.get("organic") if isinstance(data, dict) else None
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in organic or []:
            if not isinstance(item, dict):
                continue
            url = str(item.get("link") or "").strip()
            if not url:
                continue
            key = _dedupe_key(url)
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": str(item.get("title") or "").strip() or url,
                    "url": url,
                    "snippet": str(item.get("snippet") or "").strip(),
                    "position": _int_or_zero(item.get("position")),
                }
            )
            if len(out) >= num:
                break
        return out
    raise last_error  # type: ignore[misc]


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
        "researchBrief": "",
    }
    task = asyncio.create_task(
        _run_research(job_id, project_id, node_id, queries, asset or {})
    )
    _prune_jobs(task)
    return job_id


# ---------- 批量调研（拆解链后对多个资产并发调研） ----------

BATCH_JOBS: dict[str, dict[str, Any]] = {}
# 20 路并发（serper 号池按 key 轮转承接 QPS；单 key 会被 429 打满）。
# 上限也是 langflow 内存闸门：每路资产调研会同时打 plan+select flow，
# langflow 每次 run 都整图重建（图还要进内存缓存），并发不封顶时
# RSS 会被瞬时尖峰顶穿（2026-09-02 曾膨胀到 10.4GB 拖垮全机）
BATCH_CONCURRENCY = 20
# 跨任务全局下载并发：100 路调研的候选下载共享同一信号量（Google 图源
# 域名分散，32 并发安全；过高会撞原站防盗链）
_GLOBAL_DOWNLOAD_SEM = asyncio.Semaphore(32)


# ---------- 文字考据（fork-join 文路：与图路并行，终选汇合） ----------

# 文路规模闸门：查询/页面/正文长度上限（research.fetch_page_text 另有 8MB/20s 硬闸）
_MAX_TEXT_QUERIES = 3
_MAX_PAGES = 4
_PAGE_TEXT_CHARS = 5000
_BRIEF_WAIT_S = 150  # 文路整体死线（与图路下载 110s 死线并行，不拖后腿）


async def _run_text_research(
    asset: dict[str, Any], queries: list[str], errors: dict[str, str]
) -> str:
    """文字考据：web 搜索 → 抓正文 → LLM 提纯成考据简报。

    任何一步失败都抛错由调用方记软失败（errors["考据"]），绝不影响图路。
    简报供两处消费：select 终选带简报挑图（纠错配错年代）、落卡喂写设定
    与出图设定。"""
    import research
    import skills

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for q in queries[:_MAX_TEXT_QUERIES]:
        try:
            results = await search_serper_web(q, num=4)
        except Exception as exc:  # noqa: BLE001 单查询失败跳过
            # httpx 超时的 str(exc) 常为空串，补类名防出现「考据搜索：」空信息
            errors.setdefault("考据搜索", (str(exc) or type(exc).__name__)[:100])
            continue
        for r in results:
            url = str(r.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            merged.append({"title": str(r.get("title") or "")[:80], "url": url})
    if not merged:
        raise RuntimeError("网页搜索无结果")
    pages: list[dict[str, Any]] = []
    for item in merged[:_MAX_PAGES]:
        try:
            text = await research.fetch_page_text(item["url"])
            pages.append({**item, "text": text[:_PAGE_TEXT_CHARS]})
        except Exception as exc:  # noqa: BLE001 单页失败跳过，不入简报
            errors.setdefault("考据抓页", f"{item['title']}：{str(exc)[:80]}")
    if not pages:
        raise RuntimeError("网页正文全部抓取失败（疑似反爬）")
    return await skills.run_ref_brief_flow(asset, pages)


def start_batch_research(
    project_id: str, assets: list[dict[str, Any]]
) -> str:
    """assets: [{nodeId, name, type, description}]；返回 batchId。

    逐资产并发跑单资产调研（AI 出词→双渠道搜→终选，10 路），每项结果
    记入 items；某资产失败只记该条 error，不中断整批。"""
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

    async def _run_one(i: int, a: dict[str, Any]) -> None:
        node_id = str(a.get("nodeId") or "")
        name = str(a.get("name") or "")
        batch["items"][i]["status"] = "running"
        # 信号量在任务内抢：并发由它限（顺序循环里 async with 是串行的，
        # 信号量形同虚设——首版踩坑：12 资产一个一个跑）
        async with sem:
            try:
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
                # 等本资产调研结束（轮询 REF_JOBS 终态；并发下各自独立轮询）
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
                    # 软失败（如终选失败：候选可用但无推荐预选）也要在批量条目
                    # 明报——只报 done 会把系统性故障藏成"看起来都成功"
                    soft = "；".join(
                        f"{k}：{v}" for k, v in (job.get("errors") or {}).items()
                    )
                    batch["items"][i].update(
                        status="done",
                        error=soft[:160],
                        brief=str(job.get("researchBrief") or "")[:1200],
                    )
            except Exception as exc:  # noqa: BLE001 单资产失败不中断整批
                batch["items"][i].update(status="error", error=str(exc)[:160])
        batch["done"] += 1
        running = [
            it["name"] for it in batch["items"] if it["status"] == "running"
        ]
        batch["current"] = "、".join(running[:3]) + ("…" if len(running) > 3 else "")

    await asyncio.gather(*[_run_one(i, a) for i, a in enumerate(assets)])
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
    # 跨轮次去重：已采纳的候选（连着参考卡）永久占坑，重搜不得重复入库；
    # 未采纳旧行在新结果落库前统一清掉（重跑=旧考古层作废）
    with _conn() as _c:
        seen: set[str] = {
            _dedupe_key(r[0])
            for r in _c.execute(
                "SELECT source_url FROM ref_candidates"
                " WHERE project_id=? AND node_id=? AND adopted=1",
                (project_id, node_id),
            )
        }
    rounds: list[dict[str, Any]] = []
    manual = bool(queries)
    try:
        text_task: asyncio.Task | None = None
        for round_num in range(1, MAX_RESEARCH_ROUNDS + 1):
            if round_num == 1:
                # 首轮：手填词直用；AI 模式由 planner 出词（同时出文字考据词，
                # fork：文路后台开跑与图路搜索下载并行；手填词是用户亲自掌舵
                # 搜图，不跑文路）
                if manual:
                    round_queries = queries
                else:
                    plan = await skills.run_ref_plan_flow(asset, [])
                    round_queries = plan["queries"]
                    text_queries = list(plan.get("text_queries") or [])
                    if text_queries:
                        text_task = asyncio.create_task(
                            _run_text_research(asset, text_queries, errors)
                        )
            else:
                plan = await skills.run_ref_plan_flow(asset, rounds)
                if plan["enough"]:
                    break
                round_queries = plan["queries"]
            round_start = len(merged)
            for query in round_queries:
                items = await _guarded(search_serper_images(query), "google", errors)
                for item in items:
                    key = _dedupe_key(item["sourceUrl"])
                    if key in seen:
                        continue
                    seen.add(key)
                    item["query"] = query
                    merged.append(item)
                await asyncio.sleep(0.3)  # 查询间隔：单 job 内串行，号池在 100 并发 job 间轮转
            # rounds 只记本轮增量摘要（多轮下累计摘要重复且撑长 planner 输入）
            rounds.append(
                {"queries": round_queries, "found": _rounds_summary(merged[round_start:])}
            )
        if not merged:
            if errors:
                raise RuntimeError("；".join(f"{k}：{v}" for k, v in errors.items()))
            job["status"] = "done"
            job["error"] = "没有搜到候选图，请换个关键词"
            return
        merged = merged[:MAX_CANDIDATES_PER_JOB]
        # 并发下载走全局信号量（10 路调研共享 8 并发，防叠加打爆源站）；
        # 单张失败不拖垮整批，失败者不入库。
        # 整体 110s 死线：超时取消在途下载，保留已完成部分（前端轮询 300s 截止）
        dl_errors: list[str] = []

        async def _fetch(item: dict[str, Any]) -> None:
            async with _GLOBAL_DOWNLOAD_SEM:
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
        # 重跑语义：新结果落库前清掉该资产旧未采纳候选（错配/低质的旧考古层
        # 不与新结果混存）；已采纳行保留。若新任务失败，走到这里之前已失败，
        # 旧候选不受影响
        with _conn() as _c:
            _c.execute(
                "DELETE FROM ref_candidates WHERE project_id=? AND node_id=? AND adopted=0",
                (project_id, node_id),
            )
        _insert_candidates(project_id, node_id, rows)
        # join：收文路考据简报（超时/失败记软错误，不拦终选与采纳）
        brief = ""
        if text_task is not None:
            try:
                brief = str(await asyncio.wait_for(text_task, timeout=_BRIEF_WAIT_S))
            except Exception as exc:  # noqa: BLE001 文路软失败明报
                text_task.cancel()
                errors["考据"] = str(exc)[:160]
        if brief:
            job["researchBrief"] = brief
        # LLM 终选（失败只记 errors，不影响候选展示与人工采纳）；带考据简报
        # 挑图——文字考据纠正选图（错年代/错形制的候选降权）
        try:
            select_asset = ({**asset, "research_brief": brief} if brief else asset)
            selection = await skills.run_ref_select_flow(select_asset, _select_payload(rows))
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


def _rounds_summary(items: list[dict[str, Any]], sample: int = 20) -> str:
    """本轮新增候选的摘要（planner 判「够不够」的依据；只喂增量，防多轮
    累积把 planner 输入撑长）。"""
    if not items:
        return "无候选"
    return "；".join(
        f"{m.get('provider')}|{str(m.get('title') or '')[:40]}|{m.get('width')}x{m.get('height')}"
        for m in items[:sample]
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
        # 个别异常 str() 为空（httpx 某些超时类），兜底用类名避免空错误行
        errors[channel] = (str(exc) or exc.__class__.__name__)[:160]
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
