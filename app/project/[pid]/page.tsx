"use client";

import { ReactFlowProvider } from "@xyflow/react";
import CanvasView from "@/components/canvas/CanvasView";
import WorkbenchTopbar from "@/components/canvas/WorkbenchTopbar";
import CanvasAgentBridge from "@/components/copilot/CanvasAgentBridge";
import ChatPersistence from "@/components/copilot/ChatPersistence";
import ProjectManager from "@/components/copilot/ProjectManager";
import ThemedSidebar from "@/components/copilot/Sidebar";
import ActivityBar from "@/components/shell/ActivityBar";
import AuthGate from "@/components/shell/AuthGate";
import TelemetryListener from "@/components/telemetry/TelemetryListener";

/** 画布工作台（从首页项目卡进入；pid 由 ProjectManager 读取路由参数激活）。 */
export default function ProjectWorkbench() {
  return (
    <AuthGate>
      <div className="flex h-dvh overflow-hidden">
        <TelemetryListener />
        <ActivityBar />
        <main className="flex min-w-0 flex-1 flex-col">
          <WorkbenchTopbar />
          <div className="relative min-h-0 flex-1">
            <ReactFlowProvider>
              <CanvasView />
            </ReactFlowProvider>
          </div>
        </main>
        <CanvasAgentBridge />
        <ChatPersistence />
        <ProjectManager />
        <ThemedSidebar />
      </div>
    </AuthGate>
  );
}
