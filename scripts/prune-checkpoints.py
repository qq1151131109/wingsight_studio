#!/usr/bin/env python
"""裁剪 LangGraph checkpoint 库里的孤儿线程（2026-09-11）。

**口径：只清孤儿线程，不按天数删活线程。** checkpoint 是「会话上下文」的
存储，按时间裁剪等于把老会话的记忆删掉——那是用户数据，不是缓存。孤儿
（thread_id 在 app 侧已不存在）才是真正没人能寻址的垃圾：项目/会话删了、
checkpoint 还在，白占磁盘。

**「活线程」= chat_threads 或 chat_messages 里出现过**（两个都查，缺一不可）：
前端会话 id 是客户端生成的 32 位 hex（lib/chat/session.ts），落库时机晚于
第一轮 agent 运行——实测 2026-09-11 11:48「调研完成自动续跑」就在一个
**只存在于 checkpoint、两张表都还没有行**的线程上跑了一轮。只看 chat_threads
会把这种正在用的会话当孤儿；加上 chat_messages 至少覆盖「已经有消息存档」的。
残余风险仍在（全新标签页 + 自动续跑、消息还没落库），因此裁剪必须显式执行、
且 VACUUM 前需停 agent，绝不做成启动自清理。

实测来源：2306 行 / 184MB 里，134 个 thread_id 只有 2 个活着，132 个孤儿
占 132MB（writes 表另 7.6MB）——大多是测试项目反复建删攒下来的。

**默认只报告，删除必须显式加 `--apply`**——理由见上：判据本身有残余风险，
而误删的是会话上下文（不可重建）。VACUUM 还要 agent 停着才有独占锁：
    cd agent && uv run python ../scripts/prune-checkpoints.py              # 只看
    cd agent && uv run python ../scripts/prune-checkpoints.py --apply
    cd agent && uv run python ../scripts/prune-checkpoints.py --apply --vacuum

为什么要单独一个脚本、不做成 agent 启动自清理：agent 还有一条「客户端自带
threadId 直连」的路径（活线程里有 32 位 hex 的，就不来自 create_thread），
那种会话不进 chat_threads 表——启动时自动按「不在表里」删，会把它的上下文
在每次重启时误杀。所以裁剪必须是显式动作，由人确认后再跑。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "agent" / "data"
PROJECTS_DB = DATA_DIR / "wingsight.db"
CHECKPOINTS_DB = DATA_DIR / "checkpoints.db"


def human(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def main() -> int:
    ap = argparse.ArgumentParser(description="裁剪 checkpoint 库里的孤儿线程")
    ap.add_argument("--apply", action="store_true", help="真的删除（缺省只报告）")
    ap.add_argument("--vacuum", action="store_true", help="删除后 VACUUM 回收体积（需 agent 已停）")
    args = ap.parse_args()

    if not PROJECTS_DB.exists() or not CHECKPOINTS_DB.exists():
        print(f"✗ 找不到库：{PROJECTS_DB} / {CHECKPOINTS_DB}", file=sys.stderr)
        return 1

    proj = sqlite3.connect(PROJECTS_DB)
    live = {
        r[0]
        for r in proj.execute(
            "SELECT id FROM chat_threads UNION SELECT DISTINCT thread_id FROM chat_messages"
        ).fetchall()
        if r[0]
    }
    proj.close()
    # 空集合＝读错了库（比如换了数据目录）：此时「不在表里」等于「全部」，绝不是
    # 我们想要的语义——宁可拒绝执行
    if not live:
        print(f"✗ chat_threads / chat_messages 里一个会话都没有：{PROJECTS_DB}\n  拒绝执行（否则会把整个 checkpoint 库当孤儿删掉）", file=sys.stderr)
        return 1

    con = sqlite3.connect(CHECKPOINTS_DB)
    con.execute("CREATE TEMP TABLE live_threads (id TEXT PRIMARY KEY)")
    con.executemany("INSERT INTO live_threads (id) VALUES (?)", [(t,) for t in sorted(live)])
    con.execute("CREATE TEMP TABLE all_threads AS SELECT DISTINCT thread_id AS id FROM checkpoints "
                "UNION SELECT DISTINCT thread_id FROM writes")
    orphan_rows = con.execute(
        "SELECT count(*) FROM all_threads WHERE id NOT IN (SELECT id FROM live_threads)"
    ).fetchone()[0]
    total_rows = con.execute("SELECT count(*) FROM all_threads").fetchone()[0]
    ck = con.execute(
        "SELECT count(*), coalesce(sum(length(coalesce(checkpoint,''))+length(coalesce(metadata,''))),0) "
        "FROM checkpoints WHERE thread_id NOT IN (SELECT id FROM live_threads)"
    ).fetchone()
    wr = con.execute(
        "SELECT count(*), coalesce(sum(length(coalesce(value,''))),0) "
        "FROM writes WHERE thread_id NOT IN (SELECT id FROM live_threads)"
    ).fetchone()

    print(f"会话线程：活 {len(live)}（chat_threads ∪ chat_messages）/ 总 {total_rows}；孤儿 {orphan_rows} 个线程")
    print(f"待删：checkpoints {ck[0]} 行（{human(ck[1])}）+ writes {wr[0]} 行（{human(wr[1])}）")

    if not args.apply:
        print("\n未加 --apply：只报告，未删除任何行。")
        con.close()
        return 0

    con.execute("DELETE FROM checkpoints WHERE thread_id NOT IN (SELECT id FROM live_threads)")
    con.execute("DELETE FROM writes WHERE thread_id NOT IN (SELECT id FROM live_threads)")
    con.commit()
    left = con.execute("SELECT count(*) FROM checkpoints").fetchone()[0]
    left_threads = con.execute("SELECT count(DISTINCT thread_id) FROM checkpoints").fetchone()[0]
    print(f"✓ 已删除孤儿：checkpoints 剩 {left} 行 / {left_threads} 个线程（应等于活线程数 {len(live)}）")

    if args.vacuum:
        before = CHECKPOINTS_DB.stat().st_size
        con.execute("VACUUM")
        after = CHECKPOINTS_DB.stat().st_size
        print(f"✓ VACUUM：{human(before)} → {human(after)}（回收 {human(before - after)}）")
    else:
        print("（未 VACUUM：文件体积不会立即回落，加 --vacuum 回收，需 agent 已停）")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
