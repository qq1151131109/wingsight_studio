"""存量生料卡提质迁移：标题+钩子+分集构想 按新契约一次性重写（arc 不动）。

背景：2026-09-08 选题质量整治——retitle flow 输出契约加宽为
{title, hook, episodes}，本脚本把存量生料卡分批喂入并落库三件：
  · 标题：指纹冲突跳过保留原题（同 retitle_topics.py）
  · 钩子（summary）：去空白、截 100 字，非空且不同才更新
  · 分集（episodes_json）：至少 3 条有效才更新（_sanitize_pairs 清洗、不设上限）
幂等可重跑；单批失败跳过可补。

运行：cd agent && uv run python polish_topics.py
前置：langflow 在跑；.env.local 有 LANGFLOW_TOPIC_RETITLE_FLOW_ID。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

import skills
import topics as store
from topic_pool import _sanitize_pairs

BATCH = 30
FID = os.environ.get("LANGFLOW_TOPIC_RETITLE_FLOW_ID", "").strip()

from topics import fingerprint_of


async def main() -> None:
    assert FID, ".env.local 缺 LANGFLOW_TOPIC_RETITLE_FLOW_ID"
    with store._conn() as conn:
        rows = conn.execute(
            "SELECT id, title, summary, arc, vertical, tags_json, episodes_json"
            " FROM topics WHERE stage='raw' AND status='candidate' ORDER BY id"
        ).fetchall()
    print(f"待提质: {len(rows)} 张")
    done = kept = skipped = 0
    from models import DEFAULT_TEXT_MODEL_ID, text_model_tweaks

    with store._conn() as conn:
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            payload = {
                "cards": [
                    {
                        "index": j,
                        "title": r["title"].strip("《》"),
                        "hook": r["summary"],
                        "arc": r["arc"],
                        "vertical": r["vertical"],
                        "tags": json.loads(r["tags_json"] or "[]"),
                    }
                    for j, r in enumerate(chunk)
                ]
            }
            try:
                text = await skills.run_flow_blocking(
                    FID,
                    json.dumps(payload, ensure_ascii=False),
                    tweaks={"LanguageModelComponent": text_model_tweaks(DEFAULT_TEXT_MODEL_ID)},
                )
                out = json.loads(text[text.index("[") : text.rindex("]") + 1])
            except Exception as exc:  # noqa: BLE001 - 单批失败跳过，可重跑补
                print(f"  批 {i // BATCH + 1} 失败跳过: {str(exc)[:120]}")
                skipped += len(chunk)
                continue
            items = {}
            for item in out if isinstance(out, list) else []:
                if isinstance(item, dict) and isinstance(item.get("sourceIndex"), int):
                    if 0 <= item["sourceIndex"] < len(chunk):
                        items[item["sourceIndex"]] = item
            for j, r in enumerate(chunk):
                item = items.get(j) or {}
                new_title = str(item.get("title") or "").strip().strip("《》")
                new_hook = str(item.get("hook") or "").strip()[:100]
                new_eps = _sanitize_pairs(item.get("episodes"), "focus")
                changed = {}
                # 标题：指纹冲突保留原题
                if new_title and new_title != r["title"].strip("《》"):
                    fp = fingerprint_of(new_title)
                    clash = conn.execute(
                        "SELECT 1 FROM topics WHERE title_fingerprint = ? AND id != ?",
                        (fp, r["id"]),
                    ).fetchone()
                    if not clash:
                        changed["title"] = new_title
                        changed["title_fingerprint"] = fp
                # 钩子
                if new_hook and new_hook != (r["summary"] or "").strip():
                    changed["summary"] = new_hook
                # 分集：至少 3 条有效才覆盖
                if len(new_eps) >= 3 and new_eps != json.loads(r["episodes_json"] or "[]"):
                    changed["episodes_json"] = json.dumps(new_eps, ensure_ascii=False)
                if not changed:
                    kept += 1
                    continue
                changed["updated_at"] = store._now()
                sets = ", ".join(f"{k} = ?" for k in changed)
                conn.execute(
                    f"UPDATE topics SET {sets} WHERE id = ?",
                    [*changed.values(), r["id"]],
                )
                done += 1
            conn.commit()
            print(f"  批 {i // BATCH + 1}/{(len(rows) + BATCH - 1) // BATCH}: 累计提质 {done}")
    print(f"完成：提质 {done}，保留 {kept}，批失败跳过 {skipped}")


if __name__ == "__main__":
    asyncio.run(main())
