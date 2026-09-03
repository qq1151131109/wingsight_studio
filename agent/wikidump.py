"""维基离线语料库：官方 SQL dump（page + categorylinks）导入本地 sqlite。

解决 zh.wikipedia 直连间歇不可达 + API 限流：一次性下载官方 dump（zhwiki
page ~280MB + categorylinks ~250MB，dumps.wikimedia.org 直连稳定），导入后
「类别 → 成员」查询是纯本地 SQL——零网络、零限流、全量类目全量成员
（几十万类目、数百万条目，不再是 API 单类 500 条的切片）。

dump 每月更新一次即可（categorylinks 是存量+月度增量，选题语料粒度足够）。

CLI：
  uv run python wikidump.py build     # 下载（缺才下）+ 导入
  uv run python wikidump.py status    # 查看库状态
"""

from __future__ import annotations

import gzip
import re
import sqlite3
import urllib.request
from datetime import date
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "wikidump.db"
DUMP_DIR = Path(__file__).resolve().parent / "data" / "wiki-dumps"
_BASE = "https://dumps.wikimedia.org/zhwiki/latest"
_DUMPS = {
    "page": f"{_BASE}/zhwiki-latest-page.sql.gz",
    "categorylinks": f"{_BASE}/zhwiki-latest-categorylinks.sql.gz",
}
# page 命名空间：0=条目，14=类别（子类展开用）
_NS_ARTICLE = 0
_NS_CATEGORY = 14

# SQL 转义还原（\' \" \\ \n \r \t \0）
_ESCAPE_MAP = {"\\": "\\", "'": "'", '"': '"', "n": "\n", "r": "\r", "t": "\t", "0": "\0"}
_UNESCAPE = re.compile(r"\\(.)")


def _unescape(value: str) -> str:
    return _UNESCAPE.sub(lambda m: _ESCAPE_MAP.get(m.group(1), m.group(1)), value)


# 各表行首字段抽取：page=(page_id, ns, title)，categorylinks=(cl_from, cl_to)
_PAGE_ROW = re.compile(r"\((\d+),(\d+),'((?:[^'\\]|\\.)*)'")
_CATLINK_ROW = re.compile(r"\((\d+),'((?:[^'\\]|\\.)*)'")


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")
    return conn


def is_available() -> bool:
    """本地离线库是否可用（有 pages 数据即视为导入完成）。"""
    if not DB_PATH.exists():
        return False
    try:
        with _conn() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM pages").fetchone()
        return bool(row and row["n"] > 0)
    except sqlite3.Error:
        return False


def built_at() -> str:
    try:
        with _conn() as conn:
            row = conn.execute(
                "SELECT value FROM meta WHERE key = 'built_at'"
            ).fetchone()
        return row["value"] if row else ""
    except sqlite3.Error:
        return ""


def status() -> dict:
    if not DB_PATH.exists():
        return {"available": False}
    try:
        with _conn() as conn:
            pages = conn.execute("SELECT COUNT(*) AS n FROM pages").fetchone()["n"]
            cats = conn.execute(
                "SELECT COUNT(DISTINCT category) AS n FROM catlinks"
            ).fetchone()["n"]
            links = conn.execute("SELECT COUNT(*) AS n FROM catlinks").fetchone()["n"]
        return {"available": pages > 0, "pages": pages, "categories": cats, "links": links, "builtAt": built_at()}
    except sqlite3.Error:
        return {"available": False}


