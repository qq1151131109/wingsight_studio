"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { HttpAgent } from "@ag-ui/client";
import { getToken } from "@/lib/auth";

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
  return (
    <CopilotKit
      selfManagedAgents={{ default: langgraphAgent }}
      // stock 的调试球（黑渐变圆钮）与纸感设计不符，且会顶掉 header 关闭按钮
      showDevConsole={false}
    >
      {children}
    </CopilotKit>
  );
}
