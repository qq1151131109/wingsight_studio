"""资产参考图调研：Serper 号池（Google 图片搜索）搜图，候选下载落盘入库，
调研任务异步 job + 轮询（Next 同源代理 30s 掐断，不能阻塞）。

搜索词由 planner flow 生成（手填可覆盖），LLM 终选推荐；采纳权在用户。
号池 round-robin 轮转，401/403（无效/额度耗尽）自动作废换下一个 key，
429 限速换 key 重试；号池管理在 /api/v1/serper-keys（管理后台）。
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

import eventbus  # noqa: E402  (与 main.py 同式：dotenv 之后导入)

import jobstore  # noqa: E402  (与 main.py 同式：dotenv 之后导入)
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
# wikimedia 批量下载常撞 429/5xx 限流，带退避重试（juben fetch 同口径）。
# 403 也重试（2026-09-11 冯太后项目教训：70 资产批量跑时人物类图源集中在
# 百科/知乎/搜狐几个大 CDN，开跑风暴触发防盗链 403、18 个资产候选图全灭
# ——其中相当比例是瞬时挑战，退避后再来一次就过了；持续 403 的源重试两次
# 后照旧失败，不白名单放行）
_RETRYABLE_STATUS = {403, 429, 500, 502, 503, 504}
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


# 主体表：调研产物的权威落点，键是「主体」（era + subject_key）而不是「项目+节点」
# ——同一时代同一主体全库唯一一条，项目通过 research_uses 引用它（活引用，不存副本）。
_ENTRIES_DDL = """
    CREATE TABLE IF NOT EXISTS research_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        node_id TEXT NOT NULL DEFAULT '',
        asset_name TEXT NOT NULL DEFAULT '',
        asset_type TEXT NOT NULL DEFAULT '',
        era TEXT NOT NULL DEFAULT '',
        topic_key TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(era, subject_key)
    );
    CREATE INDEX IF NOT EXISTS idx_research_entries_subject
        ON research_entries(era, subject_key);
"""


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

            -- 主体图集：调研采纳的参考图按「主体」归档（不是按项目节点）。
            -- 图是最贵的产物（搜索 + 下载 + 视觉模型终选 + 存储），挂在主体上
            -- 才可能跨项目复用；url 去重，与 research_entries 各自独立——手填
            -- 检索词的调研不跑文路、没有事实条目，照样该把图收进图集。
            CREATE TABLE IF NOT EXISTS research_subject_refs (
                id TEXT PRIMARY KEY,
                era TEXT NOT NULL DEFAULT '',
                subject_key TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                source_domain TEXT NOT NULL DEFAULT '',
                added_at TEXT NOT NULL,
                UNIQUE(era, subject_key, url)
            );

            -- 项目 ↔ 主体：本项目的哪张卡/哪个主题用了哪个主体。
            -- 「本项目有哪些考据」= 这张表（而不是「project_id 等于本项目的条目」）
            -- ——主体全库唯一，谁产出的不重要，用了才该出现在本项目的报告里。
            CREATE TABLE IF NOT EXISTS research_uses (
                project_id TEXT NOT NULL,
                entry_id TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (project_id, target_kind, target_key, entry_id)
            );

            -- 一次性维护任务的完成标记（迁移/回填只跑一次）
            CREATE TABLE IF NOT EXISTS ref_maintenance (
                name TEXT PRIMARY KEY,
                done_at TEXT NOT NULL
            );

            -- 考证大纲：项目级研究计划（主题 → 检索词 → 服务哪些卡）。
            -- 调研的单位是「题材/时代」不是「资产」：40 个资产共享的时代事实
            -- 只有一套，按资产各搜一遍既是浪费又会得出互相矛盾的结论。
            -- topic_key = 标题归一；主题事实的身份是 (era, topic:{topic_key}) 这个主体。
            CREATE TABLE IF NOT EXISTS research_topics (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                topic_key TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                rationale TEXT NOT NULL DEFAULT '',
                queries_json TEXT NOT NULL DEFAULT '[]',
                node_ids_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'planned',
                reused_from TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(project_id, topic_key)
            );
            DROP INDEX IF EXISTS idx_research_topics_era;
            CREATE INDEX IF NOT EXISTS idx_research_topics_project
                ON research_topics(project_id);
            """
        )
        # 已建旧表补列（新列不允许静默缺失）
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ref_candidates)").fetchall()}
        for col, ddl in (
            ("recommended", "ALTER TABLE ref_candidates ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0"),
            ("rec_reason", "ALTER TABLE ref_candidates ADD COLUMN rec_reason TEXT NOT NULL DEFAULT ''"),
            ("rec_rank", "ALTER TABLE ref_candidates ADD COLUMN rec_rank INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in cols:
                conn.execute(ddl)
        _ensure_subject_entries(conn)
        _maintain_once(conn, "subject_refs_backfill", _backfill_subject_refs)


def _maintain_once(conn: sqlite3.Connection, name: str, fn: Any) -> None:
    """一次性维护任务（迁移/回填）：跑过就记标记，不重复执行。

    回填类任务必须只跑一次——它对存量行做 INSERT OR IGNORE，每次启动重跑会把
    用户后来从主体图集里删掉的图悄悄塞回去。"""
    if conn.execute("SELECT 1 FROM ref_maintenance WHERE name = ?", (name,)).fetchone():
        return
    fn(conn)
    conn.execute(
        "INSERT OR REPLACE INTO ref_maintenance (name, done_at) VALUES (?, ?)",
        (name, _now()),
    )


def _ensure_subject_entries(conn: sqlite3.Connection) -> None:
    """把 research_entries 迁到主体模型（旧库带 asset_key 列即为未迁）。

    迁移做完库里**只有主体模型一种形态**——不留旧列的兼容读取路径：旧键
    （node:/name:）与项目内唯一性都随主体化作废，留着只会让两种归属口径并存。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(research_entries)").fetchall()}
    if "asset_key" not in cols:
        conn.executescript(_ENTRIES_DDL)
        return
    legacy = [dict(r) for r in conn.execute("SELECT * FROM research_entries").fetchall()]
    conn.execute("DROP TABLE research_entries")
    conn.executescript(_ENTRIES_DDL)
    now = _now()
    for row in _merge_legacy_entries(legacy):
        conn.execute(
            """INSERT INTO research_entries (id, project_id, subject_key, node_id,
               asset_name, asset_type, era, topic_key, body, sources_json,
               created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                row["id"],
                row["project_id"],
                row["subject_key"],
                row.get("node_id") or "",
                row.get("asset_name") or "",
                row.get("asset_type") or "",
                row["era"],
                row.get("topic_key") or "",
                row.get("body") or "",
                json.dumps(row["_sources"], ensure_ascii=False),
                row.get("created_at") or now,
                row.get("updated_at") or now,
            ),
        )
        # 每个曾经拥有该主体的项目都要补一条引用：主体归并后「本项目有哪些
        # 考据」只能靠引用表回答，不补的话旧项目的报告会整段消失
        for use in row["_uses"]:
            target_kind, target_key = _use_target(use["kind"], use["key"], use["node_id"])
            conn.execute(
                "INSERT OR IGNORE INTO research_uses"
                " (project_id, entry_id, target_kind, target_key, created_at)"
                " VALUES (?,?,?,?,?)",
                (use["project_id"], row["id"], target_kind, target_key, now),
            )


def _merge_legacy_entries(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """旧条目按 (era, 主体键) 归并：最新正文为权威，来源底账取并集，引用全留。

    归并是主体化的必然结果——同一时代同一主体过去可能在多个项目各存一行
    （谁都不会被覆盖），现在全库只有一条，必须先把冲突收敛掉。被归并掉的
    行不丢引用：每个原属项目都记一条 use，它的报告照旧看得见这套事实。"""
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        kind = "topic" if str(r.get("asset_type") or "") == "topic" else "asset"
        raw = (
            str(r.get("topic_key") or "")
            if kind == "topic"
            else _norm_name(str(r.get("asset_name") or ""))
        )
        raw = raw or _norm_name(str(r.get("asset_name") or ""))
        if not raw:
            continue  # 无名无键的旧行无法归属主体，随迁移丢弃
        era = str(r.get("era") or "").strip()
        pid = str(r.get("project_id") or "")
        skey = _subject_key(kind, raw, era, pid)
        try:
            srcs = json.loads(r.get("sources_json") or "[]")
        except Exception:  # noqa: BLE001
            srcs = []
        use = {"project_id": pid, "kind": kind, "key": raw, "node_id": str(r.get("node_id") or "")}
        slot = merged.get((era, skey))
        if slot is None:
            merged[(era, skey)] = {
                **r,
                "era": era,
                "subject_key": skey,
                "_sources": list(srcs or []),
                "_uses": [use],
            }
            continue
        if use not in slot["_uses"]:
            slot["_uses"].append(use)
        have = {str(s.get("url") or "") for s in slot["_sources"] if isinstance(s, dict)}
        for s in srcs or []:
            if isinstance(s, dict) and str(s.get("url") or "") not in have:
                slot["_sources"].append(s)
                have.add(str(s.get("url") or ""))
        if str(r.get("updated_at") or "") > str(slot.get("updated_at") or ""):
            for col in ("id", "project_id", "node_id", "asset_name", "asset_type", "topic_key", "body", "updated_at"):
                slot[col] = r.get(col) or ""
            slot["era"] = era
            slot["subject_key"] = skey
        slot["created_at"] = min(
            str(slot.get("created_at") or ""), str(r.get("created_at") or "")
        )
    return list(merged.values())


def _backfill_subject_refs(conn: sqlite3.Connection) -> None:
    """存量已采纳候选图 → 主体图集（按 era + 画布资产名归属）。

    主体图集是这次才有的表，此前采纳的图只躺在 ref_candidates 里、按节点挂——
    不回填的话，老项目的图永远进不了复用域，而它们已经花过钱搜下来了。"""
    rows = conn.execute(
        "SELECT project_id, node_id, title, source_url, source_domain, asset_url, created_at"
        " FROM ref_candidates WHERE adopted = 1 AND asset_url != ''"
    ).fetchall()
    if not rows:
        return
    cache: dict[str, tuple[dict[str, str], str]] = {}
    for r in rows:
        pid = str(r["project_id"])
        if pid not in cache:
            titles: dict[str, str] = {}
            era = ""
            try:
                c = conn.execute(
                    "SELECT nodes, meta FROM canvases WHERE project_id = ?", (pid,)
                ).fetchone()
                nodes = json.loads(c["nodes"]) if c and c["nodes"] else []
                for n in nodes if isinstance(nodes, list) else []:
                    if not isinstance(n, dict):
                        continue
                    d = n.get("data") if isinstance(n.get("data"), dict) else {}
                    title = str(d.get("title") or "").strip()
                    if title:
                        titles[str(n.get("id") or "")] = title
                if c and c["meta"]:
                    era = str((json.loads(c["meta"]) or {}).get("era") or "").strip()
            except Exception:  # noqa: BLE001 读不到就当无名，跳过该项目的图
                titles, era = {}, ""
            cache[pid] = (titles, era)
        titles, era = cache[pid]
        key = _norm_name(titles.get(str(r["node_id"]) or ""))
        if not key:
            continue
        skey = _subject_key("asset", key, era, pid)
        conn.execute(
            "INSERT OR IGNORE INTO research_subject_refs"
            " (id, era, subject_key, url, title, source_url, source_domain, added_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex[:12],
                era,
                skey,
                str(r["asset_url"]),
                str(r["title"] or ""),
                str(r["source_url"] or ""),
                str(r["source_domain"] or ""),
                str(r["created_at"] or _now()),
            ),
        )


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
        "recRank": int(r["rec_rank"] or 0),
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


# 终选完成即自动采纳的每资产张数（各出图模型参考上限最小 4，留 1 席余量）
AUTO_ADOPT_PER_NODE = 3


def auto_adopt_top(project_id: str, node_id: str, per_node: int = AUTO_ADOPT_PER_NODE) -> int:
    """按模型终选推荐（rec_rank 升序）自动采纳前 per_node 张，返回采纳数。

    只挑 recommended 且未采纳的；无推荐/已够则不动——用户手动改选优先。"""
    cands = [
        c
        for c in list_candidates(project_id, node_id)
        if c.get("recommended") and not c.get("adopted")
    ]
    cands.sort(key=lambda c: c.get("recRank") or 99)
    pick = cands[: max(1, per_node)]
    if not pick:
        return 0
    mark_adopted(project_id, node_id, [c["id"] for c in pick])
    return len(pick)


def delete_candidate(project_id: str, cid: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM ref_candidates WHERE id = ? AND project_id = ?",
            (cid, project_id),
        )
    return cur.rowcount > 0


def unadopt_candidates(
    project_id: str, node_id: str, ids: list[str]
) -> list[dict[str, Any]]:
    """取消采纳（保留候选行）：用户删掉参考卡 = 这张参考不要了。

    与「删除候选行」（delete_candidate）分开：候选仍在「找参考图」面板里，
    只是回到未采纳、不再作为出图参考、也不被对账物化成卡。重跑调研时若又
    命中同一张图会重新入库（重跑=新结果，采纳权仍在用户/终选）。"""
    clean = [str(i) for i in ids if str(i).strip()]
    if not clean or not node_id:
        return list_candidates(project_id, node_id)
    marks = ",".join("?" for _ in clean)
    with _conn() as conn:
        conn.execute(
            f"UPDATE ref_candidates SET adopted = 0 WHERE project_id = ?"
            f" AND node_id = ? AND id IN ({marks})",
            (project_id, node_id, *clean),
        )
    return list_candidates(project_id, node_id)


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------- 考证条目与报告（调研产物的服务端落点） ----------
#
# 调研产物此前只有两个去处：候选图落 ref_candidates，考据简报只活在 agent
# 进程内存的 job 字典里（重启即蒸发）。用户能看见的唯一形态是画布卡的
# data.researchBrief 与参考卡，而它的写入端全在前端轮询回调里——锚卡被平移
# 卸载、agent 从聊天发起调研（没人把 batchId 写进 refBatchJobId 锚）、agent
# 重启，任意一条发生产物就永久留在内存或 DB 行里，画布上什么都没有
# （2026-09-10 生产库实测：23 个项目 refSource 零命中、资产卡 researchBrief
# 全零，而 ref_candidates 里躺着 152 张已采纳的参考图）。
#
# 条目表就是补这个洞：简报一产出即入库，与谁发起、画布开没开、进程活没活
# 都无关；画布上的简报与报告卡是对它的呈现，打开项目对账一次即可自愈。
# era 是跨项目复用的作用域键——同一时代、同一资产的形制事实可以复用；
# era 为空一律不复用（宁可重搜，不可错用年代）。

ENTRY_LOOKUP_LIMIT = 3  # 库检索单次最多返回几条（主体全库唯一，留余量给同名前缀场景）


def _norm_name(name: str) -> str:
    """资产名归一（去空白与常见标点、小写）：跨项目命中按它比，空格标点差异不漏命中。"""
    return re.sub(r"[\s·、,，.。()（）\[\]【】\-—_/]+", "", str(name or "").lower())


def _subject_key(kind: str, key: str, era: str, project_id: str) -> str:
    """主体键：`asset:{名归一}` / `topic:{主题键}`；era 为空时加 `local:{项目}:` 前缀。

    era 空不是错误状态——它表示这个主体**只在项目内成立**（用户跳过年代询问、
    或题材就是架空），给它一个项目私有键，既不会污染复用域，也不会和别的项目
    撞成一条。分 kind 前缀同时消除了旧模型里「主题条目与资产条目共用一列键、
    同名互相覆盖」的隐患。"""
    key = str(key or "").strip()
    if not key:
        raise ValueError("主体键不能为空")
    scope = "" if str(era or "").strip() else f"local:{project_id}:"
    return f"{scope}{kind}:{key}"


def asset_subject(era: str, project_id: str, asset_name: str) -> str:
    """资产主体的键（era + 资产名归一）。"""
    return _subject_key("asset", _norm_name(asset_name), era, project_id)


def topic_subject(era: str, project_id: str, topic_key: str) -> str:
    """主题主体的键（era + 主题键）。"""
    return _subject_key("topic", str(topic_key or "").strip(), era, project_id)


def _use_target(kind: str, key: str, node_id: str) -> tuple[str, str]:
    """引用目标：主题挂主题键，资产优先挂节点 id（改名不失联），无 id 退按名。"""
    if kind == "topic":
        return "topic", key
    nid = str(node_id or "").strip()
    return ("node", nid) if nid else ("name", key)


def record_use(
    project_id: str, entry_id: str, kind: str, key: str, node_id: str = ""
) -> None:
    """记一条「本项目用了这个主体」（幂等）。

    主体是全库共享的，谁产出的不重要——「本项目有哪些考据」这个问题的答案
    只能是这张引用表：项目引用了它，它就该出现在本项目的报告与出图提示词里。"""
    if not project_id or not entry_id:
        return
    target_kind, target_key = _use_target(kind, key, node_id)
    with _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO research_uses"
            " (project_id, entry_id, target_kind, target_key, created_at)"
            " VALUES (?,?,?,?,?)",
            (project_id, entry_id, target_kind, target_key, _now()),
        )


