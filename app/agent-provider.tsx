"use client";

import { useEffect } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { HttpAgent } from "@ag-ui/client";
import { getToken } from "@/lib/auth";
import { startThemeSync } from "@/lib/theme";
import { useChatSession } from "@/lib/chat/session";
import { attachSnapshotStability } from "@/lib/chat/snapshotStability";
import { attachRunRetry } from "@/lib/chat/runRetry";

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

// 快照稳定（见 lib/chat/snapshotStability.ts 顶部注释）：MESSAGES_SNAPSHOT
// 整表换 id 会让气泡重建、思考行消失——run 边界（前端工具调用）一次不落
attachSnapshotStability(langgraphAgent);
// run 级自动重试（见 lib/chat/runRetry.ts 顶部注释）：传输中断自动退避重连，
// 后挂 = 更外层——错误经快照中间件透传后才被 retry 接住
attachRunRetry(langgraphAgent);

/** 原始 agent 实例的旁路订阅口（思考透传等需要完整事件流的场景用：
 *  core 注册表里的包装 agent 只转发生命周期子集事件） */
export { langgraphAgent };

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __wsAgent?: unknown }).__wsAgent = langgraphAgent;
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  // 全站主题同步（juben 时间规则：边界自动切换 / 多标签同步），只挂一次
  useEffect(() => startThemeSync(), []);
  // UI 会话 id 直通 CopilotKit（内部 ThreadsProvider）：agent 侧 langgraph
  // checkpoint 按 thread_id 存取——不接通的话「新会话」只清界面，模型仍带旧
  // 会话记忆串台；接通后新会话/切会话/删会话的记忆边界与 UI 一致
  const agentThreadId = useChatSession((s) => s.agentThreadId);
  return (
    <CopilotKit
      threadId={agentThreadId}
      selfManagedAgents={{ default: langgraphAgent }}
      // dev 构建默认挂载 web inspector（右上角黑球，shadow DOM Web Component）；
      // 旧 prop showDevConsole 已废弃不管这事，正确开关是 enableInspector
      enableInspector={false}
    >
      {children}
    </CopilotKit>
  );
}
