import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wingsight Studio",
  description: "AI 影视创作画布 —— React Flow + CopilotKit + LangGraph",
};

/** 首屏前应用主题，避免闪烁（用户选择 > 系统） */
const themeScript = `
try {
  var t = localStorage.getItem("wingsight-theme");
  var dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
