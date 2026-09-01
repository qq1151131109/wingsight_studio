"""批量资产出图：剧本拆解出的资产清单 → 每资产搜参考图 → 按布局契约出设定图。

并发信号量限流；单资产失败不中断批次；每张完成 send_message 实时推送
（Playground 聊天卡片 / 未来专用前端 SSE 事件源）。布局契约移植 juben
``lib/prompt_builders.py`` 的单阶段 sheet 版。
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from lfx.components.tools.image_generation import generate_image
from lfx.components.tools.volc_image_search import download_search_images, volc_image_search
from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DropdownInput, IntInput, MessageTextInput, MultilineInput, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.template.field.base import Output

_TYPE_LABELS = {"character": "角色", "scene": "场景", "prop": "道具", "shot": "镜头"}
TYPE_ASPECT: dict[str, str] = {"character": "16:9", "scene": "16:9", "prop": "4:3", "shot": "16:9"}

# seedream 5.x 系不在 OpenAI images 接口上（404），走 /v1/responses 多图融合
# 接口（2~10 参考图融合成一张，DMXAPI 2026-08 文档）：按模型名前缀分流
_RESPONSES_MODEL_PREFIXES = ("doubao-seedream-5",)

# gemini 系（Nano Banana）走 v1beta generateContent 接口（DMXAPI，
# 认证 x-goog-api-key）：按模型名前缀分流
_GEMINI_MODEL_PREFIXES = ("gemini",)

# responses 接口 size 显式像素值域 [1280x720(921600), 2048x2048(4194304)]，
# 总像素超上限直接拒（4K 档必超，目录侧也不开放该档）
_RESPONSES_MAX_PIXELS = 4194304

_TEXT_GUARD = "画面不得出现任何可读文字、标签、编号、水印或界面元素。"

LAYOUT_SPECS: dict[str, str] = {
    "character": (
        "横版 16:9 四格构图：左侧约 40% 宽为同一人物的胸像特写（清晰展示"
        "面部、发型、配饰、上装），右侧三个等宽面板分别为正面、四分之三"
        "侧面与背面的自然站姿全身视图。四个面板必须是同一人物同一套造型，"
        "人物的媒介、质感、皮肤与材质渲染严格遵循下方全局视觉风格。"
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
    "shot": (
        "横版电影剧情剧照，整张图只有一个画幅内的连续叙事画面：呈现描述中的"
        "人物在场景环境里正在发生的动作瞬间，机位、景别与光线服务剧情，环境"
        "透视与人物比例真实自然。出场人物的面部、发型与服装严格遵循参考图"
        "锁定，但必须融入本画面场景——绝不能复刻参考图的多格排版，不得出现"
        "分格、并排多视图、转面陈列或白底设定图版式。"
    ),
}

_REFERENCE_NOTE = "参考图用于锁定形制、材质与色彩：继承参考图中的实物特征，不复刻参考图的白底、版式、水印或文字。"

# 尾注按类型分：shot 是剧照不是设定图，防「设定图」措辞把版式带偏
_TYPE_TAILS: dict[str, str] = {
    "shot": "整张图是单幅剧情剧照，不是资产设定图。",
}
_DEFAULT_TAIL = "图内为单件资产设定图，不添加任何其他角色或道具。"

_DEFAULT_TEMPLATE = """{layout}

全局视觉风格（整张图的媒介、质感与调色以此为准，务必遵循）：
{visual_notes}

资产事实（唯一事实来源，没写的不编）：
- 名称：{name}
- 描述：{description}

