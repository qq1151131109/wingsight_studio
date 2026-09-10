"use client";

/**
 * 长回复折叠的**展开状态**：按消息 id 记，跨组件重挂载存活。
 *
 * 为什么不放组件的 useState：框架对 >50 条消息做虚拟化（滚出视口即卸载），
 * 组件本地 state 随之丢失 —— 用户展开过的长回复滚回来又折上了。放这里按 id
 * 记，滚动/重渲染都不丢（2026-09-11 用户反馈「展开后滚回来又折上」的修复）。
 *
 * 只在会话内有效（内存态）：刷新后回到默认——默认态由「最新一轮的答复不折叠」
 * 兜住，用户不会因为刷新而看不到刚拿到的答案。
 * 写入只发生在事件处理器里（点展开/收起），不在 effect 里 setState。
 */

import { create } from "zustand";

interface ChatCollapseState {
  /** 已展开的消息 id 集合 */
  expanded: Record<string, true>;
  toggle: (id: string) => void;
}

export const useChatCollapse = create<ChatCollapseState>()((set) => ({
  expanded: {},
  toggle: (id) =>
    set((s) => {
      const next = { ...s.expanded };
      if (next[id]) delete next[id];
      else next[id] = true;
      return { expanded: next };
    }),
}));
