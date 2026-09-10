"use client";

/**
 * 助手消息视图（替换 v2 默认槽位，2026-09-09 长内容 UX 修复）：
 *  - **操作按钮回归**：此前 Sidebar 把 copyButton 换成 NullSlot，而 v2 的工具栏
 *    是条件渲染（没 handler 的按钮不渲染）——助手消息一个操作按钮都没有，长回复
 *    只能手动拖选。现在直接渲染框架的 CopilotChatAssistantMessage（复制钮由框架
 *    接好 onClick=copyToClipboard），并补上「重新生成」。
 *  - **长回复折叠**：正文**实测溢出**到限高的 1.6 倍以上才折（底部渐隐 +
 *    「展开全文（N 字）」）；**最新一轮的答复永不折叠**——折叠是翻历史的手段，
 *    刚拿到的答案要完整铺开。搜索进行中自动展开（命中可能在折叠区里）。
 *    流式输出期间不折叠——写到一半突然收起来太跳。
 *  - **展开状态按消息 id 存 store**（lib/chat/collapse）：框架虚拟化会卸载滚出
 *    视口的消息，组件本地 state 会丢，展开过的长回复滚回来又折上。
 *  - **重新生成**：先调 /chat/regenerate 让服务端把该轮用户消息之前的 checkpoint
 *    分叉为会话当前头，再截断本地历史重跑。只截断不 fork 的话旧回答仍留在模型
 *    上下文里（2026-09-09 实测：模型能逐字复述「已删掉」的答案）。
 *  - **一轮只有一组操作按钮**（2026-09-10 review「为啥这么多复制/重新生成」）：
 *    协议层每个模型步都产出一条独立助手消息（ag_ui_langgraph 的 bubble id 按
 *    「节点变化就重铸」，我们的 chat_node→tool_node→chat_node 于是每步一条），
 *    v2 又给每条消息挂一个操作栏——一轮 5 步就是 5 组按钮，且「重新生成」挂在
 *    中间片段上语义错位（点第 3 条和第 5 条都从本轮那条用户消息重跑整轮）。
 *    现在只有「本轮最后一条有正文的助手消息」留操作栏，中间步骤（含纯工具卡
 *    消息）不挂；折叠同受此约束——中间片段若被折叠却没有展开钮，正文就锁死了。
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
import { useChatCollapse } from "@/lib/chat/collapse";
import { useChatSession } from "@/lib/chat/session";
import { selectSearchActive, useChatSearch } from "@/lib/chat/search";
import { regenerateChatRun } from "@/lib/projects";
import { showToast } from "@/lib/toast";

/** 折叠限高（px，与 globals.css 的 .ws-asst-msg[data-ws-collapsed="1"] 同源） */
const COLLAPSE_LIMIT_PX = 480;
/** 正文溢出到限高的这个倍数才折。略超一点就折 = 只藏两三行却要用户点一次；
 *  旧阈值（700 字 vs 340px ≈ 430 字容量）一折就砍掉近四成正文，正是
 *  「所有回复都折叠、影响观看」的来源（2026-09-11 用户反馈） */
const COLLAPSE_MIN_RATIO = 1.6;
/** 明显短于限高的正文不必测量（省一次 layout 读取） */
const COLLAPSE_SKIP_CHARS = 300;

export default function AssistantMessage({
  message,
  messages,
  isRunning,
}: CopilotChatAssistantMessageProps) {
  const msgId = message?.id ?? "";
  const expanded = useChatCollapse((s) => (msgId ? Boolean(s.expanded[msgId]) : false));
  const toggleExpanded = useChatCollapse((s) => s.toggle);
  const [overflows, setOverflows] = useState(false);
  const searchActive = useChatSearch(selectSearchActive);
  const threadId = useChatSession((s) => s.threadId);
  const chatConfig = useCopilotChatConfiguration();
  const { agent } = useAgent({ agentId: chatConfig?.agentId ?? "default" });
  const { copilotkit } = useCopilotKit();

  const content = typeof message?.content === "string" ? message.content : "";
  const isLatest = messages?.[messages.length - 1]?.id === message?.id;
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
  // 实测正文溢出：用 scrollHeight 而不是字数——同字数在纯文本/列表/代码块下
  // 高度差很多，字数只是排版容量的粗代理。
  // 为什么加 ResizeObserver：回调 ref 触发的时刻框架的 .cpk:prose 内部往往还没
  // 渲染完（首帧量到 0），而 ref 身份不变就不会重量——实测表现是「永远不折叠」。
  // 改为观察外层容器：内容落地/流式增长时补量。
  // 全程在回调 ref（commit 期）里做，不用 effect——react-hooks/set-state-in-effect
  // 是硬错误（同 media 的 onLoad 测量范式）。限高由 CSS 按 data-ws-collapsed 施加，
  // 但 scrollHeight 在 overflow:hidden + max-height 下仍返回完整内容高度，
  // 所以测量与当前是否折叠无关、不会自激；同值直接返回不触发重渲染。
  const measureOverflow = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const measure = () => {
        const prose = el.querySelector(".cpk\\:prose") as HTMLElement | null;
        const next =
          content.length >= COLLAPSE_SKIP_CHARS &&
          Boolean(prose && prose.scrollHeight > COLLAPSE_LIMIT_PX * COLLAPSE_MIN_RATIO);
        setOverflows((prev) => (prev === next ? prev : next));
      };
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    },
    [content],
  );

  const collapsible = isTurnFinal && !isLatest && overflows;
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
      ref={measureOverflow}
      className="ws-asst-msg"
      data-ws-chars={content.length}
      data-ws-collapsed={collapsed ? "1" : "0"}
      // 非本轮收尾片段：整条工具栏（复制/重新生成/展开）不渲染——判据见上面
      data-ws-toolbar={isTurnFinal ? "1" : "0"}
    >
      {/* 限高只作用于正文（globals.css 的 .ws-asst-msg[data-ws-collapsed="1"] .cpk:prose）：
          v2 把工具栏渲染在正文之后，包整条消息会把复制/重新生成一起裁掉 */}
      <CopilotChatAssistantMessage
        message={message}
        messages={messages}
        isRunning={isRunning}
        toolbarVisible={isTurnFinal}
        onRegenerate={isTurnFinal ? () => void regenerate() : undefined}
        additionalToolbarItems={
          collapsible ? (
            <button
              type="button"
              data-track="chat.msgToggle"
              aria-expanded={expanded}
              className="ws-msg-toggle"
              onClick={() => toggleExpanded(msgId)}
            >
              {expanded ? "收起" : `展开全文（${content.length} 字）`}
            </button>
          ) : null
        }
      />
    </div>
  );
}
