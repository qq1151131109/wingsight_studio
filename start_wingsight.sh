#!/usr/bin/env bash
# Wingsight Studio 一键启动/停止
#   ./start_wingsight.sh            启动 agent(8123) + 前端(8008)——前端默认生产模式
#                                   （远程/隧道访问必须用生产模式——dev 模式按需编译，
#                                   一次导航 119 请求 18MB；源码比构建新时自动先 pnpm build）
#   ./start_wingsight.sh dev        前端以开发模式启动（本机开发用）
#   ./start_wingsight.sh build      只构建前端生产包
#   ./start_wingsight.sh --tunnel   额外启动 bore 公网隧道（临时端口）
#   ./start_wingsight.sh status     查看状态
#   ./start_wingsight.sh stop       全部停止

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"

# pnpm/node 经 nvm 安装时只在交互 shell 的 PATH 里（裸 shell/cron/开机自启
# 会 nohup: pnpm: No such file or directory）——不在 PATH 就把最新的 nvm bin 补上
if ! command -v pnpm >/dev/null 2>&1; then
  _nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$_nvm_bin" ] && export PATH="$_nvm_bin:$PATH"
fi

AGENT_PORT=8123
WEB_PORT=8008

is_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/healthz" 2>/dev/null && return 0 || return 1; }
web_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" 2>/dev/null && return 0 || return 1; }

start_agent() {
  if is_up "$AGENT_PORT"; then echo "✓ agent 已在运行 (:$AGENT_PORT)"; return; fi
  echo "… 启动 LangGraph agent (:$AGENT_PORT)"
  # 清代理变量（2026-09-10 两次实锤：带 SOCKS 变量起的 agent 每个对话请求
  # 都炸 httpx ImportError: socksio 未装——LangChain 建 ChatOpenAI 客户端
  # 即挂，healthz 却正常，表现为「agent 活着但对话全断流」）
  (cd "$ROOT/agent" && nohup env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy \
     -u HTTPS_PROXY -u https_proxy uv run uvicorn main:app --port "$AGENT_PORT" --host 127.0.0.1 \
     > "$LOGS/agent.log" 2>&1 & echo $! > "$LOGS/agent.pid")
  for i in $(seq 1 20); do is_up "$AGENT_PORT" && break; sleep 1; done
  is_up "$AGENT_PORT" && echo "✓ agent 就绪 (:$AGENT_PORT)" || { echo "✗ agent 启动失败，看 logs/agent.log"; exit 1; }
}

build_web() {
  echo "… 构建前端生产包 (pnpm build)"
  (cd "$ROOT" && pnpm build > "$LOGS/web-build.log" 2>&1) \
    || { echo "✗ 构建失败，看 logs/web-build.log"; exit 1; }
}

# 源码比上次构建新（或从未构建）时需要重建——否则生产服务器吐的是旧页面
web_stale() {
  [ -f "$ROOT/.next/BUILD_ID" ] || return 0
  [ -n "$(find "$ROOT/app" "$ROOT/components" "$ROOT/lib" "$ROOT/public" \
        "$ROOT/next.config.ts" -newer "$ROOT/.next/BUILD_ID" -print -quit 2>/dev/null)" ]
}

start_web_prod() {
  if web_up "$WEB_PORT"; then echo "✓ 前端已在运行 (:$WEB_PORT)"; return; fi
  if web_stale; then echo "检测到源码比构建新（或从未构建）"; build_web; fi
  echo "… 启动 Next.js 前端·生产模式 (:$WEB_PORT)"
  (cd "$ROOT" && nohup pnpm start --port "$WEB_PORT" \
     > "$LOGS/web.log" 2>&1 & echo $! > "$LOGS/web.pid")
  for i in $(seq 1 30); do web_up "$WEB_PORT" && break; sleep 1; done
  web_up "$WEB_PORT" && echo "✓ 前端就绪 : http://localhost:$WEB_PORT" || { echo "✗ 前端启动失败，看 logs/web.log"; exit 1; }
}

start_web_dev() {
  if web_up "$WEB_PORT"; then echo "✓ 前端已在运行 (:$WEB_PORT)"; return; fi
  echo "… 启动 Next.js 前端·开发模式 (:$WEB_PORT)"
  (cd "$ROOT" && nohup pnpm dev --port "$WEB_PORT" \
     > "$LOGS/web.log" 2>&1 & echo $! > "$LOGS/web.pid")
  for i in $(seq 1 30); do web_up "$WEB_PORT" && break; sleep 1; done
  web_up "$WEB_PORT" && echo "✓ 前端就绪 : http://localhost:$WEB_PORT" || { echo "✗ 前端启动失败，看 logs/web.log"; exit 1; }
}

