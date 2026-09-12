# -*- coding: utf-8 -*-
"""隔离子代理回归（2026-09-12 P2，无 LLM——子代理模型打桩，工具真跑）。

delegate_task = 干净上下文 + 只读工具白名单（read_skill / read_canvas）+
有界内部循环（超步数解绑收尾，镜像主图 hard_close），只把最终报告带回
主对话。价值点（doc/harness-gap 第三档 #9）：长阅读隔离 / 干净视角审查 /
干跑-执行分离（执行留在主循环——canvas_ops 是前端工具）。

跑法：cd agent && uv run python test_subagent.py
"""
import asyncio
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode

import graph as graph_mod
import projects

# 测试库隔离：projects 模块 DB_PATH 指临时文件（test_ref_report.py 同款手法）
_TMP_DB = Path(tempfile.mkdtemp(prefix="subagent-test-")) / "test.db"
projects.DB_PATH = _TMP_DB
projects.init_db()

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


# ---------- 子代理假模型 ----------

_SHARED: dict = {"script": [], "calls": [], "binds": 0}
_SUB_SYSTEM_HEAD = graph_mod._SUBAGENT_SYSTEM[:12]


class _FakeSubModel:
    """按脚本吐响应的假 ChatOpenAI（子代理通道）。

    脚本条目：("tool", name, args) / ("text", s)。每次 ainvoke 弹一条；
    全部输入与绑定调用都记录进 _SHARED 供断言。"""

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        _SHARED["binds"] += 1
        return self

    async def ainvoke(self, msgs, config=None, **kwargs):  # noqa: ARG002
        _SHARED["calls"].append(list(msgs))
        item = _SHARED["script"].pop(0)
        if item[0] == "tool":
            return AIMessage(
                content="",
                tool_calls=[{"name": item[1], "args": item[2],
                             "id": f"sc_{len(_SHARED['calls'])}", "type": "tool_call"}],
            )
        return AIMessage(content=item[1])


class _EventRecorder:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def track(self, name: str, payload: dict | None = None, **kw):  # noqa: ARG002
        self.events.append((name, payload or {}))


_RECORDER = _EventRecorder()
_REAL_CTOR = graph_mod.ChatOpenAI
_REAL_MAIN_CTOR = graph_mod._OneShotToolArgsCompatChatOpenAI
_REAL_EVENTS = graph_mod.events


def _install() -> None:
    _SHARED["script"] = []
    _SHARED["calls"] = []
    _SHARED["binds"] = 0
    graph_mod.ChatOpenAI = lambda **kw: _FakeSubModel()
    graph_mod.events = _RECORDER
    _RECORDER.events.clear()


def _restore() -> None:
    graph_mod.ChatOpenAI = _REAL_CTOR
    graph_mod._OneShotToolArgsCompatChatOpenAI = _REAL_MAIN_CTOR
    graph_mod.events = _REAL_EVENTS


async def _delegate(task: str, context: str = "", config: dict | None = None) -> str:
    # 直调真循环函数（delegate_task 工具层的接线由 S8 经 ToolNode 覆盖）；
    # .ainvoke 走 schema 会把 RunnableConfig 注解的 config 参数排除掉
    return await graph_mod._run_subagent(task, context, config or {})


async def test_s_core() -> None:
    print("S1-S3：干净上下文 / 工具链 / 未知工具")
    _install()
    try:
        _SHARED["script"] = [("text", "审查意见。")]
        report = await _delegate(
            "审查下面的文案", context="这是主对话里的素材：孝庄太后年轻时……"
        )
        # S1 干净上下文：首调输入只有 system + task/context，无主对话历史
        first = _SHARED["calls"][0]
        check("S1a 子代理独立 system 提示", len(first) == 2
              and isinstance(first[0], SystemMessage)
              and str(first[0].content).startswith("你是被主助手委派"))
        human = str(first[1].content)
        check("S1b 任务与材料注入", "审查下面的文案" in human and "孝庄太后" in human)
        check("S1c 无主对话泄漏（非任务内容不进）",
              "main conversation" not in human and len(first) == 2)

        # S2 工具链：read_canvas（无项目态）→ read_skill（真手册）→ 报告
        _SHARED["calls"] = []
        _SHARED["script"] = [
            ("tool", "read_canvas", {}),
            ("tool", "read_skill", {"name": "script-to-assets"}),
            ("text", "结论：应先拆资产再出图。报告完。"),
        ]
        report = await _delegate("按手册与画布给计划")
        calls = _SHARED["calls"]
        check("S2a 三跳两次工具", len(calls) == 3)
        tmsgs = [m for inputs in calls for m in inputs if isinstance(m, ToolMessage)]
        check("S2b read_canvas 无项目态返回", any("没有关联项目" in str(m.content) for m in tmsgs))
        check("S2c read_skill 真读手册", any("第 1 站" in str(m.content) for m in tmsgs))
        check("S2d 报告原样带回", report == "结论：应先拆资产再出图。报告完。")
        evts = [e for e in _RECORDER.events if e[0] == "agent.subagent"]
        check("S2e 遥测 tools=2", evts and evts[-1][1].get("tools") == 2, f"{evts}")

        # S3 未知工具：错误串回给子代理，循环继续
        _SHARED["calls"] = []
        _SHARED["script"] = [
            ("tool", "canvas_ops", {"ops": []}),
            ("text", "收到限制说明。"),
        ]
        report = await _delegate("试着改画布")
        tmsgs = [m for m in _SHARED["calls"][1] if isinstance(m, ToolMessage)]
        check("S3a 未知工具被拒并给白名单", any("未知工具 canvas_ops" in str(m.content)
              and "read_canvas" in str(m.content) for m in tmsgs))
        check("S3b 子代理继续到文本收尾", report == "收到限制说明。")
    finally:
        _restore()


