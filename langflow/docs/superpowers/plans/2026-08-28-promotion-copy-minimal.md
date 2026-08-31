# 宣发文案最小闭环（Langflow 版）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Langflow 里实现「飞书文档链接 → LLM 按平台规则写宣发文案候选」的最小闭环：1 个自定义飞书文档组件 + 单测 + 可导入的预置 flow + README。

**Architecture:** 唯一的新代码是一个 Langflow 组件（`FeishuDocComponent`），内部移植 juben `lib/feishu/` 的最小子集（链接解析纯函数 + tenant token + wiki 解析 + raw_content 拉取，纯 httpx）。写作规则从 juben `lib/promotion_copywriter/prompts.py` 移植为 Prompt 组件的静态模板（7 个变量），多路 LLM 用统一 LanguageModel 组件并行，凭证在「设置 → 模型提供商」配置，flow 内无任何密钥。

**Tech Stack:** Python 3.10-3.14 / lfx 组件体系（`lfx.custom.custom_component.component.Component`）/ httpx（已在 lfx 依赖中）/ pytest + httpx.MockTransport / Langflow flow JSON。

**设计文档:** `docs/superpowers/specs/2026-08-28-promotion-copy-minimal-design.md`（数据流、模板内容清单、模型槽位分配均以此为准）

## Global Constraints

- 组件类名 `FeishuDocComponent` 一经合入永不改名（Langflow 以类名匹配已保存 flow）
- 飞书 HTTP 仅用 httpx，不引入第三方飞书 SDK
- 所有面向用户的错误信息用中文
- 测试跑在 `src/backend/tests/` 下，必须 `uv sync --group dev --package langflow-base` 后用 `uv run pytest` 执行
- 提交用 `uv run git commit`（pre-commit 需要）；Python 格式化跑 `make format_backend`
- API key 绝不写入仓库任何文件（flow JSON 只含 provider/model 选择）
- httpx 客户端统一 20 秒超时

---

### Task 1: 飞书链接解析纯函数

**Files:**
- Create: `src/lfx/src/lfx/components/tools/feishu_doc.py`
- Test: `src/backend/tests/unit/components/tools/__init__.py`（空文件）, `src/backend/tests/unit/components/tools/test_feishu_doc.py`

**Interfaces:**
- Consumes: 无
- Produces: `parse_feishu_url(url: str) -> FeishuDocRef`；`FeishuDocRef` 为 frozen dataclass，字段 `url: str`、`doc_type: str`（"docx" | "wiki"）、`token: str`、`platform: str`（"feishu" | "lark"）；`FeishuLinkError(ValueError)`，`str(exc)` 为可直接展示的中文。Task 2/3 依赖这些名字。

- [ ] **Step 1: 写失败测试**

创建 `src/backend/tests/unit/components/tools/__init__.py`（空文件）和 `src/backend/tests/unit/components/tools/test_feishu_doc.py`：

```python
import pytest

from lfx.components.tools.feishu_doc import FeishuLinkError, parse_feishu_url


class TestParseFeishuUrl:
    def test_docx_link(self):
        ref = parse_feishu_url("https://example.feishu.cn/docx/Abcdefgh1234")
        assert ref.doc_type == "docx"
        assert ref.token == "Abcdefgh1234"
        assert ref.platform == "feishu"

    def test_wiki_link(self):
        ref = parse_feishu_url("https://example.feishu.cn/wiki/CnkbldN1oyHdhU0rCKvcZRXvnYe")
        assert ref.doc_type == "wiki"
        assert ref.token == "CnkbldN1oyHdhU0rCKvcZRXvnYe"

    def test_lark_international_domain(self):
        ref = parse_feishu_url("https://example.larksuite.com/docx/Abcdefgh1234")
        assert ref.platform == "lark"

    def test_larkoffice_domain(self):
        ref = parse_feishu_url("https://example.larkoffice.com/wiki/Abcdefgh1234")
        assert ref.platform == "lark"

    def test_url_without_scheme_is_tolerated(self):
        ref = parse_feishu_url("example.feishu.cn/docx/Abcdefgh1234")
        assert ref.doc_type == "docx"

    def test_empty_url_raises(self):
        with pytest.raises(FeishuLinkError, match="不能为空"):
            parse_feishu_url("")

    def test_non_feishu_domain_raises(self):
        with pytest.raises(FeishuLinkError, match="不是飞书文档链接"):
            parse_feishu_url("https://notion.so/docx/Abcdefgh1234")

    @pytest.mark.parametrize("doc_type,label", [
        ("docs", "旧版文档"),
        ("sheets", "电子表格"),
        ("base", "多维表格"),
        ("file", "云空间文件"),
    ])
    def test_unsupported_doc_types_raise_with_label(self, doc_type, label):
        with pytest.raises(FeishuLinkError, match=label):
            parse_feishu_url(f"https://example.feishu.cn/{doc_type}/Abcdefgh1234")

    def test_unknown_path_segment_raises(self):
        with pytest.raises(FeishuLinkError, match="无法识别"):
            parse_feishu_url("https://example.feishu.cn/whatever/Abcdefgh1234")

    def test_short_token_raises(self):
        with pytest.raises(FeishuLinkError, match="token 不合法"):
            parse_feishu_url("https://example.feishu.cn/docx/Ab1")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'lfx.components.tools.feishu_doc'`

- [ ] **Step 3: 写最小实现**

