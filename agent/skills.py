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
from pydantic import BaseModel, Field, ValidationError
from typing_extensions import Literal

LANGFLOW_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")
LANGFLOW_API_KEY = os.environ.get("LANGFLOW_API_KEY", "")
DECOMPOSE_FLOW_ID = os.environ.get("LANGFLOW_DECOMPOSE_FLOW_ID", "")
# 分类型拆解 flow（ai-moive-studio 范式：角色/场景/道具各自独立调用，
# 单次输出小、按类型定制提示词、三路并发、单类失败不拖累其他）
DECOMPOSE_FLOW_IDS = {
    "character": os.environ.get("LANGFLOW_DECOMPOSE_CHARACTER_FLOW_ID", ""),
    "scene": os.environ.get("LANGFLOW_DECOMPOSE_SCENE_FLOW_ID", ""),
    "prop": os.environ.get("LANGFLOW_DECOMPOSE_PROP_FLOW_ID", ""),
}
IMAGEGEN_FLOW_ID = os.environ.get("LANGFLOW_IMAGEGEN_FLOW_ID", "")
DMX_API_KEY = os.environ.get("DMX_API_KEY", "")
VOLC_SEARCH_API_KEY = os.environ.get("VOLC_SEARCH_API_KEY", "")
# 出图参考图回给 langflow 下载用的本机地址（/assets 未鉴权、文件名随机 hex）
AGENT_BASE_URL = os.environ.get("AGENT_BASE_URL", "http://127.0.0.1:8123")

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


class Asset(BaseModel):
    type: Literal["character", "scene", "prop"]
    name: str = Field(min_length=1)
    description: str = ""
    visual_notes: str = ""


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

    配置了三个分类型 flow 时三路并发调用（各拆一类，单类失败记入
    errors 不拖累其他）；否则回落到单一合并 flow。existing：画布已有
    资产 [{type, name}]，注入名单让 LLM 沿用旧名（跨次拆解去重合并）。
    返回 (assets, errors)；assets 为空时 errors 至少含一条。
    """
    rosters = {
        t: [e for e in existing or [] if e.get("type") == t]
        for t in DECOMPOSE_FLOW_IDS
    }
    if all(DECOMPOSE_FLOW_IDS[t] for t in DECOMPOSE_FLOW_IDS):

        async def one(ttype: str) -> List[Dict[str, Any]]:
            return await _decompose_one_type(
                DECOMPOSE_FLOW_IDS[ttype], ttype, script, rosters[ttype]
            )

        results = await asyncio.gather(
            *[one(t) for t in DECOMPOSE_FLOW_IDS], return_exceptions=True
        )
        merged: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        for ttype, res in zip(DECOMPOSE_FLOW_IDS, results):
            if isinstance(res, BaseException):
                errors[ttype] = str(res)[:200]
            else:
                merged.extend(res)
        return merged, errors

    merged, errors = await _decompose_legacy(script, existing)
    return merged, errors


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
    # flow 提示词已限定类型，这里再强制对齐一次（防模型串类）
    return [
        {"type": ttype, "name": a.name, "description": a.description, "visual_notes": a.visual_notes}
        for a in asset_list.assets
    ]


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
    assets: List[Dict[str, Any]], config: Any = None
) -> str:
    """逐资产并发出图（并发 3），每张完成即向聊天流推送进度（若有 config）。

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

    sem = asyncio.Semaphore(3)
    done = [0]
    total = len(assets)
    if config is not None:
        await _emit_progress(
            config, f"开始为 {total} 项资产生成设定图（并发 3，每张完成会播报）…"
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


async def start_storyboard_image_job(shots: List[Dict[str, Any]]) -> str:
    """启动分镜行批量出图任务（直连 imagegen flow，并发 3，不经聊天）。

    shots: [{rid, name, description, visual_notes?}]，字段与出图 flow 的
    资产载荷一致（type 固定 scene，镜头画面不是角色设定图）。
    立即返回 jobId；每张完成即写入任务状态，前端轮询增量取走。
    """
    if not IMAGEGEN_FLOW_ID:
        raise RuntimeError("未配置 LANGFLOW_IMAGEGEN_FLOW_ID（flow 见 agent/flows/asset-imagegen.json）")
    if not DMX_API_KEY:
        raise RuntimeError("未配置 DMX_API_KEY，出图不可用")
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

    sem = asyncio.Semaphore(3)

    async def one(shot: Dict[str, Any]) -> None:
        rid = str(shot.get("rid", ""))
        # flow 载荷只认 {type,name,description,visual_notes,reference_images?,search_query?}：
        # rid 不能进 payload（会被渲染进出图提示词）。
        # 字段一律拍平成单行：langflow tweaks 传输会把 \n 反转义成裸换行，
        # 组件里 json.loads 会报 Invalid control character
        def flat(value: Any) -> str:
            return " ".join(str(value or "").split())

        payload: Dict[str, Any] = {
            "type": flat(shot.get("assetType") or "scene"),
            "name": flat(shot.get("name") or rid or "镜头"),
            "description": flat(shot.get("description")),
        }
        if shot.get("visual_notes"):
            payload["visual_notes"] = flat(shot["visual_notes"])
        # 定妆照等一致性锚点：/agent-service/assets/ 相对路径 → agent 本机绝对
        # URL（langflow 经 http 下载；/assets 未鉴权，文件名为随机 hex）
        ref_images = [
            AGENT_BASE_URL + "/assets/" + u.rsplit("/", 1)[-1]
            if u.startswith(("/agent-service/assets/", "/assets/"))
            else str(u)
            for u in (shot.get("referenceImages") or [])
            if str(u).strip()
        ]
        if ref_images:
            payload["reference_images"] = ref_images
        async with sem:
            result: Dict[str, Any]
            try:
                raw = await run_flow_blocking(
                    IMAGEGEN_FLOW_ID,
                    tweaks={
                        "BatchAssetSheet-img02": {
                            "assets_payload": json.dumps(
                                {"assets": [payload]}, ensure_ascii=False
                            ),
                            "api_key": DMX_API_KEY,
                        }
                    },
                )
            except Exception as e:  # noqa: BLE001
                result = {"rid": rid, "ok": False, "error": str(e)[:200]}
            else:
                url = _extract_image_url(raw)
                if url:
                    result = {"rid": rid, "ok": True, "imageUrl": url}
                else:
                    result = {"rid": rid, "ok": False, "error": raw[:200]}
            STORYBOARD_IMAGE_JOBS[job_id]["images"][rid] = result

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
