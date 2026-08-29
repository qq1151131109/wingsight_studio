"use client";

import {
  CopilotSidebar,
  useChatContext,
  type ErrorMessageProps,
} from "@copilotkit/react-ui";
import type {
  CopilotKitCSSProperties,
  RenderSuggestionsListProps,
} from "@copilotkit/react-ui";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import {
  CircleAlert,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import ChatInput from "./ChatInput";
import ChatSidebarHeader from "./ThreadsBar";

/** 失败卡：错误说明 + 重试本轮（stock 只显示错误文案，用户得整句重打） */
function ErrorWithRetry({ error, onRegenerate }: ErrorMessageProps) {
  return (
    <div className="my-1 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-text-2">
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">
          本次响应出错：{error?.message?.slice(0, 160) || "未知错误"}
        </p>
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-hairline bg-surface-1 px-2 py-1 text-[11px] text-text-2 transition-colors hover:border-accent-soft hover:text-text"
          >
            <RotateCcw className="h-3 w-3" />
            重试本轮
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 关闭侧栏后的"助手"显性入口（替换 stock 圆钮；对标参考布局的顶栏 Agent 按钮） */
function AssistantFab() {
  const { open, setOpen } = useChatContext();
  if (open) return null; // 侧栏开着时无需入口（Header 有关闭钮，避免成对悬浮）
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title="打开画布助手"
      className="fixed right-4 top-14 z-40 flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-xs font-medium text-white shadow-md transition-opacity hover:opacity-90"
    >
      <Sparkles className="h-3.5 w-3.5" />
      助手
    </button>
  );
}

/**
 * 主题化聊天侧栏：把 CopilotKit 的 CSS 变量映射到 juben 设计 token。
 * 输入框换成自定义 ChatInput（@引用画布卡片 + 停止按钮 + IME 安全），
 * 空态给领域建议 chips（stock 的 suggestions 常驻消息底部，这里收窄为仅空态显示）。
 */
const SUGGESTIONS = [
  {
    title: "✍️ 建个剧本卡",
    message: "创建一个剧本卡：写一个 90 秒都市悬疑短片的梗概，标题自拟。",
  },
  {
    title: "🎭 拆解剧本出设定图",
    message: "把画布上的剧本拆解成角色和场景资产清单，建卡后为它们生成设定图。",
  },
  {
    title: "📣 写宣发文案",
    message: "为画布上的剧本写一版抖音宣发文案，6 条，带话题标签。",
  },
  {
    title: "🧹 整理画布",
    message: "把画布上的卡片按类型分组整理并连好关系，最后调整视口让我看全。",
  },
];

/** 空态建议列表：对话一旦开始就隐藏；2×2 纸感卡片（stock 的 .suggestion 太碎太小） */
function EmptyStateSuggestions({
  suggestions,
  onSuggestionClick,
}: RenderSuggestionsListProps) {
  const count = useCopilotChatHeadless_c().messages.length;
  if (count > 0) return null;
  return (
    <div className="grid grid-cols-2 gap-1.5 px-1 pt-2">
      {suggestions.map((s) => (
        <button
          key={s.title}
          type="button"
          title={s.message}
          onClick={() => onSuggestionClick(s.message)}
          className="rounded-lg border border-hairline bg-surface-2 px-2.5 py-2 text-left text-xs leading-snug text-text-2 transition-colors hover:border-accent-soft hover:bg-surface-1 hover:text-text"
        >
          {s.title}
        </button>
      ))}
    </div>
  );
}

export default function ThemedSidebar() {
  return (
    <div
      style={
        {
          "--copilot-kit-primary-color": "var(--color-accent)",
          "--copilot-kit-contrast-color": "#fff",
          "--copilot-kit-background-color": "var(--color-surface-1)",
          "--copilot-kit-input-background-color": "var(--color-surface-2)",
          "--copilot-kit-secondary-color": "var(--color-surface-2)",
          "--copilot-kit-secondary-contrast-color": "var(--color-text)",
          "--copilot-kit-separator-color": "var(--color-hairline)",
          "--copilot-kit-muted-color": "var(--color-text-3)",
          "--copilot-kit-shadow-sm": "0 1px 3px oklch(0 0 0 / 0.06)",
          "--copilot-kit-shadow-md": "0 4px 16px oklch(0 0 0 / 0.10)",
          "--copilot-kit-shadow-lg": "0 8px 24px oklch(0 0 0 / 0.14)",
        } as CopilotKitCSSProperties
      }
      className="contents"
    >
      <CopilotSidebar
        labels={{
          title: "Wingsight 助手",
          initial:
            "你好，我是画布助手。你可以让我建卡片、连角色和剧本，或调用宣发 / 资产出图技能。",
          placeholder: "输入…",
        }}
        icons={{
          openIcon: <PanelRightOpen className="h-4 w-4" />,
          closeIcon: <PanelRightClose className="h-4 w-4" />,
          // "思考中"指示器：纸感三点弹跳（stock 默认转圈与纸感不符）
          activityIcon: (
            <span className="flex items-center gap-1 py-2.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 rounded-full bg-accent/60 motion-safe:animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          ),
        }}
        suggestions={SUGGESTIONS}
        RenderSuggestionsList={EmptyStateSuggestions}
        Input={ChatInput}
        Header={ChatSidebarHeader}
        Button={AssistantFab}
        ErrorMessage={ErrorWithRetry}
        defaultOpen
        clickOutsideToClose={false}
      />
    </div>
  );
}
