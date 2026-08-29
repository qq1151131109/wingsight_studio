"use client";

import { CopilotSidebar } from "@copilotkit/react-ui";
import type {
  CopilotKitCSSProperties,
  RenderSuggestionsListProps,
} from "@copilotkit/react-ui";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import ChatInput from "./ChatInput";

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

/** 空态建议列表：对话一旦开始就隐藏，避免常驻噪音 */
function EmptyStateSuggestions({
  suggestions,
  onSuggestionClick,
}: RenderSuggestionsListProps) {
  const count = useCopilotChatHeadless_c().messages.length;
  if (count > 0) return null;
  return (
    <div className="suggestions">
      {suggestions.map((s) => (
        <button
          key={s.title}
          type="button"
          className="suggestion"
          onClick={() => onSuggestionClick(s.message)}
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
        }}
        suggestions={SUGGESTIONS}
        RenderSuggestionsList={EmptyStateSuggestions}
        Input={ChatInput}
        defaultOpen
        clickOutsideToClose={false}
      />
    </div>
  );
}
