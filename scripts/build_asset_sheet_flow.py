# ruff: noqa: D415, RUF001, RUF002, RUF003 — 中文全角标点是本文件的产品内容（prompt / 示例剧本 / 面向用户的提示）
"""生成 examples/asset-sheet/asset-sheet.flow.json 预置 flow。

节点 template 用 build_custom_component_template 从组件类真实生成（与组件定义
永远同步），edge handle 用 escape_json_dump 编码。运行：

    uv run python scripts/build_asset_sheet_flow.py

在仓库根目录直接 ``uv run`` 即可：lfx 属于本 uv 工作区成员，无需 sys.path 处理。

产物字节稳定：节点 id 的随机后缀取自固定种子 ``random.Random(42)``，重复运行
diff 为空。生成后内置 self-check（见 ``self_check``）对写出的文件做结构校验。
"""

from __future__ import annotations

import inspect
import json
import random
import string
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from lfx.base.prompts.api_utils import process_prompt_template
from lfx.components.input_output.text import TextInputComponent
from lfx.components.models_and_agents.language_model import LanguageModelComponent
from lfx.components.models_and_agents.prompt import PromptComponent
from lfx.components.tools.batch_asset_sheet import BatchAssetSheetComponent
from lfx.custom.custom_component.component import Component
from lfx.custom.utils import build_custom_component_template
from lfx.utils.util import escape_json_dump

if TYPE_CHECKING:
    from collections.abc import Callable

EXPECTED_NODES = 4
EXPECTED_EDGES = 3

SCRIPT_PROMPT = """你是影视资产盘点编辑。阅读剧本，盘点需要生成设定图的生产资产，只输出 JSON。

规则：
- 只拆三类：character（角色）/ scene（场景）/ prop（道具）
- 只拆有画面感、需要专门设计图的实体；对白提及但不入画的不要
- 名称用剧本原名；description 写外形与身份要点（服饰年代、材质、体态、年龄感）
- visual_notes 写视觉要点（色彩、材质、光线、氛围）
- search_query 是可公开搜索的名词短语（如「清代商人长袍」），不要用角色名
- 按出场重要性排序，最多 10 条
- 只输出 JSON，不要任何其他文字：
{{"assets":[{{"type":"character","name":"...","description":"...","visual_notes":"...","search_query":"..."}}]}}

剧本：
{script}"""

SAMPLE_SCRIPT = """夜。老当铺内，油灯昏黄。
掌柜陈九爷（六十岁，皂色长褂，胸前挂一枚黄铜算盘）缓缓合上樟木账本。
伙计小顺（十六岁，粗布短打）抱着一摞青花瓷碗穿过天井。
天井里停着一辆蒙尘的黄包车，车灯还亮着。
陈九爷：（低声）把那把桃木算盘收进暗格。
小顺掀开柜台下的红绒布，露出一把包浆温润的桃木算盘。"""

FLOW_ID = "a5e7c1d2-0000-4000-8000-0000000a5501"

# 固定种子：产物字节稳定，重复生成 diff 友好
_RNG = random.Random(42)  # noqa: S311 — 固定种子只为产物字节稳定，非加密用途


def _suffix() -> str:
    return "".join(_RNG.choices(string.ascii_letters + string.digits, k=5))


def _frontend_node(cls: type[Component]) -> dict[str, Any]:
    """用 build_custom_component_template 从源码真实生成前端节点模板。

    取整模块源码（与 Component.set_class_code 的 inspect.getsource(module)
    一致）：只取 class 体 exec 会因缺少 import 报 NameError（如 TextInputComponent
    的基类 TextComponent 不在作用域内）。
    """
    source = inspect.getsource(inspect.getmodule(cls))
    frontend_node, _config = build_custom_component_template(Component(_code=source))
    return frontend_node


