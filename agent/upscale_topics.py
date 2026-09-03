"""存量生料卡升维迁移：题眼太小的选题升维重写（题眼/跟拍/弧线），升不了维的淘汰。

背景：2026-09-03 收敛 flow 把「容量 40 分钟」闸升级为「题眼与体量」闸（切口可以
小、题眼必须大），只对新生效；存量生料卡多为单人物单事件的小题。本脚本把存量
卡分批喂 topic-upscale flow 判定改造。幂等可重跑（dismiss 过的不再出现）。

运行：cd agent && uv run python upscale_topics.py
前置：langflow 在跑；.env.local 有 LANGFLOW_TOPIC_UPSCALE_FLOW_ID。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

import skills
import topics as store

BATCH = 30
FID = os.environ.get("LANGFLOW_TOPIC_UPSCALE_FLOW_ID", "").strip()


def fingerprint_of(title: str) -> str:
    keep = [ch for ch in title.lower() if ch.isalnum()]
    return hashlib.sha256("".join(keep).encode("utf-8")).hexdigest()


async def main() -> None:
    assert FID, ".env.local 缺 LANGFLOW_TOPIC_UPSCALE_FLOW_ID"
    with store._conn() as conn:
        rows = conn.execute(
            "SELECT id, title, summary, arc, vertical, tags_json, heat_evidence_json"
            " FROM topics WHERE stage='raw' AND status='candidate' ORDER BY id"
        ).fetchall()
    print(f"待判定: {len(rows)} 张", flush=True)
    upscaled = dismissed = kept = failed = 0
    with store._conn() as conn:
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            payload = {"cards": []}
            for j, r in enumerate(chunk):
                heat = json.loads(r["heat_evidence_json"] or "[]")
                payload["cards"].append(
                    {
                        "index": j,
                        "title": r["title"].strip("《》"),
                        "hook": r["summary"],
                        "arc": r["arc"],
                        "vertical": r["vertical"],
                        "tags": json.loads(r["tags_json"] or "[]"),
                        "clue": heat[0].get("title", "") if heat else "",
                        "clue_snippet": heat[0].get("snippet", "") if heat else "",
                    }
                )
            try:
                from models import DEFAULT_TEXT_MODEL_ID, text_model_tweaks

                text = await skills.run_flow_blocking(
                    FID,
                    json.dumps(payload, ensure_ascii=False),
                    tweaks={"LanguageModelComponent": text_model_tweaks(DEFAULT_TEXT_MODEL_ID)},
                )
                out = json.loads(text[text.index("[") : text.rindex("]") + 1])
            except Exception as exc:  # noqa: BLE001 - 单批失败跳过，可重跑补
                print(f"  批 {i // BATCH + 1} 失败跳过: {str(exc)[:120]}", flush=True)
                failed += len(chunk)
                continue
            actions = {}
            for item in out if isinstance(out, list) else []:
                if not isinstance(item, dict):
                    continue
                idx = item.get("sourceIndex")
                if isinstance(idx, int) and 0 <= idx < len(chunk):
                    actions[idx] = item
            for j, r in enumerate(chunk):
                item = actions.get(j)
                if not item:
                    kept += 1
                    continue
                if item.get("action") == "dismiss":
                    conn.execute(
                        "UPDATE topics SET status='dismissed', updated_at=? WHERE id=?",
                        (store._now(), r["id"]),
                    )
                    dismissed += 1
                    continue
                title = str(item.get("title") or "").strip().strip("《》")
                hook = str(item.get("hook") or "").strip()
                arc = str(item.get("arc") or "").strip()
                if not title or not hook or len(arc) < 12 or "题眼" not in arc[:12] or "素材" not in arc:
                    kept += 1  # 升维输出不合法保留原卡，宁缺毋滥不硬写
                    continue
                fp = fingerprint_of(title)
                clash = conn.execute(
                    "SELECT 1 FROM topics WHERE title_fingerprint = ? AND id != ?",
                    (fp, r["id"]),
                ).fetchone()
                if clash:
                    kept += 1
                    continue
                conn.execute(
                    "UPDATE topics SET title=?, title_fingerprint=?, summary=?, arc=?, updated_at=?"
                    " WHERE id=?",
                    (title, fp, hook, arc, store._now(), r["id"]),
                )
                upscaled += 1
            conn.commit()
            print(
                f"  批 {i // BATCH + 1}/{(len(rows) + BATCH - 1) // BATCH}:"
                f" 升维 {upscaled} / 淘汰 {dismissed} / 保留 {kept}",
                flush=True,
            )
    print(f"完成：升维 {upscaled}，淘汰 {dismissed}，保留 {kept}，批失败 {failed}")


if __name__ == "__main__":
    asyncio.run(main())
