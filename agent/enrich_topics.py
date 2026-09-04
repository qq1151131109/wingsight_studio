"""存量生料卡策划案回填：补分集构想/对标片/目标观众（迷你策划案三件）。

背景：2026-09-04 收敛 flow 输出扩展了 episodes/benchmarks/audience，只对
新卡生效；存量生料卡还是"四句 arc + 一条出处"的薄卡。本脚本把存量卡分批
喂 topic-enrich flow 补三件（不动已有内容），幂等可重跑（已补的跳过）。

运行：cd agent && uv run python enrich_topics.py
前置：langflow 在跑；.env.local 有 LANGFLOW_TOPIC_ENRICH_FLOW_ID。
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
from topic_pool import _sanitize_pairs

BATCH = 30
FID = os.environ.get("LANGFLOW_TOPIC_ENRICH_FLOW_ID", "").strip()


async def main() -> None:
    assert FID, ".env.local 缺 LANGFLOW_TOPIC_ENRICH_FLOW_ID"
    with store._conn() as conn:
        rows = conn.execute(
            "SELECT id, title, summary, arc, vertical, tags_json FROM topics"
            " WHERE stage='raw' AND status='candidate' AND episodes_json='[]' ORDER BY id"
        ).fetchall()
    print(f"待补策划案: {len(rows)} 张")
    if not rows:
        return
    done = skipped = 0
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
        patched = 0
        with store._conn() as conn:
            for item in out if isinstance(out, list) else []:
                if not isinstance(item, dict):
                    continue
                idx = item.get("sourceIndex")
                if not isinstance(idx, int) or not 0 <= idx < len(chunk):
                    continue
                episodes = _sanitize_pairs(item.get("episodes"), "focus", 5)
                benchmarks = _sanitize_pairs(item.get("benchmarks"), "note", 3)
                audience = str(item.get("audience") or "").strip()[:80]
                if not episodes and not benchmarks and not audience:
                    continue
                conn.execute(
                    "UPDATE topics SET episodes_json = ?, benchmarks_json = ?, audience = ?,"
                    " updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                    (
                        json.dumps(episodes, ensure_ascii=False),
                        json.dumps(benchmarks, ensure_ascii=False),
                        audience,
                        chunk[idx]["id"],
                    ),
                )
                patched += 1
        done += patched
        print(f"  批 {i // BATCH + 1}: {patched}/{len(chunk)} 张补全")
    print(f"完成：补全 {done}，跳过 {skipped}")


if __name__ == "__main__":
    asyncio.run(main())
