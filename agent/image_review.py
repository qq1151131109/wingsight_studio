"""AI 艺术评审引擎（doc/image-node-ops-spec.md §10，script_review.py 同范式）。

四维 rubric（构图/色彩/光线/比例结构，open-ai-canvas art-critique 改写）
一次视觉调用评完（image-art-review flow，gpt-5.6-luna 视觉经 DMX），
findings 落 SQLite（image_review_jobs / image_review_findings）。
与剧本审查的差异：评审对象是图片——无文本锚点/指纹（不存 sha1 不定位
区间），维度状态由 findings 聚合而来（单次调用四维同时出）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid
from datetime import datetime
from typing import Any

import eventbus
import skills

DB_PATH = os.environ.get("WINGSIGHT_DB", "data/wingsight.db")
FLOW_ID = os.environ.get("LANGFLOW_IMAGE_ART_REVIEW_FLOW_ID", "")

DIMENSIONS = ["composition", "color", "lighting", "proportion"]
DIMENSION_LABEL = {
    "composition": "构图与视觉层级",
    "color": "色彩",
    "lighting": "光线",
    "proportion": "比例结构与透视",
}
VALID_SEVERITY = {"high", "medium", "low"}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_review_db() -> None:
    with _conn() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS image_review_jobs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                card_title TEXT,
                image_url TEXT NOT NULL,
                status TEXT NOT NULL,
                dims_json TEXT NOT NULL,
                model TEXT,
                error TEXT,
                log_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS image_review_findings (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                dimension TEXT NOT NULL,
                severity TEXT NOT NULL,
                title TEXT NOT NULL,
                quote TEXT,
                detail TEXT,
                suggestion TEXT,
                dismissed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )"""
        )


def _get_row(job_id: str) -> sqlite3.Row | None:
    with _conn() as conn:
        return conn.execute(
            "SELECT * FROM image_review_jobs WHERE id = ?", (job_id,)
        ).fetchone()


def _update_row(job_id: str, **fields: Any) -> None:
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        conn.execute(
            f"UPDATE image_review_jobs SET {cols} WHERE id = ?", (*fields.values(), job_id)
        )


def _append_log(job_id: str, kind: str, text: str) -> None:
    row = _get_row(job_id)
    if not row:
        return
    log = json.loads(row["log_json"] or "[]")
    log.append({"t": _now(), "kind": kind, "text": text[:500]})
    _update_row(job_id, log_json=json.dumps(log[-100:], ensure_ascii=False))


def _finding_view(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "jobId": row["job_id"],
        "dimension": row["dimension"],
        "severity": row["severity"],
        "title": row["title"],
        "quote": row["quote"] or "",
        "detail": row["detail"] or "",
        "suggestion": row["suggestion"] or "",
        "dismissed": bool(row["dismissed"]),
        "createdAt": row["created_at"],
    }


def list_findings(job_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM image_review_findings WHERE job_id = ? ORDER BY created_at, id",
            (job_id,),
        ).fetchall()
    return [_finding_view(r) for r in rows]


def get_review_view(job_id: str, include_findings: bool = True) -> dict[str, Any] | None:
    row = _get_row(job_id)
    if not row:
        return None
    dims = json.loads(row["dims_json"])
    view = {
        "jobId": row["id"],
        "projectId": row["project_id"],
        "nodeId": row["node_id"],
        "cardTitle": row["card_title"],
        "imageUrl": row["image_url"],
        "status": row["status"],
        "dims": dims,
        "model": row["model"] or "",
        "error": row["error"] or "",
        "log": json.loads(row["log_json"] or "[]"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if include_findings:
        findings = list_findings(job_id)
        view["findings"] = findings
        view["openCount"] = sum(1 for f in findings if not f["dismissed"])
        view["totalCount"] = len(findings)
    return view


def set_finding_dismissed(job_id: str, finding_id: str, dismissed: bool) -> dict[str, Any]:
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE image_review_findings SET dismissed = ? WHERE id = ? AND job_id = ?",
            (1 if dismissed else 0, finding_id, job_id),
        )
        if cur.rowcount == 0:
            raise ValueError("评审条目不存在")
        row = conn.execute(
            "SELECT * FROM image_review_findings WHERE id = ?", (finding_id,)
        ).fetchone()
    finding = _finding_view(row)
    _sync_dim_states(job_id)
    return finding


def _sync_dim_states(job_id: str) -> None:
    """按 findings 聚合各维度 open 数（done 态）。"""
    row = _get_row(job_id)
    if not row:
        return
    dims = json.loads(row["dims_json"])
    findings = list_findings(job_id)
    for dim in list(dims.keys()):
        dims[dim] = {
            "state": "done",
            "error": "",
            "open": sum(
                1 for f in findings if f["dimension"] == dim and not f["dismissed"]
            ),
        }
    _update_row(job_id, dims_json=json.dumps(dims, ensure_ascii=False))


def cancel_review(job_id: str) -> None:
    row = _get_row(job_id)
    if not row:
        raise ValueError("评审任务不存在")
    if row["status"] in ("done", "error", "stopped"):
        raise ValueError("任务已结束，无需取消")
    _update_row(job_id, status="stopped")


def report_interrupted_jobs() -> int:
    """agent 重启时把在途任务标为 interrupted（_scriptreview 同款善后）。"""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE image_review_jobs SET status = 'interrupted', error = 'agent 重启导致中断'"
            " WHERE status IN ('queued','running')"
        )
        return cur.rowcount


class _Cancelled(Exception):
    pass


