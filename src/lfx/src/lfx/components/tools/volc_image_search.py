"""豆包搜索（火山引擎联网搜索）图片搜索组件。

移植 juben ``lib/image_search/volc_search.py``：``SearchType=image`` 返回结构化
图片结果（URL/宽高）。搜到的前 N 张下载为本地参考图，供图像生成组件图生图。
"""

from __future__ import annotations

import asyncio
import io
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import IntInput, MessageTextInput, SecretStrInput
from lfx.schema.data import Data
from lfx.template.field.base import Output
from lfx.utils.ssrf_httpx import ssrf_safe_async_get, ssrf_safe_async_post

if TYPE_CHECKING:
    import httpx

_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search"
_TIMEOUT_SECONDS = 30.0
_MAX_IMAGE_RESULTS = 5
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY = 1.0
_ERR_AUTH = {10401}
_ERR_UNCONFIGURED = {10402, 10403}
_ERR_QUOTA = {10406, 10412}
_ERR_RATE_LIMIT = {700429}


async def volc_image_search(
    query: str,
    api_key: str,
    *,
    limit: int = 3,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """豆包图片搜索：query → 结构化图片结果（未去重的原始列表，最多 5 条）。"""
    if not api_key or not api_key.strip():
        msg = "未配置豆包搜索 API Key：请填写 volc_search_api_key（或引用全局变量）"
        raise ValueError(msg)
    query_text = str(query).strip()
    if not query_text:
        msg = "搜索关键词为空"
        raise ValueError(msg)
    normalized_limit = max(1, min(int(limit), _MAX_IMAGE_RESULTS))
    payload = {"Query": query_text, "SearchType": "image", "Count": normalized_limit}
    headers = {"Authorization": f"Bearer {api_key.strip()}"}

    attempt = 0
    while True:  # 重试循环恒经 return/raise 出口，无自然退出路径
        attempt += 1
        if client is not None:
            response = await client.post(_ENDPOINT, json=payload, headers=headers)
        else:
            response = await ssrf_safe_async_post(_ENDPOINT, json=payload, headers=headers, timeout=_TIMEOUT_SECONDS)
        body = _decode(response)
        error = (body.get("ResponseMetadata") or {}).get("Error") or {}
        code = error.get("CodeN")
        if code in _ERR_RATE_LIMIT and attempt < _RETRY_ATTEMPTS:
            await asyncio.sleep(_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
            continue
        if code in _ERR_AUTH:
            msg = "豆包搜索 API Key 无效：请到火山引擎「联网搜索控制台」确认 Key 正确"
            raise ValueError(msg)
        if code in _ERR_UNCONFIGURED:
            msg = "豆包搜索服务未开通：请到火山引擎「联网搜索控制台」开通图片搜索服务"
            raise ValueError(msg)
        if code in _ERR_QUOTA:
            msg = "豆包搜索额度不足：免费额度每月 500 次，请到控制台确认额度或升级套餐"
            raise ValueError(msg)
        if code is not None:
            msg = f"豆包搜索接口错误（CodeN={code}）：{error.get('Message') or '未知错误'}"
            raise ValueError(msg)
        return _normalize_results(body, limit=normalized_limit)


def _decode(response: httpx.Response) -> dict[str, Any]:
    if response.status_code >= 400:
        msg = f"豆包搜索请求失败（HTTP {response.status_code}）"
        raise ValueError(msg)
    return response.json()


def _normalize_results(payload: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    result = payload.get("Result")
    if not isinstance(result, dict):
        return []
    images = result.get("ImageResults")
    if not isinstance(images, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in images:
        if not isinstance(item, dict):
            continue
        info = item.get("Image") or {}
        image_url = str(info.get("Url") or "").strip()
        if not image_url or image_url in seen:
            continue
        seen.add(image_url)
        out.append(
            {
                "url": image_url,
                "width": _int_or_none(info.get("Width")),
                "height": _int_or_none(info.get("Height")),
                "title": str(item.get("Title") or "").strip(),
                "page_url": str(item.get("Url") or "").strip() or None,
            }
        )
        if len(out) >= limit:
            break
    return out


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def download_search_images(
    results: list[dict[str, Any]],
    *,
    max_images: int = 3,
    client: httpx.AsyncClient | None = None,
    dest_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """下载搜索结果图片到本地并做 PIL 校验；失败项跳过（上层回退纯文生图）。"""
    from PIL import Image

    target = Path(dest_dir) if dest_dir else Path(tempfile.mkdtemp(prefix="volc_refs_"))
    target.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, Any]] = []
    for item in results[:max_images]:
        url = str(item.get("url") or "")
        if not url:
            continue
        try:
            if client is not None:
                response = await client.get(url)
            else:
                response = await ssrf_safe_async_get(url, timeout=_TIMEOUT_SECONDS, follow_redirects=False)
            response.raise_for_status()
            image = Image.open(io.BytesIO(response.content))
            image.verify()
            suffix = Path(url.split("?")[0]).suffix or ".jpg"
            path = target / f"ref_{len(out) + 1}{suffix}"
            path.write_bytes(response.content)
        except Exception:  # noqa: BLE001, S112 — 单张失败不影响其余参考图，静默跳过
            continue
        out.append({**item, "local_path": str(path)})
    return out


class VolcImageSearchComponent(Component):
    display_name = "豆包搜图"
    description = "火山引擎豆包搜索（图片模式）：按关键词搜索并下载参考图。"
    icon = "Search"
    name = "VolcImageSearch"

    inputs = [
        MessageTextInput(name="query", display_name="搜索关键词"),
        SecretStrInput(
            name="api_key",
            display_name="API Key",
            info="火山引擎联网搜索 API Key，可引用全局变量 volc_search_api_key",
        ),
        IntInput(
            name="limit",
            display_name="参考图数量",
            value=3,
            advanced=True,
            info="下载前 N 张（1-5，豆包单次最多 5 条）",
        ),
    ]

    outputs = [Output(display_name="参考图", name="images", method="search_images")]

    async def search_images(self) -> list[Data]:
        results = await volc_image_search(self.query, self.api_key, limit=int(self.limit or 3))
        downloaded = await download_search_images(results, max_images=int(self.limit or 3))
        self.status = f"{len(downloaded)} 张参考图"
        return [Data(data=item, text=item.get("title") or item["url"]) for item in downloaded]
