"""聊天附件文本提取单测（doc_extract）：xlsx 转表格 / 失败明报 / 不吐乱码。

运行：cd agent && uv run python test_doc_extract.py
不需要 LLM / 网络；.xls（soffice）一档本机没装转换器时自动跳过。

背景：2026-09-11 大宋异事录事故——用户拖入 `.xlsx`，前端「文本直读」兜底把
zip 包按 UTF-8 硬解，17000 字正文里 6967 个替换字符 + 446 个 NUL 直接进 prompt。
本测试锁两件事：① 表类附件在服务端转成人读的 Markdown 表格；② 解不了就明报
（状态码 + 中文原因），绝不返回替换字符构成的「正文」。
"""

from __future__ import annotations

import asyncio
import io
import shutil
import zipfile
from xml.sax.saxutils import escape

import doc_extract as D

PASS = [0]
SKIP: list[str] = []


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


def _cols(n: int) -> str:
    out: list[str] = []
    while True:
        n, r = divmod(n, 26)
        out.append(chr(65 + r))
        if n == 0:
            return "".join(reversed(out))
        n -= 1


def make_xlsx(sheets: dict[str, list[list[str]]]) -> bytes:
    """手搓最小 xlsx（inlineStr，零依赖）——openpyxl 能直读。"""
    buf = io.BytesIO()
    names = list(sheets)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        types = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ]
        for i in range(len(names)):
            types.append(
                f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            )
        types.append("</Types>")
        z.writestr("[Content_Types].xml", "".join(types))
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        sheet_tags = "".join(
            f'<sheet name="{escape(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
            for i, n in enumerate(names)
        )
        z.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{sheet_tags}</sheets></workbook>",
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                for i in range(len(names))
            )
            + "</Relationships>",
        )
        for i, grid in enumerate(sheets.values(), start=1):
            rows = []
            for r, row in enumerate(grid, start=1):
                cells = "".join(
                    f'<c r="{_cols(c)}{r}" t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>'
                    for c, v in enumerate(row)
                    if str(v) != ""
                )
                rows.append(f'<row r="{r}">{cells}</row>')
            z.writestr(
                f"xl/worksheets/sheet{i}.xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f"<sheetData>{''.join(rows)}</sheetData></worksheet>",
            )
    return buf.getvalue()


def make_docx(paragraphs: list[str]) -> bytes:
    buf = io.BytesIO()
    body = "".join(
        f"<w:p><w:r><w:t>{escape(p)}</w:t></w:r></w:p>" for p in paragraphs
    )
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body></w:document>",
        )
    return buf.getvalue()