def upsert_entry(
    project_id: str,
    *,
    body: str,
    node_id: str = "",
    asset_name: str = "",
    asset_type: str = "",
    era: str = "",
    topic_key: str = "",
    sources: list[dict[str, Any]] | None = None,
) -> str:
    """写入/覆盖一个**主体**的事实，并记下本项目的引用，返回条目 id。

    重跑语义：同主体再次调研覆盖旧事实（与候选「重跑清掉旧未采纳」同口径）。
    因为主体全库唯一，覆盖是**跨项目生效**的——这也是活引用的对称面：引用方
    读的是源主体的最新版，源主体被谁改进都算改进。归属键取 kind（主题/资产）
    + 归一名字，era 空则落项目私有的 local 键。"""
    body = str(body or "").strip()
    if not project_id or not body:
        raise ValueError("考据条目需要 project_id 与正文")
    kind = "topic" if str(asset_type or "") == "topic" or str(topic_key or "").strip() else "asset"
    key = str(topic_key or "").strip() if kind == "topic" else _norm_name(asset_name)
    if not key:
        raise ValueError("考据条目需要可归属的主体名字")
    skey = _subject_key(kind, key, era, project_id)
    now = _now()
    src = json.dumps(sources or [], ensure_ascii=False)
    era = str(era or "").strip()
    with _conn() as conn:
        row = conn.execute(
            "SELECT id FROM research_entries WHERE era = ? AND subject_key = ?",
            (era, skey),
        ).fetchone()
        if row:
            eid = str(row["id"])
            conn.execute(
                """
                UPDATE research_entries SET project_id=?, node_id=?, asset_name=?,
                    asset_type=?, topic_key=?, body=?, sources_json=?, updated_at=?
                WHERE id=?
                """,
                (
                    project_id,
                    str(node_id or ""),
                    str(asset_name or ""),
                    str(asset_type or ""),
                    str(topic_key or ""),
                    body,
                    src,
                    now,
                    eid,
                ),
            )
        else:
            eid = uuid.uuid4().hex[:12]
            conn.execute(
                """
                INSERT INTO research_entries (id, project_id, subject_key, node_id,
                    asset_name, asset_type, era, topic_key, body, sources_json,
                    created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    eid,
                    project_id,
                    skey,
                    str(node_id or ""),
                    str(asset_name or ""),
                    str(asset_type or ""),
                    era,
                    str(topic_key or ""),
                    body,
                    src,
                    now,
                    now,
                ),
            )
    record_use(project_id, eid, kind, key, node_id)
    return eid


def _entry_row(r: sqlite3.Row) -> dict[str, Any]:
    try:
        sources = json.loads(r["sources_json"] or "[]")
    except Exception:  # noqa: BLE001
        sources = []
    return {
        "id": r["id"],
        "projectId": r["project_id"],
        "subjectKey": r["subject_key"],
        "nodeId": r["node_id"],
        "assetName": r["asset_name"],
        "assetType": r["asset_type"],
        "era": r["era"],
        "topicKey": r["topic_key"],
        "body": r["body"],
        "sources": sources if isinstance(sources, list) else [],
        "updatedAt": r["updated_at"],
    }


def list_entries(project_id: str) -> list[dict[str, Any]]:
    """本项目引用的主体（含本项目自己产出、以及从库里引用/命中的）。

    读的是引用表而不是「project_id = 本项目」：主体全库唯一，一个主体可能由
    别的项目产出、本项目引用——活引用下正文每次从主体读，永远是最新版。"""
    if not project_id:
        return []
    with _conn() as conn:
        rows = conn.execute(
            "SELECT e.* FROM research_entries e"
            " JOIN research_uses u ON u.entry_id = e.id"
            " WHERE u.project_id = ? GROUP BY e.id ORDER BY e.updated_at",
            (project_id,),
        ).fetchall()
    return [_entry_row(r) for r in rows]


def used_entry(project_id: str, kind: str, key: str) -> dict[str, Any] | None:
    """本项目在该目标上引用的主体（主题的执行产物、资产自己的考据都走它）。"""
    if not project_id:
        return None
    with _conn() as conn:
        row = conn.execute(
            "SELECT e.* FROM research_entries e"
            " JOIN research_uses u ON u.entry_id = e.id"
            " WHERE u.project_id = ? AND u.target_kind = ? AND u.target_key = ?"
            " ORDER BY e.updated_at DESC LIMIT 1",
            (project_id, str(kind), str(key)),
        ).fetchone()
    return _entry_row(row) if row else None


def lookup_subject(era: str, kind: str, key: str) -> dict[str, Any] | None:
    """库检索：同 era 同主体的权威事实（不管哪个项目产出）。

    严格相等——名字像而不同的主体（「朝服」vs「冯太后朝服」）不命中，宁可重搜，
    不可把另一个形制的事实塞给出图。era 为空直接落空（无作用域即不进库）。"""
    era = str(era or "").strip()
    key = str(key or "").strip()
    if not era or not key:
        return None
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM research_entries WHERE era = ? AND subject_key = ?",
            (era, f"{kind}:{key}"),
        ).fetchone()
    return _entry_row(row) if row else None


def list_library(era: str, project_id: str = "") -> list[dict[str, Any]]:
    """列出某 era 下全库可复用的主体：事实 + 图集张数 + 出处项目 + 本项目是否已引用。

    这是「复用」的读面——此前只有一个要求报出确切名字的索引抽屉（撞名才命中），
    没有图书馆。era 为空返回空：不设年代的项目，主体键全是 local: 前缀，既没有
    可复用的东西，它的产物也不会被别人复用。"""
    era = str(era or "").strip()
    if not era:
        return []
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM research_entries WHERE era = ? ORDER BY updated_at DESC",
            (era,),
        ).fetchall()
        used: set[str] = set()
        if project_id:
            used = {
                str(r[0])
                for r in conn.execute(
                    "SELECT entry_id FROM research_uses WHERE project_id = ?",
                    (project_id,),
                )
            }
        counts = {
            str(r["subject_key"]): int(r["n"])
            for r in conn.execute(
                "SELECT subject_key, COUNT(*) AS n FROM research_subject_refs"
                " WHERE era = ? GROUP BY subject_key",
                (era,),
            )
        }
    names: dict[str, str] = {}
    out: list[dict[str, Any]] = []
    for r in rows:
        e = _entry_row(r)
        pid = str(e.get("projectId") or "")
        if pid and pid not in names:
            names[pid] = _project_scope(pid)[0]
        out.append(
            {
                "id": e["id"],
                "subjectKey": e["subjectKey"],
                "assetName": e["assetName"],
                "assetType": e["assetType"],
                "topicKey": e["topicKey"],
                "kind": "topic" if str(e.get("assetType")) == "topic" else "asset",
                "body": e["body"],
                "sources": e["sources"],
                "refCount": counts.get(e["subjectKey"], 0),
                "fromProjectId": pid,
                "fromProject": names.get(pid, ""),
                "used": e["id"] in used,
                "updatedAt": e["updatedAt"],
            }
        )
    return out


def get_entry(entry_id: str) -> dict[str, Any] | None:
    """按 id 取主体（导入端点用：前端只传 id，正文不可被改写）。"""
    if not str(entry_id or "").strip():
        return None
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM research_entries WHERE id = ?", (str(entry_id),)
        ).fetchone()
    return _entry_row(row) if row else None


# ---------- 主体图集（调研采纳的参考图，按主体归档、跨项目复用） ----------


def add_subject_refs(
    era: str, subject_key: str, rows: list[dict[str, Any]]
) -> int:
    """把采纳的参考图收进主体图集（url 去重），返回新增条数。

    图与事实各自独立：手填检索词的调研不跑文路、没有事实条目，图照样该入库。"""
    items = [
        {
            "url": str(r.get("assetUrl") or r.get("asset_url") or r.get("url") or "").strip(),
            "title": str(r.get("title") or "")[:120],
            "sourceUrl": str(r.get("sourceUrl") or r.get("source_url") or ""),
            "sourceDomain": str(r.get("sourceDomain") or r.get("source_domain") or ""),
        }
        for r in rows
        if str(r.get("assetUrl") or r.get("asset_url") or r.get("url") or "").strip()
    ]
    if not items:
        return 0
    now = _now()
    added = 0
    with _conn() as conn:
        for it in items:
            cur = conn.execute(
                "INSERT OR IGNORE INTO research_subject_refs"
                " (id, era, subject_key, url, title, source_url, source_domain, added_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:12],
                    str(era or "").strip(),
                    subject_key,
                    it["url"],
                    it["title"],
                    it["sourceUrl"],
                    it["sourceDomain"],
                    now,
                ),
            )
            added += cur.rowcount or 0
    return added


def subject_refs(subject_keys: list[str], era: str) -> dict[str, list[dict[str, Any]]]:
    """主体图集批量取：{主体键 → [{url,title,sourceUrl,sourceDomain}…]}（按入库序）。"""
    keys = [k for k in dict.fromkeys(str(k or "") for k in subject_keys) if k]
    if not keys:
        return {}
    marks = ",".join("?" for _ in keys)
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM research_subject_refs WHERE era = ?"
            f" AND subject_key IN ({marks}) ORDER BY added_at",
            (str(era or "").strip(), *keys),
        ).fetchall()
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(str(r["subject_key"]), []).append(
            {
                "url": str(r["url"]),
                "title": str(r["title"]),
                "sourceUrl": str(r["source_url"]),
                "sourceDomain": str(r["source_domain"]),
            }
        )
    return out


def _project_scope(project_id: str) -> tuple[str, str]:
    """项目名与时代口径（projects.name + canvases.meta.era）。读不到给空串。"""
    if not project_id:
        return "", ""
    try:
        db = sqlite3.connect(str(DB_PATH))
        db.row_factory = sqlite3.Row
        try:
            p = db.execute(
                "SELECT name FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            c = db.execute(
                "SELECT meta FROM canvases WHERE project_id = ?", (project_id,)
            ).fetchone()
        finally:
            db.close()
    except Exception:  # noqa: BLE001 读不到就空口径，不拦报告
        return "", ""
    name = str(p["name"]) if p else ""
    era = ""
    if c and c["meta"]:
        try:
            era = str((json.loads(c["meta"]) or {}).get("era") or "").strip()
        except Exception:  # noqa: BLE001
            era = ""
    return name, era


# 画布资产卡型（报告里「待补考据」与资产覆盖面按它统计）
_ASSET_NODE_TYPES = ("character", "scene", "prop", "costume")


def canvas_assets(project_id: str) -> list[dict[str, str]]:
    """项目画布上的资产卡清单：[{nodeId, title, nodeType}]（空名卡不进——未命名
    资产既不在 @ 名单里也不该进报告）。"""
    if not project_id:
        return []
    try:
        db = sqlite3.connect(str(DB_PATH))
        try:
            row = db.execute(
                "SELECT nodes FROM canvases WHERE project_id = ?", (project_id,)
            ).fetchone()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        return []
    nodes = json.loads(row[0]) if row and row[0] else []
    out: list[dict[str, str]] = []
    for n in nodes if isinstance(nodes, list) else []:
        if not isinstance(n, dict):
            continue
        data = n.get("data") if isinstance(n.get("data"), dict) else {}
        nt = str(data.get("nodeType") or "")
        title = str(data.get("title") or "").strip()
        if nt not in _ASSET_NODE_TYPES or not title:
            continue
        out.append({"nodeId": str(n.get("id") or ""), "title": title, "nodeType": nt})
    return out


def adopted_by_node(project_id: str) -> dict[str, list[dict[str, Any]]]:
    """已采纳候选按节点分组（报告底账 + 前端对账物化用）。"""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT * FROM ref_candidates WHERE project_id = ? AND adopted = 1
               ORDER BY node_id, rec_rank""",
            (project_id,),
        ).fetchall()
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["node_id"], []).append(_to_dict(r))
    return out


