import type { Metadata } from "next";
import "./globals.css";
import GlobalErrorDialog from "@/components/shell/GlobalErrorDialog";

export const metadata: Metadata = {
  title: "Wingsight Studio",
  description: "AI 影视创作画布 —— React Flow + CopilotKit + LangGraph",
};

/**
 * 首屏前应用主题，避免闪烁。规则与 lib/theme.ts / juben 一致：
 * 三态 auto|light|dark；auto 按当地时间 20:00–次日 08:00 夜间；
 * 手动选择是临时覆盖（带 override-until 时间戳，过期回落 auto）。
 * 兼容旧 key "wingsight-theme"：有值则迁移为一次手动覆盖。
 */
const themeScript = `
try {
  var K = "wingsight.appearance.theme.v1";
  var O = "wingsight.appearance.theme-override-until.v1";
  var S = 20, E = 8;
  var mode = "auto";
  try {
    // URL 带 ?theme=reset：清掉手动覆盖，恢复跟随时间（一次性诊断入口）
    if (location.search.indexOf("theme=reset") !== -1) {
      localStorage.removeItem(K);
      localStorage.removeItem(O);
      localStorage.removeItem("wingsight-theme");
    }
    var m = localStorage.getItem(K);
    // 旧 key "wingsight-theme" 是历史遗留（旧按钮直接写它，且会经迁移逻辑
    // 变成长期覆盖反复作祟）——直接清理，不再迁移
    localStorage.removeItem("wingsight-theme");
    if (m === "light" || m === "dark") {
      var until = Number(localStorage.getItem(O));
      if (Number.isFinite(until) && until > Date.now()) mode = m;
      else { localStorage.setItem(K, "auto"); localStorage.removeItem(O); }
    }
  } catch (e) {}
  var h = Math.floor(Date.now() / 36e5 + 8) % 24;
  var dark = mode === "dark" || (mode === "auto" && (h >= S || h < E));
  if (dark) document.documentElement.classList.add("dark");
  document.documentElement.dataset.themeMode = mode;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full overflow-hidden">
        {children}
        <GlobalErrorDialog />
      </body>
    </html>
  );
}