{_reference_note}{_type_tail}
{_text_guard}"""


async def generate_image_gemini(
    prompt: str,
    *,
    model: str,
    base_url: str,
    api_key: str,
    aspect_ratio: str,
    resolution: str = "1K",
    dest_dir: Path,
    reference_images: list[str],
) -> dict[str, Any]:
    """gemini 系（Nano Banana）v1beta generateContent 出图原语。

    POST {base_url}/v1beta/models/{model}:generateContent：generationConfig
    显式声明 responseModalities=IMAGE 与 imageConfig（aspectRatio + imageSize
    1K/2K/4K），幅面与分辨率由接口参数精确控制（非提示词尾注）。参考图以
    inlineData 部分并入 contents（一致性锚点）。认证用 x-goog-api-key——
    实测 Authorization Bearer 会挂起不返回，勿改。返回 {"path", "model"}。
    """
    import httpx

    from lfx.utils.ssrf_httpx import validate_url_for_ssrf_or_raise

    root = str(base_url).rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]  # base_url 含 OpenAI 风格 /v1 前缀，gemini 走 /v1beta 需剥掉
    url = f"{root}/v1beta/models/{model}:generateContent"
    validate_url_for_ssrf_or_raise(url)
    parts: list[dict[str, Any]] = [{"text": prompt}]
    for ref in reference_images[:5]:
        path = Path(ref)
        if not path.is_file():
            continue
        raw = await asyncio.to_thread(path.read_bytes)
        mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        parts.append(
            {"inlineData": {"mimeType": mime, "data": base64.b64encode(raw).decode()}}
        )
    # DMX 网关把 aspectRatio 按「高:宽」解析（实测 16:9 出 768x1376 竖版、
    # 9:16 出 1376x768 横版，与 Google 官方 w:h 语义倒置）：发送前翻转补偿；
    # 若 DMX 修正为官方语义（发 16:9 出横版），移除本翻转
    ar = aspect_ratio
    ar_parts = ar.split(":")
    if len(ar_parts) == 2 and ar_parts[0].isdigit() and ar_parts[1].isdigit():
        ar = f"{ar_parts[1]}:{ar_parts[0]}"
    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": ar, "imageSize": resolution or "1K"},
        },
    }
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                url,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                json=payload,
            )
    except Exception as exc:
        msg = f"图像生成失败（model={model}）：{exc}"
        raise ValueError(msg) from exc
    if response.status_code != 200:
        msg = f"图像生成失败（model={model}）：HTTP {response.status_code} {response.text[:300]}"
        raise ValueError(msg)
    cparts = ((response.json() or {}).get("candidates") or [{}])[0].get("content", {}).get("parts") or []
    inline = next((p.get("inlineData") for p in cparts if p.get("inlineData")), None)
    if not inline or not inline.get("data"):
        msg = "图像生成响应未包含图片（可能触发内容安全过滤）"
        raise ValueError(msg)
    ext = "png" if inline.get("mimeType") == "image/png" else "jpg"

    target_dir = Path(dest_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"image_{uuid.uuid4().hex[:12]}.{ext}"

    def _save() -> None:
        try:
            path.write_bytes(base64.b64decode(inline["data"]))
        except Exception as exc:
            msg = f"图像保存失败：{exc}"
            raise ValueError(msg) from exc

    await asyncio.to_thread(_save)
    return {"path": str(path), "model": model}


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
        "_type_tail": _TYPE_TAILS.get(asset_type, _DEFAULT_TAIL),
        "_text_guard": _TEXT_GUARD,
    }
    if template:
        return template.format(**values)
    body = _DEFAULT_TEMPLATE.format(**values)
    noun = "剧照" if asset_type == "shot" else "设定图"
    return f"{_TYPE_LABELS[asset_type]}{noun}：{values['name']}\n\n{body}"


async def generate_image_responses(
    prompt: str,
    *,
    model: str,
    base_url: str,
    api_key: str,
    aspect_ratio: str,
    resolution: str,
    reference_images: list[str],
    dest_dir: Path,
) -> dict[str, Any]:
    """seedream 5.x 专属出图原语：POST {base_url}/responses 同步出一张图。

    与 OpenAI images 接口的差异：提示词字段叫 input；参考图走 image 数组
    （URL 或 base64 data URL，本地文件统一转 data URL，免二次下载）；
    size 两种语义不可混用——1K/2K 档用显式像素（幅面精确），超像素上限
    的档位直接报中文错（目录侧不开放 4K）。产物 watermark 恒关（设定图
    不留 AI 水印标识）。落盘逻辑与 lfx generate_image 一致（uuid 文件名
    防并发覆盖、产物 URL 走 SSRF 安全下载）。
    """
    import httpx

    from lfx.components.tools.image_generation import compute_image_size
    from lfx.utils.ssrf_httpx import ssrf_safe_httpx_get, validate_url_for_ssrf_or_raise

    width, height = compute_image_size(aspect_ratio, resolution)
    if width * height > _RESPONSES_MAX_PIXELS:
        msg = f"{model} 不支持 {resolution} 档（{width}x{height} 超出 responses 接口像素上限）"
        raise ValueError(msg)
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "size": f"{width}x{height}",
        "output_format": "png",
        "response_format": "url",
        "watermark": False,
    }
    images: list[str] = []
    for ref in reference_images[:10]:
        path = Path(ref)
        if not path.is_file():
            continue
        raw = await asyncio.to_thread(path.read_bytes)
        images.append(f"data:image/png;base64,{base64.b64encode(raw).decode()}")
    if images:
        payload["image"] = images

    url = f"{str(base_url).rstrip('/')}/responses"
    validate_url_for_ssrf_or_raise(url)
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(url, headers={"Authorization": f"Bearer {api_key}"}, json=payload)
    except Exception as exc:
        msg = f"图像生成失败（model={model}）：{exc}"
        raise ValueError(msg) from exc
    if response.status_code != 200:
        msg = f"图像生成失败（model={model}）：HTTP {response.status_code} {response.text[:200]}"
        raise ValueError(msg)
    data = (response.json() or {}).get("data") or []
    if not data:
        msg = f"图像生成响应为空（model={model}），可能触发内容安全过滤"
        raise ValueError(msg)
    item = data[0]
    b64 = item.get("b64_json")
    out_url = item.get("url")
    if not b64 and not out_url:
        msg = "图像生成响应既无 b64_json 也无 url"
        raise ValueError(msg)

    target_dir = Path(dest_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"image_{uuid.uuid4().hex[:12]}.png"

    def _save() -> None:
        try:
            if b64:
                path.write_bytes(base64.b64decode(b64))
            else:
                path.write_bytes(ssrf_safe_httpx_get(str(out_url), timeout=60.0).content)
        except Exception as exc:
            msg = f"图像保存失败：{exc}"
            raise ValueError(msg) from exc

    await asyncio.to_thread(_save)
    return {"path": str(path), "width": width, "height": height, "model": model}


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
            "aspect": _aspect_of(a),
        "reference_images": [str(u) for u in (a.get("reference_images") or []) if str(u).strip()][:5],
        }
        for a in assets
        if isinstance(a, dict) and str(a.get("type") or "") in LAYOUT_SPECS and str(a.get("name") or "").strip()
    ]
    return valid[:max_assets]


def _aspect_of(a: dict[str, Any]) -> str:
    """资产级画幅覆写（分镜图幅面用）；空 = 按类型的默认幅面。格式不对
    整批报错（调用方是本项目的 agent，畸形值属契约破坏，不静默回退）。"""
    raw = str(a.get("aspect") or "").strip()
    if not raw:
        return ""
    if not re.fullmatch(r"\d{1,2}:\d{1,2}", raw):
        msg = f"资产「{a.get('name')}」的画幅不合法：{raw}（应为 w:h，如 16:9 / 9:16）"
        raise ValueError(msg)
    return raw


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
                '{"assets": [{"type": "character|scene|prop|shot", "name", "description", "visual_notes", "search_query"}]}'
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
            msg = "资产清单为空：没有可生成的 character / scene / prop / shot 资产"
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
                    payload_refs = [str(u) for u in (asset.get("reference_images") or []) if str(u).strip()]
                    if payload_refs:
                        try:
                            refs = await download_search_images(
                                [{"url": u} for u in payload_refs],
                                max_images=len(payload_refs),
                                dest_dir=out_dir / asset_type / "payload_refs",
                            )
                        except Exception as exc:  # noqa: BLE001 — 设定图下载失败回退搜索/文生图
                            self.log(f"参考设定图下载失败，回退（{name}）：{exc}")
                            refs = []
                    if not refs and asset.get("search_query"):
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
                    common = dict(
                        model=self.model_name,
                        base_url=self.base_url,
                        api_key=self.api_key,
                        # 资产级画幅覆写（分镜图 9:16/21:9 等），空则按类型默认
                        aspect_ratio=asset.get("aspect") or TYPE_ASPECT[asset_type],
                        resolution=self.resolution,
                        reference_images=[r["local_path"] for r in refs],
                        dest_dir=out_dir / asset_type,
                    )
                    # seedream 5.x 走 responses 多图融合接口，其余走 OpenAI images
                    if str(self.model_name or "").startswith(_RESPONSES_MODEL_PREFIXES):
                        image = await generate_image_responses(prompt, **common)
                    elif str(self.model_name or "").startswith(_GEMINI_MODEL_PREFIXES):
                        image = await generate_image_gemini(prompt, **common)
                    else:
                        image = await generate_image(prompt, **common)
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
