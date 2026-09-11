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
import math
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from string import Template
from typing import Any, Dict, Iterator, List, Tuple

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
import events
import free_images
import imgresearch
import models
import projects
import research
import skills

# ---------- 状态 ----------


class AgentState(CopilotKitState):
    """共享状态：canvasSummary 是画布摘要（前端 useCoAgent 写入）。
    history_summary/summary_count 是长对话滚动压缩：前 summary_count 条
    消息已折叠进 history_summary（chat_node 超阈值时自压缩，见
    _compress_history）。"""

    canvasSummary: str = ""
    tools: List[Any] = []
    history_summary: str = ""
    summary_count: int = 0


# ---------- 后端工具 ----------


@tool
async def list_langflow_skills() -> str:
    """列出当前可用的 Langflow 技能（预置的生成管线，如宣发文案）。"""
    return skills.describe_skills()


@tool
async def decompose_script(script: str, config: RunnableConfig) -> str:
    """把创作素材拆解为资产清单（角色/场景/道具/服饰，含外形与视觉要点）。

    用户给出剧本（完整或片段）并想要资产卡/设定图时，先用这个工具拆解，
    再用 canvas_ops 把拆出的资产建成画布卡片（建完继续标准链的下一步，
    增删确认放在链尾汇报时，不要中途停下）。

    标准链有两条分支（先拆分镜 / 先拆资产），**分镜先时**要把分镜表行文本
    （read_node 分镜表卡取行）与剧本原文**一并传入**：分镜行提供「本镜有哪些
    角色/场景/道具/服饰」的清单（换装、关键道具只有分镜里看得见），剧本原文
    提供「它们长什么样」的依据。只给分镜行会让 flow 按「合理补全」条款编造
    外形与造型计划，那些编造会一路进到出图提示词当事实用。

    Args:
        script: 创作素材全文——剧本原文；分镜先时 = 剧本原文 + 分镜表行文本
            （尽量完整传入，不要自行摘要）。
    """
    await skills._emit_progress(config, "正在拆解剧本，提取角色 / 场景 / 道具清单…")
    job_id = skills.start_chat_job(
        skills._thread_id_of_config(config), "tool", "拆解剧本"
    )
    task = asyncio.current_task()
    if task is not None:
        skills.job_attach_task(job_id, task)
    return await skills.decompose_script(script, skills._project_id_from_config(config))


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
            生成的行会自动引用名单内资产，行内提到时用「@名称」标记。**画布还没有资产卡时
            留空**（分镜先分支）：分镜照样按剧本原名申报每镜出现的角色/场景/道具/服饰，
            这些名字不在名单里就会在返回里列成「画布缺哪些资产」——缺卡信号（换装服饰/
            关键道具漏拆就是靠它发现的），按类型补建后再出图。
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
        rows, missing = await skills.run_storyboard_flow(
            script,
            shot_count=shot_count or None,
            assets=assets,
            model=model,
        )
    except Exception as e:  # noqa: BLE001
        return f"分镜生成失败：{e}"
    out = (
        f"分镜已生成（{len(rows)} 行）。rows JSON：\n"
        + json.dumps(rows, ensure_ascii=False)
        + '\n写回：画布已有 [分镜表] 卡 → canvas_ops update_node(id, rows=上述数组)；'
        '没有 → add_node(nodeType="shotlist", rows=上述数组)。行里的 assets 资产名数组写回时保留，系统会解析成对画布资产卡的引用。'
    )
    if missing:
        head = "、".join(missing[:20])
        more = f"（共 {len(missing)} 个，只列前 20）" if len(missing) > 20 else ""
        out += (
            f"\n\n【画布缺的资产】分镜引用了这些名字，画布上没有对应卡：{head}{more}。\n"
            "这是缺卡信号（换装服饰/关键道具漏拆；**分镜先时它就是你该盘点哪些资产的清单**）"
            "——逐名核对：确实该建卡的（角色/场景/承载时代或身份信息的服饰/关键道具）按类型补建"
            "（canvas_ops add_node，character/scene/prop/costume）并在回复里点名补了哪几个；"
            "一次性的小物件与纯属编造的丢弃并说明。补完再出图，否则相关镜头没有资产设定图可参考。"
        )
    return out


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


# 出图模型目录唯一真相源 = models.IMAGE_MODELS，工具描述里的清单由它生成
# （此前手抄两份，models.py 改动 docstring 不会跟着变——漂移隐患）。
# f-string 不能作 docstring，正文进常量、def 后显式赋 __doc__ 再 tool() 包装。
_IMAGE_MODEL_LINE = (
    "{"
    + ", ".join(
        f'"{m["id"]}": {json.dumps(m["resolutions"])}' for m in models.IMAGE_MODELS
    )
    + "}"
)
_GEN_ASSETS_DOC = f"""为资产批量生成设定图（并发出图，每张完成会实时推送进度到聊天）。

**资产正文是设定数据不是状态日志**：出图成败用聊天回复汇报、用卡上 status 字段表达，
禁止把「已生成/出图失败/已标记」之类叙述写进资产卡的 description 或正文——
正文会被后续出图当事实注入提示词，状态残留会永久污染生成（2026-09-07 实锤事故）。

用户确认资产清单后要求出图时调用。输入是资产数组 JSON，每个元素：
{{"type":"character|scene|prop|costume|shot","name":"...","description":"...","visual_notes":"...","aspect":"9:16"}}
（字段与 decompose_script 的输出一致；type 决定版式契约：shot=有人物
有剧情的电影剧照，分镜/镜头类用 shot 而不是 scene；**单件物件的道具图
（报纸/文件/告示/信件/包装等）必须用 prop——浅灰背景结构图布局，
不要用 shot**，shot 版式会注入人物与环境把白底道具图带成剧情剧照；
服饰卡用 costume——服装结构图三视图布局，不要改成 prop；**scene 是多视角空间基准图**（主视/反打/四分之三斜角/关键区域近景四格，建筑构件按真实人体尺度关系呈现）——要「空间关系与大小看得全」就用 scene）。
另可选 final_prompt 字段：用户给出完整提示词要求**原样出图**（不走版式
契约）时传它——整体替换渲染，其余字段仍必填但只作记录。
**分镜表的镜头出图必须带行绑定**：type=shot 且属于某分镜表行时，项里
加 "shotlist_id"（画布摘要 [分镜表] 行的节点 id）与 "rid"（read_node 返回
的分镜行清单里取）；返回会附带「分镜图落卡 ops」（每镜一张图卡摆分镜表
右侧 + 分镜表/资产→图卡连线 + 行挂载）——**经 canvas_ops 原样应用整批
ops，不要改写、也不要自己手写行 imageUrl**（行图要跟着图卡走才有版本/
重跑/裁剪等操作层）。不带行绑定的自由单镜出图照旧返回 URL 自行落卡（见下）。
aspect 可选画幅（w:h：16:9/9:16/1:1/4:3/3:4/21:9）：**只在用户明确对
画幅提出要求**（竖版/横版/方图/宽幕，或重出带「画幅 N」标注的卡）时传。
资产设定图一律不传 aspect——按类型默认**横版 16:9**（prop 曾 4:3、
2026-09-07 起统一 16:9），与角色表「横版 16:9 四格构图」的布局提示词和
资产卡 16:9 媒体区配套；agent 不要自行替用户决定画幅（曾把角色表按 3:4 竖版出，
四格构图被压变形、资产带格子高低不齐）。reference_images 可选（字符串数组）：一致性参考图的
/agent-service/assets/ URL（从画布摘要里取带图卡的 imageUrl），配合
reference_labels（[{{type,name}}]，type=character 时锁身份不继承白底
排版）——用户要求「按某角色的设定图出」「保持形象一致」时必须带上。
**同场相邻镜头带上一镜的镜头图当连贯参考**（type 写 `shotref`，name 写
「上一镜（场次名）」）：行上「场次」同名的连续镜头才配，锁光线/色调/陈设/
造型的连贯——同场戏前后镜各画各的调子就是这里漏了。参考图上限 5 张，
资产身份参考优先，排不下时先留资产。
**同一地点的多状态场景（朝堂 / 朝堂·夜 / 朝堂·战损）**：把变体卡的连线
指向母场景卡（canvas_ops connect_nodes 母→变体），出图时母场景图会自动进
参考（只锁空间结构与陈设，光线时段以本卡提示词为准）——状态变体只改天气/
光线/陈设/事件痕迹，不改建筑结构，否则同一地点在不同场次里长得不像同一个
地方。
**考据不用你搬**：真实题材项目（缺省；动画/架空等虚构题材由
set_project_factuality 声明）出图时，服务端会为画布上没有考据简报的资产
自动补一次文字考据（年代/形制/常见误用）并注入提示词——不必在
visual_notes 里手写考据，提示词里出现「考据依据」段是正常的。要让考据
落卡持久化（卡上可见、可供 AI 写设定复用）走 research_asset_references。
**补考据失败会留痕**：那样的图返回项带 researchNote（「未考证：…」），
卡上「节点信息」也记「未考证」——遇到它不要当正常结果交付，向用户说明
这几张形制没有依据，要补就引导先做资产考据（资产卡「找参考图」）再重出。
**返回串首行可能是「⚠️ 参考图核查」**：那说明这批资产没有实物参考（只有
文字考据约束形制，长相没有实物比对）。真实题材遇到它**先如实告诉用户缺参考、
给出补法**（research_asset_references 全量发起，或报告卡「补调研」），不要
当成正常结果交付、也不要自己编一句「已按考据出图」糊过去——参考图缺了不会
报错，图照样出得来（091101 事故：52 张资产文字考据全到、参考图 0 张，一路
出图没人发现）。画布摘要里资产行也会标「⟨缺参考图⟩」、头部有「参考图缺 k/N」。
返回每个资产的成败与 image_url，**并附带落卡 ops**：
- 资产卡（character/scene/prop/costume）→ update_node 挂回卡上媒体位（媒体位
  靠节点 id 或资产名匹配画布卡）——**拿到 ops 先经 canvas_ops 原样应用，再向
  用户汇报**：图出了不等于卡上有，没应用就说「已落卡」是错的（091101 事故：
  模型口播「52 张都落在卡上了」而画布一片空白）。不要在返回的 ops 之外自己
  手写 imageUrl/genShot。
- 分镜行绑定（shotlist_id + rid）→ 每镜一张图卡 + 连线 + 行挂载。
- 不带行绑定的自由单镜（type=shot 无 shotlist_id）不产 ops：照旧拿返回的
  image_url 自己 canvas_ops add_node 落一张图卡。
用户点名要换出图模型/清晰度/质量档时才传 model / resolution / quality；可用的模型
与各模型支持档位：
{_IMAGE_MODEL_LINE}
seedream-5-0-pro 是多图融合模型：多张参考图合成一张（如「图1 的人物
穿上图2 的服装」），用户要求融合/组合多张参考图时优先选它。

Args:
    assets_json: 资产数组 JSON 文本。
    model: 出图模型 id（上表之一），留空用目录默认 {models.DEFAULT_MODEL_ID}。
    resolution: 清晰度档位（1K/2K/4K，须在该模型支持列表内），留空用模型默认。
    quality: 质量档（low/medium/high/xhigh/max），仅 gpt-image-2.5-sunburst
        支持；用户说「最高质量/拉满画质」传 max、「快速出草稿」传 low，
        留空用默认 high。"""


