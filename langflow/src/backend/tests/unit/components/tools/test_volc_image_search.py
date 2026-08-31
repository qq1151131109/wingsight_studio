"""VolcImageSearchComponent（豆包搜图）单元测试。

搜索/下载逻辑通过 ``httpx.MockTransport`` 注入假响应，不打真实网络。
"""

from pathlib import Path

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
        {
            "Title": f"图{i}",
            "Url": f"https://page.example/{i}",
            "Image": {"Url": f"https://img.example/{i}.jpg", "Width": 800, "Height": 600},
        }
        for i in range(1, n + 1)
    ]
    return {"Result": {"ImageResults": images}}


class TestVolcImageSearch:
    @pytest.mark.asyncio
    async def test_search_parses_results(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path.endswith("/web_search")
            return httpx.Response(200, json=_ok_payload(2))

        results = await volc_image_search(
            "清代长袍", "key", limit=3, client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        assert len(results) == 2
        assert results[0]["url"] == "https://img.example/1.jpg"
        assert results[0]["width"] == 800

    @pytest.mark.asyncio
    async def test_no_results_returns_empty(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"Result": {}})

        assert (
            await volc_image_search("x", "key", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) == []
        )

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
                return httpx.Response(
                    200, json={"ResponseMetadata": {"Error": {"CodeN": 700429, "Message": "rate limit"}}}
                )
            return httpx.Response(200, json=_ok_payload(1))

        monkeypatch.setattr("lfx.components.tools.volc_image_search._RETRY_BASE_DELAY", 0)
        results = await volc_image_search("x", "key", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        assert len(results) == 1
        assert calls["n"] == 3

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

        results = [
            {"url": "https://img/1.png", "width": 4, "height": 4},
            {"url": "https://img/bad.bin", "width": 0, "height": 0},
        ]
        out = await download_search_images(
            results,
            max_images=3,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            dest_dir=tmp_path / "refs",
        )
        assert len(out) == 1
        assert Path(out[0]["local_path"]).exists()


class TestComponent(ComponentTestBaseWithoutClient):
    @pytest.fixture
    def component_class(self):
        return VolcImageSearchComponent

    @pytest.fixture
    def default_kwargs(self):
        return {"query": "清代长袍", "api_key": "key", "limit": 3}  # pragma: allowlist secret

    @pytest.fixture
    def file_names_mapping(self):
        return []

    @pytest.fixture(autouse=True)
    def _stub(self, monkeypatch):
        async def fake_search(query, api_key, *, limit=3, client=None):
            return [{"url": "https://img/1.jpg", "width": 1, "height": 1}]

        async def fake_download(results, *, max_images=3, client=None, dest_dir=None):
            return [{"url": r["url"], "width": 1, "height": 1, "local_path": "refs/stub_1.jpg"} for r in results]

        monkeypatch.setattr("lfx.components.tools.volc_image_search.volc_image_search", fake_search)
        monkeypatch.setattr("lfx.components.tools.volc_image_search.download_search_images", fake_download)
