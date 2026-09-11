"""缩略图/预览图：资产落盘时产 webp 小图，画布/面板小尺寸展示走它，放大与下载仍用原图。

原图文件名是随机 hex、内容不可变 → 缩略图同名（换 .webp）存 THUMBS_DIR，
同样可打 immutable 缓存头。/thumbs 端点发现缺图时现场补生成，
所以历史资产无需一次性迁移，首次访问即自愈。

两档：
- thumbs（512 长边）：卡片常规缩放的图区（渲染尺寸 ≤ ~540px）
- previews（1600 长边）：卡片放大后（hires）用——原图 2K/4K 直出 3~7MB，
  高缩放直接拉原图是首屏最大单项（maxZoom=4、DPR2 下 zoom>1.05 就触发）。
  previews 只在首次请求时现场生成（多数资产不会被放大，不必落盘时全量产）。
"""

import io
import subprocess
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
ASSETS_DIR = STATIC_DIR / "assets"
THUMBS_DIR = STATIC_DIR / "thumbs"
PREVIEWS_DIR = STATIC_DIR / "previews"

# 卡片图区最大 ~300px，retina 2x 取 512 长边足够；小图不放大
_LONG_EDGE = 512
_QUALITY = 80
# 放大档：卡片最大 ~560 flow px × maxZoom 4 = 2240px 渲染，1600 长边在
# 缩放态下足够（要原始分辨率走灯箱/下载，仍用原图）
_PREVIEW_EDGE = 1600
_PREVIEW_QUALITY = 82


def thumb_name(orig_name: str) -> str:
    return Path(orig_name).stem + ".webp"


def _generate(src: Path, dest: Path, long_edge: int, quality: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    # 长边压到 long_edge，短边按比例（-2 保持偶数），小图不放大
    _vf = (
        "scale=w=if(gt(iw\\,ih)\\,min(iw\\,{e})\\,-2):h=if(gt(iw\\,ih)\\,-2\\,min(ih\\,{e}))"
        ":flags=lanczos"
    ).format(e=long_edge)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-vf", _vf,
        "-frames:v", "1", "-c:v", "libwebp", "-q:v", str(quality),
        # 临时文件后缀是 .part，ffmpeg 靠扩展名猜 muxer 会失败，须显式指定
        "-f", "webp",
        str(tmp),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode(errors="ignore")[-300:])
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


def make_for(orig_name: str) -> None:
    """落盘时同步生成；失败只打日志——/thumbs 端点会在首次访问时兜底重生成。"""
    src = ASSETS_DIR / Path(orig_name).name
    dest = THUMBS_DIR / thumb_name(orig_name)
    try:
        if src.is_file():
            _generate(src, dest, _LONG_EDGE, _QUALITY)
    except Exception as e:  # noqa: BLE001
        print(f"[thumbs 生成失败] {orig_name}: {type(e).__name__}: {e}", flush=True)


def heic_to_jpeg(body: bytes) -> bytes:
    """HEIC/HEIF → JPEG（iPhone 实拍参考图，落盘前转）。

    两条硬约束逼出这一步：服务器 ffmpeg 不带 libheif（实测 `moov atom not found`）、
    浏览器 Chrome 也解不了 HEIC——原样存下来就是「卡片裂图 + 参考图出图必失败」。
    JPEG 是浏览器、缩略图管线、上游出图模型三者都认的形态，故在这里一次性转掉
    （EXIF 方向先摆正，手机竖拍不会躺着）。失败由调用方明报，不静默存原字节。
    """
    from PIL import Image, ImageOps
    import pillow_heif

    pillow_heif.register_heif_opener()
    with Image.open(io.BytesIO(body)) as im:
        out = io.BytesIO()
        ImageOps.exif_transpose(im).convert("RGB").save(out, format="JPEG", quality=92)
    return out.getvalue()


def _ensure(webp_file: str, dest_dir: Path, long_edge: int, quality: int, label: str) -> Path | None:
    safe = Path(webp_file).name
    if not safe.endswith(".webp"):
        return None
    dest = dest_dir / safe
    if dest.is_file():
        return dest
    stem = Path(safe).stem
    for src in sorted(ASSETS_DIR.glob(f"{stem}.*")):
        # ffmpeg 能解的图片扩展名（svg 靠 librsvg、avif 靠 dav1d/aom 滤镜；
        # heic 不在列——它在上传时就被转成 .jpg 落盘）
        if src.suffix.lower() in {
            ".png", ".jpg", ".jpeg", ".webp", ".gif",
            ".avif", ".bmp", ".tiff", ".tif", ".svg",
        }:
            try:
                _generate(src, dest, long_edge, quality)
                return dest
            except Exception as e:  # noqa: BLE001
                print(f"[{label} 现场生成失败] {safe}: {type(e).__name__}: {e}", flush=True)
    return None


def ensure(thumb_file: str) -> Path | None:
    """按缩略图名取文件；缺失则从同名原图（任意图片扩展名）现场生成。"""
    return _ensure(thumb_file, THUMBS_DIR, _LONG_EDGE, _QUALITY, "thumbs")


def ensure_preview(preview_file: str) -> Path | None:
    """按预览图名取文件；缺失则现场生成 1600 长边 webp（放大展示用）。"""
    return _ensure(preview_file, PREVIEWS_DIR, _PREVIEW_EDGE, _PREVIEW_QUALITY, "previews")
