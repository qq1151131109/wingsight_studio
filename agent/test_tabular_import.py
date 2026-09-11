"""分镜表导入解析单测（tabular_import）：xlsx/xls/ods/csv/txt + 编码兜底 + 上限。

运行：cd agent && uv run python test_tabular_import.py
不需要 LLM / 网络；xls/ods 一档需要 soffice（缺失自动跳过）。

背景：导入对话框此前只认 xlsx/csv/txt——国内用户手上的分镜表常是 WPS/Excel 存的
.xls，或 LibreOffice 的 .ods，选进来只能报「仅支持 xlsx / csv / txt」。现在
xls/ods 经 soffice 转 xlsx 后走同一条读表路径（doc_extract.soffice_convert_sync）。
"""

from __future__ import annotations

import shutil

import doc_extract
import tabular_import as T
from test_doc_extract import make_xlsx

PASS = [0]
SKIP: list[str] = []


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    PASS[0] += 1


GRID = {"资产表": [["编号", "名称"], ["A01", "南宋粗木破门板"], ["A02", "南宋粗草帘"]]}


def main() -> None:
    xlsx = make_xlsx(GRID)

    parsed = T.parse_tabular("资产表.xlsx", xlsx)
    expect(parsed["headers"] == ["编号", "名称"], "xlsx 表头")
    expect(len(parsed["rows"]) == 2 and parsed["rows"][0][0] == "A01", "xlsx 两行数据")
    expect(parsed["singleColumn"] is False, "多列 → 有表头")

    csv_gbk = "名称,提示词\nA01,门板\n".encode("gb18030")
    parsed_csv = T.parse_tabular("表.csv", csv_gbk)
    expect(parsed_csv["headers"] == ["名称", "提示词"], "GB18030 的 csv 表头正确")

    txt = T.parse_tabular("大纲.txt", "第一行\n第二行\n".encode("utf-8"))
    expect(txt["singleColumn"] is True and len(txt["rows"]) == 2, "txt 单列无表头")

    many = make_xlsx({"明细": [["编号", "名称"]] + [[f"B{i}", f"条目{i}"] for i in range(1, 400)]})
    expect(len(T.parse_tabular("大表.xlsx", many)["rows"]) == T.MAX_ROWS, f"行数钳到 {T.MAX_ROWS}")

    try:
        T.parse_tabular("卷宗.pdf", b"%PDF-1.4")
    except ValueError as exc:
        expect("仅支持" in str(exc), "不支持的类型给中文原因")
    else:
        raise AssertionError("pdf 本该报错")

    if shutil.which("soffice") is None:
        SKIP.append("soffice 缺失——xls/ods 档跳过")
    else:
        for ext, target in ((".xls", "xls"), (".ods", "ods")):
            try:
                raw = doc_extract.soffice_convert_sync(xlsx, ".xlsx", target)
                got = T.parse_tabular(f"资产表{ext}", raw)
                expect(
                    got["headers"] == ["编号", "名称"] and len(got["rows"]) == 2,
                    f"{ext} 经 soffice 转换后同样解析",
                )
            except RuntimeError as exc:
                SKIP.append(f"{ext} 档跳过：{exc}")

    for s in SKIP:
        print(f"⚠ 跳过：{s}")
    print(f"\n测试通过：{PASS[0]} 项")


if __name__ == "__main__":
    main()
