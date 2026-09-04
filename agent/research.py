"""深度调研引擎：Serper Google 网页搜索 → 原文抓取 → LLM 提纯 → 多轮完整性
评估 → 结构化卷宗（叙事脊/已证实事实/真实争议/风险/材料簇，全部 S 编号引用）。

LLM 环节走四个 Langflow flow（开题 research-plan / 提纯 research-extract /
评估 research-evaluate / 卷宗 research-dossier），本模块只做编排（薄编排者）；
搜索统一走 Serper 号池（imgresearch.serper_keys 表，/search 文本通道）。

任务模型：job 落 SQLite（research_jobs / research_sources / research_findings
三表），证据随收集随落库，agent 重启不丢；启动时把 running/planning 孤儿标记
为 interrupted（topic_pool RUN_STATE 先例）。前端轮询端点直读 DB，无独立内存态。

旅程（juben real-documentary 资料包范式的画布版）：
  发起 → 开题 plan flow（聊天里讲给用户确认，可改方向）→ confirm 后多轮循环
  （搜索→抓原文→提纯→评估→不足换角度补搜）→ 卷宗落卡 → gap 补研定点追加
  （共享父任务的证据底账，只重跑卷宗不重跑全查）。
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

import httpx
import jina_reader

import imgresearch
from topic_pool import extract_json

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

# 档位 → (轮数上限, 每轮查询数上限)。dzhng breadth/depth 收敛成三档
DEPTHS: dict[str, tuple[int, int]] = {"quick": (1, 4), "standard": (2, 5), "deep": (4, 5)}
DEFAULT_DEPTH = "standard"
RESULTS_PER_QUERY = 6          # 每条查询 SERP 取条数
FETCH_CAP_PER_ROUND = 10       # 每轮最多抓原文的新源数
# 域名多样性：同域每轮最多进 2 条，防单站刷屏
PER_DOMAIN_CAP = 2
_FINDINGS_CHAR_BUDGET = 9000   # 评估/卷宗上下文里发现清单的字符预算
_MAX_PAGE_CHARS = 18000        # 抓取正文喂提纯的上限
_MAX_LOG_ENTRIES = 200

_FLOW_KEYS = {"plan": "LANGFLOW_RESEARCH_PLAN_FLOW_ID", "extract": "LANGFLOW_RESEARCH_EXTRACT_FLOW_ID",
              "eval": "LANGFLOW_RESEARCH_EVAL_FLOW_ID", "dossier": "LANGFLOW_RESEARCH_DOSSIER_FLOW_ID"}
_FLOW_TIMEOUTS = {"plan": 300, "extract": 240, "eval": 240, "dossier": 600}
# 全链统一目录默认 gpt-5.6-luna（DMX 平台，见 models.TEXT_MODELS）：
# 高频轻量环节（开题/提纯/评估，单次调用几十次）和卷宗撰写都用它，
# FAST_MODEL_ID 保留名字方便以后单独给轻量环节换快模型。
# 历史注：快模型曾用 BigModel 官方 glm-5.3-flash（本部署 DeepSeek 平台
# BASE_URL 实指智谱 coding 网关，deepseek 系模型名会 1214 modelCode 不存在）。
FAST_MODEL_ID = "gpt-5.6-luna"

# 来源分类学（导演逐内容点索要出处的分类，extract flow 按它归档）
SOURCE_CATEGORIES = ("一手史料", "学术", "可靠媒体", "自媒体", "百科辞书", "其他")

_FETCH_TIMEOUT = httpx.Timeout(20.0)
_MAX_PAGE_BYTES = 8 * 1024 * 1024
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
       " (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 取消旗标（进程内）：cancel_research 置位，循环在轮间与阶段间检查
_CANCELLED: set[str] = set()
# 任务强引用集：事件循环只持弱引用，create_task 不留引用可能在挂起等待时
# 被 GC（表现=任务无声消失、状态永远停在 planning，Python 文档明写的坑）
_RESEARCH_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _RESEARCH_TASKS.add(task)
    task.add_done_callback(_RESEARCH_TASKS.discard)
    return task


# ---------- 存储 ----------


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_research_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS research_jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                topic TEXT NOT NULL,
                brief TEXT NOT NULL DEFAULT '',
                depth TEXT NOT NULL DEFAULT 'standard',
                mode TEXT NOT NULL DEFAULT 'full',
                parent_job_id TEXT,
                status TEXT NOT NULL DEFAULT 'planning',
                stage TEXT NOT NULL DEFAULT '',
                plan_json TEXT,
                dossier_json TEXT,
                summary TEXT NOT NULL DEFAULT '',
                rounds_done INTEGER NOT NULL DEFAULT 0,
                error TEXT NOT NULL DEFAULT '',
                log_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_research_jobs_project
                ON research_jobs(project_id, created_at);
            CREATE TABLE IF NOT EXISTS research_sources (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                sid TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                domain TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '其他',
                fetch_status TEXT NOT NULL DEFAULT 'pending',
                snippet TEXT NOT NULL DEFAULT '',
                round INTEGER NOT NULL DEFAULT 1,
                query TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(job_id, url)
            );
            CREATE TABLE IF NOT EXISTS research_findings (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                sid TEXT NOT NULL,
                fact TEXT NOT NULL,
                quote TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                direction TEXT NOT NULL DEFAULT '',
                round INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_research_findings_job
                ON research_findings(job_id, sid);
            """
        )


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _get_row(job_id: str) -> sqlite3.Row | None:
    with _conn() as conn:
        return conn.execute("SELECT * FROM research_jobs WHERE id = ?", (job_id,)).fetchone()