_TYPE_LABELS = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
    "costume": "服饰",
}

_REPORT_ADOPT_SAMPLE = 5  # 参考图底账每资产列几条（全量在找参考图面板）

# 报告分节序数（段数随有无考证大纲浮动，所以按序号取而不是写死）
_CN_NUM = ("", "一", "二", "三", "四", "五", "六")


def build_report(project_id: str) -> dict[str, Any]:
    """拼一份项目考证报告：考证大纲 + 条目（按资产）+ 参考图底账 + 待补清单。

    文本是「全貌索引」——一眼看全这个项目现在基于什么事实在做、计划到哪一步、
    还缺哪些。主题条目（asset_type=topic）归大纲段，不混进资产段。"""
    project_name, era = _project_scope(project_id)
    entries = list_entries(project_id)
    asset_entries = [e for e in entries if e["assetType"] != "topic"]
    by_node = {e["nodeId"]: e for e in asset_entries if e["nodeId"]}
    by_name = {_norm_name(e["assetName"]): e for e in asset_entries if e["assetName"]}
    assets = canvas_assets(project_id)
    adopted = adopted_by_node(project_id)
    outline = build_outline(project_id)
    t_by_node, t_by_name = topic_briefs(project_id)
    # 主体图集：本项目的每个主体（资产/主题）名下累积了多少张可复用参考图。
    # 图与事实各自独立归档在主体上，所以这里按主体取、不按画布节点取。
    album: dict[str, list[dict[str, Any]]] = {}
    try:
        by_era: dict[str, list[str]] = {}
        for e in entries:
            by_era.setdefault(str(e.get("era") or ""), []).append(str(e.get("subjectKey") or ""))
        for e_era, keys in by_era.items():
            album.update(subject_refs(keys, e_era))
    except Exception as exc:  # noqa: BLE001 图集读不到不影响报告主体
        print(f"[图集] 读取失败 {project_id}：{exc}", flush=True)
    producer_names: dict[str, str] = {}

    def _source_of(e: dict[str, Any]) -> str:
        """主体事实的来源标注：别的项目产出的写「复用自《X》」，本项目产出的留空。"""
        pid = str(e.get("projectId") or "")
        if not pid or pid == project_id:
            return ""
        if pid not in producer_names:
            producer_names[pid] = _project_scope(pid)[0] or "同题材项目"
        return producer_names[pid]

    def _topics_for(node_id: str, title: str) -> list[list[str]]:
        """服务该卡的考据主题（先按节点 id，再按资产名——名是各路径都有的键）。"""
        return t_by_node.get(node_id) or t_by_name.get(title) or []

    covered: list[dict[str, Any]] = []
    missing: list[dict[str, str]] = []
    for a in assets:
        e = by_node.get(a["nodeId"]) or by_name.get(_norm_name(a["title"]))
        # 被主题覆盖也算「已有考据」：主题考据是时代共有事实，对成员资产同样成立
        # （不这么算的话，被主题覆盖的卡会一直挂在「待补」里催用户做已经做过的事）
        topics_for = _topics_for(a["nodeId"], a["title"])
        if e or topics_for:
            covered.append({**a, "entry": e, "topics": [t[0] for t in topics_for]})
        else:
            missing.append(a)
    # 卡已不在画布上但条目还在（改名/删卡）：仍列出，条目不因卡没了就消失
    on_canvas = {a["nodeId"] for a in assets}
    for e in asset_entries:
        if e["nodeId"] and e["nodeId"] not in on_canvas:
            covered.append(
                {
                    "nodeId": e["nodeId"],
                    "title": e["assetName"] or "未命名资产",
                    "nodeType": e["assetType"],
                    "entry": e,
                    "orphan": True,
                }
            )

    # 待补分级（两个方向的口径事故都吃过，2026-09-11 定死）：
    # ①「已有考据 1 · 待补 70」把 52 个参考图调研成功的资产也计成待补（冯太后）——
    #    那是文字简报 2026-09-10 才落库、旧调研的简报没存档；
    # ②反向盲区（091101 武则天项目）：52 张卡文字考据全到、参考图一张没有，
    #    旧口径（无参考图 **且** 无考据）把「有文无图」整类漏掉——头部显示
    #    「覆盖 0 个 ｜ 缺参考图待补 0 个」，自相矛盾，恢复入口也不出现。
    # 口径定死：**待补 = 没有已采纳参考图的资产**（这张报告的轴是参考图，文案
    # 写着「缺参考图待补」就该这么算），文字考据只作行内标注——「覆盖 + 待补
    # = 资产数」算术自洽。文字维度的缺口（有参考图、无文字考据）单列次级说明：
    # 重跑整轮调研救不了它，该走考证大纲或出图时自动补考据。
    missing_ids = {m["nodeId"] for m in missing}
    pending_refs = [a for a in assets if not adopted.get(a["nodeId"])]
    # 头部「覆盖 M 个」只数画布上的资产：adopted 里可能有「卡已删、候选仍
    # 采纳着」的孤儿节点（底账段也只列画布资产）——算进去会让
    # 「覆盖 + 待补 = 资产数」的算术对不上，又成一处口径不一致
    covered_refs = [a for a in assets if adopted.get(a["nodeId"])]
    missing_refs_only = [m for m in missing if adopted.get(m["nodeId"])]
    # 张数与「覆盖 M 个」同口径（只数画布资产）：底账段也是逐个画布资产列的，
    # 把孤儿行的张数算进总数就成了「说 5 张、只列 4 张」的口径不一致
    ref_total = sum(len(adopted.get(a["nodeId"]) or []) for a in assets)
    # 最近一次批量调研的逐项错误（jobstore 镜像）：待补行带上「上次失败」
    # 让用户分得清「无结果（该换词）」和「下载 403（重试能救）」
    last_errors: dict[str, str] = {}
    for mirror in jobstore.latest_states("ref_batch"):
        if mirror.get("projectId") != project_id:
            continue
        for it in mirror.get("items") or []:
            if it.get("status") == "error" and it.get("nodeId"):
                last_errors.setdefault(str(it["nodeId"]), str(it.get("error") or ""))
        break

    lines: list[str] = [f"《{project_name or '未命名项目'}》资产考证报告"]
    if era:
        lines.append(f"时代/题材：{era}")
    # 文字考据口径 = 画布上有考据的资产数（孤儿条目单列在考据事实段，不进头部
    # ——「资产 5 · 文字考据 4」的算术对不上会让人怀疑口径）
    covered_on_canvas = [c for c in covered if not c.get("orphan")]
    reused_count = len([e for e in asset_entries if _source_of(e)])
    lines.append(
        f"资产 {len(assets)} 个 ｜ 参考图已采纳 {ref_total} 张、覆盖"
        f" {len(covered_refs)} 个 ｜ 文字考据 {len(covered_on_canvas)} 个 ｜ 缺参考图待补"
        f" {len(pending_refs)} 个"
    )
    if reused_count or album:
        album_total = sum(len(v) for v in album.values())
        bits = []
        if reused_count:
            bits.append(f"复用同题材考据 {reused_count} 条")
        if album_total:
            bits.append(f"主体图集 {album_total} 张可跨项目复用")
        lines.append(" · ".join(bits))
    lines.append(f"生成于 {_now()[:16].replace('T', ' ')}")

    sec = 0
    if outline["topics"]:
        sec += 1
        lines.append("")
        lines.append(
            f"{_CN_NUM[sec]}、考证大纲（{len(outline['topics'])} 个主题"
            f" · 已完成 {outline['done_count']}）"
        )
        lines.extend(outline["lines"])

    sec += 1
    lines.append("")
    lines.append(f"{_CN_NUM[sec]}、考据事实")
    if not covered:
        lines.append("（暂无——在资产卡「找参考图」发起调研后，考据会自动汇总到这里）")
    for c in covered:
        e = c["entry"]
        kind = str(e["assetType"]) if e else str(c["nodeType"])
        label = _TYPE_LABELS.get(kind, kind)
        gone = "（画布上已无此卡）" if c.get("orphan") else ""
        lines.append("")
        lines.append(f"■ {c['title']}（{label or '资产'}）{gone}")
        if e:
            src = _source_of(e)
            if src:
                lines.append(f"（复用自《{src}》同题材考据——本项目未重搜，源更新此处跟着变）")
            lines.append(str(e["body"]).strip())
            doms = [
                str(s.get("domain") or _domain(str(s.get("url") or "")))
                for s in e["sources"]
                if isinstance(s, dict)
            ]
            doms = [d for d in doms if d]
            if doms:
                seen: list[str] = []
                for d in doms:
                    if d not in seen:
                        seen.append(d)
                lines.append("—— 来源：" + "、".join(seen[:6]))
            n_album = len(album.get(str(e.get("subjectKey") or ""), []))
            if n_album:
                lines.append(f"—— 参考图集：{n_album} 张（同题材项目可直接复用）")
        for ttitle, _tbody in _topics_for(c["nodeId"], c["title"]):
            lines.append(f"＋主题考据〈{ttitle}〉（全文见考证大纲）")

    sec += 1
    lines.append("")
    lines.append(
        f"{_CN_NUM[sec]}、参考图底账（已采纳 {ref_total} 张）"
    )
    if not adopted:
        lines.append("（暂无已采纳的参考图）")
    for a in assets:
        rows = adopted.get(a["nodeId"]) or []
        if not rows:
            continue
        doms = []
        for r in rows:
            d = str(r.get("sourceDomain") or "") or _domain(str(r.get("sourceUrl") or ""))
            if d and d not in doms:
                doms.append(d)
        sample = rows[:_REPORT_ADOPT_SAMPLE]
        titles = "；".join(str(r.get("title") or "参考图")[:24] for r in sample)
        more = f" 等 {len(rows)} 张" if len(rows) > len(sample) else ""
        lines.append(f"■ {a['title']}（{len(rows)} 张）")
        lines.append(f"  {titles}{more}")
        if doms:
            lines.append(f"  来源域名：{'、'.join(doms[:6])}")

    sec += 1
    lines.append("")
    lines.append(f"{_CN_NUM[sec]}、待补清单（缺参考图 {len(pending_refs)} 个资产）")
    if not pending_refs:
        lines.append("（画布资产的参考图已齐）")
    for m in pending_refs:
        label = _TYPE_LABELS.get(m["nodeType"], m["nodeType"])
        marks: list[str] = []
        # 有文字考据只缺图：行内标注，别让人以为连考据都没做（091101 的形态）
        if m["nodeId"] not in missing_ids:
            marks.append("已有文字考据，只缺参考图")
        err = last_errors.get(m["nodeId"], "")
        if err:
            marks.append(f"上次失败：{err[:60]}")
        suffix = f"——{'；'.join(marks)}" if marks else ""
        lines.append(f"· {m['title']}（{label}）{suffix}")
    if missing_refs_only:
        names = "、".join(m["title"] for m in missing_refs_only[:20])
        more = f" 等 {len(missing_refs_only)} 个" if len(missing_refs_only) > 20 else ""
        lines.append("")
        lines.append(
            f"另有 {len(missing_refs_only)} 个资产参考图已采纳、文字考据未存档"
            f"（早期调研的简报未落库）：{names}{more}"
        )
        lines.append(
            "（这些不用重跑调研：在「考证大纲」卡执行主题可按主题补齐文字考据，出图时也会自动补考据）"
        )

    # 卡面简报 = 本资产条目 + 服务它的主题条目。出图注入的是同一个合成结果
    # （skills._inject_research_briefs），所以「卡上显示的」=「出图发出去的」
    card_briefs: dict[str, str] = {}
    for a in assets:
        e = by_node.get(a["nodeId"]) or by_name.get(_norm_name(a["title"]))
        parts: list[str] = []
        if e:
            parts.append(str(e["body"]).strip())
        for ttitle, tbody in _topics_for(a["nodeId"], a["title"]):
            parts.append(f"〈{ttitle}〉{tbody}")
        if parts:
            card_briefs[a["nodeId"]] = "；".join(p for p in parts if p)
    for e in asset_entries:
        if e["nodeId"] and e["nodeId"] not in on_canvas and str(e["body"]).strip():
            card_briefs.setdefault(e["nodeId"], str(e["body"]).strip())

    return {
        "projectId": project_id,
        "projectName": project_name,
        "era": era,
        "entries": entries,
        "missing": missing,
        # 真待办（缺参考图的资产，报告卡「补调研 N」按钮的工作清单）——
        # 含「已有文字考据、只缺参考图」的一类（091101 盲区：图路没跑过，
        # 补调研正是缺的那一步）；missing 里剩下的（有参考图、无文字考据）
        # 不进这里——重跑调研不产文字，走考证大纲或出图时自动补考据
        "pendingAssets": [
            {"nodeId": m["nodeId"], "name": m["title"], "type": m["nodeType"]}
            for m in pending_refs
        ],
        "adopted": [{"nodeId": k, "candidates": v} for k, v in adopted.items()],
        "outline": outline["topics"],
        "cardBriefs": card_briefs,
        # 主体图集张数（主体键 → 张数）：报告卡头部与「同题材可复用」入口的数据源
        "album": {k: len(v) for k, v in album.items()},
        "text": "\n".join(lines),
        "generatedAt": _now(),
    }


