"""Wingsight 画布助手 — LangGraph 主 Agent。

架构（参考 CopilotKit 官方 canvas 示例的 coagent 模式）：
- 前端工具（canvas_ops）经 RunAgentInput 注入，从 state["tools"] / state["copilotkit"].actions
  读取并 bind 到模型；模型发起调用后本轮结束（Command(goto=END)），由浏览器执行并把
  ToolMessage 带回下一轮。
- 后端工具（run_langflow_skill / list_langflow_skills）在 ToolNode 里执行。
- 画布 ground truth 走共享状态 canvasSummary（前端 useCoAgent setState 同步）。
"""

import base64
import json
import os
from pathlib import Path
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langchain.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.types import Command
from copilotkit import CopilotKitState
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
async def decompose_script(script: str, config: RunnableConfig) -> str:
    """把剧本拆解为资产清单（角色/场景/道具，含外形与视觉要点）。

    用户给出剧本（完整或片段）并想要资产卡/设定图时，先用这个工具拆解，
    再用 canvas_ops 把拆出的资产建成画布卡片，等用户确认增删。

    Args:
        script: 剧本原文（尽量完整传入，不要自行摘要）。
    """
    await skills._emit_progress(config, "正在拆解剧本，提取角色 / 场景 / 道具清单…")
    return await skills.decompose_script(script)


@tool
async def run_langflow_skill(
    skill: str, input_text: str, params_json: str, config: RunnableConfig
) -> str:
    """调用一个 Langflow 技能（预置生成管线）并返回其文本结果。

    Args:
        skill: 技能名（先用 list_langflow_skills 查可用技能与参数）。
        input_text: 传给技能的主输入（如剧本片段、补充说明）。
        params_json: 技能参数，JSON 对象字符串，如 {"platform":"抖音","count":6}；
            只能使用技能清单里声明的参数，不需要时留空。
    """
    await skills._emit_progress(config, f"正在调用技能「{skill}」，生成中…")
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
async def generate_asset_images(assets_json: str, config: RunnableConfig) -> str:
    """为资产批量生成设定图（并发出图，每张完成会实时推送进度到聊天）。

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
    return await skills.generate_asset_images(assets, config=config)


backend_tools = [list_langflow_skills, decompose_script, generate_asset_images, run_langflow_skill]
backend_tool_names = {t.name for t in backend_tools}

# 允许模型调用的前端工具白名单（防止客户端注入无关工具）
FRONTEND_TOOL_ALLOWLIST = {"canvas_ops"}


# ---------- 多模态附件（图片/视频随消息上传） ----------

# 视觉模型名探测（AGENT_VISION_ENABLED=1/0 可强制覆盖）。
# deepseek-chat 等纯文本模型收到 image_url 块会 400，必须在净化阶段剥离。
_VISION_MODEL_HINTS = (
    "vl", "vision", "4v", "gpt-4o", "gpt-4.1", "o3", "o4",
    "gemini", "claude", "pixtral", "internvl",
)


def _vision_enabled() -> bool:
    explicit = (os.environ.get("AGENT_VISION_ENABLED") or "").strip().lower()
    if explicit:
        return explicit in ("1", "true", "yes", "on")
    model = (os.environ.get("AGENT_MODEL") or "deepseek-chat").lower()
    return any(h in model for h in _VISION_MODEL_HINTS)


_MEDIA_BLOCK_LABELS = {
    "image_url": "图片",
    "image": "图片",
    "video": "视频",
    "audio": "音频",
    "file": "文件",
}


def _flatten_media_message(m: Any) -> Any:
    """纯文本模型视图：content 块数组 → 纯文本（媒体块降级成 URL 清单）。

    不原地改消息（state 里持有引用），返回替换后的新 HumanMessage；
    URL 已在文本里出现时不重复罗列。视觉模型路径不经过此函数。
    """
    texts: List[str] = []
    media: List[str] = []
    for b in m.content if isinstance(m.content, list) else []:
        if not isinstance(b, dict):
            continue
        btype = str(b.get("type", ""))
        if btype == "text" and isinstance(b.get("text"), str):
            texts.append(b["text"])
        elif btype in _MEDIA_BLOCK_LABELS:
            url = b.get("url") or (b.get("image_url") or {}).get("url") or ""
            media.append(f"{_MEDIA_BLOCK_LABELS.get(btype, '媒体')} {url}".strip())
    joined = "\n".join(t for t in texts if t)
    # 文本里已有的 URL 不重复罗列（前端消息本身就带附件清单）
    extra = [line for line in media if not (line.rsplit(" ", 1)[-1] and line.rsplit(" ", 1)[-1] in joined)]
    if extra:
        joined = "\n".join(
            [
                p
                for p in (
                    joined,
                    "【用户附件（当前模型为纯文本，仅 URL 可用）】",
                    *(f"- {x}" for x in extra),
                )
                if p
            ]
        )
    return HumanMessage(content=joined or "（附件消息）", id=getattr(m, "id", None))


# 视觉模型路径：本地附件嵌入（模型服务器够不着 /agent-service/assets/ 的本机路径，
# 必须转成 base64 data URL；DeepSeek 视觉接口只收静态图，视频/音频块剔除）
_LOCAL_ASSET_PREFIX = "/agent-service/assets/"
_ASSET_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_EMBED_IMAGE_MAX = 16 * 1024 * 1024  # API 单图上限 32MiB，留余量


def _local_asset_to_data_url(url: str) -> str | None:
    name = Path(url).name
    mime = _ASSET_IMAGE_MIME.get(Path(name).suffix.lower())
    if not mime:
        return None
    try:
        data = (skills.ASSETS_DIR / name).read_bytes()
    except OSError:
        return None
    if not data or len(data) > _EMBED_IMAGE_MAX:
        return None
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def _embed_local_media(m: Any) -> Any:
    """视觉模型视图：本地图片 URL → data URL；公网 URL / data URL 原样保留。

    视频/音频/文件块剔除（接口不收，文本清单里已有 URL 可供工具引用）。
    无任何可保留内容时退回纯文本视图。
    """
    blocks_out: List[Any] = []
    for b in m.content if isinstance(m.content, list) else []:
        if not isinstance(b, dict):
            continue
        btype = str(b.get("type", ""))
        if btype == "text":
            blocks_out.append(b)
        elif btype == "image_url":
            url = (b.get("image_url") or {}).get("url", "")
            if url.startswith("data:image/"):
                blocks_out.append(b)
            elif url.startswith(_LOCAL_ASSET_PREFIX):
                data_url = _local_asset_to_data_url(url)
                if data_url:
                    blocks_out.append(
                        {"type": "image_url", "image_url": {"url": data_url}}
                    )
            elif url.startswith(("http://", "https://")):
                blocks_out.append(b)
            # 其他来源丢弃（清单里已有 URL）
    if not blocks_out:
        return _flatten_media_message(m)
    return HumanMessage(content=blocks_out, id=getattr(m, "id", None))


# ---------- 系统提示 ----------

SYSTEM_PROMPT = """你是 Wingsight Studio 的画布助手，帮助创作者在无限画布上进行影视创作（剧本、角色、分镜、设定图）。

