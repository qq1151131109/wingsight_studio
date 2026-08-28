"""Wingsight 画布助手 — LangGraph 主 Agent。

架构（参考 CopilotKit 官方 canvas 示例的 coagent 模式）：
- 前端工具（canvas_ops）经 RunAgentInput 注入，从 state["tools"] / state["copilotkit"].actions
  读取并 bind 到模型；模型发起调用后本轮结束（Command(goto=END)），由浏览器执行并把
  ToolMessage 带回下一轮。
- 后端工具（run_langflow_skill / list_langflow_skills）在 ToolNode 里执行。
- 画布 ground truth 走共享状态 canvasSummary（前端 useCoAgent setState 同步）。
"""

import os
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langchain.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from langgraph.prebuilt import ToolNode
from copilotkit import CopilotKitState

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
async def run_langflow_skill(skill: str, input_text: str) -> str:
    """调用一个 Langflow 技能（预置生成管线）并返回其文本结果。

    Args:
        skill: 技能名（先用 list_langflow_skills 查可用技能）。
        input_text: 传给技能的输入（如剧本片段、角色设定描述）。
    """
    return await skills.run_skill(skill, input_text)


backend_tools = [list_langflow_skills, decompose_script, run_langflow_skill]
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
1. 调 decompose_script(剧本原文) 拆出资产清单
2. 用一次 canvas_ops 批量建卡：角色→character 卡（name 做标题）；场景/道具→note 卡（标题带「场景：」「道具：」前缀，description 与 visual_notes 写进 body）
3. 汇报拆解结果并请用户确认增删（用户补充/删除角色时直接用 canvas_ops 改画布，不要重新拆解）
4. 出图能力暂未接入——用户要求出图时说明这一步即将上线，先完成卡片

## 行为准则
1. 用户要求增删改卡片时，必须调用 canvas_ops 实际执行，不要只口头描述；只做用户要求的操作，不要自作主张添加用户没提的节点。
2. 执行后基于工具结果简短汇报，不要虚构操作结果。
3. 用简体中文交流，简洁、专业，像一个懂影视创作的助手。
4. 与画布/技能无关的问题，正常回答即可。
5. 不要在单轮里重复调用同一个工具超过 5 次；批量操作尽量合并进一次 canvas_ops。"""


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


def _pending_frontend_call(messages: List[Any]) -> bool:
    """最后一条 AI 消息里是否还有未回传的前端工具调用（等待浏览器执行）。"""
    if not messages:
        return False
    last = messages[-1]
    if not isinstance(last, AIMessage):
        return False
    for tc in getattr(last, "tool_calls", None) or []:
        name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None)
        if name and name not in backend_tool_names:
            return True
    return False


async def chat_node(state: AgentState, config: RunnableConfig) -> Command:
    messages = list(state.get("messages") or [])

    # 前端工具调用的结果已回传则继续；还有未决的前端调用则等浏览器
    if _pending_frontend_call(messages):
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
        content=SYSTEM_PROMPT.format(canvas_summary=canvas_summary),
    )

    # 截断历史，末尾再放一次最新 ground truth，抑制状态漂移
    trimmed = messages[-12:]
    latest = SystemMessage(
        content=f"[最新画布状态]\n{canvas_summary}",
    )
    response = await model_with_tools.ainvoke(
        [system_message, *trimmed, latest], config
    )

    tool_calls = getattr(response, "tool_calls", None) or []
    has_backend_call = any(
        (tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None))
        in backend_tool_names
        for tc in tool_calls
    )

    if has_backend_call:
        return Command(goto="tool_node", update={"messages": [response]})

    # 前端工具调用（或纯文本回复）→ 本轮结束；前端执行后带 ToolMessage 开启下一轮
    return Command(goto=END, update={"messages": [response]})


# ---------- 图 ----------

workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(backend_tools))
workflow.add_edge("tool_node", "chat_node")
workflow.set_entry_point("chat_node")

# 进程内会话记忆（重启即失；后续可换 SqliteSaver/PostgresSaver）
graph = workflow.compile(checkpointer=MemorySaver())
