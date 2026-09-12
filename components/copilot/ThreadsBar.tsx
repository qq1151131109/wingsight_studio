"use client";

/**
 * 自绘聊天侧栏 Header（v2 CopilotSidebar 的 header 槽位替换 CopilotModalHeader；
 * 槽位组件不收绑定 props——关闭走 useCopilotChatConfiguration）：
 *   错误横幅 + 品牌标（W）+ 身份（「画布助手」+运行状态）+ [搜索][历史] │ [关闭]
 * 历史面板：列表（自动标题 + 时间 + 条数）/ 点击切换 / 重命名 / 删除；
 * 删除当前会话时自动落到最新一条。会话状态在 lib/chat/session.ts。
 *
 * 2026-09-10 review 收口（原来头部是「孤立运行点 + 15px 会话标题 + 四个同权重
 * 裸图标」，乱在三点）：① 会话名只在下面页签行出现，头部不再重复说一遍，改回
 * 产品身份；② 搜索/历史是"看这个会话"的工具，收进一个 pill 槽成组，关闭是
 * 窗口动作，用竖线与组分开；③「技能」移去输入条（产品能力入口与当前会话无关，
 * 不该占头部黄金位）。激活态也从「与 hover 同色的 bg-surface-2」改成 +ring，
 * 否则"开着"和"划过"看不出区别。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { History, Pencil, Download, Plus, Search, Trash2, X } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";
import { useChatSession } from "@/lib/chat/session";
import { useChatSearch } from "@/lib/chat/search";
import { CTX_MARK } from "@/lib/chat/messageContext";
import ChatSearch from "./ChatSearch";
import { contentToMarkdown, decodeContent } from "@/lib/chat/content";
import { migrateLegacyUserContent } from "@/lib/chat/messageContext";
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
        className="shrink-0 rounded p-1.5 text-text-4 transition-colors hover:text-text"
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

/** 机械标题（服务端过渡态）：等待 LLM 智能命名升级的会话。以服务端下发的
 *  title_mechanical 为准（首条消息截断/附件名截断都算机械，前端无法自行复算）；
 *  空标题/遗留字面量/界标截断作前端兜底 */