## 画布当前状态（ground truth，以此为准，忽略聊天历史里的旧状态）
{canvas_summary}

## 操作画布
调用前端工具 canvas_ops，参数 ops 是操作数组，一次可以批量执行多项：
- {{"op":"add_node","nodeType":"note|script|character|image|video|audio|compose|storyboard","title":"标题","body":"正文","position":{{"x":0,"y":0}}}}  新建卡片（position 可省略，会自动布局；image/video/audio 可带 imageUrl/videoUrl/audioUrl）
- {{"op":"update_node","id":"节点id","title":"新标题","body":"新正文"}}  更新卡片
- {{"op":"delete_nodes","ids":["节点id",...]}}  删除卡片
- {{"op":"connect_nodes","fromId":"节点id","toId":"节点id"}}  连线（方向：from → to）
- {{"op":"group_nodes","ids":["节点id",...],"title":"分组名"}}  把多张卡收进一个分组框（如整场戏的分镜归拢）
- {{"op":"set_viewport","x":0,"y":0,"zoom":1}}  移动画布视野

audio（音频）卡：配音 / 音效 / BGM，音频源由用户在卡片上上传（audioUrl），你只负责建卡与连线。
compose（合成）卡：把多张视频卡按顺序连线到它，用户点卡片上的「合成成片」按钮由服务端 ffmpeg 拼接——
你只负责建 compose 卡并 connect_nodes 把视频按镜号顺序连上，不要自己生成合成结果。

storyboard（分镜）卡：title=镜头名，body=画面描述（谁、在哪、做什么），
add_node / update_node 可带 shotNumber（镜号，如 01）、shotSize（远景/全景/中景/近景/特写）、
cameraMove（运镜，如 推、拉、摇、跟、固定）、duration（如 3s）、dialogue（台词/旁白）。
用户要求分镜/故事板时为每个镜头建一张 storyboard 卡并按顺序连线（镜号从 01 递增）。

节点 id 形如 n_xxx_x，可以在「画布当前状态」里查到。新建后若要连线，先等工具结果返回新节点 id。

