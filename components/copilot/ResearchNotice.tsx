"use client";

/**
 * 调研终态通知桥：调研卡轮询观察到任务进入终态（完成/失败/中断/取消）时——
 *  1) 聊天流插一条 progress_* 瞬时消息（ChatPersistence 对该前缀不落库；
 *     会话内留在 assistant 上下文，助手下轮自知任务已终态不必重查）
 *  2) 画布左下浮条给人话 + 动作：「查看卷宗」= 运镜定位调研卡并直接打开
 *     阅读器（失败/中断态只定位不开卷宗）
 *  AG-UI 会话没有服务端主动推送通道——后台调研跑完 agent 不会主动说话
 *  （白骨精事故：40 来源 103 事实的卷宗躺在库里，用户问了才有输出），
 *  终态信号只能由前端轮询产生：锚点在调研卡（轮询本来就活着），这里只消费。
 */

import { useEffect, useRef, useState } from "react";
import { BookOpen, CheckCircle2, CircleAlert, X } from "lucide-react";
import { langgraphAgent } from "@/app/agent-provider";
import {
  FOCUS_NODES_EVENT,
  OPEN_RESEARCH_READER_EVENT,
  RESEARCH_TERMINAL_EVENT,
  type ResearchTerminalDetail,
} from "@/lib/canvas/events";

const CHAT_TEXT: Record<
  ResearchTerminalDetail["status"],
  (d: ResearchTerminalDetail) => string
> = {
  done: (d) =>
    `📋 深度调研完成：「${d.title}」（源 ${d.sourcesCount} · 事实 ${d.findingsCount}）。卷宗已就绪——画布调研卡点「卷宗」读完整材料，也可以直接让我把卷宗整理成文稿。`,
  error: (d) => `⚠️ 深度调研失败：「${d.title}」——${d.error || "未知错误"}`,
  interrupted: (d) =>
    `⏸️ 深度调研中断：「${d.title}」——已收集的证据保留，可补研续跑。`,
  stopped: (d) => `⏹️ 深度调研已取消：「${d.title}」。`,
};

export default function ResearchNotice() {
  const [notice, setNotice] = useState<ResearchTerminalDetail | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onTerminal = (e: Event) => {
      const detail = (e as CustomEvent<ResearchTerminalDetail>).detail;
      if (!detail?.nodeId || !detail.jobId) return;
      // 聊天瞬时消息（progress_ 前缀 = 不落库，回看历史时消失）
      const agent = langgraphAgent;
      agent?.setMessages?.([
        ...((agent?.messages ?? []) as unknown[]),
        {
          id: `progress_research_${Date.now().toString(36)}`,
          role: "assistant",
          content: CHAT_TEXT[detail.status]?.(detail) ?? "",
        },
      ] as never);
      // 浮条：最新一条顶掉旧通知，12s 自动收起
      setNotice(detail);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNotice(null), 12000);
    };
    window.addEventListener(RESEARCH_TERMINAL_EVENT, onTerminal);
    return () => {
      window.removeEventListener(RESEARCH_TERMINAL_EVENT, onTerminal);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!notice) return null;
  const done = notice.status === "done";
  const failed = notice.status === "error";
  const Icon = done ? CheckCircle2 : CircleAlert;
  return (
    <div className="fixed bottom-4 left-4 z-40 flex max-w-[340px] items-center gap-2 rounded-xl border border-hairline bg-surface-1 px-3 py-2.5 shadow-lg">
      <Icon
        className={`h-4 w-4 shrink-0 ${done ? "text-good" : "text-warn"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-text">
          {done ? "调研完成" : failed ? "调研失败" : notice.status === "interrupted" ? "调研中断" : "调研已取消"}
          《{notice.title}》
        </div>
        <div className="truncate text-[10px] text-text-3">
          {done
            ? `源 ${notice.sourcesCount} · 事实 ${notice.findingsCount}——卷宗已就绪`
            : failed
              ? notice.error || "任务出错"
              : "已收集证据保留，可补研续跑"}
        </div>
      </div>
      <button
        type="button"
        data-track={done ? "research.notice.open" : "research.notice.locate"}
        className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
        onClick={() => {
          window.dispatchEvent(
            new CustomEvent(FOCUS_NODES_EVENT, {
              detail: { ids: [notice.nodeId] },
            }),
          );
          if (done) {
            // 等一拍让卡先挂载/聚焦再开阅读器（同 dispatchFocusEdit 的理由）
            window.setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent(OPEN_RESEARCH_READER_EVENT, {
                  detail: { nodeId: notice.nodeId },
                }),
              );
            }, 80);
          }
          setNotice(null);
        }}
      >
        <BookOpen className="h-3 w-3" />
        {done ? "查看卷宗" : "查看卡片"}
      </button>
      <button
        type="button"
        aria-label="关闭通知"
        data-tip="关闭"
        className="shrink-0 rounded-md p-0.5 text-text-4 transition-colors hover:bg-surface-2 hover:text-text-2"
        onClick={() => setNotice(null)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
