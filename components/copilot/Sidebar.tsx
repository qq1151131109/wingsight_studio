"use client";

import { CopilotSidebar } from "@copilotkit/react-ui";
import type { CopilotKitCSSProperties } from "@copilotkit/react-ui";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

/**
 * 主题化聊天侧栏：把 CopilotKit 的 CSS 变量映射到 juben 设计 token。
 */
export default function ThemedSidebar() {
  return (
    <div
      style={
        {
          "--copilot-kit-primary-color": "var(--color-accent)",
          "--copilot-kit-contrast-color": "#fff",
          "--copilot-kit-background-color": "var(--color-surface-1)",
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
          placeholder: "输入…（例如：建一个剧本卡和两个角色卡并连线）",
        }}
        icons={{
          openIcon: <PanelRightOpen className="h-4 w-4" />,
          closeIcon: <PanelRightClose className="h-4 w-4" />,
        }}
        defaultOpen
        clickOutsideToClose={false}
      />
    </div>
  );
}
