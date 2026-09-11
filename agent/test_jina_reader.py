"""Jina Reader 双层客户端单测：本地 OSS → 官方 API 的层级顺序与错误分类。

运行：cd agent && uv run python test_jina_reader.py
不需要网络——monkeypatch jina_reader._request_markdown 与 httpx.AsyncClient，
只测层级决策（何时升官方层）与单层错误语义（4xx/拦截页/连接失败）。

背景（2026-09-11 抓取经常失败的根治）：本地 OSS 实例没在跑（colima 停了
容器跟着停）+ 生产服务器从未部署 docker，整条回退链等于裸直抓。改造后
本地判定不算终审——官方 API（key 触发）有无头浏览器集群与住宅代理，
本地过不去的反爬它常常能过。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

import jina_reader

PASS = [0]

_ENV_KEYS = ("JINA_READER_BASE_URL", "JINA_READER_API_KEY", "JINA_READER_API_BASE_URL")


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


class _Env:
    """临时改 env，退出恢复原值。"""

    def __init__(self, **overrides: str | None):
        self.overrides = overrides
        self.saved: dict[str, str | None] = {}

    def __enter__(self):
        for k in _ENV_KEYS:
            self.saved[k] = os.environ.get(k)
        for k, v in self.overrides.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class _Recorder:
    """按 endpoint 前缀分派假结果，记录每次调用的 (endpoint, headers)。"""

    def __init__(self, script: dict[str, Any]):
        self.script = script
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def __call__(self, endpoint: str, headers: dict[str, str], tier: str):
        self.calls.append((endpoint, headers))
        for prefix, outcome in self.script.items():
            if endpoint.startswith(prefix):
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
        raise AssertionError(f"未脚本化的 endpoint：{endpoint}")


_REAL_REQUEST = jina_reader._request_markdown


def _install(monkey_scope: dict[str, Any]):
    rec = _Recorder(monkey_scope)
    jina_reader._request_markdown = rec  # type: ignore[assignment]
    return rec


async def main() -> None:
    # ---- A. 层级顺序 ----
    # A1 本地成功：只调本地层，不带 Authorization
    with _Env(JINA_READER_API_KEY="sk-test"):
        rec = _install({"http://127.0.0.1:3000/": "本地正文" * 30})
        out = await jina_reader.fetch_markdown("https://example.com/a")
        expect(out.startswith("本地正文"), "A1 返回本地层结果")
        expect(len(rec.calls) == 1, f"A1 只调一层（实际 {len(rec.calls)}）")
        expect("Authorization" not in rec.calls[0][1], "A1 本地层不带 Bearer")
        expect(rec.calls[0][1].get("X-Retain-Images") is None, "A1 本地层不丢图")

    # A2 本地连接失败（实例没在跑）+ 有 key → 升官方层成功
    with _Env(JINA_READER_API_KEY="sk-test"):
        rec = _install({
            "http://127.0.0.1:3000/": jina_reader.WebSourceUnreachableError("Jina 本地实例不可达"),
            "https://r.jina.ai/": "官方正文" * 30,
        })
        out = await jina_reader.fetch_markdown("https://example.com/a")
        expect(out.startswith("官方正文"), "A2 官方层结果透出")
        expect(len(rec.calls) == 2, f"A2 两层各调一次（实际 {len(rec.calls)}）")
        api_headers = rec.calls[1][1]
        expect(api_headers.get("Authorization") == "Bearer sk-test", "A2 官方层带 Bearer")
        expect(api_headers.get("X-Retain-Images") == "none", "A2 官方层丢图省 token")
        expect(rec.calls[1][0].endswith("/https://example.com/a"), "A2 官方 endpoint 拼接正确")

    # A3 本地失败 + 无 key → 不升层，本地错误即终局
    with _Env(JINA_READER_API_KEY=None):
        rec = _install({
            "http://127.0.0.1:3000/": jina_reader.WebSourceContentError("疑似拦截页（命中「请先登录」）"),
        })
        try:
            await jina_reader.fetch_markdown("https://example.com/a")
            raise AssertionError("A3 应抛异常")
        except jina_reader.WebSourceContentError:
            PASS[0] += 1
        expect(len(rec.calls) == 1, f"A3 无 key 只调本地（实际 {len(rec.calls)}）")

    # A4 本地 4xx（目标真死）+ 有 key → 官方也试一次（本地判定不算终审）
    with _Env(JINA_READER_API_KEY="sk-test"):
        rec = _install({
            "http://127.0.0.1:3000/": jina_reader.WebSourceUnreachableError("Jina 4xx 404"),
            "https://r.jina.ai/": "官方正文" * 30,
        })
        out = await jina_reader.fetch_markdown("https://example.com/a")
        expect(out.startswith("官方正文"), "A4 官方层对本地 4xx 也有机会复核")

    # A5 双层皆败 → 官方层异常透出，本地错误挂在因果链上
    with _Env(JINA_READER_API_KEY="sk-test"):
        local_err = jina_reader.WebSourceUnreachableError("Jina 本地实例不可达")
        _install({
            "http://127.0.0.1:3000/": local_err,
            "https://r.jina.ai/": jina_reader.WebSourceUnreachableError("Jina 4xx 403"),
        })
        try:
            await jina_reader.fetch_markdown("https://example.com/a")
            raise AssertionError("A5 应抛异常")
        except jina_reader.WebSourceUnreachableError as exc:
            expect("403" in str(exc), "A5 抛的是官方层终审错误")
            expect(exc.__cause__ is local_err, "A5 本地错误在因果链上")

    # A6 官方层 base 可覆盖
    with _Env(JINA_READER_API_KEY="sk-test", JINA_READER_API_BASE_URL="https://my-proxy.example"):
        rec = _install({
            "http://127.0.0.1:3000/": jina_reader.WebSourceUnreachableError("down"),
            "https://my-proxy.example/": "代理正文" * 30,
        })
        out = await jina_reader.fetch_markdown("https://example.com/a")
        expect(out.startswith("代理正文"), "A6 官方 base 覆盖生效")

    # A7 enabled()：本地 base 恒有默认值 → 恒 True；显式置空本地 + 有 key 仍 True
    with _Env(JINA_READER_API_KEY=None):
        expect(jina_reader.enabled(), "A7 默认 enabled")
    with _Env(JINA_READER_BASE_URL=" ", JINA_READER_API_KEY="sk-test"):
        expect(jina_reader.enabled(), "A7 仅 key 也 enabled")

    # ---- B. 单层 _request_markdown 错误语义（stub httpx.AsyncClient） ----
    jina_reader._request_markdown = _REAL_REQUEST  # type: ignore[assignment]
    class _Resp:
        def __init__(self, status: int, text: str = ""):
            self.status_code = status
            self.text = text

        def raise_for_status(self):
            if self.status_code >= 500:
                raise httpx.HTTPStatusError("server", request=None, response=None)

    class _Client:
        responses: list[_Resp] = []

        def __init__(self, *args: Any, **kwargs: Any):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any):
            return False

        async def get(self, url: str, headers: dict[str, str] | None = None):
            return _Client.responses.pop(0)

    real_client = httpx.AsyncClient

    async def _run_single(status: int, text: str = "") -> str:
        _Client.responses = [_Resp(status, text)]
        httpx.AsyncClient = _Client  # type: ignore[assignment]
        try:
            return await jina_reader._request_markdown("http://x/y", {}, "测试层")
        finally:
            httpx.AsyncClient = real_client

    # B1 4xx → 永久不可达（不重试）
    try:
        await _run_single(403)
        raise AssertionError("B1 应抛异常")
    except jina_reader.WebSourceUnreachableError:
        PASS[0] += 1

    # B2 5xx → 重试一次后抛 httpx.HTTPStatusError
    try:
        _Client.responses = [_Resp(500), _Resp(500)]
        httpx.AsyncClient = _Client  # type: ignore[assignment]
        try:
            await jina_reader._request_markdown("http://x/y", {}, "测试层")
        finally:
            httpx.AsyncClient = real_client
        raise AssertionError("B2 应抛异常")
    except httpx.HTTPStatusError:
        PASS[0] += 1

    # B3 拦截页文案 → 内容错误
    try:
        await _run_single(200, "请完成验证" + "x" * 100)
        raise AssertionError("B3 应抛异常")
    except jina_reader.WebSourceContentError as exc:
        expect("验证" in str(exc), "B3 拦截页归因")

    # B4 正常正文 → 剥 Reader 头后返回
    body = "Markdown Content:\n" + "正文内容" * 40
    out = await _run_single(200, "Title: t\nURL Source: u\n" + body)
    expect(out.startswith("正文内容"), "B4 Reader 头剥除")

    print(f"jina_reader 单测：{PASS[0]} 项全过")


if __name__ == "__main__":
    asyncio.run(main())
