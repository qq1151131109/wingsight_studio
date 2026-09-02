"""OpenAI 兼容图像生成组件（默认 DMXAPI 中转）。

比例优先、清晰度其次：输出比例由 aspect_ratio 唯一决定，resolution 只决定
短边档位（竖版比例的短边是宽度）；合法尺寸取 (aw*16, ah*16) 的整数倍，
比例零偏差且天然满足 gpt-image-2 宽高被 16 整除的约束。
有参考图走 images.edit（图生图），无参考图走 images.generate。
"""

from __future__ import annotations

import asyncio
import base64
import math
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DropdownInput, MessageTextInput, SecretStrInput
from lfx.schema.data import Data
from lfx.template.field.base import Output
from lfx.utils.ssrf_httpx import ssrf_protected_openai_clients_for_url

# 清晰度档位 = 短边下限（与 juben aspect_size 语义一致，竖版比例的短边是
# 宽度）：取 (aw*16, ah*16) 网格上短边不低于档位的最小倍数。
# 16:9 → 1K=2048x1152 / 2K=2560x1440 / 4K=3840x2160；9:16 1K=1152x2048。
_RESOLUTION_SHORT_EDGE = {"1K": 1024, "2K": 1440, "4K": 2160}
_ROUND_TO = 16
_RATIO_SPLIT_RE = re.compile(r"^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$")
# 单次尝试上限（DMX 4K 档图生图实测可超 180s；与 responses/gemini 通道的
# httpx timeout=300 对齐。openai SDK 默认 max_retries=2，最坏 3×本值，调用方
# agent 的 run_flow_blocking 只等 300s——首尝试必须在此窗口内返回才有意义）
_TIMEOUT_SECONDS = 300.0

# 质量档位一律 high（gpt-image 系 images 接口质量参数，DMX 实测
# generate/edit 通道均接受；high=最细渲染档，output_tokens 随之最高）
_IMAGE_QUALITY = "high"

# OpenAI 异步客户端类占位：默认 None，首次出图时经 _load_async_openai 懒加载
# （lfx 组件模块导入期不拉起 openai）；挂为模块级名字便于测试 monkeypatch。
AsyncOpenAI: Any = None


def _load_async_openai() -> Any:
    """懒加载 openai.AsyncOpenAI（首次之后命中 sys.modules 缓存，开销可忽略）。"""
    import openai

    return openai.AsyncOpenAI


def compute_image_size(aspect_ratio: str, resolution: str = "1K") -> tuple[int, int]:
    """计算输出尺寸：比例零偏差、两边被 16 整除、短边不低于档位。"""
    match = _RATIO_SPLIT_RE.match(str(aspect_ratio))
    if not match:
        msg = f"无法解析比例：{aspect_ratio}（支持 w:h 形如 16:9 / 4:3）"
        raise ValueError(msg)
    aw, ah = int(match.group(1)), int(match.group(2))
    if aw <= 0 or ah <= 0:
        msg = f"比例不合法：{aspect_ratio}"
        raise ValueError(msg)
    short = _RESOLUTION_SHORT_EDGE.get(str(resolution))
    if short is None:
        msg = f"不支持的清晰度档位：{resolution}（支持 1K / 2K / 4K）"
        raise ValueError(msg)
    unit_w, unit_h = aw * _ROUND_TO, ah * _ROUND_TO
    multiple = max(1, math.ceil(short / min(unit_w, unit_h)))
    return unit_w * multiple, unit_h * multiple


