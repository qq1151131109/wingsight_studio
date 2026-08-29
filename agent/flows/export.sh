#!/usr/bin/env bash
# 从 langflow 导出一个 flow 到 agent/flows/（剥除前端元数据）。
# 用法：source ../.env.local && ./export.sh <flow_id> <文件名.json>
set -euo pipefail

fid="${1:?用法: ./export.sh <flow_id> <文件名.json>}"
out="${2:?用法: ./export.sh <flow_id> <文件名.json>}"
: "${LANGFLOW_API_KEY:?需要 LANGFLOW_API_KEY（在项目根 .env.local）}"

curl -s --compressed -H "x-api-key: $LANGFLOW_API_KEY" \
  "http://localhost:7860/api/v1/flows/$fid" | python3 -c "
import json, sys
f = json.load(sys.stdin)
for n in f['data']['nodes']:
    tpl = n['data']['node'].get('template') or {}
    tpl.pop('_frontend_node_flow_id', None)
    tpl.pop('_frontend_node_folder_id', None)
print(json.dumps(f, ensure_ascii=False, indent=2))
" > "$out"

echo "导出 $out ✓（flow: $fid）"
