#!/usr/bin/env bash
# 审计 langflow 运行实例 vs agent/flows/ 版本化文件：找出「文件新、实例旧」的
# 静默漂移（2026-09-07 选题池空池事故：服务器 flow 文件已同步但实例没 PATCH，
# 旧契约 flow 照常 200 返回、输出缺新字段被 Python 侧格式闸 100% 拒收）。
# 用法: scripts/audit-flows.sh [--fix]
#   （默认）只报告；--fix 对过期项逐个跑 update-flow.sh PATCH 后复审。
# 前置: langflow 在 127.0.0.1:7860（或 LANGFLOW_URL）；.env.local 有 LANGFLOW_API_KEY。
# 退出码: 0=全部一致；1=有过期/缺失（可作部署脚本闸门）。
set -euo pipefail
cd "$(dirname "$0")/.."

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

LF="${LANGFLOW_URL:-http://127.0.0.1:7860}"
KEY="$(grep '^LANGFLOW_API_KEY=' .env.local | cut -d= -f2 || true)"
if [ -z "$KEY" ]; then echo "✗ .env.local 无 LANGFLOW_API_KEY" >&2; exit 1; fi

STALE="$(python3 - "$LF" "$KEY" << 'PYEOF'
import json, sys, urllib.request
from pathlib import Path

lf, key = sys.argv[1], sys.argv[2]

def call(url):
    req = urllib.request.Request(f"{lf}{url}", headers={"x-api-key": key})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":
        import gzip
        raw = gzip.decompress(raw)
    return json.loads(raw)

def canon(o):
    return json.dumps(o, sort_keys=True, ensure_ascii=False)

flows = call("/api/v1/flows/")
by_id = {f.get("id"): f for f in flows}
by_name = {f.get("name"): f for f in flows}

stale, missing = [], []
for p in sorted(Path("agent/flows").glob("*.json")):
    payload = json.loads(p.read_text(encoding="utf-8"))
    inst = by_id.get(payload.get("id", "")) or by_name.get(payload.get("name"))
    if inst is None:
        missing.append(p.name)
    elif canon(inst.get("data")) != canon(payload.get("data")):
        stale.append(p.name)
for n in stale:
    print(n)
for n in missing:
    print(f"__MISSING__:{n}", file=sys.stderr)
PYEOF
)"

if [ -z "$STALE" ]; then
  echo "✓ 全部 flow 实例与版本化文件一致"
  exit 0
fi
echo "✗ 以下 flow 实例与文件不一致（缺实例的见 stderr）:"
echo "$STALE" | sed 's/^/  ! /'

if [ "$FIX" = "1" ]; then
  echo "$STALE" | xargs bash scripts/update-flow.sh
  exec bash scripts/audit-flows.sh
fi
exit 1