def _norm_findings(raw: Any) -> list[dict[str, Any]]:
    """flow 输出 findings 数组规范化：非法维度/严重度/空标题丢弃。"""
    if not isinstance(raw, dict):
        return []
    out: list[dict[str, Any]] = []
    for f in raw.get("findings") or []:
        if not isinstance(f, dict):
            continue
        dim = str(f.get("dimension") or "").strip()
        if dim not in DIMENSIONS:
            continue
        title = str(f.get("title") or "").strip()
        if not title:
            continue
        severity = str(f.get("severity") or "medium").strip().lower()
        if severity not in VALID_SEVERITY:
            severity = "medium"
        out.append(
            {
                "dimension": dim,
                "severity": severity,
                "title": title[:80],
                "quote": str(f.get("quote") or "").strip()[:200],
                "detail": str(f.get("detail") or "").strip()[:800],
                "suggestion": str(f.get("suggestion") or "").strip()[:800],
            }
        )
    return out


def _parse_flow_json(raw: str) -> dict[str, Any]:
    """flow 文本 → 严格 JSON（skills._parse_flow_json 同款防错误伪装链）。"""
    text = (raw or "").strip()
    if text.startswith("（") and text.endswith("）"):
        raise RuntimeError(f"评审 flow 失败：{text.strip('（）')}")
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError(f"评审返回不是 JSON：{text[:120]}")
    return json.loads(text[start : end + 1])


def _check_cancelled(job_id: str) -> None:
    row = _get_row(job_id)
    if row is None or row["status"] == "stopped":
        raise _Cancelled()


async def _run_task(job_id: str, image_url: str, card_title: str, model: str) -> None:
    try:
        _check_cancelled(job_id)
        _append_log(job_id, "info", "评审任务启动（四维一次评完）")
        _update_row(job_id, status="running")
        # 相对 /agent-service/assets/ → agent 本机绝对 URL（组件 httpx 要下载）
        abs_url = skills._normalize_asset_url(image_url)
        tweaks: dict[str, Any] = {
            "ArtReview-main": {
                "payload": json.dumps(
                    {"image_url": abs_url, "card_title": card_title},
                    ensure_ascii=False,
                ),
                "api_key": skills.DMX_API_KEY,
            }
        }
        if model:
            tweaks["ArtReview-main"]["model_name"] = model
        raw = await skills.run_flow_blocking(FLOW_ID, input_value="", tweaks=tweaks)
        _check_cancelled(job_id)
        data = _parse_flow_json(raw)
        findings = _norm_findings(data)
        with _conn() as conn:
            for f in findings:
                conn.execute(
                    "INSERT INTO image_review_findings (id, job_id, dimension, severity,"
                    " title, quote, detail, suggestion, dismissed, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,0,?)",
                    (
                        str(uuid.uuid4()), job_id, f["dimension"], f["severity"],
                        f["title"], f["quote"], f["detail"], f["suggestion"], _now(),
                    ),
                )
        _append_log(job_id, "info", f"评审完成：{len(findings)} 条发现")
        _update_row(job_id, status="done")
        _sync_dim_states(job_id)
        _emit_review_terminal(job_id)
    except _Cancelled:
        return
    except Exception as exc:  # noqa: BLE001
        row = _get_row(job_id)
        if row is not None and row["status"] == "stopped":
            return
        _append_log(job_id, "error", str(exc)[:300])
        _update_row(job_id, status="error", error=str(exc)[:300])
        _emit_review_terminal(job_id)


def _emit_review_terminal(job_id: str) -> None:
    """终态广播到 SSE 事件流（用户可能已离开图片卡，卡锚轮询看不见）。"""
    row = _get_row(job_id)
    if row is None or row["status"] not in ("done", "error"):
        return
    eventbus.publish_job_event(
        "image_review",
        str(row["project_id"]),
        job_id,
        str(row["status"]),
        title=str(row["card_title"] or "图片评审"),
        summary=str(row["error"] or "")[:200] if row["status"] == "error" else "评审完成",
    )


def start_review(
    project_id: str, node_id: str, card_title: str, image_url: str, model: str,
) -> dict[str, Any]:
    """发起评审：校验 → 建 job（queued）→ 后台跑。返回任务视图。"""
    if not FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_IMAGE_ART_REVIEW_FLOW_ID（flow 见 agent/flows/image-art-review.json）"
        )
    if not str(image_url).strip():
        raise ValueError("该卡没有可评审的图片")
    with _conn() as conn:
        busy = conn.execute(
            "SELECT id FROM image_review_jobs WHERE project_id = ? AND node_id = ?"
            " AND status IN ('queued','running') LIMIT 1",
            (project_id, node_id),
        ).fetchone()
    if busy:
        raise ValueError("该图片已有评审任务在跑，请等待完成或取消后再发起")
    job_id = str(uuid.uuid4())
    now = _now()
    dims_state = {d: {"state": "pending", "error": "", "open": 0} for d in DIMENSIONS}
    with _conn() as conn:
        conn.execute(
            "INSERT INTO image_review_jobs (id, project_id, node_id, card_title,"
            " image_url, status, dims_json, model, error, log_json, created_at, updated_at)"
            " VALUES (?,?,?,?,?,'queued',?,?, '', '[]', ?, ?)",
            (
                job_id, project_id, node_id, (card_title or "")[:120],
                image_url, json.dumps(dims_state, ensure_ascii=False),
                (model or "")[:80], now, now,
            ),
        )
    asyncio.get_running_loop().create_task(_run_task(job_id, image_url, card_title, model))
    view = get_review_view(job_id)
    assert view is not None
    return view
