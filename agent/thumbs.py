"""缩略图：资产落盘时产 webp 小图，画布/面板小尺寸展示走它，放大与下载仍用原图。

原图文件名是随机 hex、内容不可变 → 缩略图同名（换 .webp）存 THUMBS_DIR，
同样可打 immutable 缓存头。/thumbs 端点发现缺图时现场补生成，
所以历史资产无需一次性迁移，首次访问即自愈。
"""

import subprocess
from pathlib import Path

THUMBS_DIR = Path(__file__).resolve().parent / "static" / "thumbs"

# 卡片图区最大 ~300px，retina 2x 取 512 长边足够；小图不放大
_LONG_EDGE = 512
_QUALITY = 80


def thumb_name(orig_name: str) -> str:
    return Path(orig_name).stem + ".webp"


def _generate(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    # 长边压到 _LONG_EDGE，短边按比例（-2 保持偶数），小图不放大
    _vf = (
        "scale=w=if(gt(iw\\,ih)\\,min(iw\\,{e})\\,-2):h=if(gt(iw\\,ih)\\,-2\\,min(ih\\,{e}))"
        ":flags=lanczos"
    ).format(e=_LONG_EDGE)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-vf", _vf,
        "-frames:v", "1", "-c:v", "libwebp", "-q:v", str(_QUALITY),
        # 临时文件后缀是 .part，ffmpeg 靠扩展名猜 muxer 会失败，须显式指定
        "-f", "webp",
        str(tmp),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode(errors="ignore")[-300:])
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def make_for(orig_name: str) -> None:
    """落盘时同步生成；失败只打日志——/thumbs 端点会在首次访问时兜底重生成。"""
    src = Path(__file__).resolve().parent / "static" / "assets" / Path(orig_name).name
    dest = THUMBS_DIR / thumb_name(orig_name)
    try:
        if src.is_file():
            _generate(src, dest)
    except Exception as e:  # noqa: BLE001
        print(f"[thumbs 生成失败] {orig_name}: {type(e).__name__}: {e}", flush=True)


def ensure(thumb_file: str) -> Path | None:
    """按缩略图名取文件；缺失则从同名原图（任意图片扩展名）现场生成。"""
    safe = Path(thumb_file).name
    if not safe.endswith(".webp"):
        return None
    dest = THUMBS_DIR / safe
    if dest.is_file():
        return dest
    stem = Path(safe).stem
    assets = Path(__file__).resolve().parent / "static" / "assets"
    for src in sorted(assets.glob(f"{stem}.*")):
        if src.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            try:
                _generate(src, dest)
                return dest
            except Exception as e:  # noqa: BLE001
                print(f"[thumbs 现场生成失败] {safe}: {type(e).__name__}: {e}", flush=True)
    return None