# ---------- 考证大纲（项目级研究计划：主题 → 检索词 → 服务哪些卡） ----------
#
# 调研计划不是「一个资产一次调研」的延长线，而是换主语：主题/时代才是单位，
# 资产是成果的消费者。三类重叠事实里影响面最大的那类（时代共有事实：服制、
# 发式、宫室形制）不属于任何单个资产——旧流程只有「资产」这个单位，无主的
# 事实就没人做；大纲的作用正是给无主的事实安一个主，并按「服务多少张卡」
# 排资源（影响 6 张卡的服制和影响 1 张的漆器不该花一样的时间）。

TOPIC_STATUS = ("planned", "running", "done", "reused", "error")# 大纲规模闸门：一个项目 40 个资产也不该铺出 50 个主题（人审不动 = 不审）
MAX_TOPICS = 24
# 主题执行并发（Serper 号池限速，与补考据同档）
TOPIC_CONCURRENCY = 4


def _topic_row(r: sqlite3.Row) -> dict[str, Any]:
    def _load(col: str) -> list[Any]:
        try:
            v = json.loads(r[col] or "[]")
        except Exception:  # noqa: BLE001
            return []
        return v if isinstance(v, list) else []

    return {
        "id": r["id"],
        "topicKey": r["topic_key"],
        "title": r["title"],
        "rationale": r["rationale"],
        "queries": [str(q) for q in _load("queries_json")],
        "nodeIds": [str(n) for n in _load("node_ids_json")],
        "status": r["status"],
        "reusedFrom": r["reused_from"],
        "error": r["error"],
        "updatedAt": r["updated_at"],
    }


