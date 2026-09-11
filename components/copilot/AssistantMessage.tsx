"use client";

/**
 * 助手消息视图（替换 v2 默认槽位，2026-09-09 长内容 UX 修复）。
 *
 * **折叠口径 = 行业共识「过程折叠、答案展开」（2026-09-11 用户拍板）**：
 * 思考块与工具调用默认收起（ChatGPT 的 "Thought for X s"、Claude 的
 * Show more/Show less、Perplexity 的 Steps、gemini-cli 的 MaxSizedBox 都是这个口径），
 * **助手正文一律不自动折叠**——此前按「实测溢出 >480px×1.6 自动折 + 展开钮」
 * 折的正是答案本身，方向与主流相反，用户也反馈过「回复都折叠影响观看」。
 * 正文的「过程」折叠在 toolCards（长结果进 <details>）与框架的思考块里。
 *
 *  - **操作按钮回归**：此前 Sidebar 把 copyButton 换成 NullSlot，而 v2 的工具栏
 *    是条件渲染（没 handler 的按钮不渲染）——助手消息一个操作按钮都没有，长回复
 *    只能手动拖选。现在直接渲染框架的 CopilotChatAssistantMessage（复制钮由框架
 *    接好 onClick=copyToClipboard），并补上「重新生成」。
 *  - **重新生成**：先调 /chat/regenerate 让服务端把该轮用户消息之前的 checkpoint
 *    分叉为会话当前头，再截断本地历史重跑。只截断不 fork 的话旧回答仍留在模型
 *    上下文里（2026-09-09 实测：模型能逐字复述「已删掉」的答案）。
 *  - **一轮只有一组操作按钮**（2026-09-10 review「为啥这么多复制/重新生成」）：
 *    协议层每个模型步都产出一条独立助手消息（ag_ui_langgraph 的 bubble id 按
 *    「节点变化就重铸」，我们的 chat_node→tool_node→chat_node 于是每步一条），
 *    v2 又给每条消息挂一个操作栏——一轮 5 步就是 5 组按钮，且「重新生成」挂在
 *    中间片段上语义错位（点第 3 条和第 5 条都从本轮那条用户消息重跑整轮）。
 *    现在只有「本轮最后一条有正文的助手消息」留操作栏，中间步骤（含纯工具卡
 *    消息）不挂。
 */
