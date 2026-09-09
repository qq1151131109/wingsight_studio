"use client";

/**
 * 会话内搜索的共享状态（ChatSearch ↔ AssistantMessage ↔ ThreadsBar）。
 * 只有 open/query 两个字段，`searchActive` 是派生选择器：
 *  - open：搜索条展开（头部放大镜按钮 / Cmd·Ctrl+F）
 *  - query 非空 → searchActive：长消息在此期间自动展开（命中的文字可能在
 *    折叠区里，不展开既高亮不到也滚不到位）
 * 全部写入都发生在事件处理器里（按钮/键盘），不在 effect 里 setState
 * （React Compiler 的 set-state-in-effect 规则）。
 */

import { create } from "zustand";

interface ChatSearchState {
  open: boolean;
  query: string;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  /** 关闭并清空（× 钮 / Esc / 切会话） */
  close: () => void;
}

export const useChatSearch = create<ChatSearchState>()((set) => ({
  open: false,
  query: "",
  setOpen: (open) => set({ open }),
  setQuery: (query) => set({ query }),
  close: () => set({ open: false, query: "" }),
}));

/** 搜索进行中（有词）——长消息自动展开的判据 */
export const selectSearchActive = (s: ChatSearchState) =>
  s.open && s.query.trim().length > 0;
