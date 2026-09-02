"use client";

/**
 * 聊天会话选择状态（ThreadsBar ↔ ChatPersistence ↔ AgentProvider 之间的最小共享）。
 * 三态语义：
 *  - undefined：尚未选择（进项目时由 ChatPersistence 拉列表挑最新）
 *  - null：明确的新会话（界面清空，首条消息保存时才真正落库建会话）
 *  - string：当前会话 id
 *
 * agentThreadId：喂给 <CopilotKit threadId> 的 id（= langgraph checkpoint 的
 * thread_id），保证 UI 会话与模型记忆一一对应：
 *  - undefined → CopilotKit 用内部自生成 thread（进项目选择前的瞬态）
 *  - null（新会话）→ 现场铸造一个新 id，agent 从干净上下文开始；
 *    首存时 ChatPersistence 用同一 id 建服务端会话，两边从此同源
 *  - string → 直接用会话 id
 */

import { create } from "zustand";

const mintThreadId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  ).replace(/-/g, "");

function agentThreadIdOf(threadId: string | null | undefined): string | undefined {
  if (typeof threadId === "string") return threadId;
  if (threadId === null) return mintThreadId();
  return undefined;
}

interface ChatSessionState {
  threadId: string | null | undefined;
  /** undefined 也是合法目标：撤销选择（切项目/会话失效自愈时回"未选择"） */
  setThreadId: (threadId: string | null | undefined) => void;
  /** 只读派生： CopilotKit threadId（新会话期间与 threadId 不同步，首存后对齐） */
  agentThreadId: string | undefined;
}

export const useChatSession = create<ChatSessionState>()((set) => ({
  threadId: undefined,
  setThreadId: (threadId) => set({ threadId, agentThreadId: agentThreadIdOf(threadId) }),
  // 不能在初始化器里 get()：zustand 创建期 state 尚未赋值，get() 返回
  // undefined 会炸整页。初值 threadId=undefined → agentThreadId 同为 undefined
  agentThreadId: undefined,
}));

/** 新会话首存落库：把 agent 用的 id 带给服务端（createChatThread），并对齐两边 */
export function pendingAgentThreadId(): string | undefined {
  return useChatSession.getState().agentThreadId;
}
