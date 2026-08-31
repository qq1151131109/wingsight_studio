import base64
import io
from pathlib import Path
from types import SimpleNamespace

import pytest
from lfx.components.tools.image_generation import (
    ImageGenerationComponent,
    compute_image_size,
    generate_image,
)

from tests.base import ComponentTestBaseWithoutClient

_TIERS = {"1K": 1024, "2K": 1440, "4K": 2160}


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

    @pytest.mark.parametrize(
        ("ratio", "resolution"),
        [(r, res) for r in ("16:9", "4:3", "9:16") for res in ("1K", "2K", "4K")],
    )
    def test_divisible_by_16_and_ratio_exact(self, ratio, resolution):
        w, h = compute_image_size(ratio, resolution)
        assert w % 16 == 0 and h % 16 == 0
        aw, ah = (int(x) for x in ratio.split(":"))
        assert w * ah == h * aw  # 比例零偏差
        assert min(w, h) >= _TIERS[resolution]  # 短边 ≥ 档位, 竖版短边是宽度

    def test_bad_ratio_message_mentions_generic_form(self):
        with pytest.raises(ValueError, match="支持 w:h"):
            compute_image_size("16x9")


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
                self.closed = False
                captured["client"] = self

            async def close(self):
                self.closed = True

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        result = await generate_image(
            "一只猫",
            model="gpt-image-2-03",
            base_url="https://www.dmxapi.cn/v1",
            api_key="k",
            aspect_ratio="16:9",
            resolution="1K",
            dest_dir=tmp_path,
        )
        assert captured["model"] == "gpt-image-2-03"
        assert captured["size"] == "2048x1152"
        assert "image" not in captured
        assert result["width"] == 2048 and Path(result["path"]).exists()
        assert captured["client"].closed is True  # 用完即关, 防批量出图连接堆积

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
                self.closed = False
                captured["client"] = self

            async def close(self):
                self.closed = True

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        result = await generate_image(
            "一只猫",
            model="m",
            base_url="https://x/v1",
            api_key="k",
            reference_images=[str(ref), "/nonexistent.png"],
            dest_dir=tmp_path,
        )
        assert captured["image_count"] == 1
        assert captured["size"] == "2048x1152"
        assert result["model"] == "m"
        assert captured["client"].closed is True

    @pytest.mark.asyncio
    async def test_api_error_closes_client_and_raises_chinese(self, tmp_path, monkeypatch):
        captured = {}

        class FakeImages:
            async def generate(self, **kwargs):
                raise RuntimeError("boom")

            async def edit(self, **kwargs):
                raise AssertionError("不应走 edit")

        class FakeClient:
            def __init__(self, **kwargs):
                self.images = FakeImages()
                self.closed = False
                captured["client"] = self

            async def close(self):
                self.closed = True

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        with pytest.raises(ValueError, match="图像生成失败"):
            await generate_image("一只猫", model="m", base_url="https://x/v1", api_key="k", dest_dir=tmp_path)
        assert captured["client"].closed is True  # 异常路径也要关闭客户端

    @pytest.mark.asyncio
    async def test_save_b64_failure_raises_chinese(self, tmp_path, monkeypatch):
        class FakeImages:
            async def generate(self, **kwargs):
                return SimpleNamespace(data=[SimpleNamespace(b64_json="%%%not-base64%%%", url=None)])

        class FakeClient:
            def __init__(self, **kwargs):
                self.images = FakeImages()

            async def close(self):
                return None

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        with pytest.raises(ValueError, match="图像保存失败"):
            await generate_image("一只猫", model="m", base_url="https://x/v1", api_key="k", dest_dir=tmp_path)

    @pytest.mark.asyncio
    async def test_save_url_failure_raises_chinese(self, tmp_path, monkeypatch):
        class FakeImages:
            async def generate(self, **kwargs):
                return SimpleNamespace(data=[SimpleNamespace(b64_json=None, url="https://img/x.png")])

        class FakeClient:
            def __init__(self, **kwargs):
                self.images = FakeImages()

            async def close(self):
                return None

        def fake_get(*args, **kwargs):
            msg = "connection refused"
            raise RuntimeError(msg)

        monkeypatch.setattr("lfx.components.tools.image_generation.AsyncOpenAI", FakeClient)
        monkeypatch.setattr(
            "lfx.components.tools.image_generation.ssrf_protected_openai_clients_for_url",
            lambda url: {},
        )
        monkeypatch.setattr("lfx.utils.ssrf_httpx.ssrf_safe_httpx_get", fake_get)
        with pytest.raises(ValueError, match="图像保存失败"):
            await generate_image("一只猫", model="m", base_url="https://x/v1", api_key="k", dest_dir=tmp_path)


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
