"""分镜 rows 单测：场次字段透传 + 名单外资产不静默丢弃。

运行：cd agent && uv run python test_storyboard_rows.py
不需要 langflow / LLM / 网络——flow 调用被替换成固定返回串。

背景：分镜行申报的资产名此前在按名单二次校验时被直接丢掉（防幻觉的副
作用），「他穿囚衣」而画布没这张卡的信息就此蒸发——换装服饰/关键道具
漏拆的唯一发现回路断了。本测试锁两件事：剔除的名字必须回报；场次字段
（相邻镜头连贯参考的配对依据）必须透传。
"""

from __future__ import annotations

import asyncio
import json
import os

import skills

PASS = [0]


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


FLOW_OUT = json.dumps(
    [
        {
            "scene": "御书房·夜",
            "shotSize": "近景",
            "cameraMove": "推",
            "duration": 5,
            "action": "@小雨 在案前展开密信",
            "lighting": "烛光侧照，暖黄",
            "sound": "烛火轻响",
            "dialogue": "",
            "assets": ["小雨", "御书房", "囚衣"],
        },
        {
            "scene": "御书房·夜",
            "shotSize": "特写",
            "cameraMove": "固定",
            "duration": 3,
            "action": "密信上的火漆印",
            "lighting": "烛光侧照，暖黄",
            "sound": "",
            "dialogue": "",
            "assets": ["密信", "囚衣"],
        },
    ],
    ensure_ascii=False,
)

os.environ.setdefault("LANGFLOW_SHOTLIST_FLOW_ID", "test-flow-id")


async def fake_flow(*_a, **_kw) -> str:
    return FLOW_OUT


async def main() -> None:
    skills.run_flow_blocking = fake_flow  # type: ignore[assignment]
    roster = [
        {"type": "character", "name": "小雨"},
        {"type": "scene", "name": "御书房"},
        {"type": "prop", "name": "密信"},
    ]
    rows, missing = await skills.run_storyboard_flow("剧本", assets=roster)

    # 场次透传（同场两镜同名，前端据此配相邻镜头连贯参考）
    expect(
        [r["scene"] for r in rows] == ["御书房·夜", "御书房·夜"],
        f"场次应逐行透传：{[r['scene'] for r in rows]}",
    )
    # 名单内资产保留（行 refIds 绑定的来源）
    expect(rows[0]["assets"] == ["小雨", "御书房"], f"名单内保留：{rows[0]['assets']}")
    expect(rows[1]["assets"] == ["密信"], f"名单内保留：{rows[1]['assets']}")
    # 名单外的名字剔除、但按出现顺序回报（去重）
    expect(missing == ["囚衣"], f"名单外资产应回报：{missing}")
    # 其余字段照旧
    expect(rows[0]["rid"] == "r1" and rows[1]["rid"] == "r2", "rid 递增")
    expect(rows[0]["shotSize"] == "近景", "景别透传")
    expect(rows[0]["duration"] == "5", "时长转字符串")

    # 名单为空（画布还没拆资产）：全部名字都算缺、全部回报
    rows2, missing2 = await skills.run_storyboard_flow("剧本", assets=[])
    expect(all(r["assets"] == [] for r in rows2), "名单为空时行资产清空")
    expect(
        missing2 == ["小雨", "御书房", "囚衣", "密信"],
        f"名单为空时应回报全部名字且去重：{missing2}",
    )

    # 场次缺失（老 flow 输出/手改）不炸，落空串
    async def flow_no_scene(*_a, **_kw) -> str:
        return '[{"shotSize":"全景","assets":[]}]'

    skills.run_flow_blocking = flow_no_scene  # type: ignore[assignment]
    rows3, _ = await skills.run_storyboard_flow("剧本", assets=roster)
    expect(rows3[0]["scene"] == "", f"缺场次落空串：{rows3[0].get('scene')!r}")

    print(f"✅ 分镜 rows {PASS[0]} 项断言全部通过")


asyncio.run(main())
