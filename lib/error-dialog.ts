"use client";

/**
 * 全局错误对话框的事件通道（对标 Storyboard-Copilot 的 errorDialogEvents）：
 * 任何模块 reportError(...) 即可弹出统一错误框，附可复制的诊断报告。
 */

import type { ErrorDialogDetail } from "@/components/shell/GlobalErrorDialog";

export const ERROR_DIALOG_EVENT = "wingsight:error-dialog";

/** 上报错误：弹统一错误框（detail 会进入可复制的诊断报告） */
export function reportError(title: string, detail?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ErrorDialogDetail>(ERROR_DIALOG_EVENT, {
      detail: { title, detail },
    }),
  );
}

/** 构造可复制的诊断报告（对标 generationErrorReport：环境+上下文，脱敏由调用方负责） */
export function buildDiagnosticReport(title: string, detail?: string): string {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const os =
    nav?.userAgent.match(/\(([^)]+)\)/)?.[1]?.replace(/[^;]+;/g, "").trim() ??
    nav?.platform ??
    "unknown";
  return [
    `【Wingsight 诊断报告】${title}`,
    `时间：${new Date().toLocaleString("zh-CN")}`,
    `页面：${typeof location !== "undefined" ? location.pathname : "-"}`,
    `环境：${os}`,
    detail ? `详情：\n${detail}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
