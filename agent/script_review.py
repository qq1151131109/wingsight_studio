"""剧本审查引擎：合规 / 一致性 / 事实核查 三维度结构化审查。

LLM 环节走四个 Langflow flow（合规 script-review-compliance / 一致性
script-review-consistency / 事实抽取 script-review-fact-claims / 事实判定
script-review-fact-verdict），本模块只做编排（薄编排者）；敏感词表只是
注入 flow 的参考底料（agent/lexicons/sensitive-lexicon.txt），不做代码层
精确匹配。事实核查的联网搜索走 Serper 号池（imgresearch.search_serper_web，
research 深度调研同通道），flow 内不做搜索。

任务模型：job 落 SQLite（review_jobs / review_findings 两表），findings 带
正文锚点（quote + 字符区间，写入时定位）；job 记 body_sha1，剧本改了前端
比对指纹标过期。启动时把 queued/running 孤儿标记为 interrupted（research
同范式）。前端轮询端点直读 DB，无独立内存态。

维度语义：
  compliance  合规——词表底料 + 语境判定，报 类目/严重度/依据/改写建议
  consistency 一致性——剧本内部矛盾（人物/时间线/设定），双位置引文
  fact        事实——抽断言 → Serper 取证 → 逐条判定（属实不报，只报问题）
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import imgresearch
import models
import research
from topic_pool import extract_json

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"
LEXICON_PATH = Path(__file__).resolve().parent / "lexicons" / "sensitive-lexicon.txt"

DIMENSIONS = ("compliance", "consistency", "fact")
SEVERITIES = ("high", "medium", "low")
FACT_VERDICT_META = {
    # verdict → (findings category, severity)；true 不生成 finding（审查只报问题）
    "false": ("有误", "high"),
    "uncertain": ("存疑", "medium"),
    "unverifiable": ("无法核实", "low"),
}
MAX_BODY_CHARS = 60_000      # v1 全文单次过 flow，超长明报
MAX_FINDINGS = 80            # 单任务 findings 总量保护
MAX_CLAIMS = 12              # 事实核查断言上限（flow 提示词同数）
CLAIM_SOURCES = 3            # 每断言最多采信源数
_EVIDENCE_CHARS = 1600       # 喂判定 flow 的单证据字符预算
_MAX_LOG_ENTRIES = 200

_FLOW_KEYS = {
    "compliance": "LANGFLOW_SCRIPT_COMPLIANCE_FLOW_ID",
    "consistency": "LANGFLOW_SCRIPT_CONSISTENCY_FLOW_ID",
    "claims": "LANGFLOW_SCRIPT_FACTCLAIMS_FLOW_ID",
    "verdict": "LANGFLOW_SCRIPT_FACTVERDICT_FLOW_ID",
}
_FLOW_TIMEOUTS = {"compliance": 240, "consistency": 240, "claims": 150, "verdict": 240}

# 取消旗标（进程内）：cancel_review 置位，管线在阶段间检查
_CANCELLED: set[str] = set()

_lexicon_cache: str | None = None


# ---------- 存储 ----------


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_review_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS review_jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                card_title TEXT NOT NULL DEFAULT '',
                dimensions_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'queued',
                dims_json TEXT NOT NULL DEFAULT '{}',
                body_sha1 TEXT NOT NULL DEFAULT '',
                body_chars INTEGER NOT NULL DEFAULT 0,
                text_model TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                log_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_review_jobs_node
                ON review_jobs(project_id, node_id, created_at);
            CREATE TABLE IF NOT EXISTS review_findings (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                dimension TEXT NOT NULL,
                severity TEXT NOT NULL DEFAULT 'medium',
                category TEXT NOT NULL DEFAULT '',
                quote TEXT NOT NULL,
                quote_start INTEGER NOT NULL DEFAULT -1,
                quote_end INTEGER NOT NULL DEFAULT -1,
                related_quote TEXT NOT NULL DEFAULT '',
                message TEXT NOT NULL DEFAULT '',
                suggestion TEXT NOT NULL DEFAULT '',
                evidence_json TEXT NOT NULL DEFAULT '[]',
                dismissed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_review_findings_job
                ON review_findings(job_id, dimension);
            """
        )


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _get_row(job_id: str) -> sqlite3.Row | None:
    with _conn() as conn:
        return conn.execute("SELECT * FROM review_jobs WHERE id = ?", (job_id,)).fetchone()


