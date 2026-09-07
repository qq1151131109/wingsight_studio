# -*- coding: utf-8 -*-
"""聊天历史交替守卫回归（090702 凤临天下 400 毒化事故）。

背景：模型在一条 assistant 消息里混发前端（canvas_ops）+后端
（decompose_script）工具调用——宪法规则 2 明令禁止、parallel_tool_calls=False
上游也不遵守。chat_node 前端优先路由把该消息送 END（后端调用被跳过），
浏览器只应答了前端调用，模型下轮重发后端调用。旧版
_sanitize_messages_for_model 的占位响应补在序列末尾，中段
AI(mixed)→Tool(部分应答)→AI(reissue) 对上游是非法交替：
"An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'" ——400 之后每轮重放同段历史，会话永久毒化。

旧版 _unanswered_frontend_calls 还会把「结果丢失的陈旧前端调用」当
「等浏览器回传」处理：中途 END 无声吞掉用户后续所有消息。

回归（纯函数，无 LLM）：
  T1 毒源场景：混合调用重发序列 → 清洗后交替合法（占位补在 AI 之间）
  T2 陈旧前端调用：中部未应答 + 用户已发新消息 → 守卫放行不哑火
  T3 尾部前端调用：模型刚发完前端调用 → 守卫拦截等浏览器（原语义保留）
  T4 尾部混合调用：末条 AI 含未应答前端调用 → 守卫拦截
  T5 混合调用已部分应答：末条是 Tool → 守卫放行（下轮重发后端调用）
  T6 迟到的前端结果：Human 之后的孤儿 Tool → 跳过不破坏交替
  T7 凤临天下 checkpoint 结构复刻：真实中毒形态 → 清洗后合法

跑法：cd agent && uv run python ../scripts/chat-alternation-guard-test.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from graph import _sanitize_messages_for_model, _unanswered_frontend_calls

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    mark = "✓" if cond else "✗"
    print(f"  {mark} {name}" + (f" —— {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def assert_legal_alternation(msgs: list, label: str) -> None:
    """上游口径：assistant(tool_calls) 的每个 call_id 必须在紧随其后的
    连续 ToolMessage 区段内得到应答，之后才能出现任何其他消息。"""
    i = 0
    while i < len(msgs):
        m = msgs[i]
        tcs = getattr(m, "tool_calls", None) or []
        if isinstance(m, AIMessage) and tcs:
            ids = {tc["id"] for tc in tcs}
            j = i + 1
            answered: set[str] = set()
            while j < len(msgs) and isinstance(msgs[j], ToolMessage):
                if msgs[j].tool_call_id in ids:
                    answered.add(msgs[j].tool_call_id)
                j += 1
            missing = ids - answered
            check(
                f"{label}：[{i}] AI(tool_calls) 交替合法",
                not missing,
                f"缺应答 {missing}，其后第一条非 Tool 消息是 {type(msgs[j]).__name__ if j < len(msgs) else '<END>'}",
            )
            i = j
        else:
            i += 1


def ai(tcs: list[tuple[str, str]], text: str = "") -> AIMessage:
    return AIMessage(
        content=text,
        tool_calls=[{"name": n, "args": {}, "id": cid} for n, cid in tcs],
    )


def tool(cid: str, content: str = "ok") -> ToolMessage:
    return ToolMessage(content=content, tool_call_id=cid)


print("T1 毒源场景：混合调用重发（凤临天下形态）")
seq1 = [
    HumanMessage("生成资产"),
    ai([("read_skill", "c_rs")]),
    tool("c_rs"),
    ai([("canvas_ops", "c_cv"), ("decompose_script", "c_dc")]),  # 混合：前端+后端
    tool("c_cv"),  # 浏览器只应答了前端
    ai([("decompose_script", "c_dc2")]),  # 模型下轮重发后端调用
    tool("c_dc2"),
    AIMessage("剧本卡已落。"),
    HumanMessage("好"),
]
out1 = _sanitize_messages_for_model(seq1)
assert_legal_alternation(out1, "T1")
# 占位必须补在 AI(mixed) 与 AI(reissue) 之间，而不是序列末尾
idx_mixed = next(i for i, m in enumerate(out1) if isinstance(m, AIMessage) and
                 {tc["name"] for tc in (m.tool_calls or [])} == {"canvas_ops", "decompose_script"})
between = out1[idx_mixed + 1: idx_mixed + 3]
check("T1：c_dc 占位补在 AI(mixed) 之后两条消息内",
      any(isinstance(m, ToolMessage) and m.tool_call_id == "c_dc" for m in between),
      f"实际 {between}")
check("T1：守卫放行（后端调用缺响应不是前端等待态）", not _unanswered_frontend_calls(seq1))

print("T2 陈旧前端调用：结果丢失后用户又发了消息 → 不哑火")
seq2 = [
    HumanMessage("整理画布"),
    ai([("canvas_ops", "c_stale")]),  # 前端调用，结果因刷新/断流丢失
    HumanMessage("继续"),
]
check("T2：守卫放行（未应答调用不在尾部）", not _unanswered_frontend_calls(seq2))
out2 = _sanitize_messages_for_model(seq2)
assert_legal_alternation(out2, "T2")
check("T2：占位补在第二条 Human 之前",
      isinstance(out2[2], ToolMessage) and out2[2].tool_call_id == "c_stale"
      and isinstance(out2[3], HumanMessage))

print("T3 尾部前端调用：模型刚发完 → 等浏览器（原语义保留）")
seq3 = [HumanMessage("打开画风面板"), ai([("open_style_picker", "c_sp")])]
check("T3：守卫拦截", _unanswered_frontend_calls(seq3))
out3 = _sanitize_messages_for_model(seq3)
assert_legal_alternation(out3, "T3")

print("T4 尾部混合调用：末条 AI 含未应答前端调用 → 拦截")
seq4 = [HumanMessage("建卡并拆解"), ai([("canvas_ops", "c_m1"), ("decompose_script", "c_m2")])]
check("T4：守卫拦截", _unanswered_frontend_calls(seq4))

print("T5 混合调用已部分应答：末条是 Tool → 放行走模型")
seq5 = [
    HumanMessage("建卡并拆解"),
    ai([("canvas_ops", "c_p1"), ("decompose_script", "c_p2")]),
    tool("c_p1"),  # 浏览器应答前端，后端等模型下轮重发
]
check("T5：守卫放行", not _unanswered_frontend_calls(seq5))
assert_legal_alternation(_sanitize_messages_for_model(seq5), "T5")

print("T6 迟到的前端结果：Human 之后的孤儿 Tool → 跳过")
seq6 = [
    HumanMessage("整理画布"),
    ai([("canvas_ops", "c_late")]),
    HumanMessage("继续"),
    tool("c_late"),  # 结果迟到，落在用户新消息之后
    ai([("read_skill", "c_rs6")]),
    tool("c_rs6"),
]
out6 = _sanitize_messages_for_model(seq6)
assert_legal_alternation(out6, "T6")
check("T6：孤儿 Tool（迟到真实响应）被剔除",
      not any(isinstance(m, ToolMessage) and m.tool_call_id == "c_late" and m.content == "ok"
              for m in out6))

print("T7 凤临天下 checkpoint 结构复刻（真实中毒形态）")
seq7 = [
    HumanMessage("生成资产\n\n附件：\n- 文档「凤临天下-冯太后.docx」内容：\n<<<\n《凤临…"),
    ai([("read_skill", "call_00_P4Qj")]),
    tool("call_00_P4Qj", "…手册正文…"),
    ai([("canvas_ops", "call_00_SCrO"), ("decompose_script", "call_01_u47x")]),
    tool("call_00_SCrO"),  # name=None 的浏览器应答，只回前端
    ai([("decompose_script", "call_00_XT9D")]),
    tool("call_00_XT9D", "拆解完成"),
    AIMessage("剧本卡已落。"),
    HumanMessage("好"),
    HumanMessage("好"),
    HumanMessage("好"),
    HumanMessage("好的"),
]
out7 = _sanitize_messages_for_model(seq7)
assert_legal_alternation(out7, "T7")
check("T7：守卫放行（可以继续对话，不再 400/哑火）", not _unanswered_frontend_calls(seq7))

print("T8 纯净会话不受影响")
seq8 = [
    SystemMessage("sys"),
    HumanMessage("你好"),
    AIMessage("你好！"),
    HumanMessage("画布上有啥"),
    ai([("canvas_query", "c_q")]),
    tool("c_q", "[]"),
    AIMessage("画布是空的。"),
]
out8 = _sanitize_messages_for_model(seq8)
check("T8：原样透传（不增不减不重排）",
      [type(m).__name__ for m in out8] == [type(m).__name__ for m in seq8])
assert_legal_alternation(out8, "T8")

print()
if FAILS:
    print(f"✗ 失败 {len(FAILS)} 项：{FAILS}")
    sys.exit(1)
print(f"✓ 全部通过（8 组场景）")
