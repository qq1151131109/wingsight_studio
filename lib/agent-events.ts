"use client";

/**
 * 后台任务事件流客户端（agent/eventbus.py 的同契约消费端）。
 *
 * SSE over fetch：EventSource 不能带 Authorization 头，token 只能走 header
 * （不进 URL/代理日志）。断线指数退避重连；事件不重放——错过的终态由既有
 * 卡面状态轮询兜回，这里只消费增量。单例连接：一个标签页一条流，
 * 订阅者共享（TaskEvents 是目前唯一入口）。
 */

import { getToken } from "@/lib/auth";

export type AgentJobKind =
  | "deep_research"
  | "ref_research"
  | "shot_images"
  | "decompose"
  | "script_review"
  | "image_review"
  /** 进行中进度播报（job_id=thread_id；不进聊天消息流，TaskEvents 浮条渲染） */
  | "progress";

/** 后台任务终态事件（契约两端同改：agent/eventbus.py publish_job_event） */
export interface AgentJobEvent {
  kind: AgentJobKind;
  project_id: string;
  job_id: string;
  /** done | error | stopped | cancelled */
  status: string;
  title: string;
  summary: string;
  error?: string;
  sources_count?: number;
  findings_count?: number;
  items?: { node_id: string; name: string; status: string; error: string }[];
}

type Listener = (e: AgentJobEvent) => void;

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function scheduleReconnect(): void {
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  const mine = new AbortController();
  controller = mine;
  const token = getToken();
  try {
    const res = await fetch("/api/v1/events/stream", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: mine.signal,
    });
    if (!res.ok || !res.body) throw new Error(`事件流连接失败（${res.status}）`);
    attempt = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        dispatchFrame(frame);
        sep = buf.indexOf("\n\n");
      }
    }
    // 服务端不会主动关流；走到这里 = 连接被中间层掐断，重连
  } catch {
    // 主动退订（abort）不重连；其余（网络闪断/代理重启）退避重连
  }
  if (!mine.signal.aborted) scheduleReconnect();
}

function dispatchFrame(frame: string): void {
  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!data) return; // 注释帧（心跳）或 event: 行
  try {
    const event = JSON.parse(data) as AgentJobEvent;
    if (!event || typeof event.job_id !== "string" || !event.kind) return;
    for (const fn of listeners) fn(event);
  } catch {
    // 单帧解析失败跳过，不断流
  }
}

/** 订阅后台任务事件；返回退订函数（最后一个订阅者退出时关闭连接） */
export function subscribeAgentEvents(onEvent: Listener): () => void {
  listeners.add(onEvent);
  if (!controller && !reconnectTimer) void connect();
  return () => {
    listeners.delete(onEvent);
    if (listeners.size === 0) {
      controller?.abort();
      controller = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      attempt = 0;
    }
  };
}
