"""飞书（Lark）文档读取组件：粘贴文档链接，输出标题与正文。

移植自 Wingsight（juben）``lib/feishu/link_parser.py`` 与 ``client.py`` 的
最小子集：链接解析为纯函数；HTTP 客户端用注入 transport 的 httpx，便于
测试以 ``httpx.MockTransport`` 模拟飞书开放平台。仅支持新版文档
（``/docx/``）与知识库节点（``/wiki/``），旧版文档/表格等明确报不支持。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from lfx.custom.custom_component.component import Component
from lfx.io import DropdownInput, MessageTextInput, Output, SecretStrInput
from lfx.schema.message import Message
from lfx.utils.secrets import secret_value_to_str

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
        msg = f"不是飞书文档链接（域名应为 *.feishu.cn / *.larksuite.com / *.larkoffice.com）：{raw}"
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
        """解析链接并返回 ``(title, content)``；wiki 链接先换成文档 id。

        传输层异常（DNS 失败、连接拒绝、超时等 httpx.HTTPError 子类）统一
        包装为中文 :class:`FeishuApiError`，不外泄英文原始异常。
        """
        try:
            return await self._fetch_document(doc_url)
        except httpx.HTTPError as exc:
            reason = str(exc) or type(exc).__name__
            msg = f"网络连接失败（无法访问飞书开放平台）：{reason}"
            raise FeishuApiError(msg) from exc

    async def _fetch_document(self, doc_url: str) -> tuple[str, str]:
        ref = parse_feishu_url(doc_url)
        title: str | None = None
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
            # wiki 节点响应自带标题，无需再查文档信息
            title = str(node.get("title") or "").strip() or None
        else:
            document_id = ref.token

        if title is None:
            # 官方文档信息接口是 GET /docx/v1/documents/:id（无 basic_info 后缀，
            # 那条路径在飞书网关上不存在，会 404）
            info = await self._api_json("GET", f"/open-apis/docx/v1/documents/{document_id}")
            document = info.get("document")
            doc_title = document.get("title") if isinstance(document, dict) else None
            title = str(doc_title or "").strip() or document_id
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


class FeishuDocComponent(Component):
    display_name = "飞书文档"
    description = "粘贴飞书（Lark）文档链接，读取标题与正文。仅支持新版文档（/docx/）与知识库节点（/wiki/）。"
    icon = "FileText"
    name = "FeishuDoc"

    inputs = [
        MessageTextInput(
            name="doc_url",
            display_name="文档链接",
            info="飞书文档链接，支持 *.feishu.cn/docx/<token>、/wiki/<token>，"
            "国际版 larksuite.com / larkoffice.com 同理",
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
        # 全局凭证变量下发的值可能是 pydantic SecretStr，str() 只会得到掩码，
        # 必须先解包再交给客户端；base_url 来自 DropdownInput，始终是明文。
        return FeishuClient(
            app_id=secret_value_to_str(self.app_id) or "",
            app_secret=secret_value_to_str(self.app_secret) or "",
            base_url=str(self.base_url or FEISHU_BASE_URL),
        )

    async def fetch_document(self) -> Message:
        title, content = await self._build_client().fetch_document(self.doc_url)
        text = f"{title}\n\n{content}"
        self.status = text
        return Message(text=text)