创建 `src/lfx/src/lfx/components/tools/feishu_doc.py`：

```python
"""飞书（Lark）文档读取组件：粘贴文档链接，输出标题与正文。

移植自 Wingsight（juben）``lib/feishu/link_parser.py`` 与 ``client.py`` 的
最小子集：链接解析为纯函数；HTTP 客户端用注入 transport 的 httpx，便于
测试以 ``httpx.MockTransport`` 模拟飞书开放平台。仅支持新版文档
（``/docx/``）与知识库节点（``/wiki/``），旧版文档/表格等明确报不支持。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse


FEISHU_BASE_URL = "https://open.feishu.cn"
LARK_BASE_URL = "https://open.larksuite.com"

# 旧版文档与表格等走别的接口族，明确拒绝而不是静默失败
_UNSUPPORTED_DOC_TYPES: dict[str, str] = {
    "docs": "旧版文档（doc）",
    "sheets": "电子表格",
    "file": "云空间文件",
    "base": "多维表格",
    "slides": "幻灯片",
    "board": "画板",
    "minutes": "妙记",
}

_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class FeishuLinkError(ValueError):
    """链接无法解析为受支持的飞书文档；``str(exc)`` 直接面向用户展示。"""


class FeishuApiError(RuntimeError):
    """飞书开放平台调用失败；中文 message 直接面向用户展示。"""


@dataclass(frozen=True)
class FeishuDocRef:
    url: str
    doc_type: str  # "docx" | "wiki"
    token: str
    platform: str  # "feishu" | "lark"


def _platform_of_host(host: str) -> str | None:
    lowered = host.lower()
    if lowered == "feishu.cn" or lowered.endswith(".feishu.cn"):
        return "feishu"
    if (
        lowered == "larksuite.com"
        or lowered.endswith(".larksuite.com")
        or lowered == "larkoffice.com"
        or lowered.endswith(".larkoffice.com")
    ):
        return "lark"
    return None


def parse_feishu_url(url: str) -> FeishuDocRef:
    """把用户粘贴的飞书链接解析为文档引用；不支持时抛 :class:`FeishuLinkError`。"""
    raw = (url or "").strip()
    if not raw:
        msg = "飞书链接不能为空"
        raise FeishuLinkError(msg)
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    platform = _platform_of_host(parsed.netloc.lower())
    if platform is None:
        msg = (
            "不是飞书文档链接（域名应为 *.feishu.cn / *.larksuite.com / *.larkoffice.com）："
            f"{raw}"
        )
        raise FeishuLinkError(msg)

    segments = [seg for seg in parsed.path.split("/") if seg]
    if not segments:
        msg = f"链接里没有文档路径（应为 /docx/<token> 或 /wiki/<token>）：{raw}"
        raise FeishuLinkError(msg)

    doc_type = segments[0].lower()
    if doc_type in _UNSUPPORTED_DOC_TYPES:
        label = _UNSUPPORTED_DOC_TYPES[doc_type]
        msg = f"暂不支持{label}链接，仅支持新版文档（/docx/）与知识库（/wiki/）：{raw}"
        raise FeishuLinkError(msg)
    if doc_type not in ("docx", "wiki"):
        msg = f"无法识别的飞书文档类型 /{doc_type}/，仅支持 /docx/ 与 /wiki/：{raw}"
        raise FeishuLinkError(msg)

    if len(segments) < 2 or not _TOKEN_PATTERN.match(segments[1]):
        msg = f"链接里的文档 token 不合法：{raw}"
        raise FeishuLinkError(msg)

    return FeishuDocRef(url=raw, doc_type=doc_type, token=segments[1], platform=platform)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py -v`
Expected: PASS（14 项左右全绿）

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/feishu_doc.py src/backend/tests/unit/components/tools/
uv run git commit -m "feat(tools): 飞书链接解析纯函数（parse_feishu_url）"
```

---

### Task 2: 飞书 API 客户端（token / wiki 解析 / 正文 / 错误映射）

**Files:**
- Modify: `src/lfx/src/lfx/components/tools/feishu_doc.py`（追加 `FeishuClient` 类）
- Test: `src/backend/tests/unit/components/tools/test_feishu_doc.py`（追加 `TestFeishuClient`）

**Interfaces:**
- Consumes: Task 1 的 `FeishuDocRef`、`FeishuApiError`
- Produces: `FeishuClient(app_id: str, app_secret: str, base_url: str = FEISHU_BASE_URL, transport: httpx.AsyncBaseTransport | None = None)`；异步方法 `fetch_document(doc_url: str) -> tuple[str, str]` 返回 `(title, content)`；错误统一抛 `FeishuApiError`（中文）。Task 3 的组件方法调用它。

- [ ] **Step 1: 写失败测试**

在 `test_feishu_doc.py` 追加：顶部 `import` 区改为 `import httpx as httpx_mod` + `import pytest`，并从 `lfx.components.tools.feishu_doc` 导入 `FEISHU_BASE_URL, FeishuApiError, FeishuClient, FeishuLinkError, parse_feishu_url`（Task 1 已导入其中两个，合并成一个 import 语句），然后追加测试类：

```python
DOC_URL = "https://example.feishu.cn/docx/Abcdefgh1234"
WIKI_URL = "https://example.feishu.cn/wiki/WikiToken123456"
TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal"


def _ok_token_response() -> dict:
    return {"code": 0, "tenant_access_token": "t-abc", "expire": 7200}


