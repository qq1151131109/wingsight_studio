#!/usr/bin/env bash
# langflow 环境重建（换机 / 首次部署 / subtree 更新后）。
#   1) uv sync 建 langflow/.venv（引擎源码在 langflow/，subtree 并入）
#   2) langflow/.env 缺失则写入默认（SSRF 白名单）
#   3) 起 7860（已有健康实例则跳过）
#   4) API key：根 .env.local 已有 LANGFLOW_API_KEY 则用之，否则 langflow api-key
#      生成并回写（需要 AUTO_LOGIN，langflow 默认开启）
#   5) 导入 agent/flows/*.json → flow id 是导入时生成的 UUID，每套环境都不同，
#      自动回写 .env.local（promo-copy 的 flowId 在 LANGFLOW_SKILLS_JSON 内，一并更新）
# 幂等：.env.local 里记录的 flow id 在当前实例中已存在 → 跳过该 flow，不重复导入。
# 用法：./scripts/setup-langflow.sh
set -euo pipefail
cd "$(dirname "$0")/.."

LF_PORT=7860
LF="http://127.0.0.1:$LF_PORT"

command -v uv >/dev/null 2>&1 || { echo "✗ 需要 uv（https://docs.astral.sh/uv/）"; exit 1; }
[ -d langflow ] || { echo "✗ 缺 langflow/（subtree 未就位？）"; exit 1; }
mkdir -p logs

# ---------- 1) 环境 ----------
if [ ! -x langflow/.venv/bin/langflow ]; then
  echo "… uv sync 建 langflow/.venv（首次较慢）"
  (cd langflow && uv sync)
fi

# ---------- 1.5) 平台扩展包（wingsight 自有 bundle，editable 安装） ----------
if ! (cd langflow && .venv/bin/python -c "import lfx_platforms" >/dev/null 2>&1); then
  echo "… 安装平台扩展包 bundles/platforms（lfx-platforms）"
  (cd langflow && uv pip install -e src/bundles/platforms --no-deps)
  echo "✓ lfx-platforms 已安装"
fi

# ---------- 2) 运行配置 ----------
if [ ! -f langflow/.env ]; then
  cat > langflow/.env <<'EOF'
# langflow 运行配置（无密钥；模型/对象存储/飞书等出站域名过 SSRF 防护需在此放行）
LANGFLOW_SSRF_ALLOWED_HOSTS=www.dmxapi.cn,*.dmxapi.cn,*.amazonaws.com,pre-signed-firefly-prod.s3-accelerate.amazonaws.com,open.feedcoopapi.com,api.deepseek.com,api.openai.com,open.bigmodel.cn,dashscope.aliyuncs.com,*.volces.com,volces.com
# 免登录：身份把关在宿主代理（app/langflow/[[...path]]/route.ts，仅平台 admin 放行）
LANGFLOW_AUTO_LOGIN=true
EOF
  echo "✓ 已生成 langflow/.env（默认 SSRF 白名单 + AUTO_LOGIN）"
fi

# ---------- 3) 启动 ----------
if curl -s --max-time 2 "$LF/health" >/dev/null 2>&1; then
  echo "✓ langflow 已在运行 :$LF_PORT"
else
  # LANGFLOW_HOST 可在 .env.local 覆盖（对外部署设 0.0.0.0 供内网/前端入口访问）
  LF_HOST="$(grep -E '^LANGFLOW_HOST=' .env.local | tail -1 | cut -d= -f2- || true)"
  LF_HOST="${LF_HOST:-127.0.0.1}"
  echo "… 启动 langflow :$LF_HOST:$LF_PORT"
  (cd langflow && setsid nohup .venv/bin/langflow run --host "$LF_HOST" --port "$LF_PORT" \
     > ../logs/langflow.log 2>&1 < /dev/null &)
  ok=0
  for _ in $(seq 1 60); do
    curl -s --max-time 2 "$LF/health" >/dev/null 2>&1 && { ok=1; break; }
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "✗ langflow 启动失败，看 logs/langflow.log"; exit 1; }
  echo "✓ langflow 就绪 $LF"
fi

# ---------- 4) API key ----------
[ -f .env.local ] || touch .env.local
# 不能 source：LANGFLOW_SKILLS_JSON 的值是带空格的 JSON，source 会当命令执行
# （grep 不匹配时管道退出码非 0，pipefail 下必须 || true 兜住）
KEY="$(grep -E '^LANGFLOW_API_KEY=' .env.local | tail -1 | cut -d= -f2- || true)"
# key 可能来自别的实例的拷贝（换机部署常见）——先验证，无效则重新生成
key_ok() {
  [ -n "$1" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "x-api-key: $1" "$LF/api/v1/flows/")" = 200 ]
}
if ! key_ok "$KEY"; then
  KEY="$(cd langflow && .venv/bin/langflow api-key 2>/dev/null | grep -oE 'sk-[A-Za-z0-9_-]+' | head -1 || true)"
  [ -n "$KEY" ] || { echo "✗ API key 生成失败（AUTO_LOGIN 未开？）"; exit 1; }
  python3 - "$KEY" <<'PY'
