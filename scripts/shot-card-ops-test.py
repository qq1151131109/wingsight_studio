"""E2E：聊天侧批量分镜图落卡 ops（与前端出图按钮同语义）。

python 直连 agent 模块（不经 LLM）：建临时项目 + 1 张带设定图的资产卡 +
分镜表（2 行）→ 绑线程 → 直接调 generate_asset_images 工具（1 镜真出图）
→ 断言返回带落卡 ops：add_node image（imageUrl/status/genShot/refIds）+
connect_nodes（分镜表→图卡、资产→图卡）+ update_node row 挂 imageNodeId，
位置在分镜表右侧网格。用后删项目。

运行：cd agent && uv run python ../scripts/shot-card-ops-test.py
（agent 在跑与否无关——工具内嵌调用；真出 1 张图约 30-60s）
"""

import asyncio
import json
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
sys.path.insert(0, str(AGENT_DIR))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(AGENT_DIR / ".env")
load_dotenv(AGENT_DIR.parent / ".env.local")

import projects  # noqa: E402
import graph  # noqa: E402

projects.init_db()

proj = projects.create_project(f"e2e-shotcard-{__import__('time').strftime('%H%M%S')}")
pid = proj["id"]
# tid 必须是纯 hex（projects._THREAD_ID_RE），带前缀/下划线会被回退成服务端
# 生成的新 id，绑定就断了（首轮 debug 就是栽在这）
tid = format(int(__import__("time").time() * 1000), "x")[-12:]
projects.create_thread(pid, "分镜落卡实测", tid=tid)

# 已有资产卡（带设定图，供 URL 反查连线；复用今日冒烟产的图）
ASSET_URL = "/agent-service/assets/f33a69fc801b.png"
projects.save_canvas(
    pid,
    nodes=[
        {
            "id": "n_ch_probe",
            "type": "character",
            "position": {"x": 0, "y": 0},
            "data": {"nodeType": "character", "title": "黄志恒", "imageUrl": ASSET_URL},
        },
        {
            "id": "SHOTLIST_PROBE",
            "type": "shotlist",
            "position": {"x": 400, "y": 0},
            "data": {
                "nodeType": "shotlist",
                "title": "分镜表",
                "rows": [
                    {"rid": "r1", "action": "八仙饭店夜景外拍", "assets": ["黄志恒"]},
                    {"rid": "r2", "action": "司法卷宗特写", "assets": []},
                ],
            },
        },
    ],
    edges=[],
    viewport={"x": 0, "y": 0, "zoom": 0.8},
)

assets_json = json.dumps(
    [
        {
            "type": "shot",
            "name": "镜头01·八仙饭店夜景",
            "description": "横版电影剧照：1980 年代澳门八仙饭店夜景门面，暖黄灯箱、蒸气、街道路面反光",
            "shotlist_id": "SHOTLIST_PROBE",
            "rid": "r1",
            "reference_images": [ASSET_URL],
            "reference_labels": [{"type": "character", "name": "黄志恒"}],
        }
    ],
    ensure_ascii=False,
)

out = asyncio.run(
    graph.generate_asset_images.ainvoke(
        {"assets_json": assets_json},
        config={"configurable": {"thread_id": tid}},
    )
)

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("✓" if ok else "✗") + f" {name}" + (f"  — {detail}" if detail else ""))

check("出图成功", "✓ 镜头01" in out, out.splitlines()[0][:80] if out else "空")
check("返回带落卡 ops 区块", "分镜图落卡 ops 已生成" in out)
ops = []
if "分镜图落卡 ops 已生成" in out:
    try:
        payload = out.split("：\n", 1)[1]
        # ops JSON 后可能跟「各资产实际发送提示词」附录（finalPrompt 通道）：
        # raw_decode 只吃前缀 JSON
        ops = json.JSONDecoder().raw_decode(payload)[0]["ops"]
    except Exception as exc:  # noqa: BLE001
        check("ops JSON 可解析", False, str(exc)[:80])

adds = [o for o in ops if o.get("op") == "add_node"]
conns = [o for o in ops if o.get("op") == "connect_nodes"]
row_updates = [o for o in ops if o.get("op") == "update_node"]
check("add_node image 卡 ×1", len(adds) == 1 and adds[0].get("nodeType") == "image")
if adds:
    a = adds[0]
    check("图卡带图与 ready", a.get("imageUrl", "").startswith("/agent-service/assets/") and a.get("status") == "ready")
    check("图卡标题=镜头01 图", a.get("title") == "镜头01 图", str(a.get("title")))
    check("genShot 快照齐全", a.get("genShot", {}).get("assetType") == "shot" and a.get("genShot", {}).get("referenceImages") == [ASSET_URL])
    check("genShot.finalPrompt=实际发送提示词", bool(str(a.get("genShot", {}).get("finalPrompt") or "").strip()), str(a.get("genShot", {}).get("finalPrompt"))[:60])
    check("refIds URL 反查命中资产卡", a.get("refIds") == ["n_ch_probe"], str(a.get("refIds")))
    check("位置在分镜表右侧", a["position"]["x"] >= 400 + 560 and a["position"]["y"] >= 0, str(a.get("position")))
check(
    "连线：分镜表→图卡 + 资产→图卡",
    any(c.get("fromId") == "SHOTLIST_PROBE" and c.get("toId") == "shotimg_r1" for c in conns)
    and any(c.get("fromId") == "n_ch_probe" and c.get("toId") == "shotimg_r1" for c in conns),
    f"{len(conns)} 条连线",
)
check(
    "行挂 imageNodeId=占位符",
    len(row_updates) == 1
    and row_updates[0].get("id") == "SHOTLIST_PROBE"
    and row_updates[0].get("row", {}).get("rid") == "r1"
    and row_updates[0].get("row", {}).get("imageNodeId") == "shotimg_r1",
)

projects.delete_project(pid)
print("✓ 测试项目已删除")
ok = all(results)
print(f"\n{'✓✓ 分镜落卡 ops 通过' if ok else '✗ 有环节未过'}（{sum(results)}/{len(results)}）")
sys.exit(0 if ok else 1)