async def test_s4_forced_close() -> None:
    print("S4：步数耗尽 → 解绑收尾（镜像主图 hard_close）")
    _install()
    try:
        _SHARED["script"] = [("tool", "read_canvas", {})] * graph_mod._SUBAGENT_MAX_STEPS
        _SHARED["script"] += [("text", "被迫收尾的报告。")]
        report = await _delegate("反复读画布")
        check("S4a 收到解绑后的最终报告", report == "被迫收尾的报告。")
        calls = _SHARED["calls"]
        check("S4b 恰好 MAX_STEPS+1 次模型调用",
              len(calls) == graph_mod._SUBAGENT_MAX_STEPS + 1, f"got {len(calls)}")
        last = calls[-1]
        check("S4c 收尾提醒注入", any(
            isinstance(m, HumanMessage) and "步数或时限已到" in str(m.content)
            for m in last))
        check("S4d 死线检查不产生无应答调用（交替合法）", isinstance(last[-1], HumanMessage))
        evts = [e for e in _RECORDER.events if e[0] == "agent.subagent"]
        check("S4e forced_close 遥测", evts and evts[-1][1].get("forced_close") is True)
    finally:
        _restore()


async def test_s5_report_cap() -> None:
    print("S5：报告超长显式截断（不静默）")
    _install()
    try:
        _SHARED["script"] = [("text", "长" * (graph_mod._SUBAGENT_REPORT_CAP + 500))]
        report = await _delegate("写长文")
        check("S5a 截断标记在场", "报告超长已截断" in report)
        check("S5b 长度受控", len(report) <= graph_mod._SUBAGENT_REPORT_CAP + 60,
              f"len={len(report)}")
    finally:
        _restore()


def test_s6_guards() -> None:
    print("S6：结构防护与注册")
    tools_map = graph_mod._build_subagent_tools({})
    check("S6a 白名单恰为两个只读工具",
          set(tools_map.keys()) == {"read_skill", "read_canvas"}, f"{sorted(tools_map)}")
    check("S6b 递归防护：白名单无 delegate_task", "delegate_task" not in tools_map)
    check("S6c delegate_task 已注册后端工具", "delegate_task" in graph_mod.backend_tool_names)
    check("S6d 白名单工具不在主图注册（子代理专属 read_canvas）",
          "read_canvas" not in graph_mod.backend_tool_names)
    check("S6e 步数/死线常量合理",
          graph_mod._SUBAGENT_MAX_STEPS == 8 and graph_mod._SUBAGENT_DEADLINE_S >= 60)


