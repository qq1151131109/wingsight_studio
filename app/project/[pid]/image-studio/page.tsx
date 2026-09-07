"use client";

import CanvasAgentBridge from "@/components/copilot/CanvasAgentBridge";
import ChatPersistence from "@/components/copilot/ChatPersistence";
import ProjectManager from "@/components/copilot/ProjectManager";
import TaskEvents from "@/components/copilot/TaskEvents";
import ThemedSidebar from "@/components/copilot/Sidebar";
import ActivityBar from "@/components/shell/ActivityBar";
import AuthGate from "@/components/shell/AuthGate";
import TelemetryListener from "@/components/telemetry/TelemetryListener";
import WorkbenchTopbar from "@/components/canvas/WorkbenchTopbar";
import FreeImageStudio from "@/components/image-studio/FreeImageStudio";

/** 自由生图工作台（项目域第二视图）：与画布工作台同壳——左活动栏 + 顶栏 +
 *  右侧聊天（agent 带画布上下文，可 generate_free_image 出图、canvas_ops
 *  把结果送上画布）；聊天线程与画布工作台共享（ChatPersistence 按项目）。 */
export default function ImageStudioWorkbench() {
  return (
    <AuthGate>
      <div className="flex h-dvh overflow-hidden">
        <TelemetryListener />
        <ActivityBar />
        <main className="flex min-w-0 flex-1 flex-col">
          <WorkbenchTopbar />
          <div className="relative min-h-0 flex-1">
            <FreeImageStudio />
          </div>
        </main>
        <CanvasAgentBridge />
        <ChatPersistence />
        <ProjectManager />
        <TaskEvents />
        <ThemedSidebar />
      </div>
    </AuthGate>
  );
}
