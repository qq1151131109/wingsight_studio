"""任务可靠性回归（P1：job 持久化 + 重启恢复语义），纯函数 + HTTP 双层：

A. jobstore：create/save/finish/load 的正常链路；running 孤儿 load 就地
   终态化（产物保留 + 补中断 error）；镜像 state 内残留 status 键不得盖掉列权威。
B. imagejobs.finalize_running_orphans：两张 item 表的 running 孤儿批量终态化
   ——完成项保留、未知状态在途项标中断（不自动重跑，防重复计费）。
C. skills 轮询端内存 miss 回退：拆解/分镜生成任务在 agent 重启（内存表空）
   后照常可查——拆解带回 partial assets（已生成的设定图不随进程蒸发）。
D. HTTP 层（agent 在跑）：GET /assets/decompose/{orphanId} 不再 404。

用法：cd agent && uv run python ../scripts/job-recovery-test.py
（无 LLM 调用；D 组需 agent 8123 在跑，不在则跳过）
"""
from __future__ import annotations

import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

import imagejobs  # noqa: E402
import jobstore  # noqa: E402
import skills  # noqa: E402

RESULTS = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok))
    print(("✓" if ok else "✗") + f" {name}" + (f"  — {detail}" if detail else ""))


def env_local(key: str) -> str:
    for line in (Path(__file__).resolve().parent.parent / ".env.local").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line[len(key) + 1:].strip()
    return ""


# ---------- A. jobstore 基础语义 ----------
JID = "jt_a1"
jobstore.create_job(JID, "decompose", {"phase": "decompose", "assets": None})
jobstore.save_state(JID, {"phase": "images", "assets": [{"type": "character", "name": "老陈"}], "progress": {"done": 1, "total": 5}})
jobstore.finish_job(JID, {"phase": "done", "assets": [{"type": "character", "name": "老陈", "image_url": "/agent-service/assets/x.png"}], "error": None})
loaded = jobstore.load_job(JID)
check("A1 正常终态读回（assets 带 image_url）",
      loaded["status"] == "done" and loaded["assets"][0]["image_url"].endswith("x.png"),
      json.dumps(loaded, ensure_ascii=False)[:100])

# 孤儿：running 行 + 内存无此任务 → load 终态化，产物保留补中断 error
JID2 = "jt_a2"
jobstore.create_job(JID2, "decompose", {"phase": "images"})
jobstore.save_state(JID2, {"phase": "images", "assets": [{"type": "scene", "name": "茶馆", "image_url": "/agent-service/assets/y.png"}]})
orphan = jobstore.load_job(JID2)
check("A2 孤儿 load 终态化（done + 中断 error + partial 保留）",
      orphan["status"] == "done" and "中断" in orphan["error"] and orphan["assets"][0]["image_url"].endswith("y.png"),
      str(orphan.get("error")))
re = jobstore.load_job(JID2)
check("A3 终态化幂等（二次 load 不再改写）", re["status"] == "done" and re["error"] == orphan["error"])

# 镜像 state 残留 status 键不得盖掉列权威
JID3 = "jt_a3"
jobstore.create_job(JID3, "shotlist_gen", {"status": "running", "rows": None, "error": None})
row3 = jobstore.load_job(JID3)
check("A4 state 内残留 status 键不盖列权威", row3["status"] == "done" and "中断" in row3["error"])

# 启动清扫
JID4 = "jt_a4"
jobstore.create_job(JID4, "decompose", {"phase": "decompose"})
swept = jobstore.sweep_orphans()
after4 = jobstore.load_job(JID4)
check("A5 sweep_orphans 终态化 running 孤儿", after4["status"] == "done" and "中断" in after4["error"], f"swept={swept}")

