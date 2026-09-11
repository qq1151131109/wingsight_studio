"""抓取链单测：Jina 两层原语 + fetch_page_text 四通道编排顺序。

运行：cd agent && uv run python test_jina_reader.py
不需要网络——stub jina_reader 两层原语、httpx.AsyncClient 与 TikHub 专项，
只测链路决策（谁先谁后、谁失败才降层）与单层错误语义。

链路（2026-09-11 用户拍板 Jina 优先）：
知乎专栏 → TikHub；其余 → 本地 Jina（主路径）→ 直抓（回退）→ 官方 API
（收尾烧 token）。配套考据文路 4 路并发（_PAGE_FETCH_CONCURRENCY）。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

import jina_reader
import research

PASS = [0]

_ENV_KEYS = (
    "JINA_READER_BASE_URL",
    "JINA_READER_API_KEY",
    "JINA_READER_API_BASE_URL",
    "TIKHUB_API_KEY",
)


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


# ---------- C 组素材：链路各层可计数的假件 ----------

_DIRECT_HTML = "<html><body>" + "直抓正文" * 40 + "</body></html>"


class _Chain:
    """打桩 fetch_page_text 的四层依赖并计数。"""

    def __init__(self):
        self.counts = {"tikhub": 0, "jina_local": 0, "direct": 0, "jina_api": 0}
        self.results = {
            "tikhub": "TikHub 正文" * 30,
            "jina_local": "本地 Jina 正文" * 30,
            "direct": _DIRECT_HTML,
            "jina_api": "官方 API 正文" * 30,
        }
        self.fail: set[str] = set()

    def __enter__(self):
        self._saved = (
            research._tikhub_zhihu_article,
            jina_reader.fetch_local,
            jina_reader.fetch_api,
            jina_reader.enabled,
            jina_reader.api_enabled,
            httpx.AsyncClient,
        )
        chain = self

        async def _tikhub(article_id: str) -> str:
            chain.counts["tikhub"] += 1
            if "tikhub" in chain.fail:
                raise RuntimeError("tikhub 挂")
            return chain.results["tikhub"]

        async def _local(url: str) -> str:
            chain.counts["jina_local"] += 1
            if "jina_local" in chain.fail:
                raise jina_reader.WebSourceUnreachableError("Jina 本地实例不可达")
            return chain.results["jina_local"]

        async def _api(url: str) -> str:
            chain.counts["jina_api"] += 1
            if "jina_api" in chain.fail:
                raise jina_reader.WebSourceContentError("疑似拦截页（命中「请先登录」）")
            return chain.results["jina_api"]

        research._tikhub_zhihu_article = _tikhub  # type: ignore[assignment]
        jina_reader.fetch_local = _local  # type: ignore[assignment]
        jina_reader.fetch_api = _api  # type: ignore[assignment]
        jina_reader.enabled = lambda: True  # type: ignore[assignment]
        jina_reader.api_enabled = lambda: "jina_api" not in chain.disabled_api  # type: ignore[assignment]
        self.disabled_api: set[str] = set()

        class _Resp:
            status_code = 200
            text = chain.results["direct"]
            content = chain.results["direct"].encode()
            headers = {"content-type": "text/html"}

            def raise_for_status(self):
                pass

        class _FailResp(_Resp):
            status_code = 403

            def raise_for_status(self):
                raise httpx.HTTPStatusError("403", request=None, response=None)

        class _Client:
            def __init__(self, *a: Any, **k: Any):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc: Any):
                return False

            async def get(self, url: str, headers: dict[str, str] | None = None):
                chain.counts["direct"] += 1
                return _FailResp() if "direct" in chain.fail else _Resp()

        httpx.AsyncClient = _Client  # type: ignore[assignment]
        return self

    def __exit__(self, *exc):
        (
            research._tikhub_zhihu_article,
            jina_reader.fetch_local,
            jina_reader.fetch_api,
            jina_reader.enabled,
            jina_reader.api_enabled,
            httpx.AsyncClient,
        ) = self._saved


async def main() -> None:
    # ---- C 组：fetch_page_text 四通道编排 ----
    # C1 知乎专栏 + TikHub key：专项通道最前，后面三层全不碰
    with _Env(TIKHUB_API_KEY="tk-1"), _Chain() as c:
        out = await research.fetch_page_text("https://zhuanlan.zhihu.com/p/abc123")
        expect(out.startswith("TikHub"), "C1 TikHub 命中")
        expect(c.counts == {"tikhub": 1, "jina_local": 0, "direct": 0, "jina_api": 0},
               f"C1 只调 TikHub（{c.counts}）")

    # C2 知乎 + TikHub 挂 → 降本地 Jina
    with _Env(TIKHUB_API_KEY="tk-1"), _Chain() as c:
        c.fail.add("tikhub")
        out = await research.fetch_page_text("https://zhuanlan.zhihu.com/p/abc123")
        expect(out.startswith("本地 Jina"), "C2 TikHub 失败降本地 Jina")
        expect(c.counts["direct"] == 0 and c.counts["jina_api"] == 0, "C2 不再往下走")

    # C3 知乎但没配 TikHub key → 直接走本地 Jina（别空转专项）
    with _Env(TIKHUB_API_KEY=None), _Chain() as c:
        out = await research.fetch_page_text("https://zhuanlan.zhihu.com/p/abc123")
        expect(out.startswith("本地 Jina"), "C3 无 TikHub key 走本地 Jina")
        expect(c.counts["tikhub"] == 0, "C3 TikHub 未被调用")

    # C4 普通页：本地 Jina 主路径直出，直抓/官方 API 全不碰
    with _Env(TIKHUB_API_KEY="tk-1"), _Chain() as c:
        out = await research.fetch_page_text("https://example.com/a")
        expect(out.startswith("本地 Jina"), "C4 本地 Jina 主路径")
        expect(c.counts == {"tikhub": 0, "jina_local": 1, "direct": 0, "jina_api": 0},
               f"C4 只调本地 Jina（{c.counts}）")

    # C5 本地 Jina 挂 → 直抓秒级顶上，官方 API 不烧
    with _Chain() as c:
        c.fail.add("jina_local")
        out = await research.fetch_page_text("https://example.com/a")
        expect(out.startswith("直抓正文"), "C5 直抓回退命中")
        expect(c.counts["jina_api"] == 0, "C5 官方 API 未烧 token")

    # C6 本地 Jina 挂 + 直抓挂 + key 在 → 官方 API 收尾
    with _Chain() as c:
        c.fail.update({"jina_local", "direct"})
        out = await research.fetch_page_text("https://example.com/a")
        expect(out.startswith("官方 API"), "C6 官方 API 收尾")
        expect(c.counts == {"tikhub": 0, "jina_local": 1, "direct": 1, "jina_api": 1},
               f"C6 逐层降级（{c.counts}）")

    # C7 全挂 + key 在：异常带直抓与官方两层原因
    with _Chain() as c:
        c.fail.update({"jina_local", "direct", "jina_api"})
        try:
            await research.fetch_page_text("https://example.com/a")
            raise AssertionError("C7 应抛异常")
        except ValueError as exc:
            msg = str(exc)
            expect("直抓失败" in msg and "官方回退失败" in msg, f"C7 双层归因（{msg}）")

    # C8 全挂 + 没配 key：只剩直抓结论（与无 key 老行为一致）
    with _Chain() as c:
        c.fail.update({"jina_local", "direct"})
        c.disabled_api.add("jina_api")
        try:
            await research.fetch_page_text("https://example.com/a")
            raise AssertionError("C8 应抛异常")
        except ValueError as exc:
            expect(str(exc).startswith("直抓失败") and "官方" not in str(exc), "C8 无 key 不提官方层")
            expect(c.counts["jina_api"] == 0, "C8 官方层未调用")

    # ---- A 组：两层原语 ----
    jina_reader._request_markdown = _REAL_REQUEST  # type: ignore[assignment]

    # A1 fetch_local：打本地 base，只带 Accept
    with _Env(JINA_READER_API_KEY="sk-test"):
        rec = _install({"http://127.0.0.1:3000/": "本地正文" * 30})
        out = await jina_reader.fetch_local("https://example.com/a")
        expect(out.startswith("本地正文"), "A1 本地层结果")
        expect(len(rec.calls) == 1 and rec.calls[0][0] == "http://127.0.0.1:3000/https://example.com/a",
               "A1 endpoint 拼接")
        expect(set(rec.calls[0][1]) == {"Accept"}, "A1 本地层不带 Bearer/丢图头")

    # A2 fetch_api 无 key → 防呆明报（不悄悄成功也不悄悄网络请求）
    with _Env(JINA_READER_API_KEY=None):
        rec = _install({})
        try:
            await jina_reader.fetch_api("https://example.com/a")
            raise AssertionError("A2 应抛异常")
        except jina_reader.WebSourceUnreachableError:
            PASS[0] += 1
        expect(rec.calls == [], "A2 无 key 不发请求")

    # A3 fetch_api 有 key：Bearer + X-Retain-Images，默认官方 base
    with _Env(JINA_READER_API_KEY="sk-test"):
        rec = _install({"https://r.jina.ai/": "官方正文" * 30})
        out = await jina_reader.fetch_api("https://example.com/a")
        expect(out.startswith("官方正文"), "A3 官方层结果")
        h = rec.calls[0][1]
        expect(h.get("Authorization") == "Bearer sk-test", "A3 Bearer")
        expect(h.get("X-Retain-Images") == "none", "A3 丢图省 token")

    # A4 官方 base 可覆盖 + api_enabled 开关
    with _Env(JINA_READER_API_KEY="sk-test", JINA_READER_API_BASE_URL="https://my-proxy.example"):
        rec = _install({"https://my-proxy.example/": "代理正文" * 30})
        out = await jina_reader.fetch_api("https://example.com/a")
        expect(out.startswith("代理正文"), "A4 base 覆盖生效")
    with _Env(JINA_READER_API_KEY=None):
        expect(not jina_reader.api_enabled(), "A4 api_enabled 关")
    with _Env(JINA_READER_API_KEY="sk-test"):
        expect(jina_reader.api_enabled(), "A4 api_enabled 开")

    # A5 enabled()：本地 base 恒有默认值 → 恒 True
    with _Env(JINA_READER_API_KEY=None):
        expect(jina_reader.enabled(), "A5 默认 enabled")

    # ---- B 组：单层 _request_markdown 错误语义（stub httpx.AsyncClient） ----
    jina_reader._request_markdown = _REAL_REQUEST  # type: ignore[assignment]

    class _RespB:
        def __init__(self, status: int, text: str = ""):
            self.status_code = status
            self.text = text

        def raise_for_status(self):
            if self.status_code >= 500:
                raise httpx.HTTPStatusError("server", request=None, response=None)

    class _ClientB:
        responses: list[_RespB] = []

        def __init__(self, *args: Any, **kwargs: Any):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any):
            return False

        async def get(self, url: str, headers: dict[str, str] | None = None):
            return _ClientB.responses.pop(0)

    real_client = httpx.AsyncClient

    async def _run_single(status: int, text: str = "") -> str:
        _ClientB.responses = [_RespB(status, text)]
        httpx.AsyncClient = _ClientB  # type: ignore[assignment]
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
        _ClientB.responses = [_RespB(500), _RespB(500)]
        httpx.AsyncClient = _ClientB  # type: ignore[assignment]
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

    print(f"抓取链单测：{PASS[0]} 项全过")


if __name__ == "__main__":
    asyncio.run(main())
