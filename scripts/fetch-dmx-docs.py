#!/usr/bin/env python3
"""抓取 doc.dmxapi.cn 的 VitePress 文档页转 Markdown，存 doc/dmxapi/。
一次性工具：页面为服务端预渲染（正文在 <main>），用 stdlib html.parser 转换，
不引第三方依赖。用法：python3 scripts/fetch-dmx-docs.py [页面名 ...]
无参数 = 抓 PAGES 清单全量。"""
import re
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "doc" / "dmxapi"
BASE = "https://doc.dmxapi.cn/"

PAGES = {
    # 基础
    "kaishi": "🚀快速开始",
    "openai-chat": "文本对话",
    "fanwei": "openai请求格式",
    "gemini-chat": "gemini请求格式",
    # AI绘图（含已接入的三个模型）
    "gpt-image-2-text-to-image": "🖌️GPT绘图",
    "gemini-3.1-flash-image-preview": "🖌️香蕉绘图",
    "gemini-3.1-flash-image-preview-edit": "----图片编辑",
    "gemini-3.1-flash-image-preview-images": "----多图合并",
    "gemini-3.1-flash-image-preview-duolun": "----多轮对话绘图",
    "wan2.7-image-text-to-image": "🖌️阿里万象",
    "doubao-seedream-5.0-lite-t2i": "🖌️豆包即梦",
    # AI视频（视频执行层候选）
    "hailuo-txt2video": "🎞️海螺视频",
    "viduq2-pro": "🎞️VIDU视频",
    "kling-v2-6-text2video": "🎞️可灵视频",
    "doubao-seedance-2-0-text-to-video": "🎞️豆包视频",
    "wan2.6-t2v": "🎞️阿里万象视频",
    "paiwo-v5.6-ttv": "🎞️拍我视频",
    "happyhorse-1.0-t2v-text-to-video": "🎞️快乐马",
    # AI场景（未来配音/配乐）
    "minimax-speech": "📚TTS文本转语音",
    "music-2.0": "📚AI音乐",
}


class VitePressToMarkdown(HTMLParser):
    """VitePress 预渲染 HTML → Markdown（覆盖文档站实际用到的标签子集）。"""

    HEADINGS = {f"h{i}": i for i in range(1, 7)}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.in_main = False
        self.pre_depth = 0
        self.pre_lang = ""
        self.pre_buf: list[str] = []
        self.tag_stack: list[str] = []
        self.href = ""
        self.skip_depth = 0  # script/style/nav 内不入正文
        self.lang_span = 0  # <span class="lang">xxx</span> 代码语言角标，跳过

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag == "main":
            self.in_main = True
            return
        if not self.in_main or self.skip_depth:
            if tag in ("script", "style", "nav"):
                self.skip_depth += 1
            return
        if tag in ("script", "style", "nav"):
            self.skip_depth += 1
            return
        attrs = dict(attrs or {})
        cls = str(attrs.get("class") or "")
        m = re.search(r"language-(\w+)", cls)
        if m:
            self.pre_lang = m.group(1)
        if tag == "span" and "lang" in cls.split():
            self.lang_span += 1
            return
        if tag == "pre":
            self.pre_depth += 1
            self.pre_buf = []
            return
        if self.pre_depth:
            return
        if self.lang_span:
            return
        self.tag_stack.append(tag)
        if tag in self.HEADINGS:
            self.out.append("\n" + "#" * self.HEADINGS[tag] + " ")
        elif tag == "p":
            self.out.append("\n")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "tr":
            self.out.append("\n| ")
        elif tag in ("td", "th"):
            self.out.append(" | ")
        elif tag == "a":
            self.href = attrs.get("url") or attrs.get("href") or ""
            if self.href.startswith("http"):
                self.out.append("[")
        elif tag == "br":
            self.out.append("\n")
        elif tag in ("div", "ul", "table"):
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:  # noqa: ANN001
        if tag == "main":
            self.in_main = False
            return
        if self.skip_depth:
            if tag in ("script", "style", "nav"):
                self.skip_depth -= 1
            return
        if not self.in_main:
            return
        if tag == "span" and self.lang_span:
            self.lang_span -= 1
            return
        if tag == "pre":
            self.pre_depth = max(0, self.pre_depth - 1)
            if self.pre_depth == 0:
                body = "".join(self.pre_buf).strip("\n")
                self.out.append(f"\n```{self.pre_lang}\n{body}\n```\n")
                self.pre_buf = []
                self.pre_lang = ""
            return
        if self.pre_depth or self.lang_span:
            return
        if self.tag_stack and self.tag_stack[-1] == tag:
            self.tag_stack.pop()
        if tag == "a" and self.href:
            # 只保留外链；站内 #锚点是导航噪音，丢弃
            if self.href.startswith("http"):
                self.out.append(f"]({self.href})")
            self.href = ""

    def handle_data(self, data: str) -> None:  # noqa: ANN001
        if not self.in_main or self.skip_depth:
            return
        if self.pre_depth:
            self.pre_buf.append(data)
            return
        if self.lang_span:
            return
        text = re.sub(r"\s+", " ", data)
        if text.strip() or (self.out and self.out[-1].endswith(" ")):
            self.out.append(text)

    def markdown(self) -> str:
        md = "".join(self.out)
        md = re.sub(r"\n{3,}", "\n\n", md)
        md = re.sub(r"[ \t]+\n", "\n", md)
        return md.strip() + "\n"


def fetch(slug: str, title: str) -> str:
    url = BASE + slug + ".html"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
    m = re.search(r"<title>(.*?)</title>", html)
    page_title = m.group(1).split("|")[0].strip() if m else slug
    p = VitePressToMarkdown()
    p.feed(html)
    md = p.markdown()
    header = (
        f"# {title}\n\n"
        f"> 来源：{url}\n"
        f"> 官方标题：{page_title}\n"
        f"> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）\n\n"
    )
    path = OUT / f"{slug}.md"
    path.write_text(header + md, encoding="utf-8")
    return f"{path.name}: {len(md)} 字符"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[1:] or list(PAGES)
    for slug in wanted:
        try:
            print("✓", fetch(slug, PAGES.get(slug, slug)))
        except Exception as exc:  # noqa: BLE001
            print("✗", slug, exc)


if __name__ == "__main__":
    main()
