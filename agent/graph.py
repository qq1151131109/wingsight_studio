"""Wingsight 画布助手 — LangGraph 主 Agent。

架构（参考 CopilotKit 官方 canvas 示例的 coagent 模式）：
- 前端工具（canvas_ops）经 RunAgentInput 注入，从 state["tools"] / state["copilotkit"].actions
  读取并 bind 到模型；模型发起调用后本轮结束（Command(goto=END)），由浏览器执行并把
  ToolMessage 带回下一轮。
- 后端工具（run_langflow_skill / list_langflow_skills）在 ToolNode 里执行。
- 画布 ground truth 走共享状态 canvasSummary（前端 useCoAgent setState 同步）。
"""

import base64
import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterator, List

from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langchain.tools import tool
from langgraph.graph import END, StateGraph
from langgraph.types import Command
from copilotkit import CopilotKitState
from langgraph.prebuilt import ToolNode

import camera
import imgresearch
import models
import projects
import research
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
    job_id = skills.start_chat_job(
        skills._thread_id_of_config(config), "tool", "拆解剧本"
    )
    task = asyncio.current_task()
    if task is not None:
        skills.job_attach_task(job_id, task)
    return await skills.decompose_script(script)


@tool
async def generate_storyboard(
    script: str,
    config: RunnableConfig,
    shot_count: int = 0,
    assets_json: str = "",
    model: str = "",
) -> str:
    """从剧本生成整表分镜（结构化 rows：景别/运镜/时长/画面/光影/音效/台词/引用资产）。

    用户要「拆分镜表 / 生成分镜表 / 重新分镜 / 整表重写到 N 镜」时用这个工具；
    不要自己手写整表 rows（管线输出的字段规范与镜头语言质量都更好）。
    生成完写回画布：画布已有分镜表卡（画布状态里的 [分镜表] 行）用 canvas_ops
    update_node(id=分镜表id, rows=...) 整组替换；没有分镜表卡则 add_node
    nodeType=shotlist 带 rows 新建。整表分镜不要为每个镜头铺独立 storyboard 卡
    （storyboard 卡只用于单个镜头的画面卡）。

    Args:
        script: 剧本原文全文（从剧本卡取时先 read_node，不要自行摘要）。
        shot_count: 目标镜头数，用户点名了才传（如「压到 20 镜」），0=按剧本自定。
        assets_json: 画布已有资产名单 JSON 数组，如 [{"type":"character","name":"郑成功"}]；
            生成的行会自动引用名单内资产（名单外的幻觉名会被剔除）。画布没有资产卡时留空。
        model: 文本模型 id（GET /models/text 目录），留空用默认 gpt-5.6-luna。
    """
    assets = None
    if assets_json.strip():
        try:
            assets = json.loads(assets_json)
            if not isinstance(assets, list):
                return "assets_json 必须是数组 JSON"
        except json.JSONDecodeError as e:
            return f"assets_json 不是合法 JSON：{e}"
    await skills._emit_progress(config, "正在生成分镜表（分镜管线约 1-2 分钟）…")
    job_id = skills.start_chat_job(
        skills._thread_id_of_config(config), "tool", "生成分镜表"
    )
    task = asyncio.current_task()
    if task is not None:
        skills.job_attach_task(job_id, task)
    try:
        rows = await skills.run_storyboard_flow(
            script,
            shot_count=shot_count or None,
            assets=assets,
            model=model,
        )
    except Exception as e:  # noqa: BLE001
        return f"分镜生成失败：{e}"
    return (
        f"分镜已生成（{len(rows)} 行）。rows JSON：\n"
        + json.dumps(rows, ensure_ascii=False)
        + '\n写回：画布已有 [分镜表] 卡 → canvas_ops update_node(id, rows=上述数组)；'
        '没有 → add_node(nodeType="shotlist", rows=上述数组)。行里的 assets 资产名数组写回时保留，系统会解析成对画布资产卡的引用。'
    )


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
    job_id = skills.start_chat_job(
        skills._thread_id_of_config(config), "tool", f"技能「{skill}」"
    )
    task = asyncio.current_task()
    if task is not None:
        skills.job_attach_task(job_id, task)
    return await skills.run_skill(skill, input_text, params)


