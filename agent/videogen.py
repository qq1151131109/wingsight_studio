"""BigModel（智谱）视频生成客户端：CogVideoX 系（cogvideox-3 / cogvideox-flash）。

供应商与契约均为 2026-09-07 真实探针验证（选型实录见 models.py VIDEO_MODELS
注释）：
- 提交：POST {PAAS}/videos/generations，{model, prompt≤512, image_url?(URL 或
  base64 data URI，v3 另收 [首帧,尾帧] 数组), size?, fps?(30/60), duration?
  (v3: 5|10), quality?(v3: speed|quality), with_audio?(v3)} → {id, task_status}
- 轮询：GET {PAAS}/async-result/{id} → task_status PROCESSING|SUCCESS|FAIL，
  SUCCESS 带 video_result[0].url（临时 URL，尽快下载）
- i2v 不传 size：按原图比例自适配（短边 1080）——分镜图生视频默认不传

与 compose.py 同范式直连（ffmpeg/HTTP 原语不经 Langflow：视频 API 调用不是
LLM 文字生成，提示词组装在前端/调用方逐字可见，无版式渲染契约）。coding
套餐 key 即可调用，但必须走官方 paas 路径——coding 网关（/api/coding/paas/v4）
不挂视频路由。
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

import usage

BIGMODEL_API_KEY = os.environ.get("BIGMODEL_API_KEY", "")
# 官方 paas 路径（coding 网关无视频路由，勿改成 BIGMODEL_BASE_URL）
VIDEO_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
PROMPT_LIMIT = 512
POLL_INTERVAL = 8
POLL_TIMEOUT = 15 * 60  # 单条视频轮询上限（实测 1 分钟内出片，留足余量）
DOWNLOAD_TIMEOUT = 300

# 与 skills.ASSETS_DIR 同一资产根（视频落这里即得 /agent-service/assets/<name>）
ASSETS_DIR = Path(__file__).resolve().parent / "static" / "assets"


def _flat(value: Any) -> str:
    return " ".join(str(value or "").split())


def _image_payload(url: str) -> str:
    """首帧图转 API 载荷：本服务资产 URL → 本地文件读 base64 data URI（本地
    开发无公网，BigModel 实测收 data URI）；外部 http(s) URL 原样透传。"""
    u = str(url or "").strip()
    if u.startswith(("http://", "https://", "data:")):
        return u
    name = u.rsplit("/", 1)[-1]
    path = ASSETS_DIR / name
    if not path.is_file():
        raise ValueError(f"首帧图不存在：{u}")
    suffix = path.suffix.lower().lstrip(".")
    mime = "jpeg" if suffix in ("jpg", "jpeg") else ("png" if suffix == "png" else "jpeg")
    b64 = base64.b64encode(path.read_bytes()).decode()
    return f"data:image/{mime};base64,{b64}"


def _extract_error(payload: Dict[str, Any]) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or err)[:300]
    return str(payload.get("message") or payload)[:300]


async def generate_video(
    prompt: str,
    *,
    model: str = "cogvideox-flash",
    image_url: Optional[str] = None,
    last_frame_url: Optional[str] = None,
    size: Optional[str] = None,
    fps: Optional[int] = None,
    duration: Optional[int] = None,
    quality: Optional[str] = None,
    with_audio: Optional[bool] = None,
) -> Dict[str, Any]:
    """单条视频生成原语：提交 → 轮询 → 下载落盘。

    返回 {ok, videoUrl?|error}；videoUrl 为本服务资产 URL（/agent-service/…），
    上游临时 URL 不外泄（过期后不可回看，落盘才是我们的事实源）。
    """
    if not BIGMODEL_API_KEY:
        return {"ok": False, "error": "未配置 BIGMODEL_API_KEY，视频生成不可用"}
    text = _flat(prompt)[:PROMPT_LIMIT]
    if not text and not image_url:
        return {"ok": False, "error": "提示词与首帧图均为空，无法生成视频"}
    body: Dict[str, Any] = {"model": model, "prompt": text}
    try:
        if image_url and last_frame_url:
            # v3 首尾帧：image_url 收两张图的数组（第一张=首帧，第二张=尾帧）
            body["image_url"] = [
                _image_payload(image_url),
                _image_payload(last_frame_url),
            ]
        elif image_url:
            body["image_url"] = _image_payload(image_url)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)[:200]}
    # i2v 缺省不传 size：按原图比例自适配；t2v 不传 size 上游按短边 1080 出横版
    if size:
        body["size"] = size
    if fps:
        body["fps"] = fps
    if duration:
        body["duration"] = duration
    if quality:
        body["quality"] = quality
    if with_audio is not None:
        body["with_audio"] = with_audio

    headers = {"Authorization": f"Bearer {BIGMODEL_API_KEY}"}
    async with httpx.AsyncClient(timeout=60) as client:
        # 提交（幂等性无从保证，只对网络类瞬态重试；4xx 业务错不重试）
        task_id = ""
        for attempt in range(3):
            try:
                r = await client.post(
                    f"{VIDEO_API_BASE}/videos/generations", json=body, headers=headers
                )
            except httpx.HTTPError as exc:
                if attempt == 2:
                    return {"ok": False, "error": f"视频任务提交失败：{exc}"[:200]}
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if r.status_code == 200:
                task_id = str((r.json() or {}).get("id") or "")
                break
            try:
                err_payload = r.json()
            except ValueError:
                err_payload = {}
            return {"ok": False, "error": f"视频任务提交失败：{_extract_error(err_payload)}"[:200]}
        if not task_id:
            return {"ok": False, "error": "视频任务提交失败（无任务 id）"}

        # 轮询到终态
        deadline = time.monotonic() + POLL_TIMEOUT
        video_url = ""
        while time.monotonic() < deadline:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                r = await client.get(
                    f"{VIDEO_API_BASE}/async-result/{task_id}", headers=headers
                )
            except httpx.HTTPError as exc:
                await asyncio.sleep(3)
                continue
            if r.status_code != 200:
                # 轮询 4xx/5xx 视为瞬态，退避后重试直到超时
                await asyncio.sleep(3)
                continue
            data = r.json()
            status = str(data.get("task_status") or "")
            if status == "FAIL":
                return {"ok": False, "error": f"视频生成失败：{_extract_error(data)}"[:300]}
            if status == "SUCCESS":
                result = (data.get("video_result") or [{}])[0]
                video_url = str(result.get("url") or "")
                break
        if not video_url:
            return {"ok": False, "error": f"视频生成超时（{POLL_TIMEOUT // 60} 分钟）"}

        # 下载落盘（临时 URL 有时效；失败重试，不再重新生成浪费额度）
        try:
            return await _download_as_asset(client, video_url, model)
        except (httpx.HTTPError, OSError, RuntimeError) as exc:
            return {"ok": False, "error": f"视频下载落盘失败：{exc}"[:200]}


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
                usage.record_video(model)
                return {"ok": True, "videoUrl": f"/agent-service/assets/{out_path.name}"}
            last_err = "产物为空"
        except httpx.HTTPError as exc:
            last_err = str(exc)
        await asyncio.sleep(3 * (attempt + 1))
    out_path.unlink(missing_ok=True)
    raise RuntimeError(last_err or "下载失败")
