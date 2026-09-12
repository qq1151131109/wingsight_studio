"use client";

/**
 * 思考行（替换 v2 默认的 CopilotChatReasoningMessage，2026-09-11）。
 *
 * **单行贯穿，布局永不跳**（opencode TUI ReasoningPart 范式）——v2 默认行为是
 * 流式期间强制展开全文、结束自动折叠成「Thought for N seconds」：高度从 N 行
 * 跳回 1 行，消息区整段上弹，用户反馈「看起来跳来跳去」。三家先进 agent 的
 * 共识是 reasoning 正文永远不允许改变消息区高度：
 *   - codex：reasoning 不进消息区，固定高度状态行原地换最新 summary 行
 *     （streaming.rs latest_summary_line），结束后主区 0 行、全文进 transcript 层
 *   - gemini-cli：同派，底部状态行单行 truncate，正文首 token 到达即清空
 *   - opencode TUI：全生命周期只占一个固定单行——流式 `Thinking: {标题}` spinner
 *     原地刷新，结束同一行原位变 `Thought: {标题} · {时长}`，点击展开全文
 *     （源码注释原话 "a single line throughout, so the layout never shifts"）
 * 我们取 opencode 形态（保留可回看的折叠条），标题提取照三家共识：reasoning
 * 文本的首个加粗行/标题行，零额外模型调用。
 *
 * 事件链：DeepSeek additional_kwargs.reasoning_content → ag_ui_langgraph
 * REASONING_MESSAGE_* SSE → @ag-ui/client 落 role:"reasoning" 消息 → v2
 * messageView 按 role 分发给本组件（message/messages/isRunning props 与
 * CopilotChatReasoningMessage 同签名）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";

type ReasoningMessageProps = {
  message: { id?: string; content?: unknown };
  messages?: { id?: string }[];
  isRunning?: boolean;

};

/** 标题提取（codex latest_summary_line / opencode reasoningSummary 同思路）：
 *  优先首个 `**加粗**` 行或 `# 标题` 行（模型思考常自带头部小节），
 *  否则取最后一个非空行——思考的末行通常陈述「当前正在做什么」，
 *  流式期间它随 delta 原地刷新，就是「实时进度」。 */
function latestTitle(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const bold = lines.find((l) => /^\*\*([^*]+)\*\*$/.test(l));
  if (bold) return bold.replace(/^\*\*|\*\*$/g, "");
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  if (heading) return heading.replace(/^#{1,3}\s+/, "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i].replace(/^[#>*\-\s]+/, "").trim();
    if (l) return l;
  }
  return "";
}

function fmtDuration(sec: number): string {
  if (sec < 1) return "几秒";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

export default function ReasoningMessage({
  message,
  messages,
  isRunning,
}: ReasoningMessageProps) {
  const content = typeof message.content === "string" ? message.content : "";
  const hasContent = content.length > 0;
  const isLatest = messages?.[messages.length - 1]?.id === message.id;
  const isStreaming = !!(isRunning && isLatest);

  // 计时：流式起算、结束定格（结束后 UI 不再依赖 interval，避免无谓重渲）
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (isStreaming) {
      if (startRef.current === null) startRef.current = Date.now();
      const t = setInterval(
        () => setElapsed((Date.now() - (startRef.current ?? Date.now())) / 1000),
        1000,
      );
      return () => clearInterval(t);
    }
    if (startRef.current !== null) {
      setElapsed((Date.now() - startRef.current) / 1000);
      startRef.current = null;
    }
    return undefined;
  }, [isStreaming]);

  // 展开态：默认折叠（单行贯穿的关键）——流式期间也不展开，想看实时全文点一下。
  // 「新一轮流式自动收回」不落 state/effect（React Compiler 禁 effect 里 setState）：
  // 记下用户上次主动展开是哪条消息的哪次流，渲染期派生——流式重启即回折叠基线
  const [userOpen, setUserOpen] = useState<{ id?: string; stream: boolean } | null>(null);
  const open = userOpen ? userOpen.id === message.id && userOpen.stream === isStreaming : false;

  // 标题截断到一行（CSS ellipsis 兜底，这里防超长串把单行撑高）
  const title = useMemo(() => {
    const t = latestTitle(content);
    return t.length > 42 ? `${t.slice(0, 42)}…` : t;
  }, [content]);

  // 结束后标题定格为「收尾时的状态」；流式中随 delta 原地刷新。
  // 回放（刷新页面后从落库恢复）没有计时信息（elapsed 恒 0，流式从未在本
  // 会话发生）——不显示时长，只有实时流式过的才带「N 秒」
  const duration = elapsed > 0 ? ` ${fmtDuration(elapsed)}` : "";
  const label = isStreaming
    ? title || "思考中"
    : `已思考${duration}${title ? ` · ${title}` : ""}`;

  return (
    <div className="ws-reasoning cpk:my-1" data-ws-streaming={isStreaming || undefined}>
      <button
        type="button"
        aria-expanded={hasContent ? open : undefined}
        disabled={!hasContent}
        onClick={() =>
          hasContent && setUserOpen(open ? null : { id: message.id, stream: isStreaming })
        }
        className={
          "flex w-full items-center gap-1.5 py-1 text-left text-xs text-text-2 select-none " +
          (hasContent ? "cursor-pointer hover:text-text-1" : "cursor-default")
        }
      >
        {isStreaming ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
        ) : (
          <ChevronRight
            className={
              "h-3 w-3 shrink-0 transition-transform duration-200 " +
              (open ? "rotate-90" : "")
            }
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      </button>
      {open && hasContent ? (
        <div className="ws-reasoning-body mb-1 ml-[18px] max-h-64 overflow-y-auto border-l border-hairline pl-3 text-xs leading-relaxed whitespace-pre-wrap text-text-2">
          {content}
        </div>
      ) : null}
    </div>
  );
}