def _update_row(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        conn.execute(f"UPDATE review_jobs SET {cols} WHERE id = ?", [*fields.values(), job_id])


def _get_dims(job_id: str) -> dict[str, dict[str, str]]:
    row = _get_row(job_id)
    if row is None:
        return {}
    try:
        return json.loads(row["dims_json"] or "{}")
    except ValueError:
        return {}


def _set_dim(job_id: str, dim: str, state: str, error: str = "") -> None:
    dims = _get_dims(job_id)
    dims[dim] = {"state": state, "error": error}
    _update_row(job_id, dims_json=json.dumps(dims, ensure_ascii=False))


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
    """lifespan 启动时调用：把上次进程残留的 queued/running 标记为 interrupted。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id FROM review_jobs WHERE status IN ('queued','running')"
        ).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE review_jobs SET status = 'interrupted',"
                " error = 'agent 重启导致中断，请重新发起审查', updated_at = ?"
                " WHERE id = ?",
                (_now(), r["id"]),
            )
    return len(rows)


# ---------- 视图 ----------


def _finding_view(row: sqlite3.Row) -> dict[str, Any]:
    try:
        evidence = json.loads(row["evidence_json"] or "[]")
    except ValueError:
        evidence = []
    return {
        "id": row["id"],
        "jobId": row["job_id"],
        "dimension": row["dimension"],
        "severity": row["severity"],
        "category": row["category"],
        "quote": row["quote"],
        "quoteStart": row["quote_start"],
        "quoteEnd": row["quote_end"],
        "relatedQuote": row["related_quote"],
        "message": row["message"],
        "suggestion": row["suggestion"],
        "evidence": evidence,
        "dismissed": bool(row["dismissed"]),
        "createdAt": row["created_at"],
    }


def list_findings(job_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM review_findings WHERE job_id = ?"
            " ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,"
            " created_at, id",
            (job_id,),
        ).fetchall()
    return [_finding_view(r) for r in rows]


def get_review_view(job_id: str, include_findings: bool = True) -> dict[str, Any] | None:
    row = _get_row(job_id)
    if row is None:
        return None
    view: dict[str, Any] = {
        "jobId": row["id"],
        "projectId": row["project_id"],
        "nodeId": row["node_id"],
        "cardTitle": row["card_title"],
        "dimensions": json.loads(row["dimensions_json"] or "[]"),
        "status": row["status"],
        "dims": _get_dims(job_id),
        "bodySha1": row["body_sha1"],
        "bodyChars": row["body_chars"],
        "textModel": row["text_model"],
        "error": row["error"],
        "log": json.loads(row["log_json"] or "[]"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if include_findings:
        findings = list_findings(job_id)
        view["findings"] = findings
        view["openCount"] = sum(1 for f in findings if not f["dismissed"])
    return view


def latest_summary(project_id: str, node_id: str) -> dict[str, Any] | None:
    """该卡最近一次审查的摘要（卡面角标 / 重开弹窗用）。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM review_jobs WHERE project_id = ? AND node_id = ?"
            " ORDER BY created_at DESC LIMIT 1",
            (project_id, node_id),
        ).fetchone()
        if row is None:
            return None
        counts = conn.execute(
            "SELECT COUNT(*) AS total, COALESCE(SUM(dismissed = 0), 0) AS open"
            " FROM review_findings WHERE job_id = ?",
            (row["id"],),
        ).fetchone()
    return {
        "jobId": row["id"],
        "nodeId": row["node_id"],
        "status": row["status"],
        "bodySha1": row["body_sha1"],
        "bodyChars": row["body_chars"],
        "totalCount": counts["total"],
        "openCount": counts["open"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def set_finding_dismissed(job_id: str, finding_id: str, dismissed: bool) -> dict[str, Any]:
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE review_findings SET dismissed = ? WHERE id = ? AND job_id = ?",
            (1 if dismissed else 0, finding_id, job_id),
        )
        if cur.rowcount == 0:
            raise ValueError("finding 不存在")
    return next(f for f in list_findings(job_id) if f["id"] == finding_id)


def cancel_review(job_id: str) -> None:
    row = _get_row(job_id)
    if row is None:
        raise ValueError("任务不存在")
    if row["status"] not in ("queued", "running"):
        raise ValueError(f"任务已是终态（{row['status']}），无法取消")
    _CANCELLED.add(job_id)
    _append_log(job_id, "info", "收到取消请求，等待当前环节结束")


def _aborted(job_id: str) -> bool:
    return job_id in _CANCELLED


class _Cancelled(Exception):
    pass


# ---------- 词表 ----------


def load_lexicon() -> str:
    """敏感词表全文（剥文件头 "# " 注释行，保留 #类目 分节行）。"""
    global _lexicon_cache
    if _lexicon_cache is None:
        lines = [ln for ln in LEXICON_PATH.read_text(encoding="utf-8").splitlines()
                 if not ln.startswith("# ")]
        _lexicon_cache = "\n".join(lines).strip()
    return _lexicon_cache


# ---------- flow 调用（宽容解析 + 坏输出重试一次，research 同款） ----------


async def _call_flow(key: str, payload: dict[str, Any], model: str) -> Any:
    import skills

    env_key = _FLOW_KEYS[key]
    flow_id = os.environ.get(env_key, "").strip()
    if not flow_id:
        raise RuntimeError(f"未配置 {env_key}（剧本审查 {key} flow）")
    tweaks = models.text_model_tweaks(model) if model else None
    last_error: ValueError | None = None
    for attempt in (1, 2):
        text = await skills.run_flow_blocking(
            flow_id, json.dumps(payload, ensure_ascii=False),
            tweaks=tweaks, timeout=_FLOW_TIMEOUTS[key],
        )
        if text.startswith("（"):
            # run_flow_blocking 的错误以全角括号包裹；引擎错误不重试
            raise RuntimeError(f"剧本审查 {key} flow 调用失败: {text[:200]}")
        try:
            return extract_json(text)
        except ValueError as exc:
            last_error = exc
            logger.warning("剧本审查 %s flow 输出解析失败（第 %d 次）: %s",
                           key, attempt, str(exc)[:200])
    raise RuntimeError(f"剧本审查 {key} flow 输出两次解析失败: {last_error}")


# ---------- 归一化（结构不符即抛，无 fallback） ----------


def _norm_severity(v: Any) -> str:
    s = str(v or "").strip().lower()
    return s if s in SEVERITIES else "medium"


def _norm_findings(raw: Any, dimension: str, need_related: bool) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ValueError(f"{dimension} 输出不是对象")
    items = raw.get("findings")
    if not isinstance(items, list):
        raise ValueError(f"{dimension} 输出缺 findings 数组")
    out = []
    for it in items[:MAX_FINDINGS]:
        if not isinstance(it, dict):
            continue
        quote = str(it.get("quote") or "").strip()
        message = str(it.get("message") or "").strip()
        if not quote or not message:
            continue
        out.append({
            "dimension": dimension,
            "severity": _norm_severity(it.get("severity")),
            "category": str(it.get("category") or "").strip(),
            "quote": quote,
            "relatedQuote": str(it.get("relatedQuote") or "").strip() if need_related else "",
            "message": message,
            "suggestion": str(it.get("suggestion") or "").strip(),
        })
    return out


def _norm_claims(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, dict) or not isinstance(raw.get("claims"), list):
        raise ValueError("事实抽取输出缺 claims 数组")
    out = []
    for it in raw["claims"][:MAX_CLAIMS]:
        if not isinstance(it, dict):
            continue
        quote = str(it.get("quote") or "").strip()
        claim = str(it.get("claim") or "").strip()
        if not quote or not claim:
            continue
        out.append({
            "quote": quote,
            "claim": claim,
            "reason": str(it.get("reason") or "").strip(),
        })
    return out


def _norm_verdicts(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, dict) or not isinstance(raw.get("verdicts"), list):
        raise ValueError("事实判定输出缺 verdicts 数组")
    out = []
    for it in raw["verdicts"]:
        if not isinstance(it, dict):
            continue
        verdict = str(it.get("verdict") or "").strip().lower()
        if verdict not in FACT_VERDICT_META:
            continue
        out.append({
            "id": str(it.get("id") or "").strip(),
            "verdict": verdict,
            "message": str(it.get("message") or "").strip(),
            "suggestion": str(it.get("suggestion") or "").strip(),
            "evidence": [str(e).strip() for e in (it.get("evidence") or []) if str(e).strip()],
        })
    return out


# ---------- 锚点定位 ----------

_WS_CHARS = " \t\r\n\u3000\u00a0"


def _find_anchor(body: str, quote: str) -> tuple[int, int]:
    """把 finding 的 quote 定位到正文字符区间。先精确找，再按去空白容错
    （LLM 摘录偶尔会合并换行）；找不到返回 (-1,-1)，前端只展示引文不高亮。"""
    idx = body.find(quote)
    if idx >= 0:
        return idx, idx + len(quote)
    q = "".join(quote.split())
    if not q:
        return -1, -1
    mapping = [i for i, ch in enumerate(body) if ch not in _WS_CHARS]
    stripped = "".join(body[i] for i in mapping)
    sidx = stripped.find(q)
    if sidx < 0:
        return -1, -1
    start = mapping[sidx]
    end = mapping[sidx + len(q) - 1] + 1
    return start, end


# ---------- 事实核查取证 ----------


async def _search_claim_evidence(
    claim_id: str, claim: str,
    evidence: dict[str, dict[str, str]], claim_sids: dict[str, list[str]],
) -> None:
    """单断言取证：2 条查询 → URL 去重取 top 源 → 尽力抓原文，抓不到落
    snippet 级证据（逐源诚实标注，research 同式）。"""
    queries = [claim, f"{claim} 事实核查"]
    urls: list[dict[str, str]] = []
    seen: set[str] = set()
    for q in queries:
        try:
            results = await imgresearch.search_serper_web(q, num=4)
        except Exception as exc:
            raise RuntimeError(f"Serper 搜索失败（{str(exc)[:120]}）") from exc
        for r in results:
            url = str(r.get("url") or "").strip()
            if url and url not in seen:
                seen.add(url)
                urls.append(r)
    for r in urls[:CLAIM_SOURCES]:
        sid = f"S{len(evidence) + 1:03d}"
        url = r["url"]
        content = str(r.get("snippet") or "").strip()
        fetch_status = "snippet"
        try:
            page = await research.fetch_page_text(url)
            content = page
            fetch_status = "ok"
        except Exception:
            pass
        evidence[sid] = {
            "sid": sid, "claim": claim_id, "url": url,
            "title": str(r.get("title") or "").strip(),
            "content": content[:_EVIDENCE_CHARS], "fetchStatus": fetch_status,
        }
        claim_sids.setdefault(claim_id, []).append(sid)


async def _run_fact(job_id: str, body: str, model: str) -> list[dict[str, Any]]:
    _set_dim(job_id, "fact", "running")
    _append_log(job_id, "info", "事实核查：抽取可核查断言")
    claims = _norm_claims(await _call_flow("claims", {"script": body}, model))
    if _aborted(job_id):
        raise _Cancelled()
    if not claims:
        _append_log(job_id, "info", "事实核查：无可核查断言")
        return []

    enumerated = [{"id": f"C{i + 1:02d}", **c} for i, c in enumerate(claims)]
    claim_sids: dict[str, list[str]] = {}
    evidence: dict[str, dict[str, str]] = {}
    sem = asyncio.Semaphore(3)

    async def _one(c: dict[str, Any]) -> None:
        async with sem:
            if _aborted(job_id):
                raise _Cancelled()
            _append_log(job_id, "info", f"取证 {c['id']}：{c['claim'][:40]}")
            try:
                await _search_claim_evidence(c["id"], c["claim"], evidence, claim_sids)
            except _Cancelled:
                raise
            except Exception as exc:  # noqa: BLE001 —— 单断言取证失败不炸维度：
                # 该断言按无证据进判定（verdict 流会给 unverifiable），日志明报
                _append_log(job_id, "warn",
                            f"{c['id']} 取证失败，按无证据判定：{str(exc)[:160]}")

    await asyncio.gather(*[_one(c) for c in enumerated])
    if _aborted(job_id):
        raise _Cancelled()

    evidence_lines = [
        f"{e['claim']}｜{sid}｜{e['title']}｜{e['content']}｜{e['url']}"
        for sid, e in evidence.items()
    ]
    _append_log(job_id, "info", f"取证完成：{len(claims)} 断言 {len(evidence)} 源，开始判定")
    verdicts = _norm_verdicts(await _call_flow(
        "verdict",
        {"claims": [{"id": c["id"], "quote": c["quote"], "claim": c["claim"]} for c in enumerated],
         "evidence": "\n".join(evidence_lines)},
        model,
    ))

    claim_by_id = {c["id"]: c for c in enumerated}
    known_sids = set(evidence)
    findings = []
    for v in verdicts:
        c = claim_by_id.get(v["id"])
        if c is None or v["verdict"] not in FACT_VERDICT_META:
            continue
        category, severity = FACT_VERDICT_META[v["verdict"]]
        sids = [s for s in v["evidence"] if s in known_sids]  # 幻觉编号剔除
        findings.append({
            "dimension": "fact",
            "severity": severity,
            "category": category,
            "quote": c["quote"],
            "relatedQuote": "",
            "message": v["message"] or "证据不足以核实该断言",
            "suggestion": v["suggestion"],
            "evidence": [
                {"sid": s, "url": evidence[s]["url"], "title": evidence[s]["title"]}
                for s in sids
            ],
        })
    _append_log(job_id, "info",
                f"事实判定完成：{len(verdicts)} 条中 {len(findings)} 条存疑/有误/无法核实")
    return findings


# ---------- 合规 / 一致性 ----------


async def _run_compliance(job_id: str, body: str, model: str) -> list[dict[str, Any]]:
    _set_dim(job_id, "compliance", "running")
    raw = await _call_flow("compliance", {"script": body, "lexicon": load_lexicon()}, model)
    findings = _norm_findings(raw, "compliance", need_related=False)
    _append_log(job_id, "info", f"合规审查完成：{len(findings)} 条问题")
    return findings


async def _run_consistency(job_id: str, body: str, model: str) -> list[dict[str, Any]]:
    _set_dim(job_id, "consistency", "running")
    raw = await _call_flow("consistency", {"script": body}, model)
    findings = _norm_findings(raw, "consistency", need_related=True)
    _append_log(job_id, "info", f"一致性审查完成：{len(findings)} 条矛盾")
    return findings


# ---------- 任务编排 ----------


def _insert_finding(job_id: str, body: str, f: dict[str, Any]) -> None:
    start, end = _find_anchor(body, f["quote"])
    with _conn() as conn:
        conn.execute(
            "INSERT INTO review_findings (id, job_id, dimension, severity, category,"
            " quote, quote_start, quote_end, related_quote, message, suggestion,"
            " evidence_json, dismissed, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
            (
                str(uuid.uuid4()), job_id, f["dimension"], f["severity"], f["category"],
                f["quote"], start, end, f.get("relatedQuote", ""), f["message"],
                f.get("suggestion", ""),
                json.dumps(f.get("evidence", []), ensure_ascii=False), _now(),
            ),
        )


async def _run_task(job_id: str, body: str, dims: list[str], model: str) -> None:
    try:
        _update_row(job_id, status="running")
        runners = {"compliance": _run_compliance, "consistency": _run_consistency, "fact": _run_fact}
        # 1s 粒度取消监视：取消时 cancel 全部在途维度任务（httpx 随之中断），
        # 不等单次 flow 跑完（最长 240s）才响应
        tasks = [asyncio.create_task(runners[d](job_id, body, model)) for d in dims]
        while True:
            if _aborted(job_id):
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)  # 收尸吞取消
                raise _Cancelled()
            await asyncio.wait(tasks, timeout=1.0, return_when=asyncio.FIRST_COMPLETED)
            if all(t.done() for t in tasks):
                break
        results = []
        for t in tasks:
            try:
                results.append(t.result())
            except Exception as exc:  # noqa: BLE001 —— 与 return_exceptions 同语义
                results.append(exc)

        total = 0
        errors: list[str] = []
        for dim, res in zip(dims, results):
            if isinstance(res, BaseException):
                if isinstance(res, _Cancelled):
                    raise res
                msg = str(res)[:200]
                errors.append(f"{dim}：{msg}")
                _set_dim(job_id, dim, "error", msg)
                logger.warning("剧本审查 %s 维度 %s 失败: %s", job_id, dim, msg)
                continue
            _set_dim(job_id, dim, "done")
            for f in res:
                _insert_finding(job_id, body, f)
                total += 1

        # 单维度软失败明报（dims 里带原因），全失败才整单 error
        if errors and total == 0 and len(errors) == len(dims):
            _update_row(job_id, status="error", error="；".join(errors)[:500])
            _append_log(job_id, "error", f"全部维度失败：{errors}")
        else:
            _update_row(job_id, status="done", error="；".join(errors)[:500])
            _append_log(job_id, "info", f"审查完成：共 {total} 条问题（{len(errors)} 个维度软失败）")
    except _Cancelled:
        _update_row(job_id, status="stopped", error="已取消")
        _append_log(job_id, "info", "任务已取消")
    except Exception as exc:  # noqa: BLE001 —— 兜底落库，轮询端可见
        logger.exception("剧本审查任务 %s 异常", job_id)
        _update_row(job_id, status="error", error=str(exc)[:500])
        _append_log(job_id, "error", f"任务异常：{str(exc)[:300]}")
    finally:
        _CANCELLED.discard(job_id)


