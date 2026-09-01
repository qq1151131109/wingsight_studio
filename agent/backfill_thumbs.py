"""补齐存量资产缩略图（一次性/部署时手动跑）。

/thumbs 端点发现缺图会现场生成，历史资产自愈；此脚本只是预热，
避免存量图首次访问时才付 ffmpeg 的账。
运行：cd agent && uv run python backfill_thumbs.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import thumbs  # noqa: E402


def main() -> None:
    assets = Path(__file__).resolve().parent / "static" / "assets"
    exts = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    files = sorted(p for p in assets.iterdir() if p.suffix.lower() in exts) if assets.is_dir() else []
    done = skipped = failed = 0
    for p in files:
        name = thumbs.thumb_name(p.name)
        if (thumbs.THUMBS_DIR / name).is_file():
            skipped += 1
            continue
        if thumbs.ensure(name):
            done += 1
        else:
            failed += 1
            print(f"✗ {p.name}", flush=True)
    print(f"共 {len(files)} 张：新增 {done}，已有 {skipped}，失败 {failed}", flush=True)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
