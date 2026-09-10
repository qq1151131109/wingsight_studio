"""RunningHub MiniMax H3 参考生视频客户端（ComfyUI 工作流协议）。

2026-09-08 用户拍板：视频只支持 RunningHub 渠道的 MiniMax H3 参考生视频。
协议与节点映射移植自 juben `lib/video_backends/runninghub.py`（实战验证过）：
- 工作流 2088888684010622977（9 参考图槽 + 3 音频槽，无独立主图槽——首帧占
  第 0 槽，其余参考图依次占后续槽，参考上限 8）
- 上传：POST /task/openapi/upload（form：apiKey + fileType=input + 文件）→ fileName
- 建任务：POST /task/openapi/create {apiKey, workflowId, nodeInfoList} → taskId；
  **421 TASK_QUEUE_MAXED = 账号并发满，任务未创建不重复计费**，30s 重试至多 30 分钟
- 轮询：POST /task/openapi/outputs {apiKey, taskId} → code 0 + data[].fileUrl
  （取 video 型产物）；804/813 = 进行中；805 = failedReason 失败
- 时长开关 select = 秒数 − 4（5s→1 … 15s→11）；兆像素开关 1=540p / 2=720p；
  画幅走 ResolutionSelector 枚举（"16:9 (Widescreen)" 等，必须精确匹配）

历史选型实录（2026-09-07 探针留档，供日后扩渠道参考）：DMX /v1/videos 海螺系
取件链坏（双面 artifact_gone）；ark key 未开通 seedance；BigModel cogvideox
双档全通（coding 套餐 key 走官方 paas）——后被本渠道取代，恢复时见
jobstore 前历史 git 版本。

与 compose.py 同范式直连（HTTP 原语不经 Langflow：视频 API 调用不是 LLM
文字生成，提示词在调用方组装逐字可见）。
"""

from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

import usage

RUNNINGHUB_API_KEY = os.environ.get("RUNNINGHUB_API_KEY", "")
_BASE_URL = "https://www.runninghub.cn"
PROMPT_LIMIT = 2000
POLL_INTERVAL = 6
POLL_TIMEOUT = 15 * 60  # 单条轮询上限（工作流实测数分钟，留足余量）
DOWNLOAD_TIMEOUT = 300
QUEUE_RETRY_INTERVAL = 30  # 421 队列满：30s 后重试提交（任务未创建，不重复计费）
QUEUE_MAX_WAIT = 30 * 60

# 工作流 2088888684010622977（MiniMax H3 参考生视频）节点映射——来自工作流
# 编辑器 Export Workflow API JSON（juben 实战维护），改工作流须同步这里
_WORKFLOW_ID = "2088888684010622977"
_NODE_PROMPT = "250"
_NODE_ASPECT = "115"
_NODE_MEGAPIXEL = "225"
_NODE_DURATION = "205"
_NODE_SEED = "129"
_IMAGE_SLOTS = ("231", "232", "233", "234", "235", "236", "237", "238", "239")
MAX_REFERENCES = 8  # 槽位 0 被首帧占用，参考图最多 8 张
_DURATION_SELECT_BASE = 4  # 时长开关 select = 秒数 − 4

# ResolutionSelector 画幅枚举（带说明后缀，必须与节点枚举精确一致）
_ASPECT_ENUMS = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}

# 与 skills.ASSETS_DIR 同一资产根（视频落这里即得 /agent-service/assets/<name>）
ASSETS_DIR = Path(__file__).resolve().parent / "static" / "assets"


def _flat(value: Any) -> str:
    return " ".join(str(value or "").split())


def _read_local_image(url: str) -> Optional[tuple[str, bytes]]:
    """本服务资产 URL → (文件名, bytes)；外部 http(s) URL 返回 None（不下载，
    参考图由调用方保证是本服务资产——分镜链路全是本地镜头图/资产图）。"""
    u = str(url or "").strip()
    if not u:
        return None
    if u.startswith(("http://", "https://")):
        return None
    name = u.rsplit("/", 1)[-1]
    path = ASSETS_DIR / name
    if not path.is_file():
        raise ValueError(f"参考图不存在：{u}")
    return (path.name, path.read_bytes())