async def test_s7_canvas_digest() -> None:
    print("S7：画布真值摘要（服务端权威副本）")
    pid = ""
    try:
        pid = projects.create_project(name=f"subagent-test-{int(time.time())}")["id"]
        nodes = [
            {"id": "n_a", "type": "canvasNode", "data": {"nodeType": "character", "title": "冯太后", "imageUrl": "http://x/1.jpg"}},
            {"id": "n_b", "type": "canvasNode", "data": {"nodeType": "scene", "title": "御书房"}},
            {"id": "n_c", "type": "canvasNode", "data": {"nodeType": "shotlist", "title": "分镜表", "rows": [{"rid": "r1"}]}},
        ]
        edges = [{"id": "e1", "source": "n_a", "target": "n_b"}]
        projects.save_canvas(pid, nodes, edges, {"x": 0, "y": 0, "zoom": 1},
                              {"projectStyle": "写实影视", "era": "北魏·平城"})
        th = projects.create_thread(pid, tid=f"subthr{int(time.time())}")
        digest = graph_mod._subagent_canvas_digest(pid)
        check("S7a 节点行含 id/类型/标题", "id=n_a" in digest and "character" in digest and "冯太后" in digest)
        check("S7b 无图资产标记", "id=n_b" in digest and "无图" in digest)
        check("S7c 分镜行计数", "分镜1行" in digest)
        check("S7d 连线清单", "n_a→n_b" in digest)
        check("S7e meta 行（画风/时代）", "写实影视" in digest and "北魏·平城" in digest)
        # 经 config → thread → project 的完整链
        _install()
        try:
            _SHARED["calls"] = []
            _SHARED["script"] = [("tool", "read_canvas", {}), ("text", "读到画布。")]
            await _delegate("读画布", config={"configurable": {"thread_id": th["id"]}})
            tmsgs = [m for m in _SHARED["calls"][1] if isinstance(m, ToolMessage)]
            check("S7f 经会话映射读到真画布", any("冯太后" in str(m.content) for m in tmsgs))
        finally:
            _restore()
    finally:
        if pid:
            projects.delete_project(pid)


_MAIN_INPUTS: list[list] = []


class _FakeMainModel:
    """主图假模型：delegate_task 调用 → 收到报告后文本收尾。记录每跳输入。"""

    def __init__(self, **kwargs):  # noqa: ARG002
        self.bound = False

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        self.bound = True
        return self

    async def astream(self, msgs, config):  # noqa: ARG002
        _MAIN_INPUTS.append(list(msgs))
        if not self.bound:
            yield AIMessageChunk(content="（禁用收尾）")
            return
        global _MAIN_STEP
        if _MAIN_STEP == 0:
            _MAIN_STEP += 1
            yield AIMessageChunk(content="", tool_calls=[{
                "name": "delegate_task", "args": {"task": "审查画布一致性"},
                "id": "mc_1", "type": "tool_call"}])
        else:
            yield AIMessageChunk(content="审查已完成并汇报。")


_MAIN_STEP = 0


async def test_s8_graph_wiring() -> None:
    print("S8：图级接线（主模型委派 → ToolNode 真跑 delegate_task → 报告回主对话）")
    global _MAIN_STEP
    _MAIN_STEP = 0
    _MAIN_INPUTS.clear()
    _install()
    graph_mod._OneShotToolArgsCompatChatOpenAI = lambda **kw: _FakeMainModel()
    _SHARED["script"] = [("text", "【子代理报告】画布一致性 OK。")]
    try:
        wf = StateGraph(graph_mod.AgentState)
        wf.add_node("chat_node", graph_mod.chat_node)
        wf.add_node("tool_node", ToolNode(graph_mod.backend_tools))
        wf.add_edge("tool_node", "chat_node")
        wf.set_entry_point("chat_node")
        g = wf.compile(checkpointer=MemorySaver())
        final = await g.ainvoke(
            {"messages": [HumanMessage(content="帮我审查一下画布")]},
            config={"configurable": {"thread_id": "sub-wire-1"}, "recursion_limit": 20},
        )
        msgs = final["messages"]
        tools = [m for m in msgs if isinstance(m, ToolMessage)]
        check("S8a delegate_task 经 ToolNode 真执行", any(
            "子代理" in str(m.content) or "【子代理报告】" in str(m.content) for m in tools))
        check("S8b 报告进入主对话并文本收尾",
              isinstance(msgs[-1], AIMessage) and msgs[-1].content == "审查已完成并汇报。")
        second_input_text = "\n".join(str(getattr(m, "content", "")) for m in _MAIN_INPUTS[1])
        check("S8c 主模型第二跳收到报告、未见子代理过程",
              "【子代理报告】" in second_input_text
              and "你是被主助手委派" not in second_input_text)
        check("S8d 子代理首调输入不含主对话（隔离）",
              len(_SHARED["calls"][0]) == 2)
    finally:
        _restore()


async def main() -> None:
    await test_s_core()
    await test_s4_forced_close()
    await test_s5_report_cap()
    test_s6_guards()
    await test_s7_canvas_digest()
    await test_s8_graph_wiring()
    total = PASSED + len(FAILS)
    print(f"\n共 {total} 项，通过 {PASSED}，失败 {len(FAILS)}")
    if FAILS:
        for f in FAILS:
            print(f"  ✗ {f}")
        sys.exit(1)
    print("全绿 ✓")


if __name__ == "__main__":
    asyncio.run(main())
