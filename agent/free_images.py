"""自由生图工作台（juben ImageStudioPage 移植，2026-09-07）。

与资产/分镜出图完全隔离（juben 同款约定）：
- 不读项目画风、不注入版式契约——assetType="none" 且走 final_prompt 通道
  （版式显选 v3 的 KEEP 语义：用户提示词原样直发，参考编号注解置顶）；
- 产出落 static/assets（与全站同域，hex 不可变名 + thumbs），不写画布、不进资产库；
- @图N 注解解析与参考图绑定照搬 juben services/generation/free_image.py：
  「@图1 锁定脸部」→ 注解抹出正文、以 编号注解 行并入最终提示词。

一次点击多模型并行 = 一个 batch（画廊按 batch 分组）；每模型一行任务，
各自调 skills._generate_single_image（复用模型目录校验与三条出图通道）。
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import models  # noqa: E402  (dotenv 之后的平铺模块，同 main.py)
import projects  # noqa: E402
import skills  # noqa: E402

DB_PATH = Path(__file__).resolve().parent / "data" / "wingsight.db"

PROMPT_MAX = 6000
FREE_IMAGE_TIMEOUT_SEC = 10 * 60  # 上游偶发挂起兜底，对齐 juben
MAX_BATCH_MODELS = 8  # 目录内模型全选上限之外的保护（越界明报）
LIST_LIMIT = 300

# 内存任务表：重启后 DB 行仍在（终态可读），在途行由 _prune_orphans 终态化
_TASKS: Dict[str, asyncio.Task] = {}


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS free_images ("
        " id TEXT PRIMARY KEY,"
        " project_id TEXT NOT NULL,"
        " batch_id TEXT NOT NULL,"
        " prompt TEXT NOT NULL,"
        " aspect TEXT NOT NULL DEFAULT '',"
        " resolution TEXT NOT NULL DEFAULT '',"
        " model_id TEXT NOT NULL,"
        " reference_urls TEXT NOT NULL DEFAULT '[]',"
        " status TEXT NOT NULL,"
        " image_url TEXT,"
        " final_prompt TEXT,"
        " error TEXT,"
        " created_at TEXT NOT NULL,"
        " updated_at TEXT NOT NULL)"
    )
    return conn


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _cutoff() -> str:
    return (datetime.now() - timedelta(days=30)).isoformat(timespec="seconds")


def _row_to_item(row: sqlite3.Row, with_final_prompt: bool = False) -> Dict[str, Any]:
    """画廊行序列化。finalPrompt（每行最多 3000 字）默认不带——画廊列表
    3s 轮询下发它是纯流量浪费（用户隧道下图片请求全排在它后面），详情
    按条拉取（GET /free-images/{id}）。"""
    item = {
        "id": row["id"],
        "projectId": row["project_id"],
        "batchId": row["batch_id"],
        "prompt": row["prompt"],
        "aspect": row["aspect"],
        "resolution": row["resolution"],
        "modelId": row["model_id"],
        "referenceUrls": json.loads(row["reference_urls"] or "[]"),
        "status": row["status"],
        "imageUrl": row["image_url"],
        "error": row["error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }
    if with_final_prompt:
        item["finalPrompt"] = row["final_prompt"]
    return item


def get_item(item_id: str) -> Optional[Dict[str, Any]]:
    """单条详情（含 finalPrompt），Lightbox 打开时拉取；不存在返回 None。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM free_images WHERE id = ?", (item_id,)
        ).fetchone()
    return _row_to_item(row, with_final_prompt=True) if row else None


def _reconcile_orphans(conn: sqlite3.Connection) -> None:
    """重启遗留对账：在途（queued/running）且进程内无任务、行龄 >60s 的
    就地终态化。60s 窗口防建批竞态（INSERT 落库与 _TASKS 注册之间无 await，
    但轮询请求在别的线程，留足余量）。"""
    grace = (datetime.now() - timedelta(seconds=60)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT id FROM free_images WHERE status IN ('queued', 'running')"
        " AND updated_at < ?",
        (grace,),
    ).fetchall()
    for r in rows:
        if r["id"] not in _TASKS:
            conn.execute(
                "UPDATE free_images SET status = 'error',"
                " error = '生成中断（服务重启），可重试', updated_at = ? WHERE id = ?",
                (_now(), r["id"]),
            )