async def generate_image(
    prompt: str,
    *,
    model: str,
    base_url: str,
    api_key: str,
    aspect_ratio: str = "16:9",
    resolution: str = "1K",
    reference_images: list[str] | None = None,
    dest_dir: Path | None = None,
) -> dict[str, Any]:
    """调用 OpenAI 兼容 images 接口出一张图：有参考图走 edit，无走 generate。"""
    width, height = compute_image_size(aspect_ratio, resolution)
    size = f"{width}x{height}"
    clients = ssrf_protected_openai_clients_for_url(base_url)
    client_cls = AsyncOpenAI or _load_async_openai()
    client_kwargs: dict[str, Any] = {
        "api_key": api_key,
        "base_url": base_url,
        "timeout": _TIMEOUT_SECONDS,
    }
    # openai v1/v2 构造参数差异 + SSRF 校验为空时返回 None：都降级为不传该参数
    async_client = clients.get("http_async_client")
    if async_client is not None:
        try:
            client = client_cls(**client_kwargs, http_async_client=async_client)
        except TypeError:
            client = client_cls(**client_kwargs)
    else:
        client = client_cls(**client_kwargs)

    ref_files: list[bytes] = []
    ref_suffixes: list[str] = []
    for ref in reference_images or []:
        path = Path(ref)
        if path.is_file():
            ref_files.append(await asyncio.to_thread(path.read_bytes))
            ref_suffixes.append(path.suffix or ".png")

    common = {"model": model, "prompt": prompt, "size": size, "n": 1, "quality": _IMAGE_QUALITY}
    try:
        if ref_files:
            import io

            files = [
                (f"ref_{i}{sfx}", io.BytesIO(data), "application/octet-stream")
                for i, (data, sfx) in enumerate(zip(ref_files, ref_suffixes, strict=True))
            ]
            response = await client.images.edit(image=files, **common)
        else:
            response = await client.images.generate(**common)
    except Exception as exc:
        msg = f"图像生成失败（model={model}）：{exc}"
        raise ValueError(msg) from exc
    finally:
        # 每次调用都新建客户端（含底层 httpx.AsyncClient），批量出图场景用完即关，
        # 防止连接堆积与 ResourceWarning；测试注入的假客户端可能没有 close，防御处理。
        close = getattr(client, "close", None)
        if close is not None:
            await close()

    data = getattr(response, "data", None) or []
    if not data:
        msg = f"图像生成响应为空（model={model}），可能触发内容安全过滤"
        raise ValueError(msg)
    item = data[0]
    b64 = getattr(item, "b64_json", None)
    url = getattr(item, "url", None)
    if not b64 and not url:
        msg = "图像生成响应既无 b64_json 也无 url"
        raise ValueError(msg)

    target_dir = Path(dest_dir) if dest_dir else Path(tempfile.mkdtemp(prefix="gen_image_"))
    target_dir.mkdir(parents=True, exist_ok=True)
    # uuid 后缀防止并发/批量出图时同名覆盖
    path = target_dir / f"image_{uuid.uuid4().hex[:12]}.png"

    def _save() -> None:
        try:
            if b64:
                path.write_bytes(base64.b64decode(b64))
            else:
                from lfx.utils.ssrf_httpx import ssrf_safe_httpx_get

                path.write_bytes(ssrf_safe_httpx_get(str(url), timeout=60.0).content)
        except Exception as exc:
            msg = f"图像保存失败：{exc}"
            raise ValueError(msg) from exc

    await asyncio.to_thread(_save)
    return {"path": str(path), "width": width, "height": height, "model": model}


class ImageGenerationComponent(Component):
    display_name = "图像生成"
    description = "OpenAI 兼容图像生成（默认 DMXAPI）：有参考图走图生图，无参考图走文生图。"
    icon = "Image"
    name = "ImageGeneration"

    inputs = [
        MessageTextInput(name="prompt", display_name="提示词"),
        MessageTextInput(
            name="reference_paths",
            display_name="参考图路径",
            info="可选。本地图片路径，逗号或换行分隔；留空走纯文生图",
            advanced=True,
        ),
        DropdownInput(
            name="model_name",
            display_name="模型",
            options=["gpt-image-2-03", "gpt-image-2", "doubao-seedream-5-0-pro-260628", "gemini-3.1-flash-image"],
            value="gpt-image-2-03",
            combobox=True,
            info="任意 OpenAI 兼容 images 模型名",
        ),
        MessageTextInput(name="base_url", display_name="Base URL", value="https://www.dmxapi.cn/v1"),
        SecretStrInput(name="api_key", display_name="API Key", info="可引用全局变量 dmx_api_key"),
        DropdownInput(
            name="aspect_ratio", display_name="比例", options=["16:9", "9:16", "1:1", "4:3", "3:4"], value="16:9"
        ),
        DropdownInput(name="resolution", display_name="清晰度", options=["1K", "2K", "4K"], value="1K", advanced=True),
    ]

    outputs = [Output(display_name="图像", name="image", method="generate")]

    async def generate(self) -> Data:
        refs = [p.strip() for p in re.split(r"[,\n]", self.reference_paths or "") if p.strip()]
        result = await generate_image(
            self.prompt,
            model=self.model_name,
            base_url=self.base_url,
            api_key=self.api_key,
            aspect_ratio=self.aspect_ratio,
            resolution=self.resolution,
            reference_images=refs,
        )
        self.status = result["path"]
        return Data(data=result, text=result["path"])