import sys
key = sys.argv[1]
lines = open(".env.local", encoding="utf-8").read().splitlines()
lines = [l for l in lines if not l.startswith("LANGFLOW_API_KEY=")]
lines.append(f"LANGFLOW_API_KEY={key}")
open(".env.local", "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
  echo "✓ LANGFLOW_API_KEY 已生成并回写 .env.local"
fi

# ---------- 4.5) 平台变量种子（wingsight 平台 bundle：BigModel/DMX/DeepSeek） ----------
# 幂等：已存在的变量不覆盖（换值走 langflow UI，或删变量后重跑本脚本）。
# API key 取自根 .env.local 的 <前缀>_API_KEY，BASE_URL 为各平台缺省端点。
echo "… 平台变量种子（BigModel/DMX/DeepSeek）"
python3 - "$KEY" <<'PY'
import json, sys, urllib.request
from pathlib import Path

key = sys.argv[1]
base = "http://127.0.0.1:7860"

def api(method, path, body=None):
    req = urllib.request.Request(base + path, method=method,
        headers={"x-api-key": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")

env = {}
for l in Path(".env.local").read_text(encoding="utf-8").splitlines():
    if "=" in l and not l.strip().startswith("#"):
        k, _, v = l.partition("=")
        env[k.strip()] = v

existing = {v.get("name") for v in api("GET", "/api/v1/variables/")}
seeds = {
    "BIGMODEL_BASE_URL": "https://open.bigmodel.cn/api/coding/paas/v4",
    "BIGMODEL_API_KEY": env.get("BIGMODEL_API_KEY", ""),
    "DMX_BASE_URL": "https://www.dmxapi.cn/v1",
    "DMX_API_KEY": env.get("DMX_API_KEY", ""),
    "DEEPSEEK_BASE_URL": "https://open.bigmodel.cn/api/coding/paas/v4",
    "DEEPSEEK_API_KEY": env.get("DEEPSEEK_API_KEY", ""),
}
for name, value in seeds.items():
    if name in existing:
        continue
    if not value:
        print(f"  ⚠ {name} 缺 .env.local 键且变量不存在，跳过（平台在 UI 里不可用）")
        continue
    api("POST", "/api/v1/variables/", {"name": name, "value": value, "default_fields": []})
    print(f"  ✓ {name}")
print("✓ 平台变量种子完成")
PY

# ---------- 5) 导入 flows + 回写 id ----------
python3 - "$KEY" <<'PY'
import json, sys, urllib.request
from pathlib import Path

key = sys.argv[1]
base = "http://127.0.0.1:7860"

def api(method, path, body=None):
    import gzip
    req = urllib.request.Request(base + path, method=method,
        headers={"x-api-key": key, "Content-Type": "application/json",
                 "Accept-Encoding": "identity"},
        data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":  # langflow 部分端点无视 identity 强制 gzip
        raw = gzip.decompress(raw)
    return json.loads(raw)

env_path = Path(".env.local")
lines = env_path.read_text(encoding="utf-8").splitlines()
env = {}
for l in lines:
    if "=" in l and not l.strip().startswith("#"):
        k, _, v = l.partition("=")
        env[k.strip()] = v

existing = {f["id"] for f in api("GET", "/api/v1/flows/")}
existing_by_name = {f["name"]: f["id"] for f in api("GET", "/api/v1/flows/")}
# flow 文件 → .env.local 变量；promo-copy 特殊：flowId 藏在 LANGFLOW_SKILLS_JSON
FLOWS = {
    "asset-decompose-character.json": "LANGFLOW_DECOMPOSE_CHARACTER_FLOW_ID",
    "asset-decompose-scene.json": "LANGFLOW_DECOMPOSE_SCENE_FLOW_ID",
    "asset-decompose-prop.json": "LANGFLOW_DECOMPOSE_PROP_FLOW_ID",
    "asset-decompose-costume.json": "LANGFLOW_DECOMPOSE_COSTUME_FLOW_ID",
    "asset-decompose.json": "LANGFLOW_DECOMPOSE_FLOW_ID",
    "asset-imagegen.json": "LANGFLOW_IMAGEGEN_FLOW_ID",
    "prompt-optimize-text.json": "LANGFLOW_PROMPT_OPTIMIZE_TEXT_FLOW_ID",
    "prompt-optimize-image.json": "LANGFLOW_PROMPT_OPTIMIZE_IMAGE_FLOW_ID",
    "style-reverse.json": "LANGFLOW_STYLE_REVERSE_FLOW_ID",
    "shotlist-generate.json": "LANGFLOW_SHOTLIST_FLOW_ID",
    "text-write.json": "LANGFLOW_TEXTWRITE_FLOW_ID",
    "instruction-compose.json": "LANGFLOW_COMPOSE_FLOW_ID",
    "ref-research-brief.json": "LANGFLOW_REF_BRIEF_FLOW_ID",
    "topic-triage.json": "LANGFLOW_TOPIC_TRIAGE_FLOW_ID",
    "topic-research-plan.json": "LANGFLOW_TOPIC_PLAN_FLOW_ID",
    "topic-research-followup.json": "LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID",
    "topic-verdict.json": "LANGFLOW_TOPIC_VERDICT_FLOW_ID",
    "topic-rescan-plan.json": "LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID",
    "topic-angle-gen.json": "LANGFLOW_TOPIC_ANGLE_FLOW_ID",
    "ref-research-plan.json": "LANGFLOW_REF_PLAN_FLOW_ID",
    "ref-research-select.json": "LANGFLOW_REF_SELECT_FLOW_ID",
    "topic-ideate.json": "LANGFLOW_TOPIC_IDEATE_FLOW_ID",
    "topic-diverge.json": "LANGFLOW_TOPIC_DIVERGE_FLOW_ID",
    "topic-retitle.json": "LANGFLOW_TOPIC_RETITLE_FLOW_ID",
    "topic-upscale.json": "LANGFLOW_TOPIC_UPSCALE_FLOW_ID",
    "promo-copy.json": None,
    "research-plan.json": "LANGFLOW_RESEARCH_PLAN_FLOW_ID",
    "research-extract.json": "LANGFLOW_RESEARCH_EXTRACT_FLOW_ID",
    "research-evaluate.json": "LANGFLOW_RESEARCH_EVAL_FLOW_ID",
    "research-dossier.json": "LANGFLOW_RESEARCH_DOSSIER_FLOW_ID",
    "script-review-compliance.json": "LANGFLOW_SCRIPT_COMPLIANCE_FLOW_ID",
    "script-review-consistency.json": "LANGFLOW_SCRIPT_CONSISTENCY_FLOW_ID",
    "script-review-fact-claims.json": "LANGFLOW_SCRIPT_FACTCLAIMS_FLOW_ID",
    "script-review-fact-verdict.json": "LANGFLOW_SCRIPT_FACTVERDICT_FLOW_ID",
}
skills_idx = next((i for i, l in enumerate(lines) if l.startswith("LANGFLOW_SKILLS_JSON=")), None)
skills = json.loads(env["LANGFLOW_SKILLS_JSON"]) if env.get("LANGFLOW_SKILLS_JSON") else {}

changed = False
for fname, var in FLOWS.items():
    path = Path("agent/flows") / fname
    if not path.exists():
        print(f"  - 跳过 {fname}（文件不存在）")
        continue
    payload = json.loads(path.read_text(encoding="utf-8"))
    cur = env.get(var, "") if var else skills.get("宣发文案生成", {}).get("flowId", "")
    # 名字已在实例中 = 别的并发/历史运行导入过 → 跳过（幂等；POST 同 id 会 400）
    if payload.get("name") in existing_by_name:
        print(f"  = {fname}（{payload.get('name')}）已存在，跳过")
        continue
    if cur and cur in existing:
        print(f"  = {fname} 已存在（{cur[:8]}…），跳过")
        continue
    try:
        new_id = api("POST", "/api/v1/flows/", payload)["id"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 400 and "unique" in body and payload.get("name") in (
            {f["name"]: f["id"] for f in api("GET", "/api/v1/flows/")}
        ):
            print(f"  = {fname} 并发导入撞车，已存在，跳过")
            continue
        raise
    if var:
        lines = [f"{var}={new_id}" if l.startswith(var + "=") else l for l in lines]
        if not any(l.startswith(var + "=") for l in lines):
            lines.append(f"{var}={new_id}")
    else:
        skills["宣发文案生成"]["flowId"] = new_id
        if skills_idx is not None:
            lines[skills_idx] = "LANGFLOW_SKILLS_JSON=" + json.dumps(skills, ensure_ascii=False)
        else:
            lines.append("LANGFLOW_SKILLS_JSON=" + json.dumps(skills, ensure_ascii=False))
    changed = True
    print(f"  + 导入 {fname} → {new_id}")

# 历史遗留：指向已删/已拆 flow 的旧键，一律清除
for stale in ("LANGFLOW_FLOW_ID", "LANGFLOW_PROMPT_OPTIMIZE_FLOW_ID"):
    if any(l.startswith(stale + "=") for l in lines):
        lines = [l for l in lines if not l.startswith(stale + "=")]
        changed = True
        print(f"  - 清除历史遗留 {stale}")

if changed:
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("✓ .env.local 已回写")
else:
    print("✓ flows 全部就位，无需回写")
PY

echo "完成。flow 清单/ tweaks 对照见 agent/flows/README.md"
