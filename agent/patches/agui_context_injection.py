#!/usr/bin/env python3
"""ag-ui-langgraph 桥补丁：把 RunAgentInput.context 注入为对话末尾消息。

上游 ag_ui_langgraph 不消费 AG-UI 的 context 字段，而聊天 UI 依赖它下发
画布摘要（useCopilotReadable → RunAgentInput.context）。venv 重建后跑一次：

    cd agent && uv run python patches/agui_context_injection.py

幂等：已打补丁时直接跳过。补丁内容 = prepare_stream 里把 context 项
（description 含"画布"）写入图状态键 canvasSummary——绝不能注入为 message：
消息会进 checkpoint/UI/持久化，把内部上下文泄露成聊天气泡。
"""
import sys
from pathlib import Path

ANCHOR = '''        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)'''
PATCH = '''        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)
        # AG-UI RunAgentInput.context → 写入图状态键 canvasSummary（本地补丁，
        # 上游不消费 context；wingsight 的画布摘要经 useCopilotReadable 走此通道）。
        # 绝不能注入为 message：消息会进 checkpoint/UI/持久化，把内部上下文
        # 泄露成聊天气泡。
        _ctx_items = getattr(input, "context", None) or []
        for _item in _ctx_items:
            _desc = getattr(_item, "description", "")
            _value = getattr(_item, "value", "")
            # 写入图状态键而非消息：消息会进 checkpoint/UI/持久化，把内部上下文
            # 泄露成聊天气泡（wingsight AgentState 有 canvasSummary，merge 保它）
            if _value and "画布" in _desc:
                state_input["canvasSummary"] = _value
        state = self.langgraph_default_merge_state(state_input, langchain_messages, input)'''

target = Path(__file__).resolve().parent.parent / ".venv/lib/python3.12/site-packages/ag_ui_langgraph/agent.py"
src = target.read_text()
if "AG-UI RunAgentInput.context → 写入图状态键" in src:
    print("已打过补丁，跳过")
    sys.exit(0)
if ANCHOR not in src:
    print("锚点不存在：上游代码结构变了，请手工核对 prepare_stream", file=sys.stderr)
    sys.exit(1)
target.write_text(src.replace(ANCHOR, PATCH))
print("补丁完成:", target)
