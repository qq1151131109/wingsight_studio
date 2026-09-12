# -*- coding: utf-8 -*-
"""确定性循环检测 + 步数宽限收尾回归（2026-09-12 P2，无 LLM）。

背景：LLM 自察不了循环——同工具同参数原样重发一路烧到 recursion_limit，
GraphRecursionError 把本轮全部产出与叙事一起报废。graph.py 现有两级守卫：
  - 连续第 3 次同签名调用 → 拦截 + 合成 ToolMessage 反思提醒 + 自环重跑
  - 提醒后仍第 4 次 → 止损标记 + 下一跳解绑工具强制纯文字收尾
  - recursion_limit 临近 → 软收尾指令（不落 checkpoint）；最后 2 步硬收尾
    （解绑工具，结构性不可达 GraphRecursionError）

测试分两组：
  A 纯函数：签名稳定性 / 尾部连续计数与断档 / 止损标记只认尾部 / 步数预算
  B 图级（真 chat_node + 假模型，真 StateGraph + MemorySaver）：
    B1 循环全链：同参×4 → 2 真执行 + 拦截 + 止损 → 解绑文字收尾
    B2 宽限收尾：异参连发不触发循环检测；limit=12 下软指令注入、硬收尾解绑、
       不抛 GraphRecursionError
    B3 不误伤：同工具不同参数连续调用 + 正常文本收尾，零拦截
    B4 前端调用不进循环账：canvas_ops 直接 END 等浏览器
    B5 混合调用（前端+后端同消息）：前端优先路由 END，守卫不添乱
    B6 多后端调用违规：第一个是重复 → 只拦第一个，第二个由 sanitize 占位
    B8 止损 END 后新 run 恢复正常：「临时禁用」只作用于当轮（同 thread 续跑）

跑法：cd agent && uv run python test_loop_guard.py
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
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


# ---------- 测试探针后端工具 ----------


@tool
async def echo_probe(q: str) -> str:
    """测试探针：原样回显 q。"""
    return f"echo:{q}"


graph_mod.backend_tools.append(echo_probe)
graph_mod.backend_tool_names.add("echo_probe")


# ---------- 假模型 + 埋点录音 ----------

_SHARED: dict = {"script": [], "inputs": [], "instances": []}


class _FakeChatModel:
    """按共享脚本吐 chunk 的假 ChatOpenAI；bind_tools 只记绑定状态。

    解绑（hard_close）后脚本仍要求工具时降级为文本——模拟真实 provider
    没绑工具就物理上调不出工具调用。脚本条目：
      ("tool", name, args) 单工具调用 / ("multi", [(name, args), ...]) 一条
      消息多个调用（复现 parallel_tool_calls=False 被违反）/ ("text", s) 纯文本
    """

    def __init__(self, **kwargs):  # noqa: ARG002
        self.bound = False

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        self.bound = True
        return self

    async def astream(self, msgs, config):  # noqa: ARG002
        _SHARED["inputs"].append(list(msgs))
        _SHARED["instances"].append(self)
        item = _SHARED["script"].pop(0)
        if item[0] in ("tool", "multi"):
            if not self.bound:
                yield AIMessageChunk(content="（工具已禁用，转为文字收尾）")
                return
            pairs = [(item[1], item[2])] if item[0] == "tool" else item[1]
            yield AIMessageChunk(
                content="",
                tool_calls=[{
                    "name": n,
                    "args": a,
                    "id": f"call_{len(_SHARED['inputs'])}_{i}",
                    "type": "tool_call",
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


def _install_fakes() -> None:
    _SHARED["script"] = []
    _SHARED["inputs"] = []
    _SHARED["instances"] = []
    graph_mod._OneShotToolArgsCompatChatOpenAI = lambda **kw: _FakeChatModel(**kw)
    graph_mod.events = _RECORDER
    _RECORDER.events.clear()


def _restore() -> None:
    graph_mod._OneShotToolArgsCompatChatOpenAI = _REAL_CTOR
    graph_mod.events = _REAL_EVENTS


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
                "configurable": {"thread_id": thread or f"loop-guard-{seq}"},
                "recursion_limit": limit,
            },
        )
        return final, None
    except Exception as exc:  # noqa: BLE001
        return None, exc
    finally:
        _restore()


def _model_inputs_text() -> str:
    """假模型收到的全部入参拼成一段文本（供指令注入/占位断言）。"""
    return "\n".join(
        str(getattr(m, "content", "")) for inputs in _SHARED["inputs"] for m in inputs
    )


def _tc(name: str, args: dict) -> dict:
    return {"name": name, "args": args, "id": f"tc_{name}", "type": "tool_call"}


def _ai_tool(name: str, args: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=[_tc(name, args)])


def _ai_text(text: str) -> AIMessage:
    return AIMessage(content=text)


def _tool_res(content: str, tc_id: str = "tc_x") -> ToolMessage:
    return ToolMessage(content=content, tool_call_id=tc_id)


# ---------- A 纯函数 ----------


def test_pure() -> None:
    print("A 组：纯函数")
    # A1 签名：dict/对象两形态一致；键序不敏感；args 空安全
    s1 = graph_mod._tool_call_sig(_tc("t", {"q": "x", "n": 1}))
    s2 = graph_mod._tool_call_sig(_tc("t", {"n": 1, "q": "x"}))
    s3 = graph_mod._tool_call_sig(
        SimpleNamespace(name="t", args={"n": 1, "q": "x"})
    )
    check("A1a 键序不敏感", s1 == s2, f"{s1} != {s2}")
    check("A1b 对象形态同签名", s1 == s3)
    check("A1c 空 args 与 None 同签名",
          graph_mod._tool_call_sig(_tc("t", {})) == graph_mod._tool_call_sig(
              SimpleNamespace(name="t", args=None)))

    # A2 尾部连续计数
    hist = [
        HumanMessage(content="做"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r2"),
    ]
    n1 = graph_mod._consecutive_repeat(hist, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2a 同签名连续 ×2", n1 == 2, f"got {n1}")

    hist_break = [
        HumanMessage(content="做"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        _ai_tool("t", {"q": 2}),
        _tool_res("r2"),
    ]
    n2 = graph_mod._consecutive_repeat(hist_break, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2b 异参即断档", n2 == 0, f"got {n2}")

    hist_interleave = [
        HumanMessage(content="做"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        _ai_tool("other", {"z": 1}),
        _tool_res("r2"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r3"),
    ]
    n3 = graph_mod._consecutive_repeat(hist_interleave, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2c 穿插其它调用断档", n3 == 1, f"got {n3}")

    hist_text = [
        HumanMessage(content="做"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        _ai_text("中间插话"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r2"),
    ]
    n4 = graph_mod._consecutive_repeat(hist_text, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2d 纯文本 AI 断档", n4 == 1, f"got {n4}")

    hist_cross_turn = [
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        HumanMessage(content="新轮"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r2"),
    ]
    n5 = graph_mod._consecutive_repeat(hist_cross_turn, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2e 跨轮不计（Human 断档）", n5 == 1, f"got {n5}")

    # 拦截/止损的合成 ToolMessage 不应断计数（否则止损永远数不到 4）
    hist_guarded = [
        HumanMessage(content="做"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r1"),
        _ai_tool("t", {"q": 1}),
        _tool_res("r2"),
        _ai_tool("t", {"q": 1}),
        _tool_res("[循环拦截] …"),
    ]
    n6 = graph_mod._consecutive_repeat(hist_guarded, "t", graph_mod._tool_call_sig(_tc("t", {"q": 1}))[1])
    check("A2f 合成拦截 Tool 不断计数", n6 == 3, f"got {n6}")
    check("A2g 空历史为 0", graph_mod._consecutive_repeat([HumanMessage(content="hi")], "t", "x") == 0)

    # A3 止损标记只认尾部
    mark = graph_mod._LOOP_STOP_MARK
    check("A3a 尾部标记命中",
          graph_mod._pending_stop_loss([_ai_tool("t", {}), _tool_res(f"{mark} 强制收尾")]))
    check("A3b 中部标记不命中",
          not graph_mod._pending_stop_loss(
              [_tool_res(f"{mark} 旧标记"), _ai_text("早已收尾"), HumanMessage(content="新消息")]))
    check("A3c 无标记不命中", not graph_mod._pending_stop_loss([_tool_res("echo:x")]))
    check("A3d 空列表不命中", not graph_mod._pending_stop_loss([]))

    # A4 步数预算
    check("A4a 正常读取", graph_mod._step_budget(
        {"metadata": {"langgraph_step": 5}, "recursion_limit": 12}) == (5, 12))
    check("A4b 缺失归零", graph_mod._step_budget({}) == (0, 0))
    check("A4c 垃圾值归零", graph_mod._step_budget(
        {"metadata": {"langgraph_step": "x"}, "recursion_limit": None}) == (0, 0))

    # A5 阈值契约锁定
    check("A5a 反思阈值 3", graph_mod._LOOP_REFLECT_AT == 3)
    check("A5b 止损阈值 4", graph_mod._LOOP_STOP_AT == 4)
    check("A5c 宽限 8 / 硬收尾 2", graph_mod._CLOSE_MARGIN == 8 and graph_mod._HARD_CLOSE_MARGIN == 2)


# ---------- B 图级 ----------


async def test_b1_loop_full_chain() -> None:
    print("B1：循环检测全链（同参×4 → 拦截 → 止损 → 解绑收尾）")
    script = [("tool", "echo_probe", {"q": "x"})] * 4 + [("text", "已按要求收尾。")]
    final, err = await _run(script, limit=40, seq=1)
    check("B1a 无异常收尾", err is None, f"{type(err).__name__}: {err}")
    if final is None:
        return
    msgs = final["messages"]
    ai_calls = [m for m in msgs if isinstance(m, AIMessage) and m.tool_calls]
    tools = [m for m in msgs if isinstance(m, ToolMessage)]
    echoes = [m for m in tools if str(m.content) == "echo:x"]
    intercepts = [m for m in tools if "循环拦截" in str(m.content)]
    stops = [m for m in tools if str(m.content).startswith(graph_mod._LOOP_STOP_MARK)]
    check("B1b 4 次同参调用全留痕（2 执行 + 2 拦截）", len(ai_calls) == 4, f"got {len(ai_calls)}")
    check("B1c 只真执行 2 次", len(echoes) == 2, f"got {len(echoes)}")
    check("B1d 反思拦截 1 次", len(intercepts) == 1)
    check("B1e 止损拦截 1 次", len(stops) == 1)
    check("B1f 末条为模型文字收尾",
          isinstance(msgs[-1], AIMessage) and msgs[-1].content == "已按要求收尾。")
    insts = _SHARED["instances"]
    check("B1g 共 5 跳（4 工具跳 + 1 收尾跳）", len(insts) == 5, f"got {len(insts)}")
    check("B1h 止损后一跳解绑工具", all(not i.bound for i in insts[4:]))
    check("B1i 此前各跳正常绑定", all(i.bound for i in insts[:4]))
    guards = [e for e in _RECORDER.events if e[0] == "agent.loop_guard"]
    levels = [e[1].get("level") for e in guards]
    check("B1j 遥测两档（reflect→stop）", levels == ["reflect", "stop"], f"got {levels}")


async def test_b2_graceful_close() -> None:
    print("B2：宽限收尾（异参连发不触发循环检测；limit=12 软指令 + 硬收尾解绑）")
    script = [("tool", "echo_probe", {"q": str(i)}) for i in range(1, 6)] + [("text", "收尾汇报：完成。")]
    final, err = await _run(script, limit=12, seq=2)
    check("B2a 不抛 GraphRecursionError", err is None, f"{type(err).__name__}: {err}")
    if final is None:
        return
    msgs = final["messages"]
    check("B2b 正常文字收尾", isinstance(msgs[-1], AIMessage) and msgs[-1].content == "收尾汇报：完成。")
    guards = [e for e in _RECORDER.events if e[0] == "agent.loop_guard"]
    check("B2c 异参连发零拦截", not guards, f"got {guards}")

    def _saw(mark: str) -> bool:
        return any(
            mark in str(getattr(m, "content", ""))
            for inputs in _SHARED["inputs"]
            for m in inputs
        )

    check("B2d 软收尾指令已注入", _saw("步数即将耗尽"))
    check("B2e 硬收尾指令已注入", _saw("必须现在收尾"))
    insts = _SHARED["instances"]
    check("B2f 末跳解绑（硬收尾生效）", insts and not insts[-1].bound)
    check("B2g 末跳前正常绑定", all(i.bound for i in insts[:-1]))


async def test_b3_no_false_positive() -> None:
    print("B3：不误伤（同工具异参 + 正常收尾，零拦截）")
    script = [
        ("tool", "echo_probe", {"q": "1"}),
        ("tool", "echo_probe", {"q": "2"}),
        ("text", "两次结果不同，正常汇报。"),
    ]
    final, err = await _run(script, limit=40, seq=3)
    check("B3a 无异常", err is None)
    if final:
        tools = [m for m in final["messages"] if isinstance(m, ToolMessage)]
        check("B3b 两次都真执行", len([m for m in tools if str(m.content).startswith("echo:")]) == 2)
        check("B3c 无拦截产物", not any("循环" in str(m.content) for m in tools))
        guards = [e for e in _RECORDER.events if e[0] == "agent.loop_guard"]
        check("B3d 零 loop_guard 遥测", not guards)


async def test_b4_frontend_excluded() -> None:
    print("B4：前端调用不进循环账（直接 END 等浏览器）")
    script = [("tool", "canvas_ops", {"ops": []})]
    final, err = await _run(script, limit=40, seq=4)
    check("B4a 无异常", err is None)
    if final:
        msgs = final["messages"]
        check("B4b 一跳即 END", len(msgs) == 2, f"got {len(msgs)}")
        check("B4c 无合成拦截 Tool", not any(isinstance(m, ToolMessage) for m in msgs))


async def test_b5_mixed_call_not_intercepted() -> None:
    print("B5：混合调用（前端+后端同消息）走前端优先路由，不进循环账")
    # 混合调用本身违反宪法，但守卫必须不添乱：consec 只在纯后端路径计算，
    # 混合 → 前端优先 END（后端调用当轮不执行、模型下轮重发，既有语义）
    script = [("multi", [("canvas_ops", {"ops": []}), ("echo_probe", {"q": "x"})])]
    final, err = await _run(script, limit=40, seq=5)
    check("B5a 无异常", err is None)
    if final:
        msgs = final["messages"]
        tools = [m for m in msgs if isinstance(m, ToolMessage)]
        check("B5b 一跳即 END 等浏览器", len(msgs) == 2, f"got {len(msgs)}")
        check("B5c 零合成 Tool（不拦截不执行）", not tools)
        check("B5d 零 loop_guard 遥测",
              not [e for e in _RECORDER.events if e[0] == "agent.loop_guard"])


async def test_b6_multi_backend_violation() -> None:
    print("B6：多后端调用违规（第一个是重复）——只拦第一个，第二个由 sanitize 补占位")
    script = [
        ("tool", "echo_probe", {"q": "x"}),
        ("tool", "echo_probe", {"q": "x"}),
        ("multi", [("echo_probe", {"q": "x"}), ("echo_probe", {"q": "z"})]),
        ("text", "收到拦截，收尾。"),
    ]
    final, err = await _run(script, limit=40, seq=6)
    check("B6a 无异常收尾", err is None, f"{type(err).__name__}: {err}")
    if final is None:
        return
    msgs = final["messages"]
    tools = [m for m in msgs if isinstance(m, ToolMessage)]
    echoes = [m for m in tools if str(m.content) == "echo:x"]
    intercepts = [m for m in tools if "循环拦截" in str(m.content)]
    check("B6b 第 3 次同参被拦（只出 1 条拦截 Tool）", len(intercepts) == 1, f"got {len(intercepts)}")
    check("B6c 拦截 Tool 应答第一个调用（call_id 配对首个）",
          intercepts and intercepts[0].tool_call_id.endswith("_0"))
    check("B6d 真执行仍只有前两次", len(echoes) == 2, f"got {len(echoes)}")
    # 第二个调用（z）无 Tool 应答 → sanitize 补「本轮未执行」占位，交替不炸
    check("B6e 第二个调用由 sanitize 占位收口",
          "本轮未执行" in _model_inputs_text())
    check("B6f 正常文字收尾", isinstance(msgs[-1], AIMessage) and msgs[-1].content == "收到拦截，收尾。")


async def test_b8_stop_loss_then_new_run_recovers() -> None:
    print("B8：止损 END 后新 run 恢复正常（「临时禁用」只作用于当轮）")
    thread = "loop-guard-resume"
    script1 = [("tool", "echo_probe", {"q": "x"})] * 4 + [("text", "已收尾。")]
    final1, err1 = await _run(script1, limit=40, seq=8, thread=thread)
    check("B8a 首轮止损收尾", err1 is None and final1 is not None
          and isinstance(final1["messages"][-1], AIMessage))
    script2 = [("tool", "echo_probe", {"q": "fresh"}), ("text", "新任务完成。")]
    final2, err2 = await _run(script2, limit=40, seq=9, thread=thread)
    check("B8b 新 run 无异常", err2 is None, f"{type(err2).__name__}: {err2}")
    if final2 is None:
        return
    tools = [m for m in final2["messages"] if isinstance(m, ToolMessage)]
    check("B8c 新 run 工具正常绑定执行（echo:fresh 在场）",
          any(str(m.content) == "echo:fresh" for m in tools))
    insts = _SHARED["instances"]
    check("B8d 新 run 全跳绑定（尾部标记只影响自环交接瞬间）",
          insts and all(i.bound for i in insts))
    # 同 thread 的 state 保留首轮拦截 Tool——断言「没有新增」而非「不存在」
    def _guard_count(msgs):
        return sum(1 for m in msgs if isinstance(m, ToolMessage) and "循环" in str(m.content))
    check("B8e 新 run 零新增拦截", _guard_count(final2["messages"]) == _guard_count(final1["messages"]))


async def main() -> None:
    test_pure()
    await test_b1_loop_full_chain()
    await test_b2_graceful_close()
    await test_b3_no_false_positive()
    await test_b4_frontend_excluded()
    await test_b5_mixed_call_not_intercepted()
    await test_b6_multi_backend_violation()
    await test_b8_stop_loss_then_new_run_recovers()
    total = PASSED + len(FAILS)
    print(f"\n共 {total} 项，通过 {PASSED}，失败 {len(FAILS)}")
    if FAILS:
        for f in FAILS:
            print(f"  ✗ {f}")
        sys.exit(1)
    print("全绿 ✓")


if __name__ == "__main__":
    asyncio.run(main())