def _patch_values(frontend_node: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    template = frontend_node["template"]
    for field_name, value in values.items():
        if field_name not in template:
            msg = f"{frontend_node.get('display_name')!r} 模板缺少字段 {field_name!r}"
            raise KeyError(msg)
        template[field_name]["value"] = value
    return frontend_node


def _process_prompt_variables(frontend_node: dict[str, Any], prompt: str) -> dict[str, Any]:
    """把 {script} 变量铸成动态输入字段，与 PromptComponent._update_template 同路。"""
    frontend_node["template"]["template"]["value"] = prompt
    process_prompt_template(
        template=prompt,
        name="template",
        custom_fields=frontend_node["custom_fields"],
        frontend_node_template=frontend_node["template"],
        is_mustache=False,
    )
    return frontend_node


def _node(
    cls: type[Component], x: int, y: int, *, patch: Callable[[dict[str, Any]], dict[str, Any]] | None = None
) -> dict[str, Any]:
    frontend_node = _frontend_node(cls)
    if patch:
        frontend_node = patch(frontend_node)
    node_id = f"{cls.__name__}-{_suffix()}"
    return {
        "id": node_id,
        "type": "genericNode",
        "position": {"x": x, "y": y},
        "selected": False,
        "data": {
            "id": node_id,
            "type": cls.__name__,
            "node": frontend_node,
            "showNode": True,
        },
    }


def _output_handle(node: dict[str, Any], field: str) -> str:
    """从节点 outputs 里取真实 output_types，构造 œ 编码的 source handle。"""
    outputs = node["data"]["node"]["outputs"]
    types = next((o["types"] for o in outputs if o["name"] == field), None)
    if types is None:
        msg = f"节点 {node['id']} 没有输出字段 {field!r}（现有：{[o['name'] for o in outputs]}）"
        raise KeyError(msg)
    return escape_json_dump({"dataType": node["data"]["type"], "id": node["id"], "name": field, "output_types": types})


def _input_handle(node: dict[str, Any], field: str) -> str:
    """从节点 template 字段取真实 input_types / type，构造 œ 编码的 target handle。"""
    spec = node["data"]["node"]["template"][field]
    return escape_json_dump(
        {
            "fieldName": field,
            "id": node["id"],
            "inputTypes": spec.get("input_types") or [],
            "type": spec.get("type") or "str",
        }
    )


def _edge(source: dict[str, Any], source_field: str, target: dict[str, Any], target_field: str) -> dict[str, Any]:
    source_handle = _output_handle(source, source_field)
    target_handle = _input_handle(target, target_field)
    return {
        "animated": False,
        "className": "",
        "data": {
            "sourceHandle": json.loads(source_handle.replace("œ", '"')),
            "targetHandle": json.loads(target_handle.replace("œ", '"')),
        },
        "id": f"reactflow__edge-{source['id']}{source_handle}-{target['id']}{target_handle}",
        "source": source["id"],
        "sourceHandle": source_handle,
        "target": target["id"],
        "targetHandle": target_handle,
        "selected": False,
    }


def build_flow() -> dict[str, Any]:
    script_input = _node(TextInputComponent, 0, 300, patch=lambda fn: _patch_values(fn, {"input_value": SAMPLE_SCRIPT}))
    prompt = _node(PromptComponent, 400, 300, patch=lambda fn: _process_prompt_variables(fn, SCRIPT_PROMPT))
    # model 留空：导入后在 UI 的模型选择器里选已配置的提供商（README 步骤 5）
    llm = _node(
        LanguageModelComponent,
        800,
        300,
        patch=lambda fn: _patch_values(fn, {"model_name": "", "system_message": "", "input_value": ""}),
    )
    batch = _node(
        BatchAssetSheetComponent,
        1200,
        300,
        patch=lambda fn: _patch_values(
            fn, {"assets_payload": "", "search_api_key": "", "api_key": "", "model_name": "gpt-image-2-03"}
        ),
    )

    nodes = [script_input, prompt, llm, batch]
    # 字段名以 build_custom_component_template 的真实产物为准：
    # TextInput 输出 text；{script} 变量铸成 Prompt 的动态输入 script；
    # Language Model 的 Message 输出叫 text_output（另一个是 model_output）
    edges = [
        _edge(script_input, "text", prompt, "script"),
        _edge(prompt, "prompt", llm, "system_message"),
        _edge(llm, "text_output", batch, "assets_payload"),
    ]

    return {
        "id": FLOW_ID,
        "name": "剧本 → 资产设定图",
        "description": "剧本拆解资产清单 → 豆包搜图参考 → 并发出设定图（每张完成实时推送）",
        "is_component": False,
        "data": {"nodes": nodes, "edges": edges, "viewport": {"x": 0, "y": 0, "zoom": 0.7}},
    }


def self_check(path: Path) -> list[str]:
    """程序化代替 UI 导入验证：对写出的文件做结构断言，返回通过项列表。"""
    failures: list[str] = []
    passed: list[str] = []

    def expect(*, ok: bool, label: str) -> None:
        (passed if ok else failures).append(label)

    flow = json.loads(path.read_text(encoding="utf-8"))
    nodes = flow["data"]["nodes"]
    edges = flow["data"]["edges"]
    node_by_id = {n["id"]: n for n in nodes}

    expect(
        ok=len(nodes) == EXPECTED_NODES and len(edges) == EXPECTED_EDGES,
        label=f"节点/连线数量：{len(nodes)} 节点 / {len(edges)} 连线",
    )

    # 4. 每个节点 template 含 _type 且非空
    expect(
        ok=all(n["data"]["node"]["template"].get("_type") for n in nodes),
        label="每个节点 template 含非空 _type",
    )

    for e in edges:
        # 2. edge 的 source/target 指向存在的节点 id
        expect(
            ok=e["source"] in node_by_id and e["target"] in node_by_id,
            label=f"edge 端点存在：{e['source']} → {e['target']}",
        )
        # 3. handle 字段名在对应节点 template 的字段集合里（解析 œ 编码回 JSON 校验）
        sh = json.loads(e["sourceHandle"].replace("œ", '"'))
        th = json.loads(e["targetHandle"].replace("œ", '"'))
        out_names = [o["name"] for o in node_by_id[e["source"]]["data"]["node"]["outputs"]]
        in_names = list(node_by_id[e["target"]]["data"]["node"]["template"])
        expect(ok=sh["name"] in out_names, label=f"sourceHandle 字段 {sh['name']!r} ∈ {e['source']} 输出 {out_names}")
        expect(ok=th["fieldName"] in in_names, label=f"targetHandle 字段 {th['fieldName']!r} ∈ {e['target']} 模板字段")

    # 连线拓扑：剧本输入 → Prompt → Language Model → 批量资产出图
    chain = [(e["source"], e["target"]) for e in edges]
    expect(
        ok=[node_by_id[s]["data"]["type"] for s, _ in chain]
        == ["TextInputComponent", "PromptComponent", "LanguageModelComponent"],
        label="连线拓扑：剧本输入 → Prompt → Language Model → 批量资产出图",
    )

    # Prompt 节点：{script} 已铸成动态输入字段且登记在 custom_fields
    prompt_node = next(n for n in nodes if n["data"]["type"] == "PromptComponent")
    expect(
        ok="script" in prompt_node["data"]["node"]["template"]
        and prompt_node["data"]["node"]["custom_fields"] == {"template": ["script"]},
        label="Prompt 的 {script} 变量已生成动态输入字段 script",
    )

    if failures:
        print("self-check 失败：", file=sys.stderr)
        for f in failures:
            print(f"  ✗ {f}", file=sys.stderr)
        msg = f"self-check 失败 {len(failures)} 项"
        raise SystemExit(msg)
    for p in passed:
        print(f"  ✓ {p}")
    return passed


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "examples" / "asset-sheet" / "asset-sheet.flow.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_flow(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"written: {out}")
    print("self-check:")
    self_check(out)


if __name__ == "__main__":
    main()
