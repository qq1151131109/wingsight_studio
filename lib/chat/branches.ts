"use client";

/**
 * 会话分支版本（‹ i/N ›）的共享状态 —— 行业共识：编辑重发/重新生成产生新版本，
 * 旧版本可在消息下用箭头切回，**且模型上下文跟着切换的版本走**（ChatGPT 的
 * ‹ 2/2 ›、Claude 的分支切换器；两者都没有对话树视图，故这里也不做树）。
 *
 * 数据源是服务端 /chat/branches：被放弃的版本 + 当前生效版本（现算）。
 * 只在有 ≥2 版的轮上渲染切换器；单版轮不进 UI。
 *
 * 生命周期：按会话缓存（threadId 变了就重置），切换/重新生成后刷新。
 */

import { create } from "zustand";
import { loadChatBranches, type ChatBranchVersion } from "@/lib/projects";

interface BranchState {
  threadId: string | null;
  /** turnId（该轮用户消息 id）→ 版本清单 */
  byTurn: Record<string, ChatBranchVersion[]>;
  loading: boolean;
  /** 拉取/刷新（threadId 变化时重置缓存） */
  refresh: (threadId: string) => Promise<void>;
  reset: () => void;
}

export const useChatBranches = create<BranchState>()((set) => ({
  threadId: null,
  byTurn: {},
  loading: false,
  reset: () => set({ threadId: null, byTurn: {}, loading: false }),
  refresh: async (threadId) => {
    if (!threadId) return;
    set((s) => ({
      loading: true,
      // 换会话才清空：同一会话内的刷新保留旧数据，避免切换器闪一下消失
      threadId,
      byTurn: s.threadId === threadId ? s.byTurn : {},
    }));
    const turns = await loadChatBranches(threadId);
    set((s) => {
      // 期间又换了会话 → 丢弃这次结果（避免把别的会话的版本写进来）
      if (s.threadId !== threadId) return s;
      const byTurn: Record<string, ChatBranchVersion[]> = {};
      for (const t of turns) byTurn[t.turnId] = t.versions;
      return { byTurn, loading: false };
    });
  },
}));
