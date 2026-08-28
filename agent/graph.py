"""Wingsight 画布助手 — LangGraph 主 Agent。

架构（参考 CopilotKit 官方 canvas 示例的 coagent 模式）：
- 前端工具（canvas_ops）经 RunAgentInput 注入，从 state["tools"] / state["copilotkit"].actions
  读取并 bind 到模型；模型发起调用后本轮结束（Command(goto=END)），由浏览器执行并把
  ToolMessage 带回下一轮。
- 后端工具（run_langflow_skill / list_langflow_skills）在 ToolNode 里执行。
- 画布 ground truth 走共享状态 canvasSummary（前端 useCoAgent setState 同步）。
"""

import json
import os
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langchain.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from langgraph.prebuilt import ToolNode
from copilotkit import CopilotKitState

import camera
import skills

# ---------- 状态 ----------


class AgentState(CopilotKitState):
    """共享状态：canvasSummary 是画布摘要（前端 useCoAgent 写入）。"""

    canvasSummary: str = ""
    tools: List[Any] = []


# ---------- 后端工具 ----------


@tool
async def list_langflow_skills() -> str:
    """列出当前可用的 Langflow 技能（预置的生成管线，如宣发文案）。"""
    return skills.describe_skills()


@tool
async def decompose_script(script: str) -> str:
    """把剧本拆解为资产清单（角色/场景/道具，含外形与视觉要点）。

    用户给出剧本（完整或片段）并想要资产卡/设定图时，先用这个工具拆解，
    再用 canvas_ops 把拆出的资产建成画布卡片，等用户确认增删。

    Args:
        script: 剧本原文（尽量完整传入，不要自行摘要）。
    """
    return await skills.decompose_script(script)


@tool
async def run_langflow_skill(
    skill: str, input_text: str, params_json: str = ""
) -> str:
    """调用一个 Langflow 技能（预置生成管线）并返回其文本结果。

    Args:
        skill: 技能名（先用 list_langflow_skills 查可用技能与参数）。
        input_text: 传给技能的主输入（如剧本片段、补充说明）。
        params_json: 技能参数，JSON 对象字符串，如 {"platform":"抖音","count":6}；
            只能使用技能清单里声明的参数，不需要时留空。
    """
    params = None
    if params_json and params_json.strip():
        try:
            params = json.loads(params_json)
            if not isinstance(params, dict):
                return "params_json 必须是 JSON 对象字符串"
        except json.JSONDecodeError as e:
            return f"params_json 不是合法 JSON：{e}"
    return await skills.run_skill(skill, input_text, params)


@tool
async def generate_asset_images(assets_json: str) -> str:
    """为资产批量生成设定图（豆包搜参考图 + AI 出图，并发执行）。

    用户确认资产清单后要求出图时调用。输入是资产数组 JSON，每个元素：
    {"type":"character|scene|prop","name":"...","description":"...","visual_notes":"...","search_query":"可公开搜索的参考词"}
    （字段与 decompose_script 的输出一致）。返回每个资产的成败与 image_url。

    Args:
        assets_json: 资产数组 JSON 文本。
    """
    try:
        assets = json.loads(assets_json)
        if not isinstance(assets, list):
            return "assets_json 必须是资产数组 JSON"
    except json.JSONDecodeError as e:
        return f"assets_json 不是合法 JSON：{e}"
    return await skills.generate_asset_images(assets)


backend_tools = [list_langflow_skills, decompose_script, generate_asset_images, run_langflow_skill]
backend_tool_names = {t.name for t in backend_tools}

# 允许模型调用的前端工具白名单（防止客户端注入无关工具）
FRONTEND_TOOL_ALLOWLIST = {"canvas_ops"}


# ---------- 系统提示 ----------

