# 剧本 → 资产设定图批量生成 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Langflow 中实现「输入剧本 → LLM 拆解资产清单 → 豆包搜图取参考 → 并发出设定图 → 聊天流逐张推送」的资产设定图批量生成能力。

**Architecture:** 3 个自定义组件（豆包搜图、OpenAI 兼容图像生成、批量资产出图编排）+ 1 个共用的飞书文档组件（宣发设计已定稿、本计划一并实施）+ 1 个生成脚本产出可导入的预置 flow。批量组件内部 `asyncio.Semaphore` 并发，每张图完成即 `send_message` 推送（Playground 卡片 + 未来专用前端的 SSE 事件源）。

**Tech Stack:** Python 3.10+ / lfx 组件体系（`Component` 基类）/ httpx + openai SDK / pytest（`ComponentTestBaseWithoutClient` + `httpx.MockTransport`）

## Global Constraints

- 组件放 `src/lfx/src/lfx/components/tools/`，注册进 `src/lfx/src/lfx/components/tools/__init__.py`（`_dynamic_imports` + `__all__`，按字母序）
- **类名一经发布不可改**（Langflow 以类名匹配已保存 flow）
- 所有出站 HTTP 必须走 `lfx.utils.ssrf_httpx` 的助手（`ssrf_safe_async_get/post`、`ssrf_protected_openai_clients_for_url`），禁止裸 `httpx.Client`/`AsyncClient`/`httpx.get`（`test_bundle_ssrf_wiring.py` 静态扫描约束）
- 所有用户可见错误信息用中文
- 面向用户的输出不含 API key
- 测试放 `src/backend/tests/unit/components/tools/`，继承 `tests.base.ComponentTestBaseWithoutClient`，必须实现 `component_class` / `default_kwargs` / `file_names_mapping` 三个 fixture
- 提交用 conventional commits（`feat:` / `test:` / `docs:`），提交命令 `uv run git commit`
- 本计划产出的 4 个组件对 juben 代码是「移植重写」：只搬逻辑不搬依赖（juben 的 `lib.*` 不可 import）
- 设计文档：`docs/superpowers/specs/2026-08-28-asset-sheet-generation-design.md`（资产图）与 `docs/superpowers/specs/2026-08-28-promotion-copy-minimal-design.md`（飞书组件来源）

## File Structure

```
src/lfx/src/lfx/components/tools/
├── __init__.py                      # 注册 3 个新组件（Modify；飞书组件由另一会话注册）
├── feishu_doc.py                    # ⛔ 另一会话实施中——本计划不做（见 Task 1 说明）
├── volc_image_search.py             # 豆包搜图：web_search image 模式 + 参考图下载（Create）
├── image_generation.py              # OpenAI 兼容图像生成：尺寸计算 + generate/edit（Create）
└── batch_asset_sheet.py             # 批量资产出图：并发编排 + 布局契约模板 + send_message（Create）

src/backend/tests/unit/components/tools/
├── __init__.py                      # 空（Create；若飞书会话已建则复用）
├── test_volc_image_search.py        # Create
├── test_image_generation.py         # Create
└── test_batch_asset_sheet.py        # Create

scripts/build_asset_sheet_flow.py    # 预置 flow 生成脚本（Create）
examples/asset-sheet/
├── asset-sheet.flow.json            # 生成产物（Create，由脚本产出）
└── README.md                        # 导入与配置说明（Create）
```

每个组件文件 = 底层纯函数/HTTP 函数 + 组件薄壳；`batch_asset_sheet.py` import 前三者的底层函数（不实例化组件类）。

**与设计文档的一处偏离（已在计划内固化）**：批量组件的资产清单输入用 JSON 文本（`MultilineInput`）而非 Data 列表——langflow 本版无画布级结构化输出组件，LLM 直接输出 JSON 文本由组件容错解析（剥 code fence）最稳。

---

### Task 1: 飞书文档组件 FeishuDocComponent ⛔ 跳过——另一会话实施中

**本任务不执行。** 飞书组件（`feishu_doc.py` + `test_feishu_doc.py` + `tools/__init__.py` 注册）由另一个会话负责实施。执行本计划时：

- 不得创建/修改 `feishu_doc.py` 与 `test_feishu_doc.py`
- 修改 `tools/__init__.py` 注册新组件时，**不要动飞书相关行**；若该会话尚未注册，也只添加本计划自己的 3 个条目
- 若与本计划任务产生 `tools/__init__.py` 合并冲突：以对方会话的飞书条目为准保留，重试自己的注册块

以下 Task 2-5 互不依赖飞书组件，可独立执行。

---

### Task 2: 豆包搜图组件 VolcImageSearchComponent

**Files:**
- Create: `src/lfx/src/lfx/components/tools/volc_image_search.py`
- Modify: `src/lfx/src/lfx/components/tools/__init__.py`
- Test: `src/backend/tests/unit/components/tools/test_volc_image_search.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `async volc_image_search(query: str, api_key: str, *, limit: int = 3, client: httpx.AsyncClient | None = None) -> list[dict]`：返回 `[{"url","width","height","title","page_url"}]`；未配 key 抛 `ValueError`（中文）；限流（CodeN 700429）指数退避重试 ≤3；无结果返回 `[]`
  - `async download_search_images(results: list[dict], *, max_images: int = 3, client: httpx.AsyncClient | None = None, dest_dir: Path | None = None) -> list[dict]`：下载 + PIL 校验，返回 `[{"url","width","height","local_path"}]`（失败项跳过；SSRF 走 `ssrf_safe_async_get`）
  - `class VolcImageSearchComponent(Component)`：inputs `query` / `api_key` / `limit`；Output name `images`（Data 列表）

- [ ] **Step 1: 写失败测试**

```python
# src/backend/tests/unit/components/tools/test_volc_image_search.py
import httpx
import pytest

from lfx.components.tools.volc_image_search import (
    VolcImageSearchComponent,
    download_search_images,
    volc_image_search,
)
from tests.base import ComponentTestBaseWithoutClient

_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search"


def _ok_payload(n: int = 2) -> dict:
    images = [
        {"Title": f"图{i}", "Url": f"https://page.example/{i}", "Image": {"Url": f"https://img.example/{i}.jpg", "Width": 800, "Height": 600}}
        for i in range(1, n + 1)
    ]
    return {"Result": {"ImageResults": images}}