@tool
async def generate_asset_images(
    assets_json: str, config: RunnableConfig, model: str = "", resolution: str = ""
) -> str:
    """为资产批量生成设定图（并发出图，每张完成会实时推送进度到聊天）。

    用户确认资产清单后要求出图时调用。输入是资产数组 JSON，每个元素：
    {"type":"character|scene|prop|shot","name":"...","description":"...","visual_notes":"...","search_query":"可公开搜索的参考词","aspect":"9:16"}
    （字段与 decompose_script 的输出一致；type=shot 是镜头剧照布局——
    有人物有剧情的单幅画面，分镜/镜头类出图用 shot 而不是 scene）。
    aspect 可选画幅（w:h：16:9/9:16/1:1/4:3/3:4/21:9）：用户对画幅有要求
    （竖版/横版/方图/宽幕）或重出带「画幅 N」标注的卡时传；不传按类型
    默认幅面。reference_images 可选（字符串数组）：一致性参考图的
    /agent-service/assets/ URL（从画布摘要里取带图卡的 imageUrl），配合
    reference_labels（[{type,name}]，type=character 时锁身份不继承白底
    排版）——用户要求「按某角色的设定图出」「保持形象一致」时必须带上。
    返回每个资产的成败与 image_url。
    用户点名要换出图模型/清晰度时才传 model / resolution；可用的模型
    与各模型支持档位：
    {"gpt-image-2-03": ["1K","2K","4K"], "doubao-seedream-4-0-250828": ["1K","2K","4K"], "doubao-seedream-4-5-251128": ["2K","4K"], "doubao-seedream-5-0-pro-260628": ["1K","2K"]}
    seedream-5-0-pro 是多图融合模型：多张参考图合成一张（如「图1 的人物
    穿上图2 的服装」），用户要求融合/组合多张参考图时优先选它。

    Args:
        assets_json: 资产数组 JSON 文本。
        model: 出图模型 id（上表之一），留空用默认 gpt-image-2-03。
        resolution: 清晰度档位（1K/2K/4K，须在该模型支持列表内），留空用模型默认。
    """
    try:
        assets = json.loads(assets_json)
        if not isinstance(assets, list):
            return "assets_json 必须是资产数组 JSON"
    except json.JSONDecodeError as e:
        return f"assets_json 不是合法 JSON：{e}"
    params = None
    if model.strip() or resolution.strip():
        try:
            params = models.resolve_imagegen_params(
                {"model": model, "resolution": resolution}
            )
        except ValueError as e:
            return str(e)
    return await skills.generate_asset_images(assets, config=config, params=params)


