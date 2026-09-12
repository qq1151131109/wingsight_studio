# -*- coding: utf-8 -*-
"""turn 状态机补完回归：轮中压缩续跑 + 完成闸门（2026-09-12 P2，无 LLM）。

  C 组 轮中压缩续跑：provider 上下文超限 400 不再整轮报废——
    _is_context_overflow 识别 → _compress_history(force=True) 强制折叠
    （无视阈值、只保最近约 6 条）→ 原地重建 trimmed 重试（不烧 nudge 轮，
    最多 2 次）；压不动（≤8 条 / 单条巨型）原样抛出
  G 组 完成闸门（stop-hook）：纯文本收轮前确定性对账——本轮工具产物带
    「落卡 ops」标记但之后没有任何 canvas_ops 调用 → 拦下一次给第二次机会；
    SystemMessage 落消息流（模型每跳可见 / 按轮扫描去重一轮一次 /
    前端 system 角色不渲染 / 不进聊天持久化）；hard_close 不拦

跑法：cd agent && uv run python test_turn_state.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

import graph as graph_mod

FAILS: list[str] = []
PASSED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
        print(f"  ✓ {name}")
    else:
        FAILS.append(name)
        print(f"  ✗ {name} {detail}")


# ---------- 测试探针 ----------


@tool
async def echo_probe(q: str) -> str:
    """测试探针：原样回显 q。"""
    return f"echo:{q}"


@tool
async def apply_ops_probe(q: str) -> str:
    """测试探针：返回带「落卡 ops」标记的工具结果（模拟出图工具返回串）。"""
    return (
        f"已生成 {q} 的资产图。\n\n资产卡落卡 ops 已生成（1 张 → 挂回对应资产卡）——"
        "**先经 canvas_ops 原样应用整批 ops，再向用户汇报**：\n"
        '{"ops": [{"op": "update_node", "id": "n_x", "imageUrl": "http://x"}]}'
    )


graph_mod.backend_tools.extend([echo_probe, apply_ops_probe])
graph_mod.backend_tool_names.update({"echo_probe", "apply_ops_probe"})


# ---------- 假模型 + 打桩 ----------

_SHARED: dict = {"script": [], "inputs": [], "instances": []}


class _FakeChatModel:
    """按共享脚本吐 chunk；bind_tools 只记绑定。脚本条目：
    ("tool", name, args) / ("multi", [(name,args),...]) / ("text", s) /
    ("raise", Exception) —— astream 抛出该异常（重试时弹下一条）。
    解绑后 tool 条目降级为文本（真实 provider 没绑工具调不出工具）。"""

    def __init__(self, **kwargs):  # noqa: ARG002
        self.bound = False

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        self.bound = True
        return self

    async def astream(self, msgs, config):  # noqa: ARG002
        _SHARED["inputs"].append(list(msgs))
        _SHARED["instances"].append(self)
        item = _SHARED["script"].pop(0)
        if item[0] == "raise":
            raise item[1]
        if item[0] in ("tool", "multi"):
            if not self.bound:
                yield AIMessageChunk(content="（工具已禁用，转为文字收尾）")
                return
            pairs = [(item[1], item[2])] if item[0] == "tool" else item[1]
            yield AIMessageChunk(
                content="",
                tool_calls=[{
                    "name": n, "args": a,
                    "id": f"call_{len(_SHARED['inputs'])}_{i}", "type": "tool_call",
                } for i, (n, a) in enumerate(pairs)],
            )
        else:
            yield AIMessageChunk(content=item[1])


class _EventRecorder:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def track(self, name: str, payload: dict | None = None, **kw):  # noqa: ARG002
        self.events.append((name, payload or {}))


_RECORDER = _EventRecorder()
_REAL_CTOR = graph_mod._OneShotToolArgsCompatChatOpenAI
_REAL_EVENTS = graph_mod.events
_REAL_FOLD = graph_mod._fold_into_summary
_FOLD_LOG: list[int] = []


async def _fake_fold(prev: str, messages: list) -> str:
    _FOLD_LOG.append(len(messages))
    return f"{prev}|[折叠 {len(messages)} 条] " + "；".join(
        str(getattr(m, "content", ""))[:12] for m in messages
    )


def _install_fakes() -> None:
    _SHARED["script"] = []
    _SHARED["inputs"] = []
    _SHARED["instances"] = []
    _FOLD_LOG.clear()
    graph_mod._OneShotToolArgsCompatChatOpenAI = lambda **kw: _FakeChatModel(**kw)
    graph_mod.events = _RECORDER
    graph_mod._fold_into_summary = _fake_fold
    _RECORDER.events.clear()


def _restore() -> None:
    graph_mod._OneShotToolArgsCompatChatOpenAI = _REAL_CTOR
    graph_mod.events = _REAL_EVENTS
    graph_mod._fold_into_summary = _REAL_FOLD


_TEST_GRAPH = None


def _build_test_graph():
    global _TEST_GRAPH
    if _TEST_GRAPH is None:
        wf = StateGraph(graph_mod.AgentState)
        wf.add_node("chat_node", graph_mod.chat_node)
        wf.add_node("tool_node", ToolNode(graph_mod.backend_tools))
        wf.add_edge("tool_node", "chat_node")
        wf.set_entry_point("chat_node")
        _TEST_GRAPH = wf.compile(checkpointer=MemorySaver())
    return _TEST_GRAPH


async def _run(script: list, limit: int, seq: int, thread: str | None = None):
    _install_fakes()
    _SHARED["script"] = list(script)
    try:
        final = await _build_test_graph().ainvoke(
            {"messages": [HumanMessage(content="跑")]},
            config={
                "configurable": {"thread_id": thread or f"turn-state-{seq}"},
                "recursion_limit": limit,
            },
        )
        return final, None
    except Exception as exc:  # noqa: BLE001
        return None, exc
    finally:
        _restore()


def _ai_tool(name: str, args: dict, tc_id: str = "tc_1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": tc_id, "type": "tool_call"}])


def _tool_res(content: str, tc_id: str = "tc_1") -> ToolMessage:
    return ToolMessage(content=content, tool_call_id=tc_id)


MARK = graph_mod._APPLY_OPS_MARK


# ---------- C 组：轮中压缩续跑 ----------


def test_c_pure() -> None:
    print("C 组：纯函数")
    check("C1a DeepSeek 超限文案识别",
          graph_mod._is_context_overflow(
              ValueError("Error code: 400 - This model's maximum context length is 163840 tokens.")))
    check("C1b Anthropic 错误码识别",
          graph_mod._is_context_overflow(RuntimeError("context_length_exceeded")))
    check("C1c prompt is too long 识别",
          graph_mod._is_context_overflow(Exception("API Error: prompt is too long: 210000 tokens")))
    check("C1d 普通错误不误判",
          not graph_mod._is_context_overflow(ValueError("connection reset")))
    check("C1e 空异常不炸", not graph_mod._is_context_overflow(ValueError()))


async def test_c2_force_compress() -> None:
    print("C2：_compress_history(force=True) 折叠语义")
    _install_fakes()
    try:
        msgs = [HumanMessage(content="H0")] + [
            AIMessage(content=f"第{i}轮回答" * 3) for i in range(1, 12)
        ]  # 12 条、总量远低于 400k 阈值
        summary, count, update = await (
            graph_mod._compress_history("", 0, msgs, force=True)
        )
        check("C2a 低于阈值时 force 也折叠", bool(update), f"update={update}")
        check("C2b 折叠后只保最近 5 条（≥6 守卫的边界语义）", count == 7, f"count={count}")
        check("C2c 摘要并入折叠内容", "[折叠 7 条]" in summary and "第1轮回答" in summary)

        summary2, count2, update2 = await (
            graph_mod._compress_history("", 0, msgs)
        )
        check("C2d 非 force 低于阈值不折叠", not update2 and count2 == 0)

        small = [HumanMessage(content="H")] + [AIMessage(content="x") for _ in range(6)]
        _, _, update3 = await (
            graph_mod._compress_history("", 0, small, force=True)
        )
        check("C2e ≤8 条 force 折不动（空增量，调用方据此抛错）", not update3)

        # 折叠边界不切开 tool 配对：to_fold 尾部是 AI(tool_calls) 时回退一格
        paired = [HumanMessage(content="H0")] + [
            AIMessage(content=f"t{i}") for i in range(1, 7)
        ] + [_ai_tool("x", {}, "tc_pair"), _tool_res("r", "tc_pair")]
        _, count4, _ = await (
            graph_mod._compress_history("", 0, paired, force=True)
        )
        # keep last 6 = [A(t5..t6)? ...] 实际边界：保 6 条 = 索引 4..10？——
        # 校验点是不变量：count 之后的首条消息不能是无应答的 AI(tool_calls)
        visible = paired[count4:]
        bad = any(
            isinstance(m, AIMessage) and getattr(m, "tool_calls", None)
            and not any(
                isinstance(v, ToolMessage) and v.tool_call_id == m.tool_calls[0]["id"]
                for v in visible[visible.index(m) + 1 :]
            )
            for m in visible
        )
        check("C2f 折叠边界不产生孤儿 tool_call", not bad, f"count={count4}")
    finally:
        _restore()


async def test_c3_overflow_retry() -> None:
    print("C3：图级超限重试（5 轮工具 → 超限一次 → 强压续跑文字收尾）")
    script = [("tool", "echo_probe", {"q": str(i)}) for i in range(1, 6)]
    script += [
        ("raise", ValueError("Error code: 400 - This model's maximum context length is 163840 tokens. However, you requested 200000 tokens")),
        ("text", "已压缩续跑，正常收尾。"),
    ]
    final, err = await _run(script, limit=40, seq=3)
    check("C3a 超限被挽回不抛", err is None, f"{type(err).__name__}: {err}")
    if final is None:
        return
    check("C3b 正常文字收尾", isinstance(final["messages"][-1], AIMessage)
          and final["messages"][-1].content == "已压缩续跑，正常收尾。")
    check("C3c 强制折叠落进 state", int(final.get("summary_count") or 0) > 0
          and bool(final.get("history_summary")),
          f"count={final.get('summary_count')}")
    evts = [e for e in _RECORDER.events if e[0] == "agent.ctx_overflow"]
    check("C3d ctx_overflow 遥测", len(evts) == 1 and evts[0][1].get("retry") == 1, f"{evts}")
    # 重试发生在同一 hop：第 6 次 astream 抛错，第 7 次（重建入参）成功
    inputs = _SHARED["inputs"]
    check("C3e 重试入参比超限入参短", len(inputs) == 7
          and sum(len(str(getattr(m, "content", ""))) for m in inputs[6])
          < sum(len(str(getattr(m, "content", ""))) for m in inputs[5]),
          f"calls={len(inputs)}")


async def test_c4_unfixable_raises() -> None:
    print("C4：压不动（消息 ≤8）→ 原样抛出不死循环")
    script = [
        ("tool", "echo_probe", {"q": "1"}),
        ("raise", ValueError("Error code: 400 - This model's maximum context length is 163840 tokens")),
        ("text", "不该到达"),
    ]
    final, err = await _run(script, limit=40, seq=4)
    check("C4a 异常上抛", err is not None and "maximum context length" in str(err),
          f"err={err}")
    check("C4b 只试一次不重试", len(_SHARED["inputs"]) == 2,
          f"calls={len(_SHARED['inputs'])}")


# ---------- G 组：完成闸门 ----------


def test_g_pure() -> None:
    print("G 组：纯函数")
    anchor = _tool_res(f"资产卡落卡 ops 已生成——**先经 canvas_ops {MARK}**")
    call = _ai_tool("canvas_ops", {"ops": []}, "tc_c")
    h = HumanMessage(content="做")

    check("G1a 锚点未应用 → 1", graph_mod._unapplied_canvas_ops([h, _ai_tool("x", {}), anchor]) == 1)
    check("G1b 锚点后有 canvas_ops → 0",
          graph_mod._unapplied_canvas_ops([h, anchor, call, _tool_res("ok", "tc_c")]) == 0)
    check("G1c canvas_ops 在锚点之前 → 仍 1",
          graph_mod._unapplied_canvas_ops([h, call, _tool_res("ok", "tc_c"), anchor]) == 1)
    check("G1d 锚点在上一轮 → 0（轮界断开）",
          graph_mod._unapplied_canvas_ops([anchor, h, _ai_text_msg("好的")]) == 0)
    check("G1e 两锚点夹一次应用 → 余 1",
          graph_mod._unapplied_canvas_ops([h, anchor, call, _tool_res("ok", "tc_c"), anchor]) == 1)

    gate = SystemMessage(content=f"{graph_mod._TURN_GATE_MARK} 系统对账：……")
    check("G1f 闸门标记本轮命中", graph_mod._turn_gate_fired([h, gate]))
    check("G1g 闸门标记在上轮不命中", not graph_mod._turn_gate_fired([gate, h, _ai_text_msg("收到")]))
    check("G1h 无标记不命中", not graph_mod._turn_gate_fired([h, _ai_text_msg("完成")]))


def _ai_text_msg(text: str) -> AIMessage:
    return AIMessage(content=text)


async def test_g2_gate_full_chain() -> None:
    print("G2：闸门全链（落卡产物 → 口播完成 → 拦下 → 补 canvas_ops）")
    script = [
        ("tool", "apply_ops_probe", {"q": "角色定妆"}),
        ("text", "1 张资产图已生成并落卡，全部完成！"),
        ("tool", "canvas_ops", {"ops": [{"op": "update_node", "id": "n_x", "imageUrl": "http://x"}]}),
    ]
    final, err = await _run(script, limit=40, seq=5)
    check("G2a 无异常", err is None, f"{type(err).__name__}: {err}")
    if final is None:
        return
    msgs = final["messages"]
    gates = [m for m in msgs if isinstance(m, SystemMessage) and str(m.content).startswith(graph_mod._TURN_GATE_MARK)]
    check("G2b 闸门 SystemMessage 落消息流", len(gates) == 1)
    last = msgs[-1]
    tc_names = [tc.get("name") for tc in (getattr(last, "tool_calls", None) or [])]
    check("G2c 轮以 canvas_ops 应用收尾（前端 END）", tc_names == ["canvas_ops"], f"{tc_names}")
    evts = [e for e in _RECORDER.events if e[0] == "agent.turn_gate"]
    check("G2d turn_gate 遥测一次", len(evts) == 1 and evts[0][1].get("pending") == 1, f"{evts}")
    saw = any(
        str(getattr(m, "content", "")).startswith(graph_mod._TURN_GATE_MARK)
        for inputs in _SHARED["inputs"] for m in inputs
    )
    check("G2e 模型实际看到闸门通知（入参在场）", saw)


async def test_g3_gate_once_per_turn() -> None:
    print("G3：模型无视闸门仍口播完成 → 一轮只拦一次，正常放行")
    script = [
        ("tool", "apply_ops_probe", {"q": "场景空镜"}),
        ("text", "都搞定了。"),
        ("text", "反正都搞定了。"),
    ]
    final, err = await _run(script, limit=40, seq=6)
    check("G3a 无异常收尾", err is None)
    if final:
        msgs = final["messages"]
        gates = [m for m in msgs if isinstance(m, SystemMessage) and str(m.content).startswith(graph_mod._TURN_GATE_MARK)]
        check("G3b 闸门只出现一次", len(gates) == 1, f"got {len(gates)}")
        check("G3c 以模型文本放行结束", isinstance(msgs[-1], AIMessage) and not getattr(msgs[-1], "tool_calls", None))
        evts = [e for e in _RECORDER.events if e[0] == "agent.turn_gate"]
        check("G3d turn_gate 遥测只一次", len(evts) == 1)


async def test_g4_no_marker_no_gate() -> None:
    print("G4：无落卡标记的普通轮零误伤")
    script = [("tool", "echo_probe", {"q": "1"}), ("text", "完成。")]
    final, err = await _run(script, limit=40, seq=7)
    check("G4a 无异常", err is None)
    if final:
        check("G4b 零闸门消息",
              not any(isinstance(m, SystemMessage) for m in final["messages"]))
        check("G4c 零 turn_gate 遥测",
              not [e for e in _RECORDER.events if e[0] == "agent.turn_gate"])


async def test_g5_hard_close_skips_gate() -> None:
    print("G5：hard_close（步数只够收尾）时闸门不拦")
    # limit=5：chat@1 工具 → tool@2 → chat@3（3≥5-2 硬收尾）文本放行
    script = [("tool", "apply_ops_probe", {"q": "x"}), ("text", "被迫收尾。")]
    final, err = await _run(script, limit=5, seq=8)
    check("G5a 无异常", err is None, f"{type(err).__name__}: {err}")
    if final:
        check("G5b 零闸门消息（步数预算优先）",
              not any(isinstance(m, SystemMessage) for m in final["messages"]))
        check("G5c 零 turn_gate 遥测",
              not [e for e in _RECORDER.events if e[0] == "agent.turn_gate"])


async def main() -> None:
    test_c_pure()
    await test_c2_force_compress()
    await test_c3_overflow_retry()
    await test_c4_unfixable_raises()
    test_g_pure()
    await test_g2_gate_full_chain()
    await test_g3_gate_once_per_turn()
    await test_g4_no_marker_no_gate()
    await test_g5_hard_close_skips_gate()
    total = PASSED + len(FAILS)
    print(f"\n共 {total} 项，通过 {PASSED}，失败 {len(FAILS)}")
    if FAILS:
        for f in FAILS:
            print(f"  ✗ {f}")
        sys.exit(1)
    print("全绿 ✓")


if __name__ == "__main__":
    asyncio.run(main())
