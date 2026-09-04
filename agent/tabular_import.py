"""分镜表批量导入解析（doc/image-node-ops-spec.md §11，open-storyboard
PromptImportDialog 范式的服务端简化版）。

前端上传 xlsx/csv/txt → 本模块解析为统一行结构 [{name, prompt}] → 前端
列映射向导（选名称列/提示词列）→ 批量建图片卡。解析与建卡分离：解析
只做格式转换，行数上限 200（防一次建爆画布）；xlsx 只读第一张 sheet，
csv/txt 按 gb18030→utf-8 顺序解码兜底（国内 Excel 导出的常见编码）。
"""

from __future__ import annotations

import csv
import io
import json

import openpyxl

MAX_ROWS = 200
MAX_BYTES = 10 * 1024 * 1024


def _decode_text(raw: bytes) -> str:
    """csv/txt 解码：utf-8 优先，gb18030 兜底（Excel 中文导出惯例）。"""
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别文件编码（尝试过 UTF-8 / GB18030）")


def _parse_xlsx(raw: bytes) -> list[list[str]]:
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows: list[list[str]] = []
    for row in ws.iter_rows(values_only=True):
        rows.append(["" if v is None else str(v).strip() for v in row])
        if len(rows) > MAX_ROWS + 1:
            break
    wb.close()
    return rows


def _parse_csv(raw: bytes) -> list[list[str]]:
    text = _decode_text(raw)
    rows = list(csv.reader(io.StringIO(text)))
    return [[("" if v is None else str(v).strip()) for v in r] for r in rows]


def _parse_txt(raw: bytes) -> list[list[str]]:
    """纯文本：每行一条（整行算提示词），无表头概念。"""
    text = _decode_text(raw)
    return [[line.strip()] for line in text.splitlines() if line.strip()]


def parse_tabular(filename: str, raw: bytes) -> dict:
    """解析为 {headers, rows}。rows = 原始字符串表格（含表头行若有）。"""
    if len(raw) > MAX_BYTES:
        raise ValueError("文件超过 10MB 上限")
    lower = (filename or "").lower()
    if lower.endswith(".xlsx"):
        grid = _parse_xlsx(raw)
    elif lower.endswith(".csv"):
        grid = _parse_csv(raw)
    elif lower.endswith(".txt"):
        grid = _parse_txt(raw)
    else:
        raise ValueError("仅支持 xlsx / csv / txt")
    grid = [r for r in grid if any(c for c in r)]
    if not grid:
        raise ValueError("文件内容为空")
    if len(grid) > MAX_ROWS + 1:
        grid = grid[: MAX_ROWS + 1]
    # 单列表（txt）没有表头行；多列时默认首行是表头，由前端列映射确认
    headers = grid[0] if len(grid[0]) > 1 else []
    body = grid[1:] if headers else grid
    return {
        "headers": headers,
        "rows": body,
        "singleColumn": not headers,
        "maxRows": MAX_ROWS,
    }


def rows_to_json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)
