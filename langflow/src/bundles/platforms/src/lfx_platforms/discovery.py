"""平台 live 模型发现与凭据校验（OpenAI 兼容 /models 端点通用实现）。

每个平台的可调用都由 extension.json 以点路径引用、lfx provider registry
惰性 import——import 本模块零开销。变量键按平台名派生（BigModel →
BIGMODEL_BASE_URL/BIGMODEL_API_KEY），加平台时在 ``_VARIABLE_PREFIXES``
补一行即可复用同一份实现。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

import httpx
from lfx.base.models.model_metadata import create_model_metadata
from lfx.base.models.model_utils import MIN_DEFAULT_MODELS, get_provider_variable_value
from lfx.log.logger import logger
from lfx.utils.ssrf_httpx import ssrf_safe_httpx_get

if TYPE_CHECKING:
    from uuid import UUID

_TIMEOUT_SECONDS = 5

# 平台名 → 变量键前缀（<PREFIX>_BASE_URL / <PREFIX>_API_KEY）。
# 与 extension.json providers[].name 一一对应。
_VARIABLE_PREFIXES: dict[str, str] = {
    "BigModel": "BIGMODEL",
    "DMX": "DMX",
    "DeepSeek": "DEEPSEEK",
}

# 平台名 → live 模型行的图标（与 metadata.icon 一致）。
_ICONS: dict[str, str] = {
    "BigModel": "BigModel",
    "DMX": "DMX",
    "DeepSeek": "DeepSeek",
}


def _candidate_models_urls(base_url: str) -> list[str]:
    """返回候选 /models 地址：标准 OpenAI 兼容 base 多以 /v1 结尾（DMX），
    官方网关型 base 不带（智谱 coding /v4、DeepSeek 官方域）——两种都试。"""
    base_url = base_url.rstrip("/")
    candidates = [f"{base_url}/models"]
    if not base_url.endswith("/v1"):
        candidates.append(f"{base_url}/v1/models")
    return candidates


def _probe_models(base_url: str, headers: dict[str, str]) -> httpx.Response:
    """依候选 URL 探测 /models，返回首个非 404 响应（全 404 返回最后一个）。"""
    last: httpx.Response | None = None
    for url in _candidate_models_urls(base_url):
        response = ssrf_safe_httpx_get(url, headers=headers, timeout=_TIMEOUT_SECONDS, follow_redirects=False)
        if response.status_code != 404:
            return response
        last = response
    assert last is not None
    return last


def _parse_model_names(data: object) -> list[str]:
    """解析 OpenAI 兼容 {"data": [...]} 或裸数组的模型 id 列表。"""
    if isinstance(data, list):
        return sorted(str(m) for m in data if m)
    if isinstance(data, dict) and "data" in data:
        return sorted(m.get("id", "") for m in data["data"] if m.get("id"))
    return []


def _fetch_live_models(provider: str, user_id: UUID | str | None, model_type: str = "llm") -> list[dict]:
    """拉平台 /models 实时目录；端点未配置或不可达回空列表（不抛错，
    conditional_live 语义下静态目录兜底）。"""
    prefix = _VARIABLE_PREFIXES.get(provider)
    if not prefix:
        return []
    base_url = get_provider_variable_value(user_id, f"{prefix}_BASE_URL")
    if not base_url:
        return []
    try:
        api_key = get_provider_variable_value(user_id, f"{prefix}_API_KEY")
    except Exception:  # noqa: BLE001 - 凭据解密失败不让发现跟着挂
        api_key = None

    try:
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        response = _probe_models(base_url, headers)
        response.raise_for_status()
        model_names = _parse_model_names(response.json())
        return [
            create_model_metadata(
                provider=provider,
                name=name,
                icon=_ICONS.get(provider, "Bot"),
                model_type=model_type,
                tool_calling=model_type == "llm",
                default=i < MIN_DEFAULT_MODELS,
            )
            for i, name in enumerate(model_names)
        ]
    except Exception:  # noqa: BLE001 - 传输/解析失败降级为「无实时模型」
        logger.debug(f"Could not fetch live {provider} models from {base_url}")
        return []


def validate_platform_credentials(
    provider: str,
    variables: dict[str, str],
    model_name: str | None = None,  # noqa: ARG001 - registry validator 契约保留参
) -> None:
    """凭据校验：探测 {base}/models，401/403 判密钥错、连接类错误点名 URL。

    变量键按 provider 名派生，全部平台共用这一个点路径。
    """
    prefix = _VARIABLE_PREFIXES.get(provider)
    if not prefix:
        msg = f"Unknown platform provider: {provider}"
        raise ValueError(msg)
    base_url = variables.get(f"{prefix}_BASE_URL")
    if not base_url:
        msg = f"{provider} 的 Base URL 未配置（{prefix}_BASE_URL）"
        raise ValueError(msg)

    headers: dict[str, str] = {}
    api_key = variables.get(f"{prefix}_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        response = _probe_models(base_url, headers)
        if response.status_code in (401, 403):
            msg = f"{provider} 鉴权失败，请检查 {prefix}_API_KEY。"
            logger.error(msg)
            raise ValueError(msg)
        response.raise_for_status()
    except httpx.ConnectError as e:
        msg = f"连不上 {provider} 端点 {base_url.rstrip('/')}，请检查网络与 BASE_URL。"
        logger.error(msg)
        raise ValueError(msg) from e
    except httpx.TimeoutException as e:
        msg = f"{provider} 端点 {base_url.rstrip('/')} 连接超时。"
        logger.error(msg)
        raise ValueError(msg) from e
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else "unknown"
        msg = f"{provider} 端点 /models 返回 HTTP {status}，请确认 BASE_URL 指向 OpenAI 兼容 API。"
        logger.error(msg)
        raise ValueError(msg) from e
    except httpx.RequestError as e:
        msg = f"校验 {provider} 凭据失败：{e}"
        logger.error(msg)
        raise ValueError(msg) from e


def _make_fetch(provider: str) -> Callable[[UUID | str | None, str], list[dict]]:
    """为平台生成 manifest live_discovery 签名的发现函数 (user_id, model_type)。"""

    def fetch(user_id: UUID | str | None, model_type: str = "llm") -> list[dict]:
        return _fetch_live_models(provider, user_id, model_type)

    fetch.__name__ = f"fetch_live_{provider.lower()}"
    fetch.__qualname__ = fetch.__name__
    fetch.__doc__ = f"拉取 {provider} 平台的实时模型目录（extension.json live_discovery 入口）。"
    return fetch


fetch_live_bigmodel = _make_fetch("BigModel")
fetch_live_dmx = _make_fetch("DMX")
fetch_live_deepseek = _make_fetch("DeepSeek")