class TestVolcImageSearch:
    @pytest.mark.asyncio
    async def test_search_parses_results(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path.endswith("/web_search")
            return httpx.Response(200, json=_ok_payload(2))

        results = await volc_image_search("清代长袍", "key", limit=3, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        assert len(results) == 2
        assert results[0]["url"] == "https://img.example/1.jpg"
        assert results[0]["width"] == 800

    @pytest.mark.asyncio
    async def test_no_results_returns_empty(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"Result": {}})

        assert await volc_image_search("x", "key", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) == []

    @pytest.mark.asyncio
    async def test_missing_key_raises(self):
        with pytest.raises(ValueError, match="未配置"):
            await volc_image_search("x", "  ")

    @pytest.mark.asyncio
    async def test_rate_limit_retries_then_ok(self, monkeypatch):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] < 3:
                return httpx.Response(200, json={"ResponseMetadata": {"Error": {"CodeN": 700429, "Message": "rate limit"}}})
            return httpx.Response(200, json=_ok_payload(1))

        monkeypatch.setattr("lfx.components.tools.volc_image_search._RETRY_BASE_DELAY", 0)
        results = await volc_image_search("x", "key", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        assert len(results) == 1 and calls["n"] == 3

    @pytest.mark.asyncio
    async def test_quota_error_raises_chinese(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ResponseMetadata": {"Error": {"CodeN": 10406, "Message": "quota"}}})

        with pytest.raises(Exception, match="额度"):
            await volc_image_search("x", "key", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


class TestDownload:
    @pytest.mark.asyncio
    async def test_download_ok_and_skip_invalid(self, tmp_path):
        from PIL import Image

        good = tmp_path / "good.png"
        Image.new("RGB", (4, 4)).save(good)

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/1.png"):
                return httpx.Response(200, content=good.read_bytes(), headers={"content-type": "image/png"})
            return httpx.Response(200, content=b"not an image")

        results = [{"url": "https://img/1.png", "width": 4, "height": 4}, {"url": "https://img/bad.bin", "width": 0, "height": 0}]
        out = await download_search_images(results, max_images=3, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), dest_dir=tmp_path / "refs")
        assert len(out) == 1 and Path(out[0]["local_path"]).exists()


class TestComponent(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return VolcImageSearchComponent

    @pytest.fixture
    def default_kwargs(self):
        return {"query": "清代长袍", "api_key": "key", "limit": 3}

    @pytest.fixture
    def file_names_mapping(self):
        return []

    @pytest.fixture(autouse=True)
    def _stub(self, monkeypatch):
        async def fake_search(query, api_key, *, limit=3, client=None):
            return [{"url": "https://img/1.jpg", "width": 1, "height": 1}]

        async def fake_download(results, *, max_images=3, client=None, dest_dir=None):
            return [{"url": r["url"], "width": 1, "height": 1, "local_path": "/tmp/x.jpg"} for r in results]

        monkeypatch.setattr("lfx.components.tools.volc_image_search.volc_image_search", fake_search)
        monkeypatch.setattr("lfx.components.tools.volc_image_search.download_search_images", fake_download)
```

（文件顶部补 `import json` 与 `from pathlib import Path`。）

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_volc_image_search.py -v
```

预期：`ModuleNotFoundError`

- [ ] **Step 3: 实现组件**

```python
# src/lfx/src/lfx/components/tools/volc_image_search.py
"""豆包搜索（火山引擎联网搜索）图片搜索组件。

移植 juben ``lib/image_search/volc_search.py``：``SearchType=image`` 返回结构化
图片结果（URL/宽高）。搜到的前 N 张下载为本地参考图，供图像生成组件图生图。
"""

from __future__ import annotations

import asyncio
import io
import tempfile
from pathlib import Path
from typing import Any

import httpx

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import IntInput, MessageTextInput, SecretStrInput
from lfx.schema.data import Data
from lfx.template.field.base import Output
from lfx.utils.ssrf_httpx import ssrf_safe_async_get, ssrf_safe_async_post

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
        raise ValueError("未配置豆包搜索 API Key：请填写 volc_search_api_key（或引用全局变量）")
    query_text = str(query).strip()
    if not query_text:
        raise ValueError("搜索关键词为空")
    normalized_limit = max(1, min(int(limit), _MAX_IMAGE_RESULTS))
    payload = {"Query": query_text, "SearchType": "image", "Count": normalized_limit}
    headers = {"Authorization": f"Bearer {api_key.strip()}"}

    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        if client is not None:
            response = await client.post(_ENDPOINT, json=payload, headers=headers)
        else:
            response = await ssrf_safe_async_post(_ENDPOINT, json=payload, headers=headers, timeout=_TIMEOUT_SECONDS)
        body = _decode(response)
        error = ((body.get("ResponseMetadata") or {}).get("Error") or {})
        code = error.get("CodeN")
        if code in _ERR_RATE_LIMIT and attempt < _RETRY_ATTEMPTS:
            await asyncio.sleep(_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
            continue
        if code in _ERR_AUTH:
            raise ValueError("豆包搜索 API Key 无效：请到火山引擎「联网搜索控制台」确认 Key 正确")
        if code in _ERR_UNCONFIGURED:
            raise ValueError("豆包搜索服务未开通：请到火山引擎「联网搜索控制台」开通图片搜索服务")
        if code in _ERR_QUOTA:
            raise ValueError("豆包搜索额度不足：免费额度每月 500 次，请到控制台确认额度或升级套餐")
        if code is not None:
            raise ValueError(f"豆包搜索接口错误（CodeN={code}）：{error.get('Message') or '未知错误'}")
        return _normalize_results(body, limit=normalized_limit)
    return []


def _decode(response: httpx.Response) -> dict[str, Any]:
    if response.status_code >= 400:
        raise ValueError(f"豆包搜索请求失败（HTTP {response.status_code}）")
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
        except Exception:  # noqa: BLE001 — 单张失败不影响其余参考图
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
        IntInput(name="limit", display_name="参考图数量", value=3, advanced=True, info="下载前 N 张（1-5，豆包单次最多 5 条）"),
    ]

    outputs = [Output(display_name="参考图", name="images", method="search_images")]

    async def search_images(self) -> list[Data]:
        results = await volc_image_search(self.query, self.api_key, limit=int(self.limit or 3))
        downloaded = await download_search_images(results, max_images=int(self.limit or 3))
        self.status = f"{len(downloaded)} 张参考图"
        return [Data(data=item, text=item.get("title") or item["url"]) for item in downloaded]
```

注册 `"VolcImageSearchComponent": "volc_image_search"` + `__all__`。

注意：`ssrf_safe_async_get` 对 `follow_redirects` 有断言（禁止跟随重定向）——测试 handler 直接 200 无重定向即可。

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_volc_image_search.py -v
```

预期：PASS（异步标记若报 unknown marker，把 `@pytest.mark.asyncio` 换成项目既有惯例——`src/backend/tests/` 已有 async 测试先例，参考 `src/backend/tests/unit/` 下任一 async 测试的标记）。

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/volc_image_search.py src/lfx/src/lfx/components/tools/__init__.py src/backend/tests/unit/components/tools/test_volc_image_search.py
uv run git commit -m "feat(tools): 豆包搜图组件（图片搜索 + 参考图下载）"
```

---

### Task 3: 图像生成组件 ImageGenerationComponent

**Files:**
- Create: `src/lfx/src/lfx/components/tools/image_generation.py`
- Modify: `src/lfx/src/lfx/components/tools/__init__.py`
- Test: `src/backend/tests/unit/components/tools/test_image_generation.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `compute_image_size(aspect_ratio: str, resolution: str = "1K") -> tuple[int, int]`：比例优先（零偏差）、被 16 整除、短边 ≥ 档位（1K=1024/2K=1440/4K=2160）；比例支持 `16:9 / 9:16 / 1:1 / 4:3 / 3:4`
  - `async generate_image(prompt: str, *, model: str, base_url: str, api_key: str, aspect_ratio: str = "16:9", resolution: str = "1K", reference_images: list[str] | None = None, dest_dir: Path | None = None) -> dict`：返回 `{"path","width","height","model"}`；有参考图走 `images.edit`，无走 `images.generate`；参考图路径不存在则跳过该张，全部无效视为无参考图
  - `class ImageGenerationComponent(Component)`：inputs `prompt` / `reference_paths`(MessageTextInput，逗号/换行分隔的本地路径，可选) / `model_name` / `base_url` / `api_key` / `aspect_ratio` / `resolution`；Output name `image`

- [ ] **Step 1: 写失败测试**

```python
# src/backend/tests/unit/components/tools/test_image_generation.py
import base64
import io
from types import SimpleNamespace

import pytest

from lfx.components.tools.image_generation import (
    ImageGenerationComponent,
    compute_image_size,
    generate_image,
)
from tests.base import ComponentTestBaseWithoutClient


class TestComputeImageSize:
    @pytest.mark.parametrize(
        ("ratio", "resolution", "expected"),
        [
            ("16:9", "1K", (2048, 1152)),
            ("9:16", "1K", (1152, 2048)),
            ("1:1", "1K", (1024, 1024)),
            ("4:3", "1K", (1408, 1056)),
            ("3:4", "1K", (1056, 1408)),
            ("16:9", "2K", (2560, 1440)),
            ("16:9", "4K", (3840, 2160)),
        ],
    )
    def test_sizes(self, ratio, resolution, expected):
        assert compute_image_size(ratio, resolution) == expected

    @pytest.mark.parametrize(("ratio", "resolution"), [(r, res) for r in ("16:9", "4:3") for res in ("1K", "2K", "4K")])
    def test_divisible_by_16_and_ratio_exact(self, ratio, resolution):
        w, h = compute_image_size(ratio, resolution)
        assert w % 16 == 0 and h % 16 == 0
        aw, ah = (int(x) for x in ratio.split(":"))
        assert w * ah == h * aw  # 比例零偏差


def _fake_item() -> SimpleNamespace:
    buf = io.BytesIO()
    from PIL import Image

    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    return SimpleNamespace(b64_json=base64.b64encode(buf.getvalue()).decode(), url=None)


class TestGenerateImage:
    @pytest.mark.asyncio
    async def test_t2i_calls_generate(self, tmp_path, monkeypatch):
        captured = {}

        class FakeImages:
            async def generate(self, **kwargs):
                captured.update(kwargs)
                return SimpleNamespace(data=[_fake_item()])

            async def edit(self, **kwargs):
                raise AssertionError("不应走 edit")

        class FakeClient:
            def __init__(self, **kwargs):
                self.images = FakeImages()

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        result = await generate_image(
            "一只猫", model="gpt-image-2-03", base_url="https://www.dmxapi.cn/v1",
            api_key="k", aspect_ratio="16:9", resolution="1K", dest_dir=tmp_path,
        )
        assert captured["model"] == "gpt-image-2-03"
        assert captured["size"] == "2048x1152"
        assert "image" not in captured
        assert result["width"] == 2048 and Path(result["path"]).exists()

    @pytest.mark.asyncio
    async def test_i2i_calls_edit_with_files(self, tmp_path, monkeypatch):
        captured = {}
        ref = tmp_path / "ref.png"
        from PIL import Image

        Image.new("RGB", (4, 4)).save(ref)

        class FakeImages:
            async def generate(self, **kwargs):
                raise AssertionError("不应走 generate")

            async def edit(self, **kwargs):
                captured.update({k: v for k, v in kwargs.items() if k != "image"})
                captured["image_count"] = len(kwargs["image"])
                return SimpleNamespace(data=[_fake_item()])

        class FakeClient:
            def __init__(self, **kwargs):
                self.images = FakeImages()

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        result = await generate_image(
            "一只猫", model="m", base_url="https://x/v1", api_key="k",
            reference_images=[str(ref), "/nonexistent.png"], dest_dir=tmp_path,
        )
        assert captured["image_count"] == 1
        assert captured["size"] == "2048x1152"
        assert result["model"] == "m"


class TestComponent(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return ImageGenerationComponent

    @pytest.fixture
    def default_kwargs(self):
        return {
            "prompt": "白底三视图",
            "model_name": "gpt-image-2-03",
            "base_url": "https://www.dmxapi.cn/v1",
            "api_key": "k",
            "aspect_ratio": "16:9",
            "resolution": "1K",
            "reference_paths": "",
        }

    @pytest.fixture
    def file_names_mapping(self):
        return []

    @pytest.fixture(autouse=True)
    def _stub(self, monkeypatch):
        async def fake_generate(prompt, **kwargs):
            return {"path": "/tmp/x.png", "width": 2048, "height": 1152, "model": kwargs.get("model")}

        monkeypatch.setattr("lfx.components.tools.image_generation.generate_image", fake_generate)
```

（顶部 `from pathlib import Path`。）

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_image_generation.py -v
```

预期：`ModuleNotFoundError`

- [ ] **Step 3: 实现组件**

```python
# src/lfx/src/lfx/components/tools/image_generation.py
"""OpenAI 兼容图像生成组件（默认 DMXAPI 中转）。

比例优先、清晰度其次：输出比例由 aspect_ratio 唯一决定，resolution 只决定
短边档位；合法尺寸取 (aw*16, ah*16) 的整数倍，比例零偏差且天然满足
gpt-image-2 宽高被 16 整除的约束。有参考图走 images.edit（图生图），
无参考图走 images.generate。
"""

from __future__ import annotations

import asyncio
import base64
import math
import re
import tempfile
from pathlib import Path
from typing import Any

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import DropdownInput, MessageTextInput, SecretStrInput
from lfx.schema.data import Data
from lfx.template.field.base import Output
from lfx.utils.ssrf_httpx import ssrf_protected_openai_clients_for_url

_RESOLUTION_SHORT_EDGE = {"1K": 1024, "2K": 1440, "4K": 2160}
_ROUND_TO = 16
_RATIO_SPLIT_RE = re.compile(r"^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$")
_TIMEOUT_SECONDS = 180.0


def compute_image_size(aspect_ratio: str, resolution: str = "1K") -> tuple[int, int]:
    match = _RATIO_SPLIT_RE.match(str(aspect_ratio))
    if not match:
        raise ValueError(f"无法解析比例：{aspect_ratio}（支持 16:9 / 9:16 / 1:1 / 4:3 / 3:4）")
    aw, ah = int(match.group(1)), int(match.group(2))
    if aw <= 0 or ah <= 0:
        raise ValueError(f"比例不合法：{aspect_ratio}")
    short = _RESOLUTION_SHORT_EDGE.get(str(resolution))
    if short is None:
        raise ValueError(f"不支持的清晰度档位：{resolution}（支持 1K / 2K / 4K）")
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
    from openai import AsyncOpenAI

    width, height = compute_image_size(aspect_ratio, resolution)
    size = f"{width}x{height}"
    clients = ssrf_protected_openai_clients_for_url(base_url)
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=_TIMEOUT_SECONDS,
        http_async_client=clients.get("http_async_client"),
    )

    ref_files: list[bytes] = []
    ref_suffixes: list[str] = []
    for ref in reference_images or []:
        path = Path(ref)
        if path.is_file():
            ref_files.append(path.read_bytes())
            ref_suffixes.append(path.suffix or ".png")

    common = {"model": model, "prompt": prompt, "size": size, "n": 1}
    try:
        if ref_files:
            import io

            files = [(f"ref_{i}{sfx}", io.BytesIO(data), "application/octet-stream") for i, (data, sfx) in enumerate(zip(ref_files, ref_suffixes, strict=True))]
            response = await client.images.edit(image=files, **common)
        else:
            response = await client.images.generate(**common)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"图像生成失败（model={model}）：{exc}") from exc

    data = getattr(response, "data", None) or []
    if not data:
        raise ValueError(f"图像生成响应为空（model={model}），可能触发内容安全过滤")
    item = data[0]
    b64 = getattr(item, "b64_json", None)
    url = getattr(item, "url", None)
    if not b64 and not url:
        raise ValueError("图像生成响应既无 b64_json 也无 url")

    target_dir = Path(dest_dir) if dest_dir else Path(tempfile.mkdtemp(prefix="gen_image_"))
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"image_{int(asyncio.get_running_loop().time() * 1000) % 10**9}.png"

    def _save() -> None:
        if b64:
            path.write_bytes(base64.b64decode(b64))
        else:
            import httpx

            with httpx.Client(timeout=60.0) as dl:
                path.write_bytes(dl.get(str(url)).content)

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
        DropdownInput(name="aspect_ratio", display_name="比例", options=["16:9", "9:16", "1:1", "4:3", "3:4"], value="16:9"),
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
```

注册 `"ImageGenerationComponent": "image_generation"` + `__all__`。

注意：`_save` 的 url 下载分支用了裸 `httpx.Client`——SSRF 静态扫描只扫 `lfx_bundles` 包（`GUARDED_MODULES` 是 lfx_bundles 相对路径），但为一致性把 url 分支也换成 `ssrf_safe_httpx_get`（同步版）。实现时 url 分支写为：

```python
            from lfx.utils.ssrf_httpx import ssrf_safe_httpx_get

            path.write_bytes(ssrf_safe_httpx_get(str(url), timeout=60.0).content)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_image_generation.py -v
```

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/image_generation.py src/lfx/src/lfx/components/tools/__init__.py src/backend/tests/unit/components/tools/test_image_generation.py
uv run git commit -m "feat(tools): OpenAI 兼容图像生成组件（比例优先尺寸 + t2i/i2i）"
```

---

### Task 4: 批量资产出图组件 BatchAssetSheetComponent

**Files:**
- Create: `src/lfx/src/lfx/components/tools/batch_asset_sheet.py`
- Modify: `src/lfx/src/lfx/components/tools/__init__.py`
- Test: `src/backend/tests/unit/components/tools/test_batch_asset_sheet.py`

**Interfaces:**
- Consumes:
  - `volc_image_search(query, api_key, *, limit=3, client=None) -> list[dict]`（Task 2）
  - `download_search_images(results, *, max_images=3, client=None, dest_dir=None) -> list[dict]`（Task 2）
  - `generate_image(prompt, *, model, base_url, api_key, aspect_ratio, resolution, reference_images=None, dest_dir=None) -> dict`（Task 3）
- Produces:
  - `LAYOUT_SPECS: dict[str, str]`（character/scene/prop 布局契约）
  - `TYPE_ASPECT = {"character": "16:9", "scene": "16:9", "prop": "4:3"}`
  - `render_asset_prompt(asset: dict, template: str | None = None) -> str`
  - `parse_assets_payload(text: str, max_assets: int) -> list[dict]`：容错解析（剥 ```json 围栏、截取首尾大括号、校验字段、截断）
  - `class BatchAssetSheetComponent(Component)`：Output name `results`

- [ ] **Step 1: 写失败测试**

```python
# src/backend/tests/unit/components/tools/test_batch_asset_sheet.py
import asyncio

import pytest

from lfx.components.tools import batch_asset_sheet as bas
from lfx.components.tools.batch_asset_sheet import (
    BatchAssetSheetComponent,
    LAYOUT_SPECS,
    parse_assets_payload,
    render_asset_prompt,
)
from tests.base import ComponentTestBaseWithoutClient


class TestParseAssetsPayload:
    def test_plain_json(self):
        text = '{"assets": [{"type": "character", "name": "林万年", "description": "清末商人", "visual_notes": "深色长袍", "search_query": "清代商人长袍"}]}'
        assets = parse_assets_payload(text, max_assets=10)
        assert len(assets) == 1 and assets[0]["name"] == "林万年"

    def test_fenced_json(self):
        text = '```json\n{"assets": [{"type": "prop", "name": "青花瓷瓶", "description": "d", "visual_notes": "v", "search_query": "q"}]}\n```'
        assets = parse_assets_payload(text, max_assets=10)
        assert len(assets) == 1 and assets[0]["type"] == "prop"

    def test_truncates_and_filters_unknown_type(self):
        assets = [{"type": "scene", "name": f"场景{i}", "description": "d", "visual_notes": "v", "search_query": "q"} for i in range(15)]
        assets.append({"type": "vehicle", "name": "x", "description": "d", "visual_notes": "v", "search_query": "q"})
        parsed = parse_assets_payload({"assets": assets} if False else str(assets).replace("'", '"'), max_assets=10)
        assert len(parsed) == 10 and all(a["type"] == "scene" for a in parsed)

    def test_invalid_raises_chinese(self):
        with pytest.raises(ValueError, match="资产清单"):
            parse_assets_payload("完全不是 JSON", max_assets=10)


class TestRenderPrompt:
    def test_character_layout(self):
        prompt = render_asset_prompt({"type": "character", "name": "林万年", "description": "清末商人", "visual_notes": "长袍马褂"})
        assert "纯白" in prompt and "A-Pose" in prompt and "林万年" in prompt
        assert "可读文字" in prompt  # 文字守卫

    def test_scene_layout(self):
        prompt = render_asset_prompt({"type": "scene", "name": "老宅正厅", "description": "清代宅院", "visual_notes": "午后光"})
        assert "无人" in prompt and "老宅正厅" in prompt

    def test_prop_layout(self):
        prompt = render_asset_prompt({"type": "prop", "name": "青花瓷瓶", "description": "清代瓷器", "visual_notes": "釉面"})
        assert "浅灰" in prompt

    def test_custom_template(self):
        prompt = render_asset_prompt({"type": "prop", "name": "N", "description": "D", "visual_notes": "V"}, template="自定义 {name} {type}")
        assert prompt == "自定义 N prop"


class TestRunAssetSheets:
    def _component(self, monkeypatch, *, fail_search=False, fail_gen_for=None):
        async def fake_search(query, api_key, *, limit=3, client=None):
            if fail_search:
                return []
            return [{"url": f"https://img/{query}.jpg", "width": 10, "height": 10}]

        async def fake_download(results, *, max_images=3, client=None, dest_dir=None):
            return [{**r, "local_path": f"/tmp/{i}.jpg"} for i, r in enumerate(results)]

        async def fake_generate(prompt, *, model, base_url, api_key, aspect_ratio, resolution, reference_images=None, dest_dir=None):
            if fail_gen_for and fail_gen_for in prompt:
                raise ValueError("boom")
            return {"path": f"/tmp/out_{abs(hash(prompt)) % 1000}.png", "width": 100, "height": 100, "model": model}

        monkeypatch.setattr(bas, "volc_image_search", fake_search)
        monkeypatch.setattr(bas, "download_search_images", fake_download)
        monkeypatch.setattr(bas, "generate_image", fake_generate)

        sent = []

        async def fake_send(message, id_=None, **kwargs):
            sent.append(message)

        component = BatchAssetSheetComponent(
            assets_payload='{"assets": [{"type": "character", "name": "甲", "description": "d", "visual_notes": "v", "search_query": "q1"}, {"type": "prop", "name": "乙", "description": "d", "visual_notes": "v", "search_query": "q2"}]}',
            search_api_key="k",
            api_key="k",
        )
        component.send_message = fake_send
        return component, sent

    @pytest.mark.asyncio
    async def test_all_ok(self, monkeypatch):
        component, sent = self._component(monkeypatch)
        results = await component.run_asset_sheets()
        assert len(results) == 2 and all(r.data["status"] == "ok" for r in results)
        assert len(sent) == 2
        assert results[0].data["image_path"].startswith("/tmp/out_")

    @pytest.mark.asyncio
    async def test_single_failure_does_not_break_batch(self, monkeypatch):
        component, sent = self._component(monkeypatch, fail_gen_for="乙")
        results = await component.run_asset_sheets()
        statuses = {r.data["name"]: r.data["status"] for r in results}
        assert statuses == {"甲": "ok", "乙": "failed"}
        assert len(sent) == 1

    @pytest.mark.asyncio
    async def test_search_failure_falls_back_to_t2i(self, monkeypatch):
        component, _sent = self._component(monkeypatch, fail_search=True)
        results = await component.run_asset_sheets()
        assert all(r.data["status"] == "ok" for r in results)
        assert all(r.data["reference_count"] == 0 for r in results)

    @pytest.mark.asyncio
    async def test_concurrency_respected(self, monkeypatch):
        active = {"n": 0}
        peak = {"n": 0}

        async def fake_generate(prompt, **kwargs):
            active["n"] += 1
            peak["n"] = max(peak["n"], active["n"])
            await asyncio.sleep(0.05)
            active["n"] -= 1
            return {"path": "/tmp/x.png", "width": 1, "height": 1, "model": "m"}

        async def fake_search(query, api_key, *, limit=3, client=None):
            return []

        monkeypatch.setattr(bas, "volc_image_search", fake_search)
        monkeypatch.setattr(bas, "download_search_images", lambda *a, **k: _empty())
        monkeypatch.setattr(bas, "generate_image", fake_generate)

        assets = [{"type": "prop", "name": f"p{i}", "description": "d", "visual_notes": "v", "search_query": "q"} for i in range(6)]
        component = BatchAssetSheetComponent(assets_payload=str(assets).replace("'", '"'), search_api_key="k", api_key="k", concurrency=2)
        component.send_message = _noop_send()
        await component.run_asset_sheets()
        assert peak["n"] <= 2


async def _empty():
    return []


def _noop_send():
    async def send(message, id_=None, **kwargs):
        return None

    return send


class TestComponent(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return BatchAssetSheetComponent

    @pytest.fixture
    def default_kwargs(self):
        return {
            "assets_payload": '{"assets": [{"type": "prop", "name": "瓶", "description": "d", "visual_notes": "v", "search_query": "q"}]}',
            "search_api_key": "k",
            "api_key": "k",
        }

    @pytest.fixture
    def file_names_mapping(self):
        return []

    @pytest.fixture(autouse=True)
    def _stub(self, monkeypatch):
        monkeypatch.setattr(bas, "volc_image_search", _empty)
        monkeypatch.setattr(bas, "download_search_images", lambda *a, **k: _empty())
        monkeypatch.setattr(
            bas,
            "generate_image",
            lambda prompt, **kw: _ok_gen(),
        )


async def _ok_gen():
    return {"path": "/tmp/x.png", "width": 1, "height": 1, "model": "m"}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_batch_asset_sheet.py -v
```

预期：`ModuleNotFoundError`

- [ ] **Step 3: 实现组件**

```python
# src/lfx/src/lfx/components/tools/batch_asset_sheet.py
"""批量资产出图：剧本拆解出的资产清单 → 每资产搜参考图 → 按布局契约出设定图。

并发信号量限流；单资产失败不中断批次；每张完成 send_message 实时推送
（Playground 聊天卡片 / 未来专用前端 SSE 事件源）。布局契约移植 juben
``lib/prompt_builders.py`` 的单阶段 sheet 版。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

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

_REFERENCE_NOTE = (
    "参考图用于锁定形制、材质与色彩：继承参考图中的实物特征，"
    "不复刻参考图的白底、版式、水印或文字。"
)

_DEFAULT_TEMPLATE = """{layout}

资产事实（唯一事实来源，没写的不编）：
- 名称：{name}
- 描述：{description}
- 视觉要点：{visual_notes}

{_reference_note}图内为单件资产设定图，不添加任何其他角色或道具。
{_text_guard}"""


def render_asset_prompt(asset: dict[str, Any], template: str | None = None) -> str:
    asset_type = str(asset.get("type") or "")
    if asset_type not in LAYOUT_SPECS:
        raise ValueError(f"未知资产类型：{asset_type}")
    values = {
        "layout": LAYOUT_SPECS[asset_type],
        "name": str(asset.get("name") or ""),
        "description": str(asset.get("description") or ""),
        "visual_notes": str(asset.get("visual_notes") or ""),
        "type": asset_type,
        "_reference_note": _REFERENCE_NOTE,
        "_text_guard": _TEXT_GUARD,
    }
    body = (template or _DEFAULT_TEMPLATE).format(**values)
    return f"{_TYPE_LABELS[asset_type]}设定图：{values['name']}\n\n{body}"


def parse_assets_payload(text: str, max_assets: int = 10) -> list[dict[str, Any]]:
    """容错解析资产清单 JSON：剥 code fence、截取首尾大括号、过滤未知类型并截断。"""
    raw = str(text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("资产清单不是合法 JSON：找不到 JSON 对象")
    try:
        payload = json.loads(raw[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"资产清单不是合法 JSON：{exc}") from exc
    assets = payload.get("assets") if isinstance(payload, dict) else None
    if not isinstance(assets, list):
        raise ValueError('资产清单 JSON 缺少 "assets" 数组')
    valid = [
        {"type": str(a.get("type") or ""), "name": str(a.get("name") or ""), "description": str(a.get("description") or ""), "visual_notes": str(a.get("visual_notes") or ""), "search_query": str(a.get("search_query") or "")}
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
            info='{"assets": [{"type": "character|scene|prop", "name", "description", "visual_notes", "search_query"}]}',
        ),
        SecretStrInput(name="search_api_key", display_name="豆包搜索 Key", info="可引用全局变量 volc_search_api_key"),
        SecretStrInput(name="api_key", display_name="DMXAPI Key", info="可引用全局变量 dmx_api_key"),
        MessageTextInput(name="model_name", display_name="模型", value="gpt-image-2-03", advanced=True),
        MessageTextInput(name="base_url", display_name="Base URL", value="https://www.dmxapi.cn/v1", advanced=True),
        MessageTextInput(name="search_base_url", display_name="搜索端点", value="https://open.feedcoopapi.com", advanced=True),
        IntInput(name="concurrency", display_name="并发数", value=3, advanced=True),
        IntInput(name="max_assets", display_name="资产数上限", value=10, advanced=True),
        IntInput(name="reference_count", display_name="参考图数", value=3, advanced=True),
        DropdownInput(name="resolution", display_name="清晰度", options=["1K", "2K", "4K"], value="1K", advanced=True),
        MultilineInput(name="prompt_template", display_name="自定义模板", value="", advanced=True, info="可选。变量：{layout} {name} {description} {visual_notes} {type}"),
    ]

    outputs = [Output(display_name="结果", name="results", method="run_asset_sheets")]

    async def run_asset_sheets(self) -> list[Data]:
        assets = parse_assets_payload(self.assets_payload, max_assets=int(self.max_assets or 10))
        if not assets:
            raise ValueError("资产清单为空：没有可生成的 character / scene / prop 资产")
        semaphore = asyncio.Semaphore(max(1, min(int(self.concurrency or 3), 5)))
        out_dir = Path(f"/tmp/asset_sheets/{int(time.time())}")

        async def _one(asset: dict[str, Any]) -> Data:
            name = asset["name"]
            asset_type = asset["type"]
            started = time.monotonic()
            record: dict[str, Any] = {"name": name, "type": asset_type, "status": "failed", "image_path": None, "reference_count": 0, "error": None, "elapsed_seconds": 0.0}
            async with semaphore:
                try:
                    refs: list[dict[str, Any]] = []
                    if asset.get("search_query"):
                        try:
                            results = await volc_image_search(asset["search_query"], self.search_api_key, limit=int(self.reference_count or 3))
                            refs = await download_search_images(results, max_images=int(self.reference_count or 3))
                        except Exception:  # noqa: BLE001 — 搜索失败回退纯文生图
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
                    record["status"] = "ok"
                    record["image_path"] = image["path"]
                    await self.send_message(
                        Message(text=f"{_TYPE_LABELS[asset_type]} · {name}", files=[image["path"]])
                    )
                except Exception as exc:  # noqa: BLE001 — 单资产失败不中断批次
                    record["error"] = str(exc)[:300]
            record["elapsed_seconds"] = round(time.monotonic() - started, 1)
            return Data(data=record, text=f"{name}: {record['status']}")

        results = await asyncio.gather(*(_one(a) for a in assets))
        failed = [r for r in results if r.data["status"] == "failed"]
        self.status = f"{len(results) - len(failed)}/{len(results)} 成功"
        if failed:
            await self.send_message(Message(text=f"批次完成：{len(failed)} 个资产失败（{', '.join(r.data['name'] for r in failed)}），详见结果输出"))
        return list(results)
```

注册 `"BatchAssetSheetComponent": "batch_asset_sheet"` + `__all__`。

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest src/backend/tests/unit/components/tools/test_batch_asset_sheet.py -v
```

预期：PASS。注意 `send_message` 在测试中被替换为普通协程函数——真实 `Component.send_message` 签名为 `(message, id_=None, *, skip_db_update=False)`，fake 保持同样参数形状。

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/batch_asset_sheet.py src/lfx/src/lfx/components/tools/__init__.py src/backend/tests/unit/components/tools/test_batch_asset_sheet.py
uv run git commit -m "feat(tools): 批量资产出图组件（并发编排 + 布局契约 + 实时推送）"
```

---

### Task 5: 预置 flow 生成脚本 + flow JSON + README

**Files:**
- Create: `scripts/build_asset_sheet_flow.py`
- Create: `examples/asset-sheet/README.md`
- Create: `examples/asset-sheet/asset-sheet.flow.json`（脚本产物）

**Interfaces:**
- Consumes: Task 1-4 的组件类；`lfx.custom.utils.build_custom_component_template`；`lfx.utils.util.escape_json_dump`
- Produces: 可在 langflow UI 导入并运行的 flow JSON

- [ ] **Step 1: 写生成脚本**

```python
# scripts/build_asset_sheet_flow.py
"""生成 examples/asset-sheet/asset-sheet.flow.json 预置 flow。

节点 template 用 build_custom_component_template 从组件类真实生成（与
组件定义永远同步），edge handle 用 escape_json_dump 编码。运行：
    uv run python scripts/build_asset_sheet_flow.py
"""

from __future__ import annotations

import inspect
import json
import random
import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "lfx" / "src"))

from lfx.components.input_output.text_input import TextInputComponent  # 路径以实际为准，见 Step 2
from lfx.components.models_and_agents.language_model import LanguageModelComponent
from lfx.components.models_and_agents.prompt import PromptComponent
from lfx.components.tools.batch_asset_sheet import BatchAssetSheetComponent
from lfx.custom.custom_component.component import Component
from lfx.custom.utils import build_custom_component_template
from lfx.utils.util import escape_json_dump

SCRIPT_PROMPT = """你是影视资产盘点编辑。阅读剧本，盘点需要生成设定图的生产资产，只输出 JSON。

规则：
- 只拆三类：character（角色）/ scene（场景）/ prop（道具）
- 只拆有画面感、需要专门设计图的实体；对白提及但不入画的不要
- 名称用剧本原名；description 写外形与身份要点（服饰年代、材质、体态、年龄感）
- visual_notes 写视觉要点（色彩、材质、光线、氛围）
- search_query 是可公开搜索的名词短语（如「清代商人长袍」），不要用角色名
- 按出场重要性排序，最多 10 条
- 只输出 JSON，不要任何其他文字：
{{"assets": [{{"type": "character", "name": "...", "description": "...", "visual_notes": "...", "search_query": "..."}}]}}

剧本：
{script}"""


def _suffix() -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=5))


def _template(cls: type[Component], values: dict[str, object]) -> tuple[dict, str]:
    source = inspect.getsource(cls)
    frontend_node, _config = build_custom_component_template(Component(_code=source))
    template = frontend_node["template"]
    for field_name, value in values.items():
        if field_name in template:
            template[field_name]["value"] = value
    name = frontend_node.get("display_name") or cls.__name__
    return template, name


def _node(cls: type[Component], values: dict[str, object], x: int, y: int) -> dict:
    template, display_name = _template(cls, values)
    node_id = f"{cls.__name__}-{_suffix()}"
    return {
        "id": node_id,
        "type": "genericNode",
        "position": {"x": x, "y": y},
        "positionAbsolute": {"x": x, "y": y},
        "dragging": False,
        "selected": False,
        "width": 384,
        "height": 400,
        "data": {
            "id": node_id,
            "type": display_name,
            "node": template,
            "display_name": display_name,
            "description": template.get("description", ""),
        },
    }


def _handle(source_id: str, field: str, output: bool, data_type: str, output_types: list[str] | None = None) -> str:
    payload = {"dataType": data_type, "id": source_id, "name": field}
    if output:
        payload["output_types"] = output_types or ["Message"]
    else:
        payload.update({"fieldName": field, "id": source_id, "inputTypes": ["Message"], "type": "str"})
    return escape_json_dump(payload)


def _edge(source: dict, source_field: str, source_type: str, target: dict, target_field: str, output_types: list[str]) -> dict:
    source_handle = _handle(source["id"], source_field, output=True, data_type=source_type, output_types=output_types)
    target_handle = _handle(target["id"], target_field, output=False, data_type=target["data"]["type"])
    return {
        "animated": False,
        "className": "",
        "data": {"sourceHandle": json.loads(source_handle.replace("œ", '"')), "targetHandle": json.loads(target_handle.replace("œ", '"'))},
        "id": f"reactflow__edge-{source['id']}{source_handle}-{target['id']}{target_handle}",
        "source": source["id"],
        "sourceHandle": source_handle,
        "target": target["id"],
        "targetHandle": target_handle,
        "selected": False,
    }


def main() -> None:
    script_input = _node(TextInputComponent, {"input_value": ""}, 0, 300)
    prompt = _node(PromptComponent, {"template": SCRIPT_PROMPT}, 400, 300)
    llm = _node(LanguageModelComponent, {"model_name": "", "system_message": "", "input_value": ""}, 800, 300)
    batch = _node(
        BatchAssetSheetComponent,
        {"assets_payload": "", "search_api_key": "", "api_key": "", "model_name": "gpt-image-2-03"},
        1200,
        300,
    )

    nodes = [script_input, prompt, llm, batch]
    edges = [
        _edge(script_input, "text", script_input["data"]["type"], prompt, "template", ["Message"]),
        _edge(prompt, "prompt", prompt["data"]["type"], llm, "system_message", ["Message"]),
        _edge(llm, "text", llm["data"]["type"], batch, "assets_payload", ["Message"]),
    ]

    flow = {
        "id": "a5e7c1d2-0000-4000-8000-asset-sheet01",
        "name": "剧本 → 资产设定图",
        "description": "剧本拆解资产清单 → 豆包搜图参考 → 并发出设定图（每张完成实时推送）",
        "is_component": False,
        "data": {"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 0.7}},
    }
    out = Path(__file__).resolve().parents[1] / "examples" / "asset-sheet" / "asset-sheet.flow.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(flow, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written: {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 校准导入路径并运行**

`TextInputComponent` 的模块路径需要现场核实（候选：`lfx/components/input_output/text_input.py`）。用 `grep -rn "class TextInputComponent" src/lfx/src/lfx/components/` 找到真实路径后修正 import。同理确认 `PromptComponent` 的输出字段名（`prompt`）与 `LanguageModelComponent` 的输入字段名（`system_message` / `input_value`）与输出字段名（`text`）——以 `_template()` 打印的实际字段为准调整 `_edge` 的字段名。

```bash
uv run python scripts/build_asset_sheet_flow.py
```

预期：输出 `written: examples/asset-sheet/asset-sheet.flow.json`；检查 JSON 里 4 个节点 template 各字段齐全、edges 的 sourceHandle/targetHandle 为 `œ` 编码 JSON。

- [ ] **Step 3: 本地 UI 导入验证**

```bash
LFX_DEV=1 make backend &   # 终端 1（后端 7860）
make frontend &            # 终端 2（前端 3000）
```

浏览器 http://localhost:3000 → 新建 flow → 拖入 JSON 文件导入 `examples/asset-sheet/asset-sheet.flow.json`。检查清单：
1. 4 个节点全部出现、无报错节点
2. 连线完整：剧本输入 → Prompt → Language Model → 批量资产出图
3. 每个节点参数面板字段完整（缺字段则回到 Step 2 修 `_template` 的 values 键名）
4. 在 Settings → Variables 创建 `volc_search_api_key`、`dmx_api_key`，在批量节点引用
5. Language Model 节点选择已配置的提供商与模型（如 DeepSeek）
6. 在剧本输入框贴一段含角色/场景/道具的短剧本，运行 flow，聊天面板逐张弹出设定图卡片

验证失败时修脚本重跑生成（迭代至清单全绿）。

- [ ] **Step 4: 写 README**

```markdown
<!-- examples/asset-sheet/README.md -->
# 剧本 → 资产设定图（Langflow 预置 flow）

输入剧本全文，LLM 拆解出角色/场景/道具清单，逐资产豆包搜索参考图，
按布局契约（角色白底四格三视图 / 场景无人空镜 / 道具浅灰多角度）并发出设定图。
每张图完成立即推送到聊天面板；未来专用前端可直接消费同一事件流。

## 使用步骤

1. **导入 flow**：新建 flow → 拖入 `asset-sheet.flow.json`
2. **创建全局变量**（Settings → Variables）：
   - `volc_search_api_key`：火山引擎「联网搜索控制台」创建的 API Key（免费 500 次/月）
   - `dmx_api_key`：DMXAPI 密钥（与宣发 flow 共用）
3. **配置模型提供商**（Settings → Model Providers，见宣发 README）：剧本拆解用任一文本模型槽位
4. 在「批量资产出图」节点把两个 Key 字段指向对应全局变量；Language Model 节点选择模型
5. 剧本输入框粘贴剧本 → 运行 → 聊天面板逐张收图；节点结果输出含每资产状态汇总

## 组件清单

| 组件 | 用途 | 单独使用 |
| --- | --- | --- |
| 飞书文档（可选） | 粘贴飞书链接读剧本，替代手动粘贴 | 可（接 Prompt）；由独立交付引入 |
| 豆包搜图 | 关键词 → 参考图 | 可 |
| 图像生成 | prompt（+参考图）→ 设定图 | 可 |
| 批量资产出图 | 资产清单 → 并发出图 + 实时推送 | 本 flow 的编排核心 |

## 参数说明

- 并发数：默认 3（上限 5）；豆包免费档有限流，组件自动退避重试
- 资产数上限：默认 10，超出的资产被丢弃
- 比例：角色/场景 16:9，道具 4:3（组件内按类型固定，独立图像生成组件可改）
- 搜图失败自动回退纯文生图（结果里 reference_count=0）
```

- [ ] **Step 5: 提交**

```bash
git add scripts/build_asset_sheet_flow.py examples/asset-sheet/
uv run git commit -m "feat(examples): 剧本→资产设定图预置 flow 与生成脚本"
```

---

## 收尾核查（全部任务完成后）

- [ ] `uv run pytest src/backend/tests/unit/components/tools/ -v` 全绿
- [ ] `make format_backend`（ruff）无 diff
- [ ] `uv run python scripts/build_asset_sheet_flow.py` 可重复运行且产物稳定
- [ ] 更新资产图设计文档状态行：`状态：已实施`，并在文末附实施偏离记录（assets 输入为 JSON 文本、飞书组件已随本计划落地）

## Self-Review 记录

- **Spec 覆盖**：豆包搜图（Task 2）、图像生成含比例优先尺寸（Task 3）、批量并发 + 布局契约 + send_message + 汇总（Task 4）、flow + README + 全局变量指引（Task 5）——spec 交付物清单中飞书组件（Task 1）经用户确认由另一会话实施、本计划跳过；交付物 7（测试）分散在各任务。
- **类型一致性**：`volc_image_search(query, api_key, *, limit, client)` 与 Task 4 的调用一致；`generate_image(prompt, *, model, base_url, api_key, aspect_ratio, resolution, reference_images, dest_dir)` 两处一致；`parse_assets_payload` / `render_asset_prompt` 签名与测试一致。
- **已知不确定点**（执行时按 Step 内指引现场校准，不是占位符）：`pytest.mark.asyncio` vs anyio 惯例（Task 1/2 Step 1 注明）；`TextInputComponent` 模块路径（Task 5 Step 2 注明核实方法）；`Component.send_message` 的 fake 签名对齐（Task 4 注明）。
