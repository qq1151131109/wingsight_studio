"use client";

import { CopilotSidebar } from "@copilotkit/react-ui";

export default function Home() {
  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">Wingsight Studio</h1>
        <p className="text-sm text-zinc-500">
          CopilotKit 前端骨架 —— agent 对话经网关接 Langflow（资产画布后续在此叠加）
        </p>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center text-zinc-500">
          <p>右侧聊天窗连接 Langflow flow。</p>
          <p className="mt-2 text-sm">
            使用前在 <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">.env.local</code> 配置
            LANGFLOW_URL / LANGFLOW_FLOW_ID /（可选）LANGFLOW_API_KEY，详见 README。
          </p>
        </div>
      </main>
      <CopilotSidebar
        labels={{
          title: "Wingsight 助手",
          initial: "你好，我在——背后是 Langflow。想拆剧本、出资产图，直接说。",
          placeholder: "输入…",
        }}
        defaultOpen
      />
    </div>
  );
}