# ---------- B. image/video item 表孤儿批量终态化 ----------
IJ = "jt_img_orphan"
imagejobs.create_job(IJ, ["p1", "p2", "p3"], table="image_jobs")
imagejobs.save_item(IJ, "p1", {"ok": True, "imageUrl": "/a.png"}, table="image_jobs")
imagejobs.save_item(IJ, "p2", {"ok": False, "error": "内容审核未过"}, table="image_jobs")
VJ = "jt_vid_orphan"
imagejobs.create_job(VJ, ["v1", "v2"], table="video_jobs")
imagejobs.save_item(VJ, "v1", {"ok": True, "videoUrl": "/v.mp4"}, table="video_jobs")
n = imagejobs.finalize_running_orphans()
img = imagejobs.load_job(IJ, table="image_jobs")
vid = imagejobs.load_job(VJ, table="video_jobs")
check("B1 出图表孤儿：完成项保留 + 未完成标中断",
      img["status"] == "done" and img["images"]["p1"]["ok"] and "中断" in img["images"]["p3"]["error"])
check("B2 视频表孤儿同款", vid["status"] == "done" and vid["images"]["v1"]["ok"] and "中断" in vid["images"]["v2"]["error"], f"清扫 {n} 行")

# ---------- C. skills 轮询端内存 miss 回退（拆解 partial 收回）----------
DJ = "jt_dec_orphan"
jobstore.create_job(DJ, "decompose", {"phase": "images"})
jobstore.save_state(DJ, {
    "phase": "images", "progress": {"done": 2, "total": 6},
    "assets": [
        {"type": "character", "name": "老陈", "description": "侦探", "visual_notes": "", "image_url": "/agent-service/assets/dingzhuang.png",
         "looks": [{"label": "雨夜", "description": "风衣", "image_url": "/agent-service/assets/look.png"}]},
        {"type": "scene", "name": "茶馆", "description": "夜", "visual_notes": ""},
    ],
    "errors": {},
    "error": None,
})
dec = skills.get_decompose_job(DJ)
check("C1 拆解孤儿带回 partial（定妆照+Look 图在）",
      dec is not None and dec["status"] == "done" and "中断" in dec["error"]
      and dec["assets"][0]["image_url"].endswith("dingzhuang.png")
      and dec["assets"][0]["looks"][0]["image_url"].endswith("look.png"),
      str((dec or {}).get("error")))
SG = "jt_sg_orphan"
jobstore.create_job(SG, "shotlist_gen", {"rows": None, "error": None})
sg = skills.get_storyboard_gen_job(SG)
check("C2 分镜生成孤儿可查（不再 404 盲区）",
      sg is not None and sg["status"] == "done" and "中断" in str(sg.get("error")))

# ---------- D. HTTP 层（agent 在跑时）----------
try:
    token = ""
    req = urllib.request.Request(
        "http://127.0.0.1:8123/api/v1/auth/token",
        data=f"username={env_local('AUTH_USERNAME') or 'admin'}&password={env_local('AUTH_PASSWORD')}".encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        token = json.load(r).get("access_token", "")
    if not token:
        raise RuntimeError("未取到 token")
    DJ2 = "jt_http_orphan"
    jobstore.create_job(DJ2, "decompose", {"phase": "images"})
    jobstore.save_state(DJ2, {"phase": "images", "assets": [{"type": "prop", "name": "名单", "description": "d", "visual_notes": "", "image_url": "/agent-service/assets/prop.png"}], "errors": {}})
    req = urllib.request.Request(
        f"http://127.0.0.1:8123/assets/decompose/{DJ2}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        body = json.load(r)
    check("D1 GET 拆解孤儿：200 + 中断 + partial（agent 内存无此任务）",
          body["status"] == "done" and "中断" in body["error"] and body["assets"][0]["image_url"].endswith("prop.png"),
          str(body.get("error")))
    jobstore.finish_job(DJ2, {"phase": "done", "assets": [], "error": None})
except Exception as exc:  # noqa: BLE001
    check("D1 GET 拆解孤儿", False, f"agent 未在跑或请求失败：{exc}")

# ---------- 清理种子行 ----------
con = sqlite3.connect(imagejobs.DB_PATH)
for jid in (JID, JID2, JID3, JID4, IJ, VJ, DJ, SG, "jt_http_orphan"):
    con.execute("DELETE FROM async_jobs WHERE job_id = ?", (jid,))
    con.execute("DELETE FROM image_jobs WHERE job_id = ?", (jid,))
    con.execute("DELETE FROM video_jobs WHERE job_id = ?", (jid,))
con.commit()
con.close()
print("种子行已清理")

failed = [n for n, ok in RESULTS if not ok]
print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
sys.exit(1 if failed else 0)
