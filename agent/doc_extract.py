"""聊天附件文档文本提取（`POST /extract-text` 的实现体）。

聊天输入条的二进制附件浏览器读不了，统一在这里转成可读文本：内联进当轮消息
正文 + 落资料卡（`ingest.addDocCard`）。失败一律抛 `DocExtractError`（带 HTTP
状态与中文原因），由路由原样明报——绝不回退成「按 UTF-8 硬解」的正文：
2026-09-11 大宋异事录事故，`.xlsx` 落到前端「文本直读」兜底，整份 zip 包被当
正文发给了模型（17000 字里 6967 个替换字符 + 446 个 NUL，`PK\\x03\\x04` 开头）。

通道：
- .docx：zipfile 直读 word/document.xml（w:t 串段，零外部依赖，最快）
- .pptx：zipfile 直读 ppt/slides/slideN.xml（a:t 串段，同上）
- .doc/.rtf/.xls/.ppt：soffice --headless 转 txt/xlsx/pptx（每请求独立 profile 防并发锁）
- .pdf：pdftotext
- .xlsx/.xlsm：openpyxl 读表 → Markdown 表格（多表分节、超限明示截断）
- 文本类（.txt/.md/.csv/.srt/.vtt/.ass…）：按 UTF-8 → GB18030 顺序解码——
  国内编辑器默认 ANSI/GBK，前端按 UTF-8 硬读会满屏替换字符（超 2MB 的文本
  也走这里，此前落到上传分支、agent 根本拿不到正文）
"""

from __future__ import annotations

import asyncio
import io
import os
import re
import subprocess
import tempfile
import zipfile

import openpyxl

MAX_BYTES = 20 * 1024 * 1024

# 单表上限：整本工作簿全量塞进 prompt 不现实，超出按节明示截断（不静默砍）
SHEET_MAX = 5
ROWS_MAX = 300
COLS_MAX = 40

TEXT_EXTS = (
    ".txt", ".md", ".markdown", ".json", ".csv", ".srt", ".vtt", ".ass", ".ssa", ".xml", ".log",
)
SUPPORTED_EXT = (
    ".doc", ".docx", ".rtf", ".pdf", ".xlsx", ".xlsm", ".xls", ".pptx", ".ppt",
) + TEXT_EXTS
SUPPORTED_HINT = ".doc/.docx/.rtf/.pdf/.xlsx/.xlsm/.xls/.pptx/.ppt 与文本类（.txt/.md/.csv/.srt/.vtt/.ass…）"


class DocExtractError(Exception):
    """提取失败：`status` 为回给前端的 HTTP 状态，`message` 为中文原因。"""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def soffice_convert_sync(body: bytes, src_ext: str, target: str, timeout: float = 120.0) -> bytes:
    """soffice --headless 转换 → 目标文件字节（同步；调用方需要用 to_thread 包）。

    `target` 是 LibreOffice 的转换目标（如 "txt:Text" / "xlsx" / "pptx"），
    产出文件名固定是 `src.<目标扩展名>`。每请求独立 profile——共用 profile 时
    并发转换会互相锁死（历史踩过）。失败与超时都抛 RuntimeError（中文原因）。
    """
    out_ext = target.split(":")[0]
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, f"src{src_ext}")
        with open(src, "wb") as f:
            f.write(body)
        profile = os.path.join(td, "lo-profile")
        cmd = [
            "soffice", "--headless", "--norestore",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", target, "--outdir", td, src,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"转换超时（>{timeout:.0f}s）") from None
        out_path = os.path.join(td, f"src.{out_ext}")
        if not os.path.exists(out_path):
            err = (proc.stderr or b"").decode(errors="replace").strip()[:160]
            raise RuntimeError(
                f"转换失败（soffice 未产出 .{out_ext}）——{err or '文件可能损坏或加密'}"
            )
        return open(out_path, "rb").read()


def _pdftotext(body: bytes) -> str:
    """pdftotext 抽文字层（超时/非零退出明报）。"""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(body)
        pdf_path = f.name
    try:
        proc = subprocess.run(
            ["pdftotext", "-enc", "UTF-8", pdf_path, "-"], capture_output=True, timeout=120
        )
        if proc.returncode != 0:
            raise RuntimeError(f"转换失败：{proc.stderr.decode(errors='replace')[:120]}")
        return proc.stdout.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        raise RuntimeError("转换超时（>120s）") from None
    finally:
        os.unlink(pdf_path)


def decode_text(body: bytes) -> str:
    """文本类附件解码：BOM 优先（UTF-8 / UTF-16），其余 UTF-8 → GB18030。

    GB18030 兜底是国内编辑器默认 ANSI 的常态（Excel/记事本导出的 .txt/.csv），
    按 UTF-8 硬读就是满屏替换字符。都不成才明报（不静默返回乱码）。
    """
    if body.startswith(b"\xef\xbb\xbf"):
        return body.decode("utf-8-sig", errors="strict")
    if body[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return body.decode("utf-16", errors="strict")
    for enc in ("utf-8", "gb18030"):
        try:
            return body.decode(enc)
        except UnicodeDecodeError:
            continue
    raise DocExtractError("无法识别文件编码（试过 UTF-8 / GB18030）", 422)


def _pptx_text(body: bytes) -> str:
    """pptx → 逐页文本：段落 a:p 分段、a:t 取文本（与 docx 同款零依赖解法）。"""
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        slides = [n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
        if not slides:
            raise DocExtractError("没有找到幻灯片（不是合法的 .pptx？）", 422)
        slides.sort(key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))  # type: ignore[union-attr]
        chunks = []
        for i, name in enumerate(slides, start=1):
            xml = z.read(name).decode("utf-8", errors="replace")
            lines = []
            for p in re.findall(r"<a:p[ >].*?</a:p>", xml, re.DOTALL):
                t = "".join(re.findall(r"<a:t[^>]*>(.*?)</a:t>", p, re.DOTALL))
                t = re.sub(r"<[^>]+>", "", t)
                if t.strip():
                    lines.append(t)
            if lines:
                chunks.append(f"## 第 {i} 页\n\n" + "\n".join(lines))
    return "\n\n".join(chunks)


def _docx_text(body: bytes) -> str:
    """docx → 段落文本：段落 w:p 分段、w:t 取文本——表格单元格在 w:p 内，天然覆盖。"""
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    paras = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.DOTALL):
        t = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.DOTALL))
        t = re.sub(r"<[^>]+>", "", t)
        paras.append(t)
    return "\n".join(paras)


