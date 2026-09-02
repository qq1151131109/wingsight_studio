#!/usr/bin/env bash
# 把 agent/flows/<file>.json 的版本化内容 PATCH 回 langflow 实例（按 flow id）。
# setup-langflow.sh 只做首次导入（按名字幂等跳过），flow 内容更新走本脚本。
# 用法: scripts/update-flow.sh shotlist-generate.json [另一.json ...]
# 前置: langflow 在 127.0.0.1:7860；.env.local 有 LANGFLOW_API_KEY 与对应 *_FLOW_ID。
set -euo pipefail
cd "$(dirname "$0")/.."

LF="${LANGFLOW_URL:-http://127.0.0.1:7860}"
KEY="$(grep '^LANGFLOW_API_KEY=' .env.local | cut -d= -f2 || true)"
if [ -z "$KEY" ]; then echo "✗ .env.local 无 LANGFLOW_API_KEY" >&2; exit 1; fi

for f in "$@"; do
  python3 - "$f" "$LF" "$KEY" << 'PYEOF'
import json, sys, urllib.error, urllib.request
from pathlib import Path

fname, lf, key = sys.argv[1], sys.argv[2], sys.argv[3]
payload = json.loads(Path("agent/flows", fname).read_text(encoding="utf-8"))
flow_id = payload.get("id", "")
assert flow_id, f"{fname} 缺 id 字段"

def call(method, url, body=None):
    import gzip
    req = urllib.request.Request(
        f"{lf}{url}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"x-api-key": key, "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)

# 优先用 JSON 里的 id（本机同源）；服务器 flow id 是导入时生成的，按名字回退
flows = call("GET", "/api/v1/flows/")
target = next((f for f in flows if f.get("id") == flow_id), None)
if target is None:
    target = next((f for f in flows if f.get("name") == payload.get("name")), None)
if target is None:
    print(f"✗ {fname}: 实例中无此 flow（id={flow_id[:8]}… name={payload.get('name')}），先跑 setup-langflow.sh")
    sys.exit(1)
flow_id = target["id"]
# 只更新内容字段，不动 name/id（幂等跳过逻辑靠名字）
target["data"] = payload["data"]
target["description"] = payload.get("description", target.get("description", ""))
call("PATCH", f"/api/v1/flows/{flow_id}", target)
print(f"✓ {fname} → {flow_id[:8]}… 已更新（运行时现读 DB，无需重启）")
PYEOF
done