def make_pptx(slides: list[list[str]]) -> bytes:
    """手搓 pptx（a:p 段落 + a:t 文本）。

    包结构给全（Content_Types / presentation.xml / rels / 逐页 slide）——只给
    slide 的话 openpyxl 派系的 zip 直读没问题，但 LibreOffice 打不开，.ppt
    转换档的夹具就废了（实测 "source file could not be loaded"）。
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        overrides = "".join(
            f'<Override PartName="/ppt/slides/slide{i}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
            for i in range(1, len(slides) + 1)
        )
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/presentation.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
            f"{overrides}"
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
            "</Relationships>",
        )
        sld_ids = "".join(
            f'<p:sldId id="{255 + i}" r:id="rId{i}"/>' for i in range(1, len(slides) + 1)
        )
        z.writestr(
            "ppt/presentation.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            f"<p:sldIdLst>{sld_ids}</p:sldIdLst>"
            '<p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
        )
        z.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
                for i in range(1, len(slides) + 1)
            )
            + "</Relationships>",
        )
        for i, lines in enumerate(slides, start=1):
            paras = "".join(
                f'<a:p><a:r><a:t>{escape(t)}</a:t></a:r></a:p>' for t in lines
            )
            # 文本必须挂在形状的 txBody 里——直接摊在 spTree 下虽然能被本模块的
            # 正则读到，但 LibreOffice 会当噪音丢掉，.ppt 转换档的夹具就断了
            shape = (
                '<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/>'
                '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
                '<p:spPr><a:xfrm><a:off x="838200" y="365125"/>'
                '<a:ext cx="7772400" cy="1325563"/></a:xfrm></p:spPr>'
                f"<p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>"
            )
            z.writestr(
                f"ppt/slides/slide{i}.xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                "<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
                "<p:grpSpPr/>"
                f"{shape}"
                "</p:spTree></p:cSld></p:sld>",
            )
    return buf.getvalue()


def run(name: str, body: bytes) -> str:
    return asyncio.run(D.extract_text(name, body))


def run_err(name: str, body: bytes) -> D.DocExtractError:
    try:
        asyncio.run(D.extract_text(name, body))
    except D.DocExtractError as exc:
        return exc
    raise AssertionError(f"{name} 未报错（本该明报）")


def main() -> None:
    # ---------- xlsx → Markdown 表格 ----------
    xlsx = make_xlsx(
        {
            "资产表": [
                ["编号", "名称", "英文提示词"],
                ["A01", "南宋粗木破门板", "weathered wooden door"],
                ["", "", ""],
                ["A02", "竖线|换行测试", "line1\nline2"],
                ["", "", ""],
            ],
            "备注": [["项", "说明"], ["画风", "影棚道具静物"]],
        }
    )
    text = run("资产提示词表.xlsx", xlsx)
    expect("\ufffd" not in text, "xlsx 提取结果不含替换字符（乱码闸）")
    expect("## 工作表：资产表" in text and "## 工作表：备注" in text, "多表分节（两张表都在）")
    expect("| 编号 | 名称 | 英文提示词 |" in text, "表头成 Markdown 表格行")
    expect("| --- | --- | --- |" in text, "表格分隔行")
    expect("| A01 | 南宋粗木破门板 | weathered wooden door |" in text, "数据行原样")
    expect("南宋粗木破门板" in text, "中文单元格保住（未按字节硬解）")
    expect("\\|" in text and "line1 line2" in text, "竖线转义 + 单元格内换行折平")
    expect(text.count("A02") == 1 and "\n\n\n" not in text, "空行被吃掉（不留整行空表行）")

    # ---------- 大表：明示截断，不静默砍 ----------
    big = make_xlsx({"明细": [["编号", "名称"]] + [[f"B{i}", f"条目{i}"] for i in range(1, 401)]})
    btext = run("大表.xlsx", big)
    expect(f"（本表超过 {D.ROWS_MAX} 行，仅取前 {D.ROWS_MAX} 行）" in btext, "超行数上限明示截断")
    expect("B299" in btext and "B400" not in btext, "截断点按 ROWS_MAX")

    # ---------- 多表超 SHEET_MAX：说明取了前几张 ----------
    many = make_xlsx({f"S{i}": [["列"], [str(i)]] for i in range(1, 8)})
    mtext = run("多表.xlsx", many)
    expect(f"（工作簿共 7 张工作表，仅取前 {D.SHEET_MAX} 张）" in mtext, "超表数上限明示")
    expect("## 工作表：S1" in mtext and "## 工作表：S6" not in mtext, "只取前 SHEET_MAX 张")

    # ---------- docx 老路径不回归 ----------
    dtext = run("官渡考证.docx", make_docx(["第一段", "第二段"]))
    expect(dtext == "第一段\n第二段", "docx 段落路径不变")

    # ---------- pptx → 逐页文本 ----------
    ptext = run("提案.pptx", make_pptx([["大宋异事录", "第一集分镜提案"], ["第二页：人物设定"]]))
    expect("## 第 1 页" in ptext and "## 第 2 页" in ptext, "pptx 分页标记")
    expect("大宋异事录" in ptext and "第二页：人物设定" in ptext, "pptx 取到 a:t 文本")
    expect(ptext.index("大宋异事录") < ptext.index("第二页"), "页序按 slide 编号排序")

    # ---------- 文本类：编码兜底（UTF-8 / GBK / UTF-16 / BOM） ----------
    zh = "南宋赈灾官粮袋，纯白影棚背景。"
    expect(run("剧本.txt", zh.encode("utf-8")) == zh, "UTF-8 文本原样")
    expect(run("剧本.txt", zh.encode("gb18030")) == zh, "GB18030(ANSI) 文本正确解码")
    expect(run("剧本.txt", zh.encode("utf-8-sig")) == zh, "UTF-8 BOM 剥掉")
    expect(run("剧本.txt", zh.encode("utf-16")) == zh, "UTF-16 BOM 正确解码")
    expect(run("分镜.csv", "名称,提示词\nA01,门板\n".encode("gb18030")).startswith("名称,提示词"), "GBK 的 csv 也能读")

    # ---------- 失败明报（状态码 + 中文原因，绝不吐正文） ----------
    expect(run_err("坏表.xlsx", b"not a zip at all").status == 422, "非 zip 的 .xlsx → 422")
    err = run_err("坏表.xlsx", b"not a zip")
    expect("不是合法的 .xlsx" in err.message, "解包失败给中文原因")
    expect(run_err("空.xlsx", b"").status == 400, "空 body → 400")
    expect(run_err("超限.xlsx", b"x" * (D.MAX_BYTES + 1)).status == 413, "超 20MB → 413")
    expect(run_err("坏演示.pptx", b"PK\x03\x04fake").status == 422, "坏 pptx → 422 而不是静默")
    expect(run_err("设计稿.psd", b"8BPS....").status == 415, "不支持的扩展名 → 415")
    e415 = run_err("设计稿.psd", b"8BPS....")
    expect(".pptx" in e415.message and ".txt" in e415.message, "415 文案列出支持格式")
    empty = make_xlsx({"空表": []})
    expect(run_err("空表.xlsx", empty).status == 422, "全空工作簿 → 422 未提取到文本")
    expect(run_err("空演示.pptx", make_pptx([[]])).status == 422, "无文字幻灯片的 pptx → 422")

    # ---------- .xls（soffice 转换档）：本机没转换器就跳过 ----------
    if shutil.which("soffice") is None:
        SKIP.append("soffice 缺失——.xls 转换档跳过")
    else:
        xlsx_fixture = make_xlsx({"资产表": [["编号", "名称"], ["A01", "南宋粗木破门板"]]})
        try:
            xtext = run("导出表.xls", D.soffice_convert_sync(xlsx_fixture, ".xlsx", "xls"))
            expect("南宋粗木破门板" in xtext, ".xls 经 soffice 转换后仍能读到中文单元格")
            expect("\ufffd" not in xtext, ".xls 提取结果不含替换字符")
        except RuntimeError as exc:
            SKIP.append(f".xls 转换档跳过：{exc}")
        # 老 .ppt 同款：先转 pptx 再逐页取文本
        try:
            ppt = D.soffice_convert_sync(make_pptx([["大宋异事录提案"]]), ".pptx", "ppt")
            expect("大宋异事录提案" in run("提案.ppt", ppt), ".ppt 经 soffice 转换后能读到文字")
        except RuntimeError as exc:
            SKIP.append(f".ppt 转换档跳过：{exc}")

    for s in SKIP:
        print(f"⚠ 跳过：{s}")
    print(f"\n测试通过：{PASS[0]} 项")


if __name__ == "__main__":
    main()