def _cell(v: object) -> str:
    """单元格值 → 表格文本：换行/竖线转义（保住 Markdown 表格形状），整数不带 .0。"""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip().replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def _sheet_markdown(ws) -> str:
    """单表 → Markdown 表格。空表返回空串；超 ROWS_MAX 附明示截断说明。"""
    header: list[str] | None = None
    rows: list[list[str]] = []
    truncated = False
    for row in ws.iter_rows(values_only=True):
        if len(rows) + (1 if header is not None else 0) >= ROWS_MAX:
            truncated = True
            break
        cells = [_cell(v) for v in list(row)[:COLS_MAX]]
        if not any(cells):
            continue
        if header is None:
            header = cells
        else:
            rows.append(cells)
    if header is None:
        return ""
    width = max([len(header)] + [len(r) for r in rows])

    def pad(r: list[str]) -> list[str]:
        return r + [""] * (width - len(r))

    out = [
        f"## 工作表：{ws.title}",
        "",
        "| " + " | ".join(pad(header)) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    out += ["| " + " | ".join(pad(r)) + " |" for r in rows]
    if truncated:
        out += ["", f"（本表超过 {ROWS_MAX} 行，仅取前 {ROWS_MAX} 行）"]
    return "\n".join(out)


def _xlsx_text(body: bytes) -> str:
    """xlsx/xlsm → Markdown 表格（多表分节，最多 SHEET_MAX 张）。"""
    try:
        wb = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=True)
    except Exception as exc:  # BadZipFile / InvalidFileException / 老 xls 改名等
        raise DocExtractError(
            f"表格解包失败：不是合法的 .xlsx/.xlsm（老 .xls 请直接用 .xls 后缀上传）——{exc}",
            422,
        ) from None
    try:
        sheets = list(wb.worksheets)
        parts = [t for t in (_sheet_markdown(ws) for ws in sheets[:SHEET_MAX]) if t]
        if len(sheets) > SHEET_MAX:
            parts.append(f"（工作簿共 {len(sheets)} 张工作表，仅取前 {SHEET_MAX} 张）")
    finally:
        wb.close()
    return "\n\n".join(parts)


async def extract_text(name: str, body: bytes) -> str:
    """附件二进制 → 可读文本。失败抛 DocExtractError（状态码 + 中文原因）。"""
    if not body:
        raise DocExtractError("空文件", 400)
    if len(body) > MAX_BYTES:
        raise DocExtractError("文档超过 20MB 上限", 413)
    ext = os.path.splitext(name or "")[1].lower()
    if ext not in SUPPORTED_EXT:
        raise DocExtractError(
            f"不支持的文档类型 {ext or '（未知）'}——文本提取只收 {SUPPORTED_HINT}", 415
        )

    try:
        if ext == ".docx":
            text = _docx_text(body)
        elif ext == ".pptx":
            text = _pptx_text(body)
        elif ext in (".xlsx", ".xlsm"):
            text = _xlsx_text(body)
        elif ext in TEXT_EXTS:
            text = decode_text(body)
        elif ext == ".pdf":
            text = await asyncio.to_thread(_pdftotext, body)
        elif ext == ".xls":  # 老 BIFF：先转 xlsx 再读表，保住多表与单元格结构
            converted = await asyncio.to_thread(soffice_convert_sync, body, ".xls", "xlsx")
            text = _xlsx_text(converted)
        elif ext == ".ppt":  # 老 BIFF：先转 pptx 再逐页取文本
            converted = await asyncio.to_thread(soffice_convert_sync, body, ".ppt", "pptx")
            text = _pptx_text(converted)
        else:  # .doc / .rtf → soffice 转纯文本
            out = await asyncio.to_thread(soffice_convert_sync, body, ext, "txt:Text")
            text = out.decode("utf-8", errors="replace")
    except zipfile.BadZipFile:
        raise DocExtractError(
            "docx 解包失败：文件不是合法的 .docx（老 .doc 请直接用 .doc 后缀上传）", 422
        ) from None
    except RuntimeError as exc:
        raise DocExtractError(str(exc), 422) from None
    except FileNotFoundError as exc:
        raise DocExtractError(
            f"本机缺少转换器（{exc.filename}）——.doc/.rtf/.xls 依赖 soffice、.pdf 依赖 pdftotext",
            500,
        ) from None

    stripped = text.replace("\ufeff", "").strip()
    if not stripped:
        raise DocExtractError("未提取到文本（可能是扫描件/纯图片 PDF，无文字层）", 422)
    return stripped
