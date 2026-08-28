"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { HttpAgent } from "@ag-ui/client";

// agent 名（Record 的键）会被聊天组件引用；URL 指向本项目的网关 route
const langflowAgent = new HttpAgent({
  url: "/api/agent",
  description: "Langflow workflow agent（经 AG-UI 网关）",
});

export function AgentProvider({ children }: { children: React.ReactNode }) {
  return (
    <CopilotKit selfManagedAgents={{ default: langflowAgent }}>
      {children}
    </CopilotKit>
  );
}
