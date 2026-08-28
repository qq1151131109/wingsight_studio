"""Langflow 技能执行器：把已有 flow 当作主 Agent 的 HTTP 工具调用。

调用统一走 v1 阻塞式 run API（/api/v1/run/{flow_id}）：
工具型调用需要完整结果，阻塞拿全量比 agui 事件流收集可靠
（纯链式 flow 在 agui 协议下不产生 TEXT_MESSAGE 事件）。
"""

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
IMAGEGEN_FLOW_ID = os.environ.get("LANGFLOW_IMAGEGEN_FLOW_ID", "")
DMX_API_KEY = os.environ.get("DMX_API_KEY", "")
VOLC_SEARCH_API_KEY = os.environ.get("VOLC_SEARCH_API_KEY", "")

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
    if not DECOMPOSE_FLOW_ID:
        return "（未配置 LANGFLOW_DECOMPOSE_FLOW_ID，资产拆解技能不可用）"

    raw = await run_flow_blocking(
        DECOMPOSE_FLOW_ID,
        input_value=script,
        # 拆解要确定性：每次调用定点压低温度，不依赖 flow 里的设置
        tweaks={"LanguageModelComponent": {"temperature": 0.1}},
    )
    if raw.startswith("（"):
        return f"拆解技能调用失败：{raw}"

    obj_text = _extract_json_object(raw)
    if not obj_text:
        return (
            "拆解技能返回的不是 JSON（可能提示词被改动过）。原始输出前 300 字：\n"
            + raw[:300]
        )
    try:
        asset_list = AssetList.model_validate_json(obj_text)
    except ValidationError as exc:
        return (
            "拆解结果未通过结构校验，请告诉用户拆解技能的输出格式有问题。问题：\n"
            + str(exc.errors()[:3])
        )

    if not asset_list.assets:
        return "（拆解结果为空：剧本里没有拆出任何资产）"

    lines = [f"共拆出 {len(asset_list.assets)} 个资产："]
    for i, a in enumerate(asset_list.assets, 1):
        label = {"character": "角色", "scene": "场景", "prop": "道具"}[a.type]
        lines.append(
            f"{i}. [{label}] {a.name}｜{a.description}"
            + (f"｜视觉：{a.visual_notes}" if a.visual_notes else "")
        )
    return "\n".join(lines)


# ---------- 资产出图 ----------


async def generate_asset_images(assets: List[Dict[str, Any]]) -> str:
    """调出图 flow 批量生成设定图，返回给 LLM 的结果清单。

    成功的图片复制到 agent/static/assets/ 并以 /agent-service/assets/<file>
    相对路径回传（前端同源代理可直接 <img> 渲染）。
    """
    if not IMAGEGEN_FLOW_ID:
        return "（未配置 LANGFLOW_IMAGEGEN_FLOW_ID，出图技能不可用）"
    if not assets:
        return "（资产列表为空，没有可生成的资产）"

    # 未配置豆包搜索 key 时剥掉 search_query：组件对带该字段的资产强制要求
    # 搜索 key，剥掉后走纯文生图（参考图是增强项，不影响出图）
    payload_assets = [
        {k: v for k, v in a.items() if k != "search_query"}
        for a in assets
    ] if not VOLC_SEARCH_API_KEY else assets

    raw = await run_flow_blocking(
        IMAGEGEN_FLOW_ID,
        tweaks={
            "BatchAssetSheet-img02": {
                "assets_payload": json.dumps({"assets": payload_assets}, ensure_ascii=False),
                "api_key": DMX_API_KEY,
            }
        },
    )
    if raw.startswith("（"):
        return f"出图技能调用失败：{raw}"

    # flow 返回 JSON（可能裹 ```json 围栏），抽出所有结果对象
    obj_text = _extract_json_object(raw) or _extract_json_objects_loose(raw)
    results: List[Dict[str, Any]] = []
    if obj_text:
        try:
            parsed = json.loads(obj_text)
            results = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:
            results = []

    if not results:
        return (
            "出图 flow 返回的结果无法解析。原始输出前 300 字：\n" + raw[:300]
        )

    lines = []
    for r in results:
        name = r.get("name", "?")
        if r.get("status") == "ok" and r.get("image_path"):
            src = Path(r["image_path"])
            if src.is_file():
                ASSETS_DIR.mkdir(parents=True, exist_ok=True)
                dest = f"{uuid.uuid4().hex[:12]}{src.suffix or '.png'}"
                shutil.copy2(src, ASSETS_DIR / dest)
                lines.append(
                    f"✓ {name}｜image_url=/agent-service/assets/{dest}"
                )
                continue
        err = (r.get("error") or "未知错误")[:120]
        lines.append(f"✗ {name}｜失败：{err}")
    return "\n".join(lines)


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


def load_skill_registry() -> Dict[str, Dict[str, str]]:
    """技能表来自 LANGFLOW_SKILLS_JSON：{"技能名": {"flowId": "...", "description": "..."}}"""
    raw = os.environ.get("LANGFLOW_SKILLS_JSON", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return {
            name: {
                "flowId": str(item.get("flowId", "")),
                "description": str(item.get("description", "")),
            }
            for name, item in data.items()
            if isinstance(item, dict) and item.get("flowId")
        }
    except json.JSONDecodeError:
        return {}


def describe_skills() -> str:
    registry = load_skill_registry()
    if not registry:
        return "（当前没有可用的 Langflow 技能；在 .env.local 配置 LANGFLOW_SKILLS_JSON 后可用）"
    lines = []
    for name, item in registry.items():
        desc = f" — {item['description']}" if item["description"] else ""
        lines.append(f"- {name}{desc}")
    return "\n".join(lines)


async def run_skill(skill: str, input_text: str) -> str:
    """调用一个 Langflow 技能（阻塞式）并返回其文本结果。"""
    registry = load_skill_registry()
    entry = registry.get(skill)
    if entry is None:
        return (
            f"技能 {skill!r} 不存在。可用技能：\n{describe_skills()}"
            if registry
            else f"技能 {skill!r} 不存在，且当前没有配置任何技能。"
        )
    text = await run_flow_blocking(entry["flowId"], input_value=input_text)
    text = text.strip()
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "…（已截断）"
    return text
