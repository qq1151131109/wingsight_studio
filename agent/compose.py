"""视频合成：ffmpeg 拼接本地资产（compose 卡按钮直连，不经聊天与 LLM）。

源 URL 只认 /agent-service/assets/<file>（同源资产）并映射回本地路径，
resolve 后必须仍在 ASSETS_DIR 内（防目录穿越）。
拼接策略：先 concat demuxer + stream copy（同编码片段秒级完成），
失败回落统一重编码（H.264 + AAC，异构源也能拼）。
"""

import subprocess
import tempfile
import uuid
from pathlib import Path

from skills import ASSETS_DIR

MAX_SOURCES = 20
COPY_TIMEOUT = 600  # 流复制几乎不花时间，超时即异常
ENCODE_TIMEOUT = 1800


def _resolve_local(url: str) -> Path:
    prefix = "/agent-service/assets/"
    if not url.startswith(prefix):
        raise ValueError(f"源必须是本服务资产 URL：{url}")
    p = (ASSETS_DIR / url[len(prefix):]).resolve()
    root = ASSETS_DIR.resolve()
    if root != p and root not in p.parents:
        raise ValueError("非法路径")
    if not p.is_file():
        raise ValueError(f"源文件不存在：{url}")
    return p


def compose_videos(urls: list[str]) -> str:
    """按序拼接，返回新资产 URL。任何一步失败抛异常（路由层转 4xx/5xx）。"""
    if not urls:
        raise ValueError("没有可合成的源")
    if len(urls) > MAX_SOURCES:
        raise ValueError(f"源过多（上限 {MAX_SOURCES}）")
    paths = [_resolve_local(u) for u in urls]

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = ASSETS_DIR / f"compose_{uuid.uuid4().hex[:12]}.mp4"
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        for p in paths:
            # 单引号转义：concat 清单的 shell 语义（文件名是我们生成的 hex，实际不含引号）
            f.write(f"file '{str(p).replace(chr(39), chr(39) * 2)}'\n")
        list_path = f.name
    try:
        base = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path]
        # 快路径：流复制；慢路径：统一重编码（mp4 兼容性优先）
        r = subprocess.run(
            [*base, "-c", "copy", str(out_path)],
            capture_output=True,
            timeout=COPY_TIMEOUT,
        )
        if r.returncode != 0:
            r = subprocess.run(
                [
                    *base,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart",
                    str(out_path),
                ],
                capture_output=True,
                timeout=ENCODE_TIMEOUT,
            )
        if r.returncode != 0 or not out_path.is_file() or out_path.stat().st_size == 0:
            out_path.unlink(missing_ok=True)
            raise RuntimeError(r.stderr.decode(errors="ignore")[-400:] or "ffmpeg 合成失败")
    finally:
        Path(list_path).unlink(missing_ok=True)
    return f"/agent-service/assets/{out_path.name}"
