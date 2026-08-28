"use client";

import { ReactFlowProvider } from "@xyflow/react";
import CanvasView from "@/components/canvas/CanvasView";
import CanvasAgentBridge from "@/components/copilot/CanvasAgentBridge";
import ProjectManager from "@/components/copilot/ProjectManager";
import ThemedSidebar from "@/components/copilot/Sidebar";
import ActivityBar from "@/components/shell/ActivityBar";
import AuthGate from "@/components/shell/AuthGate";

/** 画布工作台（从首页项目卡进入；pid 由 ProjectManager 读取路由参数激活）。 */
export default function ProjectWorkbench() {
  return (
    <AuthGate>
      <div className="flex h-dvh overflow-hidden">
        <ActivityBar />
        <main className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <CanvasView />
          </ReactFlowProvider>
        </main>
        <CanvasAgentBridge />
        <ProjectManager />
        <ThemedSidebar />
      </div>
    </AuthGate>
  );
}
