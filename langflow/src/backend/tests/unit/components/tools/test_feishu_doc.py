import httpx as httpx_mod
import pytest
from lfx.components.tools.feishu_doc import (
    FEISHU_BASE_URL,
    FeishuApiError,
    FeishuClient,
    FeishuDocComponent,
    FeishuLinkError,
    parse_feishu_url,
)
from pydantic import SecretStr

from tests.base import DID_NOT_EXIST, ComponentTestBaseWithoutClient


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

    @pytest.mark.parametrize(
        ("doc_type", "label"),
        [
            ("docs", "旧版文档"),
            ("sheets", "电子表格"),
            ("base", "多维表格"),
            ("file", "云空间文件"),
        ],
    )
    def test_unsupported_doc_types_raise_with_label(self, doc_type, label):
        with pytest.raises(FeishuLinkError, match=label):
            parse_feishu_url(f"https://example.feishu.cn/{doc_type}/Abcdefgh1234")

    def test_unknown_path_segment_raises(self):
        with pytest.raises(FeishuLinkError, match="无法识别"):
            parse_feishu_url("https://example.feishu.cn/whatever/Abcdefgh1234")

    def test_short_token_raises(self):
        with pytest.raises(FeishuLinkError, match="token 不合法"):
            parse_feishu_url("https://example.feishu.cn/docx/Ab1")


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
            if request.url.path == "/open-apis/docx/v1/documents/Abcdefgh1234":
                return httpx_mod.Response(200, json={"code": 0, "data": {"document": {"title": "香港奇案宣发资料"}}})
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
                    json={
                        "code": 0,
                        "data": {"node": {"obj_token": "DocToken1234", "obj_type": "docx", "title": "知识库文档"}},
                    },
                )
            if request.url.path == "/open-apis/docx/v1/documents/DocToken1234/raw_content":
                return httpx_mod.Response(200, json={"code": 0, "data": {"content": "正文"}})
            return httpx_mod.Response(404, json={"code": 999})

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        title, content = await client.fetch_document(WIKI_URL)
        # wiki 标题来自节点响应，不再额外调文档信息接口
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

    async def test_network_error_wrapped_as_chinese_error(self):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            raise httpx_mod.ConnectError("connection refused")

        client = FeishuClient("app", "secret", transport=httpx_mod.MockTransport(handler))
        with pytest.raises(FeishuApiError, match="网络"):
            await client.fetch_document(DOC_URL)


class TestFeishuDocComponentBasis(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return FeishuDocComponent

    @pytest.fixture
    def default_kwargs(self):
        return {
            "doc_url": DOC_URL,
            "app_id": "cli_xxx",
            "app_secret": "secret_xxx",  # pragma: allowlist secret
            "base_url": FEISHU_BASE_URL,
        }

    @pytest.fixture
    def file_names_mapping(self):
        # 该组件自 1.13.0 起以 feishu_doc 交付；SUPPORTED_VERSIONS 里的历史版本均未收录
        return [
            {"version": "1.0.19", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.1.0", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.1.1", "module": "tools", "file_name": DID_NOT_EXIST},
            {"version": "1.13.0", "module": "tools", "file_name": "feishu_doc"},
        ]


class TestFeishuDocComponentFetch:
    async def test_fetch_document_returns_message_with_title_and_body(self, monkeypatch):
        def handler(request: httpx_mod.Request) -> httpx_mod.Response:
            if request.url.path == TOKEN_PATH:
                return httpx_mod.Response(200, json=_ok_token_response())
            if request.url.path.endswith("/documents/Abcdefgh1234"):
                return httpx_mod.Response(200, json={"code": 0, "data": {"document": {"title": "宣发资料"}}})
            if request.url.path.endswith("/raw_content"):
                return httpx_mod.Response(200, json={"code": 0, "data": {"content": "正文内容"}})
            return httpx_mod.Response(404)

        component = FeishuDocComponent(
            doc_url=DOC_URL,
            app_id="cli_xxx",
            app_secret="secret_xxx",  # pragma: allowlist secret
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
            app_secret="secret_xxx",  # pragma: allowlist secret
            base_url=FEISHU_BASE_URL,
        )
        with pytest.raises(FeishuLinkError, match="不是飞书文档链接"):
            await component.fetch_document()


class TestFeishuDocComponentSecretInputs:
    def test_build_client_unwraps_secretstr_credentials(self):
        component = FeishuDocComponent(
            doc_url=DOC_URL,
            app_id=SecretStr("cli_real_id"),
            app_secret=SecretStr("secret_real_value"),  # pragma: allowlist secret
            base_url=FEISHU_BASE_URL,
        )
        client = component._build_client()
        assert client._app_id == "cli_real_id"
        assert client._app_secret == "secret_real_value"  # pragma: allowlist secret