def _update_row(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        conn.execute(f"UPDATE research_jobs SET {cols} WHERE id = ?", [*fields.values(), job_id])


def _append_log(job_id: str, kind: str, text: str) -> None:
    row = _get_row(job_id)
    if row is None:
        return
    try:
        log = json.loads(row["log_json"] or "[]")
    except ValueError:
        log = []
    log.append({"t": _now(), "kind": kind, "text": text[:400]})
    _update_row(job_id, log_json=json.dumps(log[-_MAX_LOG_ENTRIES:], ensure_ascii=False))


def report_interrupted_jobs() -> int:
    """lifespan 启动时调用：把上次进程残留的 planning/running 标记为 interrupted。

    证据与卷宗（若已生成）都在库里；interrupted 的任务可用 gap 补研续命。
    返回标记条数。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id FROM research_jobs WHERE status IN ('planning','running')"
        ).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE research_jobs SET status = 'interrupted',"
                " error = 'agent 重启导致中断，已集证据保留，可补研续跑', updated_at = ?"
                " WHERE id = ?",
                (_now(), r["id"]),
            )
    return len(rows)


# ---------- 视图 ----------


def get_job_view(job_id: str, include_dossier: bool = True) -> dict[str, Any] | None:
    row = _get_row(job_id)
    if row is None:
        return None
    with _conn() as conn:
        n_sources = conn.execute(
            "SELECT COUNT(*) FROM research_sources WHERE job_id = ?", (job_id,)
        ).fetchone()[0]
        n_findings = conn.execute(
            "SELECT COUNT(*) FROM research_findings WHERE job_id = ?", (job_id,)
        ).fetchone()[0]
    depth = row["depth"] if row["depth"] in DEPTHS else DEFAULT_DEPTH
    view: dict[str, Any] = {
        "jobId": row["id"],
        "projectId": row["project_id"],
        "topic": row["topic"],
        "brief": row["brief"],
        "depth": depth,
        "mode": row["mode"],
        "parentJobId": row["parent_job_id"] or "",
        "status": row["status"],
        "stage": row["stage"],
        "roundsDone": row["rounds_done"],
        "roundsTotal": DEPTHS[depth][0],
        "summary": row["summary"],
        "error": row["error"],
        "sourcesCount": n_sources,
        "findingsCount": n_findings,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "plan": _load_json(row["plan_json"]),
        "log": _load_json(row["log_json"])[-60:],
    }
    if include_dossier:
        view["dossier"] = _load_json(row["dossier_json"])
    return view


def list_sources(job_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM research_sources WHERE job_id = ? ORDER BY sid", (job_id,)
        ).fetchall()
    return [
        {
            "sid": r["sid"],
            "url": r["url"],
            "title": r["title"],
            "domain": r["domain"],
            "category": r["category"],
            "fetchStatus": r["fetch_status"],
            "snippet": r["snippet"],
            "round": r["round"],
            "query": r["query"],
        }
        for r in rows
    ]


def _load_json(text: str | None) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


# ---------- flow 调用（宽容解析 + 坏输出重试一次，topic_pool 同款） ----------


async def _call_flow(key: str, payload: dict[str, Any]) -> Any:
    import os

    import skills
    from models import text_model_tweaks

    # plan/extract/eval 走快模型，dossier（卷宗撰写）走目录默认——统一
    # 键 LanguageModelComponent 由 run_flow_blocking 前缀解析成真实节点 id
    from models import DEFAULT_TEXT_MODEL_ID, text_model_tweaks

    flow_id = os.environ.get(_FLOW_KEYS[key], "").strip()
    if not flow_id:
        raise RuntimeError(f"未配置 {_FLOW_KEYS[key]}（调研 {key} flow）")
    tweaks = {
        "LanguageModelComponent": text_model_tweaks(
            FAST_MODEL_ID if key in ("plan", "extract", "eval") else DEFAULT_TEXT_MODEL_ID
        )
    }
    last_error: ValueError | None = None
    for attempt in (1, 2):
        text = await skills.run_flow_blocking(
            flow_id, json.dumps(payload, ensure_ascii=False),
            tweaks=tweaks, timeout=_FLOW_TIMEOUTS[key],
        )
        if text.startswith("（"):
            # run_flow_blocking 的错误以全角括号包裹；确定性引擎错误不重试
            raise RuntimeError(f"调研 {key} flow 调用失败: {text[:200]}")
        try:
            return extract_json(text)
        except ValueError as exc:
            last_error = exc
            logger.warning("调研 %s flow 输出解析失败（第 %d 次）: %s", key, attempt, str(exc)[:200])
    raise RuntimeError(f"调研 {key} flow 输出两次解析失败: {last_error}")


# ---------- 抓取 ----------

_TAG_RE = re.compile(r"<(script|style|noscript|svg|iframe|nav|header|footer|form)\b[^>]*>.*?</\1>",
                     re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_ANYTAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def _normalize_url(url: str) -> str:
    """去 utm/追踪参数与尾斜杠，作为跨轮去重键。"""
    try:
        parts = urlparse(url.strip())
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if not k.lower().startswith(("utm_", "from", "spm", "share", "vd_", "ref"))]
        path = parts.path or "/"
        return urlunparse((parts.scheme.lower(), parts.netloc.lower(), path, "",
                           urlencode(query), ""))
    except ValueError:
        return url


def _domain_of(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _strip_html(raw: str) -> str:
    text = _TAG_RE.sub(" ", raw)
    text = _COMMENT_RE.sub(" ", text)
    text = _ANYTAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text)
    return re.sub(r"\n\s*\n+", "\n", text).strip()


async def fetch_page_text(url: str) -> str:
    """抓网页正文：httpx 直抓为主（快），失败自动回退本地 Jina Reader
    （无头浏览器，过 TLS 指纹反爬 + PDF 文本提取；juben 同款部署）。
    双败抛异常，由调用方记为 snippet 级来源（逐源诚实标注，不静默降级整轮）。"""
    direct_error = ""
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": _UA, "Accept-Language": "zh-CN,zh;q=0.9"})
            resp.raise_for_status()
            if len(resp.content) > _MAX_PAGE_BYTES:
                raise ValueError(f"页面过大（{len(resp.content)} 字节）")
            ctype = (resp.headers.get("content-type") or "").lower()
            if ctype and "text/html" not in ctype and "text/plain" not in ctype and "application/xhtml" not in ctype:
                raise ValueError(f"非网页内容（{ctype.split(';')[0]}）")
            text = _strip_html(resp.text)
            if len(text) < 80:
                raise ValueError("正文过短（可能被反爬拦截）")
            return text[:_MAX_PAGE_CHARS]
    except Exception as exc:  # noqa: BLE001
        direct_error = f"直抓失败：{str(exc)[:80]}"

    if jina_reader.enabled():
        try:
            md = await jina_reader.fetch_markdown(url)
            return md[:_MAX_PAGE_CHARS]
        except jina_reader.WebSourceUnreachableError:
            pass  # 本地实例未部署：静默退回直抓结论
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"{direct_error}；Jina 回退失败：{str(exc)[:80]}") from exc
    raise ValueError(direct_error)


# ---------- 开题 ----------


def _normalize_plan(raw: Any) -> dict[str, Any]:
    """校验 plan flow 输出：结构不符即抛（无 fallback，让上层明报）。"""
    if not isinstance(raw, dict):
        raise ValueError("开题输出不是对象")
    viewing = str(raw.get("viewingQuestion") or "").strip()
    directions_raw = raw.get("directions")
    if not viewing or not isinstance(directions_raw, list) or len(directions_raw) < 2:
        raise ValueError("开题缺少观看问题或方向不足 2 条")
    directions = []
    for d in directions_raw[:6]:
        if not isinstance(d, dict):
            continue
        title = str(d.get("title") or "").strip()
        queries = [str(q).strip() for q in (d.get("queries") or []) if str(q).strip()]
        if not title or not queries:
            continue
        directions.append({
            "title": title,
            "goal": str(d.get("goal") or "").strip(),
            "queries": queries[:3],
        })
    if len(directions) < 2:
        raise ValueError("开题方向不足 2 条（缺 title/queries）")
    return {
        "viewingQuestion": viewing,
        "directions": directions,
        "risks": [str(r).strip() for r in (raw.get("risks") or []) if str(r).strip()][:5],
    }


def _round1_queries(plan: dict[str, Any], cap: int) -> list[str]:
    """各方向轮转取查询（保证方向覆盖），截到每轮上限。"""
    pools = [list(d["queries"]) for d in plan["directions"]]
    out: list[str] = []
    i = 0
    while any(pools) and len(out) < cap:
        pool = pools[i % len(pools)]
        if pool:
            out.append(pool.pop(0))
        i += 1
    return out


# ---------- 任务编排 ----------


def start_research(project_id: str, topic: str, brief: str = "", depth: str = "standard") -> dict[str, Any]:
    """发起调研：建 job（planning 态）并立即后台跑开题 flow。返回任务视图。"""
    topic = topic.strip()
    if not topic:
        raise ValueError("调研主题不能为空")
    if depth not in DEPTHS:
        raise ValueError(f"depth 必须是 {'/'.join(DEPTHS)}")
    job_id = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO research_jobs (id, project_id, topic, brief, depth, status,"
            " created_at, updated_at) VALUES (?,?,?,?,?,'planning',?,?)",
            (job_id, project_id, topic, brief.strip(), depth, now, now),
        )
    _append_log(job_id, "info", f"发起调研「{topic}」（{depth}）")
    _spawn(_plan_task(job_id))
    view = get_job_view(job_id)
    assert view is not None
    return view


async def _plan_task(job_id: str) -> None:
    row = _get_row(job_id)
    if row is None:
        return
    try:
        raw = None
        # 网关慢时开题 flow 偶发超时（确定性超时但属瞬时故障）：多给一次重试
        for plan_attempt in (1, 2):
            try:
                raw = await _call_flow("plan", {
                    "topic": row["topic"],
                    "brief": row["brief"],
                    "depth": row["depth"],
                })
                break
            except RuntimeError as exc:
                if plan_attempt == 2 or "超时" not in str(exc):
                    raise
                logger.warning("调研 %s 开题超时，5s 后重试一次", job_id)
                await asyncio.sleep(5)
        plan = _normalize_plan(raw)
        _update_row(job_id, plan_json=json.dumps(plan, ensure_ascii=False))
        _append_log(job_id, "plan",
                    f"开题就绪：观看问题「{plan['viewingQuestion']}」，方向 "
                    + "、".join(d["title"] for d in plan["directions"]))
    except Exception as exc:  # noqa: BLE001
        logger.exception("调研 %s 开题失败", job_id)
        _update_row(job_id, status="error", error=f"开题失败：{str(exc)[:300]}")
        _append_log(job_id, "error", f"开题失败：{str(exc)[:300]}")


def confirm_plan(job_id: str, plan: dict[str, Any] | None = None) -> dict[str, Any]:
    """确认开题（可带修改后的计划）：planning → running 并启动执行循环。

    条件 UPDATE 防并发双确认；非 planning 态 409 语义抛 ValueError。
    """
    row = _get_row(job_id)
    if row is None:
        raise ValueError("调研任务不存在")
    if row["status"] != "planning":
        raise ValueError(f"任务当前状态为 {row['status']}，仅待确认（planning）可启动")
    if plan is not None:
        plan = _normalize_plan(plan)
        _update_row(job_id, plan_json=json.dumps(plan, ensure_ascii=False))
    else:
        plan = _load_json(row["plan_json"])
        if not plan:
            raise ValueError("开题尚未生成，暂不能确认")
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE research_jobs SET status = 'running', stage = 'search', updated_at = ?"
            " WHERE id = ? AND status = 'planning'",
            (_now(), job_id),
        )
        if cur.rowcount == 0:
            raise ValueError("任务已被确认或状态已变化")
    _append_log(job_id, "info", "开题确认，开始执行")
    _spawn(_run_task(job_id, plan))
    view = get_job_view(job_id)
    assert view is not None
    return view


def cancel_research(job_id: str) -> None:
    """请求取消：轮间检查后落 stopped 态。仅 running 可取消。"""
    row = _get_row(job_id)
    if row is None:
        raise ValueError("调研任务不存在")
    if row["status"] != "running":
        raise ValueError(f"任务当前状态为 {row['status']}，仅运行中可取消")
    _CANCELLED.add(job_id)


async def _run_task(job_id: str, plan: dict[str, Any]) -> None:
    row = _get_row(job_id)
    if row is None:
        return
    depth = row["depth"] if row["depth"] in DEPTHS else DEFAULT_DEPTH
    rounds_cap, queries_cap = DEPTHS[depth]
    try:
        queries = _round1_queries(plan, queries_cap)
        for round_no in range(1, rounds_cap + 1):
            if _aborted(job_id):
                return
            await _search_round(job_id, job_id, queries, round_no)
            _update_row(job_id, rounds_done=round_no)
            if round_no == rounds_cap:
                break
            queries = await _evaluate_round(job_id, plan["viewingQuestion"], plan["directions"], round_no)
            if queries is None:  # 评估判完整
                break
            if _aborted(job_id):
                return
        await _dossier_pass(job_id, job_id, plan["viewingQuestion"])
        _update_row(job_id, status="done", stage="")
    except _Cancelled:
        _update_row(job_id, status="stopped", stage="")
        _append_log(job_id, "info", "已取消")
    except Exception as exc:  # noqa: BLE001
        logger.exception("调研 %s 执行失败", job_id)
        _update_row(job_id, status="error", error=str(exc)[:300])
        _append_log(job_id, "error", f"执行失败：{str(exc)[:300]}")


class _Cancelled(Exception):
    pass


def _aborted(job_id: str) -> None:
    if job_id in _CANCELLED:
        raise _Cancelled()


async def _search_round(job_id: str, evidence_job_id: str, queries: list[str], round_no: int) -> None:
    """一轮取证：搜索 → 去重排序 → 抓原文 → 提纯入库。证据落 evidence_job_id
    （gap 补研时 = 父任务，共享同一份来源/发现底账）。"""
    _update_row(job_id, stage="search")
    candidates: dict[str, dict[str, Any]] = {}
    search_errors: list[str] = []
    for q in queries:
        _aborted(job_id)
        try:
            results = await imgresearch.search_serper_web(q, num=RESULTS_PER_QUERY)
        except Exception as exc:  # noqa: BLE001 - 单查询失败记日志继续（全失败在下方判）
            search_errors.append(f"「{q}」: {str(exc)[:120]}")
            continue
        for r in results:
            key = _normalize_url(r["url"])
            if key not in candidates:
                r = {**r, "normUrl": key, "query": q}
                candidates[key] = r
        _append_log(job_id, "search", f"搜索「{q}」命中 {len(results)} 条")
    if search_errors:
        _append_log(job_id, "error", "部分查询失败：" + "；".join(search_errors[:3]))
    if not candidates:
        raise RuntimeError("本轮搜索全部失败：" + "；".join(search_errors[:3] or ["无结果"]))

    # 全量去重（跨轮已抓过的不重抓）+ 域名多样性 + SERP 位次排序
    with _conn() as conn:
        known = {r[0] for r in conn.execute(
            "SELECT url FROM research_sources WHERE job_id = ?", (evidence_job_id,)).fetchall()}
    fresh = [c for c in candidates.values() if c["normUrl"] not in known]
    domain_seen: dict[str, int] = {}
    ranked: list[dict[str, Any]] = []
    for c in sorted(fresh, key=lambda x: x.get("position") or 99):
        d = _domain_of(c["url"])
        if domain_seen.get(d, 0) >= PER_DOMAIN_CAP:
            continue
        domain_seen[d] = domain_seen.get(d, 0) + 1
        ranked.append(c)
    ranked = ranked[:FETCH_CAP_PER_ROUND]
    if not ranked:
        _append_log(job_id, "info", "本轮无新来源（均已抓过）")
        return

    # 并发抓原文（4 路）
    _update_row(job_id, stage="fetch")
    sem = asyncio.Semaphore(4)

    async def _fetch_one(c: dict[str, Any]) -> None:
        async with sem:
            try:
                c["content"] = await fetch_page_text(c["url"])
                c["fetchStatus"] = "ok"
            except Exception as exc:  # noqa: BLE001 - 抓取失败按 snippet 级提纯，逐源诚实标注
                c["content"] = c.get("snippet") or c["title"]
                c["fetchStatus"] = "snippet"
                _append_log(job_id, "fetch", f"原文获取失败（按摘要提纯）{c['url'][:80]}：{str(exc)[:120]}")

    await asyncio.gather(*(_fetch_one(c) for c in ranked))

    # 逐源提纯入库（2 路，保护上游 LLM 配额）
    _update_row(job_id, stage="extract")
    sem = asyncio.Semaphore(2)
    index_lock = asyncio.Lock()
    sid_counter = _next_sid(evidence_job_id) - 1

    async def _extract_one(c: dict[str, Any]) -> None:
        nonlocal sid_counter
        async with sem:
            _aborted(job_id)
            try:
                raw = await _call_flow("extract", {
                    "topic": _get_row(job_id)["topic"],
                    "viewingQuestion": _viewing_question_of(job_id),
                    "title": c["title"],
                    "url": c["url"],
                    "domain": _domain_of(c["url"]),
                    "content": c["content"],
                })
                parsed = _normalize_extract(raw)
            except Exception as exc:  # noqa: BLE001 - 单源提纯失败记日志不中断
                _append_log(job_id, "extract", f"提纯失败 {c['url'][:80]}：{str(exc)[:150]}")
                return
            async with index_lock:
                sid_counter += 1
                sid = f"S{sid_counter:03d}"
            category = parsed["sourceCategory"] or "其他"
            with _conn() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO research_sources (id, job_id, sid, url, title,"
                    " domain, category, fetch_status, snippet, round, query, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uuid.uuid4().hex[:12], evidence_job_id, sid, c["url"], c["title"][:200],
                     _domain_of(c["url"]), category, c["fetchStatus"],
                     (c.get("snippet") or "")[:300], round_no, c["query"], _now()),
                )
                if parsed["facts"]:
                    conn.executemany(
                        "INSERT INTO research_findings (id, job_id, sid, fact, quote,"
                        " category, direction, round, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        [(uuid.uuid4().hex[:12], evidence_job_id, sid, f["fact"], f["quote"][:400],
                          f["category"], f["direction"][:60], round_no, _now())
                         for f in parsed["facts"]],
                    )
            _append_log(job_id, "extract",
                        f"{sid} {category}「{c['title'][:40]}」提得 {len(parsed['facts'])} 条事实")

    await asyncio.gather(*(_extract_one(c) for c in ranked))


def _next_sid(job_id: str) -> int:
    with _conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM research_sources WHERE job_id = ?", (job_id,)
        ).fetchone()
    return int(row[0]) + 1


def _viewing_question_of(job_id: str) -> str:
    row = _get_row(job_id)
    if row is None:
        return ""
    plan = _load_json(row["plan_json"])
    if isinstance(plan, dict) and plan.get("viewingQuestion"):
        return str(plan["viewingQuestion"])
    return row["topic"]


def _normalize_extract(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("提纯输出不是对象")
    facts = []
    for f in (raw.get("facts") or [])[:8]:
        if not isinstance(f, dict):
            continue
        fact = str(f.get("fact") or "").strip()
        if not fact:
            continue
        category = str(f.get("category") or "").strip()
        facts.append({
            "fact": fact,
            "quote": str(f.get("quote") or "").strip(),
            "category": category if category in SOURCE_CATEGORIES else "其他",
            "direction": str(f.get("direction") or "").strip(),
        })
    return {
        "relevant": bool(raw.get("relevant", True)),
        "sourceCategory": str(raw.get("sourceCategory") or "").strip(),
        "facts": facts,
    }


async def _evaluate_round(
    job_id: str, viewing_question: str, directions: list[dict[str, Any]], round_no: int
) -> list[str] | None:
    """完整性评估：返回下一轮查询列表；判完整返回 None；失败抛（无兜底）。"""
    _aborted(job_id)
    _update_row(job_id, stage="evaluate")
    findings_text = _findings_context(job_id)
    raw = await _call_flow("eval", {
        "topic": _get_row(job_id)["topic"],
        "viewingQuestion": viewing_question,
        "directions": [{"title": d["title"], "goal": d["goal"]} for d in directions],
        "round": round_no,
        "findings": findings_text,
    })
    if not isinstance(raw, dict):
        raise ValueError("评估输出不是对象")
    is_complete = bool(raw.get("isComplete"))
    reason = str(raw.get("reason") or "").strip()
    gaps = [str(g).strip() for g in (raw.get("gaps") or []) if str(g).strip()]
    _append_log(job_id, "evaluate",
                f"第 {round_no} 轮评估：{'证据已足' if is_complete else '继续补搜'}（{reason[:120]}）")
    if gaps:
        _append_log(job_id, "evaluate", "缺口：" + "；".join(gaps[:4]))
    if is_complete:
        return None
    next_queries = []
    for q in (raw.get("nextQueries") or []):
        if isinstance(q, dict) and str(q.get("query") or "").strip():
            next_queries.append(str(q["query"]).strip())
        elif isinstance(q, str) and q.strip():
            next_queries.append(q.strip())
    if not next_queries:
        _append_log(job_id, "evaluate", "评估未给出可用的补搜查询，按证据已足收束")
        return None
    return next_queries[:DEPTHS[_get_row(job_id)["depth"] if _get_row(job_id)["depth"] in DEPTHS else DEFAULT_DEPTH][1]]


def _findings_context(job_id: str) -> str:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT sid, fact, category, quote FROM research_findings WHERE job_id = ?"
            " ORDER BY rowid", (job_id,),
        ).fetchall()
    lines = []
    budget = _FINDINGS_CHAR_BUDGET
    for r in rows:
        line = f"{r['sid']}（{r['category']}）：{r['fact']}"
        if len(lines) * 60 > budget:
            break
        lines.append(line)
    return "\n".join(lines)


async def _dossier_pass(job_id: str, evidence_job_id: str, viewing_question: str) -> None:
    """卷宗撰写：全量证据 → 五段结构化卷宗；引用逐条校验（幻觉 sid 剔除）。"""
    _aborted(job_id)
    _update_row(job_id, stage="dossier")
    row = _get_row(job_id)
    assert row is not None
    with _conn() as conn:
        sources = conn.execute(
            "SELECT sid, title, domain, category, url FROM research_sources"
            " WHERE job_id = ? ORDER BY sid", (evidence_job_id,),
        ).fetchall()
        findings = conn.execute(
            "SELECT sid, fact, category, quote FROM research_findings"
            " WHERE job_id = ? ORDER BY rowid", (evidence_job_id,),
        ).fetchall()
    if not findings:
        raise RuntimeError("没有可用的证据事实，无法生成卷宗")
    known_sids = {r["sid"] for r in sources}
    raw = await _call_flow("dossier", {
        "topic": row["topic"],
        "viewingQuestion": viewing_question,
        "sources": [{"sid": r["sid"], "title": r["title"], "domain": r["domain"],
                     "category": r["category"], "url": r["url"]} for r in sources],
        # 不带 quote：fact 已是提纯陈述，quote 只会撑爆生成时长；截 60 条防超载
        "findings": [{"sid": r["sid"], "fact": r["fact"], "category": r["category"]}
                     for r in findings][:60],
    })
    dossier = _normalize_dossier(raw, known_sids)
    summary = dossier.get("summary") or ""
    _update_row(job_id, dossier_json=json.dumps(dossier, ensure_ascii=False), summary=summary)
    _append_log(job_id, "dossier",
                f"卷宗生成：事实 {len(dossier.get('establishedFacts', []))} 条、"
                f"争议 {len(dossier.get('controversies', []))} 组、"
                f"材料簇 {len(dossier.get('materialClusters', []))} 个")


def _clean_refs(refs: Any, known_sids: set[str]) -> list[str]:
    out = []
    for r in refs or []:
        s = str(r).strip().upper()
        if not s.startswith("S"):
            s = "S" + s
        if s in known_sids and s not in out:
            out.append(s)
    return out


def _normalize_dossier(raw: Any, known_sids: set[str]) -> dict[str, Any]:
    """卷宗结构校验 + 幻觉引用剔除：refs 不在证据底账的 sid 一律剥除；
    剥完后一条引用都不剩的事实/争议版本整条丢弃（宁缺毋假）。"""
    if not isinstance(raw, dict):
        raise ValueError("卷宗输出不是对象")
    headline = str(raw.get("headline") or "").strip()
    summary = str(raw.get("summary") or "").strip()
    if not headline or not summary:
        raise ValueError("卷宗缺少 headline/summary")

    spine = []
    for s in (raw.get("narrativeSpine") or [])[:8]:
        if not isinstance(s, dict):
            continue
        refs = _clean_refs(s.get("refs"), known_sids)
        if str(s.get("step") or "").strip() and refs:
            spine.append({"step": str(s["step"]).strip(), "detail": str(s.get("detail") or "").strip(), "refs": refs})

    facts = []
    for f in (raw.get("establishedFacts") or [])[:30]:
        if not isinstance(f, dict):
            continue
        refs = _clean_refs(f.get("refs"), known_sids)
        if str(f.get("text") or "").strip() and refs:
            facts.append({"text": str(f["text"]).strip(), "refs": refs})

    controversies = []
    for c in (raw.get("controversies") or [])[:8]:
        if not isinstance(c, dict):
            continue
        versions = []
        for v in (c.get("versions") or [])[:4]:
            if not isinstance(v, dict):
                continue
            refs = _clean_refs(v.get("refs"), known_sids)
            if str(v.get("text") or "").strip() and refs:
                versions.append({"text": str(v["text"]).strip(), "refs": refs})
        if str(c.get("title") or "").strip() and versions:
            controversies.append({"title": str(c["title"]).strip(), "versions": versions})

    risks = []
    for r in (raw.get("risks") or [])[:10]:
        if isinstance(r, dict):
            text = str(r.get("text") or "").strip()
            refs = _clean_refs(r.get("refs"), known_sids)
            if text:
                risks.append({"text": text, "refs": refs})
        elif str(r).strip():
            risks.append({"text": str(r).strip(), "refs": []})

    clusters = []
    for m in (raw.get("materialClusters") or [])[:10]:
        if not isinstance(m, dict):
            continue
        points = []
        for p in (m.get("points") or [])[:12]:
            if not isinstance(p, dict):
                continue
            refs = _clean_refs(p.get("refs"), known_sids)
            if str(p.get("text") or "").strip() and refs:
                points.append({"text": str(p["text"]).strip(), "refs": refs})
        if str(m.get("title") or "").strip() and points:
            clusters.append({"title": str(m["title"]).strip(), "points": points})

    if not facts and not spine:
        raise ValueError("卷宗事实与叙事脊均为空（引用校验后无有效内容）")
    return {
        "headline": headline,
        "summary": summary,
        "narrativeSpine": spine,
        "establishedFacts": facts,
        "controversies": controversies,
        "risks": risks,
        "materialClusters": clusters,
    }


# ---------- gap 补研（定点追加，共享父任务证据底账） ----------


def start_gap(project_id: str, parent_job_id: str, questions: list[str]) -> dict[str, Any]:
    """对既有调研追加定点问题：新建 gap job，证据写父任务底账，完成后重跑
    父任务卷宗。不重跑全查（juben mode=gap 范式）。"""
    parent = _get_row(parent_job_id)
    if parent is None or parent["project_id"] != project_id:
        raise ValueError("父调研任务不存在")
    if parent["status"] in ("planning", "running"):
        raise ValueError("父任务仍在执行中，等完成后再补研")
    questions = [q.strip() for q in questions if str(q).strip()]
    if not questions:
        raise ValueError("补研问题不能为空")
    job_id = uuid.uuid4().hex[:12]
    now = _now()
    with _conn() as conn:
        conn.execute(
            "INSERT INTO research_jobs (id, project_id, topic, brief, depth, mode,"
            " parent_job_id, status, stage, created_at, updated_at)"
            " VALUES (?,?,?,?,?,'gap',?,'running','search',?,?)",
            (job_id, project_id, parent["topic"], "；".join(questions)[:500],
             parent["depth"], parent_job_id, now, now),
        )
    _append_log(job_id, "info", f"补研「{parent['topic']}」：" + "；".join(questions))
    _append_log(parent_job_id, "info", "发起补研：" + "；".join(questions))
    _spawn(_gap_task(job_id, parent_job_id, questions[:5]))
    view = get_job_view(job_id)
    assert view is not None
    return view


async def _gap_task(job_id: str, parent_job_id: str, questions: list[str]) -> None:
    try:
        await _search_round(job_id, parent_job_id, questions, round_no=99)
        parent = _get_row(parent_job_id)
        assert parent is not None
        viewing = _viewing_question_of(parent_job_id)
        await _dossier_pass(parent_job_id, parent_job_id, viewing)
        _update_row(job_id, status="done", stage="", rounds_done=1)
        _update_row(parent_job_id, status="done", error="")
        _append_log(parent_job_id, "dossier", "补研回填：卷宗已更新")
    except Exception as exc:  # noqa: BLE001
        logger.exception("补研 %s 失败", job_id)
        _update_row(job_id, status="error", error=str(exc)[:300])
        _append_log(job_id, "error", f"补研失败：{str(exc)[:300]}")
