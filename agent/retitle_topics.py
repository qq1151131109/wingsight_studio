"""存量生料卡重命名迁移：散文题 → 爆款纪录片标题（只改题不动内容）。

背景：2026-09-03 收敛 flow 补了爆款标题纪律，只对新生效；存量 ~855 张
生料卡还是散文腔标题。本脚本把存量卡分批喂 topic-retitle flow 重写标题，
指纹冲突/空产出跳过保留原题。幂等可重跑。

运行：cd agent && uv run python retitle_topics.py
前置：langflow 在跑；.env.local 有 LANGFLOW_TOPIC_RETITLE_FLOW_ID。
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

import skills
import topics as store

BATCH = 30
FID = os.environ.get("LANGFLOW_TOPIC_RETITLE_FLOW_ID", "").strip()


def fingerprint_of(title: str) -> str:
    keep = [ch for ch in title.lower() if ch.isalnum()]
    import hashlib

    return hashlib.sha256("".join(keep).encode("utf-8")).hexdigest()


async def main() -> None:
    assert FID, ".env.local 缺 LANGFLOW_TOPIC_RETITLE_FLOW_ID"
    with store._conn() as conn:
        rows = conn.execute(
            "SELECT id, title, summary, arc, vertical, tags_json FROM topics"
            " WHERE stage='raw' AND status='candidate' ORDER BY id"
        ).fetchall()
    print(f"待重命名: {len(rows)} 张")
    done = skipped = kept = 0
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
                from models import DEFAULT_TEXT_MODEL_ID, text_model_tweaks

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
            new_titles = {}
            for item in out if isinstance(out, list) else []:
                if not isinstance(item, dict):
                    continue
                idx = item.get("sourceIndex")
                title = str(item.get("title") or "").strip().strip("《》")
                if isinstance(idx, int) and 0 <= idx < len(chunk) and title:
                    new_titles[idx] = title
            for j, r in enumerate(chunk):
                new = new_titles.get(j)
                if not new or new == r["title"].strip("《》"):
                    kept += 1  # 空产出/原样保留
                    continue
                fp = fingerprint_of(new)
                clash = conn.execute(
                    "SELECT 1 FROM topics WHERE title_fingerprint = ? AND id != ?",
                    (fp, r["id"]),
                ).fetchone()
                if clash:
                    kept += 1
                    continue
                conn.execute(
                    "UPDATE topics SET title = ?, title_fingerprint = ?, updated_at = ?"
                    " WHERE id = ?",
                    (new, fp, store._now(), r["id"]),
                )
                done += 1
            conn.commit()
            print(f"  批 {i // BATCH + 1}/{(len(rows) + BATCH - 1) // BATCH}: 累计改题 {done}")
    print(f"完成：改题 {done}，保留 {kept}，批失败跳过 {skipped}")


if __name__ == "__main__":
    asyncio.run(main())
