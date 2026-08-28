import type { Metadata } from "next";
import "./globals.css";
import "@copilotkit/react-ui/styles.css";
import { AgentProvider } from "./agent-provider";

export const metadata: Metadata = {
  title: "Wingsight Studio",
  description: "AI 影视创作工作台 —— CopilotKit + Langflow",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AgentProvider>{children}</AgentProvider>
      </body>
    </html>
  );
}