SYSTEM_PROMPT = """你是 Wingsight Studio 的画布助手，帮助创作者在无限画布上进行影视创作（剧本、角色、分镜、设定图）。

## 画布当前状态（ground truth，以此为准，忽略聊天历史里的旧状态）
{canvas_summary}

## 操作画布
调用前端工具 canvas_ops，参数 ops 是操作数组，一次可以批量执行多项：
- {{"op":"add_node","nodeType":"note|script|character|image","title":"标题","body":"正文","position":{{"x":0,"y":0}}}}  新建卡片（position 可省略，会自动布局）
- {{"op":"update_node","id":"节点id","title":"新标题","body":"新正文"}}  更新卡片
- {{"op":"delete_nodes","ids":["节点id",...]}}  删除卡片
- {{"op":"connect_nodes","fromId":"节点id","toId":"节点id"}}  连线（方向：from → to）
- {{"op":"set_viewport","x":0,"y":0,"zoom":1}}  移动画布视野

节点 id 形如 n_xxx_x，可以在「画布当前状态」里查到。新建后若要连线，先等工具结果返回新节点 id。

## 生成管线（Langflow 技能）
涉及批量生成（宣发文案等）时，先用 list_langflow_skills 查可用技能，再用 run_langflow_skill 调用。

## 剧本 → 资产工作流
用户给出剧本并想要资产/设定图时，按以下次序：
1. 先用 canvas_ops 建一张 script 卡：标题用片名（用户没提就叫「剧本」），body 放剧本原文全文（不要截断）
2. 调 decompose_script(剧本原文) 拆出资产清单
3. 用一次 canvas_ops 批量建资产卡，并把每张用 connect_nodes 连回剧本卡（fromId=剧本卡id）：
   角色→character 卡（name 做标题）；场景/道具→note 卡（标题带「场景：」「道具：」前缀）；description 与 visual_notes 写进 body
4. 汇报拆解结果并请用户确认增删。用户补充/删除角色时直接用 canvas_ops 改画布，不要重新拆解；
   需要回看剧本原文时用 read_node(剧本卡id)
5. 用户确认后要求出图时：调 generate_asset_images(资产数组 JSON，字段与拆解清单一致，从拆解结果或画布卡内容取)。
   注意每张约需 1 分钟，调用前先告知用户预计耗时。完成后用 canvas_ops 为每张成功的图建 image 卡
   （title=资产名，imageUrl 用返回的 image_url），并 connect_nodes 连到对应资产卡；失败的在汇报中说明可重试。
   出图前可为资产补充摄影质感描述（见下方摄影速查），让设定图更有电影感

{camera_cheat}

## 行为准则
1. 用户要求增删改卡片时，必须调用 canvas_ops 实际执行，不要只口头描述；只做用户要求的操作，不要自作主张添加用户没提的节点。
2. 每轮只发起一次工具调用（一次只调一个工具）；不要在同一轮同时调用 canvas_ops 和 decompose_script 等后端工具。
3. 执行后基于工具结果简短汇报，不要虚构操作结果。
4. 用简体中文交流，简洁、专业，像一个懂影视创作的助手。
5. 与画布/技能无关的问题，正常回答即可。
6. 不要在单轮里重复调用同一个工具超过 5 次；批量操作尽量合并进一次 canvas_ops。"""


# ---------- 节点 ----------


def _extract_tool_name(t: Any) -> str | None:
    if isinstance(t, dict):
        fn = t.get("function") if isinstance(t.get("function"), dict) else {}
        name = fn.get("name") or t.get("name")
        return name if isinstance(name, str) and name.strip() else None
    name = getattr(t, "name", None)
    return name if isinstance(name, str) and name.strip() else None


def _frontend_tools(state: AgentState) -> List[Any]:
    raw: List[Any] = list(state.get("tools") or [])
    ck = state.get("copilotkit")
    actions = getattr(ck, "actions", None) or []
    if isinstance(actions, list):
        raw.extend(actions)
    seen: set[str] = set()
    result = []
    for t in raw:
        name = _extract_tool_name(t)
        if name and name in FRONTEND_TOOL_ALLOWLIST and name not in seen:
            seen.add(name)
            result.append(t)
    return result


def _tool_call_info(tc: Any) -> tuple[str | None, str | None]:
    if isinstance(tc, dict):
        return tc.get("id"), tc.get("name")
    return getattr(tc, "id", None), getattr(tc, "name", None)


def _unanswered_frontend_calls(messages: List[Any]) -> bool:
    """历史里是否存在没有 tool 响应的前端工具调用。

    覆盖混合调用场景：模型把 canvas_ops（前端）和后端工具放在同一条
    assistant 消息里，后端工具被 ToolNode 执行后前端调用仍无响应——
    此时必须结束本轮，等浏览器执行前端工具并回传，否则模型侧 400。
    """
    answered = {
        m.tool_call_id for m in messages if isinstance(m, ToolMessage)
    }
    for m in messages:
        if not isinstance(m, AIMessage):
            continue
        for tc in getattr(m, "tool_calls", None) or []:
            tc_id, name = _tool_call_info(tc)
            if tc_id and name not in backend_tool_names and tc_id not in answered:
                return True
    return False


