"use client";

import { ReactFlowProvider } from "@xyflow/react";
import CanvasView from "@/components/canvas/CanvasView";
import CanvasAgentBridge from "@/components/copilot/CanvasAgentBridge";
import ThemedSidebar from "@/components/copilot/Sidebar";
import ActivityBar from "@/components/shell/ActivityBar";

export default function Home() {
  return (
    <div className="flex h-dvh overflow-hidden">
      <ActivityBar />
      <main className="relative min-w-0 flex-1">
        <ReactFlowProvider>
          <CanvasView />
        </ReactFlowProvider>
      </main>
      <CanvasAgentBridge />
      <ThemedSidebar />
    </div>
  );
}