class TestFeishuClient:
    async def test_docx_fetch_returns_title_and_content(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            if request.url.path == "/open-apis/docx/v1/documents/Abcdefgh1234/basic_info":
                return httpx_mod.Response(200, json={"code": 0, "data": {"title": "香港奇案宣发资料"}})
            if request.url.path == "/open-apis/docx/v1/documents/Abcdefgh1234/raw_content":
                return httpx_mod.Response(200, json={"code": 0, "data": {"content": "五案一集一案。"}})
            return httpx_mod.Response(404, json={"code": 999})

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        title, content = await client.fetch_document(DOC_URL)
        assert title == "香港奇案宣发资料"
        assert content == "五案一集一案。"

    async def test_wiki_link_resolves_node_then_fetches(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            if request.url.path == "/open-apis/wiki/v2/spaces/get_node":
                assert request.url.params["token"] == "WikiToken123456"
                return httpx_mod.Response(
                    200,
                    json={"code": 0, "data": {"node": {"obj_token": "DocToken1234", "obj_type": "docx", "title": "知识库文档"}}},
                )
            if request.url.path == "/open-apis/docx/v1/documents/DocToken1234/raw_content":
                return httpx_mod.Response(200, json={"code": 0, "data": {"content": "正文"}})
            if request.url.path == "/open-apis/docx/v1/documents/DocToken1234/basic_info":
                return httpx_mod.Response(200, json={"code": 0, "data": {"title": "知识库文档"}})
            return httpx_mod.Response(404, json={"code": 999})

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        title, content = await client.fetch_document(WIKI_URL)
        assert title == "知识库文档"
        assert content == "正文"

    async def test_bad_credentials_raise_chinese_error(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json={"code": 99991663, "msg": "app secret invalid"})
            return httpx_mod.Response(404)

        client = FeishuClient("app", "wrong", transport=httpx_mod.MockTransport(handler))
        with pytest.raises(FeishuApiError, match="凭证校验失败"):
            await client.fetch_document(DOC_URL)

    async def test_http_403_maps_to_permission_error(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            return httpx_mod.Response(403)

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        with pytest.raises(FeishuApiError, match="访问权限"):
            await client.fetch_document(DOC_URL)

    async def test_envelope_forbidden_code_maps_to_permission_error(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            return httpx_mod.Response(200, json={"code": 1770002, "msg": "forbidden"})

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        with pytest.raises(FeishuApiError, match="访问权限"):
            await client.fetch_document(DOC_URL)

    async def test_http_404_maps_to_not_found(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            return httpx_mod.Response(404)

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        with pytest.raises(FeishuApiError, match="不存在"):
            await client.fetch_document(DOC_URL)

    async def test_default_base_url_is_feishu(self):
        client = FeishuClient("app", "secret")
        assert client._base_url == FEISHU_BASE_URL
```

注意：异步测试需要 pytest-asyncio；仓库测试已全局启用 async（`src/backend/tests/` 下大量 `async def test_` 直接可用，无需标记）。

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py::TestFeishuClient -v`
Expected: FAIL，`ImportError: cannot import name 'FeishuClient'`

- [ ] **Step 3: 实现 FeishuClient**

在 `feishu_doc.py` 追加。先在 import 区补 `import time`、`from typing import Any`、`import httpx`（追加到相应分组），再追加代码：

```python
_TOKEN_EXPIRY_MARGIN_SECONDS = 300.0
_HTTP_TIMEOUT_SECONDS = 20.0
# 飞书 envelope 业务码里表示"无权限"的常见值（HTTP 200 + code!=0 的老风格）
_FORBIDDEN_ENVELOPE_CODES = frozenset({"1770002", "230002"})


class FeishuClient:
    """飞书开放平台只读客户端：tenant token 管理 + wiki 解析 + 正文/标题读取。

    构造器注入 ``transport`` 供测试用 ``httpx.MockTransport`` 换实现；
    每次请求独立短连接，token 仅在单次 ``fetch_document`` 内复用。
    """

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        base_url: str = FEISHU_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not app_id or not app_secret:
            msg = "飞书应用凭证缺失：请在组件上填写 app_id 与 app_secret（或引用全局变量）"
            raise FeishuApiError(msg)
        self._app_id = app_id
        self._app_secret = app_secret
        self._base_url = base_url.rstrip("/")
        self._transport = transport
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> httpx.Response:
        headers: dict[str, str] = {"Content-Type": "application/json; charset=utf-8"}
        if auth:
            headers["Authorization"] = f"Bearer {await self._get_token()}"
        kwargs: dict[str, Any] = {"params": params, "headers": headers}
        if json_body is not None:
            kwargs["json"] = json_body
        async with httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT_SECONDS,
            transport=self._transport,
        ) as client:
            return await client.request(method, f"{self._base_url}{path}", **kwargs)

    async def _get_token(self) -> str:
        now = time.monotonic()
        if self._token and now < self._token_expires_at:
            return self._token
        response = await self._send(
            "POST",
            "/open-apis/auth/v3/tenant_access_token/internal",
            json_body={"app_id": self._app_id, "app_secret": self._app_secret},
            auth=False,
        )
        payload = _safe_json(response)
        token = str(payload.get("tenant_access_token") or "")
        if response.status_code != 200 or payload.get("code") not in (0, None) or not token:
            reason = str(payload.get("msg") or f"HTTP {response.status_code}")
            msg = f"飞书应用凭证校验失败（app_id/app_secret 无效或应用未发布）：{reason}"
            raise FeishuApiError(msg)
        self._token = token
        try:
            ttl = max(float(payload.get("expire") or 0), 60.0)
        except (TypeError, ValueError):
            ttl = 7200.0
        self._token_expires_at = now + ttl - _TOKEN_EXPIRY_MARGIN_SECONDS
        return self._token

    async def _api_json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        response = await self._send(method, path, params=params)
        status = response.status_code
        if status == 401:
            msg = "飞书应用凭证校验失败（tenant_access_token 无效，请核对 app_id/app_secret）"
            raise FeishuApiError(msg)
        if status == 403:
            msg = "应用没有该文档的访问权限：请在飞书文档里把应用机器人加为协作者，或把文档放进已授权给应用的知识库"
            raise FeishuApiError(msg)
        if status == 404:
            msg = "飞书文档不存在或已被删除"
            raise FeishuApiError(msg)
        if status >= 400:
            payload = _safe_json(response)
            reason = str(payload.get("msg") or f"HTTP {status}")
            msg = f"飞书接口调用失败：{reason}"
            raise FeishuApiError(msg)
        payload = _safe_json(response)
        code = payload.get("code")
        if code not in (0, None):
            reason = str(payload.get("msg") or f"code {code}")
            if str(code) in _FORBIDDEN_ENVELOPE_CODES:
                msg = "应用没有该文档的访问权限：请在飞书文档里把应用机器人加为协作者，或把文档放进已授权给应用的知识库"
                raise FeishuApiError(msg)
            msg = f"飞书接口调用失败：{reason}"
            raise FeishuApiError(msg)
        data = payload.get("data")
        return data if isinstance(data, dict) else {}

    async def fetch_document(self, doc_url: str) -> tuple[str, str]:
        """解析链接并返回 ``(title, content)``；wiki 链接先换成文档 id。"""
        ref = parse_feishu_url(doc_url)
        if ref.doc_type == "wiki":
            data = await self._api_json(
                "GET",
                "/open-apis/wiki/v2/spaces/get_node",
                params={"token": ref.token, "obj_type": "wiki"},
            )
            node = data.get("node")
            if not isinstance(node, dict) or not node.get("obj_token"):
                msg = "知识库节点不存在或已被删除"
                raise FeishuApiError(msg)
            if node.get("obj_type") != "docx":
                msg = "知识库节点指向的不是新版文档（docx），暂不支持"
                raise FeishuApiError(msg)
            document_id = str(node["obj_token"])
        else:
            document_id = ref.token

        info = await self._api_json("GET", f"/open-apis/docx/v1/documents/{document_id}/basic_info")
        title = str(info.get("title") or "").strip() or document_id
        raw = await self._api_json("GET", f"/open-apis/docx/v1/documents/{document_id}/raw_content")
        content = str(raw.get("content") or "")
        if not content.strip():
            msg = f"文档「{title}」正文为空（可能是空文档或应用无权限读取内容）"
            raise FeishuApiError(msg)
        return title, content


def _safe_json(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py -v`
Expected: PASS（Task 1 + Task 2 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/feishu_doc.py src/backend/tests/unit/components/tools/test_feishu_doc.py
uv run git commit -m "feat(tools): 飞书只读客户端（token/wiki/正文 + 中文错误映射）"
```

---

### Task 3: FeishuDocComponent 组件 + 注册 + 组件基类测试

**Files:**
- Modify: `src/lfx/src/lfx/components/tools/feishu_doc.py`（追加组件类）
- Modify: `src/lfx/src/lfx/components/tools/__init__.py`（注册，保持字母序：`FeishuDocComponent` 排在 `FileSystemToolComponent` 之后、`PythonREPLToolComponent` 之前）
- Test: `src/backend/tests/unit/components/tools/test_feishu_doc.py`（追加基类测试）

**Interfaces:**
- Consumes: Task 1 `parse_feishu_url`、Task 2 `FeishuClient`
- Produces: `FeishuDocComponent`，inputs `doc_url`（MessageTextInput）、`app_id`（SecretStrInput）、`app_secret`（SecretStrInput）、`base_url`（DropdownInput，`FEISHU_BASE_URL` / `LARK_BASE_URL`）；output `document`（Message，text = `"{标题}\n\n{正文}"`），method `fetch_document`。Task 4 的 flow JSON 引用 `type: "FeishuDocComponent"`。

- [ ] **Step 1: 写失败测试**

在 `test_feishu_doc.py` 追加基类测试与组件级 mock 测试：

```python
from lfx.components.tools.feishu_doc import FeishuDocComponent

from tests.base import ComponentTestBaseWithoutClient


class TestFeishuDocComponentBasis(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return FeishuDocComponent

    @pytest.fixture
    def default_kwargs(self):
        return {
            "doc_url": DOC_URL,
            "app_id": "cli_xxx",
            "app_secret": "secret_xxx",
            "base_url": FEISHU_BASE_URL,
        }

    @pytest.fixture
    def file_names_mapping(self):
        return [
            {"version": "1.13.0", "module": "tools", "file_name": "feishu_doc"},
        ]


class TestFeishuDocComponentFetch:
    async def test_fetch_document_returns_message_with_title_and_body(self, monkeypatch):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            if request.url.path.endswith("/basic_info"):
                return httpx_mod.Response(200, json={"code": 0, "data": {"title": "宣发资料"}})
            if request.url.path.endswith("/raw_content"):
                return httpx_mod.Response(200, json={"code": 0, "data": {"content": "正文内容"}})
            return httpx_mod.Response(404)

        component = FeishuDocComponent(
            doc_url=DOC_URL,
            app_id="cli_xxx",
            app_secret="secret_xxx",
            base_url=FEISHU_BASE_URL,
        )
        monkeypatch.setattr(
            component,
            "_build_client",
            lambda: FeishuClient("cli_xxx", "secret_xxx", FEISHU_BASE_URL, transport=httpx_mod.MockTransport(handler)),
        )
        message = await component.fetch_document()
        assert message.text == "宣发资料\n\n正文内容"

    async def test_fetch_document_link_error_propagates(self):
        component = FeishuDocComponent(
            doc_url="https://notion.so/docx/Abcdefgh1234",
            app_id="cli_xxx",
            app_secret="secret_xxx",
            base_url=FEISHU_BASE_URL,
        )
        with pytest.raises(FeishuLinkError, match="不是飞书文档链接"):
            await component.fetch_document()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py -v`
Expected: FAIL，`ImportError: cannot import name 'FeishuDocComponent'`

- [ ] **Step 3: 实现组件类并注册**

`feishu_doc.py` import 区补 `import httpx` 已在 Task 2 加入；再补 `from lfx.custom.custom_component.component import Component`、`from lfx.io import DropdownInput, MessageTextInput, Output, SecretStrInput`、`from lfx.schema.message import Message`，然后追加组件类：

```python
class FeishuDocComponent(Component):
    display_name = "飞书文档"
    description = "粘贴飞书（Lark）文档链接，读取标题与正文。仅支持新版文档（/docx/）与知识库节点（/wiki/）。"
    icon = "FileText"
    name = "FeishuDoc"

    inputs = [
        MessageTextInput(
            name="doc_url",
            display_name="文档链接",
            info="飞书文档链接，支持 *.feishu.cn/docx/<token>、/wiki/<token>，国际版 larksuite.com / larkoffice.com 同理",
            required=True,
        ),
        SecretStrInput(
            name="app_id",
            display_name="App ID",
            info="飞书自建应用 App ID（支持引用全局变量）",
            required=True,
        ),
        SecretStrInput(
            name="app_secret",
            display_name="App Secret",
            info="飞书自建应用 App Secret（支持引用全局变量）",
            required=True,
        ),
        DropdownInput(
            name="base_url",
            display_name="平台",
            options=[FEISHU_BASE_URL, LARK_BASE_URL],
            value=FEISHU_BASE_URL,
            info="飞书（中国版）或 Lark（国际版）的开放平台接入点",
        ),
    ]

    outputs = [
        Output(display_name="文档", name="document", method="fetch_document"),
    ]

    def _build_client(self) -> FeishuClient:
        return FeishuClient(
            app_id=str(self.app_id or ""),
            app_secret=str(self.app_secret or ""),
            base_url=str(self.base_url or FEISHU_BASE_URL),
        )

    async def fetch_document(self) -> Message:
        title, content = await self._build_client().fetch_document(self.doc_url)
        text = f"{title}\n\n{content}"
        self.status = text
        return Message(text=text)
```

`src/lfx/src/lfx/components/tools/__init__.py`：
- `_dynamic_imports` 字典中按字母序插入 `"FeishuDocComponent": "feishu_doc",`（排在 `"FileSystemToolComponent"` 条目之后、`"PythonREPLToolComponent"` 之前）
- `_TYPE_CHECKING` import 块加 `from .feishu_doc import FeishuDocComponent`
- `__all__` 列表按字母序加 `"FeishuDocComponent"`

- [ ] **Step 4: 跑测试确认通过（含注册冒烟）**

Run: `uv run pytest src/backend/tests/unit/components/tools/test_feishu_doc.py src/backend/tests/unit/components/test_all_modules_importable.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lfx/src/lfx/components/tools/feishu_doc.py src/lfx/src/lfx/components/tools/__init__.py src/backend/tests/unit/components/tools/test_feishu_doc.py
uv run git commit -m "feat(tools): 飞书文档组件（FeishuDocComponent）并注册"
```

---

### Task 4: 预置 flow JSON（含完整写作 Prompt 模板）

**Files:**
- Create: `examples/promotion/promotion-copy.flow.json`
- Create: `examples/promotion/prompt-template.md`（模板单独存一份便于评审与复用；flow JSON 内嵌同一份文本，两处以模板文件为准同步）

**Interfaces:**
- Consumes: Task 3 的 `FeishuDocComponent`；langflow 内置 `TextInputComponent`、`PromptComponent`、`LanguageModelComponent`、`CombineTextComponent`、`TextOutputComponent`
- Produces: 可在 langflow UI「Import」导入的 flow JSON（顶层字段结构照抄 `src/backend/base/langflow/initial_setup/starter_projects/Basic Prompting.json`）

- [ ] **Step 1: 写 Prompt 模板文件**

创建 `examples/promotion/prompt-template.md`，内容如下（正文即 Prompt 组件 template 字段的最终值，`{var}` 为 langflow 变量占位）：

````markdown
# 宣发写作 Prompt 模板

以下内容整体作为 Langflow「Prompt」组件的 template 字段值。

------

你是影视宣发的资深文案写手，为真实项目写可直接发布的平台文案。产出是候选包：用户从变体里挑着发，每一条都要独立成立，读起来像写完的一条。钩子方向互不相同。

只学「本平台正例」的语感、节奏和结构。案例里的片名、演员、案件、出品方一个字都不能带到这次任务里——事实全部换成宣发资料。几行、要不要表情、话题怎么写，以本平台规则为准。

# 任务

为《{title}》写 {count} 条{platform}文案。本次批次：{batch_kind}。

- 日常批次（daily）：第一句就是钩子（场面、台词、数字、反差），不要「即将上线」铺垫，不要职务名单当钩子。
- 节点批次（milestone）：先让人知道是什么片，再给钩子。卖片种和看下去的理由，不要职务 credits，不要搬通稿，不要拿整部剧情填空。

# 宣发资料（唯一事实来源，没写的不编）

{doc_content}

资料没写的不编；待定项用 【短链接】/【播出平台】 占位，不编日期和数据。不要编「我看完了」这种亲历。出品用机构名，不要职务 credits 开场。

# 怎么写好

一条文案卖为什么点进去，不复述剧情。第一句就是钩子，钩子成立就停，不要再补第二条剧情。空形容词、中心思想句删掉。提问或轻共鸣可有可无，没有就不要硬造。变体之间换切入（场面 / 台词 / 数字 / 反差 / 提问），不要同一骨架换词。

# 平台规则（只应用当前平台 {platform} 的那一段）

【douyin 抖音】信息流折叠文案：一句钩子成文，话题另起一行；确需补充最多再加 1 句。首句 ≤25 字，正文（去话题）≤55 字，话题 ≤5 个、单井号格式（#话题）。文案与话题都不得出现播出平台名（爱奇艺/腾讯视频等，会被限流），捷报数据换"全网热播/热度攀升"等说法。结尾不用带链接。节点先亮片名再给钩子。

【channels 视频号】一句钩子成文，确需补充最多再加 1 句。首句 ≤25 字，正文 ≤55 字，话题 ≤5 个单井号。文案与话题不出现其他平台名。节点把身份和钩子压进一两行。不要「出品人/导演 + 人名」开场。

【weibo 微博】信息量可以更大、要有可讨论性：有效话题 ≤3 个、双井号格式（#话题#，首行片名话题 #片名#），结尾带播出平台与日期信息（如"8月13日起爱奇艺独播"）。仍是一个点写完，不要把核心看点逐条换行粘贴。默认不用表情，需要点情绪时最多 1 个。节点先亮片名或出品机构。

【moments 朋友圈】转发裂变场景。首行亮身份（#片名 + 属性或一句钩子），末行给收看路径（平台名 + 【短链接】）。主创名单不进开场。表情按口吻，转发轻松向可用一枚平台 emoji（爱奇艺🥝 / 腾讯视频🐧 / 优酷👖），硬核题材钩子够就不堆。
- form=short（四行文案，不折叠，最多 6 行含短链接与话题行）：第一行亮身份，中间 2-3 行把同一个钩子写具体（不要一行一个互不相关的剧情点），末行收看路径。像朋友转发时配的话，不像官方通稿。
- form=long（长文案，面向平台方/合作方，3 段以内）：第一段我是谁（出品机构或片名+档期平台），第二段只展开一个看点，第三段行动号召+【短链接】。禁止"刷屏预警！"式空喊开头。
（当前 form 为：{form}；非朋友圈时忽略 form 相关内容）

# 本平台正例（学语感与结构；事实与片名换成宣发资料，只看当前平台）

抖音 · 日常（一句戏当钩子）：
命案目击者接受警察问询，崩溃边缘展示超绝记忆力
#终于等到悬案王传凯出场了 #剧集悬案 #曾美慧孜
学：钩子是场面词，零介绍。

抖音 · 日常（台词直接上台）：
王妃：在下略懂一些刀法，什么刀你别管
#御赐小仵作2开播 #御赐小仵作2 #苏晓彤
学：原话够狠就一句成文，不解释人物背景。

抖音 · 日常（一句场面）：
萧北冥一进门，桌上那份卷宗还没拆
#定风波 #悬疑
学：追更就写这一下。

抖音 · 节点（结构卖点）：
#香港奇案开播 五案一集一案
港片质感，真实到窒息
#香港奇案 #悬疑
学：卖片种和结构，不写成谁杀了谁。

抖音 · 节点（卖片种不复述剧情）：
#入局开播 卧底大案层层反转
最强烧脑，谁是终极boss
#入局 #悬疑
学：卖为什么点进去。

抖音 · 日常（幕后细节开场）：
做这部片子最难的一镜，是八仙饭店那间屋子
没有实拍，全靠旧报纸一间间把现场搭回来
#香港奇案 #纪录片
学：第一行就是钩子，两行讲完不铺垫。

微博 · 捷报（数字当新闻）：
【师弟播报】恭喜 #剧集南部档案# 爱奇艺热度峰值达 9303！进入爱奇艺人气殿堂！
开播后第一次站上这个数
锁定正在热播！
学：捷报数据放开头；有效话题只有片名一个。

微博 · 节点（身份 + 一个点 + 收看）：
#迟到27年的无罪判决#
等了 9778 天，从死缓等到无罪。
8月26日爱奇艺独家播出
学：有数字就让数字当钩子。

微博 · 节点（只抛悬念）：
#双面棋#
越查越不像自己人。看到最后才知道，谁才是那个boss。
即将上线
学：留问题就停，人名不出现。

微博 · 日常（一个场面写完）：
#御赐小仵作2开播#
王妃：在下略懂一些刀法，什么刀你别管
正在播出
学：一个场面或一句原话写完，不套定档骨架。

朋友圈四行 · 节点（身份 + 一个点 + 收看）：
#华夏风云人物·南宋篇开播
翼视界出品，AI 重现岳飞一生
爱奇艺首播，锁定观看！
学：四行是身份、一个点、收看；出品写机构品牌。

朋友圈四行 · 节点（IP 属性先行）：
#迟到27年的无罪判决
9778天，从死缓等到无罪
🥝8月26日爱奇艺独家播出【短链接】
学：中间只写这一个点。

朋友圈四行 · 捷报（数据当由头）：
#香港奇案
登陆爱奇艺热播榜TOP5
港片质感，真实到窒息
🥝爱奇艺热播中【短链接】
学：捷报数据放开头当新闻，总括压到八个字。

朋友圈四行 · 节点（转发向卖观感）：
#夜线开播
卧底进局，层层反转
最强烧脑，看到最后才知道谁是boss
【播出平台】【短链接】
学：中间两行是观感，不要一行一个剧情点。

朋友圈四行 · 日常（一个场面）：
#御赐小仵作2# 开播
王妃那句「什么刀你别管」，刀还没亮
正在热播【短链接】
学：中间只展开这一个场面。

朋友圈长文 · 节点（身份 + 一个体验 + 行动）：
8月3日由山西博物院、央视视频、北京翼视界文化传媒联合出品的AR沉浸式互动#晋游记 已正式开启！
让文物活起来、让历史走到身边，以参与者身份走进晋国风云，边玩边学。
诚邀热爱历史文化的你，来山西博物院线下，一起共赴这场穿越千年的探索。
学：长文三段——出品机构第一段，第二段只展开一个体验，第三段行动号召。

朋友圈长文 · 节点（卖体验不剧透）：
小河文化出品的#夹缝#开播了。
今年最能熬的一部：卧底进局，层层反转，看到最后才知道谁是boss。
去【播出平台】看：【短链接】
学：第二段写看下去的理由，不复述谁干了什么。

# 本次附加要求（用户原话，在写法和平台红线之内优先满足）

{brief}

# 输出

{count} 个变体，每个一节，钩子类型从这些里选（≤6 字）：数字 / 反差 / 身份反差 / 场景代入 / 悬念 / 台词 / 未解之谜 / 极端事实 / 质感 / 时间线 / 提问 / 热梗。格式：

## 变体 1 · 钩子类型
（文案正文，含话题标签）

编号从 1 递增，{count} 条必须 {count} 个不同切入，不要同一骨架换词，也不要把看点缩写成谁是谁、谁杀了谁。不要用出品人/导演/监制/制片人+人名当变体差异。不要输出任何变体之外的解释文字。
````

- [ ] **Step 2: 构建 flow JSON**

创建 `examples/promotion/promotion-copy.flow.json`。结构照抄 `Basic Prompting.json`（顶层 `id/description/name/endpoint_name/is_component/last_tested_version/tags` + `data.edges/nodes/viewport`），节点模板逐字段参考 starter 中同类型节点。节点清单：

| 节点 id | type | 关键配置 |
| --- | --- | --- |
| `TextInput-FeishuUrl` | TextInputComponent | `input_value` 空 |
| `TextInput-Platform` | TextInputComponent | `input_value` = `douyin` |
| `TextInput-Form` | TextInputComponent | `input_value` = `short` |
| `TextInput-BatchKind` | TextInputComponent | `input_value` = `daily` |
| `TextInput-Title` | TextInputComponent | `input_value` 空 |
| `TextInput-Brief` | TextInputComponent | `input_value` 空 |
| `TextInput-Count` | TextInputComponent | `input_value` = `5` |
| `FeishuDocComponent-Source` | FeishuDocComponent | `doc_url` 接链接输入；`app_id`/`app_secret` 值留空（用户填或引全局变量）；`base_url` = `https://open.feishu.cn` |
| `PromptTemplate-Writer` | PromptComponent | `template` = prompt-template.md 正文；变量 `doc_content/platform/form/batch_kind/title/brief/count` 由 Prompt 组件从模板自动生成字段 |
| `LanguageModelComponent-DeepSeek` | LanguageModelComponent | `model.value` = `[{"name": "deepseek-v4-flash", "provider": "OpenAI", "category": "OpenAI"}]` |
| `LanguageModelComponent-DmxGpt` | LanguageModelComponent | `model.value` = `[{"name": "gpt-5.6-luna", "provider": "OpenAI Compatible", "category": "OpenAI Compatible"}]` |
| `LanguageModelComponent-DmxGemini` | LanguageModelComponent | `model.value` = `[{"name": "gemini-3.7-flash", "provider": "OpenAI Compatible", "category": "OpenAI Compatible"}]` |
| `CombineText-Merge12` | CombineTextComponent | text1 ← DeepSeek 输出，text2 ← DmxGpt 输出，delimiter = `"\n\n---\n\n"` |
| `CombineText-Merge123` | CombineTextComponent | text1 ← Merge12，text2 ← DmxGemini 输出，delimiter = `"\n\n---\n\n"` |
| `TextOutputComponent-Result` | TextOutputComponent | 接 Merge123 |

连线（targetHandle 为各组件输入字段名；sourceHandle 为 `{dataType, id, name, output_types}` 对象，格式同 starter）：
- `TextInput-FeishuUrl.text` → `FeishuDocComponent-Source.doc_url`
- `FeishuDocComponent-Source.document` → `PromptTemplate-Writer.doc_content`
- `TextInput-Platform.text` → `PromptTemplate-Writer.platform`
- `TextInput-Form.text` → `PromptTemplate-Writer.form`
- `TextInput-BatchKind.text` → `PromptTemplate-Writer.batch_kind`
- `TextInput-Title.text` → `PromptTemplate-Writer.title`
- `TextInput-Brief.text` → `PromptTemplate-Writer.brief`
- `TextInput-Count.text` → `PromptTemplate-Writer.count`
- `PromptTemplate-Writer.prompt` → 三个 LanguageModelComponent 的 `input_value`（各一条边）
- 三个 LanguageModelComponent 的 `text` 输出 → 两个 CombineText 的 `text1`/`text2`
- `CombineText-Merge123.combined_text` → `TextOutputComponent-Result.input_value`

节点 `data.node.template` 的完整字段集：从 starter 的同类型节点复制（含 `code/_type/field_order` 等），只改需要的 value；FeishuDocComponent 的 template 按 Task 3 inputs 生成（每个 input 一项，含 `name/display_name/value/required/type` 等，参照 starter 中组件字段的字段结构）。

- [ ] **Step 3: 校验 JSON 与组件引用**

Run: `uv run python -c "import json; f=json.load(open('examples/promotion/promotion-copy.flow.json')); nodes=f['data']['nodes']; print(len(nodes), 'nodes'); assert all(n['data'].get('type') for n in nodes)"`
Expected: 打印 `15 nodes`，无断言错误。

再确认所有引用的组件类型真实存在：
`uv run python -c "from lfx.components.input_output import TextInputComponent; from lfx.components.models_and_agents import PromptComponent, LanguageModelComponent; from lfx.components.processing import CombineTextComponent; from lfx.components.input_output import TextOutputComponent; from lfx.components.tools import FeishuDocComponent; print('ok')"`

- [ ] **Step 4: 本地导入冒烟（人工/UI 步骤，执行者用 browser 或请用户配合）**

启动 `make backend` + `make frontend`，UI 中 Import 该 JSON，确认：画布出现 15 个节点、连线完整、三个模型节点显示预选模型名。若模型预选被导入丢弃（ModelInput 值格式与前端期望不完全一致），在 README 补一条「导入后在模型节点重新选择模型」的操作说明，不阻塞本任务。

- [ ] **Step 5: 提交**

```bash
git add examples/promotion/
uv run git commit -m "feat(examples): 宣发文案预置 flow（飞书→Prompt→三路 LLM→合并）"
```

---

### Task 5: README 与端到端验证

**Files:**
- Create: `examples/promotion/README.md`

**Interfaces:**
- Consumes: Task 1-4 全部交付物
- Produces: 面向最终用户的使用文档

- [ ] **Step 1: 写 README**

`examples/promotion/README.md` 内容框架（按此写出完整中文文档）：

1. **功能**：输入飞书文档链接 + 平台/批次/主题等参数，三路模型并行产出宣发文案候选
2. **前置一：模型提供商配置**（设置 → 模型提供商）：
   - 「OpenAI Compatible」槽位：Base URL `https://www.dmxapi.cn/v1`，API Key = DMXAPI key（juben `projects/.wingsight.db` 的 `provider_credential` 表 provider=dmx 行）
   - 「OpenAI」槽位：OpenAI Base URL `https://api.deepseek.com`，API Key = DeepSeek key（juben 同库 `custom_provider` 表 id=3 行）
   - 配完用「验证连接」测试；注意 OpenAI 槽位被 DeepSeek 借用后不能同时接官方 OpenAI
3. **前置二：飞书自建应用**：需要 App ID / App Secret，开通文档只读权限（`docx:document:readonly`、`wiki:wiki:readonly`）；应用机器人需被加为文档协作者或文档在授权知识库内。详细申请步骤见 juben 仓库 `docs/feishu-setup.md`（摘要：飞书开放平台 → 创建企业自建应用 → 添加权限 → 发布版本 → 把机器人拉进文档协作者）
4. **导入 flow**：langflow UI → Flows → Import → 选 `promotion-copy.flow.json`
5. **运行**：填飞书链接、平台（douyin/channels/weibo/moments）、形态（仅朋友圈 short/long）、批次（daily/milestone）、主题、简报（可选）、每路变体数（默认 5）→ Run；产出在 TextOutput 节点查看
6. **常见错误对照表**：凭证校验失败 / 无访问权限 / 文档不存在 / 正文为空 —— 分别对应组件抛出的四类中文错误及处理办法
7. **改写作规则**：直接在画布上编辑 Prompt 节点模板；模板源文件在 `examples/promotion/prompt-template.md`

- [ ] **Step 2: 全量回归**

Run: `uv run pytest src/backend/tests/unit/components/tools/ -v && make format_backend && uv run pytest src/backend/tests/unit/components/tools/ -q`
Expected: 全绿（format 后无 diff 或已格式化）

- [ ] **Step 3: 提交**

```bash
git add examples/promotion/README.md
uv run git commit -m "docs(examples): 宣发 flow 使用说明（模型/飞书配置与运行指南）"
```