def _build_shot_card_ops(
    bound: List[Dict[str, Any]],
    results: List[Dict[str, Any]],
    config: RunnableConfig,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """为绑定分镜表的 shot 生成落卡 ops（与前端出图按钮同语义）：

    每镜一张 image 卡（分镜表右侧 √n 网格）+ 分镜表→图卡 与 资产→图卡
    连线 + 行挂 imageNodeId（行缩略图读卡上的图，重跑时行随卡刷新）。
    参考资产按 reference_images URL 反查画布资产卡（URL 来自画布摘要，
    basename 匹配即可）；ref_node_ids 显式指定优先。"""
    thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    pid = projects.project_id_of_thread(thread_id) if thread_id else ""
    if not pid:
        return [], ["会话未绑定项目，无法生成分镜落卡 ops"]
    canvas = projects.load_canvas(pid) or {}
    nodes = canvas.get("nodes", [])
    by_id = {str(n.get("id")): n for n in nodes}
    # URL basename → 资产卡 id（反查连线用）
    url_to_asset: Dict[str, str] = {}
    for n in nodes:
        d = n.get("data") or {}
        if d.get("nodeType") in ("character", "scene", "prop", "costume") and d.get("imageUrl"):
            url_to_asset[str(d["imageUrl"]).rsplit("/", 1)[-1]] = str(n.get("id"))

    by_name = {r.get("name"): r for r in results if isinstance(r, dict)}
    # 按分镜表分组（理论上一个 batch 只有一个表，但按表分组无伤）
    ops: List[Dict[str, Any]] = []
    notes: List[str] = []
    per_table: Dict[str, List[Dict[str, Any]]] = {}
    for a in bound:
        per_table.setdefault(str(a.get("shotlist_id")), []).append(a)
    for sl_id, items in per_table.items():
        sl = by_id.get(sl_id)
        if not sl or (sl.get("data") or {}).get("nodeType") != "shotlist":
            notes.append(f"shotlist_id={sl_id} 不是画布上的分镜表卡，本批落卡 ops 跳过")
            continue
        rows = (sl.get("data") or {}).get("rows") or []
        row_by_rid = {str(r.get("rid")): (i, r) for i, r in enumerate(rows)}
        style = str(skills._project_style_from_config(config) or "").strip()
        # 右侧 √n 网格（同前端出图按钮：footprint 256×200 + 54 间距）；
        # 整块与既有节点做粗碰撞：撞了就整块下移
        fp_w, fp_h, gap = 256, 200, 54
        sx, sy = sl.get("position", {}).get("x", 0), sl.get("position", {}).get("y", 0)
        cols = max(1, math.ceil(math.sqrt(len(items))))
        block_w = cols * (fp_w + gap) - gap
        block_h = math.ceil(len(items) / cols) * (fp_h + gap) - gap
        origin_x, origin_y = sx + 560 + 80, sy

        def _bbox_hit(x: float, y: float) -> bool:
            for n in nodes:
                p = n.get("position") or {}
                w = float((n.get("style") or {}).get("width") or 320)
                h = float((n.get("style") or {}).get("height") or 220)
                if x < p.get("x", 0) + w and p.get("x", 0) < x + block_w and \
                   y < p.get("y", 0) + h and p.get("y", 0) < y + block_h:
                    return True
            return False

        while _bbox_hit(origin_x, origin_y):
            origin_y += fp_h + gap

        for i, a in enumerate(items):
            rid = str(a.get("rid"))
            hit = row_by_rid.get(rid)
            if hit is None:
                notes.append(f"rid={rid} 不在分镜表 {sl_id} 的行清单里，该镜落卡跳过")
                continue
            seq, row = hit
            r = by_name.get(str(a.get("name")))
            if not (r and r.get("ok") and r.get("imageUrl")):
                continue  # 失败镜不建卡；✗ 行已在结果文本里
            ref_urls = [str(u) for u in (a.get("reference_images") or a.get("referenceImages") or []) if str(u).strip()]
            ref_ids = [str(x) for x in (a.get("ref_node_ids") or []) if str(x) in by_id] or [
                url_to_asset[u.rsplit("/", 1)[-1]] for u in ref_urls if u.rsplit("/", 1)[-1] in url_to_asset
            ]
            # 去重保序
            ref_ids = list(dict.fromkeys(ref_ids))
            card_id = f"shotimg_{rid}"
            rel_refs = ["/agent-service/assets/" + u.rsplit("/", 1)[-1] for u in ref_urls]
            gen_shot = {
                "description": str(r.get("composedPrompt") or a.get("description") or ""),
                "assetType": "shot",
                "visualNotes": str(a.get("visual_notes") or a.get("visualNotes") or ""),
                "referenceImages": rel_refs,
            }
            # 实际发送提示词随卡（「实际提示词」查看/编辑重跑的数据源）
            fp = str(r.get("finalPrompt") or r.get("final_prompt") or "").strip()
            if fp:
                gen_shot["finalPrompt"] = fp[:3000]
            labels = a.get("reference_labels") or a.get("referenceLabels") or []
            if ref_urls and labels:
                gen_shot["referenceLabels"] = labels[: len(ref_urls)]
            if a.get("aspect"):
                gen_shot["aspect"] = str(a["aspect"])
            ops.append({
                "op": "add_node",
                "id": card_id,
                "nodeType": "image",
                "position": {
                    "x": origin_x + (i % cols) * (fp_w + gap),
                    "y": origin_y + (i // cols) * (fp_h + gap),
                },
                "title": f"镜头{seq + 1:02d} 图",
                "body": str(row.get("action") or "")[:500],
                "imageUrl": r["imageUrl"],
                "status": "ready",
                "genPrompt": gen_shot["description"],
                "genShot": gen_shot,
                **({"refIds": ref_ids} if ref_ids else {}),
                **({"styleSnapshot": f"全局视觉风格：{style}"} if style else {}),
            })
            ops.append({"op": "connect_nodes", "fromId": sl_id, "toId": card_id})
            for aid in ref_ids:
                ops.append({"op": "connect_nodes", "fromId": aid, "toId": card_id})
            ops.append({
                "op": "update_node",
                "id": sl_id,
                "row": {"rid": rid, "imageNodeId": card_id},
            })
    return ops, notes


def _build_look_card_ops(
    results: List[Dict[str, Any]], config: RunnableConfig
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """为造型图生成落卡 ops（与前端「补资产图 → 自动续跑造型图」同语义）：

    每个造型一张 image 卡（**角色卡右侧同列纵向排列**，与前端
    fillLookImages 的落点一致）+ 角色→造型卡、服饰→造型卡 连线 + 角色卡
    looks[i] 回填 imageUrl/nodeId（幂等标记：装载时不再重复物化，卡被用户删了
    也不复活）+ 同批 group_nodes 收「造型图」框。

    ops 里的 id 是占位符（`lookimg_{角色id}_{造型序号}`），applyOps 会把它当
    真实节点 id 用——所以 update_node 写进 looks 的 nodeId 与它是同一个值。"""
    thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    pid = projects.project_id_of_thread(thread_id) if thread_id else ""
    if not pid:
        return [], ["会话未绑定项目，无法生成造型图落卡 ops"]
    canvas = projects.load_canvas(pid) or {}
    nodes = [n for n in (canvas.get("nodes") or []) if isinstance(n, dict)]
    by_id = {str(n.get("id")): n for n in nodes}
    style = str(skills._project_style_from_config(config) or "").strip()
    # 已占用矩形（既有节点 + 本批已放的造型卡）：findFreePosition 同款——只纵移，
    # x 保持「角色卡右侧」不漂
    occupied: List[tuple] = []
    for n in nodes:
        p = n.get("position") or {}
        occupied.append(
            (
                float(p.get("x") or 0),
                float(p.get("y") or 0),
                float((n.get("style") or {}).get("width") or 320),
                float((n.get("style") or {}).get("height") or 220),
            )
        )
    fp_w, fp_h, gap = 256, 200, 32
    notes: List[str] = []

    def _rel(u: Any) -> str:
        s = str(u or "").strip()
        if not s:
            return ""
        return "/agent-service/assets/" + s.rsplit("/", 1)[-1]

    ok_items = [
        r
        for r in results
        if isinstance(r, dict)
        and r.get("ok")
        and r.get("imageUrl")
        and str(r.get("charId") or "") in by_id
    ]
    missing = [
        str(r.get("charId") or "")
        for r in results
        if isinstance(r, dict) and r.get("ok") and str(r.get("charId") or "") not in by_id
    ]
    if missing:
        notes.append(f"角色卡 {'、'.join(sorted(set(missing)))} 不在画布上，造型图落卡跳过")
    if not ok_items:
        return [], notes
    by_char: Dict[str, List[Dict[str, Any]]] = {}
    for r in ok_items:
        by_char.setdefault(str(r["charId"]), []).append(r)

    ops: List[Dict[str, Any]] = []
    look_ids: List[str] = []
    for cid, items in by_char.items():
        char = by_id[cid]
        cp = char.get("position") or {}
        cdata = char.get("data") if isinstance(char.get("data"), dict) else {}
        cw = float((char.get("style") or {}).get("width") or 320)
        cx = float(cp.get("x") or 0) + cw + 48
        cy = float(cp.get("y") or 0)
        # 造型账带产物一起回填（label 匹配：agent 若同时重写了计划也不丢记账）
        looks = [dict(l) for l in (cdata.get("looks") or []) if isinstance(l, dict)]
        for slot, r in enumerate(items):
            idx = int(r.get("lookIdx") or 0)
            card_id = f"lookimg_{cid}_{idx}"
            y = cy + slot * (fp_h + gap)
            while any(
                cx < ox + ow and ox < cx + fp_w and y < oy + oh and oy < y + fp_h
                for ox, oy, ow, oh in occupied
            ):
                y += fp_h + gap
            occupied.append((cx, y, fp_w, fp_h))
            title = f"{r.get('charTitle') or '角色'}·{r.get('label') or '造型'}"[:40]
            protocol = str(r.get("sentPrompt") or "")
            ref_urls = [u for u in (_rel(r.get("identity")), _rel(r.get("costumeImg"))) if u]
            ref_labels = [{"type": "character", "name": str(r.get("charTitle") or "")}]
            if _rel(r.get("costumeImg")):
                ref_labels.append(
                    {"type": "costume", "name": str(r.get("costumeTitle") or "服饰")}
                )
            gen_shot: Dict[str, Any] = {
                "description": protocol,
                "assetType": "none",
                "referenceImages": ref_urls,
            }
            if style:
                gen_shot["visualNotes"] = f"全局视觉风格：{style}"
            if len(ref_labels) == len(ref_urls) and ref_urls:
                gen_shot["referenceLabels"] = ref_labels
            fp = str(r.get("finalPrompt") or "").strip()
            if fp:
                gen_shot["finalPrompt"] = fp[:3000]
            ref_ids = [cid] + ([str(r["costumeId"])] if r.get("costumeId") else [])
            ops.append(
                {
                    "op": "add_node",
                    "id": card_id,
                    "nodeType": "image",
                    "position": {"x": cx, "y": y},
                    "title": title,
                    "body": str(r.get("description") or "")[:500],
                    "imageUrl": r["imageUrl"],
                    "status": "ready",
                    "genPrompt": protocol,
                    "genShot": gen_shot,
                    "refIds": ref_ids,
                    **({"styleSnapshot": f"全局视觉风格：{style}"} if style else {}),
                }
            )
            ops.append({"op": "connect_nodes", "fromId": cid, "toId": card_id})
            if r.get("costumeId") and str(r["costumeId"]) in by_id:
                ops.append(
                    {"op": "connect_nodes", "fromId": str(r["costumeId"]), "toId": card_id}
                )
            # 造型账回填（imageUrl + nodeId 幂等标记）；计划里没有该项（agent 刚改过
            # 计划）时追加，免得图出了却查不到
            if idx < len(looks) and str(looks[idx].get("label") or "").strip() == str(
                r.get("label") or ""
            ):
                looks[idx] = {
                    **looks[idx],
                    "imageUrl": r["imageUrl"],
                    "nodeId": card_id,
                }
            else:
                looks.append(
                    {
                        "label": str(r.get("label") or ""),
                        **(
                            {"description": str(r["description"])}
                            if r.get("description")
                            else {}
                        ),
                        **({"costumeId": str(r["costumeId"])} if r.get("costumeId") else {}),
                        "imageUrl": r["imageUrl"],
                        "nodeId": card_id,
                    }
                )
            look_ids.append(card_id)
        ops.append({"op": "update_node", "id": cid, "looks": looks})
    # 造型图是 1:N 衍生物，收一个组框（同批占位符 id 已被 applyOps 识别）
    if len(look_ids) >= 2:
        ops.append({"op": "group_nodes", "ids": look_ids, "title": "造型图"})
    return ops, notes


# 画布上的资产卡类型（update_node 回填的目标；分镜图卡不在此列——那是
# _build_shot_card_ops 的活，落的是新建的 image 卡）
_ASSET_CARD_TYPES = ("character", "scene", "prop", "costume")


def _norm_title(s: str) -> str:
    return re.sub(r"\s+", "", str(s or ""))


def _build_asset_card_ops(
    results: List[Dict[str, Any]], config: RunnableConfig
) -> Tuple[List[Dict[str, Any]], List[str], List[Dict[str, Any]]]:
    """为非分镜资产卡生成落卡 ops（与前端「补资产图」同语义）。

    **为什么必须由服务端算**（2026-09-11 091101 事故）：聊天路径此前只返回
    image_url 文本 + 一段「把 finalPrompt 写进 genShot」的附录，落卡全靠模型
    手抄几十条 update_node——52 张图出完后画布上 52 张卡还是空的（模型分三轮：
    出图 → 又出一批 → 才发现没落卡），而中间那轮它已经在聊天里口播「都落在
    卡上了」（返回文本里没有任何「尚未落卡」的信号，模型把「图出了」当「卡有
    了」，用户看到的就是「对话框说生成了、画布一片空白」）。分镜图有
    _build_shot_card_ops、造型图有 _build_look_card_ops，资产设定图这条路不能
    是空白。

    身份解析：node_id（调用方给的画布 id）优先且必须真落在画布资产卡上；
    否则按标题精确匹配，再退一步按「去空白归一」匹配（场景名带空格，模型
    常归一成「长安后宫祈福殿」）。两条都落空的结果进 unresolved（画布上没有
    这张卡），由调用方把 genShot 快照交回 agent 建卡时带上。

    失败项只在卡上**还没有图**时才写 error 态——否则一次重出失败会把卡上
    原有的图换成重试面板（图被藏起来比报错更难查）。
    """
    thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    pid = projects.project_id_of_thread(thread_id) if thread_id else ""
    if not pid:
        return [], ["会话未绑定项目，无法生成资产落卡 ops"], []
    canvas = projects.load_canvas(pid) or {}
    asset_nodes = [
        n
        for n in (canvas.get("nodes") or [])
        if str((n.get("data") or {}).get("nodeType") or "") in _ASSET_CARD_TYPES
    ]
    by_id = {str(n.get("id")): n for n in asset_nodes}
    by_title: Dict[str, str] = {}
    by_norm: Dict[str, str] = {}
    for n in asset_nodes:
        t = str((n.get("data") or {}).get("title") or "").strip()
        if not t:
            continue
        by_title.setdefault(t, str(n.get("id")))
        by_norm.setdefault(_norm_title(t), str(n.get("id")))
    style = str(skills._project_style_from_config(config) or "").strip()
    ops: List[Dict[str, Any]] = []
    notes: List[str] = []
    unresolved: List[Dict[str, Any]] = []
    used: set = set()
    for r in results:
        if not isinstance(r, dict):
            continue
        # 分镜/镜头图走 _build_shot_card_ops（落独立图卡 + 行挂载），不进资产账
        if str(r.get("assetType") or "") == "shot" or str(r.get("shotlistId") or ""):
            continue
        name = str(r.get("name") or "").strip()
        nid = str(r.get("nodeId") or "").strip()
        target = nid if (nid and nid in by_id) else by_title.get(name, "")
        if not target or target in used:
            if not target:
                target = by_norm.get(_norm_title(name), "")
        if not target or target in used:
            if r.get("ok"):
                unresolved.append(r)
            continue
        used.add(target)
        if not r.get("ok") or not r.get("imageUrl"):
            cur = (by_id[target].get("data") or {}).get("imageUrl")
            if not cur:
                ops.append(
                    {
                        "op": "update_node",
                        "id": target,
                        "status": "error",
                        "errorMessage": str(r.get("error") or "出图失败")[:300],
                    }
                )
            continue
        gen_shot: Dict[str, Any] = {
            "description": str(r.get("description") or ""),
            "assetType": str(r.get("assetType") or "none"),
            "visualNotes": str(r.get("visualNotes") or ""),
            "referenceImages": [str(u) for u in (r.get("referenceImages") or [])],
        }
        labels = r.get("referenceLabels") or []
        if gen_shot["referenceImages"] and isinstance(labels, list) and labels:
            gen_shot["referenceLabels"] = labels[: len(gen_shot["referenceImages"])]
        if r.get("aspect"):
            gen_shot["aspect"] = str(r["aspect"])
        fp = str(r.get("finalPrompt") or "").strip()
        if fp:
            gen_shot["finalPrompt"] = fp[:3000]
        rn = str(r.get("researchNote") or "").strip()
        if rn:
            gen_shot["researchNote"] = rn
        op: Dict[str, Any] = {
            "op": "update_node",
            "id": target,
            "imageUrl": str(r["imageUrl"]),
            "status": "ready",
            "errorMessage": "",
            "genShot": gen_shot,
        }
        if gen_shot["description"]:
            op["genPrompt"] = gen_shot["description"][:4000]
        if style:
            op["styleSnapshot"] = f"全局视觉风格：{style}"
        ops.append(op)
    if unresolved:
        notes.append(
            "以下资产在画布上找不到同名的资产卡，图已出但没落卡："
            + "、".join(str(r.get("name") or "?") for r in unresolved)[:160]
            + "（按画布摘要里的真实节点 id 建卡时把 genShot 一并带上）"
        )
    return ops, notes, unresolved


async def generate_asset_images(
    assets_json: str,
    config: RunnableConfig,
    model: str = "",
    resolution: str = "",
    quality: str = "",
) -> str:
    """为资产批量生成设定图。"""
    try:
        assets = json.loads(assets_json)
        if not isinstance(assets, list):
            return "assets_json 必须是资产数组 JSON"
    except json.JSONDecodeError as e:
        return f"assets_json 不是合法 JSON：{e}"
    params = None
    if model.strip() or resolution.strip() or quality.strip():
        try:
            params = models.resolve_imagegen_params(
                {"model": model, "resolution": resolution, "quality": quality}
            )
        except ValueError as e:
            return str(e)
    res = await skills.generate_asset_images(assets, config=config, params=params)
    if isinstance(res, str):
        return res
    out = res["lines"]
    bound = [
        a
        for a in assets
        if isinstance(a, dict)
        and str(a.get("type") or a.get("assetType") or "") == "shot"
        and str(a.get("shotlist_id") or "").strip()
        and str(a.get("rid") or "").strip()
    ]
    if bound:
        ops, notes = _build_shot_card_ops(bound, res.get("results") or [], config)
        for n in notes:
            out += f"\n⚠️ {n}"
        if ops:
            out += (
                f"\n\n分镜图落卡 ops 已生成（{len(bound)} 镜 → 图卡 + 行挂载 + 连线，"
                "位置已按分镜表右侧网格算好）——**经 canvas_ops 原样应用整批 ops**"
                "（占位符 id 不要改、也不要另行手写行 imageUrl；ops 里 genShot"
                ".finalPrompt 已带实际发送提示词）：\n"
                + json.dumps({"ops": ops}, ensure_ascii=False)
            )
    # 非分镜资产卡：服务端直接算好落卡 ops（update_node 挂回资产卡媒体位 +
    # genShot 快照）——不再让模型手抄几十条 update_node（091101 事故：52 张
    # 图出完画布全空，模型中间还口播「已落卡」）
    asset_ops, asset_notes, unresolved = _build_asset_card_ops(
        res.get("results") or [], config
    )
    for n in asset_notes:
        out += f"\n⚠️ {n}"
    if asset_ops:
        n_ok = sum(1 for o in asset_ops if o.get("imageUrl"))
        out += (
            f"\n\n资产卡落卡 ops 已生成（{n_ok} 张 → 挂回对应资产卡媒体位；每张的"
            "genPrompt/genShot（含实际发送提示词 finalPrompt）随 ops 落卡）——"
            "**先经 canvas_ops 原样应用整批 ops，再向用户汇报**：图出了不等于"
            "卡上有，没应用就说「已落卡」是错的；不要再自己手写 imageUrl/genShot"
            "（ops 里已带全）：\n"
            + json.dumps({"ops": asset_ops}, ensure_ascii=False)
        )
    # 画布上没有对应卡的新资产：ops 无从生成，genShot 快照交给 agent 建卡时带
    gen_meta = {
        str(r.get("name")): {"finalPrompt": str(r.get("finalPrompt") or "")}
        for r in unresolved
        if isinstance(r, dict) and r.get("finalPrompt")
    }
    if gen_meta:
        out += (
            "\n\n以上未落卡资产实际发送的完整提示词（版式契约渲染后的最终版）——"
            "用 canvas_ops 按画布摘要里的真实节点 id 建卡时，把对应 finalPrompt "
            "放进 genShot 快照（卡上可查看/编辑重跑）：\n"
            + json.dumps({"genShots": gen_meta}, ensure_ascii=False)
        )
    return out


generate_asset_images.__doc__ = _GEN_ASSETS_DOC
generate_asset_images = tool(generate_asset_images)


_LOOK_DOC = """为角色卡的造型计划（looks）批量出造型图（每个造型一张）。

标准制作链的第三站：资产设定图 → **造型图** → 分镜镜头图。近景/特写镜头
要用造型图当参考而不是定妆照（换装镜拿定妆照出一定穿错衣服），所以资产
设定图出完就该走这一步。

**硬前置**：项目画风已选（无画风会被拦下并告知，不要绕过）；角色卡已有
定妆照（没有身份锚点，造型会长成另一个人——先出资产设定图）。关联的
服饰卡有结构图时会自动当第二张参考锁形制（looks 里的 costumeId 绑定）。

调用后返回「造型图落卡 ops」——**经 canvas_ops 原样应用整批 ops**（占位符
id 不要改）：每个造型物化成独立图片卡（命名「角色名·造型名」，摆角色卡
右侧）+ 角色/服饰→造型卡连线 + 角色卡造型账回填 imageUrl/nodeId。
不要自己另建造型图卡或手写 looks 的 imageUrl——重复建卡与账目错位都从
绕过 ops 来。

Args:
    char_json: 可选，圈定要出造型图的角色卡 JSON 数组 [{"node_id":"..."}]；
        留空 = 画布上所有「有待出造型、且已有定妆照」的角色（常用）。
"""


async def generate_look_images(char_json: str = "", config: RunnableConfig = None) -> str:
    """为角色卡的造型计划（looks）批量出造型图。

    正文在 _LOOK_DOC（f-string 不能作 docstring：模型清单等由目录动态生成），
    def 后赋 __doc__ 再 tool() 包装——与 generate_asset_images 同规。"""
    char_ids: List[str] = []
    if char_json.strip():
        try:
            parsed = json.loads(char_json)
        except json.JSONDecodeError as e:
            return f"char_json 不是合法 JSON：{e}"
        if not isinstance(parsed, list):
            return "char_json 必须是数组 JSON"
        char_ids = [
            str(x.get("node_id") or x.get("nodeId") or x)
            for x in parsed
            if isinstance(x, (dict, str)) and str(x).strip()
        ]
    await skills._emit_progress(
        config, "正在出造型图（每个造型约 1 分钟，参考定妆照与服饰结构图）…"
    )
    job_id = skills.start_chat_job(
        skills._thread_id_of_config(config), "tool", "生成造型图"
    )
    task = asyncio.current_task()
    if task is not None:
        skills.job_attach_task(job_id, task)
    res = await skills.generate_look_images(config=config, char_ids=char_ids)
    out = str(res.get("lines") or "")
    ops, notes = _build_look_card_ops(res.get("results") or [], config)
    for n in notes:
        out += f"\n⚠️ {n}"
    if ops:
        n_card = sum(1 for o in ops if o.get("op") == "add_node")
        out += (
            f"\n\n造型图落卡 ops 已生成（{n_card} 张造型卡 + 角色/服饰连线 + "
            "角色卡造型账回填，位置已按角色卡右侧算好）——**经 canvas_ops 原样"
            "应用整批 ops**（占位符 id 不要改）：\n"
            + json.dumps({"ops": ops}, ensure_ascii=False)
        )
    return out


generate_look_images.__doc__ = _LOOK_DOC
generate_look_images = tool(generate_look_images)


def _pid_from_config(config: Any) -> str:
    """会话 → 项目 id（新工具统一用它；老工具的六行内联写法保持原样不动）。"""
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    if not thread_id:
        return ""
    return projects.project_id_of_thread(thread_id) or ""


@tool
async def research_asset_references(assets_json: str, config: RunnableConfig) -> str:
    """为画布资产批量调研网络参考图（AI 出词 → 联网搜图与下载 → 模型看图终选）。

    给角色/场景/道具/服饰找考据参考图、历史画像、实物照片，提升形制与材质
    一致性。**资产考据是标准制作链的一站，不是请示项**：真实题材（历史/罪案
    纪实，画布缺省）在拆资产之后、出图之前**自动发起，不必问用户**（用户口径：
    除动画片外都是真实题材）；虚构题材（动画/架空/穿越，经 set_project_factuality
    声明）不发起。用户点名只做哪几个/哪一类时才收窄。
    注意时机：意图还没确立（用户只上传素材、没说要做）时先按决策原则问意图，
    意图确立后走到这一站就直接发起。
    **别与史实深度调研混淆**：链路里自动走的只有资产考据（本工具 / 考证大纲），
    start_deep_research 永远由用户发起——「开始制作」不含它。

    **与考证大纲的关系是两个维度，不是二选一**：大纲产**文字**考据（时代级，
    管形制对不对——已采纳参考图只喂图片模型，文字约束得靠大纲），本工具产
    **参考图**（资产级，管长得像不像实物）。**两个都要发起**：只跑大纲不会
    产生任何参考图（091101 武则天项目事故：52 张卡文字考据全到、参考图候选
    0 行，模型以为大纲跑完参考图会自动跟上，全片照着文字硬出）。先后不限
    （本工具收不到大纲的检索词——每资产的首轮搜索词由出词 flow 按资产描述生成，
    大纲的形制结论走**出图时**的提示词注入）。

    **先查库再搜**：发起之前先 `list_research_library` 看一眼同题材项目已经
    考据过什么——同一个时代的同一主体（唐代官服品级、某具体人物、某座宫殿）
    只要别的项目做过，直接 `import_research` 引用即可，不必重搜（用户口径：
    不用每次都调研）。库里没有的资产再走本工具。

    **范围默认全量**：用户说「给资产做调研」没点名具体几个/哪类时，画布上
    的资产卡（character/scene/prop/costume）**全部传入一次调用**——不要
    自己挑「重点资产」子集（090602 事故：55 个资产只调研 16 个，用户以为
    全做了）。用户点名了范围才收窄；只有资产特别多（>60）或用户明显在意
    时间/成本时，先问一句带默认（「全部 N 个约 X 分钟，还是先做重点？」）。
    发起**之后**在回复文字里向用户说明「画布 N 个资产全部纳入」——说明
    只写在回复里，绝不写进 assets_json（JSON 到 ] 即止）。
    **一批资产（≥3 个）不因为数量多就改走大纲**：大纲是补充不是替代，
    参考图这一路永远按本工具发起。

    node_id 必须取自画布摘要（每行行首的节点 id），画布上没有该资产时
    先用 canvas_ops 建卡、下一轮再调研。20 路并发执行：约每 20 个资产
    一波、每波约 4 分钟，发起后立即返回，用 get_reference_research_status
    查进度；**完成时系统已按模型终选自动采纳每资产 top-3 推荐参考**（用户
    可在「找参考图」面板改选，或用 adopt_asset_references 调整张数），
    「补资产图」批量出图会自动带上已采纳参考；参考卡收在画布「考据参考」
    折叠组里。调研有欠账时**考证报告卡**（reportKind=ref-research）头部会写
    「缺参考图待补 Y 个」、工具条有「补调研 Y」一键补齐——用户问「怎么没有
    参考图」时先看那张卡。

    Args:
        assets_json: 资产数组 JSON 文本，每个元素：
            {"node_id":"画布节点id","name":"资产名","type":"character|scene|prop|costume","description":"设定描述（外形/朝代/材质越具体越好）","queries":["可选检索词"]}
            queries 可选（≤5，缺省由出词 flow 按描述生成）：指定该资产的首轮搜索词。
            **给了 queries 就不为它跑文字考据**（与面板手填词同语义）——所以只在
            你已经有可靠的词时才给（如考证大纲里该时代的形制检索词），否则留空
            让系统先出词+考据。
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
        return (
            f"assets_json 不是合法 JSON：{e}——JSON 到 ] 即止，"
            "不要在 JSON 后追加任何说明文字（「N 个资产全部纳入」这类话写在回复里）。"
            "修正后原样重发。"
        )
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
                # 可选检索词（≤5）：给了就用手填词搜图、不跑文字考据——考证大纲
                # 的形制结论可以直接当搜索词喂进来（「文字定边界 → 图像做选择」）
                "queries": [
                    str(q).strip() for q in (a.get("queries") or []) if str(q).strip()
                ][:5],
            }
        )
    if not parsed:
        return "assets_json 缺少有效项：每项需要 node_id 与 name"
    # 节点存在性校验（防幻觉 id/占位 id）：不在画布上直接点名拒绝，并把
    # 可用卡列出来——模型下一轮拿真实 id 重发，不必再查一遍画布
    canvas = projects.load_canvas(pid)
    nodes = (canvas or {}).get("nodes", [])
    node_ids = {str(n.get("id") or "") for n in nodes}
    missing = [a["name"] for a in parsed if a["nodeId"] not in node_ids]
    if missing:
        listing = "；".join(
            f"{n.get('id')}（{(n.get('data') or {}).get('title') or n.get('id')}）"
            for n in nodes[:12]
        )
        return (
            f"node_id 不在画布上（涉及：{('、'.join(missing))[:80]}）——不要自拟占位 id，"
            f"从画布摘要行首取真实节点 id。当前画布的卡：{listing[:400]}"
        )
    batch_id = imgresearch.start_batch_research(pid, parsed)
    names = "、".join(a["name"] for a in parsed)[:120]
    est_min = max(1, -(-len(parsed) // imgresearch.BATCH_CONCURRENCY) * 4)
    return (
        f"已发起 {len(parsed)} 个资产（{names}）的参考图调研，后台 "
        f"{imgresearch.BATCH_CONCURRENCY} 路并发执行预计约 {est_min} 分钟。batch_id={batch_id}。"
        "用 get_reference_research_status 查询进度；完成时系统已按模型终选"
        "自动采纳每资产 top-3 推荐（用户可在「找参考图」面板改选，或调 "
        "adopt_asset_references 调整张数），之后可用「补资产图」批量出图。"
    )


@tool
async def get_reference_research_status(batch_id: str, config: RunnableConfig) -> str:
    """查询参考图调研任务的进度与结果摘要。

    发起 research_asset_references 后用户问进度/是否完成时调用；任务完成后
    返回每个资产的候选数与模型推荐——完成时系统已自动采纳每资产 top-3
    推荐，用户要换图去「找参考图」面板改选，要调整张数调 adopt_asset_references。

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
        lines.append("完成时已自动采纳每资产 top-3 推荐；用户要换图去「找参考图」面板改选，要调整张数调 adopt_asset_references。")
    return "\n".join(lines)


@tool
async def adopt_asset_references(
    node_ids_json: str, config: RunnableConfig, per_node: int = 3
) -> str:
    """调整资产参考图的自动采纳：按调研终选推荐（rec_rank 升序）补采纳。

    调研完成时系统已自动采纳每资产 top-3 推荐；用户想多带几张（如「每个
    资产带 5 张参考」）、少带（面板改选更直观）或某资产漏了推荐时用这个
    工具补齐——等价于在资产卡「找参考图」面板里勾选推荐项，采纳后
    「补资产图」批量出图自动带上参考；用户随时可在面板改选。
    （2026-09-06 用户「你帮我选啊」事故：此前采纳只能手动勾。）

    Args:
        node_ids_json: 资产卡 node_id 数组 JSON（从画布摘要取），如 ["n_ab12_x"]；
            传 "[]" 表示项目内所有有调研候选的资产。
        per_node: 每个资产采纳到几张推荐参考（默认 3，已采纳的不重复计；
            各出图模型参考上限最小为 4，留 1 席余量；上限 10）。
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
        node_ids = json.loads(node_ids_json) if node_ids_json.strip() else []
        if not isinstance(node_ids, list):
            return "node_ids_json 必须是数组 JSON"
    except json.JSONDecodeError as e:
        return f"node_ids_json 不是合法 JSON：{e}"
    per_node = max(1, min(int(per_node or 3), imgresearch.MAX_ADOPT_PER_NODE))
    summary = imgresearch.candidate_summary(pid)
    if not summary:
        return "项目里还没有参考图候选——先调 research_asset_references 发起考据调研。"
    targets = [s for s in summary if not node_ids or s["nodeId"] in node_ids]
    if not targets:
        return "给定资产卡没有调研候选（node_id 要从画布摘要取，或传 [] 全量采纳）。"
    titles: dict[str, str] = {}
    canvas = projects.load_canvas(pid)
    for n in (canvas or {}).get("nodes", []):
        titles[n.get("id")] = (n.get("data") or {}).get("title") or n.get("id")
    lines = []
    adopted_total = 0
    for s in targets:
        label = titles.get(s["nodeId"], s["nodeId"])
        cands = [
            c
            for c in imgresearch.list_candidates(pid, s["nodeId"])
            if c.get("recommended") and not c.get("adopted")
        ]
        cands.sort(key=lambda c: c.get("recRank") or 99)
        # 总量语义：补齐到 per_node 张（自动采纳已带 3 张时，要 5 = 再补 2）
        need = per_node - int(s["adopted"] or 0)
        pick = cands[:need] if need > 0 else []
        if not pick:
            if need <= 0:
                lines.append(f"- {label}：已采纳 {s['adopted']} 张（≥目标 {per_node}），无需补")
            elif s["adopted"]:
                lines.append(
                    f"- {label}：已采纳 {s['adopted']} 张，剩余推荐不足补到 {per_node}（共 "
                    f"{s['adopted'] + len(cands)} 张可采）"
                )
            else:
                lines.append(f"- {label}：无模型推荐，建议用户在「找参考图」面板自行挑选")
            continue
        imgresearch.mark_adopted(pid, s["nodeId"], [c["id"] for c in pick])
        adopted_total += len(pick)
        lines.append(
            f"- {label}：补采纳 {len(pick)} 张（现共 {s['adopted'] + len(pick)} 张）"
            f"（{'、'.join((c.get('title') or '')[:20] for c in pick)}）"
        )
    head = (
        f"已补采纳 {adopted_total} 张推荐参考图（总量补齐到每资产 {per_node} 张，按模型终选推荐序）。"
        "「补资产图」批量出图会自动带上；用户可在资产卡「找参考图」面板改选。"
    )
    return "\n".join([head, *lines])


@tool
async def list_research_library(config: RunnableConfig) -> str:
    """查看**同题材其他项目已经考据过的现成成果**（可复用主体库）。

    时机：用户要「给资产做调研」「按史实出图」「考据一下这个年代」之前**先看一下
    库里有什么**——同一时代的主体（唐代官服品级、武则天寝宫形制、某具体人物）
    只要别的项目做过，就能直接引用，不必重搜（用户口径：不用每次都调研）。

    库里每条含：主体名、事实正文、参考图张数、来自哪个项目、本项目是否已引用。
    要引用就用 import_research 挂到本项目的卡/主题上；库里没有的才发起
    research_asset_references（参考图）或考证大纲（时代文字）。

    作用域是项目的时代口径（画布 meta 的 era）：**没设 era 的项目库是空的**——
    那就先按用户说的年代调 set_project_era 记下来（真实题材才有年代；架空/穿越
    不设），之后调研产生的主体才能跨项目复用。"""
    pid = _pid_from_config(config)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    _, era = imgresearch._project_scope(pid)
    if not era:
        return (
            "本项目还没设时代口径（画布 meta.era），可复用库为空——"
            "先用 set_project_era 记下年代（如「北魏·平城时期」「唐·武周」），"
            "同题材项目的历史考据才能被复用；虚构/架空题材不用设。"
        )
    items = imgresearch.list_library(era, project_id=pid)
    if not items:
        return (
            f"「{era}」下还没有可复用的考据主体（本项目和别的同题材项目都没做过）。"
            "可以发起调研：参考图走 research_asset_references（画布资产全部一次传入），"
            "时代共有的文字事实走考证大纲（get_research_material → propose_research_outline）。"
        )
    free = [i for i in items if not i["used"]]
    lines = [
        f"「{era}」库中共 {len(items)} 条考据主体，其中 {len(free)} 条本项目还没引用"
        f"（下面按最近更新排）"
    ]
    for i in items[:40]:
        kind = "时代主题" if i["kind"] == "topic" else (i["assetType"] or "资产")
        src = i["fromProject"] or "（项目已删）"
        marks = []
        if i["refCount"]:
            marks.append(f"参考图 {i['refCount']} 张")
        if i["used"]:
            marks.append("本项目已引用")
        else:
            marks.append("本项目未引用")
        body = " ".join(str(i["body"]).split())
        lines.append(
            f"■ {i['assetName'] or i['topicKey']}（{kind} · 来自《{src}》"
            f" · {'、'.join(marks)}）\n  id={i['id']}\n  {body[:160]}"
        )
    if len(items) > 40:
        lines.append(f"（其余 {len(items) - 40} 条略）")
    lines.append(
        "引用：import_research（把主体挂到本项目某张卡或某个主题上，活引用、不重搜）。"
        "库里没有的主体再发起调研。"
    )
    return "\n".join(lines)


@tool
async def import_research(
    entry_ids_json: str, targets_json: str, config: RunnableConfig
) -> str:
    """把库里现成的考据主体引用到本项目（活引用：不拷副本，源更新跟着变）。

    用途：list_research_library 看到某个主体正好是本项目要用的（同题材项目已经
    考据过），直接引用而不重新调研——文字事实进提示词、图集的参考图进参考序列。

    Args:
        entry_ids_json: 主体 id 数组 JSON，取自 list_research_library 每条的
            id 字段，如 ["a1b2c3d4e5f6"]。
        targets_json: 挂载目标数组 JSON，与 entry_ids 一一对应（少则按序取，
            多出的忽略），每项 {"target_kind":"node"|"topic","target_key":"..."}：
            node 的 key 是画布节点 id（画布摘要行首取）；topic 的 key 是主题键
            （必须是本项目大纲里已有的主题）。
    """
    pid = _pid_from_config(config)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    try:
        entry_ids = json.loads(entry_ids_json)
        targets = json.loads(targets_json)
        if not isinstance(entry_ids, list) or not isinstance(targets, list):
            return "entry_ids_json 与 targets_json 都必须是数组 JSON"
    except json.JSONDecodeError as e:
        return f"不是合法 JSON：{e}（JSON 到 ] 即止，修正后原样重发）"
    if not entry_ids:
        return "entry_ids_json 是空的：先用 list_research_library 看有哪些可引用主体。"
    canvas = projects.load_canvas(pid)
    node_ids = {str(n.get("id") or "") for n in (canvas or {}).get("nodes", [])}
    titles = {
        str(n.get("id") or ""): str((n.get("data") or {}).get("title") or n.get("id"))
        for n in (canvas or {}).get("nodes", [])
    }
    topic_keys = {t["topicKey"] for t in imgresearch.list_topics(pid)}
    lines: list[str] = []
    ok = 0
    for idx, raw_id in enumerate(entry_ids):
        entry = imgresearch.get_entry(str(raw_id))
        if not entry:
            lines.append(f"- {raw_id}：库里没有这个主体 id（用 list_research_library 的 id 字段）")
            continue
        if idx >= len(targets):
            lines.append(f"- {entry['assetName']}：没有对应的 target，未挂载")
            continue
        t = targets[idx] if isinstance(targets[idx], dict) else {}
        kind = str(t.get("target_kind") or t.get("targetKind") or "node")
        key = str(t.get("target_key") or t.get("targetKey") or "").strip()
        if kind == "node":
            if key not in node_ids:
                lines.append(f"- {entry['assetName']}：画布上没有节点 {key}（取画布摘要行首 id）")
                continue
            imgresearch.record_use(pid, str(entry["id"]), "node", "", key)
            lines.append(f"- {entry['assetName']} → {titles.get(key, key)}：已引用")
        elif kind == "topic":
            if key not in topic_keys:
                lines.append(f"- {entry['assetName']}：本项目大纲里没有主题 {key}，未挂载")
                continue
            imgresearch.record_use(pid, str(entry["id"]), "topic", key)
            lines.append(f"- {entry['assetName']} → 主题「{key}」：已引用")
        else:
            lines.append(f"- {entry['assetName']}：target_kind 只能是 node 或 topic")
            continue
        ok += 1
    head = (
        f"已引用 {ok} 条现成考据主体（活引用，不重搜）。"
        "它们会出现在考证报告卡与出图提示词里；库里的版本更新后本项目跟着变。"
    )
    return "\n".join([head, *lines])


@tool
async def get_research_material(config: RunnableConfig) -> str:
    """读本项目的考据现状：画布资产清单 + 已有考据条目（全文与来源）+ 尚无考据的资产 + 现有考证大纲。

    要做考证大纲（propose_research_outline）之前先调它——大纲是从已有条目里
    聚类、再补上没人认领的时代事实，不看现状就切主题等于拍脑袋。用户问
    「现在考据到什么程度了 / 还缺什么」也用它回答。
    """
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    if not thread_id:
        return "无法定位当前项目：会话上下文缺少 thread_id"
    pid = projects.project_id_of_thread(thread_id)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    report = imgresearch.build_report(pid)
    outline = imgresearch.build_outline_report(pid)
    assets = imgresearch.canvas_assets(pid)
    if not assets:
        return "画布上还没有命名过的资产卡——先建资产卡（拆解剧本或手动建），再谈考据。"

    lines = [
        f"项目：{report['projectName'] or '未命名'}"
        f" · 时代口径：{report['era'] or '未设置（set_project_era 记下才能跨项目复用考据）'}"
        f" · 资产 {len(assets)} 个 · 已有考据 {len([e for e in report['entries'] if e['assetType'] != 'topic'])} 条"
    ]
    lines.append("")
    lines.append("一、画布资产（node_id 取这里的）")
    for a in assets:
        lines.append(f"- {a['nodeId']} {a['title']}（{a['nodeType']}）")

    asset_entries = [e for e in report["entries"] if e["assetType"] != "topic"]
    lines.append("")
    lines.append(f"二、已有考据条目（{len(asset_entries)} 条，全文）")
    if not asset_entries:
        lines.append("（无——还没做过参考图调研，或调研失败）")
    for e in asset_entries:
        doms = "、".join(
            str(s.get("domain") or "") for s in e["sources"] if isinstance(s, dict)
        )
        lines.append(f"■ {e['assetName']}（{e['assetType']}）" + (f" 来源：{doms}" if doms else ""))
        lines.append(str(e["body"]).strip())

    if report["missing"]:
        lines.append("")
        lines.append(f"三、尚无任何考据的资产（{len(report['missing'])} 个）")
        for m in report["missing"]:
            lines.append(f"- {m['title']}（{m['nodeType']}）")

    lines.append("")
    lines.append(f"四、现有考证大纲：{len(outline['topics'])} 个主题")
    if outline["topics"]:
        for t in outline["topics"]:
            serves = "、".join(s["title"] for s in t.get("serves") or [])
            lines.append(
                f"- {t['title']}（{t['status']}）服务：{serves or '（未绑定卡）'}"
                + (f" 检索词：{' · '.join(t['queries'])}" if t["queries"] else "")
            )
    else:
        lines.append("（还没建大纲）")
    if outline["uncovered"]:
        lines.append(
            "未被任何主题覆盖的资产：" + "、".join(a["title"] for a in outline["uncovered"])
        )
    # 五、同题材可复用主体：别的项目已经考据过同一件事的现成成果
    _, era = imgresearch._project_scope(pid)
    library = imgresearch.list_library(era, project_id=pid) if era else []
    lines.append("")
    if not era:
        lines.append(
            "五、同题材可复用主体：本项目未设时代口径（set_project_era）——库不可用，"
            "调研产出也不会进复用域。真实题材先记下年代；架空/穿越不用设。"
        )
    elif not library:
        lines.append(f"五、同题材可复用主体：「{era}」下暂无（别的项目也没做过）")
    else:
        free = [i for i in library if not i["used"]]
        lines.append(
            f"五、同题材可复用主体（{len(library)} 条 · 本项目未引用 {len(free)} 条）"
            "——已考据过的不必重搜，用 import_research 引用："
        )
        for i in library[:20]:
            label = i["assetName"] or i["topicKey"]
            n_ref = f" · 图 {i['refCount']} 张" if i["refCount"] else ""
            lines.append(
                f"- {label}（{'时代主题' if i['kind'] == 'topic' else i['assetType']}"
                f" · 来自《{i['fromProject'] or '已删项目'}》{n_ref}"
                f"{' · 本项目已引用' if i['used'] else ''}）id={i['id']}"
            )
    return "\n".join(lines)


@tool
async def propose_research_outline(topics_json: str, config: RunnableConfig) -> str:
    """写/改本项目的考证大纲（整份替换）：把考据需求切成若干主题，每个主题写明为什么、检索词、服务哪些卡。

    调研的单位是「题材/时代」不是「资产」——同一时代的事实（服制、发式、
    宫室形制、器物）被几十张卡共享，按资产各搜一遍既是浪费、又会搜出互相
    矛盾的结论。先调 get_research_material 看现状，再切主题：

    1. 已有条目里内容重叠的一组卡 → 收成一个主题（它们的事实本来就是一套）；
    2. 没有任何卡认领的时代共有事实 → 必须单独成主题（这类影响面最大，
       旧流程里因为「不属于任何单个资产」而无人做）；
    3. 只影响一张卡、且没有时代共性的 → 不必进大纲（**但它的参考图仍要走
       research_asset_references**——「不进大纲」不等于「不做考据」）。

    **本工具排的是主题计划；主题执行时文字与时代参考图一起产**：文字事实注入
    提示词，参考池（该时代搜下来的一批实物参考）发给该主题的**全部成员卡**——
    同框角色的形制因此同源。**资产自己的参考图仍是另一条路**：用
    research_asset_references 单独发起（一次带全部资产，管「这个角色长什么样」）。
    大纲跑完 ≠ 每个资产的参考图有了——真实题材两条都要走（091101 武则天项目
    事故：只跑大纲，全片没有一张实物参考）。

    整份替换语义：每次提交的都是项目当前完整的计划，不要只提交增量。切完把
    大纲讲给用户听（哪几个主题、分别服务哪些卡、先做哪个），用户确认后再
    run_research_outline；主题切法与优先级判断见 real-documentary 手册「考证大纲」节。

    Args:
        topics_json: 主题数组 JSON 文本：
            [{"title":"主题名（如「北魏早期服制」）","rationale":"为什么需要（影响哪些卡/不做会错在哪）","queries":["检索词1","检索词2"],"nodeIds":["画布节点id"]}]
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
        topics = json.loads(topics_json)
        if not isinstance(topics, list):
            return "topics_json 必须是数组 JSON"
    except json.JSONDecodeError as e:
        return (
            f"topics_json 不是合法 JSON：{e}——JSON 到 ] 即止，"
            "不要在 JSON 后追加说明文字。修正后原样重发。"
        )
    try:
        imgresearch.replace_topics(pid, topics)
    except ValueError as exc:
        return str(exc)
    outline = imgresearch.build_outline_report(pid)
    lines = [f"考证大纲已更新：{len(outline['topics'])} 个主题（整份替换）"]
    for t in outline["topics"]:
        serves = "、".join(s["title"] for s in t.get("serves") or [])
        lines.append(
            f"- {t['title']}｜服务 {len(t.get('serves') or [])} 张卡"
            f"{f'（{serves}）' if serves else ''}"
        )
    if outline["uncovered"]:
        lines.append(
            "未被任何主题覆盖的资产：" + "、".join(a["title"] for a in outline["uncovered"])
            + "——要么给它们立主题，要么在回复里说明为什么不考据。"
        )
    lines.append(
        "画布上会有一张考证大纲卡（人读版）。请把大纲讲给用户：" 
        "哪几个主题、各服务哪些卡、先做哪个（按服务卡数排优先级），请他确认或增删。"
    )
    return "\n".join(lines)


@tool
async def run_research_outline(topic_keys_json: str, config: RunnableConfig) -> str:
    """执行考证大纲的主题（缺省执行全部未完成的）：逐主题搜网络取证，结果落项目考据条目。

    用户确认大纲后调用。同题材已考据过的主题会自动复用（不再重搜），状态可
    用 get_research_material 或画布上的考证大纲卡查看。完成后各资产出图时
    自动带上所属主题的考据依据。切主题之前先 `list_research_library` 看一眼
    库里有什么——库里已有的主体直接用 import_research 引用，不必立主题重搜。

    **主题执行会同时产出两样东西**：① 该时代的**文字事实**（注入成员资产的出图
    提示词）；② 该时代的**实物参考池**——用主题检索词搜图 → 下载 → 模型终选，
    归档进主题图集、**服务该主题的全部成员卡**（同一批实物参考发给所有成员，
    这是「十二个大臣戏里同框、官服形制却各挑各的互斥」的解法）。因此比只跑文字
    贵：每个主题约 3 次搜索 + 最多 12 张候选下载 + 1 次选图模型调用；已有图集的
    主题不重搜（幂等）。汇报时如实说清这个量级，别让用户以为是纯文字。
    **资产级参考图仍要单独发起**（research_asset_references）：主题图集是时代
    共性参考（形制、陈设、妆容），「这个角色长什么样」（选角、脸）得按资产搜——
    两条不是替代关系，别互相顶替。

    Args:
        topic_keys_json: 要执行的主题名数组 JSON（如 ["北魏早期服制"]）；
            传 "[]" 表示执行全部未完成的主题。
    """
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    if not thread_id:
        return "无法定位当前项目：会话上下文缺少 thread_id"
    pid = projects.project_id_of_thread(thread_id)
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    if not imgresearch.list_topics(pid):
        return "项目还没有考证大纲——先调 get_research_material 看现状，再调 propose_research_outline 切主题。"
    try:
        raw = json.loads(topic_keys_json) if topic_keys_json.strip() else []
        if not isinstance(raw, list):
            return "topic_keys_json 必须是数组 JSON"
    except json.JSONDecodeError as e:
        return f"topic_keys_json 不是合法 JSON：{e}"
    keys = [str(k).strip() for k in raw if str(k).strip()]
    if keys:
        known = {t["topicKey"] for t in imgresearch.list_topics(pid)}
        unknown = [k for k in keys if k not in known]
        if unknown:
            return (
                f"大纲里没有这些主题：{'、'.join(unknown)}；"
                f"现有主题：{'、'.join(sorted(known))}"
            )
    started = imgresearch.run_topics(pid, keys or None)
    if not started:
        return "没有可执行的主题（都已完成，或大纲为空）。"
    return (
        f"已开始执行 {len(started)} 个主题：{'、'.join(started)}。"
        "逐主题搜网络取证，完成后自动落考据条目（重启不丢，跨项目可复用）；"
        "进度与结果见画布上的考证大纲卡，用户问进展时用 get_research_material 查。"
        "执行期间可以继续聊别的，完成后我会收到通知。"
    )


@tool
async def start_deep_research(
    topic: str, brief: str, depth: str, config: RunnableConfig
) -> str:
    """就一个题材/问题发起深度调研（多轮 Google 搜索取证 → 结构化调研卷宗）。

    用户要选题论证、背景资料、史实核实、人物/事件深挖时调用（「帮我调研X」
    「查查X的资料」「X到底是怎么回事」）；闲聊、画布内已有答案、找参考图
    （那是 research_asset_references）时不要调用。

    **史实深度调研永远由用户发起**——制作链的资产考据站（参考图调研 /
    考证大纲）不用它，「开始制作」这类指令也不含它；用户没说要做史实核查
    时发起本工具是事故（a768423e2069：调研二义被抢答）。

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


@tool
async def cancel_research(job_id: str) -> str:
    """取消一个深度调研任务（仅运行中可取消）。

    启动错了方向（如用户要的是资产参考图考据、你启动了史实深度调研）、
    或用户改主意说"别查了"时立即调用——别让任务留在后台空跑烧搜索配额。
    已集来源与事实会保留，之后可对它发起补研。
    注：还在 planning 态（开题未确认）的任务直接弃置即可、无需取消——
    未确认不会开始执行、不消耗搜索。

    Args:
        job_id: start_deep_research 返回的任务 id。
    """
    try:
        research.cancel_research(job_id.strip())
    except ValueError as e:
        return str(e)
    return f"已请求取消调研任务 {job_id}（轮间生效，状态会翻到已取消）；已集材料保留可补研。"


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


def _msg_text(m: Any) -> str:
    """消息文本长度（token 保守估算：中文约 1-1.5 字/token，按字符数计偏高
    不偏低——压缩宁可早不可晚）。多模态 content 取文本块拼接。"""
    c = getattr(m, "content", m)
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(
            b.get("text", "") for b in c if isinstance(b, dict) and isinstance(b.get("text"), str)
        )
    return str(c or "")


async def _fold_into_summary(prev_summary: str, messages: List[Any]) -> str:
    """把一批旧消息并入滚动摘要（≤1500 字）：保留关键事实、已定决策、
    实体设定与用户偏好，丢寒暄与过程性工具往返。"""
    model = ChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-flash"),
        base_url=os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ.get("AGENT_API_KEY", ""),
        temperature=0.2,
        max_tokens=2048,
        streaming=False,
        **({"extra_body": {"thinking": {"type": "enabled"}}} if _thinking_enabled() else {"reasoning_effort": "none"}),
    )
    lines = "\n".join(f"[{getattr(m, 'type', '?')}] {_msg_text(m)[:600]}" for m in messages)
    # 固定四段结构（gemini <task_state> + opencode Work State/Next Move 范式）：
    # 「未完成事项」是防半途而废的关键段——长任务跨压缩续跑靠它，自由散文
    # 摘要会丢；末句借鉴 opencode「不带走就丢失」给摘要模型压力。
    prompt = (
        "把「已有摘要」与「新增对话片段」合并成一份不超 1500 字的滚动摘要，"
        "输出固定四段（段名照抄，无内容也要留段名）：\n"
        "## 目标与偏好（用户要什么、口味与约束）\n"
        "## 已定设定与决策（实体名与关系、拍板过的方向与关键事实）\n"
        "## 未完成事项（进行到哪一步 ←当前焦点、剩余步骤、被什么打断）\n"
        "## 关键上下文（续接必须知道的：画风/模型/项目名等）\n"
        "丢弃寒暄、失败重试过程、工具调用细节。摘要会成为后续唯一记忆——"
        "没写进来的下一轮就没了。直接输出摘要正文。"
        f"\n\n已有摘要：\n{prev_summary or '（无）'}\n\n新增对话片段：\n{lines[:60000]}"
    )
    try:
        resp = await model.ainvoke([("user", prompt)])
        out = str(resp.content or "").strip()
        return out[:3000] or prev_summary
    except Exception:  # noqa: BLE001
        return prev_summary  # 压缩失败保原状，下轮再试


async def _compress_history(
    summary: str, summary_count: int, messages: List[Any]
) -> tuple[str, int, dict]:
    """超阈值时把较旧的消息折叠进滚动摘要。返回 (新摘要, 新计数, state 增量)。
    阈值 CHAT_COMPRESS_THRESHOLD_TOKENS（默认 400k，字符数近似 token 上界）；
    触发后保留最近约 40% 预算的消息原文，其余并入摘要。"""
    threshold = max(int(os.environ.get("CHAT_COMPRESS_THRESHOLD_TOKENS", "400000")), 20000)
    visible = messages[summary_count:]
    est = sum(len(_msg_text(m)) for m in visible) + len(summary)
    if est < threshold or len(visible) <= 8:
        return summary, summary_count, {}
    keep_budget = int(threshold * 0.4)
    acc = 0
    boundary = len(visible)  # visible[boundary:] 为保留的最近消息
    for i in range(len(visible) - 1, -1, -1):
        acc += len(_msg_text(visible[i]))
        if acc > keep_budget and (len(visible) - i) >= 6:
            boundary = i + 1
            break
        boundary = i
    if boundary <= 0:
        return summary, summary_count, {}
    to_fold = visible[:boundary]
    # 折叠边界不切开 tool 配对：assistant(tool_calls) 与其 tool 响应同进退
    while to_fold and getattr(to_fold[-1], "type", "") == "ai" and getattr(to_fold[-1], "tool_calls", None):
        to_fold.pop()
        boundary -= 1
    if not to_fold:
        return summary, summary_count, {}
    new_summary = await _fold_into_summary(summary, to_fold)
    new_count = summary_count + boundary
    return new_summary, new_count, {
        "history_summary": new_summary,
        "summary_count": new_count,
    }


async def generate_thread_title(user_text: str, assistant_text: str) -> str:
    """会话自动命名：首组对话 → 6-14 字中文标题。一次性小调用走主循环同款
    模型通道（聊天基础设施，与「聊天主循环豁免 Langflow」同族；不做 flow）。
    失败返回空串，调用方保留原标题。"""
    # thinking_kwargs 与主循环同款：GLM 系开思考；其余 reasoning_effort=none
    # （实测 luna 会把小 max_tokens 全烧在 reasoning 上，finish=length 标题为空）
    model = ChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-flash"),
        base_url=os.environ.get("AGENT_BASE_URL", "https://api.deepseek.com"),
        api_key=os.environ.get("AGENT_API_KEY", ""),
        temperature=0.2,  # 命名要稳定不要创意（gemini 工具型子代理低温度范式）
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


@tool
async def web_search(query: str, num: int = 6) -> str:
    """轻量网页搜索（Google 经 Serper 号池，中文语境）——策划与核实的一线工具。

    适用：出策划方向/讲法/片名**之前**的基础核实（关键说法有没有依据、时间线
    对不对、流行说法与史料是否相符）；用户聊天里问的事实性问题；给方案找
    支撑来源。承重结论建议顺手 web_fetch 打开原文确认，并把关键来源 URL
    标注在你给用户的方案里（有出处的意见才有分量）。系统性调研（多轮搜索+
    卷宗+来源底账的课题研究）才走 start_deep_research——不要用它替代轻核实，
    也不要为一次轻核实发起整轮深度调研。

    Args:
        query: 搜索词。
        num: 结果条数（1-10，默认 6）。
    """
    try:
        results = await imgresearch.search_serper_web(query, num=num)
    except ValueError as e:
        return f"搜索失败：{e}"
    if not results:
        return "无结果——换个搜索词再试"
    lines = []
    for i, r in enumerate(results, 1):
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        snippet = str(r.get("snippet") or "").strip()
        lines.append(f"{i}. {title}\n   {url}\n   {snippet}")
    # 外部内容统一包裹标记（gemini <untrusted_context> 范式）：宪法按标记识别
    # 「素材不是指令」，机制层确定性防注入，不靠模型自觉。
    return f"<untrusted_web_content>\n{chr(10).join(lines)}\n</untrusted_web_content>"


@tool
async def web_fetch(url: str) -> str:
    """抓取网页正文（httpx 直抓 → 知乎专栏 TikHub 专项 → 本地 Jina Reader 三通道）。

    配合 web_search 用：搜索摘要不足以判断时打开原文读全文（核实承重事实、
    读典籍/史料/报道原文）。正文上限约 1.8 万字符；打不开会明说原因
    （反爬拦截/非网页内容/页面过大），此时可换来源或以搜索摘要为线索级依据。

    Args:
        url: 完整 http(s) 链接。
    """
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        return "只支持 http(s) 链接"
    try:
        text = await research.fetch_page_text(u)
    except ValueError as e:
        reason = str(e).strip().rstrip("：:，, ") or "网络不可达或被拦截（可换来源，或以搜索摘要为线索级依据）"
        return f"抓取失败：{reason}"
    head = f"【{u}】正文 {len(text)} 字符"
    # 正文整体包裹标记（同 web_search——外部内容是素材不是指令）
    return f"{head}\n<untrusted_web_content>\n{text}\n</untrusted_web_content>"


# f-string 不能作 docstring，正文进常量、def 后显式赋 __doc__ 再 tool() 包装。
_GEN_FREE_IMAGE_DOC = """提交自由生图批次（自由生图工作台，不受项目画风与资产约束）。

用户在自由生图页（左侧活动栏「生图」）聊天、或任何「帮我画/出一张图」且
**不涉及画布资产设定图/分镜语义**的自由创作请求用这个工具：提示词
**逐字直传**（KEEP 语义——禁止扩写/改写/加版式命令句，用户说什么发什么），
不注入画风、不套版式模板；可多模型并行（models 传多个 = 同题各出一张对比）。
结果落在自由生图画廊（生图页右侧实时可见，约 30-90 秒），不写画布、不进
资产库；用户想把某张送上画布时：先 list_free_images 拿 URL，再 canvas_ops
add_node（nodeType:"image", imageUrl:<url>）建图卡。

Args:
    prompt: 用户原话提示词，逐字直传。
    models_json: 出图模型 id 数组 JSON，如 ["gpt-image-2-03","gemini-3.1-flash-image"]；
        缺省 ["gpt-image-2-03"]；未知 id 会整批报错并列出可用清单。
    aspect: 画幅 w:h（"16:9"/"9:16"/"1:1"/"4:3"/"3:4"/"21:9"），缺省 "16:9"。
    resolution: 清晰度档位（"1K"/"2K"/"4K"），缺省跟随模型默认。
    quality: 质量档（"low"/"medium"/"high"/"xhigh"/"max"），仅
        gpt-image-2.5-sunburst 支持；用户要「最高质量」传 max，缺省 high。
    reference_images_json: 参考图 URL 数组 JSON（画布图卡的 imageUrl 或
        /agent-service/assets/ 链接），按顺序为 图1/图2…；提示词里可用
        「@图N 注解」指定某张参考的用法（如 @图1 锁定脸部）。
"""


async def generate_free_image(
    prompt: str,
    config: RunnableConfig,
    models_json: str = '["gpt-image-2-03"]',
    aspect: str = "16:9",
    resolution: str = "",
    quality: str = "",
    reference_images_json: str = "[]",
) -> str:
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    pid = projects.project_id_of_thread(thread_id) if thread_id else ""
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    try:
        model_ids = json.loads(models_json)
        ref_urls = json.loads(reference_images_json)
        if not isinstance(model_ids, list) or not model_ids:
            return "models_json 必须是非空字符串数组 JSON"
        if not isinstance(ref_urls, list) or not all(isinstance(u, str) for u in ref_urls):
            return "reference_images_json 必须是字符串数组 JSON"
        batch = await free_images.create_batch(
            pid, prompt, aspect, resolution, quality, model_ids, ref_urls
        )
    except ValueError as exc:
        return f"提交失败：{exc}"
    except json.JSONDecodeError as exc:
        return f"参数不是合法 JSON：{exc}"
    names = []
    for it in batch["items"]:
        entry = next((m for m in models.IMAGE_MODELS if m["id"] == it["modelId"]), None)
        names.append(str(entry["label"]) if entry else it["modelId"])
    return (
        f"已提交自由生图批次（{len(batch['items'])} 个模型并行：{'、'.join(names)}），"
        "约 30-90 秒出图，结果实时出现在自由生图画廊（左侧活动栏「生图」页）；"
        "用户问进度/想看结果时用 list_free_images 查。"
    )


generate_free_image.__doc__ = _GEN_FREE_IMAGE_DOC
generate_free_image = tool(generate_free_image)


@tool
async def list_free_images(config: RunnableConfig, limit: int = 12) -> str:
    """查自由生图画廊（最近批次，新在前）。

    用户在自由生图页问「出了吗/刚才那张给我」、或要把自由生图结果送上画布
    （拿 imageUrl 去 canvas_ops 建图卡）时调用。每行含状态/模型/画幅/提示词/
    图片 URL；在途任务（queued/running）稍后再查。

    Args:
        limit: 返回条数（默认 12，上限 50）。
    """
    thread_id = ""
    if isinstance(config, dict):
        thread_id = str((config.get("configurable") or {}).get("thread_id") or "")
    pid = projects.project_id_of_thread(thread_id) if thread_id else ""
    if not pid:
        return "无法定位当前项目：当前会话未绑定画布项目"
    items = free_images.list_free_images(pid)[: max(1, min(int(limit or 12), 50))]
    if not items:
        return "自由生图画廊还没有记录（生图页或本工具 generate_free_image 都可以出图）。"
    status_word = {"queued": "排队中", "running": "生成中", "done": "已完成", "error": "失败"}
    lines = []
    for it in items:
        entry = next((m for m in models.IMAGE_MODELS if m["id"] == it["modelId"]), None)
        label = str(entry["label"]) if entry else it["modelId"]
        line = f"- [{status_word.get(it['status'], it['status'])}] {label}"
        if it.get("aspect"):
            line += f" · {it['aspect']}"
        line += f"：{(it.get('prompt') or '')[:60]}"
        if it.get("imageUrl"):
            line += f" → {it['imageUrl']}"
        if it.get("error"):
            line += f"（{it['error'][:80]}）"
        lines.append(line)
    return "\n".join(lines)


backend_tools = [list_langflow_skills, decompose_script, generate_storyboard, generate_asset_images, generate_look_images, generate_free_image, list_free_images, run_langflow_skill, read_skill, web_search, web_fetch, research_asset_references, get_reference_research_status, adopt_asset_references, list_research_library, import_research, get_research_material, propose_research_outline, run_research_outline, start_deep_research, confirm_research_plan, get_research_result, cancel_research]
backend_tool_names = {t.name for t in backend_tools}

# 允许模型调用的前端工具白名单（防止客户端注入无关工具）。
# read_node：系统提示两处指示模型用它在摘要截断时取卡片全文，必须在册
# 允许模型调用的前端工具白名单（防止客户端注入无关工具）。
# read_node：系统提示两处指示模型用它在摘要截断时取卡片全文，必须在册；
# propose_plan / update_plan：计划先行（多步任务先确认后执行、逐步打勾）；
# regenerate_card_image：卡上出图/改图（复用输入条直连管线，版本档案/派生新卡同源）
FRONTEND_TOOL_ALLOWLIST = {"canvas_ops", "canvas_query", "canvas_validate_ops", "read_node", "open_style_picker", "set_project_style", "regenerate_card_image", "propose_plan", "update_plan"}


# ---------- 多模态附件（图片/视频随消息上传） ----------

# 视觉模型名探测（AGENT_VISION_ENABLED=1/0 可强制覆盖）。
# 纯文本模型收到 image_url 块会 400，必须在净化阶段剥离。
# deepseek-flash 官方 2026-09-10 起多模态吃图（名字不带 vision，须显式收录）。
_VISION_MODEL_HINTS = (
    "vl", "vision", "4v", "gpt-4o", "gpt-4.1", "o3", "o4",
    "gemini", "claude", "pixtral", "internvl", "deepseek-flash",
)

def _vision_enabled() -> bool:
    explicit = (os.environ.get("AGENT_VISION_ENABLED") or "").strip().lower()
    if explicit:
        return explicit in ("1", "true", "yes", "on")
    model = (os.environ.get("AGENT_MODEL") or "deepseek-flash").lower()
    return any(h in model for h in _VISION_MODEL_HINTS)


def _thinking_enabled() -> bool:
    """思考模式开关：GLM 系默认开（网关认 thinking 参数）；换非思考模型时用
    AGENT_THINKING=0 关闭，反之 =1 强制开。"""
    explicit = (os.environ.get("AGENT_THINKING") or "").strip().lower()
    if explicit:
        return explicit in ("1", "true", "yes", "on")
    return "glm" in (os.environ.get("AGENT_MODEL") or "").lower()


def _chat_reasoning_kwargs() -> dict:
    """聊天主循环的思考档位（辅助小调用不在此列，仍 reasoning_effort=none
    ——会话命名等小 max_tokens 调用会被 reasoning 烧光导致输出为空）：
    - GLM 系：thinking:enabled（网关参数，无档位；AGENT_THINKING=0 可关）；
    - luna（DMX）：必须显式 none——reasoning_effort 与 function tools 同发
      即 400（"Function tools with reasoning_effort are not supported"），
      GLM 关思考时同发 none（智谱网关容忍该参数，沿用旧姿势）；
    - 其余（DeepSeek V4 官方）：medium（2026-09-07 用户拍板「打开中等思考」；
      实测与工具同发兼容，reasoning_content 经兼容层透传 REASONING 事件）。
    """
    model = (os.environ.get("AGENT_MODEL") or "").lower()
    if _thinking_enabled():
        return {"extra_body": {"thinking": {"type": "enabled"}}}
    if "luna" in model or "glm" in model:
        return {"reasoning_effort": "none"}
    return {"reasoning_effort": "medium"}


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
            # data: URL 是内嵌降级时的图块——兆级串进文本清单会撑爆请求，
            # 只标记不罗列（URL 清单的价值在可指代，不在可点开）
            if url.startswith("data:"):
                media.append(f"{_MEDIA_BLOCK_LABELS.get(btype, '媒体')}（历史内嵌图已省略）")
            else:
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
_EMBED_LONG_EDGE = 1280  # 视觉理解不需要原图分辨率（thumbs 512 太小，折中）
_EMBED_JPEG_Q = 5  # mjpeg 质量档（≈85），1280 边单图典型 150-400KB
# DMX 上游限制「单请求图片总量 ≤50MB」（2026-09-07 霸王龙项目 13 张设定图
# 全量原图内嵌 63MB 把 run 打 400，且消息留在历史里令会话永久毒化——后续
# 每轮重发同样的 63MB 全部失败）。降采样内嵌为主，总预算闸兜底：超预算的
# 旧图退回 URL 清单（文本里仍可见、可提及），不再内嵌。
_EMBED_TOTAL_MAX = 40 * 1024 * 1024
# 原图文件名随机 hex、内容不可变 → 降采样结果按文件名缓存，历史重放不重编码
_VISION_EMBED_CACHE: Dict[str, str] = {}


def _local_asset_to_data_url(url: str) -> str | None:
    name = Path(url).name
    cached = _VISION_EMBED_CACHE.get(name)
    if cached is not None:
        return cached
    src = skills.ASSETS_DIR / name
    if not src.is_file():
        return None
    try:
        r = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                "-vf",
                (
                    "scale=w=if(gt(iw\\,ih)\\,min(iw\\,%d)\\,-2)"
                    ":h=if(gt(iw\\,ih)\\,-2\\,min(ih\\,%d)):flags=lanczos"
                )
                % (_EMBED_LONG_EDGE, _EMBED_LONG_EDGE),
                "-frames:v", "1", "-c:v", "mjpeg", "-q:v", str(_EMBED_JPEG_Q),
                "-f", "image2pipe", "pipe:1",
            ],
            capture_output=True,
            timeout=30,
        )
        data = r.stdout if r.returncode == 0 and r.stdout else None
    except (OSError, subprocess.TimeoutExpired):
        data = None
    if not data:
        return None
    data_url = "data:image/jpeg;base64," + base64.b64encode(data).decode()
    if len(data_url) > 1024 * 1024:  # 降采样后仍异常大（超长图等），弃嵌
        return None
    _VISION_EMBED_CACHE[name] = data_url
    return data_url


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
# 提示词正文在 prompts/system.md（占位符用 string.Template 的 $name 语法，
# JSON 示例可直接写花括号，不必再数 {{ }}）。按 mtime 热加载：改提示词保存
# 即生效，不必重启 agent（与技能手册的 refresh 同款诉求）。
# ⚠ 维护提示词时：正文里要写字面 $ 必须写成 $$（如金额 $100 → $$100），否则
#   substitute 会把它当占位符，抛 ValueError（$ 后非法字符）或 KeyError（像变量名）。
_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "system.md"
_prompt_cache: Tuple[float, Template] | None = None

# chat_node 每轮 substitute 提供的占位符集合；system.md 里的占位符必须与之完全
# 一致——多了没人传（KeyError）、少了动态段静默丢失（画布摘要/技能目录不进 prompt）。
_PROMPT_PLACEHOLDERS = frozenset(
    {"canvas_summary", "camera_cheat", "skill_catalog", "history_section", "today"}
)


def load_system_prompt() -> Template:
    """读取系统提示模板；文件缺失或占位符不匹配时抛错明报，不静默降级。"""
    global _prompt_cache
    try:
        mtime = _PROMPT_PATH.stat().st_mtime
    except OSError as exc:
        raise RuntimeError(
            f"系统提示文件缺失：{_PROMPT_PATH}（{exc}）——提示词是 agent 的宪法，缺失即拒绝启动"
        ) from exc
    if _prompt_cache is None or _prompt_cache[0] != mtime:
        tmpl = Template(_PROMPT_PATH.read_text(encoding="utf-8"))
        # 占位符双向校验：装载时（启动 + 每次热重载）就炸，不留到第一轮对话
        # substitute 才暴露。get_identifiers() 需 Python ≥3.11（本项目 ≥3.12）。
        found = set(tmpl.get_identifiers())
        if found != _PROMPT_PLACEHOLDERS:
            missing = sorted(_PROMPT_PLACEHOLDERS - found)
            extra = sorted(found - _PROMPT_PLACEHOLDERS)
            parts = []
            if missing:
                parts.append(f"缺失(对应动态段会丢失) {missing}")
            if extra:
                parts.append(f"多余(chat_node 没传会 KeyError) {extra}")
            raise RuntimeError(
                f"系统提示占位符不匹配：{'；'.join(parts)}"
                f"——system.md 应与 chat_node 提供的 {sorted(_PROMPT_PLACEHOLDERS)} 完全一致"
            )
        _prompt_cache = (mtime, tmpl)
    return _prompt_cache[1]


# 启动即校验一次（缺文件/占位符写错在启动时就炸，而不是等第一轮对话）
load_system_prompt()


def _today_str() -> str:
    d = datetime.now()
    return f"{d.year}年{d.month}月{d.day}日 周{'一二三四五六日'[d.weekday()]}"



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
    """是否处于「等浏览器回传前端工具结果」状态：最后一条消息是 AIMessage
    且含未应答的前端调用（模型刚发完前端调用，本轮结束等浏览器执行）。

    只看尾部——历史中部滞留的未应答前端调用是陈旧轮次（刷新/断流丢了
    结果），据其中途 END 会把整条会话永久哑火（用户每发一条都被无声
    吞掉）；陈旧调用交由 _sanitize_messages_for_model 补占位继续走模型。
    """
    if not messages:
        return False
    last = messages[-1]
    if not (isinstance(last, AIMessage) and getattr(last, "tool_calls", None)):
        return False
    answered = {
        m.tool_call_id for m in messages if isinstance(m, ToolMessage)
    }
    for tc in last.tool_calls:
        tc_id, name = _tool_call_info(tc)
        if tc_id and name not in backend_tool_names and tc_id not in answered:
            return True
    return False


def _current_turn_start(messages: List[Any]) -> int:
    """当前用户轮的起始下标：最后一条 HumanMessage 往前的连续 HumanMessage 区段。

    工具往返中段（尾部是 AI tool_calls / ToolMessage）以最后一条 HumanMessage
    定位轮起点，本轮图片保持内嵌不中途降级。
    """
    last_human = -1
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage):
            last_human = i
            break
    start = last_human
    while start > 0 and isinstance(messages[start - 1], HumanMessage):
        start -= 1
    return start


def _reasoning_roundtrip_required() -> bool:
    """该 provider 是否**要求**历史 AIMessage 的 reasoning_content 回传。

    DeepSeek 官方思考档：**必须**回传——2026-09-11 实测，历史里「带 tool_calls 的
    助手消息 + 工具结果」（续写工具轨迹）若缺 reasoning_content，整轮 400
    `The reasoning_content in the thinking mode must be passed back to the API`
    （最小复现：带/[user, assistant(tool_calls 无 reasoning), tool] 必挂，
    带 reasoning 即通过；纯文本历史不带也行）。此前无差别剥除，是照着旧网关
    「拒未知字段」的结论写的——网关系（GLM/DMX）沿用剥除，DeepSeek 官方保留。
    """
    return "deepseek" in (os.environ.get("AGENT_BASE_URL") or "").lower()


def _sanitize_messages_for_model(messages: List[Any]) -> List[Any]:
    """清洗历史，保证模型侧永不 400：

    - assistant(tool_calls) ↔ tool 的合法交替：孤儿 tool 消息剔除、
      assistant 的 tool_call 缺响应时补占位响应
    - 纯文本模型：content 为多模态块数组的用户消息降级成纯文本
      （媒体块 → URL 清单，见 _flatten_media_message）
    - 视觉内嵌只保留当前用户轮：历史轮次的图片一律退 URL 清单——19 张
      历史内嵌图实测把模型拖进「素材投喂等指令」帧，连最新一条明示指令
      都不认、逐轮复读「未检测到制作指令」（2026-09-07 霸王龙事故）；
      URL 清单对模型完全够用（干活本来就靠清单里的 URL），当轮新到的
      图才是视觉理解的刚需
    - AIMessage 的 reasoning_content：**按 provider 分流**——DeepSeek 官方思考档
      要求回传（缺失即 400「must be passed back」，见 _reasoning_roundtrip_required）；
      GLM/DMX 网关系沿用剥除（旧的「不被 API 接受」结论只对网关成立）
    """
    flatten_media = not _vision_enabled()
    turn_start = _current_turn_start(messages)
    result: List[Any] = []
    pending: Dict[str, str] = {}
    for i, m in enumerate(messages):
        ak = getattr(m, "additional_kwargs", None)
        if (
            not _reasoning_roundtrip_required()
            and isinstance(m, AIMessage)
            and isinstance(ak, dict)
            and "reasoning_content" in ak
        ):
            m = m.model_copy(
                update={
                    "additional_kwargs": {
                        k: v for k, v in ak.items() if k != "reasoning_content"
                    }
                }
            )
        if isinstance(m, ToolMessage):
            tc_id = getattr(m, "tool_call_id", None)
            if tc_id and tc_id in pending:
                result.append(m)
                del pending[tc_id]
            # 孤儿 tool 响应 → 跳过
            continue
        # 任何非 ToolMessage 消息（含下一条 AI(tool_calls)）都收口配对窗口：
        # 占位响应必须补在 assistant(tool_calls) 与下一条 assistant 之间，
        # 拖到序列末尾会留下非法交替（090702 凤临天下事故：混合调用
        # canvas_ops+decompose_script 里后端调用被跳过、模型下轮重发，
        # 占位补在结尾，中段 AI(mixed)→AI(reissue) 交替非法，会话 400 永久毒化）
        if pending:
            for tc_id, name in list(pending.items()):
                result.append(
                    ToolMessage(
                        content=f"（工具 {name} 本轮未执行，已跳过）",
                        tool_call_id=tc_id,
                    )
                )
            pending.clear()
        if isinstance(m, AIMessage) and getattr(m, "tool_calls", None):
            result.append(m)
            for tc in m.tool_calls:
                tc_id, name = _tool_call_info(tc)
                if tc_id:
                    pending[tc_id] = name or ""
        elif isinstance(m, HumanMessage) and isinstance(m.content, list):
            result.append(
                _embed_local_media(m)
                if not flatten_media and i >= turn_start
                else _flatten_media_message(m)
            )
        else:
            result.append(m)
    for tc_id, name in pending.items():
        result.append(
            ToolMessage(
                content=f"（工具 {name} 本轮未执行，已跳过）", tool_call_id=tc_id
            )
        )
    # 收尾守卫：入参**以助手消息结尾**时丢掉尾部的助手消息（2026-09-11 实测）。
    # 思考档 + 绑 tools 时，历史里没有 reasoning_content 的助手消息即 400
    # （`The reasoning_content in the thinking mode must be passed back`）；
    # 正常流程永远不会以助手消息结尾（用户/工具结果最后说话），只有客户端重投
    # 与 checkpoint 合并后才会出现这种形状——它本就是「续写自己上一条」的协议
    # 产物，删掉即回到合法边界（新一轮由谁提问由调用方决定）。
    while result and isinstance(result[-1], AIMessage) and not getattr(result[-1], "tool_calls", None):
        result.pop()
    return result


def _cap_embedded_media(messages: List[Any], budget: int) -> List[Any]:
    """内嵌图片总量闸（DMX 上游限 50MB/请求）：从最新往旧累计 data URL 字节，
    超预算的消息整体退回纯文本视图（图变 URL 清单/省略标记），旧图让位新图。
    毒历史免疫：无论历史里堆了多少图消息，请求字节恒有上界。"""
    total = 0
    # 最新往旧决定「保留谁」
    keep: Dict[int, int] = {}
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        content = getattr(m, "content", None)
        if not (isinstance(m, HumanMessage) and isinstance(content, list)):
            continue
        size = sum(
            len((b.get("image_url") or {}).get("url", ""))
            for b in content
            if isinstance(b, dict) and str(b.get("type", "")) == "image_url"
            and isinstance(b.get("image_url"), dict)
        )
        if not size:
            continue
        if total + size > budget:
            break  # 再旧的一并放弃（旧消息的图对当前轮最不重要）
        total += size
        keep[i] = size
    if not keep:
        return messages
    return [
        m if i in keep else (_flatten_media_message(m) if isinstance(m, HumanMessage) else m)
        for i, m in enumerate(messages)
    ]


def _has_model_output(m: Any) -> bool:
    """模型响应是否有可用产出：非空正文（文本块）或工具调用。"""
    text = _msg_text(m)
    return bool(text.strip() or getattr(m, "tool_calls", None))


def _shape_dump(messages: List[Any]) -> str:
    """入参形状摘要（诊断用，**不含正文**）：每条消息的类型/长度/有无工具调用/
    有无 reasoning_content——provider 契约类 400 定位靠它（哪个位置缺了什么）。"""
    parts: List[str] = []
    for i, m in enumerate(messages):
        ak = getattr(m, "additional_kwargs", None) or {}
        tcs = getattr(m, "tool_calls", None) or []
        t = getattr(m, "type", "?")
        tags = [f"{i}:{t}", f"{len(_msg_text(m))}字"]
        if tcs:
            tags.append(f"tc={len(tcs)}")
        if isinstance(ak, dict) and "reasoning_content" in ak:
            tags.append("reasoning✓")
        if t == "tool":
            tags.append("tool_res")
        parts.append("|".join(tags))
    return " ".join(parts)


def _is_repeat_tool_call(messages: List[Any], response: Any) -> bool:
    """本次工具调用与历史上最近一次同工具调用的参数是否完全相同（空转信号）。
    只返回布尔供埋点——参数本身不入库（埋点不记正文铁律）。"""
    calls = getattr(response, "tool_calls", None) or []
    if not calls:
        return False

    def _sig(tc: Any) -> tuple[str | None, str]:
        if isinstance(tc, dict):
            name = tc.get("name")
            args = tc.get("args")
        else:
            name = getattr(tc, "name", None)
            args = getattr(tc, "args", None)
        try:
            return name, json.dumps(args or {}, sort_keys=True, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            return name, repr(args)

    name, sig = _sig(calls[0])
    for m in reversed(messages):
        if not isinstance(m, AIMessage):
            continue
        for prev in getattr(m, "tool_calls", None) or []:
            pname, psig = _sig(prev)
            if pname == name:
                return psig == sig
    return False


async def chat_node(state: AgentState, config: RunnableConfig) -> Command:
    messages = list(state.get("messages") or [])

    # 有未响应的前端工具调用（含混合调用场景）→ 等浏览器执行回传
    if _unanswered_frontend_calls(messages):
        return Command(goto=END, update={})

    # 思考/推理档位见 _chat_reasoning_kwargs：GLM 系 thinking:enabled；
    # luna 必须 none（DMX 的 reasoning_effort+function tools 即 400）；
    # DeepSeek 官方 medium（用户拍板「打开中等思考」）
    thinking_kwargs = _chat_reasoning_kwargs()
    model = _OneShotToolArgsCompatChatOpenAI(
        model=os.environ.get("AGENT_MODEL", "deepseek-flash"),
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
    # 长对话滚动压缩：前 summary_count 条已折叠进 history_summary（超
    # CHAT_COMPRESS_THRESHOLD_TOKENS，默认 400k 字符近似，触发时保留最近
    # ~40% 原文、其余并入摘要——替代旧的 messages[-14:] 硬截断：阈值内
    # 全量原文可见，超阈值旧内容以摘要形态续命而不是直接失明）
    summary = str(state.get("history_summary") or "")
    summary_count = int(state.get("summary_count") or 0)
    summary, summary_count, comp_update = await _compress_history(
        summary, summary_count, messages
    )
    history_section = (
        f"\n## 更早对话的摘要（已压缩——据此理解前文指代与既定决策，并续接「未完成事项」段列出的工作，不重复已完成的部分）\n{summary}\n"
        if summary
        else ""
    )
    system_message = SystemMessage(
        content=load_system_prompt().substitute(
            canvas_summary=canvas_summary,
            camera_cheat=camera.camera_cheat_sheet(),
            skill_catalog=SKILL_CATALOG,
            history_section=history_section,
            today=_today_str(),
        ),
    )

    # 未压缩窗口 + 清洗交替（孤儿 tool / 缺响应的 call）防止模型侧 400。
    # 画布摘要只随 system prompt 注入一次（每轮重建，值恒为最新，无需末尾再放）
    trimmed = _sanitize_messages_for_model(messages[summary_count:])
    trimmed = _cap_embedded_media(trimmed, _EMBED_TOTAL_MAX)

    # 流式聚合：必须用 astream 而非 ainvoke——ag-ui 桥的 TEXT_MESSAGE_CONTENT
    # 靠 on_chat_model_stream 事件逐 token 下发，ainvoke 是单次非流式请求，
    # 整段回复憋到节点结束才一次性吐出（前端表现为"没有打字机效果"）。
    # 聚合后的完整消息照常入 state/checkpoint，图逻辑与 ainvoke 等价。
    # 空响应 nudge 重试（gemini geminiChat 范式）：模型偶发只思考不出字/
    # 断流零内容——nudge 以 user 提醒打在对话末尾重试（不动系统提示，保
    # 前缀缓存；只进本次请求不落 checkpoint），3 次全空才报错。
    merged: AIMessageChunk | None = None
    nudge_retries = 0
    for attempt in range(3):
        attempt_msgs = [system_message, *trimmed]
        if attempt > 0:
            attempt_msgs.append(
                HumanMessage(
                    content=(
                        "[系统提醒] 你上一跳没有输出正文，也没有调用工具。"
                        "请正常回复用户，或调用工具继续任务。"
                    )
                )
            )
        merged = None
        # WS_DEBUG_SHAPE=1：每次调用前转储入参形状（诊断 provider 契约类 400 用，
        # 只打类型/长度/有无 tool_calls 与 reasoning，不含正文；默认关、零开销）
        if os.environ.get("WS_DEBUG_SHAPE"):
            print(f"[模型入参] 第{attempt + 1}跳 | {_shape_dump(attempt_msgs)}", flush=True)
        try:
            async for chunk in model_with_tools.astream(attempt_msgs, config):
                merged = chunk if merged is None else merged + chunk
        except Exception as exc:  # noqa: BLE001
            # 模型侧报错时留下一份入参形状摘要：provider 契约类 400（如 DeepSeek
            # 思考档要求 reasoning_content 回传）不看入参形状几乎无法定位——
            # 栈里只有「哪一行调了模型」，看不出哪条消息缺了什么。
            print(f"[模型入参] {type(exc).__name__} | {_shape_dump(attempt_msgs)}", flush=True)
            raise
        if merged is not None and _has_model_output(merged):
            break
        nudge_retries += 1
    if merged is None or not _has_model_output(merged):
        raise RuntimeError("模型连续 3 次未返回内容（空响应，nudge 重试后仍空）")
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

    # 行为遥测（粗粒度计数，不含正文/参数——「懒」的量化基础）
    events.track(
        "agent.step",
        {
            "tools": len(call_names),
            "frontend": has_frontend_call,
            "backend": has_backend_call,
            "chars": len(_msg_text(response)),
            "nudge_retries": nudge_retries,
            "repeat_call": _is_repeat_tool_call(messages, response),
            "compressed": bool(comp_update),
        },
    )

    # 前端工具调用优先：本轮立即结束交给浏览器执行。若同一消息还混着后端
    # 调用，则后端调用本轮不执行（历史清洗会给它补占位响应，模型下一轮
    # 重新发起）。绝不能把含前端调用的消息送进 ToolNode——它不认识前端
    # 工具，会以"invalid tool"错误响应，破坏交替并误导模型。
    if has_frontend_call:
        return Command(goto=END, update={"messages": [response], **comp_update})

    if has_backend_call:
        return Command(goto="tool_node", update={"messages": [response], **comp_update})

    # 纯文本回复 → 结束
    return Command(goto=END, update={"messages": [response], **comp_update})


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
