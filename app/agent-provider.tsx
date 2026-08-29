"use client";

import { useEffect } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { HttpAgent } from "@ag-ui/client";
import { getToken } from "@/lib/auth";
import { startThemeSync } from "@/lib/theme";

/**
 * LangGraph 主 agent（agent/ 目录，FastAPI + ag-ui-langgraph，8123 端口）。
 * 默认走 Next 同源代理 /agent-service（next.config.ts rewrites → 127.0.0.1:8123），
 * 本地和远程隧道访问都无需额外配置；特殊部署可用 NEXT_PUBLIC_AGENT_URL 覆盖。
 * 开启认证后带 Bearer（模块在整页加载时求值，登录跳转后自然携带新 token）。
 */
const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? "/agent-service";

const token = typeof window === "undefined" ? null : getToken();

const langgraphAgent = new HttpAgent({
  url: agentUrl,
  description: "Wingsight 画布助手（LangGraph）",
  ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
});

export function AgentProvider({ children }: { children: React.ReactNode }) {
  // 全站主题同步（juben 时间规则：边界自动切换 / 多标签同步），只挂一次
  useEffect(() => startThemeSync(), []);
  return (
    <CopilotKit
      selfManagedAgents={{ default: langgraphAgent }}
      // dev 构建默认挂载 web inspector（右上角黑球，shadow DOM Web Component）；
      // 旧 prop showDevConsole 已废弃不管这事，正确开关是 enableInspector
      enableInspector={false}
    >
      {children}
    </CopilotKit>
  );
}
