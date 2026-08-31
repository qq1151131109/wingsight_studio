import asyncio

import pytest
from lfx.components.tools import batch_asset_sheet as bas
from lfx.components.tools.batch_asset_sheet import (
    LAYOUT_SPECS,
    BatchAssetSheetComponent,
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
        assets = [
            {"type": "scene", "name": f"场景{i}", "description": "d", "visual_notes": "v", "search_query": "q"}
            for i in range(15)
        ]
        assets.append({"type": "vehicle", "name": "x", "description": "d", "visual_notes": "v", "search_query": "q"})
        parsed = parse_assets_payload({"assets": assets} if False else str(assets).replace("'", '"'), max_assets=10)
        assert len(parsed) == 10 and all(a["type"] == "scene" for a in parsed)

    def test_invalid_raises_chinese(self):
        with pytest.raises(ValueError, match="资产清单"):
            parse_assets_payload("完全不是 JSON", max_assets=10)


class TestRenderPrompt:
    def test_character_layout(self):
        prompt = render_asset_prompt(
            {"type": "character", "name": "林万年", "description": "清末商人", "visual_notes": "长袍马褂"}
        )
        assert "纯白" in prompt and "A-Pose" in prompt and "林万年" in prompt
        assert "可读文字" in prompt  # 文字守卫

    def test_scene_layout(self):
        prompt = render_asset_prompt(
            {"type": "scene", "name": "老宅正厅", "description": "清代宅院", "visual_notes": "午后光"}
        )
        assert "无人" in prompt and "老宅正厅" in prompt

    def test_prop_layout(self):
        prompt = render_asset_prompt(
            {"type": "prop", "name": "青花瓷瓶", "description": "清代瓷器", "visual_notes": "釉面"}
        )
        assert "浅灰" in prompt

    def test_custom_template(self):
        prompt = render_asset_prompt(
            {"type": "prop", "name": "N", "description": "D", "visual_notes": "V"}, template="自定义 {name} {type}"
        )
        assert prompt == "自定义 N prop"


class TestRunAssetSheets:
    _PAYLOAD = '{"assets": [{"type": "character", "name": "甲", "description": "d", "visual_notes": "v", "search_query": "q1"}, {"type": "prop", "name": "乙", "description": "d", "visual_notes": "v", "search_query": "q2"}]}'

    def _component(
        self,
        monkeypatch,
        *,
        fail_search=False,
        fail_gen_for=None,
        fail_all=False,
        fail_send_for=None,
        search_key="k",
        payload=None,
    ):
        async def fake_search(query, api_key, *, limit=3, client=None):
            if fail_search:
                msg = "network down"
                raise RuntimeError(msg)
            return [{"url": f"https://img/{query}.jpg", "width": 10, "height": 10}]

        async def fake_download(results, *, max_images=3, client=None, dest_dir=None):
            return [{**r, "local_path": f"/tmp/{i}.jpg"} for i, r in enumerate(results)]

        async def fake_generate(
            prompt, *, model, base_url, api_key, aspect_ratio, resolution, reference_images=None, dest_dir=None
        ):
            if fail_all or (fail_gen_for and fail_gen_for in prompt):
                raise ValueError("boom")
            return {"path": f"/tmp/out_{abs(hash(prompt)) % 1000}.png", "width": 100, "height": 100, "model": model}

        monkeypatch.setattr(bas, "volc_image_search", fake_search)
        monkeypatch.setattr(bas, "download_search_images", fake_download)
        monkeypatch.setattr(bas, "generate_image", fake_generate)

        sent = []

        async def fake_send(message, id_=None, **kwargs):
            if fail_send_for and fail_send_for in message.text:
                msg = "push failed"
                raise RuntimeError(msg)
            sent.append(message)

        component = BatchAssetSheetComponent(
            assets_payload=payload or self._PAYLOAD,
            search_api_key=search_key,
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
    async def test_all_failed_sends_batch_failure_notice(self, monkeypatch):
        component, sent = self._component(monkeypatch, fail_all=True)
        results = await component.run_asset_sheets()
        assert all(r.data["status"] == "failed" for r in results)
        assert len(sent) == 1
        assert "批次失败" in sent[0].text
        assert "甲" in sent[0].text and "乙" in sent[0].text

    @pytest.mark.asyncio
    async def test_search_failure_falls_back_to_t2i(self, monkeypatch):
        component, _sent = self._component(monkeypatch, fail_search=True)
        results = await component.run_asset_sheets()
        assert all(r.data["status"] == "ok" for r in results)
        assert all(r.data["reference_count"] == 0 for r in results)
        # 降级不静默 — 失败原因写入组件日志
        assert any("回退纯文生图" in log.message for log in component._logs)

    @pytest.mark.asyncio
    async def test_missing_search_key_with_search_query_raises_chinese(self, monkeypatch):
        component, _sent = self._component(monkeypatch, search_key="")
        with pytest.raises(ValueError, match="未配置豆包搜索"):
            await component.run_asset_sheets()

    @pytest.mark.asyncio
    async def test_missing_search_key_ok_without_search_query(self, monkeypatch):
        payload = '{"assets": [{"type": "character", "name": "甲", "description": "d", "visual_notes": "v", "search_query": ""}]}'
        component, sent = self._component(monkeypatch, search_key="", payload=payload)
        results = await component.run_asset_sheets()
        assert all(r.data["status"] == "ok" for r in results)
        assert len(sent) == 1

    @pytest.mark.asyncio
    async def test_send_failure_marks_asset_failed(self, monkeypatch):
        component, sent = self._component(monkeypatch, fail_send_for="乙")
        results = await component.run_asset_sheets()
        statuses = {r.data["name"]: r.data["status"] for r in results}
        assert statuses == {"甲": "ok", "乙": "failed"}  # 推送失败不置 ok
        assert "push failed" in results[1].data["error"]
        assert len(sent) == 1

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

        assets = [
            {"type": "prop", "name": f"p{i}", "description": "d", "visual_notes": "v", "search_query": "q"}
            for i in range(6)
        ]
        component = BatchAssetSheetComponent(
            assets_payload=str(assets).replace("'", '"'), search_api_key="k", api_key="k", concurrency=2
        )
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