def list_free_images(project_id: str) -> List[Dict[str, Any]]:
    """画廊数据源：项目内全部批次倒序（新批次在前）；顺手对账孤儿行。"""
    with _conn() as conn:
        _reconcile_orphans(conn)
        rows = conn.execute(
            "SELECT * FROM free_images WHERE project_id = ?"
            " ORDER BY created_at DESC, id DESC LIMIT ?",
            (project_id, LIST_LIMIT),
        ).fetchall()
    return [_row_to_item(r) for r in rows]


def _parse_reference_annotations(prompt: str) -> tuple[str, Dict[int, str]]:
    """解析 prompt 里的 ``@图N 注解``，返回 ``(去注解正文, {序号: 说明})``。

    照搬 juben：``@图(\\d+)\\s*([^@]*)`` 让说明吃到下一个 @ 前，尾标点清理，
    ``@图N`` 字样从最终正文抹除。
    """
    annotations: Dict[int, str] = {}
    for match in re.finditer(r"@图(\d+)\s*([^@]*)", prompt):
        index = int(match.group(1))
        text = match.group(2).strip().rstrip("，,。；;：:、 ")
        if index > 0 and text:
            annotations[index] = text
    cleaned = re.sub(r"@图\d+\s*", "", prompt)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned, annotations


def _filename_of(url: str) -> str:
    return url.rsplit("/", 1)[-1] or url


def _build_final_prompt(cleaned: str, refs: List[Dict[str, str]]) -> str:
    """最终提示词 = 参考编号注解（有参考才出现）+ 用户正文原样。

    编号注解把 图N 与实际参考图（及 @图N 注解）对上号——final_prompt 通道
    不经 flow 模板渲染，参考职责段不存在，编号行就是参考图的全部说明。
    """
    if not refs:
        return cleaned
    parts = []
    for i, r in enumerate(refs, 1):
        note = r.get("annotation", "")
        parts.append(f"图{i}=《{r['filename']}》" + (f"：{note}" if note else ""))
    return "参考图编号：" + "；".join(parts) + "。\n" + cleaned


