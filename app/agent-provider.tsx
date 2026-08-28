"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { HttpAgent } from "@ag-ui/client";

/**
 * LangGraph 主 agent（agent/ 目录，FastAPI + ag-ui-langgraph，8123 端口）。
 * 默认走 Next 同源代理 /agent-service（next.config.ts rewrites → 127.0.0.1:8123），
 * 本地和远程隧道访问都无需额外配置；特殊部署可用 NEXT_PUBLIC_AGENT_URL 覆盖。
 */
const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? "/agent-service";

const langgraphAgent = new HttpAgent({
  url: agentUrl,
  description: "Wingsight 画布助手（LangGraph）",
});

export function AgentProvider({ children }: { children: React.ReactNode }) {
  return (
    <CopilotKit selfManagedAgents={{ default: langgraphAgent }}>
      {children}
    </CopilotKit>
  );
}