def list_topics(project_id: str) -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM research_topics WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()
    return [_topic_row(r) for r in rows]


def replace_topics(project_id: str, topics: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """整份替换项目考证大纲。

    整份替换而非增量合并：大纲是「这个项目打算怎么考据」的一份判断，增量叠加
    会攒出互相矛盾的多版计划、没人知道当前生效的是哪版。删掉的主题若已有考据
    条目，条目本身保留（那是事实，不随计划取消而失效），只摘掉主题归属。

    节点 id 校验照 research_asset_references 的防幻觉口径：不在画布上的 id
    报错并列出可用卡清单（模型下一轮能自纠），不静默丢弃。"""
    project_id = str(project_id or "").strip()
    if not project_id:
        raise ValueError("缺少 project_id")
    if not topics:
        raise ValueError("考证大纲不能为空（没有要考据的题材就先别建大纲）")
    if len(topics) > MAX_TOPICS:
        raise ValueError(f"主题数上限 {MAX_TOPICS}（当前 {len(topics)}）——大纲是给人审的，铺太多等于没审")
    assets = {a["nodeId"]: a for a in canvas_assets(project_id)}
    known = "、".join(f"{a['title']}({a['nodeId']})" for a in assets.values()) or "（画布上没有资产卡）"

    clean: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for t in topics:
        if not isinstance(t, dict):
            raise ValueError("主题必须是对象")
        title = str(t.get("title") or "").strip()
        if not title:
            raise ValueError("主题缺少 title")
        key = _norm_name(title)[:60]
        if not key:
            raise ValueError(f"主题「{title}」标题无法归一成键")
        if key in seen_keys:
            raise ValueError(f"主题键重复：「{title}」——同一件事写两遍会得出两套考据")
        seen_keys.add(key)
        queries = [str(q).strip() for q in (t.get("queries") or []) if str(q).strip()]
        node_ids: list[str] = []
        for raw in t.get("nodeIds") or []:
            nid = str(raw).strip()
            if not nid:
                continue
            if nid not in assets:
                raise ValueError(
                    f"主题「{title}」引用了画布上不存在的卡片 id：{nid}。"
                    f"可用资产卡：{known}。修正 nodeIds 后原样重发。"
                )
            if nid not in node_ids:
                node_ids.append(nid)
        clean.append(
            {
                "topic_key": key,
                "title": title[:60],
                "rationale": str(t.get("rationale") or "").strip()[:400],
                "queries": queries[:4],
                "node_ids": node_ids,
            }
        )

    now = _now()
    with _conn() as conn:
        keep = [c["topic_key"] for c in clean]
        # 摘掉被移出大纲的主题归属（条目保留——事实不随计划取消而失效）
        marks = ",".join("?" for _ in keep)
        conn.execute(
            f"DELETE FROM research_topics WHERE project_id = ? AND topic_key NOT IN ({marks})",
            (project_id, *keep),
        )
        conn.execute(
            f"UPDATE research_entries SET topic_key = '' WHERE project_id = ?"
            f" AND topic_key != '' AND topic_key NOT IN ({marks})",
            (project_id, *keep),
        )
        for c in clean:
            row = conn.execute(
                "SELECT id, status, reused_from FROM research_topics"
                " WHERE project_id = ? AND topic_key = ?",
                (project_id, c["topic_key"]),
            ).fetchone()
            payload = (
                c["title"],
                c["rationale"],
                json.dumps(c["queries"], ensure_ascii=False),
                json.dumps(c["node_ids"], ensure_ascii=False),
                now,
            )
            if row:
                # 计划调整不清成果：已完成/复用状态与出处留着，重跑由调用方显式发起
                conn.execute(
                    """UPDATE research_topics SET title=?, rationale=?, queries_json=?,
                       node_ids_json=?, updated_at=? WHERE id=?""",
                    (*payload, row["id"]),
                )
            else:
                conn.execute(
                    """INSERT INTO research_topics (id, project_id, topic_key, title,
                       rationale, queries_json, node_ids_json, status, reused_from,
                       error, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,'planned','','',?,?)""",
                    (
                        uuid.uuid4().hex[:12],
                        project_id,
                        c["topic_key"],
                        *payload,
                        now,
                    ),
                )
    return list_topics(project_id)


def _topic_status(project_id: str, topic_key: str, status: str, **fields: Any) -> None:
    sets = ["status = ?", "updated_at = ?"]
    vals: list[Any] = [status, _now()]
    for col, val in fields.items():
        sets.append(f"{col} = ?")
        vals.append(val)
    vals.extend([project_id, topic_key])
    with _conn() as conn:
        conn.execute(
            f"UPDATE research_topics SET {', '.join(sets)}"
            " WHERE project_id = ? AND topic_key = ?",
            tuple(vals),
        )


def topic_entry(project_id: str, topic_key: str) -> dict[str, Any] | None:
    """本项目该主题引用的主体（主题执行产物，或从库里引用/命中的）。"""
    return used_entry(project_id, "topic", topic_key)


def build_outline_report(project_id: str) -> dict[str, Any]:
    """大纲的人读视图：主题 + 正文（落大纲卡）+ 覆盖统计 + 未被覆盖的资产。

    「未被任何主题覆盖的资产」是大纲段最有用的输出——盘点缺口用：既可能是
    该单独立主题的资产，也可能是并进已有主题就行。"""
    project_name, era = _project_scope(project_id)
    # 大纲卡是计划与进度板，不含事实正文（事实归报告卡，两边不重复）
    outline = build_outline(project_id, with_facts=False)
    assets = canvas_assets(project_id)
    covered = set(outline["coveredNodeIds"])
    uncovered = [a for a in assets if a["nodeId"] not in covered]

    lines: list[str] = [f"《{project_name or '未命名项目'}》考证大纲"]
    if era:
        lines.append(f"时代/题材：{era}")
    lines.append(
        f"主题 {len(outline['topics'])} 个 · 已完成 {outline['done_count']}"
        f" · 资产 {len(assets)} 个（未被主题覆盖 {len(uncovered)} 个）"
    )
    lines.append(f"生成于 {_now()[:16].replace('T', ' ')}")
    lines.extend(outline["lines"])
    if uncovered:
        lines.append("")
        lines.append("未被任何主题覆盖的资产（单独立主题，或并进已有主题）：")
        for a in uncovered:
            lines.append(f"· {a['title']}（{_TYPE_LABELS.get(a['nodeType'], a['nodeType'])}）")

    return {
        "projectId": project_id,
        "projectName": project_name,
        "era": era,
        "topics": outline["topics"],
        "uncovered": uncovered,
        "assetCount": len(assets),
        "doneCount": outline["done_count"],
        "text": "\n".join(lines),
        "generatedAt": _now(),
    }


def topic_briefs(
    project_id: str,
) -> tuple[dict[str, list[list[str]]], dict[str, list[list[str]]]]:
    """主题考据按资产分发的索引：(按节点 id, 按资产名) → [[主题名, 事实], …]。

    主题条目是「时代共有事实」，一个主题服务多张卡——出图与卡面展示都按主题的
    服务范围分发到成员资产。主题事实的身份是主体（era + topic:键）：本项目
    引用它（自己产出或从库里命中）就分发；引用是活引用不是拷贝，主体被谁改进
    这里都跟着变。"""
    empty: tuple[dict[str, list[list[str]]], dict[str, list[list[str]]]] = ({}, {})
    if not project_id:
        return empty
    topics = list_topics(project_id)
    if not topics:
        return empty
    titles = {a["nodeId"]: a["title"] for a in canvas_assets(project_id)}
    by_node: dict[str, list[list[str]]] = {}
    by_name: dict[str, list[list[str]]] = {}
    for t in topics:
        entry = topic_entry(project_id, t["topicKey"])
        if not entry:
            continue
        body = str(entry.get("body") or "").strip()
        if not body:
            continue
        item = [t["title"], body]
        for nid in t["nodeIds"]:
            by_node.setdefault(nid, []).append(item)
            title = titles.get(nid)
            if title:
                by_name.setdefault(title, []).append(item)
    return by_node, by_name


def build_outline(project_id: str, with_facts: bool = True) -> dict[str, Any]:
    """大纲视图：每个主题的检索词、服务哪些卡、状态、（可选）已考据的事实与出处。

    「服务哪些卡」是大纲最有信息量的一列——它把复用关系显式化了：一眼看出
    这个主题值不值得做（服务 6 张 vs 1 张），也就能按影响面排资源。

    with_facts=False 给大纲卡（计划与进度板，不含事实正文——事实归报告卡，
    两边都不重复）。"""
    _, era = _project_scope(project_id)
    assets = {a["nodeId"]: a for a in canvas_assets(project_id)}
    topics_out: list[dict[str, Any]] = []
    lines: list[str] = []
    covered_nodes: list[str] = []
    done = 0
    produced_by: dict[str, str] = {}
    # 主题图集张数（一次批量取）：大纲卡上「这个主题除了文字还有几张实物参考」
    all_topics = list_topics(project_id)
    topic_albums = subject_refs(
        [topic_subject(era, project_id, t["topicKey"]) for t in all_topics], era
    )

    def _produced_by(pid: str) -> str:
        if pid not in produced_by:
            produced_by[pid] = _project_scope(pid)[0] or "同题材项目"
        return produced_by[pid]

    for t in all_topics:
        entry = topic_entry(project_id, t["topicKey"])
        if entry:
            done += 1
        serves = [
            {"nodeId": nid, "title": assets[nid]["title"]}
            for nid in t["nodeIds"]
            if nid in assets
        ]
        covered_nodes.extend(s for s in t["nodeIds"] if s in assets)
        # 状态以产物为准（条目可能是直接写入或补考据落库的，状态还停在 planned，
        # 此时显示「待执行」会误导）；事实来自别的项目就是复用，出处写在行上。
        src_pid = str((entry or {}).get("projectId") or "")
        if entry and src_pid and src_pid != project_id:
            status_label = f"复用自《{_produced_by(src_pid)}》"
        elif entry:
            status_label = "已完成"
        elif t["status"] == "reused":
            status_label = f"复用自《{t['reusedFrom'] or '同题材项目'}》"
        else:
            status_label = {
                "planned": "待执行",
                "running": "进行中",
                "error": f"失败：{t['error'] or '未知原因'}",
            }.get(t["status"], t["status"])
        lines.append("")
        n_figs = len(topic_albums.get(topic_subject(era, project_id, t["topicKey"]), []))
        lines.append(
            f"■ {t['title']}（服务 {len(serves)} 张卡 · {status_label}"
            f"{f' · 图 {n_figs} 张' if n_figs else ''}）"
        )
        if t["rationale"]:
            lines.append(f"  为什么：{t['rationale']}")
        if serves:
            lines.append("  服务：" + "、".join(s["title"] for s in serves))
        if t["queries"]:
            lines.append("  检索词：" + " · ".join(t["queries"]))
        if with_facts and entry:
            lines.append("  " + str(entry["body"]).strip().replace("\n", "\n  "))
            doms = [
                str(s.get("domain") or _domain(str(s.get("url") or "")))
                for s in entry["sources"]
                if isinstance(s, dict)
            ]
            doms = [d for d in doms if d]
            if doms:
                seen: list[str] = []
                for d in doms:
                    if d not in seen:
                        seen.append(d)
                lines.append("  —— 来源：" + "、".join(seen[:6]))
        topics_out.append(
            {
                **t,
                "serves": serves,
                "entry": entry,
                # 主题图集张数（时代参考池）——出图时按服务范围分发给成员资产
                "refCount": len(
                    topic_albums.get(topic_subject(era, project_id, t["topicKey"]), [])
                ),
            }
        )
    return {
        "era": era,
        "topics": topics_out,
        "lines": lines,
        "done_count": done,
        "coveredNodeIds": covered_nodes,
        "assetCount": len(assets),
    }


def topic_serving(project_id: str) -> dict[str, list[dict[str, Any]]]:
    """卡片节点 id → 服务它的主题主体记录（标题/主体键/era/产出项目）。

    主题图集按「服务哪些卡」分发到成员资产——这是**时代参考池**的作用机制：
    `topic_briefs` 只带标题与事实正文（提示词用），这里带主体记录，
    出图参考序列才能按主体键取到该主题的图集（同框一致的机械基础）。"""
    out: dict[str, list[dict[str, Any]]] = {}
    if not project_id:
        return out
    for t in list_topics(project_id):
        entry = topic_entry(project_id, t["topicKey"])
        if not entry:
            continue
        rec = {
            "title": t["title"],
            "entryId": str(entry.get("id") or ""),
            "subjectKey": str(entry.get("subjectKey") or ""),
            "era": str(entry.get("era") or ""),
            "source": str(entry.get("projectId") or ""),
        }
        for nid in t["nodeIds"]:
            out.setdefault(str(nid), []).append(rec)
    return out


def lookup_topic_entry(era: str, topic_key: str) -> dict[str, Any] | None:
    """库检索：同 era 同主题键的主体事实（别的项目已经考据过同一件事）。

    严格按主题键相等——主题键是标题归一，同键即同一件事。era 为空不进库。"""
    return lookup_subject(era, "topic", str(topic_key or "").strip())


def _select_brief(
    project_id: str, node_id: str, asset_name: str, brief: str
) -> str:
    """终选用考据 = 本资产简报 + 服务它的时代主题事实（与出图注入同口径）。

    「文字定边界 → 图像做选择」要成立，挑图的模型必须同时看见两层边界：**这个
    资产是什么**（自己的简报）与**这个时代什么形制才对**（它所属主题的事实）。
    只给前者，模型只能判「像不像」，判不了「这个形制对不对时代」——同一批候选里
    错年代的照样会被选中。合成口径与 `skills._inject_research_briefs`、报告卡
    `cardBriefs` 三处同源（卡上显示的 = 挑图依据 = 出图发出去的）。"""
    parts = [str(brief or "").strip()]
    try:
        t_by_node, t_by_name = topic_briefs(project_id)
        for item in t_by_node.get(node_id) or t_by_name.get(str(asset_name or "").strip()) or []:
            parts.append(f"〈{item[0]}〉{item[1]}")
    except Exception:  # noqa: BLE001 主题读不到不影响本资产简报
        pass
    return "；".join(p for p in parts if p)


async def _run_topic(
    project_id: str, topic_key: str, sem: asyncio.Semaphore, force: bool = False
) -> None:
    """执行一个主题：本项目已有（自己产出或引用）即完成；库里命中即挂引用；否则搜一轮。

    复用即零成本、且是活引用（挂 uses，不拷贝正文）。失败记在主题行上明报，
    不静默标完成。force=True（调用方点名要跑这个主题）跳过「已有事实」短路——
    点名就是重跑意图，静默空转比花钱更糟；库命中仍然复用（那是零成本的既有
    结论，不值得为「重跑」再搜一遍同样的东西）。"""
    # 函数内 import：与 _run_research 同式（imgresearch 顶层已 from skills import，
    # 但模块名 skills 只在函数内绑定，避免 import 顺序敏感）
    import skills

    _, era = _project_scope(project_id)
    async with sem:
        if not force and topic_entry(project_id, topic_key):
            _topic_status(project_id, topic_key, "done", error="")
            return
        reused = lookup_topic_entry(era, topic_key)
        if reused:
            # _project_scope 返回 (项目名, era)——别解包错了：旧代码把 era 当成
            # 项目名，「复用自《北魏·平城时期》」这种年代当出处的标注一直是错的
            src_name, _ = _project_scope(str(reused.get("projectId") or ""))
            record_use(project_id, str(reused["id"]), "topic", topic_key)
            _topic_status(
                project_id,
                topic_key,
                "reused",
                reused_from=src_name or "同题材项目",
                error="",
            )
            return
        topics = {t["topicKey"]: t for t in list_topics(project_id)}
        topic = topics.get(topic_key)
        if topic is None:
            return
        _topic_status(project_id, topic_key, "running", error="")
        try:
            queries = list(topic["queries"])
            if not queries:
                plan = await skills.run_ref_plan_flow(
                    {
                        "name": topic["title"],
                        "type": "topic",
                        "description": topic["rationale"] or topic["title"],
                    },
                    [],
                )
                queries = [
                    str(q).strip()
                    for q in (plan.get("text_queries") or [])
                    if str(q).strip()
                ]
            if not queries:
                raise RuntimeError("主题没有检索词，且 plan flow 未产出文字检索词")
            errors: dict[str, str] = {}
            brief, sources = await _run_text_research(
                {
                    "name": topic["title"],
                    "type": "topic",
                    "description": topic["rationale"],
                },
                queries[: _MAX_TEXT_QUERIES],
                errors,
            )
            upsert_entry(
                project_id,
                body=brief,
                asset_name=topic["title"],
                asset_type="topic",
                era=era,
                topic_key=topic_key,
                sources=sources,
            )
            # 主题图路：时代级实物参考池（软失败，不拦文字产物）
            await _topic_images(project_id, topic, era, queries, errors)
            _topic_status(
                project_id, topic_key, "done", error="；".join(errors.values())[:160]
            )
        except Exception as exc:  # noqa: BLE001 单主题失败不中断整批
            print(f"[大纲] 主题执行失败 {project_id}/{topic_key}：{str(exc)[:160]}", flush=True)
            _topic_status(project_id, topic_key, "error", error=str(exc)[:160])


# 主题图集保留张数：一张卡的参考席上限 4，池子留余量给不同卡的不同侧重
TOPIC_REF_KEEP = 6
# 主题图的候选上限（进终选的张数）：比单资产调研小一个量级——主题图是
# 「同一时代一套参考」，不需要穷举；每批 50 张一次终选，别把额度烧在长尾上
TOPIC_CANDIDATE_CAP = 12


async def _topic_images(
    project_id: str,
    topic: dict[str, Any],
    era: str,
    queries: list[str],
    errors: dict[str, str],
) -> int:
    """主题级图路：主题检索词 → 搜图 → 下载 → 终选 → 归档进主题主体图集。

    这是**同框一致的机制落点**：主题图集挂在主题主体上、按「服务哪些卡」分发，
    同一时代的成员资产出图时带上同一批实物参考——旧流程按资产各搜一遍，十二个
    大臣会各自挑回形制互斥的官服（剧本里他们还要同框）。已有图集的主题不重搜
    （幂等；要换图走资产级调研或「找参考图」面板改选）。

    全程软失败：搜索/下载/终选任一步失败只记 errors，不拦文字产物。"""
    import skills

    skey = topic_subject(era, project_id, str(topic["topicKey"]))
    if subject_refs([skey], era).get(skey):
        return 0
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for q in queries[: _MAX_TEXT_QUERIES]:
        items = await _guarded(search_serper_images(q), "google", errors)
        for item in items:
            key = _dedupe_key(item["sourceUrl"])
            if key in seen:
                continue
            seen.add(key)
            item["query"] = q
            rows.append(item)
        await asyncio.sleep(0.3)  # 查询间隔：号池在并发主题间轮转
    if not rows:
        return 0
    rows = rows[:TOPIC_CANDIDATE_CAP]
    dl_errors: list[str] = []

    async def _fetch(item: dict[str, Any]) -> None:
        async with _GLOBAL_DOWNLOAD_SEM:
            try:
                item["assetUrl"] = await download_image(
                    item["sourceUrl"], item.get("pageUrl") or ""
                )
            except Exception as exc:  # noqa: BLE001 单张失败留痕不入库
                dl_errors.append(f"{item.get('title') or item['sourceUrl']}：{str(exc)[:60]}")

    try:
        await asyncio.wait_for(
            asyncio.gather(*[_fetch(item) for item in rows]), timeout=150.0
        )
    except (asyncio.TimeoutError, TimeoutError):
        dl_errors.append("整体下载超时，仅保留已完成部分")
    if dl_errors:
        errors["主题下载"] = "；".join(dl_errors[:3])
    kept = [r for r in rows if r.get("assetUrl")]
    if not kept:
        return 0
    picks = kept[:TOPIC_REF_KEEP]
    try:
        entry = topic_entry(project_id, topic["topicKey"])
        selection = await skills.run_ref_select_flow(
            {
                "name": str(topic["title"]),
                "type": "topic",
                "description": str(topic.get("rationale") or topic["title"]),
                "research_brief": str((entry or {}).get("body") or ""),
            },
            _select_payload(kept),
        )
        rec: list[int] = []
        for raw in selection.get("recommended") or []:
            try:
                rec.append(int(raw))
            except (TypeError, ValueError):
                continue
        chosen = [kept[i] for i in rec if 0 <= i < len(kept)]
        # 模型没给推荐也别把已下好的图扔了（钱已经花过）——按搜索序取前 K
        picks = (chosen or kept)[:TOPIC_REF_KEEP]
    except Exception as exc:  # noqa: BLE001 终选失败不拦归档
        errors["主题终选"] = str(exc)[:160]
    return add_subject_refs(era, skey, picks)


def run_topics(project_id: str, topic_keys: list[str] | None = None) -> list[str]:
    """执行主题（缺省=全部未完成的）：并发跑，状态写在主题行上（大纲即进度板）。

    **显式点名的主题一律跑**（调用方说了要跑就跑，那是重跑意图）；**缺省全量时
    跳过已有事实的**（done/reused 或库里/项目里已有条目）——状态机只记过程、
    产物为准：事实可能是直接写入或补考据落库的，状态还停在 planned，按旧口径
    重跑就是白花一次搜索。"""
    explicit = bool(topic_keys)
    todos: list[str] = []
    for t in list_topics(project_id):
        if explicit and t["topicKey"] not in topic_keys:
            continue
        if not explicit and (
            t["status"] in ("done", "reused") or topic_entry(project_id, t["topicKey"])
        ):
            continue
        todos.append(t["topicKey"])
    if not todos:
        return []
    sem = asyncio.Semaphore(TOPIC_CONCURRENCY)

    async def _all() -> None:
        await asyncio.gather(
            *[_run_topic(project_id, k, sem, force=explicit) for k in todos]
        )

    task = asyncio.create_task(_all())
    task.add_done_callback(
        lambda _t: eventbus.publish_job_event(
            "ref_topics", project_id, f"outline-{project_id}", "done", title="考证大纲执行"
        )
    )
    return todos


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
        "phase": "",
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
) -> tuple[str, list[dict[str, Any]]]:
    """文字考据：web 搜索 → 抓正文 → LLM 提纯成考据简报。

    返回 (简报, 来源底账)——来源是真正抓成功的页面（title/url/domain），条目
    落库时作证据底账存下；没抓到的页面不算来源。

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
    brief = await skills.run_ref_brief_flow(asset, pages)
    sources = [
        {"title": p["title"], "url": p["url"], "domain": _domain(p["url"])}
        for p in pages
    ]
    return brief, sources


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
    # 镜像落库（含 running 态）：重启丢内存任务表后，报告卡还能读到
    # 「上次调研中断」而不是一片空白；逐项错误也在这里留档
    jobstore.create_job(
        batch_id,
        "ref_batch",
        {"projectId": project_id, "batchId": batch_id, "total": len(assets)},
    )
    sem = asyncio.Semaphore(BATCH_CONCURRENCY)
    # 批内启动抖动：整批同时开跑会把下载风暴压向同一批大 CDN（人物类图源
    # 高度集中），2026-09-11 冯太后项目 18 资产候选图全灭于此。抖动上限随
    # 批量缩放——小批不拖时间，大批摊开入场
    jitter_max = min(12.0, 0.4 * len(assets))

    async def _run_one(i: int, a: dict[str, Any], attempt: int = 1) -> None:
        node_id = str(a.get("nodeId") or "")
        name = str(a.get("name") or "")
        batch["items"][i]["status"] = "running"
        if attempt > 1:
            batch["items"][i]["retried"] = True
        # 信号量在任务内抢：并发由它限（顺序循环里 async with 是串行的，
        # 信号量形同虚设——首版踩坑：12 资产一个一个跑）
        async with sem:
            try:
                if attempt == 1 and jitter_max > 0:
                    await asyncio.sleep(random.uniform(0, jitter_max))
                # 手填/主题检索词逐资产透传（空 = AI 出词）。给了词就不跑文路
                # ——与前端单资产面板的「手填词」同语义：用户/agent 亲自掌舵搜图，
                # 不替它先搜一轮文字（见 _run_research 的 manual 分支）
                job_id = start_research_job(
                    project_id,
                    node_id,
                    [str(q) for q in (a.get("queries") or []) if str(q).strip()],
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
        batch["done"] = sum(
            1 for it in batch["items"] if it["status"] in ("done", "error")
        )
        running = [
            it["name"] for it in batch["items"] if it["status"] == "running"
        ]
        batch["current"] = "、".join(running[:3]) + ("…" if len(running) > 3 else "")

    await asyncio.gather(*[_run_one(i, a) for i, a in enumerate(assets)])
    # 失败项自动补跑一轮（产品自愈，2026-09-11）：失败集中在瞬时原因
    # （防盗链 403 风暴 / 源站限流），隔 45s 冷却后重跑大概率能救回；
    # 只重跑明确 error（未产出任何候选）的项——done 项的重跑会重复搜索
    # 与采纳语义，不做。补跑后仍失败的项保持 error，报告卡与事件如实呈现
    retry_plan = [
        (i, a)
        for i, (it, a) in enumerate(zip(batch["items"], assets))
        if it["status"] == "error"
    ]
    if retry_plan:
        await asyncio.sleep(45.0)
        await asyncio.gather(
            *[_run_one(i, a, attempt=2) for i, a in retry_plan]
        )
    batch["status"] = "done"
    batch["current"] = ""
    jobstore.finish_job(
        batch_id,
        {
            "projectId": project_id,
            "batchId": batch_id,
            # brief 逐条 1200 字、整批几十 KB，镜像只留诊断需要的字段
            "items": [
                {
                    "nodeId": it["nodeId"],
                    "name": it["name"],
                    "status": it["status"],
                    "error": str(it.get("error") or "")[:160],
                    "retried": bool(it.get("retried")),
                }
                for it in batch["items"]
            ],
        },
    )
    # 终态广播：聊天侧自动续跑汇报采纳结果（AG-UI 轮次流早已关闭，只有事件流能到）
    n_ok = sum(1 for it in batch["items"] if it["status"] == "done")
    n_err = len(batch["items"]) - n_ok
    eventbus.publish_job_event(
        "ref_research",
        project_id,
        batch_id,
        "done",
        title="资产参考图调研",
        summary=f"{n_ok} 项完成" + (f"、{n_err} 项失败" if n_err else ""),
        items=[
            {
                "node_id": it["nodeId"],
                "name": it["name"],
                "status": it["status"],
                "error": str(it.get("error") or "")[:160],
            }
            for it in batch["items"]
        ],
    )


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
    （第二轮起带已完成轮次摘要，自动换角度）。下载段整体受 150s 死线约束。"""
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
        job["phase"] = "出搜索词"
        text_task: asyncio.Task | None = None
        for round_num in range(1, MAX_RESEARCH_ROUNDS + 1):
            if round_num == 1:
                # 首轮：手填词直用；AI 模式由 planner 出词（同时出文字考据词，
                # fork：文路后台开跑与图路搜索下载并行；手填词是用户亲自掌舵
                # 搜图，不跑文路）
                if manual:
                    round_queries = queries
                    job["phase"] = "搜图与下载"
                else:
                    plan = await skills.run_ref_plan_flow(asset, [])
                    round_queries = plan["queries"]
                    job["phase"] = "搜图与下载"
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
        # 并发下载走全局信号量（10 路调研共享 32 并发，防叠加打爆源站）；
        # 单张失败不拖垮整批，失败者不入库。
        # 整体 150s 死线（与文路 _BRIEF_WAIT_S 同档）：超时取消在途下载，
        # 保留已完成部分。曾为 110s——批量 20 路并发下共享信号量排队 +
        # 403/429 退避重试会占住槽位，队尾资产的候选被死线整批掐掉
        # （2026-09-11 冯太后项目 18 资产全灭的另一半根因）
        dl_errors: list[str] = []

        async def _fetch(item: dict[str, Any]) -> None:
            async with _GLOBAL_DOWNLOAD_SEM:
                try:
                    item["assetUrl"] = await download_image(item["sourceUrl"], item.get("pageUrl") or "")
                except Exception as exc:  # noqa: BLE001 单张下载失败留痕不入库
                    dl_errors.append(f"{item.get('title') or item['sourceUrl']}：{str(exc)[:80]}")

        try:
            await asyncio.wait_for(
                asyncio.gather(*[_fetch(item) for item in merged]), timeout=150.0
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
        job["phase"] = "考据与终选"
        _, era = _project_scope(project_id)
        asset_name = str(asset.get("name") or "")
        # join：收文路考据简报（超时/失败记软错误，不拦终选与采纳）
        brief = ""
        brief_sources: list[dict[str, Any]] = []
        if text_task is not None:
            try:
                res = await asyncio.wait_for(text_task, timeout=_BRIEF_WAIT_S)
                brief, brief_sources = res
            except Exception as exc:  # noqa: BLE001 文路软失败明报
                text_task.cancel()
                errors["考据"] = str(exc)[:160]
        if brief:
            job["researchBrief"] = brief
            # 服务端权威落点：简报一产出即入主体表，与谁发起调研、画布开没开、
            # agent 进程活没活都无关（此前只活在内存 job 字典里，重启即蒸发）
            try:
                upsert_entry(
                    project_id,
                    body=brief,
                    node_id=node_id,
                    asset_name=asset_name,
                    asset_type=str(asset.get("type") or ""),
                    era=era,
                    sources=brief_sources,
                )
            except Exception as exc:  # noqa: BLE001 落库失败不拦出图链路
                print(f"[考据] 条目落库失败 {project_id}/{node_id}：{exc}", flush=True)
                errors["条目落库"] = str(exc)[:120]
        # LLM 终选（失败只记 errors，不影响候选展示与人工采纳）；带考据挑图——
        # 文字考据纠正选图（错年代/错形制的候选降权）。**时代主题事实也在这时
        # 上场**：同一资产既属于自己（具名个体），也属于它所在时代的若干主题，
        # 「文字定边界 → 图像做选择」要成立就得让挑图的模型同时看见两层边界，
        # 否则它只能按单资产简报判「像不像」，判不了「这个形制对不对时代」
        # （合成口径与出图注入、报告卡 cardBriefs 三处同源）
        try:
            brief_for_select = _select_brief(
                project_id, node_id, str(asset.get("name") or ""), brief
            )
            select_asset = (
                {**asset, "research_brief": brief_for_select}
                if brief_for_select
                else asset
            )
            selection = await skills.run_ref_select_flow(select_asset, _select_payload(rows))
            _apply_recommendation(project_id, node_id, rows, selection)
            job["note"] = selection.get("note") or ""
            # 终选完自动采纳 top-K 推荐（rec_rank 升序）——LLM 已挑过一轮，
            # 再等用户逐张手勾是把模型判断抄写一遍；采纳只是标记不花额度，
            # 用户可在「找参考图」面板随时改选（2026-09-06 用户「为啥没自动选」）
            auto_adopt_top(project_id, node_id, AUTO_ADOPT_PER_NODE)
        except Exception as exc:  # noqa: BLE001
            errors["终选"] = str(exc)[:160]
        # 采纳回流：采纳的图收进主体图集，下一个项目遇到同一主体直接复用。
        # 图与事实各自独立——手填检索词的调研不跑文路、没有事实条目，图照样入库
        try:
            _archive_adopted_refs(project_id, node_id, asset_name, era)
        except Exception as exc:  # noqa: BLE001 归档失败不拦调研结果
            print(f"[图集] 归档失败 {project_id}/{node_id}：{exc}", flush=True)
            errors["图集归档"] = str(exc)[:120]
        job["candidates"] = list_candidates(project_id, node_id)
        job["errors"] = errors
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 任务级失败明报
        job["status"] = "error"
        job["error"] = str(exc)[:300]


def _archive_adopted_refs(
    project_id: str, node_id: str, asset_name: str, era: str
) -> int:
    """把某资产已采纳的候选图收进它的主体图集（url 去重），返回新增条数。"""
    if not _norm_name(asset_name):
        return 0
    adopted = [c for c in list_candidates(project_id, node_id) if c.get("adopted")]
    return add_subject_refs(
        era, asset_subject(era, project_id, asset_name), adopted
    )


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
    """把终选结果回填 ref_candidates（按 source_url 匹配行）。

    recommended 照旧存布尔；rec_rank 存 LLM 排序位（selection 列表顺序 =
    适配度降序，自动采纳按它取 top-K——只存布尔会让"最好的 3 张"退化成
    "任选 3 张推荐"）。多批合并时批内严格按 LLM 排序，批间按批先后。"""
    rec_list = [int(i) for i in (selection.get("recommended") or [])]
    rec_idx = set(rec_list)
    rank_of = {idx: r + 1 for r, idx in enumerate(rec_list)}
    note = selection.get("note") or ""
    with _conn() as conn:
        for i, m in enumerate(rows):
            conn.execute(
                "UPDATE ref_candidates SET recommended = ?, rec_rank = ?, rec_reason = ?"
                " WHERE project_id = ? AND node_id = ? AND source_url = ?",
                (
                    1 if i in rec_idx else 0,
                    rank_of.get(i, 0),
                    note,
                    project_id,
                    node_id,
                    m["sourceUrl"][:800],
                ),
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