def _update(id_: str, **fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _conn() as conn:
        conn.execute(
            f"UPDATE free_images SET {sets}, updated_at = ? WHERE id = ?",
            (*fields.values(), _now(), id_),
        )


def _prune_old_rows() -> None:
    """30 天龄期懒清理（建新批次时顺手删，不设启动钩子）。"""
    with _conn() as conn:
        conn.execute("DELETE FROM free_images WHERE updated_at < ?", (_cutoff(),))


async def _run_one(
    id_: str,
    model_id: str,
    params: Dict[str, str],
    aspect: str,
    final_prompt: str,
    ref_urls: List[str],
) -> None:
    _update(id_, status="running")
    try:
        shot: Dict[str, Any] = {
            # name 不进提示词（final_prompt 通道），仅供任务记录可读
            "name": final_prompt[:24] or "自由生图",
            "description": final_prompt,
            "assetType": "none",
            "visualNotes": "",
            "finalPrompt": final_prompt,
            "referenceImages": ref_urls,
            **({"aspect": aspect} if aspect else {}),
        }
        result = await asyncio.wait_for(
            skills._generate_single_image(shot, params=params),
            timeout=FREE_IMAGE_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        result = {"ok": False, "error": f"生成超时（>{FREE_IMAGE_TIMEOUT_SEC // 60} 分钟），可重试"}
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 单模型失败不拦批次，明报在卡片上
        result = {"ok": False, "error": str(exc)[:300]}
    _TASKS.pop(id_, None)
    if result.get("ok") and result.get("imageUrl"):
        _update(
            id_,
            status="done",
            image_url=str(result["imageUrl"]),
            final_prompt=str(result.get("finalPrompt") or final_prompt),
        )
    else:
        _update(id_, status="error", error=str(result.get("error") or "生成失败"))


async def create_batch(
    project_id: str,
    prompt: str,
    aspect: str,
    resolution: str,
    model_ids: List[str],
    reference_images: List[str],
    viewer: Any = None,
) -> Dict[str, Any]:
    """建批次（一模型一行）并启动任务；校验失败 ValueError → 端点 400 明报。

    viewer（HTTP 端点的 CurrentUser）非空时校验项目访问权；None = 聊天工具
    上下文（与其他后端工具同一信任级，项目由会话线程解析）。
    校验铁律与全站一致：模型/画幅/档位组合不合法点名报错，绝不静默换默认。
    """
    if viewer is not None:
        projects.assert_access(viewer, project_id)
    raw_prompt = (prompt or "").strip()
    if not raw_prompt:
        raise ValueError("提示词不能为空")
    if len(raw_prompt) > PROMPT_MAX:
        raise ValueError(f"提示词超长（{len(raw_prompt)} > {PROMPT_MAX} 字）")
    cleaned, annotations = _parse_reference_annotations(raw_prompt)
    if not cleaned:
        raise ValueError("提示词除 @图N 注解外为空")

    if not model_ids:
        raise ValueError("至少选择一个出图模型")
    if len(model_ids) > MAX_BATCH_MODELS:
        raise ValueError(f"一次最多并行 {MAX_BATCH_MODELS} 个模型（收到 {len(model_ids)}）")

    ref_urls = [str(u).strip() for u in reference_images if str(u).strip()]
    refs = [
        {
            "url": u,
            "filename": _filename_of(u),
            "annotation": annotations.get(i + 1, ""),
        }
        for i, u in enumerate(ref_urls)
    ]
    stray = [n for n in annotations if n > len(refs)]
    if stray:
        raise ValueError(
            f"@图{stray[0]} 没有对应的参考图（当前 {len(refs)} 张），请检查编号或补充参考图"
        )

    # 逐模型预校验（模型存在 / 档位 / 画幅 / 参考图上限）：任一不合法整批 400 点名
    per_model: List[Dict[str, Any]] = []
    for mid in model_ids:
        entry = models.find_model(mid)
        if entry is None:
            known = " / ".join(m["id"] for m in models.IMAGE_MODELS)
            raise ValueError(f"未知出图模型：{mid}（可用：{known}）")
        try:
            params = models.resolve_imagegen_params(
                {"model": mid, **({"resolution": resolution} if resolution else {})}
            )
            resolved_aspect = models.resolve_aspect(aspect, mid)
        except ValueError as exc:
            raise ValueError(f"「{entry['label']}」{exc}") from None
        if len(ref_urls) > int(entry.get("max_references") or 4):
            raise ValueError(
                f"「{entry['label']}」最多带 {entry['max_references']} 张参考图（当前 {len(ref_urls)}）"
            )
        per_model.append({"model_id": mid, "params": params, "aspect": resolved_aspect or ""})

    _prune_old_rows()
    final_prompt = _build_final_prompt(cleaned, refs)
    batch_id = uuid.uuid4().hex[:12]
    now = _now()
    rows = []
    with _conn() as conn:
        for m in per_model:
            id_ = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO free_images (id, project_id, batch_id, prompt, aspect,"
                " resolution, model_id, reference_urls, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
                (
                    id_,
                    project_id,
                    batch_id,
                    raw_prompt,
                    aspect,
                    resolution,
                    m["model_id"],
                    json.dumps(ref_urls, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            rows.append(
                {
                    "id": id_,
                    "batchId": batch_id,
                    "modelId": m["model_id"],
                    "status": "queued",
                }
            )
    loop = asyncio.get_running_loop()
    for r, m in zip(rows, per_model):
        _TASKS[r["id"]] = loop.create_task(
            _run_one(r["id"], m["model_id"], m["params"] or {}, m["aspect"], final_prompt, ref_urls)
        )
    return {"batchId": batch_id, "items": rows}


def active_task_count() -> int:
    return sum(1 for t in _TASKS.values() if not t.done())


def get_final_prompt_preview(project_id: str, batch_id: str) -> Optional[str]:
    """批次最终提示词（画廊展示用；批内各模型同文）。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT final_prompt FROM free_images WHERE project_id = ? AND batch_id = ?"
            " AND final_prompt IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
            (project_id, batch_id),
        ).fetchone()
    return row["final_prompt"] if row else None
