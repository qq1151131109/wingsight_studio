"""标杆拆解知识库（insights）：把「近期什么内容火」变成可复用的选题知识。

平台热榜/豆瓣口碑是原始数据（谁在热），本模块存的是拆解结论（为什么热、
什么可迁移）——每天从热内容里采样几条做结构化拆解，跨时间累积成知识。

三条纪律（写进拆解 flow 提示词，代码层只做结构校验）：
  1. 只收内容侧可迁移因素——平台推荐/版权采购/运营位一律不收（不可迁移，学了没用）
  2. 跨样本归纳优先于单条归因——单条拆解是原材料，规律靠聚合（distribution()）
  3. 每条结论挂证据（评分/评价人数/上榜位次）——无证据不写

消费路径：选题收敛时按垂类/热度注入相关洞察 + 分布画像；use_count 记被注入
且产出非空的次数，用来淘汰没被用上的知识（同 treatments 的热度浮沉范式）。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# 注入上限：一次收敛载荷最多带几条洞察（多了稀释提示词注意力）
INSIGHT_PAYLOAD_LIMIT = 8
# 单条字段长度上限（防拆解输出灌水）
_LIMITS = {
    "subject": 60,      # 题材：一句话说清这是什么内容
    "treatment": 40,    # 讲法：怎么讲的（形态轴）
    "emotion": 60,      # 情绪入口：观众为什么点进来
    "form": 60,         # 形式：时长/节奏/视角等可迁移形态
    "transferable": 120,  # 可迁移结论：这个打法能搬到什么题材上（最有价值的一栏）
    "evidence": 80,     # 证据：来自评分/热度/上榜位次的硬数据
}


def _conn():
    import topics  # 运行期晚导入：topics 是存储叶模块，无环

    return topics._conn()


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def insight_id(title: str) -> str:
    """按来源标题指纹做主键：同一条内容只拆一次（幂等）。"""
    keep = "".join(ch for ch in str(title or "").lower() if ch.isalnum())
    return hashlib.sha256(keep.encode("utf-8")).hexdigest()[:16]


def ensure_table() -> None:
    import topics

    topics.init_topics_db()


def upsert_insight(entry: dict[str, Any]) -> bool:
    """拆解结果入库。同 id 更新拆解字段（重拆覆盖），保留 use_count。"""
    title = str(entry.get("title") or "").strip()
    if not title:
        return False
    iid = str(entry.get("id") or insight_id(title))
    fields = {k: str(entry.get(k) or "").strip()[:lim] for k, lim in _LIMITS.items()}
    if not fields["subject"]:
        return False  # 题材都没拆出来，这条拆解没价值
    try:
        with _conn() as conn:
            conn.execute(
                "INSERT INTO insights (id, source_title, source_url, platform, metric,"
                " vertical, subject, treatment, emotion, form, transferable, evidence,"
                " confidence, use_count, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
                " ON CONFLICT(id) DO UPDATE SET subject = excluded.subject,"
                " treatment = excluded.treatment, emotion = excluded.emotion,"
                " form = excluded.form, transferable = excluded.transferable,"
                " evidence = excluded.evidence, metric = excluded.metric,"
                " confidence = excluded.confidence"
                " WHERE insights.edited = 0",  # 用户改过的条目不被重拆覆盖
                (
                    iid,
                    title[:80],
                    str(entry.get("url") or "").strip()[:200],
                    str(entry.get("platform") or "").strip()[:20],
                    str(entry.get("metric") or "").strip()[:80],
                    str(entry.get("vertical") or "").strip()[:20],
                    fields["subject"],
                    fields["treatment"],
                    fields["emotion"],
                    fields["form"],
                    fields["transferable"],
                    fields["evidence"],
                    int(entry.get("confidence") or 1),
                    _now(),
                ),
            )
        return True
    except Exception:
        return False


def record_use(ids: list[str]) -> None:
    """被注入且该批产出了卡：记一次使用（淘汰依据；失败不影响主流程）。"""
    if not ids:
        return
    try:
        with _conn() as conn:
            conn.executemany(
                "UPDATE insights SET use_count = use_count + 1 WHERE id = ?",
                [(str(i),) for i in ids],
            )
    except Exception:
        pass


def list_insights(limit: int = INSIGHT_PAYLOAD_LIMIT, vertical: str | None = None) -> list[dict[str, Any]]:
    """取头部洞察：同垂类优先（相关），其次使用热度与新旧。

    注入时垂类匹配的排前面，其余按热度补齐——不做严格过滤，避免新库空窗。
    """
    try:
        with _conn() as conn:
            rows = conn.execute(
                "SELECT * FROM insights ORDER BY use_count DESC, created_at DESC LIMIT ?",
                (max(limit * 3, limit),),
            ).fetchall()
    except Exception:
        return []
    out = [dict(r) for r in rows]
    if vertical:
        out.sort(key=lambda r: 0 if r.get("vertical") == vertical else 1)
    return [
        {
            "id": r["id"],
            "title": r["source_title"],
            "platform": r["platform"],
            "metric": r["metric"],
            "subject": r["subject"],
            "treatment": r["treatment"],
            "emotion": r["emotion"],
            "form": r["form"],
            "transferable": r["transferable"],
            "evidence": r["evidence"],
        }
        for r in out[:limit]
    ]


def payload(limit: int = INSIGHT_PAYLOAD_LIMIT, vertical: str | None = None) -> list[dict[str, Any]]:
    """收敛载荷形态（与 list_insights 同源，留接口便于后续按垂类检索）。"""
    return list_insights(limit=limit, vertical=vertical)


def distribution() -> dict[str, list[tuple[str, int]]]:
    """知识库聚合画像：题材/讲法/情绪三个维度的分布（跨样本归纳，非单条归因）。

    样本不足（<5 条）返回空——少数样本的"规律"是噪音，宁可不说。
    """
    try:
        with _conn() as conn:
            total = conn.execute("SELECT COUNT(*) FROM insights").fetchone()[0]
            if int(total or 0) < 5:
                return {}
            out: dict[str, list[tuple[str, int]]] = {}
            for col, key in (("treatment", "讲法"), ("vertical", "垂类")):
                rows = conn.execute(
                    f"SELECT {col} AS k, COUNT(*) AS n FROM insights"
                    f" WHERE {col} != '' GROUP BY {col} ORDER BY n DESC LIMIT 5"
                ).fetchall()
                if rows:
                    out[key] = [(str(r["k"]), int(r["n"])) for r in rows]
            return out
    except Exception:
        return {}


def stats_line() -> str:
    """一行画像摘要（进提示词）；样本不足返回空串。"""
    dist = distribution()
    if not dist:
        return ""
    parts = [f"{k}：" + "、".join(f"{name}({n})" for name, n in v) for k, v in dist.items()]
    return "近期标杆拆解分布（" + "；".join(parts) + "）"


# ---------- 管理面板读写（用户可见/可改） ----------

_EDITABLE = ("subject", "treatment", "emotion", "form", "transferable", "evidence")


def list_all() -> list[dict[str, Any]]:
    """管理面板：全量条目（含热度与时间），最新在前。"""
    try:
        with _conn() as conn:
            rows = conn.execute(
                "SELECT * FROM insights ORDER BY created_at DESC LIMIT 500"
            ).fetchall()
    except Exception:
        return []
    return [
        {
            "id": r["id"],
            "title": r["source_title"],
            "url": r["source_url"],
            "platform": r["platform"],
            "metric": r["metric"],
            "vertical": r["vertical"],
            "subject": r["subject"],
            "treatment": r["treatment"],
            "emotion": r["emotion"],
            "form": r["form"],
            "transferable": r["transferable"],
            "evidence": r["evidence"],
            "confidence": int(r["confidence"] or 1),
            "useCount": int(r["use_count"] or 0),
            "edited": bool(r["edited"]),
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


def update_insight(iid: str, fields: dict[str, Any]) -> bool:
    """用户手工修订拆解：只改给定字段，打 edited 标记防后续重拆覆盖。"""
    sets, params = [], []
    for k in _EDITABLE:
        if k in fields:
            sets.append(f"{k} = ?")
            params.append(str(fields.get(k) or "").strip()[: _LIMITS[k]])
    if not sets:
        return False
    params.append(str(iid or "").strip())
    try:
        with _conn() as conn:
            cur = conn.execute(
                f"UPDATE insights SET {', '.join(sets)}, edited = 1 WHERE id = ?", params
            )
            return cur.rowcount > 0
    except Exception:
        return False


def delete_insight(iid: str) -> bool:
    try:
        with _conn() as conn:
            cur = conn.execute("DELETE FROM insights WHERE id = ?", (str(iid or "").strip(),))
            return cur.rowcount > 0
    except Exception:
        return False