import { useCallback } from "react";
import {
  CopilotChatAssistantMessage,
  useAgent,
  useCopilotChatConfiguration,
  useCopilotKit,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { langgraphAgent } from "@/app/agent-provider";
import TurnBranchSwitcher from "@/components/copilot/TurnBranchSwitcher";
import { useChatBranches } from "@/lib/chat/branches";
import { useChatSession } from "@/lib/chat/session";
import { regenerateChatRun } from "@/lib/projects";
import { showToast } from "@/lib/toast";

export default function AssistantMessage({
  message,
  messages,
  isRunning,
}: CopilotChatAssistantMessageProps) {
  const msgId = message?.id ?? "";
  const threadId = useChatSession((s) => s.threadId);
  const chatConfig = useCopilotChatConfiguration();
  const { agent } = useAgent({ agentId: chatConfig?.agentId ?? "default" });
  const { copilotkit } = useCopilotKit();

  const content = typeof message?.content === "string" ? message.content : "";
  // 本轮收尾 = 这条消息没发起工具调用。graph.py 的 chat_node 是唯一路由点：
  // 有 tool_calls → Command(goto="tool_node") 继续跑，没有 → goto=END 收轮，所以
  // 「带工具调用的消息」= 中间步骤，「不带」= 本轮最终答复。
  //
  // 实时与回放两条路取同一个结论（消息形状不一样，实测）：
  //  - 实时流：消息自带 toolCalls，是自足且权威的信号——不能改用"往后扫 messages"
  //    的判据：非最新消息在后续消息到达时不会重渲染（props 引用未变 React 直接
  //    bail out），扫出来永远停在"我是最后一条"，实测一轮 5 步 5 组按钮都在。
  //  - 回放（刷新/重开项目）：AG-UI 回放的消息只剩 {id, role, content}，没有
  //    toolCalls，只能往后扫——同轮（到下一个用户消息为止）后面还有助手消息，
  //    本条就是中间步骤。回放是一次性渲染，扫的结果是稳的（实测刷新后判据正确）。
  const toolCalls = (message as { toolCalls?: unknown[] } | undefined)?.toolCalls;
  const isTurnFinal = (() => {
    if (Array.isArray(toolCalls)) return toolCalls.length === 0;
    if (!messages || !message?.id) return true; // 上下文缺失：宁可留着按钮
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx < 0) return true;
    for (let i = idx + 1; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.role === "user") break;
      if (m.role === "assistant") return false;
    }
    return true;
  })();

  /** 本条所属那一轮的用户消息 id（＝分支版本清单的键）+ 是否末轮。
   *
   *  **只有末轮放版本切换器**：切换要挪服务端的会话头，若本轮之后还有别的轮次，
   *  那些轮次就不在模型上下文里了，而界面还留着它们——显示与上下文打架。
   *  更早轮次的分支切换需要把「整条分支（含后续轮次）」也建模，留作后续。 */
  const { turnUser, isLastTurn } = (() => {
    if (!messages || !message?.id) return { turnUser: "", isLastTurn: false };
    const i = messages.findIndex((m) => m.id === message.id);
    if (i < 0) return { turnUser: "", isLastTurn: false };
    let turn = "";
    for (let k = i - 1; k >= 0; k -= 1) {
      if (messages[k].role === "user") {
        turn = String(messages[k].id ?? "");
        break;
      }
    }
    const tail = messages.slice(i + 1).some((m) => m.role === "user");
    return { turnUser: turn, isLastTurn: !tail };
  })();

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
    // 本轮当前这一版的答复（到下一个用户消息为止；多带后面几轮会把别的轮次
    // 也存成本轮的一个「版本」），连它一起交给服务端存档，再 fork
    const abandoned: { id?: string; role?: string; content?: string }[] = [];
    for (let k = idx; k < msgs.length; k += 1) {
      if (msgs[k].role === "user") break;
      if (msgs[k].role === "assistant")
        abandoned.push({
          id: msgs[k].id,
          role: "assistant",
          content: String(msgs[k].content ?? ""),
        });
    }
    const ok = await regenerateChatRun(threadId, prevUser.id, abandoned);
    if (!ok) {
      showToast("重新生成失败：服务端没能定位这一轮，刷新后重试");
      return;
    }
    langgraphAgent.setMessages?.(msgs.slice(0, idx) as never);
    void copilotkit.runAgent({ agent }).catch((e: unknown) => {
      console.error("[AssistantMessage] 重新生成 runAgent 失败", e);
    });
    // 版本清单变了（旧版刚被存档）——刷新让 ‹ i/N › 立刻出现
    void useChatBranches.getState().refresh(threadId);
  }, [threadId, message?.id, agent, copilotkit]);

  return (
    <div
      className="ws-asst-msg"
      data-ws-chars={content.length}
      // 会话内搜索的定位锚（ChatSearch 按消息 id 找到容器再落高亮）：
      // 命中计数走数据源（langgraphAgent.messages），只有「画」需要 DOM
      data-ws-msg-id={msgId || undefined}
      // 非本轮收尾片段：整条工具栏（复制/重新生成）不渲染——判据见上面
      data-ws-toolbar={isTurnFinal ? "1" : "0"}
    >
      <CopilotChatAssistantMessage
        message={message}
        messages={messages}
        isRunning={isRunning}
        toolbarVisible={isTurnFinal}
        onRegenerate={isTurnFinal ? () => void regenerate() : undefined}
        additionalToolbarItems={
          // 本轮多版本时给 ‹ i/N ›（只有收轮那条、且只有末轮才挂）
          isTurnFinal && isLastTurn && turnUser ? (
            <TurnBranchSwitcher turnId={turnUser} />
          ) : null
        }
      />
    </div>
  );
}