def _sanitize_messages_for_model(messages: List[Any]) -> List[Any]:
    """清洗历史，保证 assistant(tool_calls) ↔ tool 的合法交替：

    - 孤儿 tool 消息（对应的 assistant tool_call 不在历史里）剔除
    - assistant 的 tool_call 缺响应时补占位响应（模型侧 400 的根源）
    """
    result: List[Any] = []
    pending: Dict[str, str] = {}
    for m in messages:
        if isinstance(m, AIMessage) and getattr(m, "tool_calls", None):
            result.append(m)
            for tc in m.tool_calls:
                tc_id, name = _tool_call_info(tc)
                if tc_id:
                    pending[tc_id] = name or ""
        elif isinstance(m, ToolMessage):
            tc_id = getattr(m, "tool_call_id", None)
            if tc_id and tc_id in pending:
                result.append(m)
                del pending[tc_id]
            # 孤儿 tool 响应 → 跳过
        else:
            if pending:
                for tc_id, name in list(pending.items()):
                    result.append(
                        ToolMessage(
                            content=f"（工具 {name} 本轮未执行，已跳过）",
                            tool_call_id=tc_id,
                        )
                    )
                pending.clear()
            result.append(m)
    for tc_id, name in pending.items():
        result.append(
            ToolMessage(
                content=f"（工具 {name} 本轮未执行，已跳过）", tool_call_id=tc_id
            )
        )
    return result


async def chat_node(state: AgentState, config: RunnableConfig) -> Command:
    messages = list(state.get("messages") or [])

    # 有未响应的前端工具调用（含混合调用场景）→ 等浏览器执行回传
    if _unanswered_frontend_calls(messages):
        return Command(goto=END, update={})

    model = ChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-chat"),
        base_url=os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ.get("AGENT_API_KEY", ""),
        temperature=0.3,
        streaming=True,
    )

    model_with_tools = model.bind_tools(
        [*_frontend_tools(state), *backend_tools],
        parallel_tool_calls=False,
    )

    canvas_summary = state.get("canvasSummary") or "（画布摘要不可用）"
    system_message = SystemMessage(
        content=SYSTEM_PROMPT.format(
            canvas_summary=canvas_summary,
            camera_cheat=camera.camera_cheat_sheet(),
        ),
    )

    # 截断历史，末尾再放一次最新 ground truth，抑制状态漂移；
    # 清洗交替（孤儿 tool / 缺响应的 call）防止模型侧 400
    trimmed = _sanitize_messages_for_model(messages[-14:])
    latest = SystemMessage(
        content=f"[最新画布状态]\n{canvas_summary}",
    )
    response = await model_with_tools.ainvoke(
        [system_message, *trimmed, latest], config
    )

    tool_calls = getattr(response, "tool_calls", None) or []
    call_names = [
        (tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None))
        for tc in tool_calls
    ]
    has_frontend_call = any(n and n not in backend_tool_names for n in call_names)
    has_backend_call = any(n in backend_tool_names for n in call_names)

    # 前端工具调用优先：本轮立即结束交给浏览器执行。若同一消息还混着后端
    # 调用，则后端调用本轮不执行（历史清洗会给它补占位响应，模型下一轮
    # 重新发起）。绝不能把含前端调用的消息送进 ToolNode——它不认识前端
    # 工具，会以"invalid tool"错误响应，破坏交替并误导模型。
    if has_frontend_call:
        return Command(goto=END, update={"messages": [response]})

    if has_backend_call:
        return Command(goto="tool_node", update={"messages": [response]})

    # 纯文本回复 → 结束
    return Command(goto=END, update={"messages": [response]})


# ---------- 图 ----------

workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(backend_tools))
workflow.add_edge("tool_node", "chat_node")
workflow.set_entry_point("chat_node")

# 进程内会话记忆（重启即失；后续可换 SqliteSaver/PostgresSaver）
graph = workflow.compile(checkpointer=MemorySaver())