async def generate_video(
    prompt: str,
    *,
    image_url: str = "",
    reference_images: Optional[List[str]] = None,
    duration: int = 5,
    resolution: str = "540p",
    aspect: str = "16:9",
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """单条视频生成原语：上传参考图 → 建工作流任务 → 轮询 → 下载落盘。

    image_url = 首帧（占图槽 0，构图基准）；reference_images = 其余参考图
    （资产设定图等，最多 8 张，按序占槽）。返回 {ok, videoUrl?|error}。
    """
    if not RUNNINGHUB_API_KEY:
        return {"ok": False, "error": "未配置 RUNNINGHUB_API_KEY，视频生成不可用"}
    text = _flat(prompt)[:PROMPT_LIMIT]
    if not text:
        return {"ok": False, "error": "运动提示词为空，无法生成视频"}
    try:
        # 图片槽序列：首帧（槽0）+ 参考图（槽1+，超上限截断并明示）
        images: List[tuple[str, bytes]] = []
        for u in [image_url, *(reference_images or [])]:
            local = _read_local_image(u)
            if local is not None:
                images.append(local)
        if not images:
            return {"ok": False, "error": "缺少首帧图（图生视频工作流至少 1 张图）"}
        truncated = max(0, len(images) - len(_IMAGE_SLOTS))
        if truncated:
            images = images[: len(_IMAGE_SLOTS)]
    except ValueError as exc:
        return {"ok": False, "error": str(exc)[:200]}

    dur = max(5, min(15, int(duration or 5)))
    node_info: List[Dict[str, Any]] = [
        {"nodeId": _NODE_PROMPT, "fieldName": "prompt", "fieldValue": text},
        {
            "nodeId": _NODE_ASPECT,
            "fieldName": "aspect_ratio",
            "fieldValue": _ASPECT_ENUMS.get(aspect or "16:9", _ASPECT_ENUMS["16:9"]),
        },
        # 兆像素开关：1 = 0.5MP（约 540p），2 = 1MP（约 720p）
        {"nodeId": _NODE_MEGAPIXEL, "fieldName": "select", "fieldValue": 2 if resolution == "720p" else 1},
        {"nodeId": _NODE_DURATION, "fieldName": "select", "fieldValue": dur - _DURATION_SELECT_BASE},
    ]
    if seed is not None:
        node_info.append({"nodeId": _NODE_SEED, "fieldName": "noise_seed", "fieldValue": int(seed)})

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            # 逐张上传（fileName 进节点信息；本地 bytes 直传，无需公网）
            for slot, (name, blob) in zip(_IMAGE_SLOTS, images):
                r = await client.post(
                    f"{_BASE_URL}/task/openapi/upload",
                    data={"apiKey": RUNNINGHUB_API_KEY, "fileType": "input"},
                    files={"file": (name, blob)},
                )
                r.raise_for_status()
                file_name = str((r.json().get("data") or {}).get("fileName") or "")
                if not file_name:
                    return {"ok": False, "error": f"参考图上传失败：{name}"[:200]}
                node_info.append({"nodeId": slot, "fieldName": "image", "fieldValue": file_name})
        except httpx.HTTPError as exc:
            return {"ok": False, "error": f"参考图上传失败：{exc}"[:200]}

        # 建任务（421 队列满 = 账号并发上限：任务未创建不重复计费，等 30s 重试）
        body = {
            "apiKey": RUNNINGHUB_API_KEY,
            "workflowId": _WORKFLOW_ID,
            "nodeInfoList": node_info,
        }
        task_id = ""
        elapsed = 0.0
        while True:
            try:
                r = await client.post(f"{_BASE_URL}/task/openapi/create", json=body)
            except httpx.HTTPError as exc:
                return {"ok": False, "error": f"任务提交失败：{exc}"[:200]}
            payload = _json_or(r, {})
            code = payload.get("code")
            if str(code) == "421":
                if elapsed >= QUEUE_MAX_WAIT:
                    return {"ok": False, "error": f"RunningHub 队列已满，等待 {elapsed:.0f}s 后放弃（可稍后重试）"}
                await asyncio.sleep(QUEUE_RETRY_INTERVAL)
                elapsed += QUEUE_RETRY_INTERVAL
                continue
            if str(code) not in ("0", "") or "taskId" not in (payload.get("data") or {}):
                return {"ok": False, "error": f"任务提交失败：code={code} {payload.get('msg')}"[:200]}
            task_id = str(payload["data"]["taskId"])
            break

        # 轮询到产物 URL（804/813 = 进行中；805 = 失败带 failedReason）
        deadline = time.monotonic() + POLL_TIMEOUT
        file_url = ""
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                r = await client.post(
                    f"{_BASE_URL}/task/openapi/outputs",
                    json={"apiKey": RUNNINGHUB_API_KEY, "taskId": task_id},
                )
            except httpx.HTTPError:
                continue
            if r.status_code >= 500:
                continue
            payload = _json_or(r, {})
            code = str(payload.get("code"))
            if code == "0":
                data = payload.get("data")
                if isinstance(data, list) and data:
                    vids = [
                        x for x in data
                        if isinstance(x, dict) and "video" in str(x.get("fileType", "")).lower()
                    ]
                    chosen = vids[0] if vids else data[0]
                    file_url = str((chosen or {}).get("fileUrl") or "")
                    if file_url:
                        break
                # code 0 但产物未出：继续等
            elif code == "805":
                reason = ""
                d = payload.get("data")
                if isinstance(d, dict):
                    reason = str(d.get("failedReason") or "")
                return {"ok": False, "error": f"视频生成失败：{reason or payload.get('msg')}"[:300]}
            elif code in ("804", "813"):
                continue
            else:
                return {"ok": False, "error": f"任务查询异常：code={code} {payload.get('msg')}"[:200]}
        if not file_url:
            return {"ok": False, "error": f"视频生成超时（{POLL_TIMEOUT // 60} 分钟），task_id={task_id}"}

        try:
            return await _download_as_asset(client, file_url, "rh-minimax-h3")
        except (httpx.HTTPError, OSError, RuntimeError) as exc:
            return {"ok": False, "error": f"视频下载落盘失败：{exc}"[:200]}


def _json_or(r: httpx.Response, default: Any) -> Any:
    try:
        return r.json()
    except ValueError:
        return default


def _faststart_remux(path: Path) -> None:
    """把 moov 挪到文件头（-c copy 无损重封装，秒级）。

    RunningHub 下发的 mp4 是 moov 在尾部：浏览器 preload="metadata" 也得把整段
    下完才拿到时长/尺寸，15 张视频卡就是几十 MB。失败只打日志——视频本身仍可播。
    """
    tmp = path.with_suffix(".faststart.mp4")
    try:
        r = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
                "-c", "copy", "-movflags", "+faststart", "-f", "mp4", str(tmp),
            ],
            capture_output=True,
            timeout=120,
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode(errors="ignore")[-300:])
        tmp.replace(path)
    except Exception as e:  # noqa: BLE001
        print(f"[视频 faststart 重封装失败] {path.name}: {type(e).__name__}: {e}", flush=True)
    finally:
        tmp.unlink(missing_ok=True)


async def _download_as_asset(
    client: httpx.AsyncClient, url: str, model: str
) -> Dict[str, Any]:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = ASSETS_DIR / f"vid_{uuid.uuid4().hex[:12]}.mp4"
    last_err = ""
    for attempt in range(3):
        try:
            async with client.stream(
                "GET", url, timeout=DOWNLOAD_TIMEOUT, follow_redirects=True
            ) as r:
                if r.status_code != 200:
                    last_err = f"HTTP {r.status_code}"
                    await asyncio.sleep(3)
                    continue
                with out_path.open("wb") as f:
                    async for chunk in r.aiter_bytes(1 << 16):
                        f.write(chunk)
            if out_path.is_file() and out_path.stat().st_size > 1024:
                await asyncio.to_thread(_faststart_remux, out_path)
                usage.record_video(model)
                return {"ok": True, "videoUrl": f"/agent-service/assets/{out_path.name}"}
            last_err = "产物为空"
        except httpx.HTTPError as exc:
            last_err = str(exc)
        await asyncio.sleep(3 * (attempt + 1))
    out_path.unlink(missing_ok=True)
    raise RuntimeError(last_err or "下载失败")