start_tunnel() {
  if [ -f "$LOGS/tunnel.pid" ] && kill -0 "$(cat "$LOGS/tunnel.pid")" 2>/dev/null; then
    echo "✓ 隧道已在运行"; return
  fi
  BORE="$(command -v bore || echo /tmp/bore)"
  if [ ! -x "$BORE" ]; then echo "✗ 未安装 bore（/tmp/bore），跳过隧道"; return; fi
  echo "… 启动 bore 隧道"
  (nohup "$BORE" local "$WEB_PORT" --to bore.pub > "$LOGS/tunnel.log" 2>&1 & echo $! > "$LOGS/tunnel.pid")
  sleep 4
  grep -oE "bore.pub:[0-9]+" "$LOGS/tunnel.log" | head -1 | sed 's/^/✓ 公网地址: http:\/\//' || echo "（隧道地址稍后见 logs/tunnel.log）"
}

# 调研抓取主路径层（fetch_page_text：知乎 TikHub → 本地 jina 主路径 →
# 直抓回退 → 官方 API 收尾）。软保障：只在 3000 没人听时动手，且任何
# 失败只警告不阻塞——jina 是可选依赖，没有它链路自动降级（直抓+官方 API，
# 慢一点但都能活）。绝不隐式 pull 镜像（2GB，生产机不装它是有意为之——
# 那边靠官方 API 层）。
ensure_jina() {
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ && { echo "✓ jina-reader :3000 已在运行"; return; }
  command -v docker >/dev/null 2>&1 || { echo "⚠ 无 docker，本地 jina 不启用（抓取走直抓+官方 API）"; return; }
  if ! docker info >/dev/null 2>&1; then
    command -v colima >/dev/null 2>&1 || { echo "⚠ docker 未运行且无 colima，本地 jina 不启用（直抓+官方 API 兜底）"; return; }
    echo "… 启动 colima（jina-reader 依赖）"
    colima start >/dev/null 2>&1 || { echo "⚠ colima 启动失败，本地 jina 不启用（docker start colima 排查）"; return; }
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx jina-reader; then
    docker start jina-reader >/dev/null 2>&1 || { echo "⚠ jina-reader 容器启动失败（docker logs jina-reader）"; return; }
  elif docker image inspect ghcr.io/jina-ai/reader:oss >/dev/null 2>&1; then
    # 容器访问宿主代理必须走 colima 网关地址（127.0.0.1 在容器里指向容器自己；
    # 旧容器烘过 172.17.0.1:7898 死地址，wikisource 等境外源全 ERR_PROXY_CONNECTION）
    local proxy=""
    if command -v colima >/dev/null 2>&1; then
      proxy="$(colima ssh -- sh -c 'grep -m1 "^http_proxy=" /etc/environment 2>/dev/null | cut -d= -f2' 2>/dev/null || true)"
    fi
    local run_args=(-d --name jina-reader --restart unless-stopped -p 3000:8081)
    [ -n "$proxy" ] && run_args+=(-e HTTP_PROXY="$proxy" -e HTTPS_PROXY="$proxy")
    docker run "${run_args[@]}" ghcr.io/jina-ai/reader:oss >/dev/null 2>&1 \
      || { echo "⚠ jina-reader 容器创建失败（docker run 手跑排查）"; return; }
  else
    echo "⚠ 本地 jina 镜像未部署，抓取走直抓+官方 API（要启用：docker pull ghcr.io/jina-ai/reader:oss 后重跑本脚本）"
    return
  fi
  for i in $(seq 1 25); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ && break; sleep 1; done
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ \
    && echo "✓ jina-reader 就绪 :3000" || echo "⚠ jina-reader 启动超时（docker logs jina-reader；抓取暂走直抓+官方 API）"
}

# 按端口找占用进程：**两种工具都问、取并集**（macOS 只有 lsof；Linux 生产机实测
# lsof 存在却查不到 socket、返回空而 ss 查得到——只信一个都会漏，漏掉就是「以为
# 重启了其实跑的还是旧进程」）。任一工具不存在就只用另一个。
port_pids() {
  local port="$1" out=""
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  fi
  if command -v ss >/dev/null 2>&1; then
    out="${out}
$(ss -tlnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true)"
  fi
  # 逐行输出（不要 tr 成空格：单个 pid 会带尾空格，调用方 grep '^[0-9]+$' 会漏）
  printf '%s\n' "$out" | grep -E '^[0-9]+$' | sort -u
}

# 连子进程一起收（uv run 包 python 的两层结构：只杀父会留下占端口的子）
kill_tree() {
  local pid="$1" sig="$2"
  local k
  for k in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill "-$sig" "$k" 2>/dev/null
  done
  kill "-$sig" "$pid" 2>/dev/null
}

