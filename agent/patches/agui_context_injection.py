#!/usr/bin/env python3
"""ag-ui-langgraph 桥补丁：把 RunAgentInput.context 注入为对话末尾消息。

上游 ag_ui_langgraph 不消费 AG-UI 的 context 字段，而聊天 UI 依赖它下发
画布摘要（useCopilotReadable → RunAgentInput.context）。venv 重建后跑一次：

    cd agent && uv run python patches/agui_context_injection.py

幂等：已打补丁时直接跳过。补丁内容 = prepare_stream 里把 context 项拼成
一条 Human 消息追加到 messages 末尾（merge_state 会剥掉首条 SystemMessage，
且末位对模型注意力最友好，故不注入为 system）。
"""
import sys
from pathlib import Path

ANCHOR = '''        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)'''
PATCH = '''        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)
        # AG-UI RunAgentInput.context → 注入为一条 Human 消息（本地补丁，
        # 上游不消费 context；wingsight 的画布摘要经 useCopilotReadable 走此通道）
        _ctx_items = getattr(input, "context", None) or []
        _ctx_lines = []
        for _item in _ctx_items:
            _desc = getattr(_item, "description", "")
            _value = getattr(_item, "value", "")
            if _value:
                _ctx_lines.append(f"{_desc}: {_value}" if _desc else str(_value))
        if _ctx_lines:
            from langchain_core.messages import HumanMessage as _CtxHumanMessage
            # 追加为末尾一条 Human 消息：merge_state 会剥掉首条 SystemMessage，
            # 且末位对模型注意力最友好
            langchain_messages = [
                *langchain_messages,
                _CtxHumanMessage(content="[调用方附带的上下文]\\n" + "\\n".join(_ctx_lines)),
            ]'''

target = Path(__file__).resolve().parent.parent / ".venv/lib/python3.12/site-packages/ag_ui_langgraph/agent.py"
src = target.read_text()
if "AG-UI RunAgentInput.context → 注入" in src:
    print("已打过补丁，跳过")
    sys.exit(0)
if ANCHOR not in src:
    print("锚点不存在：上游代码结构变了，请手工核对 prepare_stream", file=sys.stderr)
    sys.exit(1)
target.write_text(src.replace(ANCHOR, PATCH))
print("补丁完成:", target)
