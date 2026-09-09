"use client";

/**
 * 助手消息视图（替换 v2 默认槽位，2026-09-09 长内容 UX 修复）：
 *  - **操作按钮回归**：此前 Sidebar 把 copyButton 换成 NullSlot，而 v2 的工具栏
 *    是条件渲染（没 handler 的按钮不渲染）——助手消息一个操作按钮都没有，长回复
 *    只能手动拖选。现在直接渲染框架的 CopilotChatAssistantMessage（复制钮由框架
 *    接好 onClick=copyToClipboard），并补上「重新生成」。
 *  - **长回复折叠**：超过 COLLAPSE_CHARS 字默认收起（约 12 行），底部渐隐 +
 *    「展开全文（N 字）」；搜索进行中自动展开（命中可能在折叠区里）。
 *    最新一条流式输出期间不折叠——写到一半突然收起来太跳。
 *  - **重新生成**：先调 /chat/regenerate 让服务端把该轮用户消息之前的 checkpoint
 *    分叉为会话当前头，再截断本地历史重跑。只截断不 fork 的话旧回答仍留在模型
 *    上下文里（2026-09-09 实测：模型能逐字复述「已删掉」的答案）。
 */
import { useCallback, useState } from "react";
import {
  CopilotChatAssistantMessage,
  useAgent,
  useCopilotChatConfiguration,
  useCopilotKit,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { langgraphAgent } from "@/app/agent-provider";
import { useChatSession } from "@/lib/chat/session";
import { selectSearchActive, useChatSearch } from "@/lib/chat/search";
import { regenerateChatRun } from "@/lib/projects";
import { showToast } from "@/lib/toast";

/** 折叠阈值：约 12 行正文（13px/1.7 ≈ 22px 行高） */
const COLLAPSE_CHARS = 700;

export default function AssistantMessage({
  message,
  messages,
  isRunning,
}: CopilotChatAssistantMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const searchActive = useChatSearch(selectSearchActive);
  const threadId = useChatSession((s) => s.threadId);
  const chatConfig = useCopilotChatConfiguration();
  const { agent } = useAgent({ agentId: chatConfig?.agentId ?? "default" });
  const { copilotkit } = useCopilotKit();

  const content = typeof message?.content === "string" ? message.content : "";
  const isLatest = messages?.[messages.length - 1]?.id === message?.id;
  const collapsible =
    content.length > COLLAPSE_CHARS && !(isRunning && isLatest);
  const collapsed = collapsible && !expanded && !searchActive;

  const regenerate = useCallback(async () => {
    const messageId = message?.id;
    if (!threadId || !messageId) return;
    if (agent?.isRunning) {
      showToast("正在生成中，先停止或等本轮结束再重新生成");
      return;
    }
    const msgs = langgraphAgent.messages ?? [];
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx <= 0) return;
    const prevUser = [...msgs.slice(0, idx)]
      .reverse()
      .find((m) => m.role === "user");
    if (!prevUser?.id) return;
    const ok = await regenerateChatRun(threadId, prevUser.id);
    if (!ok) {
      showToast("重新生成失败：服务端没能定位这一轮，刷新后重试");
      return;
    }
    langgraphAgent.setMessages?.(msgs.slice(0, idx) as never);
    void copilotkit.runAgent({ agent }).catch((e: unknown) => {
      console.error("[AssistantMessage] 重新生成 runAgent 失败", e);
    });
  }, [threadId, message?.id, agent, copilotkit]);

  return (
    <div
      className="ws-asst-msg"
      data-ws-chars={content.length}
      data-ws-collapsed={collapsed ? "1" : "0"}
    >
      {/* 限高只作用于正文（globals.css 的 .ws-asst-msg[data-ws-collapsed="1"] .cpk:prose）：
          v2 把工具栏渲染在正文之后，包整条消息会把复制/重新生成一起裁掉 */}
      <CopilotChatAssistantMessage
        message={message}
        messages={messages}
        isRunning={isRunning}
        onRegenerate={() => void regenerate()}
        additionalToolbarItems={
          collapsible ? (
            <button
              type="button"
              data-track="chat.msgToggle"
              aria-expanded={expanded}
              className="ws-msg-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : `展开全文（${content.length} 字）`}
            </button>
          ) : null
        }
      />
    </div>
  );
}