def download_dumps() -> list[str]:
    """下载缺失的 dump 包（已存在且非空则跳过）。返回下载的文件列表。"""
    DUMP_DIR.mkdir(parents=True, exist_ok=True)
    downloaded: list[str] = []
    for name, url in _DUMPS.items():
        target = DUMP_DIR / f"zhwiki-latest-{name}.sql.gz"
        if target.exists() and target.stat().st_size > 1024:
            print(f"  = {target.name} 已存在（{target.stat().st_size // 1048576}MB），跳过下载")
            continue
        print(f"  ↓ {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "Wingsight/1.0 (documentary research)"})
        tmp = target.with_suffix(".part")
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
            done = 0
            while chunk := resp.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if done % (64 << 20) < (1 << 20):
                    print(f"    {done // 1048576}MB…", flush=True)
        tmp.rename(target)
        downloaded.append(name)
        print(f"  ✓ {target.name}（{target.stat().st_size // 1048576}MB）")
    return downloaded


def _iter_rows(gz_path: Path, table: str, row_pattern: re.Pattern, fields: int):
    """流式扫 dump 的 INSERT 语句，抽每行首字段。

    注意：VALUES 语句内部可能含换行（长语句折行/字符串转义），必须把整条
    语句累积完再 finditer——按行解析会把跨行元组切烂（踩过：类目名里混进
    换行、成员数对不上）。语句块可达数十 MB，内存可承受。
    """
    prefix = f"INSERT INTO `{table}` VALUES"
    buf: list[str] = []
    in_stmt = False
    with gzip.open(gz_path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not in_stmt:
                idx = line.find(prefix)
                if idx == -1:
                    continue
                buf = [line[idx + len(prefix):]]
                in_stmt = True
            else:
                buf.append(line)
            if line.rstrip().endswith(";"):
                stmt = "".join(buf)
                buf = []
                in_stmt = False
                for m in row_pattern.finditer(stmt):
                    groups = m.groups()
                    if len(groups) >= fields:
                        yield tuple(_unescape(g) if isinstance(g, str) else int(g) for g in groups[:fields])


def import_dumps() -> dict:
    """page.sql.gz → pages(page_id,title,ns)；categorylinks.sql.gz → catlinks。"""
    for name in _DUMPS:
        target = DUMP_DIR / f"zhwiki-latest-{name}.sql.gz"
        if not target.exists() or target.stat().st_size < 1024:
            raise FileNotFoundError(f"缺 {target.name}，先 build 下载")
    conn = _conn()
    pages_n = catlinks_n = 0
    try:
        with conn:
            conn.executescript(
                "DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS catlinks; DROP TABLE IF EXISTS meta;"
                "CREATE TABLE pages (page_id INTEGER PRIMARY KEY, ns INTEGER NOT NULL, title TEXT NOT NULL);"
                "CREATE TABLE catlinks (page_id INTEGER NOT NULL, category TEXT NOT NULL);"
                "CREATE INDEX idx_catlinks_category ON catlinks(category, page_id);"
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            )
        batch: list[tuple] = []
        page_sql = DUMP_DIR / "zhwiki-latest-page.sql.gz"
        print("  导入 pages…")
        with _conn() as conn:
            for page_id, ns, title in _iter_rows(page_sql, 'page', _PAGE_ROW, 3):
                batch.append((int(page_id), int(ns), title))
                if len(batch) >= 50_000:
                    conn.executemany("INSERT OR IGNORE INTO pages VALUES (?,?,?)", batch)
                    pages_n += len(batch)
                    batch = []
            if batch:
                conn.executemany("INSERT OR IGNORE INTO pages VALUES (?,?,?)", batch)
                pages_n += len(batch)
            print(f"  pages: {pages_n}")
        batch = []
        cat_sql = DUMP_DIR / "zhwiki-latest-categorylinks.sql.gz"
        print("  导入 catlinks…")
        with _conn() as conn:
            for cl_from, cl_to in _iter_rows(cat_sql, 'categorylinks', _CATLINK_ROW, 2):
                batch.append((int(cl_from), cl_to))
                if len(batch) >= 50_000:
                    conn.executemany("INSERT OR IGNORE INTO catlinks VALUES (?,?)", batch)
                    catlinks_n += len(batch)
                    batch = []
            if batch:
                conn.executemany("INSERT OR IGNORE INTO catlinks VALUES (?,?)", batch)
                catlinks_n += len(batch)
            conn.execute(
                "INSERT INTO meta VALUES ('built_at', ?)", (date.today().isoformat(),)
            )
            print(f"  catlinks: {catlinks_n}")
    finally:
        conn.close()
    return {"pages": pages_n, "catlinks": catlinks_n}


def category_members(category: str) -> list[str]:
    """本地查询类别成员条目（ns=0；zh dump 同行存在变体重复，DISTINCT 去重）。"""
    cat = category.replace(" ", "_")
    with _conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT p.title FROM catlinks c JOIN pages p ON p.page_id = c.page_id"
            " WHERE c.category = ? AND p.ns = ? AND c.category NOT LIKE '%' || char(10) || '%'"
            " ORDER BY p.title",
            (cat, _NS_ARTICLE),
        ).fetchall()
    return [r["title"] for r in rows]


def category_subcategories(category: str) -> list[str]:
    cat = category.replace(" ", "_")
    with _conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT p.title FROM catlinks c JOIN pages p ON p.page_id = c.page_id"
            " WHERE c.category = ? AND p.ns = ? AND p.title != ?"
            " AND c.category NOT LIKE '%' || char(10) || '%'"
            " ORDER BY p.title",
            (cat, _NS_CATEGORY, cat),
        ).fetchall()
    return [r["title"].removeprefix("Category:") for r in rows]


def build() -> dict:
    download_dumps()
    stats = import_dumps()
    print("✓ 离线语料库就绪", stats)
    return stats


if __name__ == "__main__":
    import sys

    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "build":
        build()
    else:
        import json

        print(json.dumps(status(), ensure_ascii=False, indent=1))
