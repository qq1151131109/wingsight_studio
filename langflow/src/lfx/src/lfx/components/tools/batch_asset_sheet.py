"""批量资产出图：剧本拆解出的资产清单 → 每资产搜参考图 → 按布局契约出设定图。

并发信号量限流；单资产失败不中断批次；每张完成 send_message 实时推送
（Playground 聊天卡片 / 未来专用前端 SSE 事件源）。布局契约移植 juben
``lib/prompt_builders.py`` 的单阶段 sheet 版。
"""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from lfx.components.tools.image_generation import generate_image
from lfx.components.tools.volc_image_search import download_search_images, volc_image_search
from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DropdownInput, IntInput, MessageTextInput, MultilineInput, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.template.field.base import Output

_TYPE_LABELS = {"character": "角色", "scene": "场景", "prop": "道具"}
TYPE_ASPECT: dict[str, str] = {"character": "16:9", "scene": "16:9", "prop": "4:3"}

_TEXT_GUARD = "画面不得出现任何可读文字、标签、编号、水印或界面元素。"

LAYOUT_SPECS: dict[str, str] = {
    "character": (
        "横版 16:9 四格布局，纯白 (#FFFFFF) 背景：左侧约 40% 宽为胸像特写"
        "（清晰展示面部、发型、配饰、上装），右侧三个等宽面板分别为正面 / "
        "四分之三侧面 / 背面的 A-Pose 全身视图，保持静态白底角色资产。"
    ),
    "scene": (
        "可复用场景空间基准图，无人空镜，只展示空间本身。以中性勘景视角完整呈现"
        "建筑、地貌、空间布局、固定陈设、材质与光线氛围，尺度与材质清晰可辨。"
        "画面中不出现人物、动物、剧情行为或临时活动。这是空间设计与勘景参考图，"
        "不是正在发生剧情的电影剧照。"
    ),
    "prop": (
        "可复用道具资产图，纯净浅灰背景。只采用下列一种匹配布局：单件立体物使用"
        "正面、45° 侧面与结构细节；大型器械使用完整侧视、三分之四视角或机构细节；"
        "文字标牌以正面文字主视图为核心；物件集合按类别完整陈列，每件保持独立形制；"
        "平面文书使用正面全貌与材质细节。所有视图必须展示同一件道具。"
    ),
}

_REFERENCE_NOTE = "参考图用于锁定形制、材质与色彩：继承参考图中的实物特征，不复刻参考图的白底、版式、水印或文字。"


async def _resolve_reference_image(source: str, dest_dir: Path) -> str | None:
    """Payload 内参考图解析：本地路径直用，http(s) 下载到 dest_dir，其余忽略。

    供调用方（agent 直连出图）传入角色定妆照等一致性锚点图；失败返回 None
    由调用方降级（少一张参考不影响出图）。
    """
    if not source:
        return None
    local = Path(source)
    if local.is_file():
        return str(local)
    if not source.startswith(("http://", "https://")):
        return None
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^A-Za-z0-9._-]", "", source.rsplit("/", 1)[-1]) or "ref.png"
        target = dest_dir / f"{int(time.time() * 1000)}_{stem}"
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(source)
            resp.raise_for_status()
            target.write_bytes(resp.content)
        return str(target)
    except Exception:  # noqa: BLE001 — 单张参考下载失败不影响出图
        return None


_DEFAULT_TEMPLATE = """{layout}

资产事实（唯一事实来源，没写的不编）：
- 名称：{name}
- 描述：{description}
- 视觉要点：{visual_notes}

{_reference_note}图内为单件资产设定图，不添加任何其他角色或道具。
{_text_guard}"""