## 生成管线（Langflow 技能）
涉及批量生成（宣发文案等）时，先用 list_langflow_skills 查可用技能，再用 run_langflow_skill 调用。

## 卡片输入条的直接生成请求（@引用）
用户会在图片/视频卡的输入条上直接发起生成，消息会指明目标节点 id，并可能附「严格参考以下画布卡片」清单（@节点id + 内容摘要）。处理方式：
1. 前端已把目标卡置为 loading，你负责生成与回填，不要重复置 loading。
2. 引用清单里的描述（角色外形/服装/场景细节）必须并入生成 prompt 保持一致；需要全文时用 read_node 取。
3. 图片：调 generate_asset_images（单资产数组即可，name=卡片标题，description 写完整画面 prompt，引用卡的角色/场景描述并入 visual_notes），
   拿到 image_url 后用 canvas_ops update_node 回填 {{imageUrl, status:"ready"}}。
4. 视频：当前没有视频生成管线——如实说明，并把节点置为 {{status:"error", errorMessage:"暂不支持 AI 生成视频，可点击卡片上传本地视频"}}。
5. 任何失败都要回填 {{status:"error", errorMessage:原因}}，绝不让卡片停在 loading。

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

## 长镜头 / 多段动作计划
用户要求"长镜头计划"或描述一段含多个动作节拍的连续戏时：按动作节拍拆成多张 storyboard 卡——
镜号用同一镜号加段号（如 03a/03b/03c），每段 duration 2-5 秒，body 写该段的画面描述与节拍动作，
整镜的 cameraMove 保持一致（保证镜头连续性），按时间顺序 connect_nodes 相邻连线。
用户在分镜卡上会用「导演台」补摄影语言（body 的【摄影】段），尊重它，不要改写。

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
    """清洗历史，保证模型侧永不 400：

    - assistant(tool_calls) ↔ tool 的合法交替：孤儿 tool 消息剔除、
      assistant 的 tool_call 缺响应时补占位响应
    - 纯文本模型：content 为多模态块数组的用户消息降级成纯文本
      （媒体块 → URL 清单，见 _flatten_media_message）
    """
    flatten_media = not _vision_enabled()
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
            if isinstance(m, HumanMessage) and isinstance(m.content, list):
                result.append(
                    _flatten_media_message(m)
                    if flatten_media
                    else _embed_local_media(m)
                )
            else:
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

# 聊天会话持久化（AsyncSqliteSaver：重启不丢对话）。
# 它的构造需要运行中的事件循环，而 graph 在模块级编译——用惰性代理：
# 首次在请求事件循环内使用时才真正创建并建表。
import aiosqlite
import threading

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


class _LazyAsyncSaver(BaseCheckpointSaver):
    """模块级占位；async 方法首次调用时在当前事件循环内初始化真身。

    继承 BaseCheckpointSaver 以通过 langgraph.compile 的类型校验；
    同步接口（get_tuple/put/...）不实现，本图全异步运行。"""


    def __init__(self, db_path: str):
        self._db_path = db_path
        self._saver: AsyncSqliteSaver | None = None

    async def _ensure(self) -> AsyncSqliteSaver:
        if self._saver is None:
            saver = AsyncSqliteSaver(aiosqlite.connect(self._db_path))
            await saver.setup()
            self._saver = saver
        return self._saver

    # 显式覆写（基类默认实现抛 NotImplementedError，__getattr__ 拦不住）
    async def aget_tuple(self, config, *args, **kwargs):
        return await (await self._ensure()).aget_tuple(config, *args, **kwargs)

    async def aput(self, config, checkpoint, metadata, new_versions, *args, **kwargs):
        return await (await self._ensure()).aput(
            config, checkpoint, metadata, new_versions, *args, **kwargs
        )

    async def aput_writes(self, config, writes, task_path, *args, **kwargs):
        return await (await self._ensure()).aput_writes(
            config, writes, task_path, *args, **kwargs
        )

    async def adelete_thread(self, thread_id, *args, **kwargs):
        return await (await self._ensure()).adelete_thread(thread_id, *args, **kwargs)

    async def alist(self, config, *args, **kwargs):
        saver = await self._ensure()
        async for item in saver.alist(config, *args, **kwargs):
            yield item


CHECKPOINT_DB = str(Path(__file__).resolve().parent / "data" / "checkpoints.db")
Path(CHECKPOINT_DB).parent.mkdir(parents=True, exist_ok=True)
# 触发 DB 文件占位，避免首次并发请求竞争创建
threading.Event()
checkpointer = _LazyAsyncSaver(CHECKPOINT_DB)
graph = workflow.compile(checkpointer=checkpointer)