def start_review(
    project_id: str, node_id: str, card_title: str, body: str,
    dimensions: list[str], text_model: str,
) -> dict[str, Any]:
    """发起审查：校验 → 建 job 行（queued）→ 后台跑。返回任务视图。"""
    # 指纹/锚点/字数一律对原文算（不 strip）——前端比对的是 store 原文，
    # strip 掉首尾空白会让尾换行剧本每次都亮「剧本已修改」假横幅
    if not body.strip():
        raise ValueError("剧本正文为空，无需审查")
    if len(body) > MAX_BODY_CHARS:
        raise ValueError(f"剧本过长（{len(body)} 字），当前支持 {MAX_BODY_CHARS} 字以内")
    dims = [d for d in dimensions if d in DIMENSIONS]
    if not dims:
        raise ValueError("至少选择一个审查维度")
    with _conn() as conn:
        busy = conn.execute(
            "SELECT id FROM review_jobs WHERE project_id = ? AND node_id = ?"
            " AND status IN ('queued','running') LIMIT 1",
            (project_id, node_id),
        ).fetchone()
    if busy:
        raise ValueError("该剧本已有审查任务在跑，请等待完成或取消后再发起")

    sha1 = hashlib.sha1(body.encode("utf-8")).hexdigest()
    job_id = str(uuid.uuid4())
    now = _now()
    dims_state = {d: {"state": "pending", "error": ""} for d in dims}
    with _conn() as conn:
        conn.execute(
            "INSERT INTO review_jobs (id, project_id, node_id, card_title,"
            " dimensions_json, status, dims_json, body_sha1, body_chars, text_model,"
            " error, log_json, created_at, updated_at)"
            " VALUES (?,?,?,?,?,'queued',?,?,?,?, '', '[]', ?, ?)",
            (
                job_id, project_id, node_id, card_title[:120],
                json.dumps(dims, ensure_ascii=False),
                json.dumps(dims_state, ensure_ascii=False),
                sha1, len(body), text_model[:80], now, now,
            ),
        )
    asyncio.get_running_loop().create_task(_run_task(job_id, body, dims, text_model))
    view = get_review_view(job_id)
    assert view is not None
    return view
