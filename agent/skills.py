"""Langflow 技能执行器：把已有 flow 当作主 Agent 的 HTTP 工具调用。

调用统一走 v1 阻塞式 run API（/api/v1/run/{flow_id}）：
工具型调用需要完整结果，阻塞拿全量比 agui 事件流收集可靠
（纯链式 flow 在 agui 协议下不产生 TEXT_MESSAGE 事件）。
"""

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field, ValidationError, model_validator
from typing_extensions import Literal

import imagejobs
import models
import thumbs
import usage

LANGFLOW_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")
LANGFLOW_API_KEY = os.environ.get("LANGFLOW_API_KEY", "")
DECOMPOSE_FLOW_ID = os.environ.get("LANGFLOW_DECOMPOSE_FLOW_ID", "")
# 分类型拆解 flow（ai-moive-studio 范式：角色/场景/道具各自独立调用，
# 单次输出小、按类型定制提示词、三路并发、单类失败不拖累其他）
DECOMPOSE_FLOW_IDS = {
    "character": os.environ.get("LANGFLOW_DECOMPOSE_CHARACTER_FLOW_ID", ""),
    "scene": os.environ.get("LANGFLOW_DECOMPOSE_SCENE_FLOW_ID", ""),
    "prop": os.environ.get("LANGFLOW_DECOMPOSE_PROP_FLOW_ID", ""),
    "costume": os.environ.get("LANGFLOW_DECOMPOSE_COSTUME_FLOW_ID", ""),
}
# 资产类型 → 中文标签（清单文案/提示词共用；与前端卡型一一对应）
ASSET_TYPE_LABELS = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
    "costume": "服饰",
}

