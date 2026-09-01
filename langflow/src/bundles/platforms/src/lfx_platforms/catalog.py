"""平台静态模型目录（live 发现不可用时的兜底下拉项）。

只收 wingsight 实际在用的模型 id（与 agent/models.py TEXT_MODELS 对齐）；
端点可达时 conditional_live 会用实时目录整组替换，这里保证离线/断网时
下拉仍有正确选项。加平台/加模型：改 ``_PLATFORM_MODELS`` + extension.json
的 catalog_loader 已按名分发，无需改其他文件。
"""

from __future__ import annotations

from typing import Callable

from lfx.base.models.model_metadata import create_model_metadata

# 平台名 → 静态模型行（声明顺序即下拉顺序；模型 flag 只影响 Agent 组件
# 的 tool 过滤与排序，wingsight 的 LanguageModelComponent 不吃过滤）
_PLATFORM_MODELS: dict[str, list[dict[str, object]]] = {
    "BigModel": [
        {"name": "glm-5.3-flash", "tool_calling": True},
        {"name": "glm-5.3", "tool_calling": True, "reasoning": True},
    ],
    "DMX": [
        {"name": "gpt-5.6-luna", "tool_calling": True},
        {"name": "gemini-3.7-flash", "tool_calling": True},
        {"name": "claude-sonnet-5", "tool_calling": True},
    ],
    "DeepSeek": [
        {"name": "deepseek-v4-flash", "tool_calling": True},
        {"name": "deepseek-v4-pro", "tool_calling": True, "reasoning": True},
        {"name": "deepseek-v4-flash-vision-exp", "tool_calling": True},
    ],
}


def _make_catalog(provider: str) -> Callable[[], list[dict]]:
    """为平台生成 manifest catalog_loader 签名的目录函数（无参 → dict 行）。"""

    def catalog() -> list[dict]:
        return [
            create_model_metadata(
                provider=provider,
                icon=provider,
                **spec,
            )
            for spec in _PLATFORM_MODELS.get(provider, [])
        ]

    catalog.__name__ = f"catalog_{provider.lower()}"
    catalog.__qualname__ = catalog.__name__
    catalog.__doc__ = f"{provider} 平台静态模型目录（extension.json catalog_loader 入口）。"
    return catalog


catalog_bigmodel = _make_catalog("BigModel")
catalog_dmx = _make_catalog("DMX")
catalog_deepseek = _make_catalog("DeepSeek")
