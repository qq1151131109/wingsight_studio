"""Langflow 技能执行器：把已有 flow 当作主 Agent 的 HTTP 工具调用。"""

import json
import os
from typing import Any, Dict, List

import httpx

LANGFLOW_URL = os.environ.get("LANGFLOW_URL", "http://localhost:7860")
LANGFLOW_API_KEY = os.environ.get("LANGFLOW_API_KEY", "")

MAX_RESULT_CHARS = 1500


def load_skill_registry() -> Dict[str, Dict[str, str]]:
    """技能表来自 LANGFLOW_SKILLS_JSON：{"技能名": {"flowId": "...", "description": "..."}}"""
    raw = os.environ.get("LANGFLOW_SKILLS_JSON", "").strip()
    if not raw:
        # 未配置技能表时，退回用 LANGFLOW_FLOW_ID 当作一个通用技能（若有）
        flow_id = os.environ.get("LANGFLOW_FLOW_ID", "").strip()
        if flow_id:
            return {
                "默认流程": {
                    "flowId": flow_id,
                    "description": "当前 .env.local LANGFLOW_FLOW_ID 指向的 flow",
                }
            }
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
    """以 AG-UI 流式协议调用 langflow flow，收集文本消息后返回（截断）。"""
    registry = load_skill_registry()
    entry = registry.get(skill)
    if entry is None:
        return (
            f"技能 {skill!r} 不存在。可用技能：\n{describe_skills()}"
            if registry
            else f"技能 {skill!r} 不存在，且当前没有配置任何技能。"
        )

    headers = {"Content-Type": "application/json"}
    if LANGFLOW_API_KEY:
        headers["x-api-key"] = LANGFLOW_API_KEY

    payload = {
        "flow_id": entry["flowId"],
        "input_value": input_text,
        "session_id": None,
        "mode": "stream",
        "stream_protocol": "agui",
    }

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                f"{LANGFLOW_URL}/api/v2/workflows",
                headers=headers,
                json=payload,
            ) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                    return f"langflow 返回 {resp.status_code}：{detail}"
                text = await _collect_agui_text(resp)
    except httpx.HTTPError as exc:
        return f"连不上 langflow（{LANGFLOW_URL}）：{exc}"

    text = text.strip()
    if not text:
        return "技能已执行，但没有返回文本内容。"
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "…（已截断）"
    return text


async def _collect_agui_text(resp: httpx.Response) -> str:
    """解析 SSE 里的 AG-UI 事件，按 message_id 聚合 TEXT_MESSAGE_CONTENT。"""
    chunks: Dict[str, List[str]] = {}
    async for line in resp.aiter_lines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        body = line[5:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "TEXT_MESSAGE_CONTENT":
            mid = event.get("messageId", "_")
            chunks.setdefault(mid, []).append(event.get("delta", ""))
        elif etype == "RUN_ERROR":
            return f"（langflow 运行错误：{str(event.get('message', ''))[:300]}）"
    ordered = sorted(chunks.items())
    return "\n\n".join("".join(parts) for _, parts in ordered)
