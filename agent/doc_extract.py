"""聊天附件文档文本提取（`POST /extract-text` 的实现体）。

聊天输入条的二进制附件浏览器读不了，统一在这里转成可读文本：内联进当轮消息
正文 + 落资料卡（`ingest.addDocCard`）。失败一律抛 `DocExtractError`（带 HTTP
状态与中文原因），由路由原样明报——绝不回退成「按 UTF-8 硬解」的正文：
2026-09-11 大宋异事录事故，`.xlsx` 落到前端「文本直读」兜底，整份 zip 包被当
正文发给了模型（17000 字里 6967 个替换字符 + 446 个 NUL，`PK\\x03\\x04` 开头）。

通道：
- .docx：zipfile 直读 word/document.xml（w:t 串段，零外部依赖，最快）
- .doc/.rtf/.xls：soffice --headless 转 txt/xlsx（每请求独立 profile 防并发锁）
- .pdf：pdftotext
- .xlsx/.xlsm：openpyxl 读表 → Markdown 表格（多表分节、超限明示截断）
"""

from __future__ import annotations

import io
import os
import re
import tempfile
import zipfile

import openpyxl

MAX_BYTES = 20 * 1024 * 1024

# 单表上限：整本工作簿全量塞进 prompt 不现实，超出按节明示截断（不静默砍）
SHEET_MAX = 5
ROWS_MAX = 300
COLS_MAX = 40

SUPPORTED_EXT = (".doc", ".docx", ".rtf", ".pdf", ".xlsx", ".xlsm", ".xls")
SUPPORTED_HINT = ".doc/.docx/.rtf/.pdf/.xlsx/.xlsm/.xls"


class DocExtractError(Exception):
    """提取失败：`status` 为回给前端的 HTTP 状态，`message` 为中文原因。"""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


async def _run(cmd: list[str], timeout: float = 40.0) -> bytes:
    """跑外部转换器（soffice/pdftotext）：非零退出与超时都明报。"""
    import asyncio

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        raise RuntimeError(f"转换超时（>{timeout:.0f}s）") from None
    if proc.returncode != 0:
        raise RuntimeError(f"转换失败：{err.decode(errors='replace')[:120]}")
    return out


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
        elif ext in (".xlsx", ".xlsm"):
            text = _xlsx_text(body)
        elif ext == ".pdf":
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(body)
                pdf_path = f.name
            try:
                out = await _run(["pdftotext", "-enc", "UTF-8", pdf_path, "-"])
            finally:
                os.unlink(pdf_path)
            text = out.decode("utf-8", errors="replace")
        elif ext == ".xls":  # 老 BIFF：先转 xlsx 再读表，保住多表与单元格结构
            with tempfile.TemporaryDirectory() as td:
                src = os.path.join(td, "src.xls")
                with open(src, "wb") as f:
                    f.write(body)
                profile = os.path.join(td, "lo-profile")
                await _run(
                    [
                        "soffice", "--headless", "--norestore",
                        f"-env:UserInstallation=file://{profile}",
                        "--convert-to", "xlsx", "--outdir", td, src,
                    ]
                )
                out_path = os.path.join(td, "src.xlsx")
                if not os.path.exists(out_path):
                    raise RuntimeError("soffice 未产出表格（文件可能损坏或加密）")
                text = _xlsx_text(open(out_path, "rb").read())
        else:  # .doc / .rtf → soffice 转纯文本
            with tempfile.TemporaryDirectory() as td:
                src = os.path.join(td, f"src{ext}")
                with open(src, "wb") as f:
                    f.write(body)
                profile = os.path.join(td, "lo-profile")
                await _run(
                    [
                        "soffice", "--headless", "--norestore",
                        f"-env:UserInstallation=file://{profile}",
                        "--convert-to", "txt:Text", "--outdir", td, src,
                    ]
                )
                out_path = os.path.join(td, "src.txt")
                if not os.path.exists(out_path):
                    raise RuntimeError("soffice 未产出文本（文件可能损坏或加密）")
                text = open(out_path, encoding="utf-8", errors="replace").read()
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
