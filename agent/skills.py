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
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field, ValidationError, model_validator
from typing_extensions import Literal

import models

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

def _parse_shot_rows(text: str) -> list[dict]:
    """从 flow 输出文本中解析分镜 JSON 数组（容错：剥围栏、截取首尾括号）。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip()
        if t.startswith("json"):
            t = t[4:].lstrip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("输出里没有 JSON 数组")
    arr = json.loads(t[start : end + 1])
    rows = []
    for i, it in enumerate(arr):
        if not isinstance(it, dict):
            continue
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
            }
        )
    return rows


# 分镜表生成任务表：jobId -> {"status": running|done, "rows"| "error"}
STORYBOARD_GEN_JOBS: Dict[str, Dict[str, Any]] = {}


def get_storyboard_gen_job(job_id: str) -> Optional[Dict[str, Any]]:
    return STORYBOARD_GEN_JOBS.get(job_id)


async def start_storyboard_gen_job(
    script: str,
    shot_count: Optional[int] = None,
    duration_seconds: Optional[int] = None,
    visual_style: str = "",
    assets: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """启动分镜表生成任务（异步：代理 30s 掐断长请求）。返回 jobId。"""
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
    label = {"character": "角色", "scene": "场景", "prop": "道具", "costume": "服饰"}
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
    input_value = "\n".join(parts)

    job_id = uuid.uuid4().hex[:12]
    STORYBOARD_GEN_JOBS[job_id] = {"status": "running", "rows": None, "error": None}

    async def run() -> None:
        state = STORYBOARD_GEN_JOBS[job_id]
        try:
            text = await run_flow_blocking(
                flow_id,
                input_value=input_value,
                tweaks={"LanguageModelComponent": {"temperature": 0.4}},
            )
            state["rows"] = _parse_shot_rows(text)
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
PROMPT_OPTIMIZE_FLOW_ID = os.environ.get("LANGFLOW_PROMPT_OPTIMIZE_FLOW_ID", "")
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


async def run_flow_blocking(flow_id: str, input_value: str = "", tweaks: Optional[Dict[str, Any]] = None) -> str:
    """阻塞式跑一个 flow，返回末端输出组件的消息文本。"""
    headers = {"Content-Type": "application/json"}
    if LANGFLOW_API_KEY:
        headers["x-api-key"] = LANGFLOW_API_KEY

    payload: Dict[str, Any] = {
        "input_value": input_value,
        "input_type": "chat",
        "output_type": "chat",
    }
    if tweaks:
        payload["tweaks"] = tweaks

    try:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{LANGFLOW_URL}/api/v1/run/{flow_id}",
                headers=headers,
                json=payload,
            )
            if resp.status_code >= 400:
                detail = resp.text[:300]
                return f"（langflow 返回 {resp.status_code}：{detail}）"
            data = resp.json()
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
        label = {"character": "角色", "scene": "场景", "prop": "道具"}[a["type"]]
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
) -> tuple[List[Dict[str, Any]], Dict[str, str]]:
    """拆解剧本为结构化资产清单（直连端点用）。

    已配置的分类型 flow 各拆一类、并行调用（character/scene/prop/costume
    四路；单类失败记入 errors 不拖累其他；未配置的类型直接跳过，不回退整
    条 legacy）。existing：画布已有资产 [{type, name}]，注入名单让 LLM
    沿用旧名（跨次拆解去重合并）。返回 (assets, errors)。
    """
    configured = {t: fid for t, fid in DECOMPOSE_FLOW_IDS.items() if fid}
    if not configured:
        return await _decompose_legacy(script, existing)

    rosters = {
        t: [e for e in existing or [] if e.get("type") == t] for t in configured
    }

    async def one(ttype: str) -> List[Dict[str, Any]]:
        return await _decompose_one_type(
            configured[ttype], ttype, script, rosters[ttype]
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
) -> str:
    """启动资产拆解任务，立即返回 jobId（前端轮询 GET /assets/decompose/{jobId}）。

    auto_looks=True 时拆解完成后自动续跑角色出图链（juben 全自动范式：
    每角色先出定妆照，再以其为身份参考图逐个出 Look 造型图），
    结果写回 asset 条目（image_url / looks[i].image_url）。
    params：出图模型/分辨率覆盖（models.resolve_imagegen_params 产物）。
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
                script, existing=existing
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
                    state["images_note"] = await _auto_asset_images(
                        assets, state, visual_style, existed, params=params
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
) -> str:
    """资产图自动链（juben collect_pending_character_materials 泛化）：
    ① 服饰结构图先行（Look 的一致性锚点之二）
    ② 角色定妆照 / 场景概念图 / 道具设定图 并发
    ③ 角色 Look 造型图（参考图1=定妆照身份锚点，参考图2=绑定服饰的结构图）
    结果写回 asset 条目（image_url / looks[i].image_url）；单张失败记 error
    不拖累其他。并发 30；每类上限 8、每角色 Look 上限 4（防成本失控）。
    existed：画布已有 (type, name) 集合，命中跳过。返回汇报 note。"""
    existed = existed or set()
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
            "visualNotes": style_note,
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

        async def one_look(l: Dict[str, Any]) -> None:
            # 参考图2：绑定的服饰卡结构图（按名模糊对上才加）
            refs = [a["image_url"]]
            cname = str(l.get("costume") or "").strip()
            costume_img = next(
                (
                    c["image_url"]
                    for c in assets
                    if c.get("type") == "costume"
                    and c.get("image_url")
                    and cname
                    and (cname in str(c.get("name") or "") or str(c.get("name") or "") in cname)
                ),
                None,
            )
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
                "visualNotes": style_note,
                "referenceImages": refs,
            })
            if r.get("ok") and r.get("imageUrl"):
                l["image_url"] = r["imageUrl"]
            else:
                l["error"] = str(r.get("error") or "出图失败")[:200]

        looks = (a.get("looks") or [])[:_AUTO_LOOK_CAP]
        await asyncio.gather(*[one_look(l) for l in looks])

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
    )
    state["progress"] = {"done": 0, "total": total_target[0]}

    # ① 服饰先行（Look 的参考图2）② 角色定妆照(+Looks)/场景/道具 并发
    await asyncio.gather(*[one_costume(a) for a in costumes])
    await asyncio.gather(
        *([one_char(a) for a in chars] + [gen_main(a, "scene") for a in scenes] + [gen_main(a, "prop") for a in props])
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
        tweaks={"LanguageModelComponent": {"temperature": 0.1}},
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
        tweaks={"LanguageModelComponent": {"temperature": 0.1}},
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

    # 未配置豆包搜索 key 时剥掉 search_query：组件对带该字段的资产强制要求
    # 搜索 key，剥掉后走纯文生图（参考图是增强项，不影响出图）
    if not VOLC_SEARCH_API_KEY:
        assets = [{k: v for k, v in a.items() if k != "search_query"} for a in assets]

    sem = asyncio.Semaphore(30)
    done = [0]
    total = len(assets)
    if config is not None:
        await _emit_progress(
            config, f"开始为 {total} 项资产生成设定图（并发 30，每张完成会播报）…"
        )

    async def one(asset: Dict[str, Any]) -> str:
        name = str(asset.get("name", "?"))
        async with sem:
            raw = await run_flow_blocking(
                IMAGEGEN_FLOW_ID,
                tweaks={
                    "BatchAssetSheet-img02": {
                        "assets_payload": json.dumps(
                            {"assets": [asset]}, ensure_ascii=False
                        ),
                        "api_key": DMX_API_KEY,
                        **(params or {}),
                    }
                },
            )
        done[0] += 1
        line = _format_asset_result(name, raw)
        if config is not None:
            try:
                await _emit_progress(config, f"出图 {done[0]}/{total}：{line}")
            except Exception as e:  # noqa: BLE001
                print(f"[emit_progress 失败] {type(e).__name__}: {e}", flush=True)
        return line

    lines = await asyncio.gather(*[one(a) for a in assets])
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


def _extract_image_url(raw: str) -> Optional[str]:
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
                return f"/agent-service/assets/{dest}"
    except (json.JSONDecodeError, IndexError, KeyError):
        pass
    return None


def _format_asset_result(name: str, raw: str) -> str:
    """把单资产 flow 结果整理为一行汇报（成功附 image_url）。"""
    url = _extract_image_url(raw)
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
    return STORYBOARD_IMAGE_JOBS.get(job_id)


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

    payload: Dict[str, Any] = {
        "type": flat(shot.get("assetType") or "scene"),
        "name": flat(shot.get("name") or "资产"),
        "description": flat(shot.get("description")),
    }
    if shot.get("visual_notes"):
        payload["visual_notes"] = flat(shot["visual_notes"])
    # 资产级画幅覆写（分镜图幅面：9:16/21:9 等）；格式校验在 flow 侧，
    # 不合法会得到中文报错并落到该图卡的 error 上
    if shot.get("aspect"):
        payload["aspect"] = flat(shot["aspect"])
    # 定妆照等一致性锚点：/agent-service/assets/ 相对路径 → agent 本机绝对
    # URL（langflow 经 http 下载；/assets 未鉴权，文件名为随机 hex）
    ref_images = [
        ASSET_BASE_URL + "/assets/" + u.rsplit("/", 1)[-1]
        if u.startswith(("/agent-service/assets/", "/assets/"))
        else str(u)
        for u in (shot.get("referenceImages") or [])
        if str(u).strip()
    ]
    if ref_images:
        payload["reference_images"] = ref_images
    try:
        raw = await run_flow_blocking(
            IMAGEGEN_FLOW_ID,
            tweaks={
                "BatchAssetSheet-img02": {
                    "assets_payload": json.dumps(
                        {"assets": [payload]}, ensure_ascii=False
                    ),
                    "api_key": DMX_API_KEY,
                    **(params or {}),
                }
            },
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}
    url = _extract_image_url(raw)
    if url:
        return {"ok": True, "imageUrl": url}
    return {"ok": False, "error": raw[:200]}


async def start_storyboard_image_job(
    shots: List[Dict[str, Any]], params: Optional[Dict[str, str]] = None
) -> str:
    """启动分镜行批量出图任务（直连 imagegen flow，并发 30，不经聊天）。

    shots: [{rid, name, description, visual_notes?, aspect?,
             params?: {model?, resolution?}}]，字段与出图 flow 的资产载荷
    一致（type 固定 scene，镜头画面不是角色设定图）。params：请求级出图
    模型/分辨率；镜头级 params 覆盖请求级（卡片级覆盖），逐镜头合并后
    预校验——任一组合不合法整批 ValueError（端点转 400 明报）。
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
        merged = {**(params or {}), **(s.get("params") or {})}
        try:
            resolved[rid] = models.resolve_imagegen_params(merged or None)
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
        "images": {str(s.get("rid", "")): {"rid": str(s.get("rid", "")), "ok": False} for s in shots},
    }

    sem = asyncio.Semaphore(30)

    async def one(shot: Dict[str, Any]) -> None:
        rid = str(shot.get("rid", ""))
        async with sem:
            result = await _generate_single_image(shot, params=resolved.get(rid))
        STORYBOARD_IMAGE_JOBS[job_id]["images"][rid] = {"rid": rid, **result}

    async def run() -> None:
        try:
            await asyncio.gather(*[one(s) for s in shots])
        finally:
            STORYBOARD_IMAGE_JOBS[job_id]["status"] = "done"

    asyncio.create_task(run())
    return job_id


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
# 直连「提示词优化」flow（deepseek-v4-flash 视觉，DMX），不经聊天 LLM。
# 产物回填面板输入框草稿，用户确认后才随生成落卡。

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
    prompt: str, image_urls: Optional[List[str]], context_notes: str
) -> str:
    if not PROMPT_OPTIMIZE_FLOW_ID:
        raise RuntimeError(
            "未配置 LANGFLOW_PROMPT_OPTIMIZE_FLOW_ID（flow 见 agent/flows/prompt-optimize.json）"
        )
    if not DMX_API_KEY:
        raise RuntimeError("未配置 DMX_API_KEY，提示词优化不可用")
    prompt = str(prompt or "").strip()
    urls = [_normalize_asset_url(u) for u in (image_urls or []) if str(u).strip()][:4]
    if not prompt and not urls:
        raise RuntimeError("提示词为空且无参考图：没有可优化的对象")
    # 字段一律拍平成单行：langflow tweaks 传输会把 \n 反转义成裸换行，
    # 组件里 json.loads 会报 Invalid control character（imagegen 同款防坑）
    payload = {
        "prompt": " ".join(prompt[:2000].split()),
        "image_urls": urls,
        "context_notes": " ".join(str(context_notes or "")[:1200].split()),
    }

    job_id = uuid.uuid4().hex[:12]
    PROMPT_OPTIMIZE_JOBS[job_id] = {"status": "running", "result": None, "error": None}

    async def run() -> None:
        try:
            raw = await run_flow_blocking(
                PROMPT_OPTIMIZE_FLOW_ID,
                tweaks={
                    "PromptOptimize-main": {
                        "payload": json.dumps(payload, ensure_ascii=False),
                        "api_key": DMX_API_KEY,
                    }
                },
            )
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
