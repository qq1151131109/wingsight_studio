"use client";

/**
 * 自绘聊天侧栏 Header（v2 CopilotSidebar 的 header 槽位替换 CopilotModalHeader；
 * 槽位组件不收绑定 props——关闭走 useCopilotChatConfiguration）：
 *   错误横幅 + 标题 + [新会话] [历史] [关闭]
 * 历史面板：列表（自动标题 + 时间 + 条数）/ 点击切换 / 重命名 / 删除；
 * 删除当前会话时自动落到最新一条。会话状态在 lib/chat/session.ts。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { History, MessageSquarePlus, Pencil, Download, Trash2, X } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";
import { useChatSession } from "@/lib/chat/session";
import { contentToMarkdown, decodeContent } from "@/lib/chat/content";
import {
  cancelChatRun,
  deleteChatThread,
  listChatThreads,
  loadChatMessages,
  renameChatThread,
  type ChatThreadMeta,
} from "@/lib/projects";
import ConfirmDialog from "@/components/shell/ConfirmDialog";

/** 运行错误横幅：人话摘要 + 可关（v2 onError 写入 session store） */
function RunErrorBanner() {
  const runError = useChatSession((s) => s.runError);
  const setRunError = useChatSession((s) => s.setRunError);
  if (!runError) return null;
  return (
    <div className="pointer-events-auto absolute inset-x-4 top-1 z-30 flex items-start gap-2 rounded-lg border border-danger/30 bg-surface-1/95 px-3 py-2 text-xs text-text-2 shadow-md backdrop-blur">
      <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-danger" />
      <p className="min-w-0 flex-1 leading-relaxed">{runError}</p>
      <button
        type="button"
        data-tip="关闭" aria-label="关闭错误提示"
        className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-text"
        onClick={() => setRunError(null)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 相对时间（同首页项目卡规则） */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

export default function ChatSidebarHeader() {
  // v1 useCopilotChat 是开源无门控的 headless 面（isLoading/stopGeneration 真
  // 功能；_c 变体才是付费门控桩）。v2 槽位环境下它读 <CopilotKit> 的 v1 上下文桥
  const { isLoading, stopGeneration } = useCopilotChat();
  const config = useCopilotChatConfiguration();
  const projectId = useCanvasStore((s) => s.projectId);
  const threadId = useChatSession((s) => s.threadId);
  const setThreadId = useChatSession((s) => s.setThreadId);

  const [panelOpen, setPanelOpen] = useState(false);
  const [threads, setThreads] = useState<ChatThreadMeta[] | null>(null);
  const [threadQuery, setThreadQuery] = useState("");
  const [deleting, setDeleting] = useState<ChatThreadMeta | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** 离开当前会话前收尾：运行中先停客户端 run + 透传后端取消（在途出图不再烧钱） */
  const abandonActiveRun = useCallback(() => {
    if (!isLoading) return;
    void cancelChatRun(useChatSession.getState().threadId);
    stopGeneration();
  }, [isLoading, stopGeneration]);

  const shownThreads = (threads ?? []).filter((t) => {
    const q = threadQuery.trim().toLowerCase();
    return !q || (t.title || "未命名会话").toLowerCase().includes(q);
  });

  /** 导出当前会话为 Markdown（拼文本 + Blob 下载，不经服务端） */
  const exportCurrent = async () => {
    if (!projectId || !threadId) return;
    try {
      const [msgs, meta] = await Promise.all([
        loadChatMessages(projectId, threadId),
        Promise.resolve(
          (threads ?? []).find((t) => t.id === threadId)?.title || "会话",
        ),
      ]);
      if (!msgs || msgs.length === 0) return;
      const lines = [`# ${meta}`, ""];
      for (const m of msgs) {
        const text = contentToMarkdown(decodeContent(m.content));
        lines.push(`**${m.role === "user" ? "🧑 用户" : "🎬 助手"}**`, "", text, "", "---", "");
      }
      const blob = new Blob([lines.join("\n")], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${meta}-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* 静默：导出失败不打扰 */
    }
  };

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setThreads(await listChatThreads(projectId));
    } catch {
      setThreads([]);
    }
  }, [projectId]);

  const togglePanel = () => {
    // 打开时拉最新列表（而非 effect 里拉，避免级联渲染）
    if (!panelOpen) void refresh();
    setPanelOpen(!panelOpen);
  };

  // 点击面板外部关闭
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPanelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [panelOpen]);

  const startNew = () => {
    abandonActiveRun();
    setThreadId(null);
    setPanelOpen(false);
  };

  const rename = async (t: ChatThreadMeta) => {
    if (!projectId) return;
    const name = window.prompt("重命名会话", t.title || "未命名会话");
    if (!name?.trim() || name.trim() === t.title) return;
    if (await renameChatThread(projectId, t.id, name.trim())) void refresh();
  };

  const remove = async () => {
    if (!deleting || !projectId) return;
    if (await deleteChatThread(projectId, deleting.id)) {
      const rest = (threads ?? []).filter((x) => x.id !== deleting.id);
      setThreads(rest);
      // 删的是当前会话 → 停掉在途任务（后端 checkpoint 随删除端点一并清），
      // 落到最新一条（或空新会话）
      if (deleting.id === threadId) {
        abandonActiveRun();
        setThreadId(rest[0]?.id ?? null);
      }
    }
    setDeleting(null);
  };

  return (
    <div
      ref={wrapRef}
      className="copilotKitHeader relative flex w-full items-center"
    >
      <RunErrorBanner />
      <span className="truncate">Wingsight 助手</span>

      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          data-tip="新会话" aria-label="新会话"
          onClick={startNew}
          className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-tip="历史会话" aria-label="历史会话"
          onClick={togglePanel}
          className={`rounded-md p-1.5 transition-colors hover:bg-surface-2 hover:text-text ${
            panelOpen ? "bg-surface-2 text-text" : "text-text-3"
          }`}
        >
          <History className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="关闭" data-tip="关闭"
          onClick={() => config?.setModalOpen(false)}
          className="rounded-md p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {panelOpen ? (
        <div className="absolute right-2 top-[calc(100%+4px)] z-30 w-72 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <p className="text-[10px] uppercase tracking-wide text-text-4">
              历史会话
            </p>
            <button
              type="button"
              data-tip="导出当前会话为 Markdown" aria-label="导出当前会话为 Markdown"
              className="ml-auto rounded p-0.5 text-text-4 transition-colors hover:text-text"
              onClick={() => void exportCurrent()}
            >
              <Download className="h-3 w-3" />
            </button>
          </div>
          <div className="px-1 pb-1">
            <input
              value={threadQuery}
              onChange={(e) => setThreadQuery(e.target.value)}
              placeholder="搜索会话…"
              className="w-full rounded-md border border-hairline bg-surface-2 px-2 py-1 text-xs text-text outline-none placeholder:text-text-4 focus:border-accent-soft"
            />
          </div>
          {threads === null ? (
            <p className="px-2 py-4 text-center text-xs text-text-4">加载中…</p>
          ) : threads.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-text-4">
              暂无历史会话
            </p>
          ) : shownThreads.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-text-4">
              没有匹配的会话
            </p>
          ) : (
            <div className="max-h-80 overflow-auto">
              {shownThreads.map((t) => (
                <div
                  key={t.id}
                  className={`group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2 ${
                    t.id === threadId ? "bg-surface-2" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      if (t.id !== threadId) abandonActiveRun();
                      setThreadId(t.id);
                      setPanelOpen(false);
                    }}
                  >
                    <p
                      className={`truncate text-xs ${
                        t.id === threadId ? "font-medium text-text" : "text-text-2"
                      }`}
                    >
                      {t.title || "未命名会话"}
                    </p>
                    <p className="text-[10px] text-text-4">
                      {formatTime(t.updated_at)}
                      {t.message_count > 0 ? ` · ${t.message_count} 条` : ""}
                    </p>
                  </button>
                  <button
                    type="button"
                    data-tip="重命名" aria-label="重命名"
                    className="shrink-0 rounded p-1 text-text-4 opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
                    onClick={() => void rename(t)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-tip="删除" aria-label="删除"
                    className="shrink-0 rounded p-1 text-text-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    onClick={() => setDeleting(t)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`删除会话「${deleting.title || "未命名会话"}」？`}
          message="该会话的全部聊天记录将被永久删除，此操作不可撤销。"
          confirmText="删除"
          danger
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}
