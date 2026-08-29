"use client";

/**
 * 聊天会话选择状态（ThreadsBar ↔ ChatPersistence 之间的最小共享）。
 * 三态语义：
 *  - undefined：尚未选择（进项目时由 ChatPersistence 拉列表挑最新）
 *  - null：明确的新会话（界面清空，首条消息保存时才真正落库建会话）
 *  - string：当前会话 id
 */

import { create } from "zustand";

interface ChatSessionState {
  threadId: string | null | undefined;
  setThreadId: (tid: string | null) => void;
}

export const useChatSession = create<ChatSessionState>()((set) => ({
  threadId: undefined,
  setThreadId: (threadId) => set({ threadId }),
}));