def _parse_shot_rows(text: str) -> list[dict]:
    """从 flow 输出文本中解析分镜 JSON 数组（容错：剥围栏、截取首尾括号）。

    解析失败带上原文片段——本函数常收到 run_flow_blocking 的错误文案
    （截括号会截出 "[Errno ...]" 之类），不带上下文的报错无法定位真因。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip()
        if t.startswith("json"):
            t = t[4:].lstrip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end <= start:
        raise ValueError(f"输出里没有 JSON 数组。原始输出前 120 字：{t[:120]}")
    try:
        arr = json.loads(t[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"分镜 JSON 解析失败（{exc}），截取片段开头：{t[start : start + 120]}"
        ) from exc
    rows = []
    for i, it in enumerate(arr):
        if not isinstance(it, dict):
            continue
        # 每行资产名数组（novanova referenceKey 范式的名字版）：乱给/缺给都
        # 容忍——上游 start_storyboard_gen_job 会按名单二次校验
        raw_assets = it.get("assets")
        assets_list = (
            [str(a).strip() for a in raw_assets if str(a).strip()]
            if isinstance(raw_assets, list)
            else []
        )
        rows.append(
            {
                "rid": f"r{i + 1}",
                "shotSize": str(it.get("shotSize") or ""),
                "cameraMove": str(it.get("cameraMove") or ""),
                "duration": str(it.get("duration") or ""),
                "action": str(it.get("action") or ""),
                "lighting": str(it.get("lighting") or ""),
                "sound": str(it.get("sound") or ""),
                "dialogue": str(it.get("dialogue") or ""),
                "assets": assets_list,
            }
        )
    return rows


# 分镜表生成任务表：jobId -> {"status": running|done, "rows"| "error"}
STORYBOARD_GEN_JOBS: Dict[str, Dict[str, Any]] = {}


def get_storyboard_gen_job(job_id: str) -> Optional[Dict[str, Any]]:
    return STORYBOARD_GEN_JOBS.get(job_id)


async def run_storyboard_flow(
    script: str,
    shot_count: Optional[int] = None,
    duration_seconds: Optional[int] = None,
    visual_style: str = "",
    assets: Optional[List[Dict[str, Any]]] = None,
    model: str = "",
) -> List[Dict[str, Any]]:
    """跑分镜生成 flow 并返回结构化 rows（HTTP job 与聊天工具共用的核心）。

    失败抛 RuntimeError（调用方决定明报形态）；rows 内 assets 已按名单
    二次校验剔除幻觉名。model：空=目录默认文本模型。
    """
    flow_id = os.environ.get("LANGFLOW_SHOTLIST_FLOW_ID", "")
    if not flow_id:
        raise RuntimeError("未配置 LANGFLOW_SHOTLIST_FLOW_ID")

    parts = []
    if shot_count:
        parts.append(f"镜头数：{int(shot_count)}")
    if duration_seconds:
        parts.append(f"单镜时长：{int(duration_seconds)} 秒")
    if str(visual_style or "").strip():
        parts.append(f"全局视觉风格：{str(visual_style).strip()}")
    assets = assets or []
    label = ASSET_TYPE_LABELS
    entries = [
        f"- [{label.get(a.get('type'), a.get('type'))}] {a.get('name')}"
        for a in assets
        if str(a.get("name") or "").strip()
    ]
    if entries:
        parts.append("已有资产名单：")
        parts.extend(entries)
    parts.append("剧本：")
    parts.append(script)

    text = await run_flow_blocking(
        flow_id,
        input_value="\n".join(parts),
        tweaks={
            "LanguageModelComponent": {
                "temperature": 0.4,
                **models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID),
            }
        },
        timeout=900,
    )
    # run_flow_blocking 失败不抛错、返回全角括号错误文案（拆解同款守卫）：
    # 明报真因，不落到 _parse_shot_rows 里被截括号伪装成 JSON 解析错
    if text.startswith("（"):
        raise RuntimeError(text.strip("（）"))
    rows = _parse_shot_rows(text)
    # 结构化资产名按名单二次校验（novanova 强约束的名字版）：LLM 幻觉
    # 出的名字剔除，不报废整路；名单为空时一律清空（此时前端靠行文本
    # 全名兜底匹配画布资产）
    roster = {
        str(a.get("name")).strip()
        for a in (assets or [])
        if str(a.get("name") or "").strip()
    }
    for row in rows:
        row["assets"] = (
            [a for a in row.get("assets", []) if a in roster] if roster else []
        )
    return rows


async def start_storyboard_gen_job(
    script: str,
    shot_count: Optional[int] = None,
    duration_seconds: Optional[int] = None,
    visual_style: str = "",
    assets: Optional[List[Dict[str, Any]]] = None,
    model: str = "",
) -> str:
    """启动分镜表生成任务（异步：HTTP 端点立即返回 jobId，前端轮询）。

    model：文本模型覆盖（models.resolve_text_model 产物，空=flow 出厂模型），
    经 LanguageModelComponent 的 model_name 覆盖字段按组件名注入。
    """
    job_id = uuid.uuid4().hex[:12]
    STORYBOARD_GEN_JOBS[job_id] = {"status": "running", "rows": None, "error": None}

    async def run() -> None:
        state = STORYBOARD_GEN_JOBS[job_id]
        try:
            state["rows"] = await run_storyboard_flow(
                script,
                shot_count=shot_count,
                duration_seconds=duration_seconds,
                visual_style=visual_style,
                assets=assets,
                model=model,
            )
        except Exception as e:  # noqa: BLE001
            state["error"] = str(e)[:300]
        finally:
            state["status"] = "done"
        # 清理历史任务（保留最近 49 个已完成）
        done = [k for k, v in STORYBOARD_GEN_JOBS.items() if v["status"] == "done"]
        for k in done[:-49]:
            STORYBOARD_GEN_JOBS.pop(k, None)

    asyncio.create_task(run())
    return job_id
IMAGEGEN_FLOW_ID = os.environ.get("LANGFLOW_IMAGEGEN_FLOW_ID", "")
DMX_API_KEY = os.environ.get("DMX_API_KEY", "")
VOLC_SEARCH_API_KEY = os.environ.get("VOLC_SEARCH_API_KEY", "")
# 出图参考图回给 langflow 下载用的本机地址（/assets 未鉴权、文件名随机 hex）
AGENT_BASE_URL = os.environ.get("AGENT_BASE_URL", "http://127.0.0.1:8123")
# 本 agent 服务的资产基地址（/assets 未鉴权）。注意 AGENT_BASE_URL 是
# DeepSeek 聊天 API 的地址，别混用——历史上曾把参考图拼到 deepseek 域名上
ASSET_BASE_URL = os.environ.get("ASSET_BASE_URL", "http://127.0.0.1:8123")

# 生成图片的对外暴露目录（main.py 挂 /assets 端点，前端经 /agent-service/assets/ 访问）
ASSETS_DIR = Path(__file__).resolve().parent / "static" / "assets"

MAX_RESULT_CHARS = 1500


# ---------- 通用：阻塞式调用 ----------


class _TweakKeyError(Exception):
    """tweaks 逻辑键在 flow 里解析不出唯一节点（零个或多个命中）。"""


async def _resolve_tweak_keys(
    flow_id: str, tweaks: Dict[str, Any], headers: Dict[str, str]
) -> Dict[str, Any]:
    """把逻辑组件键解析成真实节点 id（langflow 只按节点 id / display_name
    精确匹配 tweaks 键，其他一律静默丢弃）。

    业务代码统一用组件名做键（如 LanguageModelComponent），实际节点 id 带
    随机后缀（LanguageModelComponent-nFbmO）、display_name 是 UI 文案
    （Language Model），直接透传曾让所有文本模型/温度注入静默空转。规则：
    键命中节点 id 或 display_name → 原样透传；否则按「id 以 键+'-' 开头」
    唯一前缀匹配；零个或多个命中都报错，绝不静默丢弃（铁律）。
    """
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            f"{LANGFLOW_URL}/api/v1/flows/{flow_id}", headers=headers
        )
    if resp.status_code >= 400:
        raise _TweakKeyError(
            f"读取 flow 节点失败（{resp.status_code}）：{resp.text[:160]}"
        )
    nodes = ((resp.json().get("data") or {}).get("nodes")) or []
    ids = {n.get("id") for n in nodes if n.get("id")}
    names = {
        n.get("data", {}).get("node", {}).get("display_name")
        for n in nodes
        if n.get("data", {}).get("node", {}).get("display_name")
    }
    resolved: Dict[str, Any] = {}
    for key, value in tweaks.items():
        if not isinstance(value, dict):
            # 标量 tweak 是 langflow 原生的「应用到全部节点」语义，不是节点键，原样透传
            resolved[key] = value
            continue
        if key in ids or key in names:
            resolved[key] = value
            continue
        hits = sorted(k for k in ids if k.startswith(f"{key}-"))
        if len(hits) == 1:
            resolved[hits[0]] = value
        elif not hits:
            raise _TweakKeyError(
                f"tweaks 键 {key!r} 在 flow {flow_id} 里没有匹配节点"
                "（id 或 display_name 精确、id 前缀均未命中）"
            )
        else:
            raise _TweakKeyError(
                f"tweaks 键 {key!r} 在 flow {flow_id} 里命中多个节点：{hits}，"
                "请改用完整节点 id"
            )
    return resolved


async def run_flow_blocking(
    flow_id: str,
    input_value: str = "",
    tweaks: Optional[Dict[str, Any]] = None,
    timeout: int = 300,
) -> str:
    """阻塞式跑一个 flow，返回末端输出组件的消息文本。

    tweaks 键支持逻辑组件名（见 _resolve_tweak_keys），解析失败明报不静默。
    timeout：整链等待上限（秒）。分镜表生成实测可到 13 分钟+（大剧本 + 慢模型），
    长流程调用方必须显式放宽，否则 httpx 超时被下面的守卫包装成"连不上"误导人。
    """
    headers = {"Content-Type": "application/json"}
    if LANGFLOW_API_KEY:
        headers["x-api-key"] = LANGFLOW_API_KEY

    if tweaks:
        try:
            tweaks = await _resolve_tweak_keys(flow_id, tweaks, headers)
        except _TweakKeyError as exc:
            return f"（tweaks 解析失败：{exc}）"

    payload: Dict[str, Any] = {
        "input_value": input_value,
        "input_type": "chat",
        "output_type": "chat",
    }
    if tweaks:
        payload["tweaks"] = tweaks

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{LANGFLOW_URL}/api/v1/run/{flow_id}",
                headers=headers,
                json=payload,
            )
            if resp.status_code >= 400:
                detail = resp.text[:300]
                return f"（langflow 返回 {resp.status_code}：{detail}）"
            try:
                data = resp.json()
            except ValueError as exc:
                # 200 但响应体不是 JSON（截断/代理页/流式混入）：明报并带原文，
                # 否则这里裸抛 JSONDecodeError，调用方只能看到 "Expecting value…"
                return f"（langflow 响应不是 JSON（{exc}）：{resp.text[:120]}）"
    except httpx.TimeoutException as exc:
        # 超时 ≠ 连不上：langflow 多半还在后台跑，只是超过了等待上限
        # （httpx 超时异常的 str 常为空串，不点明会被误读成服务挂了）
        return f"（langflow 响应超时（>{timeout}s，flow 可能仍在后台执行）：{exc}）"
    except httpx.HTTPError as exc:
        return f"（连不上 langflow（{LANGFLOW_URL}）：{exc}）"

    # outputs[0].outputs[*].results.{message|...}.(data.text|text)
    try:
        texts: List[str] = []
        for out in data.get("outputs") or []:
            for comp_out in out.get("outputs") or []:
                results = comp_out.get("results") or {}
                for payload_ in results.values():
                    if not isinstance(payload_, dict):
                        continue
                    msg = payload_.get("message")
                    if isinstance(msg, dict):
                        t = (msg.get("data") or {}).get("text") or msg.get("text") or ""
                    else:
                        t = str(payload_.get("text") or "")
                    if t:
                        texts.append(t)
        text = "\n\n".join(texts).strip()
    except Exception as exc:  # noqa: BLE001
        return f"（解析 langflow 响应失败：{exc}）"

    if not text:
        return "（flow 已执行，但没有返回文本。检查 flow 是否有 ChatOutput 且连线完整）"
    return text


# ---------- 资产拆解 ----------


class AssetLook(BaseModel):
    label: str = Field(min_length=1)
    description: str = ""
    # 该造型的核心服装名（与服饰拆解 flow 的产出按名对上后，服饰图作参考图2）
    costume: str = ""


class Asset(BaseModel):
    type: Literal["character", "scene", "prop", "costume"]
    name: str = Field(min_length=1)
    description: str = ""
    visual_notes: str = ""
    # 角色拆解 flow 额外输出：剧本中的造型/服饰变化计划（juben look 范式）。
    # LLM 输出形态不稳（字符串、缺 label、杂字段都见过）：坏条目剔除而非
    # 让整路拆解报废
    looks: List[AssetLook] = []

    @model_validator(mode="before")
    @classmethod
    def _sanitize_looks(cls, data: Any) -> Any:
        if not (isinstance(data, dict) and isinstance(data.get("looks"), list)):
            return data
        good: List[Dict[str, Any]] = []
        for item in data["looks"]:
            if isinstance(item, str) and item.strip():
                good.append({"label": item.strip()})
                continue
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or item.get("name") or "").strip()
            if not label:
                continue
            good.append({
                "label": label[:40],
                "description": str(item.get("description") or "").strip(),
                "costume": str(item.get("costume") or "").strip(),
            })
        return {**data, "looks": good}


class AssetList(BaseModel):
    assets: List[Asset]


def _extract_json_object(text: str) -> Optional[str]:
    """从模型输出里抠出第一个完整 JSON 对象（容忍 ```json 围栏和前后杂文字）。"""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


async def decompose_script(script: str) -> str:
    """调拆解 flow 并严格校验，返回给 LLM 的清单文本。"""
    try:
        assets, errors = await decompose_script_assets(script)
    except RuntimeError as exc:
        return f"拆解技能调用失败：{exc}"
    if not assets:
        return "（拆解结果为空：剧本里没有拆出任何资产）"

    lines = [f"共拆出 {len(assets)} 个资产："]
    for i, a in enumerate(assets, 1):
        # 未知类型不炸整条拆解（四路 flow 并行，类型集合随配置浮动）
        label = ASSET_TYPE_LABELS.get(a["type"], a["type"])
        lines.append(
            f"{i}. [{label}] {a['name']}｜{a['description']}"
            + (f"｜视觉：{a['visual_notes']}" if a["visual_notes"] else "")
        )
    if errors:
        lines.append(
            "（部分类型拆解失败：" + "；".join(f"{t}: {e}" for t, e in errors.items()) + "）"
        )
    return "\n".join(lines)


async def decompose_script_assets(
    script: str,
    existing: Optional[List[Dict[str, Any]]] = None,
    model: str = "",
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    """拆解剧本为结构化资产清单（直连端点用）。

    已配置的分类型 flow 各拆一类、并行调用（character/scene/prop/costume
    四路；单类失败记入 errors 不拖累其他；未配置的类型直接跳过，不回退整
    条 legacy）。existing：画布已有资产 [{type, name}]，注入名单让 LLM
    沿用旧名（跨次拆解去重合并）。model：文本模型覆盖（同分镜表生成）。
    返回 (assets, errors)。
    """
    configured = {t: fid for t, fid in DECOMPOSE_FLOW_IDS.items() if fid}
    if not configured:
        return await _decompose_legacy(script, existing, model)

    rosters = {
        t: [e for e in existing or [] if e.get("type") == t] for t in configured
    }

    async def one(ttype: str) -> List[Dict[str, Any]]:
        return await _decompose_one_type(
            configured[ttype], ttype, script, rosters[ttype], model
        )

    results = await asyncio.gather(
        *[one(t) for t in configured], return_exceptions=True
    )
    merged: List[Dict[str, Any]] = []
    errors: Dict[str, str] = {}
    for ttype, res in zip(configured, results):
        if isinstance(res, BaseException):
            errors[ttype] = str(res)[:200]
        else:
            merged.extend(res)
    return merged, errors


# ---------- 资产拆解（异步任务：Next 同源代理 30s 掐断长请求） ----------

DECOMPOSE_JOBS: Dict[str, Dict[str, Any]] = {}


def get_decompose_job(job_id: str) -> Optional[Dict[str, Any]]:
    return DECOMPOSE_JOBS.get(job_id)


async def start_decompose_job(
    script: str,
    existing: Optional[List[Dict[str, Any]]] = None,
    auto_looks: bool = False,
    visual_style: str = "",
    params: Optional[Dict[str, str]] = None,
    text_model: str = "",
) -> str:
    """启动资产拆解任务，立即返回 jobId（前端轮询 GET /assets/decompose/{jobId}）。

    auto_looks=True 时拆解完成后自动续跑角色出图链（juben 全自动范式：
    每角色先出定妆照，再以其为身份参考图逐个出 Look 造型图），
    结果写回 asset 条目（image_url / looks[i].image_url）。
    params：出图模型/分辨率覆盖（models.resolve_imagegen_params 产物）。
    text_model：拆解文本模型覆盖（models.resolve_text_model 产物，出图链不受影响）。
    """
    job_id = uuid.uuid4().hex[:12]
    DECOMPOSE_JOBS[job_id] = {
        "status": "running",
        "phase": "decompose",
        "progress": None,
        "assets": None,
        "errors": None,
        "error": None,
    }

    async def run() -> None:
        state = DECOMPOSE_JOBS[job_id]
        try:
            assets, errors = await decompose_script_assets(
                script, existing=existing, model=text_model
            )
            state["assets"] = assets
            state["errors"] = errors
            if auto_looks and IMAGEGEN_FLOW_ID and DMX_API_KEY:
                # 画风闸兜底（前端已拦，这里防 API 直调绕过）：无画风不自动出图
                if not visual_style.strip():
                    state["images_note"] = "未提供画风，已跳过自动出图"
                else:
                    state["phase"] = "images"
                    # 已有同名卡（flow 沿用旧名）的类型化跳过：其卡不受本次建卡
                    # 影响，自动出图产物没有落点，跳过省成本
                    existed = {
                        (str(e.get("type") or ""), str(e.get("name") or "").strip())
                        for e in existing or []
                    }
                    # 前端带的画布现况：卡上定妆照/设定图（已有角色补 Look 的
                    # 身份锚点，免重出定妆照）+ 已有 Look 造型名（对名跳过）
                    existing_imgs = {
                        (str(e.get("type") or ""), str(e.get("name") or "").strip()):
                            str(e.get("image_url") or "")
                        for e in existing or []
                        if e.get("image_url")
                    }
                    existing_look_labels = {
                        str(e.get("name") or "").strip(): {
                            str(x).strip() for x in (e.get("looks") or [])
                        }
                        for e in existing or []
                        if e.get("type") == "character" and e.get("looks")
                    }
                    state["images_note"] = await _auto_asset_images(
                        assets, state, visual_style, existed, params=params,
                        existing_imgs=existing_imgs,
                        existing_look_labels=existing_look_labels,
                    )
        except Exception as e:  # noqa: BLE001
            state["error"] = str(e)[:300]
        finally:
            state["phase"] = "done"
            state["status"] = "done"
        # 清理历史任务（保留最近 49 个已完成）
        done = [k for k, v in DECOMPOSE_JOBS.items() if v["status"] == "done"]
        for k in done[:-49]:
            DECOMPOSE_JOBS.pop(k, None)

    asyncio.create_task(run())
    return job_id


_AUTO_CAPS = {"character": 8, "scene": 8, "prop": 8, "costume": 8}
_AUTO_LOOK_CAP = 4


async def _auto_asset_images(
    assets: List[Dict[str, Any]],
    state: Dict[str, Any],
    visual_style: str,
    existed: Optional[set] = None,
    params: Optional[Dict[str, str]] = None,
    existing_imgs: Optional[Dict[tuple, str]] = None,
    existing_look_labels: Optional[Dict[str, set]] = None,
) -> str:
    """资产图自动链（juben collect_pending_character_materials 泛化）：
    ① 服饰结构图先行（Look 的一致性锚点之二）
    ② 角色定妆照 / 场景概念图 / 道具设定图 并发
    ③ 角色 Look 造型图（参考图1=定妆照身份锚点，参考图2=绑定服饰的结构图）
    ③b 画布已有角色补 Look：定妆照免重出（existing_imgs 带卡上现图做
    身份锚点），只出画布还没有的造型（existing_look_labels 对名跳过）
    结果写回 asset 条目（image_url / looks[i].image_url）；单张失败记 error
    不拖累其他。并发 30；每类上限 8、每角色 Look 上限 4（防成本失控）。
    existed：画布已有 (type, name) 集合，命中跳过。返回汇报 note。"""
    existed = existed or set()
    existing_imgs = existing_imgs or {}
    sem = asyncio.Semaphore(30)
    style_note = f"全局视觉风格：{visual_style}" if visual_style.strip() else ""
    total_done = [0]
    total_target = [0]

    def capped(ttype: str) -> List[Dict[str, Any]]:
        fresh = [
            a
            for a in assets
            if a.get("type") == ttype
            and (ttype, str(a.get("name") or "").strip()) not in existed
        ]
        return fresh[: _AUTO_CAPS[ttype]]

    async def gen(shot: Dict[str, Any]) -> Dict[str, Any]:
        async with sem:
            r = await _generate_single_image(shot, params=params)
        total_done[0] += 1
        state["progress"] = {"done": total_done[0], "total": total_target[0]}
        return r

    async def gen_main(a: Dict[str, Any], asset_type: str) -> None:
        desc = f"{a.get('name', '')}。{a.get('description', '')}"
        if a.get("visual_notes"):
            desc += f"（视觉：{a['visual_notes']}）"
        r = await gen({
            "name": a.get("name") or "资产",
            "description": desc,
            "assetType": asset_type,
            "visual_notes": style_note,
        })
        if r.get("ok") and r.get("imageUrl"):
            a["image_url"] = r["imageUrl"]
        else:
            a["error"] = str(r.get("error") or "出图失败")[:200]

    async def one_costume(a: Dict[str, Any]) -> None:
        # 服饰结构图按道具契约（4:3 单件平铺）
        await gen_main(a, "prop")

    async def one_char(a: Dict[str, Any]) -> None:
        await gen_main(a, "character")
        if not a.get("image_url"):
            # 没有定妆照就没有身份锚点，Look 退化成纯文生图一致性差：跳过
            for l in a.get("looks") or []:
                l["error"] = "定妆照生成失败，Look 已跳过"
            return
        looks = (a.get("looks") or [])[:_AUTO_LOOK_CAP]
        await asyncio.gather(
            *[gen_one_look(a, l, a["image_url"]) for l in looks]
        )

    def find_costume_img(cname: str) -> Optional[str]:
        """绑定服饰的结构图：先查本次 flow 产物，再查画布已有服饰卡带图
        （existing_imgs；重拆补 Look 时服饰卡多半早已建好）"""
        cname = cname.strip()
        if not cname:
            return None
        for c in assets:
            if (
                c.get("type") == "costume"
                and c.get("image_url")
                and (cname in str(c.get("name") or "") or str(c.get("name") or "") in cname)
            ):
                return c["image_url"]
        for (t, n), url in existing_imgs.items():
            if t == "costume" and (cname in n or n in cname):
                return url
        return None

    async def gen_one_look(
        a: Dict[str, Any], l: Dict[str, Any], identity: str
    ) -> None:
        # 参考图2：绑定的服饰卡结构图（按名模糊对上才加）
        refs = [identity]
        costume_img = find_costume_img(str(l.get("costume") or ""))
        if costume_img:
            refs.append(costume_img)
        protocol = [
            f"生成角色「{a.get('name', '')}」的造型定妆图：{l.get('label', '')}。",
            f"角色设定：{a.get('description', '')}。",
            "参考图1（角色身份参考）：只继承脸型、五官、发型、体型比例，"
            "保持完全不变；忽略其服装、配饰、姿态与背景。",
        ]
        if costume_img:
            protocol.append(
                "参考图2（服饰结构参考）：形制、材质、配色以该服饰图为准。"
            )
        protocol.append(f"造型要求：{l.get('description', '')}。")
        r = await gen({
            "name": f"{a.get('name', '')}·{l.get('label', '造型')}",
            "description": " ".join(protocol),
            "assetType": "character",
            "visual_notes": style_note,
            "referenceImages": refs,
        })
        if r.get("ok") and r.get("imageUrl"):
            l["image_url"] = r["imageUrl"]
        else:
            l["error"] = str(r.get("error") or "出图失败")[:200]

    # 已存在角色的 Look 补齐计划：卡上定妆照做身份锚点，跳过画布已有的造型
    look_backfill: List[tuple] = []
    for a in assets:
        if a.get("type") != "character":
            continue
        name = str(a.get("name") or "").strip()
        ding = existing_imgs.get(("character", name))
        if not ding or (a.get("looks") or []) == []:
            continue
        skip = set(existing_look_labels.get(name) or set())
        new_looks = [
            l
            for l in (a.get("looks") or [])[:_AUTO_LOOK_CAP]
            if str(l.get("label") or "").strip() not in skip
        ]
        if new_looks:
            look_backfill.append((a, ding, new_looks))

    # 总量先算好再跑（进度条闭环）
    costumes = capped("costume")
    chars = capped("character")
    scenes = capped("scene")
    props = capped("prop")
    total_target[0] = (
        len(costumes)
        + len(chars)
        + len(scenes)
        + len(props)
        + sum(min(len(a.get("looks") or []), _AUTO_LOOK_CAP) for a in chars)
        + sum(len(ls) for _, _, ls in look_backfill)
    )
    state["progress"] = {"done": 0, "total": total_target[0]}

    # ① 服饰先行（Look 的参考图2）② 角色定妆照(+Looks)/场景/道具 并发
    await asyncio.gather(*[one_costume(a) for a in costumes])
    await asyncio.gather(
        *([one_char(a) for a in chars] + [gen_main(a, "scene") for a in scenes] + [gen_main(a, "prop") for a in props])
    )
    # ③b 补 Look（放服饰之后：参考图2 可吃本次新出的服饰结构图）
    await asyncio.gather(
        *[gen_one_look(a, l, ding) for a, ding, ls in look_backfill for l in ls]
    )

    imaged = {
        t: sum(1 for a in assets if a.get("type") == t and a.get("image_url"))
        for t in ("character", "scene", "prop", "costume")
    }
    looks_done = sum(
        1
        for a in assets
        if a.get("type") == "character"
        for l in a.get("looks") or []
        if l.get("image_url")
    )
    parts = [
        f"{label} {imaged[t]}"
        for t, label in (
            ("character", "角色"),
            ("costume", "服饰"),
            ("scene", "场景"),
            ("prop", "道具"),
        )
        if imaged[t]
    ]
    note = "已自动出图：" + ("、".join(parts) if parts else "无")
    if looks_done:
        note += f"（含 Look {looks_done} 张）"
    backfilled = sum(len(ls) for _, _, ls in look_backfill)
    if backfilled:
        note += f"；已有角色补 Look {backfilled} 张"
    skipped = sum(
        1
        for a in assets
        if a.get("type") in _AUTO_CAPS
        and (a.get("type"), str(a.get("name") or "").strip()) in existed
    )
    over = sum(
        len([a for a in assets if a.get("type") == t])
        - len(capped(t))
        - sum(1 for a in assets if a.get("type") == t and (t, str(a.get("name") or "").strip()) in existed)
        for t in _AUTO_CAPS
    )
    if skipped:
        note += f"；画布已有同名 {skipped} 项跳过"
    if over > 0:
        note += f"；超上限 {over} 项未出图（可在卡上单独出图）"
    return note


async def _decompose_one_type(
    flow_id: str,
    ttype: str,
    script: str,
    roster: List[Dict[str, Any]],
    model: str = "",
) -> List[Dict[str, Any]]:
    parts = []
    if roster:
        parts.append("已有资产名单：")
        parts.extend(f"- [{a.get('type', '')}] {a.get('name', '')}" for a in roster)
    parts.append("剧本：")
    parts.append(script)

    raw = await run_flow_blocking(
        flow_id,
        input_value="\n".join(parts),
        tweaks={
            "LanguageModelComponent": {
                "temperature": 0.1,
                **models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID),
            }
        },
    )
    if raw.startswith("（"):
        raise RuntimeError(raw.strip("（）"))
    obj_text = _extract_json_object(raw)
    if not obj_text:
        raise RuntimeError(f"返回的不是 JSON。原始输出前 160 字：{raw[:160]}")
    try:
        asset_list = AssetList.model_validate_json(obj_text)
    except ValidationError as exc:
        raise RuntimeError(f"未通过结构校验：{exc.errors()[:3]}") from exc
    # flow 提示词已限定类型，这里再强制对齐一次（防模型串类）；
    # looks 仅角色类型保留（场景/道具无造型概念）
    out = [
        {"type": ttype, "name": a.name, "description": a.description, "visual_notes": a.visual_notes}
        for a in asset_list.assets
    ]
    if ttype == "character":
        for item, a in zip(out, asset_list.assets):
            if a.looks:
                item["looks"] = [
                    {
                        "label": l.label,
                        "description": l.description,
                        "costume": l.costume,
                    }
                    for l in a.looks
                ]
    return out


async def _decompose_legacy(
    script: str,
    existing: Optional[List[Dict[str, Any]]] = None,
    model: str = "",
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    if not DECOMPOSE_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_DECOMPOSE_*_FLOW_ID（分类型）或 LANGFLOW_DECOMPOSE_FLOW_ID（合并）"
        )

    parts = []
    if existing:
        lines = [
            f"- [{a.get('type', '')}] {a.get('name', '')}"
            for a in existing
            if str(a.get("name", "")).strip()
        ]
        if lines:
            parts.append("已有资产名单：")
            parts.extend(lines)
    parts.append("剧本：")
    parts.append(script)

    raw = await run_flow_blocking(
        DECOMPOSE_FLOW_ID,
        input_value="\n".join(parts),
        tweaks={
            "LanguageModelComponent": {
                "temperature": 0.1,
                **models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID),
            }
        },
    )
    if raw.startswith("（"):
        raise RuntimeError(raw.strip("（）"))

    obj_text = _extract_json_object(raw)
    if not obj_text:
        raise RuntimeError(f"拆解技能返回的不是 JSON。原始输出前 200 字：{raw[:200]}")
    try:
        asset_list = AssetList.model_validate_json(obj_text)
    except ValidationError as exc:
        raise RuntimeError(f"拆解结果未通过结构校验：{exc.errors()[:3]}") from exc

    return [
        {
            "type": a.type,
            "name": a.name,
            "description": a.description,
            "visual_notes": a.visual_notes,
        }
        for a in asset_list.assets
    ], {}


# ---------- 资产出图 ----------


def _project_imagegen_from_config(config: Any = None) -> Dict[str, Any]:
    """聊天线程 → 所属项目 → 画布 meta.imagegen（出图面板的项目级默认：
    model/resolution/aspect）。非聊天路径、未知线程或读库失败时返回空 dict。"""
    try:
        thread_id = str(((config or {}).get("configurable") or {}).get("thread_id") or "")
        if not thread_id:
            return {}
        import sqlite3

        db_path = Path(__file__).resolve().parent / "data" / "wingsight.db"
        db = sqlite3.connect(str(db_path))
        try:
            row = db.execute(
                "select c.meta from canvases c join chat_threads t"
                " on c.project_id = t.project_id where t.id = ?",
                (thread_id,),
            ).fetchone()
        finally:
            db.close()
        meta = json.loads(row[0]) if row and row[0] else {}
        gen = meta.get("imagegen")
        return gen if isinstance(gen, dict) else {}
    except Exception:
        return {}


def _project_style_from_config(config: Any = None) -> str:
    """聊天线程 → 所属项目 → 画布 meta 的全局画风。

    服务端以 DB 为准解析（novanova 模式：前端只传 ID，约束不可被模型改写）。
    非聊天路径、未知线程或读库失败时返回空串（不阻塞出图）。"""
    try:
        thread_id = str(((config or {}).get("configurable") or {}).get("thread_id") or "")
        if not thread_id:
            return ""
        import sqlite3

        db_path = Path(__file__).resolve().parent / "data" / "wingsight.db"
        db = sqlite3.connect(str(db_path))
        try:
            row = db.execute(
                "select c.meta from canvases c join chat_threads t"
                " on c.project_id = t.project_id where t.id = ?",
                (thread_id,),
            ).fetchone()
        finally:
            db.close()
        meta = json.loads(row[0]) if row and row[0] else {}
        return str(meta.get("visualStyle") or "")
    except Exception:
        return ""


# ---------- 聊天长任务（取消 + 任务面板数据源；「停止」/ 切会话透传后端） ----------

# job_id -> 在途任务档案。任务面板（GET /chat/jobs）按 threadId 拉这里。
CHAT_JOBS: Dict[str, Dict[str, Any]] = {}


def _thread_id_of_config(config: Any) -> str:
    try:
        return str(
            ((config or {}).get("configurable") or {}).get("thread_id") or ""
        )
    except Exception:  # noqa: BLE001
        return ""


def start_chat_job(thread_id: str, kind: str, title: str, total: int = 0) -> str:
    """登记一个聊天侧长任务，返回 job_id。total=0 表示进度不可数（单流任务）。"""
    job_id = f"job{uuid.uuid4().hex[:8]}"
    CHAT_JOBS[job_id] = {
        "threadId": thread_id,
        "kind": kind,
        "title": title,
        "done": 0,
        "total": total,
        "cancelled": False,
        "tasks": set(),
    }
    return job_id


def job_attach_task(job_id: str, task: "asyncio.Task") -> None:
    """把在途任务挂到 job 名下；全部任务结束后 job 自动摘除。"""
    job = CHAT_JOBS.get(job_id)
    if not job:
        return

    def _discard(t: "asyncio.Task") -> None:
        job["tasks"].discard(t)
        if not job["tasks"]:
            CHAT_JOBS.pop(job_id, None)

    job["tasks"].add(task)
    task.add_done_callback(_discard)


def job_set_progress(job_id: str, done: int) -> None:
    job = CHAT_JOBS.get(job_id)
    if job:
        job["done"] = done


def cancel_chat_runs(thread_id: str, job_id: str = "") -> int:
    """取消该会话在途的后端任务（在途 http 请求中止，不再计费）。
    job_id 非空时只取消该任务。返回取消数。"""
    n = 0
    for jid, job in list(CHAT_JOBS.items()):
        if job["threadId"] != thread_id:
            continue
        if job_id and jid != job_id:
            continue
        job["cancelled"] = True
        for t in list(job["tasks"]):
            if not t.done():
                t.cancel()
                n += 1
    return n


def list_chat_jobs(thread_id: str) -> List[Dict[str, Any]]:
    """任务面板数据源：该会话全部在途任务（含进行中的进度）。"""
    return [
        {
            "jobId": jid,
            "kind": job["kind"],
            "title": job["title"],
            "done": job["done"],
            "total": job["total"],
            "cancelled": job["cancelled"],
        }
        for jid, job in CHAT_JOBS.items()
        if job["threadId"] == thread_id
    ]


async def generate_asset_images(
    assets: List[Dict[str, Any]], config: Any = None, params: Optional[Dict[str, str]] = None
) -> str:
    """逐资产并发出图（并发 30），每张完成即向聊天流推送进度（若有 config）。

    params：模型/分辨率覆盖（models.resolve_imagegen_params 产物）。
    成功的图片复制到 agent/static/assets/ 并以 /agent-service/assets/<file>
    相对路径回传（前端同源代理可直接 <img> 渲染）。
    """
    if not IMAGEGEN_FLOW_ID:
        return "（未配置 LANGFLOW_IMAGEGEN_FLOW_ID，出图技能不可用）"
    if not assets:
        return "（资产列表为空，没有可生成的资产）"
    if not DMX_API_KEY:
        return "（未配置 DMX_API_KEY，出图不可用）"
    # 项目画风（服务端按线程→项目→画布 meta 解析）：并进每张资产的
    # visual_notes，写实媒介时 _generate_single_image 会自动加主体锚点
    style = _project_style_from_config(config)
    # 项目级默认画幅（底部坞「出图」面板的 meta.imagegen.aspect）：资产未带
    # aspect 时兜底，替代 flow 的类型默认幅面（角色=竖幅）——用户反馈聊天出图
    # 应跟随画布默认尺寸，而非角色一律竖图
    project_default_aspect = str(_project_imagegen_from_config(config).get("aspect") or "")
    if project_default_aspect:
        assets = [
            {**a, "aspect": str(a.get("aspect") or project_default_aspect)}
            for a in assets
        ]

    # 未配置豆包搜索 key 时剥掉 search_query：组件对带该字段的资产强制要求
    # 搜索 key，剥掉后走纯文生图（参考图是增强项，不影响出图）
    if not VOLC_SEARCH_API_KEY:
        assets = [{k: v for k, v in a.items() if k != "search_query"} for a in assets]

    # 画幅预检（任一不合法整批不跑，点名报错让 LLM 修正重调——与批量出图
    # 端点同一铁律）；合法值随资产进 shot，_generate_single_image 认 shot.aspect
    aspect_model = str((params or {}).get("model_name") or models.DEFAULT_MODEL_ID)
    bad_aspects: List[str] = []
    for a in assets:
        try:
            models.resolve_aspect(a.get("aspect"), aspect_model)
        except ValueError as exc:
            bad_aspects.append(f"「{str(a.get('name') or '?')}」{exc}")
    if bad_aspects:
        return "；".join(bad_aspects)

    sem = asyncio.Semaphore(30)
    done = [0]
    total = len(assets)
    recent: List[str] = []
    last_emit = [0.0]
    thread_id = _thread_id_of_config(config)
    job_id = (
        start_chat_job(thread_id, "imagegen", f"设定图 ×{total}", total)
        if thread_id
        else ""
    )
    if config is not None:
        await _emit_progress(
            config, f"开始为 {total} 项资产生成设定图（并发 30，每张完成会播报）…"
        )

    async def one(asset: Dict[str, Any]) -> str:
        name = str(asset.get("name", "?"))
        # LLM 构建的资产用 type 字段（与工具 docstring 一致），归一到 assetType；
        # 项目画风并进 visual_notes → _generate_single_image 统一注入锚点/拍平
        shot = {
            **asset,
            "assetType": str(asset.get("type") or asset.get("assetType") or "scene"),
        }
        if style:
            shot["visual_notes"] = "；".join(
                filter(
                    None,
                    [str(shot.get("visual_notes") or ""), f"全局视觉风格：{style}"],
                )
            )
        async with sem:
            result = await _generate_single_image(shot, params=params)
        done[0] += 1
        job_set_progress(job_id, done[0])
        if result.get("ok") and result.get("imageUrl"):
            line = f"✓ {name}｜image_url={result['imageUrl']}"
        else:
            line = f"✗ {name}｜出图失败：{str(result.get('error') or '未知')[:100]}"
        # 节流播报：只在静默 ≥3s 或全部完成时推一条累计行（并发 30 张时逐张
        # 播报会把聊天刷成 30 条进度；AG-UI 桥的 message_id 单次认领，
        # 同 id 原地更新不可行，只能源头降频）
        recent.append(line)
        del recent[:-6]
        if config is not None and (
            done[0] == total or time.monotonic() - last_emit[0] >= 3.0
        ):
            last_emit[0] = time.monotonic()
            try:
                await _emit_progress(
                    config, f"出图进度 {done[0]}/{total}：\n" + "\n".join(recent)
                )
            except Exception as e:  # noqa: BLE001
                print(f"[emit_progress 失败] {type(e).__name__}: {e}", flush=True)
        return line

    tasks = [asyncio.create_task(one(a)) for a in assets]
    if job_id:
        for t in tasks:
            job_attach_task(job_id, t)
    # return_exceptions：被 cancel_chat_runs 取消的任务以 CancelledError 收场，
    # 不炸整批——完成的照常返回，取消的单独立数说明
    results = await asyncio.gather(*tasks, return_exceptions=True)
    lines = [r for r in results if isinstance(r, str)]
    n_cancelled = sum(1 for r in results if not isinstance(r, str))
    if n_cancelled:
        lines.append(f"（已取消 {n_cancelled} 张，未计入结果）")
    return "\n".join(lines)


async def _emit_progress(config: Any, message: str) -> None:
    """向聊天流推送中途进度消息。

    copilotkit 包的 emit_message 发 "copilotkit_manually_emit_message"，
    而当前 ag-ui-langgraph 只认 "manually_emit_message"（版本错位）——
    直接按 ag-ui 侧期望的事件名与 payload 发送。
    进度只是锦上添花：任何失败都吞掉，绝不影响工具本身执行。
    """
    import uuid as _uuid

    from langchain_core.callbacks import adispatch_custom_event

    try:
        await adispatch_custom_event(
            "manually_emit_message",
            {"message": message, "message_id": f"progress_{_uuid.uuid4().hex[:10]}", "role": "assistant"},
            config=config,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[emit_progress 失败] {type(e).__name__}: {e}", flush=True)


async def _extract_image_url(raw: str) -> Optional[str]:
    """从单次出图 flow 结果里解析图片并归档到 /agent-service/assets/。

    成功返回可访问 URL；失败返回 None（调用方决定如何汇报错误）。
    """
    obj_text = _extract_json_object(raw) or _extract_json_objects_loose(raw)
    if not obj_text:
        return None
    try:
        parsed = json.loads(obj_text)
        r = parsed[0] if isinstance(parsed, list) else parsed
        if r.get("status") == "ok" and r.get("image_path"):
            src = Path(r["image_path"])
            if src.is_file():
                ASSETS_DIR.mkdir(parents=True, exist_ok=True)
                dest = f"{uuid.uuid4().hex[:12]}{src.suffix or '.png'}"
                shutil.copy2(src, ASSETS_DIR / dest)
                # ffmpeg 产缩略图不能卡事件循环（批量出图并发跑在这条循环上）
                await asyncio.to_thread(thumbs.make_for, dest)
                return f"/agent-service/assets/{dest}"
    except (json.JSONDecodeError, IndexError, KeyError):
        pass
    return None


async def _format_asset_result(name: str, raw: str) -> str:
    """把单资产 flow 结果整理为一行汇报（成功附 image_url）。"""
    url = await _extract_image_url(raw)
    if url:
        return f"✓ {name}｜image_url={url}"
    if raw.startswith("（"):
        return f"✗ {name}｜调用失败：{raw[:100]}"
    return f"✗ {name}｜结果解析失败：{raw[:100]}"


# 分镜批量出图任务表：jobId -> {"status": running|done, "images": {rid: result}}
# Next 同源代理对长请求约 30s 就掐断，批量出图必须异步任务 + 前端轮询
STORYBOARD_IMAGE_JOBS: Dict[str, Dict[str, Any]] = {}


def _prune_storyboard_image_jobs() -> None:
    done = [k for k, v in STORYBOARD_IMAGE_JOBS.items() if v["status"] == "done"]
    for k in done[:-49]:  # 最多保留 49 个已完成任务
        STORYBOARD_IMAGE_JOBS.pop(k, None)


def get_storyboard_image_job(job_id: str) -> Optional[Dict[str, Any]]:
    job = STORYBOARD_IMAGE_JOBS.get(job_id)
    if job is not None:
        return job
    # 内存 miss：查持久层（agent 重启丢内存任务表）。已完成的结果原样
    # 返回供前端恢复轮询收回；重启时在途的孤儿任务就地终态化（未完成项
    # 标中断）——不再 404 让用户对已计费的部分全额重试
    return imagejobs.load_job(job_id)


COMPOSE_FLOW_ID = os.environ.get("LANGFLOW_COMPOSE_FLOW_ID", "")


async def compose_instruction(
    instruction: str, setting: str, ref_duties: str, style: str, model: str = ""
) -> Dict[str, str]:
    """出图指令合成（智能编排，novanova KEEP/OPTIMIZE 范式）：短指令结合
    卡片设定文本扩写成完整提示词；完整描述/改图指令 keep 原样逐字返回。
    失败抛错由调用方明报（铁律：不静默降级直传）。flow 见
    agent/flows/instruction-compose.json（提示词搬运自 novanova
    agent-image.md/optimization-image.md 融合适配）。"""
    if not COMPOSE_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_COMPOSE_FLOW_ID（flow 见 agent/flows/instruction-compose.json）"
        )
    instruction = instruction.strip()[:2000]
    if not instruction:
        raise RuntimeError("指令合成为空指令")
    input_value = (
        f"【生成指令】{instruction}\n"
        f"【卡片设定文本】\n{setting.strip()[:6000] or '（空）'}\n"
        f"【参考图职责】\n{ref_duties.strip() or '（无）'}\n"
        f"【全局画风】{style.strip() or '（未设定）'}"
    )
    tweaks = (
        {"LanguageModelComponent": models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID)}
    )
    raw = await run_flow_blocking(
        COMPOSE_FLOW_ID, input_value=input_value, tweaks=tweaks
    )
    obj_text = _extract_json_object(raw) or _extract_json_objects_loose(raw)
    if not obj_text:
        raise RuntimeError(f"编排结果不是合法 JSON：{raw[:120]}")
    parsed = json.loads(obj_text)
    action = str(parsed.get("action") or "").strip().lower()
    prompt = str(parsed.get("prompt") or "").strip()
    if action not in ("keep", "optimize") or not prompt:
        raise RuntimeError(f"编排结果字段缺失：{raw[:120]}")
    return {"action": action, "prompt": prompt}


async def _generate_single_image(
    shot: Dict[str, Any], params: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """单张出图原语（直连 imagegen flow，不经聊天）：入参字段同批量出图
    请求（name/description/visualNotes?/assetType?/referenceImages?），
    params 为模型/分辨率覆盖（models.resolve_imagegen_params 产物），
    返回 {ok, imageUrl?|error}。拆解自动出图链与批量出图任务共用。"""
    # flow 载荷只认 {type,name,description,visual_notes,reference_images?,search_query?}：
    # rid 不能进 payload（会被渲染进出图提示词）。
    # 字段一律拍平成单行：langflow tweaks 传输会把 \n 反转义成裸换行，
    # 组件里 json.loads 会报 Invalid control character
    def flat(value: Any) -> str:
        return " ".join(str(value or "").split())

    # 媒介条件式主体锚点（t5 实验结论）：画风声明真人/实拍时，把「真实演员
    # 出镜」写进主体描述开头——gpt-image 的写实模式跟随主体内部声明，放
    # 视觉要点末尾只是部分缓解；动漫画风不含关键词则不注入，互不影响
    # 兼容驼峰/下划线：直连端点历史用 visualNotes，flow 载荷用 visual_notes
    visual_flat = flat(shot.get("visual_notes") or shot.get("visualNotes"))
    description = flat(shot.get("description"))
    shot_type = flat(shot.get("assetType") or "scene")
    # 指令合成（智能编排）：短指令结合【设定文本】扩写成完整提示词；完整
    # 描述/改图指令 keep 原样逐字直传。失败明报不静默降级（铁律）；合成
    # 结果随任务项回传前端回显（composedPrompt）
    composed: Optional[Dict[str, str]] = None
    if str(shot.get("compose") or "").lower() in ("1", "true"):
        duties = "；".join(
            f"图{i + 1}=《{str(l.get('name') or '').strip()}》"
            for i, l in enumerate(
                shot.get("referenceLabels") or shot.get("reference_labels") or []
            )
            if isinstance(l, dict) and str(l.get("name") or "").strip()
        )
        style_line = ""
        m = re.search(r"全局视觉风格：(.+)$", visual_flat)
        if m:
            style_line = m.group(1)
        composed = await compose_instruction(
            flat(shot.get("instruction") or ""),
            str(shot.get("setting") or ""),
            duties,
            style_line,
        )
        description = composed["prompt"]
    if visual_flat and any(
        kw in visual_flat for kw in ("实拍", "真人", "真实演员", "photoreal")
    ):
        # 媒介锚点按类型分级：角色=具名演员出镜；场景/道具/服饰/镜头=仅媒介
        # 质感前缀（空镜契约禁人物，镜头更不能「饰演镜头1」）
        medium = "实拍真人照片，photorealistic photograph 质感"
        if shot_type == "character":
            description = f"{medium}：由真实演员饰演「{flat(shot.get('name'))}」本人出镜。{description}"
        else:
            description = f"{medium}。{description}"
    payload: Dict[str, Any] = {
        "type": shot_type,
        "name": flat(shot.get("name") or "资产"),
        "description": description,
    }
    if visual_flat:
        payload["visual_notes"] = visual_flat
    # 资产级画幅覆写（分镜图幅面：9:16/21:9 等）；格式校验在 flow 侧，
    # 不合法会得到中文报错并落到该图卡的 error 上
    if shot.get("aspect"):
        payload["aspect"] = flat(shot["aspect"])
    # 定妆照等一致性锚点：/agent-service/assets/ 相对路径 → agent 本机绝对
    # URL（langflow 经 http 下载；/assets 未鉴权，文件名为随机 hex）。
    # 两种键名都收：前端批量出图传 camelCase referenceImages，聊天工具的
    # 资产 JSON 按工具 docstring 用 snake_case reference_images
    ref_images = [
        ASSET_BASE_URL + "/assets/" + u.rsplit("/", 1)[-1]
        if u.startswith(("/agent-service/assets/", "/assets/"))
        else str(u)
        for u in (
            shot.get("referenceImages")
            or shot.get("reference_images")
            or []
        )
        if str(u).strip()
    ]
    if ref_images:
        payload["reference_images"] = ref_images
    # 逐张参考图职责标签（[{type,name}]，与 referenceImages 一一对应）：
    # flow 据此渲染「参考图N（名）：只锁定什么/不继承什么」职责段——
    # 定妆照的白底/多视图排版最容易污染剧照画面，笼统一句压不住
    ref_labels = [
        {"type": str(l.get("type") or ""), "name": str(l.get("name") or "")}
        for l in (shot.get("referenceLabels") or shot.get("reference_labels") or [])
        if isinstance(l, dict) and str(l.get("name") or "").strip()
    ]
    if ref_images and ref_labels:
        payload["reference_labels"] = ref_labels[: len(ref_images)]
    try:
        tweaks: Dict[str, Dict[str, Any]] = {
            "BatchAssetSheet-img02": {
                "assets_payload": json.dumps(
                    {"assets": [payload]}, ensure_ascii=False
                ),
                "api_key": DMX_API_KEY,
                **(params or {}),
            }
        }
        # 改图模式（前端契约推断）：最小提示词模板整体替换 flow 默认模板——
        # 无四格/空镜/剧照版式措辞，参考职责段（image=保留构图只改要改的）
        # 与文字守卫保留。截断防呆：模板变量引用完整才会被 flow format
        template = str(shot.get("promptTemplate") or "").strip()
        if template:
            tweaks["BatchAssetSheet-img02"]["prompt_template"] = template[:2000]
        if ref_images:
            # 按实际张数注入参考图上限——组件默认 3 会静默截断第 4 张起
            # 的参考图（组件侧 int() 容忍字符串）
            tweaks["BatchAssetSheet-img02"]["reference_count"] = str(
                len(ref_images)
            )
        raw = await run_flow_blocking(IMAGEGEN_FLOW_ID, tweaks=tweaks)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}
    url = await _extract_image_url(raw)
    if url:
        # 用量计量（按用户）：模型取解析后的目录 id；发起者来自请求上下文
        usage.record_image(str((params or {}).get("model_name") or ""))
        out: Dict[str, Any] = {"ok": True, "imageUrl": url}
        if composed:
            out["composedPrompt"] = composed["prompt"][:2000]
            out["composeAction"] = composed["action"]
        return out
    return {"ok": False, "error": raw[:200]}


async def start_storyboard_image_job(
    shots: List[Dict[str, Any]], params: Optional[Dict[str, str]] = None
) -> str:
    """启动分镜行批量出图任务（直连 imagegen flow，并发 30，不经聊天）。

    shots: [{rid, name, description, visual_notes?, aspect?,
             params?: {model?, resolution?, aspect?}}]，字段与出图 flow 的资产载荷
    一致（type 固定 scene，镜头画面不是角色设定图）。params：请求级出图
    模型/分辨率/画幅；镜头级 aspect 与 params 覆盖请求级（卡片级覆盖），
    逐镜头合并后预校验——任一组合不合法整批 ValueError（端点转 400 明报）。
    立即返回 jobId；每张完成即写入任务状态，前端轮询增量取走。
    """
    if not IMAGEGEN_FLOW_ID:
        raise RuntimeError("未配置 LANGFLOW_IMAGEGEN_FLOW_ID（flow 见 agent/flows/asset-imagegen.json）")
    if not DMX_API_KEY:
        raise RuntimeError("未配置 DMX_API_KEY，出图不可用")
    resolved: Dict[str, Optional[Dict[str, str]]] = {}
    invalid: List[str] = []
    for s in shots:
        rid = str(s.get("rid", ""))
        # 请求级 params 是端点已解析的 {model_name, resolution}，镜头级
        # params 是前端原始 {model, resolution}——统一成 model 键再校验，
        # 否则请求级模型被当缺省、画幅/档位拿错模型对表
        merged = {**(params or {}), **(s.get("params") or {})}
        if "model_name" in merged:
            merged["model"] = merged.pop("model_name")
        try:
            # 画幅：镜头级显式 > 请求级（merged.aspect）；模型/档位同批校验，
            # 任一项不合法整批 400 点名镜头（绝不静默回退默认幅面）
            p = models.resolve_imagegen_params(merged or None) or {}
            p["aspect"] = models.resolve_aspect(
                s.get("aspect") or merged.get("aspect"),
                str(p.get("model_name") or models.DEFAULT_MODEL_ID),
            )
            resolved[rid] = p
        except ValueError as exc:
            invalid.append(f"「{str(s.get('name') or rid) or rid}」{exc}")
    if invalid:
        raise ValueError("；".join(invalid))
    _prune_storyboard_image_jobs()

    # 未配置豆包搜索 key 时剥掉 search_query：组件对带该字段的资产强制要求
    # 搜索 key，剥掉后走纯文生图
    if not VOLC_SEARCH_API_KEY:
        shots = [{k: v for k, v in s.items() if k != "search_query"} for s in shots]

    job_id = uuid.uuid4().hex[:12]
    STORYBOARD_IMAGE_JOBS[job_id] = {
        "status": "running",
        "cancelled": False,
        "images": {str(s.get("rid", "")): {"rid": str(s.get("rid", "")), "ok": False} for s in shots},
    }
    # 任务落库（imagejobs）：agent 重启后轮询仍可命中、已完成的结果可找回
    imagejobs.create_job(
        job_id, [str(s.get("rid", "")) for s in shots]
    )

    sem = asyncio.Semaphore(30)

    async def one(shot: Dict[str, Any]) -> None:
        rid = str(shot.get("rid", ""))
        p = resolved.get(rid) or {}
        # 请求级画幅落到无显式画幅的镜头（flow 载荷只认 shot.aspect；
        # aspect 不能留在 params 里——params 会被整体展开成组件 tweaks）
        if not str(shot.get("aspect") or "").strip() and p.get("aspect"):
            shot = {**shot, "aspect": p["aspect"]}
        tweaks = {k: v for k, v in p.items() if k != "aspect"} or None
        try:
            async with sem:
                if STORYBOARD_IMAGE_JOBS[job_id]["cancelled"]:
                    return
                result = await _generate_single_image(shot, params=tweaks)
        except asyncio.CancelledError:
            # cancel_storyboard_image_job 取消了在途任务：httpx 请求中止，
            # 未完成的生成不再计费
            result = {"ok": False, "error": "已取消", "cancelled": True}
        STORYBOARD_IMAGE_JOBS[job_id]["images"][rid] = {"rid": rid, **result}
        # 单张结果即时落库：重启窗口内已完成的图可被找回（计费已发生）
        try:
            imagejobs.save_item(job_id, rid, result)
        except Exception as exc:  # noqa: BLE001
            print(f"[imagejobs] 结果落库失败 job={job_id} rid={rid}: {exc}", flush=True)

    async def run() -> None:
        job = STORYBOARD_IMAGE_JOBS[job_id]
        job["tasks"] = [asyncio.create_task(one(s)) for s in shots]
        try:
            await asyncio.gather(*job["tasks"], return_exceptions=True)
        finally:
            job["status"] = "cancelled" if job["cancelled"] else "done"
            # 终态以内存完整结果为准权威落库（自愈中途漏写的单项）
            try:
                imagejobs.finish_job(job_id, job["status"], job["images"])
            except Exception as exc:  # noqa: BLE001
                print(f"[imagejobs] 终态落库失败 job={job_id}: {exc}", flush=True)

    asyncio.create_task(run())
    return job_id


def cancel_storyboard_image_job(job_id: str) -> bool:
    """取消出图任务：未开跑的镜头直接跳过，在途的取消底层 http 请求。

    已完成的任务返回 False（无可取消）。
    """
    job = STORYBOARD_IMAGE_JOBS.get(job_id)
    if not job or job["status"] != "running":
        return False
    job["cancelled"] = True
    for t in job.get("tasks", []):
        t.cancel()
    return True


def _extract_json_objects_loose(text: str) -> Optional[str]:
    """兜底：抓文本里第一个 {...} 或 [{...}] 块（含结果数组）。"""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", text, re.DOTALL)
    if fenced:
        return fenced.group(1)
    start = min(
        (i for i in (text.find("{"), text.find("[")) if i != -1), default=-1
    )
    if start == -1:
        return None
    closer = "}" if text[start] == "{" else "]"
    end = text.rfind(closer)
    return text[start : end + 1] if end > start else None


# ---------- 通用技能表 ----------


def load_skill_registry() -> Dict[str, Dict[str, Any]]:
    """技能表来自 LANGFLOW_SKILLS_JSON：
    {"技能名": {"flowId": "...", "description": "...",
                "params": {"参数名": {"target": "组件id", "desc": "说明"}}}}
    """
    raw = os.environ.get("LANGFLOW_SKILLS_JSON", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    registry: Dict[str, Dict[str, Any]] = {}
    for name, item in data.items():
        if not isinstance(item, dict) or not item.get("flowId"):
            continue
        entry: Dict[str, Any] = {
            "flowId": str(item["flowId"]),
            "description": str(item.get("description", "")),
        }
        params = item.get("params")
        if isinstance(params, dict) and params:
            entry["params"] = {
                k: v
                for k, v in params.items()
                if isinstance(v, dict) and v.get("target")
            }
        registry[name] = entry
    return registry


def describe_skills() -> str:
    registry = load_skill_registry()
    if not registry:
        return "（当前没有可用的 Langflow 技能；在 .env.local 配置 LANGFLOW_SKILLS_JSON 后可用）"
    lines = []
    for name, item in registry.items():
        desc = f" — {item['description']}" if item["description"] else ""
        lines.append(f"- {name}{desc}")
        for pname, p in (item.get("params") or {}).items():
            lines.append(f"    参数 {pname}: {p.get('desc', '')}")
    return "\n".join(lines)


def list_skills_payload() -> List[Dict[str, Any]]:
    """结构化技能清单（前端 slash 菜单用）。"""
    registry = load_skill_registry()
    return [
        {
            "name": name,
            "description": item.get("description", ""),
            "params": [
                {"name": pname, "desc": p.get("desc", "")}
                for pname, p in (item.get("params") or {}).items()
            ],
        }
        for name, item in registry.items()
    ]


async def run_skill(
    skill: str, input_text: str, params: Optional[Dict[str, Any]] = None
) -> str:
    """调用一个 Langflow 技能（阻塞式），params 按技能表声明翻译成 tweaks。"""
    registry = load_skill_registry()
    entry = registry.get(skill)
    if entry is None:
        return (
            f"技能 {skill!r} 不存在。可用技能：\n{describe_skills()}"
            if registry
            else f"技能 {skill!r} 不存在，且当前没有配置任何技能。"
        )

    tweaks: Dict[str, Any] = {}
    declared = entry.get("params") or {}
    if params:
        unknown = [k for k in params if k not in declared]
        if unknown:
            return (
                f"技能 {skill} 不支持参数：{', '.join(unknown)}。"
                f"可用参数：{', '.join(declared) or '（无）'}"
            )
        for pname, value in params.items():
            target = declared[pname]["target"]
            # Prompt 模板变量字段只收字符串（传 int 会让组件构建 KeyError）
            if isinstance(value, (int, float)):
                value = str(value)
            tweaks.setdefault(target, {})[pname] = value

    text = await run_flow_blocking(
        entry["flowId"], input_value=input_text, tweaks=tweaks or None
    )
    text = text.strip()
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "…（已截断）"
    return text


# ── 提示词 AI 辅助（面板 ✦ 双态按钮：优化扩写 / 看图反推）──────────────────────
# 直连两个单用途 flow（前端已知态显式路由，不经聊天 LLM）：
#   optimize  = 扩写（纯原生链，未选模型走目录默认）；reversal = 看图反推（gpt-5.6-luna 视觉经 DMX）。
# 产物回填面板输入框草稿，用户确认后才随生成落卡。

PROMPT_OPTIMIZE_TEXT_FLOW_ID = os.environ.get("LANGFLOW_PROMPT_OPTIMIZE_TEXT_FLOW_ID", "")
PROMPT_OPTIMIZE_IMAGE_FLOW_ID = os.environ.get("LANGFLOW_PROMPT_OPTIMIZE_IMAGE_FLOW_ID", "")

PROMPT_OPTIMIZE_JOBS: Dict[str, Dict[str, Any]] = {}


def get_prompt_optimize_job(job_id: str) -> Optional[Dict[str, Any]]:
    return PROMPT_OPTIMIZE_JOBS.get(job_id)


def _normalize_asset_url(url: str) -> str:
    """/agent-service/assets/ 相对路径 → agent 本机绝对 URL（组件要 httpx 下载）"""
    u = str(url or "").strip()
    if u.startswith(("/agent-service/assets/", "/assets/")):
        return ASSET_BASE_URL + "/assets/" + u.rsplit("/", 1)[-1]
    return u


async def start_prompt_optimize_job(
    mode: str,
    prompt: str,
    image_urls: Optional[List[str]],
    context_notes: str,
    model: str = "",
) -> str:
    """mode：调用方（前端按按钮态）显式路由——
    "optimize" 优化扩写（prompt 必填，纯文本，model 可覆盖文本模型，空=出厂 deepseek-v4-flash）；
    "reversal" 看图反推（参考图必填，gpt-5.6-luna 视觉，模型在 flow 的 model_name 字段换）。"""
    if mode == "optimize":
        if not PROMPT_OPTIMIZE_TEXT_FLOW_ID:
            raise RuntimeError(
                "未配置 LANGFLOW_PROMPT_OPTIMIZE_TEXT_FLOW_ID（flow 见 agent/flows/prompt-optimize-text.json）"
            )
        text = " ".join(str(prompt or "")[:2000].split())
        if not text:
            raise RuntimeError("优化扩写需要非空提示词")
        context = " ".join(str(context_notes or "")[:1200].split())
        input_value = f"【上下文设定】\n{context or '（无）'}\n\n【当前提示词】\n{text}"
        tweaks = (
            {"LanguageModelComponent": models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID)}
        )
    elif mode == "reversal":
        if not PROMPT_OPTIMIZE_IMAGE_FLOW_ID:
            raise RuntimeError(
                "未配置 LANGFLOW_PROMPT_OPTIMIZE_IMAGE_FLOW_ID（flow 见 agent/flows/prompt-optimize-image.json）"
            )
        if not DMX_API_KEY:
            raise RuntimeError("未配置 DMX_API_KEY，看图反推不可用")
        urls = [_normalize_asset_url(u) for u in (image_urls or []) if str(u).strip()][:4]
        if not urls:
            raise RuntimeError("看图反推需要至少一张参考图")
        # 字段一律拍平成单行：langflow tweaks 传输会把 \n 反转义成裸换行，
        # 组件里 json.loads 会报 Invalid control character（imagegen 同款防坑）
        payload = {
            "image_urls": urls,
            "context_notes": " ".join(str(context_notes or "")[:1200].split()),
        }
        input_value = ""
        tweaks = {
            "PromptOptimize-main": {
                "payload": json.dumps(payload, ensure_ascii=False),
                "api_key": DMX_API_KEY,
            }
        }
    else:
        raise RuntimeError(f"未知 mode：{mode}（可选 optimize / reversal）")

    job_id = uuid.uuid4().hex[:12]
    PROMPT_OPTIMIZE_JOBS[job_id] = {"status": "running", "result": None, "error": None}

    async def run() -> None:
        try:
            flow_id = (
                PROMPT_OPTIMIZE_TEXT_FLOW_ID if mode == "optimize" else PROMPT_OPTIMIZE_IMAGE_FLOW_ID
            )
            raw = await run_flow_blocking(flow_id, input_value=input_value, tweaks=tweaks)
            if raw.startswith("（"):
                PROMPT_OPTIMIZE_JOBS[job_id].update(status="done", error=raw.strip("（）"))
            else:
                PROMPT_OPTIMIZE_JOBS[job_id].update(status="done", result=raw)
        except Exception as e:  # noqa: BLE001
            PROMPT_OPTIMIZE_JOBS[job_id].update(status="done", error=str(e)[:200])
        finally:
            done = [k for k, v in PROMPT_OPTIMIZE_JOBS.items() if v["status"] == "done"]
            for k in done[:-49]:
                PROMPT_OPTIMIZE_JOBS.pop(k, None)

    asyncio.create_task(run())
    return job_id


# ── 画风反推（我的画风：参考图 → 画风描述草稿）───────────────────────────────
# 单用途 flow（style-reverse.json，gemini 视觉经 DMX），与看图反推同范式不同
# 提示词：只提炼可复用画风，不带主体/构图。产物回填「新建画风」草稿框。

STYLE_REVERSE_FLOW_ID = os.environ.get("LANGFLOW_STYLE_REVERSE_FLOW_ID", "")

STYLE_REVERSE_JOBS: Dict[str, Dict[str, Any]] = {}


def get_style_reverse_job(job_id: str) -> Optional[Dict[str, Any]]:
    return STYLE_REVERSE_JOBS.get(job_id)


async def start_style_reverse_job(image_urls: Optional[List[str]]) -> str:
    if not STYLE_REVERSE_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_STYLE_REVERSE_FLOW_ID（flow 见 agent/flows/style-reverse.json）"
        )
    if not DMX_API_KEY:
        raise RuntimeError("未配置 DMX_API_KEY，画风反推不可用")
    urls = [_normalize_asset_url(u) for u in (image_urls or []) if str(u).strip()][:4]
    if not urls:
        raise RuntimeError("画风反推需要至少一张参考图")
    # 字段拍平成单行：tweaks 传输会把 \n 反转义成裸换行（imagegen 同款防坑）
    payload = {"image_urls": urls}
    tweaks = {
        "StyleReverse-main": {
            "payload": json.dumps(payload, ensure_ascii=False),
            "api_key": DMX_API_KEY,
        }
    }
    job_id = uuid.uuid4().hex[:12]
    STYLE_REVERSE_JOBS[job_id] = {"status": "running", "result": None, "error": None}

    async def run() -> None:
        try:
            raw = await run_flow_blocking(STYLE_REVERSE_FLOW_ID, input_value="", tweaks=tweaks)
            if raw.startswith("（"):
                STYLE_REVERSE_JOBS[job_id].update(status="done", error=raw.strip("（）"))
            else:
                STYLE_REVERSE_JOBS[job_id].update(status="done", result=raw)
        except Exception as e:  # noqa: BLE001
            STYLE_REVERSE_JOBS[job_id].update(status="done", error=str(e)[:200])
        finally:
            done = [k for k, v in STYLE_REVERSE_JOBS.items() if v["status"] == "done"]
            for k in done[:-49]:
                STYLE_REVERSE_JOBS.pop(k, None)

    asyncio.create_task(run())
    return job_id


# ── 资产参考图调研 flow 调用（planner 文本链 + 终选视觉链）──────────────────────

REF_PLAN_FLOW_ID = os.environ.get("LANGFLOW_REF_PLAN_FLOW_ID", "")
REF_BRIEF_FLOW_ID = os.environ.get("LANGFLOW_REF_BRIEF_FLOW_ID", "")
REF_SELECT_FLOW_ID = os.environ.get("LANGFLOW_REF_SELECT_FLOW_ID", "")


def _parse_flow_json(raw: str, what: str) -> Dict[str, Any]:
    """flow 返回文本 → 严格 JSON dict；解析失败明报（不静默兜底）。

    注意错误伪装链：run_flow_blocking 会把 flow 内部错误当文本返回（以「（」
    包裹的中文报错），先识别再解析，避免把错误文本截括号当 JSON。"""
    text = (raw or "").strip()
    if text.startswith("（") and text.endswith("）"):
        raise RuntimeError(f"{what}失败：{text.strip('（）')}")
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError(f"{what}返回不是 JSON：{text[:120]}")
    try:
        out = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{what}JSON 解析失败：{e}（原文：{text[:120]}）") from e
    if not isinstance(out, dict):
        raise RuntimeError(f"{what}返回不是 JSON 对象")
    return out


async def run_ref_plan_flow(
    asset: Dict[str, Any], rounds: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """搜索词规划：资产上下文+已完成轮次 → {queries: [...], enough: bool}。"""
    if not REF_PLAN_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_REF_PLAN_FLOW_ID（flow 见 agent/flows/ref-research-plan.json）"
        )
    payload = {"asset": asset, "rounds": rounds}
    # 字段拍平成单行：tweaks 传输会把 \n 反转义成裸换行（imagegen 同款防坑）
    input_value = " ".join(str(json.dumps(payload, ensure_ascii=False)).split())
    # luna 偶发 JSON 格式抖动/空 queries（10 路并发下更常见，实测 12 资产
    # 约 1/4 概率）：3 次重试带间隔；连续失败带原文明报，不让单次抖动打死
    # 整个调研任务
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            raw = await run_flow_blocking(REF_PLAN_FLOW_ID, input_value=input_value)
            out = _parse_flow_json(raw, "搜索词规划")
            queries = [str(q).strip() for q in (out.get("queries") or []) if str(q).strip()][:5]
            if queries:
                text_queries = [
                    str(q).strip() for q in (out.get("text_queries") or []) if str(q).strip()
                ][:3]
                return {"queries": queries, "text_queries": text_queries, "enough": bool(out.get("enough"))}
            last_error = RuntimeError(f"搜索词规划未产出有效关键词（原文：{raw[:100]}）")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        if attempt < 2:
            await asyncio.sleep(1.5)
    raise last_error  # type: ignore[misc]


async def run_ref_brief_flow(asset: Dict[str, Any], pages: List[Dict[str, Any]]) -> str:
    """文字考据提纯：资产设定+网页正文 → 考据简报（视觉细节/时代特征/常见
    误用，每条带来源域名）。flow 见 agent/flows/ref-research-brief.json。
    调用方（imgresearch 文路）负责查询词生成与页面抓取的上限控制；这里只
    做一次 LLM 提纯，失败抛错由调用方记软失败（不拦搜图）。"""
    if not REF_BRIEF_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_REF_BRIEF_FLOW_ID（flow 见 agent/flows/ref-research-brief.json）"
        )
    payload = {"asset": asset, "pages": pages}
    # 拍平成单行（plan 同款防坑：tweaks 传输会把 \n 反转义成裸换行）
    input_value = " ".join(str(json.dumps(payload, ensure_ascii=False)).split())
    raw = await run_flow_blocking(
        REF_BRIEF_FLOW_ID,
        input_value=input_value,
        tweaks={
            "LanguageModelComponent": models.text_model_tweaks(
                models.DEFAULT_TEXT_MODEL_ID
            )
        },
        timeout=120,
    )
    if raw.startswith("（"):
        raise RuntimeError(raw.strip("（）")[:200])
    text = raw.strip()
    if not text:
        raise RuntimeError("考据提纯返回空文本")
    return text[:1200]


async def run_ref_select_flow(
    asset: Dict[str, Any], candidates: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """LLM 终选：看候选图 → {recommended: [index...], note: str}。

    索引对应 candidates 顺序（0 基，payload 里已带全局 index），调用方
    负责回填 recommended 字段。看图模型 gpt-5.6-luna（DMX gpt 通道）
    上游单请求限 50 张图（100 张实测报 "Too many images in request: 51,
    maximum allowed: 50"），批大小定 50，>50 自动分批合并推荐；单批失败
    只记该批，不拖垮其余批。"""
    if not REF_SELECT_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_REF_SELECT_FLOW_ID（flow 见 agent/flows/ref-research-select.json）"
        )
    if not DMX_API_KEY:
        raise RuntimeError("未配置 DMX_API_KEY，参考图终选不可用")
    if not candidates:
        raise RuntimeError("终选需要至少一张候选图")

    batches = [candidates[i : i + 50] for i in range(0, len(candidates), 50)]
    recommended: List[int] = []
    notes: List[str] = []
    batch_errors: List[str] = []
    for bi, batch in enumerate(batches, 1):
        # 字段拍平成单行：langflow tweaks 传输会把 \n 反转义成裸换行，组件里
        # json.loads 报 Invalid control character（imagegen/画风反推同款防坑；
        # 批量资产的 description 是多行正文，不拍平终选必炸）
        # 所有字符串字段统一拍平（tweaks 传输会把 \n 反转义成裸换行，载荷里
        # 任何多行字段都会炸组件的 json.loads——research_brief 注入时踩过）
        flat_asset = {
            k: " ".join(str(v).split()) if isinstance(v, str) else v
            for k, v in asset.items()
        }
        flat_batch = [
            {**c, "title": " ".join(str(c.get("title") or "").split())}
            for c in batch
        ]
        payload = {"asset": flat_asset, "candidates": flat_batch}
        tweaks = {
            "RefSelect-main": {
                "payload": json.dumps(payload, ensure_ascii=False),
                "api_key": DMX_API_KEY,
            }
        }
        # 每批 3 次重试带间隔：批量 10 路并发下终选偶发失败（重试即恢复），
        # 失败会导致该资产无推荐预选，审阅体验明显劣化
        batch_error: Exception | None = None
        for attempt in range(3):
            try:
                raw = await run_flow_blocking(REF_SELECT_FLOW_ID, input_value="", tweaks=tweaks)
                out = _parse_flow_json(raw, f"参考图终选（第{bi}批）")
                recommended.extend(
                    int(i)
                    for i in (out.get("recommended") or [])
                    if isinstance(i, (int, float, str)) and str(i).strip().lstrip("-").isdigit()
                )
                if str(out.get("note") or "").strip():
                    notes.append(f"第{bi}批：{str(out['note']).strip()}")
                batch_error = None
                break
            except Exception as exc:  # noqa: BLE001 单批失败先重试再记错
                batch_error = exc
                if attempt < 2:
                    await asyncio.sleep(1.5)
        if batch_error is not None:
            batch_errors.append(f"第{bi}批：{str(batch_error)[:100]}")
    if batch_errors and not recommended and not notes:
        raise RuntimeError("；".join(batch_errors))
    note = "；".join(notes)[:300]
    if batch_errors:
        note = (note + ("；" if note else "") + "；".join(batch_errors))[:300]
    return {"recommended": sorted(set(recommended)), "note": note}


# ── 文本撰写/改写（画布文本卡/剧本卡底部输入条的直连管线）──────────────────────
# 指令+正文+参考上下文 → 处理后全文。模型解析 = 卡片 data.textModel → 出厂默认
# （前端 TextModelChip 写卡，经 models.text_model_tweaks 注入组件名）。

TEXTWRITE_FLOW_ID = os.environ.get("LANGFLOW_TEXTWRITE_FLOW_ID", "")

TEXTWRITE_JOBS: Dict[str, Dict[str, Any]] = {}


def get_text_rewrite_job(job_id: str) -> Optional[Dict[str, Any]]:
    return TEXTWRITE_JOBS.get(job_id)


async def start_text_rewrite_job(
    instruction: str,
    body: str,
    context: str = "",
    model: str = "",
) -> str:
    """正文撰写/改写：instruction 必填；body 空=直接创作。异步任务（同
    prompt-optimize 范式），结果为处理后的全文。"""
    if not TEXTWRITE_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_TEXTWRITE_FLOW_ID（flow 见 agent/flows/text-write.json）"
        )
    instruction = str(instruction or "").strip()[:2000]
    if not instruction:
        raise RuntimeError("撰写/改写需要非空指令")
    body = str(body or "")[:16000]
    context = str(context or "")[:4000]
    input_value = (
        f"【指令】{instruction}\n"
        f"【正文】\n{body or '（空，直接按指令与参考上下文创作）'}\n"
        f"【参考上下文】\n{context or '（无）'}"
    )
    tweaks = (
        {"LanguageModelComponent": models.text_model_tweaks(model or models.DEFAULT_TEXT_MODEL_ID)}
    )

    job_id = uuid.uuid4().hex[:12]
    TEXTWRITE_JOBS[job_id] = {"status": "running", "result": None, "error": None}

    async def run() -> None:
        try:
            raw = await run_flow_blocking(
                TEXTWRITE_FLOW_ID, input_value=input_value, tweaks=tweaks
            )
            if raw.startswith("（"):
                TEXTWRITE_JOBS[job_id].update(status="done", error=raw.strip("（）"))
            else:
                TEXTWRITE_JOBS[job_id].update(status="done", result=raw)
        except Exception as e:  # noqa: BLE001
            TEXTWRITE_JOBS[job_id].update(status="done", error=str(e)[:200])
        finally:
            done = [k for k, v in TEXTWRITE_JOBS.items() if v["status"] == "done"]
            for k in done[:-49]:
                TEXTWRITE_JOBS.pop(k, None)

    asyncio.create_task(run())
    return job_id