@tool
async def research_asset_references(assets_json: str, config: RunnableConfig) -> str:
    """为画布资产批量调研网络参考图（AI 出词 → 豆包搜图 + Wikimedia → 模型看图终选）。

    用户想给角色/场景/道具/服饰找考据参考图、历史画像、实物照片时调用；
    历史纪实类题材出图前先调研能显著提升形制/材质一致性。纯虚构或动画
    风格、用户明确不需要参考时不要调用。不要在用户没要求时自作主张调研。

    node_id 必须取自画布摘要（每行行首的节点 id），画布上没有该资产时
    先用 canvas_ops 建卡、下一轮再调研。后台串行执行：每个资产约 1-2 分钟，
    发起后立即返回，用 get_reference_research_status 查进度；完成后提示
    用户打开资产卡的「找参考图」面板勾选采纳（采纳后「补资产图」批量出图
    会自动带上参考图）。

    Args:
        assets_json: 资产数组 JSON 文本，每个元素：
            {"node_id":"画布节点id","name":"资产名","type":"character|scene|prop|costume","description":"设定描述（外形/朝代/材质越具体越好）"}
    """
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    if not thread_id:
        return "无法定位当前项目：会话上下文缺少 thread_id"
    pid = projects.project_id_of_thread(thread_id)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    try:
        assets = json.loads(assets_json)
        if not isinstance(assets, list):
            return "assets_json 必须是数组 JSON"
    except json.JSONDecodeError as e:
        return f"assets_json 不是合法 JSON：{e}"
    parsed = []
    for a in assets:
        if not isinstance(a, dict):
            continue
        node_id = str(a.get("node_id") or "").strip()
        name = str(a.get("name") or "").strip()
        if not node_id or not name:
            continue
        parsed.append(
            {
                "nodeId": node_id,
                "name": name,
                "type": str(a.get("type") or "character"),
                "description": str(a.get("description") or ""),
            }
        )
    if not parsed:
        return "assets_json 缺少有效项：每项需要 node_id 与 name"
    # 节点存在性校验（防幻觉 id）：画布上不存在的节点直接点名拒绝
    canvas = projects.load_canvas(pid)
    node_ids = {str(n.get("id") or "") for n in (canvas or {}).get("nodes", [])}
    missing = [a["name"] for a in parsed if a["nodeId"] not in node_ids]
    if missing:
        return (
            f"画布上找不到这些资产卡：{('、'.join(missing))[:120]}。"
            "请核对画布摘要里的节点 id（先建卡再调研）"
        )
    batch_id = imgresearch.start_batch_research(pid, parsed)
    names = "、".join(a["name"] for a in parsed)[:120]
    est_min = max(1, -(-len(parsed) // 100) * 4)
    return (
        f"已发起 {len(parsed)} 个资产（{names}）的参考图调研，后台 100 路并发执行"
        f"预计约 {est_min} 分钟。batch_id={batch_id}。"
        "用 get_reference_research_status 查询进度；完成后提醒用户在资产卡上"
        "打开「找参考图」面板勾选采纳，采纳后可用「补资产图」批量出图。"
    )


@tool
async def get_reference_research_status(batch_id: str, config: RunnableConfig) -> str:
    """查询参考图调研任务的进度与结果摘要。

    发起 research_asset_references 后用户问进度/是否完成时调用；任务完成后
    返回每个资产的候选数与模型推荐，提醒用户到资产卡面板勾选采纳。

    Args:
        batch_id: research_asset_references 返回的任务 id。
    """
    batch = imgresearch.get_batch_research_job(batch_id.strip())
    if batch is None:
        return "调研任务不存在（agent 可能已重启，请重新发起）"
    lines = [f"进度 {batch['done']}/{batch['total']}，状态 {batch['status']}："]
    for item in batch["items"]:
        line = f"- {item['name']}：{item['status']}"
        if item.get("error"):
            line += f"（{item['error'][:80]}）"
        lines.append(line)
    if batch["status"] == "done":
        summaries = []
        for item in batch["items"]:
            if item["status"] != "done":
                continue
            cands = imgresearch.list_candidates(batch["projectId"], item["nodeId"])
            rec = [c["title"] for c in cands if c["recommended"]]
            if rec:
                summaries.append(
                    f"{item['name']}：候选 {len(cands)} 张，推荐 {len(rec)} 张"
                    f"（{'、'.join(t[:20] for t in rec[:3])}）"
                )
            elif cands:
                summaries.append(f"{item['name']}：候选 {len(cands)} 张，无强推荐，建议用户自行挑选")
        lines.extend(summaries)
        lines.append("请提醒用户：打开资产卡的「找参考图」面板勾选采纳，采纳后「补资产图」会带上参考图。")
    return "\n".join(lines)


@tool
async def start_deep_research(
    topic: str, brief: str, depth: str, config: RunnableConfig
) -> str:
    """就一个题材/问题发起深度调研（多轮 Google 搜索取证 → 结构化调研卷宗）。

    用户要选题论证、背景资料、史实核实、人物/事件深挖时调用（「帮我调研X」
    「查查X的资料」「X到底是怎么回事」）；闲聊、画布内已有答案、找参考图
    （那是 research_asset_references）时不要调用。

    本工具只做开题：返回观看问题与查证方向。请把开题讲给用户听（这个题材最值
    得讲什么、什么有据、什么是传闻），请其确认或修改方向；用户确认后立即调用
    confirm_research_plan 开始执行。用户明确说「直接开始/别问了」时无需再问，
    直接 confirm。

    Args:
        topic: 调研主题（一句话，具体到人名/事件/时间段越好）。
        brief: 导演的补充侧重（关注什么、给谁看、避开什么），可空。
        depth: quick=快查(1轮) / standard=标准(2轮) / deep=深挖(4轮)，缺省 standard。
    """
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    if not thread_id:
        return "无法定位当前项目：会话上下文缺少 thread_id"
    pid = projects.project_id_of_thread(thread_id)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    depth = (depth or "standard").strip() or "standard"
    try:
        view = research.start_research(pid, topic, brief, depth)
    except ValueError as e:
        return str(e)
    job_id = view["jobId"]
    # 开题 flow 通常 10-30s：在这里等到出结果，把计划直接交还给模型讲给用户
    for _ in range(60):
        if view["plan"] is not None or view["status"] == "error":
            break
        await asyncio.sleep(2)
        view = research.get_job_view(job_id) or view
    if view["status"] == "error":
        return f"调研开题失败：{view['error']}"
    plan = view["plan"]
    if plan is None:
        return (
            f"开题仍在生成（jobId={job_id}，上游服务慢时需 2-4 分钟）。告诉用户开题生成中、"
            "稍后确认即可；不要连续轮询状态。用户下次说「确认/开始」时调 confirm_research_plan"
            "（它会等开题就绪后自动开跑）。"
        )
    lines = [
        f"开题完成（jobId={job_id}）。观看问题：{plan['viewingQuestion']}",
        "查证方向：",
    ]
    for i, d in enumerate(plan["directions"], 1):
        lines.append(f"{i}. {d['title']}——{d['goal']}")
    if plan.get("risks"):
        lines.append("风险预判：" + "；".join(plan["risks"]))
    lines.append(
        "请把开题讲给用户并请其确认或修改；确认后调用 confirm_research_plan(job_id, plan_json)，"
        "plan_json 传用户修改后的完整计划 JSON（原样确认就传空串）。执行开始后再用 canvas_ops "
        '建调研卡（nodeType:"research"，title=调研主题，researchId=jobId）。'
    )
    return "\n".join(lines)


@tool
async def confirm_research_plan(job_id: str, plan_json: str, config: RunnableConfig) -> str:
    """用户确认/修改开题后调用，启动调研执行循环。

    Args:
        job_id: start_deep_research 返回的任务 id。
        plan_json: 用户修改后的完整计划 JSON（结构 {"viewingQuestion":"…",
            "directions":[{"title":"…","goal":"…","queries":["…"]}]}）；原样确认传空串。
    """
    plan = None
    if plan_json.strip():
        try:
            plan = json.loads(plan_json)
        except json.JSONDecodeError as e:
            return f"plan_json 不是合法 JSON：{e}"
    # 开题 flow 在网关慢时要 1-4 分钟：确认前就地等它就绪（用户已表态，
    # 不该让模型再跑一轮"还没生成"的空转）
    for _ in range(90):
        try:
            view = research.confirm_plan(job_id.strip(), plan)
            break
        except ValueError as e:
            if "开题尚未生成" not in str(e):
                return str(e)
            await asyncio.sleep(2)
    else:
        return (
            f"开题 flow 已等待 3 分钟仍未就绪（jobId={job_id}，上游生成服务慢）。"
            "请告诉用户稍等后再说一句「确认调研」，或用 get_research_result 查看任务状态。"
        )
    minutes = {"quick": "1-2", "standard": "2-4", "deep": "5-10"}.get(view["depth"], "2-4")
    return (
        f"调研已开跑（jobId={view['jobId']}），预计 {minutes} 分钟。"
        "请现在用 canvas_ops 建调研卡（nodeType:\"research\"，title=调研主题，"
        f"researchId=\"{view['jobId']}\"），卡上会实时显示进度；"
        "完成后用户问起时用 get_research_result 取卷宗汇报。"
    )


@tool
async def get_research_result(job_id: str, config: RunnableConfig) -> str:
    """查询深度调研的进度或取最终卷宗。

    用户问「调研怎么样了/查完没」时调用；完成后返回完整卷宗 JSON
    （叙事脊/已证实事实/真实争议/风险/材料簇，含 S 编号来源引用），可直接
    作为写剧本/写文稿的事实依据。补研任务（gap）查询时传补研 jobId。

    Args:
        job_id: 调研任务 id。
    """
    view = research.get_job_view(job_id.strip())
    if view is None:
        return "调研任务不存在（agent 可能已重启；已集证据保留，可重新发起补研）"
    if view["status"] in ("planning", "running"):
        stage_note = {
            "search": "正在搜索", "fetch": "正在抓取原文", "extract": "正在提纯",
            "evaluate": "正在评估完整性", "dossier": "正在撰写卷宗", "": "",
        }.get(view["stage"], view["stage"])
        return (
            f"调研「{view['topic']}」进行中：第 {view['roundsDone']}/{view['roundsTotal']} 轮，"
            f"{stage_note or view['status']}，已集来源 {view['sourcesCount']} 条、"
            f"事实 {view['findingsCount']} 条。请稍后再问。"
        )
    if view["status"] in ("error", "stopped", "interrupted"):
        status_word = {"error": "失败", "stopped": "已取消", "interrupted": "被中断"}[view["status"]]
        msg = f"调研「{view['topic']}」{status_word}"
        if view["error"]:
            msg += f"：{view['error']}"
        msg += (
            f"。已集来源 {view['sourcesCount']} 条、事实 {view['findingsCount']} 条"
            f"保留在卷宗（researchId={view['jobId']}），可对它发起补研继续。"
        )
        return msg
    dossier = view.get("dossier") or {}
    parts = [f"调研「{view['topic']}」已完成（{view['summary']}）", "卷宗 JSON："]
    parts.append(json.dumps(dossier, ensure_ascii=False))
    parts.append(
        "以上卷宗可作为写作的事实依据：引用时保留 S 编号与来源，口径分歧按双版本呈现，"
        "不要把 controversies 里的任何一个版本当成定论。"
    )
    return "\n".join(parts)


# ---------- 技能手册（Agent Skills 规范，渐进披露：目录进系统提示，正文按需 read_skill）----------

SKILLS_DIR = Path(__file__).resolve().parent / "skills"


def load_skill_meta() -> List[Dict[str, str]]:
    """扫描 skills/<name>/SKILL.md 的 frontmatter（name + description）。

    与 skills.py 同名目录不冲突：Python 解析时模块（skills.py）优先于
    命名空间包。description 兼作触发条件描述（影策 skills 范式）。"""
    out: List[Dict[str, str]] = []
    if not SKILLS_DIR.is_dir():
        return out
    for d in sorted(SKILLS_DIR.iterdir()):
        f = d / "SKILL.md"
        if not f.is_file():
            continue
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
        if not m:
            continue
        fields = dict(re.findall(r"^(\w+):\s*(.+?)\s*$", m.group(1), re.M))
        name = fields.get("name") or d.name
        desc = fields.get("description", "")
        if name and desc:
            out.append({"name": name, "description": desc})
    return out


SKILL_META = load_skill_meta()
SKILL_CATALOG = "\n".join(
    f"- {m['name']} — {m['description']}" for m in SKILL_META
) or "（暂无）"


def refresh_skill_meta() -> None:
    """重扫 skills 目录并热更新模块级目录/清单（技能编辑/新建端点保存后调用，
    免重启 agent——chat_node 每轮 format 时读的就是这两个模块全局量）。"""
    global SKILL_META, SKILL_CATALOG
    SKILL_META = load_skill_meta()
    SKILL_CATALOG = "\n".join(
        f"- {m['name']} — {m['description']}" for m in SKILL_META
    ) or "（暂无）"


async def generate_thread_title(user_text: str, assistant_text: str) -> str:
    """会话自动命名：首组对话 → 6-14 字中文标题。一次性小调用走主循环同款
    模型通道（聊天基础设施，与「聊天主循环豁免 Langflow」同族；不做 flow）。
    失败返回空串，调用方保留原标题。"""
    # thinking_kwargs 与主循环同款：GLM 系开思考；其余 reasoning_effort=none
    # （实测 luna 会把小 max_tokens 全烧在 reasoning 上，finish=length 标题为空）
    model = ChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-chat"),
        base_url=os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ.get("AGENT_API_KEY", ""),
        temperature=0.3,
        max_tokens=256,
        streaming=False,
        **({"extra_body": {"thinking": {"type": "enabled"}}} if _thinking_enabled() else {"reasoning_effort": "none"}),
    )
    try:
        resp = await model.ainvoke(
            [
                (
                    "system",
                    "为下面的对话起一个会话标题：6-14 个中文字，概括用户意图或主题，"
                    "不要引号、不要句号、不要前缀。只输出标题本身。",
                ),
                (
                    "user",
                    f"用户：{user_text[:600]}\n\n助手：{assistant_text[:600]}",
                ),
            ]
        )
        return str(resp.content or "").strip().strip('"“”«»').splitlines()[0][:24]
    except Exception:  # noqa: BLE001
        return ""


@tool
def read_skill(name: str) -> str:
    """读取一份技能手册全文（SKILL.md）。系统提示里的「技能手册」目录只是
    索引——执行对应任务（出设定图/批量编辑画布/读画布上下文）前先读手册。

    Args:
        name: 手册名（目录里列出的名称，如 asset-aware-generation）。
    """
    d = SKILLS_DIR / name.strip()
    f = d / "SKILL.md"
    if not f.is_file() or not d.resolve().is_relative_to(SKILLS_DIR.resolve()):
        return f"手册 {name} 不存在。可用：{'、'.join(m['name'] for m in SKILL_META)}"
    return f.read_text(encoding="utf-8")


backend_tools = [list_langflow_skills, decompose_script, generate_storyboard, generate_asset_images, run_langflow_skill, read_skill, research_asset_references, get_reference_research_status, start_deep_research, confirm_research_plan, get_research_result]
backend_tool_names = {t.name for t in backend_tools}

# 允许模型调用的前端工具白名单（防止客户端注入无关工具）。
# read_node：系统提示两处指示模型用它在摘要截断时取卡片全文，必须在册
# 允许模型调用的前端工具白名单（防止客户端注入无关工具）。
# read_node：系统提示两处指示模型用它在摘要截断时取卡片全文，必须在册；
# propose_plan / update_plan：计划先行（多步任务先确认后执行、逐步打勾）
FRONTEND_TOOL_ALLOWLIST = {"canvas_ops", "canvas_query", "canvas_validate_ops", "read_node", "open_style_picker", "set_project_style", "propose_plan", "update_plan"}


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


def _thinking_enabled() -> bool:
    """思考模式开关：GLM 系默认开（网关认 thinking 参数）；换非思考模型时用
    AGENT_THINKING=0 关闭，反之 =1 强制开。"""
    explicit = (os.environ.get("AGENT_THINKING") or "").strip().lower()
    if explicit:
        return explicit in ("1", "true", "yes", "on")
    return "glm" in (os.environ.get("AGENT_MODEL") or "").lower()


class _OneShotToolArgsCompatChatOpenAI(ChatOpenAI):
    """工具调用流兼容层：把「name 与完整 arguments 同块到达」的工具调用
    拆成 先 START（仅 name）→ 再 ARGS（纯参数增量）两段。

    GLM 等网关不做 OpenAI 式参数分片，一个流块就带全量参数；ag-ui-langgraph
    0.0.44 的编码器状态机只认「后续块才是 args 增量」，同块参数会被 START
    吞掉（客户端收到空 arguments）。渐进式分片的模型（DeepSeek/OpenAI）
    原样透传，不受影响。

    兼任 reasoning_content 恢复：langchain-openai 1.6 按官方 API 规格丢弃
    第三方思考字段，而 ag-ui 桥靠 additional_kwargs.reasoning_content 发
    REASONING_MESSAGE_* 事件（思考透传的唯一通道）——这里从原始 delta 捡回。
    """

    def _convert_chunk_to_generation_chunk(
        self, chunk: dict, default_chunk_class: type, base_generation_info: dict | None
    ) -> ChatGenerationChunk | None:
        generation_chunk = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation_chunk is None:
            return None
        choices = chunk.get("choices") or []
        delta = (choices[0].get("delta") or {}) if choices else {}
        reasoning = delta.get("reasoning_content")
        if reasoning:
            generation_chunk.message.additional_kwargs["reasoning_content"] = reasoning
        return generation_chunk

    def _split_one_shot_chunk(self, chunk: Any) -> Iterator[Any]:
        tccs = list(getattr(chunk.message, "tool_call_chunks", None) or [])
        if not any(t.get("name") and t.get("args") for t in tccs if isinstance(t, dict)):
            yield chunk
            return
        start_tccs = [
            {**t, "args": ""} if isinstance(t, dict) else t for t in tccs
        ]
        args_tccs = [
            {**t, "name": None, "id": None} if isinstance(t, dict) else t for t in tccs
        ]
        start_msg = chunk.message.model_copy(
            update={"tool_call_chunks": start_tccs, "content": ""}
        )
        args_msg = chunk.message.model_copy(
            update={"tool_call_chunks": args_tccs, "content": ""}
        )
        yield ChatGenerationChunk(
            message=start_msg, generation_info=chunk.generation_info
        )
        yield ChatGenerationChunk(message=args_msg, generation_info=None)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        async for chunk in super()._astream(
            messages, stop=stop, run_manager=run_manager, **kwargs
        ):
            for piece in self._split_one_shot_chunk(chunk):
                yield piece


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
「画布当前状态」是**索引**：节点多时只列一部分（尾部有明示），其余用 canvas_query 检索（query/types/resourceOnly 过滤，返回 id/类型/标题/媒体URL），
详情（正文全文/分镜行/邻接连线）用 read_node——**任何时候都不要按 n_xxx 格式猜测或拼造节点 id**（时间戳段不可推算，猜必错）。
写操作调用前端工具 canvas_ops，参数 ops 是操作数组，一次可以批量执行多项：
- {{"op":"add_node","nodeType":"note|script|character|image|video|audio|compose|storyboard|shotlist","title":"标题","body":"正文","position":{{"x":0,"y":0}}}}  新建卡片（position 可省略，会自动布局；image/video/audio 可带 imageUrl/videoUrl/audioUrl；image 可带 imageUrls 多候选数组；shotlist 可带 rows:[{{rid,action,shotSize,cameraMove,duration,lighting,sound,dialogue,assets:[资产名]}}] 行数组）
- {{"op":"update_node","id":"节点id","title":"新标题","body":"新正文"}}  更新卡片
- {{"op":"update_node","id":"分镜表id","row":{{"rid":"行id","imageUrl":"url"}}}}  更新分镜表的单行（镜头级出图回填）
- {{"op":"delete_nodes","ids":["节点id",...]}}  删除卡片
- {{"op":"connect_nodes","fromId":"节点id","toId":"节点id"}}  连线（方向：from → to）
- {{"op":"group_nodes","ids":["节点id",...],"title":"分组名"}}  把多张卡收进一个分组框（如整场戏的分镜归拢）
- {{"op":"set_viewport","x":0,"y":0,"zoom":1}}  移动画布视野
复杂批量（≥10 项或含删除/分组/对新建节点连线）先用 canvas_validate_ops 干跑校验，返回 issues 不落画布，无 error 再用 canvas_ops 应用。

audio（音频）卡：配音 / 音效 / BGM，音频源由用户在卡片上上传（audioUrl），你只负责建卡与连线。
compose（合成）卡：把多张视频卡按顺序连线到它，用户点卡片上的「合成成片」按钮由服务端 ffmpeg 拼接——
你只负责建 compose 卡并 connect_nodes 把视频按镜号顺序连上，不要自己生成合成结果。

storyboard（分镜）卡：title=镜头名，body=画面描述（谁、在哪、做什么），
add_node / update_node 可带 shotNumber（镜号，如 01）、shotSize（远景/全景/中景/近景/特写）、
cameraMove（运镜，如 推、拉、摇、跟、固定）、duration（如 3s）、dialogue（台词/旁白）。
分镜分两类处理：
- **整表分镜**（把剧本拆成分镜表 / 重新生成 / 整表压缩重写）→ 用 generate_storyboard 工具生成 rows
  并写回：画布已有分镜表卡（画布状态里 [分镜表] 行）用 update_node 带 rows 整组替换；没有则
  add_node nodeType=shotlist 带 rows 新建。整表分镜**不要为每个镜头铺独立 storyboard 卡**。
- 单镜头画面卡 → storyboard 卡（字段见上），按顺序连线（镜号从 01 递增）。

节点 id 形如 n_xxx_x，从「画布当前状态」索引或 canvas_query 结果里取。
新建的卡要在同批或后续连线/更新时，给 add_node 带 id 字段自拟占位符（如 "SB_1"），后续
connect_nodes / update_node 直接引用同值即可；没带占位符就必须等工具结果返回的真实 id 再引用。

## 生成管线（Langflow 技能）
涉及批量生成（宣发文案等）时，先用 list_langflow_skills 查可用技能，再用 run_langflow_skill 调用。

## 计划先行（多步任务）
≥3 步的任务（拆解→建卡→出图全链路、批量出图、整理画布等）：先用 propose_plan 列出计划
（title + steps，每步一句动词开头的短句、可独立验证），计划卡会同步展示给用户——展示后立即开始执行，
无需等待确认。按顺序执行，每完成一步调 update_plan(planId, step=步程序号) 打勾再继续，全部完成后
简短汇报；某步失败时在汇报里如实说明，不要把失败步骤标成完成。单步操作（建一张卡、单张出图、改一句）直接做，不出计划。

## 技能手册（按需加载）
{skill_catalog}
目录只是索引：执行对应任务前先调 read_skill(名称) 读手册全文再动手；
用户点名某技能（如「按技能「N」的规则处理」）时同样先 read_skill(N) 再执行。

## 设定图与考据
真实历史/史料题材出设定图前先 read_skill("asset-aware-generation")——考据检索、一致性参考
（reference_images/reference_labels）、画风闸、防重复建卡的完整规则在手册里；纯虚构题材不必读。

## 深度调研（纪录片/罪案的故事取证）
用户要选题论证、背景资料、史实核实、人物/事件深挖时：用 start_deep_research 发起 → 把开题（观看问题+查证方向）讲给用户听并请确认/修改 → confirm_research_plan 开跑 → 用 canvas_ops 建调研卡（nodeType:"research"，researchId=任务id）并 connect_nodes 连到相关卡。进度/结果用 get_research_result 查；完成后的卷宗（含 S 编号来源引用）是写剧本/文稿的事实权威——引用保留 S 编号，争议按双版本呈现不定论。

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
    - AIMessage 的 reasoning_content 剥除：思考属本轮瞬态，回传给模型
      既浪费 token 也不被 API 接受
    """
    flatten_media = not _vision_enabled()
    result: List[Any] = []
    pending: Dict[str, str] = {}
    for m in messages:
        ak = getattr(m, "additional_kwargs", None)
        if isinstance(m, AIMessage) and isinstance(ak, dict) and "reasoning_content" in ak:
            m = m.model_copy(
                update={
                    "additional_kwargs": {
                        k: v for k, v in ak.items() if k != "reasoning_content"
                    }
                }
            )
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

    # 思考/推理模式按通道二选一：GLM 系发 thinking:enabled（网关认该参数）；
    # 其余（gpt-5 系等）显式 reasoning_effort="none"——DMX 上游给 luna 默认注入
    # reasoning_effort，与 function tools 同发会被 400 拒绝（"Function tools with
    # reasoning_effort are not supported"），报错给的建议就是显式设 none。
    thinking_kwargs = (
        {"extra_body": {"thinking": {"type": "enabled"}}}
        if _thinking_enabled()
        else {"reasoning_effort": "none"}
    )
    model = _OneShotToolArgsCompatChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-chat"),
        base_url=os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ.get("AGENT_API_KEY", ""),
        temperature=0.3,
        streaming=True,
        **thinking_kwargs,
    )

    model_with_tools = model.bind_tools(
        [*_frontend_tools(state), *backend_tools],
        parallel_tool_calls=False,
    )

    # 画布摘要：主通道 = run 的 forwarded_props（前端 setProperties 每轮携带，
    # 桥接层蛇形化落进 state.forwarded_props）；useCopilotReadable 的调用方
    # 上下文经桥接补丁注入为 system 消息——都没有时不要写"不可用"误导模型，
    # 让它以前文上下文为准。
    forwarded = state.get("forwarded_props") or {}
    canvas_summary = (
        state.get("canvasSummary")
        or forwarded.get("canvas_summary")
        or "（本轮未随状态提供——若调用方附带的上下文里有画布内容，以它为准）"
    )
    system_message = SystemMessage(
        content=SYSTEM_PROMPT.format(
            canvas_summary=canvas_summary,
            camera_cheat=camera.camera_cheat_sheet(),
            skill_catalog=SKILL_CATALOG,
        ),
    )

    # 截断历史 + 清洗交替（孤儿 tool / 缺响应的 call）防止模型侧 400。
    # 画布摘要只随 system prompt 注入一次（每轮重建，值恒为最新，无需末尾再放）
    trimmed = _sanitize_messages_for_model(messages[-14:])

    # 流式聚合：必须用 astream 而非 ainvoke——ag-ui 桥的 TEXT_MESSAGE_CONTENT
    # 靠 on_chat_model_stream 事件逐 token 下发，ainvoke 是单次非流式请求，
    # 整段回复憋到节点结束才一次性吐出（前端表现为"没有打字机效果"）。
    # 聚合后的完整消息照常入 state/checkpoint，图逻辑与 ainvoke 等价。
    merged: AIMessageChunk | None = None
    async for chunk in model_with_tools.astream([system_message, *trimmed], config):
        merged = chunk if merged is None else merged + chunk
    if merged is None:
        raise RuntimeError("模型未返回任何内容")
    response = AIMessage(
        content=merged.content,
        additional_kwargs=merged.additional_kwargs,
        tool_calls=merged.tool_calls,
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
checkpointer = _LazyAsyncSaver(CHECKPOINT_DB)
graph = workflow.compile(checkpointer=checkpointer)
