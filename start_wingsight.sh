#!/usr/bin/env bash
# Wingsight Studio 一键启动/停止
#   ./start_wingsight.sh            启动 agent(8123) + 前端(8008)
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
  (cd "$ROOT/agent" && nohup uv run uvicorn main:app --port "$AGENT_PORT" --host 127.0.0.1 \
     > "$LOGS/agent.log" 2>&1 & echo $! > "$LOGS/agent.pid")
  for i in $(seq 1 20); do is_up "$AGENT_PORT" && break; sleep 1; done
  is_up "$AGENT_PORT" && echo "✓ agent 就绪 (:$AGENT_PORT)" || { echo "✗ agent 启动失败，看 logs/agent.log"; exit 1; }
}

start_web() {
  if web_up "$WEB_PORT"; then echo "✓ 前端已在运行 (:$WEB_PORT)"; return; fi
  echo "… 启动 Next.js 前端 (:$WEB_PORT)"
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

do_stop() {
  for name in agent web tunnel; do
    pidfile="$LOGS/$name.pid"
    if [ -f "$pidfile" ]; then
      pid="$(cat "$pidfile")"
      if kill "$pid" 2>/dev/null; then echo "✓ 已停止 $name (pid $pid)"; fi
      rm -f "$pidfile"
    fi
  done
  # 兜底清孤儿（按命令行匹配本项目）
  pkill -f "wingsight-studio/agent.*uvicorn" 2>/dev/null && echo "✓ 清理 agent 孤儿进程"
  pkill -f "wingsight-studio.*next dev --port $WEB_PORT" 2>/dev/null && echo "✓ 清理前端孤儿进程"
  echo "全部停止"
}

do_status() {
  is_up "$AGENT_PORT" && echo "✓ agent  :$AGENT_PORT" || echo "✗ agent 未运行"
  web_up "$WEB_PORT" && echo "✓ 前端   :$WEB_PORT" || echo "✗ 前端未运行"
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:7860/health 2>/dev/null \
    && echo "✓ langflow :7860（langflow/ 内置，scripts/setup-langflow.sh 管理）" || echo "⚠ langflow :7860 未运行（拆解/出图需要它，跑 ./scripts/setup-langflow.sh）"
}

case "${1:-start}" in
  start)   start_agent; start_web; echo "完成。日志在 logs/ 目录" ;;
  --tunnel) start_agent; start_web; start_tunnel ;;
  stop)    do_stop ;;
  status)  do_status ;;
  *) echo "用法: $0 [start|--tunnel|stop|status]" ;;
esac