function isMechanicalTitle(t: ChatThreadMeta): boolean {
  return (
    t.title_mechanical === true ||
    !t.title ||
    t.title === "未命名会话" ||
    t.title.startsWith(CTX_MARK)
  );
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
  const searchOpen = useChatSearch((s) => s.open);
  const setSearchOpen = useChatSearch((s) => s.setOpen);
  // 页签双击重命名（浏览器 tab 范式）：内联输入，Enter/失焦提交、Esc 取消
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
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
        // 思考行不进导出稿（对齐气泡口径：过程折叠，导出给用户的是对话正文）
        if (m.role === "reasoning") continue;
        // 与气泡同口径：旧格式先迁移（导出不该把附件正文再抄一份），导出内容 =
        // 用户可见部分 + 附件与引用清单 + 媒体 URL
        const text = contentToMarkdown(
          migrateLegacyUserContent(decodeContent(m.content)) as never,
        );
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

  // 挂载与 threadId 变化时重拉：header 标题与页签条都吃这份列表
  // （新建会话首存落库、自动标题更新、删除后的落位都要反映到页签）
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pollUntilUpgraded = (fetched: ChatThreadMeta[], elapsed: number) => {
      // 标题升级回显：LLM 智能命名在首存后几秒~几十秒才落库，而这里只在
      // threadId 变化时拉一次——页签会一直停在机械标题（纯附件会话甚至是
      // <<<WS-CTX>>> 界标截断，2026-09-12 用户实报）。列表里还有机械标题时
      // 每 5s 重拉，升级落地即停；60s 封顶（命名失败/失败重试的兜底，全是
      // 正经标题的存量项目零额外请求）
      if (!alive || elapsed > 60_000) return;
      if (!fetched.some((t) => isMechanicalTitle(t))) return;
      timer = setTimeout(
        () =>
          void listChatThreads(projectId)
            .then((next) => {
              if (alive) setThreads(next);
              pollUntilUpgraded(next, elapsed + 5_000);
            })
            .catch(() => {}),
        5_000,
      );
    };
    void (async () => {
      try {
        const list = await listChatThreads(projectId);
        if (alive) setThreads(list);
        pollUntilUpgraded(list, 0);
      } catch {
        if (alive) setThreads([]);
      }
    })();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, threadId]);

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

  const commitTabRename = async (id: string) => {
    const next = (renaming?.value ?? "").trim();
    const old = (threads ?? []).find((t) => t.id === id)?.title || "";
    setRenaming(null);
    if (!projectId || !next || next === old) return;
    if (await renameChatThread(projectId, id, next)) void refresh();
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
      className="copilotKitHeader relative flex w-full flex-col gap-2"
    >
      <div className="relative flex min-h-8 w-full items-center gap-2">
      <RunErrorBanner />
      {/* 头部只留身份 + 运行状态：会话名交给下面的页签行（两行说同一个名字
          是重复）；「技能」已移到输入条（产品能力入口与当前会话无关）。
          运行点从标题左侧 40px 外的孤立位置收进标题尾巴 */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* 品牌标：Wingsight 首字母 W（editorial 衬线，对话面板常驻品牌位） */}
        <span
          className="font-editorial flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-md bg-accent text-[11px] font-semibold text-white"
          title="Wingsight Studio"
        >
          W
        </span>
        <span className="truncate text-[13.5px] font-semibold tracking-[0.01em]">
          画布助手
        </span>
        {isLoading ? (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warn"
            aria-label="运行中"
          />
        ) : null}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        {/* 查看类动作成组（搜索/历史），关闭是窗口动作，与组之间用竖线分开 */}
        <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface-2/50 p-0.5">
          <button
            type="button"
            data-tip="在对话里搜索（⌘/Ctrl+F）" aria-label="打开搜索"
            data-track="chat.searchOpen"
            onClick={() => setSearchOpen(!searchOpen)}
            className={`flex h-7 w-7 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text ${
              searchOpen ? "bg-surface-2 text-text ring-1 ring-accent-soft" : ""
            }`}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-tip="全部会话（搜索/重命名）" aria-label="全部会话（搜索/重命名）"
            data-track="chat.threadSwitcher"
            onClick={togglePanel}
            className={`flex h-7 w-7 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text ${
              panelOpen ? "bg-surface-2 text-text ring-1 ring-accent-soft" : ""
            }`}
          >
            <History className="h-4 w-4" />
          </button>
        </div>
        <span className="h-4 w-px bg-hairline" aria-hidden="true" />
        <button
          type="button"
          aria-label="关闭" data-tip="关闭"
          onClick={() => config?.setModalOpen(false)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      </div>

      {/* 页签条（浏览器 tab 范式）：最近会话常驻可见，点击切换 / × 关闭 / + 新建。
          font-sans/font-normal 显式断开头部继承的衬线粗体——编辑风字体落在
          11px 页签上就是一排歪扭小标题 */}
      <div className="flex items-end gap-0.5 overflow-x-auto pb-px font-sans font-normal [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {threadId === null || !((threads ?? []).some((t) => t.id === threadId)) ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-t-md border-b-2 border-accent bg-surface-2/60 px-2 py-1 text-[11px] text-text"
            aria-current="page"
          >
            新会话
          </span>
        ) : null}
        {(threads ?? []).slice(0, 8).map((t) => {
          const active = t.id === threadId;
          return (
            <span
              key={t.id}
              className={`group flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-2 py-1 text-[11px] transition-colors ${
                active
                  ? "border-accent bg-surface-2/60 text-text"
                  : "border-transparent text-text-3 hover:bg-surface-2/40 hover:text-text"
              }`}
            >
              {renaming?.id === t.id ? (
                <input
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitTabRename(t.id);
                    if (e.key === "Escape") setRenaming(null);
                    e.stopPropagation();
                  }}
                  onBlur={() => void commitTabRename(t.id)}
                  // 双击进入即全选，直接打字覆盖
                  onFocus={(e) => e.currentTarget.select()}
                  autoFocus
                  className="w-28 rounded border border-accent-soft bg-surface-1 px-1 py-0.5 text-[11px] text-text outline-none"
                />
              ) : (
                <button
                  type="button"
                  data-track="chat.tabSwitch"
                  onClick={() => {
                    if (t.id !== threadId) abandonActiveRun();
                    setThreadId(t.id);
                  }}
                  onDoubleClick={() =>
                    setRenaming({ id: t.id, value: t.title || "" })
                  }
                  // 当前页签给更宽的额度（头部不再重复会话名，这里要能读全）
                  className={`truncate ${active ? "max-w-40" : "max-w-24"}`}
                  title={t.title || "未命名会话（双击重命名）"}
                >
                  {t.title || "未命名会话"}
                </button>
              )}
              <button
                type="button"
                data-tip="关闭会话" aria-label={`关闭会话 ${t.title || ""}`}
                data-track="chat.tabClose"
                onClick={() => setDeleting(t)}
                className="rounded p-1.5 -m-0.5 text-text-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          data-tip="新会话" aria-label="新会话"
          data-track="chat.tabNew"
          onClick={startNew}
          className="shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 常挂载（关闭时自返回 null）：Ctrl/Cmd+F 的全局监听在组件里，
          条件挂载会让快捷键在关闭态失效 */}
      <ChatSearch />

      {panelOpen ? (
        <div className="absolute right-2 top-[calc(100%+4px)] z-30 w-72 rounded-lg bg-surface-1 p-1 ws-elev-popover ws-pop-in">
          <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
            <p className="text-[10px] uppercase tracking-wide text-text-4">
              历史会话
            </p>
            <button
              type="button"
              data-tip="导出当前会话为 Markdown" aria-label="导出当前会话为 Markdown"
              className="ml-auto rounded-sm p-1.5 text-text-4 transition-colors hover:text-text"
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
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      t.id === threadId && isLoading ? "animate-pulse bg-warn" : "bg-text-4/40"
                    }`}
                    aria-label={t.id === threadId && isLoading ? "运行中" : "空闲"}
                  />
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
                    className="shrink-0 rounded p-1.5 text-text-4 opacity-0 transition-opacity hover:text-text group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={() => void rename(t)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-tip="删除" aria-label="删除"
                    className="shrink-0 rounded p-1.5 text-text-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
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