def render_asset_prompt(asset: dict[str, Any], template: str | None = None) -> str:
    """按资产类型渲染出图提示词；自定义模板整体替换（含标题行）。"""
    asset_type = str(asset.get("type") or "")
    if asset_type not in LAYOUT_SPECS:
        msg = f"未知资产类型：{asset_type}"
        raise ValueError(msg)
    values = {
        "layout": LAYOUT_SPECS[asset_type],
        "name": str(asset.get("name") or ""),
        "description": str(asset.get("description") or ""),
        "visual_notes": str(asset.get("visual_notes") or ""),
        "type": asset_type,
        "_reference_note": _REFERENCE_NOTE,
        "_text_guard": _TEXT_GUARD,
    }
    if template:
        return template.format(**values)
    body = _DEFAULT_TEMPLATE.format(**values)
    return f"{_TYPE_LABELS[asset_type]}设定图：{values['name']}\n\n{body}"


def parse_assets_payload(text: str, max_assets: int = 10) -> list[dict[str, Any]]:
    """容错解析资产清单 JSON：剥 code fence、整段优先 / 首尾大括号截取兜底。

    ``{"assets": [...]}`` 对象与裸 ``[...]`` 数组都接受；过滤未知类型与缺名
    称的条目，并截断到 ``max_assets``。完全不是 JSON 时抛中文 ValueError。
    """
    raw = str(text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    payload: Any = None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            msg = "资产清单不是合法 JSON：找不到 JSON 对象"
            raise ValueError(msg) from None
        try:
            payload = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as exc:
            msg = f"资产清单不是合法 JSON：{exc}"
            raise ValueError(msg) from exc
    assets = payload.get("assets") if isinstance(payload, dict) else payload if isinstance(payload, list) else None
    if not isinstance(assets, list):
        msg = '资产清单 JSON 缺少 "assets" 数组'
        raise ValueError(msg)  # noqa: TRY004 — 类型不符也按用户契约报中文 ValueError
    valid = [
        {
            "type": str(a.get("type") or ""),
            "name": str(a.get("name") or ""),
            "description": str(a.get("description") or ""),
            "visual_notes": str(a.get("visual_notes") or ""),
            "search_query": str(a.get("search_query") or ""),
        }
        for a in assets
        if isinstance(a, dict) and str(a.get("type") or "") in LAYOUT_SPECS and str(a.get("name") or "").strip()
    ]
    return valid[:max_assets]


class BatchAssetSheetComponent(Component):
    display_name = "批量资产出图"
    description = "资产清单 JSON → 逐资产豆包搜参考图 → 按布局契约并发生成设定图，每张完成实时推送。"
    icon = "LayoutGrid"
    name = "BatchAssetSheet"

    inputs = [
        MultilineInput(
            name="assets_payload",
            display_name="资产清单 JSON",
            info=(
                '{"assets": [{"type": "character|scene|prop", "name", "description", "visual_notes", "search_query"}]}'
            ),
        ),
        SecretStrInput(name="search_api_key", display_name="豆包搜索 Key", info="可引用全局变量 volc_search_api_key"),
        SecretStrInput(name="api_key", display_name="DMXAPI Key", info="可引用全局变量 dmx_api_key"),
        MessageTextInput(name="model_name", display_name="模型", value="gpt-image-2-03", advanced=True),
        MessageTextInput(name="base_url", display_name="Base URL", value="https://www.dmxapi.cn/v1", advanced=True),
        IntInput(name="concurrency", display_name="并发数", value=3, advanced=True),
        IntInput(name="max_assets", display_name="资产数上限", value=10, advanced=True),
        IntInput(name="reference_count", display_name="参考图数", value=3, advanced=True),
        DropdownInput(name="resolution", display_name="清晰度", options=["1K", "2K", "4K"], value="1K", advanced=True),
        MultilineInput(
            name="prompt_template",
            display_name="自定义模板",
            value="",
            advanced=True,
            info="可选。变量：{layout} {name} {description} {visual_notes} {type}",
        ),
    ]

    outputs = [Output(display_name="结果", name="results", method="run_asset_sheets")]

    async def run_asset_sheets(self) -> list[Data]:
        """逐资产：搜参考图（失败回退文生图）→ 按布局契约出设定图 → 推送结果。

        配置类错误（要用搜索却未配 Key）在并发前整批抛错红标；
        网络/单次搜索失败只降级纯文生图，不中断批次。
        """
        assets = parse_assets_payload(self.assets_payload, max_assets=int(self.max_assets or 10))
        if not assets:
            msg = "资产清单为空：没有可生成的 character / scene / prop 资产"
            raise ValueError(msg)
        if any(a.get("search_query") for a in assets) and not (self.search_api_key or "").strip():
            msg = "未配置豆包搜索 API Key：请在「豆包搜索 Key」字段填写或引用全局变量 volc_search_api_key"
            raise ValueError(msg)
        semaphore = asyncio.Semaphore(max(1, min(int(self.concurrency or 3), 5)))
        out_dir = Path(tempfile.gettempdir()) / "asset_sheets" / str(int(time.time()))

        async def _one(asset: dict[str, Any]) -> Data:
            name = asset["name"]
            asset_type = asset["type"]
            started = time.monotonic()
            record: dict[str, Any] = {
                "name": name,
                "type": asset_type,
                "status": "failed",
                "image_path": None,
                "reference_count": 0,
                "error": None,
                "elapsed_seconds": 0.0,
            }
            async with semaphore:
                try:
                    refs: list[dict[str, Any]] = []
                    payload_refs = asset.get("reference_images") or []
                    if payload_refs:
                        # 调用方显式给的参考图（如角色定妆照）优先于搜索：
                        # 这是资产一致性锚点，搜图只用于无锚点的陌生事物
                        for src in payload_refs[: int(self.reference_count or 3)]:
                            path = await _resolve_reference_image(str(src), out_dir / asset_type / "refs")
                            if path:
                                refs.append({"local_path": path})
                        if len(refs) < len(payload_refs):
                            self.log(
                                f"部分 payload 参考图不可用（{name}）：{len(payload_refs)} 张中 {len(refs)} 张可用"
                            )
                    elif asset.get("search_query"):
                        try:
                            results = await volc_image_search(
                                asset["search_query"], self.search_api_key, limit=int(self.reference_count or 3)
                            )
                            refs = await download_search_images(
                                results,
                                max_images=int(self.reference_count or 3),
                                dest_dir=out_dir / asset_type / "refs",
                            )
                        except Exception as exc:  # noqa: BLE001 — 搜索失败回退纯文生图（降级留痕可调试）
                            self.log(f"豆包搜图失败，回退纯文生图（{name}）：{exc}")
                            refs = []
                    record["reference_count"] = len(refs)
                    prompt = render_asset_prompt(asset, template=self.prompt_template or None)
                    image = await generate_image(
                        prompt,
                        model=self.model_name,
                        base_url=self.base_url,
                        api_key=self.api_key,
                        aspect_ratio=TYPE_ASPECT[asset_type],
                        resolution=self.resolution,
                        reference_images=[r["local_path"] for r in refs],
                        dest_dir=out_dir / asset_type,
                    )
                    record["image_path"] = image["path"]
                    await self.send_message(Message(text=f"{_TYPE_LABELS[asset_type]} · {name}", files=[image["path"]]))
                    record["status"] = "ok"  # 推送成功才置 ok，避免推送失败时 ok+error 矛盾
                except Exception as exc:  # noqa: BLE001 — 单资产失败不中断批次
                    record["error"] = str(exc)[:300]
            record["elapsed_seconds"] = round(time.monotonic() - started, 1)
            return Data(data=record, text=f"{name}: {record['status']}")

        results = await asyncio.gather(*(_one(a) for a in assets))
        failed = [r for r in results if r.data["status"] == "failed"]
        self.status = f"{len(results) - len(failed)}/{len(results)} 成功"
        # 全部失败才发批次通知；部分失败不发（成功资产已逐张推送，失败明细在结果 Data）
        if failed and len(failed) == len(results):
            names = "、".join(r.data["name"] for r in failed)
            await self.send_message(Message(text=f"批次失败：全部 {len(failed)} 个资产未生成（{names}），详见结果输出"))
        return list(results)