# TERM → 等 5 秒 → KILL。agent 带着常开 SSE 连接时 graceful shutdown 会卡在
# 「等连接关闭」上收不掉（2026-09-10 生产实测：旧 agent 丢了监听端口却仍挂着
# ESTAB 连接活着，两个进程同写一个 SQLite 有锁风险），所以必须兜底 KILL；
# 且收完要核实端口真的空了——旧实现发完 TERM 就报「全部停止」
stop_pids() {
  local label="$1"; shift
  local pids="$*" p alive i=0
  [ -z "$pids" ] && return 0
  for p in $pids; do kill_tree "$p" TERM; done
  while [ "$i" -lt 5 ]; do
    alive=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && { echo "✓ 已停止 ${label} (${pids})"; return 0; }
    sleep 1
    i=$((i + 1))
  done
  for p in $pids; do kill_tree "$p" KILL; done
  sleep 1
  echo "✓ 已强制停止 ${label}（TERM 5 秒未退，已 KILL）：${pids}"
}

do_stop() {
  local agent_pids web_pids left port
  agent_pids="$(cat "$LOGS/agent.pid" 2>/dev/null || true)
$(port_pids "$AGENT_PORT")"
  web_pids="$(cat "$LOGS/web.pid" 2>/dev/null || true)
$(port_pids "$WEB_PORT")"
  agent_pids="$(printf '%s\n' "$agent_pids" | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')"
  web_pids="$(printf '%s\n' "$web_pids" | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')"
  rm -f "$LOGS/agent.pid" "$LOGS/web.pid"

  stop_pids "agent" $agent_pids
  stop_pids "前端" $web_pids

  if [ -f "$LOGS/tunnel.pid" ]; then
    local tpid; tpid="$(cat "$LOGS/tunnel.pid")"
    kill_tree "$tpid" TERM
    rm -f "$LOGS/tunnel.pid"
    echo "✓ 已停止 tunnel (pid $tpid)"
  fi

  # 兜底清孤儿（命令行匹配本项目；端口清理已是主路径，这里是双保险）
  pkill -f "wingsight-studio/agent.*uvicorn" 2>/dev/null && echo "✓ 清理 agent 孤儿进程"
  pkill -f "wingsight-studio.*next dev --port $WEB_PORT" 2>/dev/null && echo "✓ 清理前端孤儿进程"
  pkill -f "wingsight-studio.*next start --port $WEB_PORT" 2>/dev/null && echo "✓ 清理前端孤儿进程"

  # 收尾核实：端口真空了才算停干净（否则明报，别让「以为重启了」重演）
  left=""
  for port in "$AGENT_PORT" "$WEB_PORT"; do
    [ -n "$(port_pids "$port")" ] && left="$left :$port"
  done
  if [ -n "$left" ]; then
    echo "✗ 端口仍被占用：${left}（手动处理：lsof -nP -iTCP:8123 -sTCP:LISTEN）"
    return 1
  fi
  echo "全部停止"
}

do_status() {
  is_up "$AGENT_PORT" && echo "✓ agent  :$AGENT_PORT" || echo "✗ agent 未运行"
  web_up "$WEB_PORT" && echo "✓ 前端   :$WEB_PORT" || echo "✗ 前端未运行"
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ \
    && echo "✓ jina    :3000（调研抓取回退层，docker 容器 jina-reader）" || echo "⚠ jina :3000 未运行（抓取回退降级：直抓+官方 API，start 会自动拉起）"
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:7860/health 2>/dev/null \
    && echo "✓ langflow :7860（langflow/ 内置，scripts/setup-langflow.sh 管理）" || echo "⚠ langflow :7860 未运行（拆解/出图需要它，跑 ./scripts/setup-langflow.sh）"
  curl -s --max-time 2 http://127.0.0.1:1200/healthz 2>/dev/null | grep -q ok \
    && echo "✓ rsshub   :1200（docker 容器 rsshub，选题池新闻 RSS 通道）" || echo "⚠ rsshub :1200 未运行（选题池新闻 RSS 降级为原生源，docker start rsshub）"
}

case "${1:-start}" in
  start)   start_agent; start_web_prod; ensure_jina; echo "完成。日志在 logs/ 目录" ;;
  dev)     start_agent; start_web_dev; ensure_jina; echo "完成（开发模式）。日志在 logs/ 目录" ;;
  build)   build_web ;;
  --tunnel) start_agent; start_web_prod; start_tunnel; ensure_jina ;;
  stop)    do_stop ;;
  status)  do_status ;;
  *) echo "用法: $0 [start|dev|build|--tunnel|stop|status]" ;;
esac
