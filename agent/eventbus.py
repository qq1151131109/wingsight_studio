"""进程内后台任务事件总线 + SSE 推送。

AG-UI 是请求-响应协议：runAgent 发起的 SSE 流随轮次结束而关闭，后台任务
（调研/批量出图/拆解/审查）跨轮次跑完时无处可推——「任务跑完 agent 不会
主动说话、用户必须再问一句」的根因。本模块给 agent 进程补一条常开通道：
任务终态 publish_job_event，GET /api/v1/events/stream 的订阅者（浏览器
fetch 流）实时收到，前端据此弹通知/自动续跑 agent（lib/agent-events.ts
是同契约的客户端，两端一起改）。

事件不持久化、不重放：断线期间错过的终态由既有卡面状态轮询兜回；慢消费
者队列满直接丢（同上可兜，绝不阻塞任务本身）。
"""

import asyncio
import json
from typing import Any, AsyncIterator, Dict

from fastapi.responses import StreamingResponse

# 心跳间隔须显著小于 Next 代理空闲超时（10 分钟）——任何中间层掐空闲连接
# 前先发注释帧续命；同时是浏览器侧断线检测的上界
_HEARTBEAT_SECONDS = 15.0
_QUEUE_MAX = 200

_subscribers: set[asyncio.Queue] = set()


def publish_job_event(
    kind: str,
    project_id: str,
    job_id: str,
    status: str,
    title: str = "",
    summary: str = "",
    **extra: Any,
) -> None:
    """向所有在线订阅者广播一个后台任务事件（无订阅者时是空操作）。

    kind：deep_research / ref_research / shot_images / decompose /
    script_review / image_review（前端 AgentJobEvent 同枚举）。
    调用点在任务终态落库之后；本函数绝不抛错（通知是增强，不拖垮任务）。
    """
    event: Dict[str, Any] = {
        "kind": kind,
        "project_id": str(project_id or ""),
        "job_id": str(job_id or ""),
        "status": str(status or ""),
        "title": str(title or ""),
        "summary": str(summary or ""),
    }
    event.update(extra)
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


async def _event_generator() -> AsyncIterator[str]:
    queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _subscribers.add(queue)
    try:
        yield ": connected\n\n"
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
                yield f"event: job\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
            except asyncio.TimeoutError:
                yield ": ping\n\n"
    finally:
        _subscribers.discard(queue)


def sse_response() -> StreamingResponse:
    """SSE 响应体（端点包一层认证依赖后直接返回）。"""
    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
