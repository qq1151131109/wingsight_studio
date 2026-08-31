"use client";

/**
 * 全局错误对话框（对标 Storyboard-Copilot GlobalErrorDialog）：
 * 挂在根布局，任何模块 reportError() 即弹出；消息 + 详情 + 一键复制诊断报告。
 */

import { useEffect, useState } from "react";
import { CircleAlert, Copy, X } from "lucide-react";
import {
  buildDiagnosticReport,
  ERROR_DIALOG_EVENT,
} from "@/lib/error-dialog";

export interface ErrorDialogDetail {
  title: string;
  detail?: string;
}

export default function GlobalErrorDialog() {
  const [cur, setCur] = useState<ErrorDialogDetail | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setCur((e as CustomEvent<ErrorDialogDetail>).detail ?? null);
      setCopied(false);
    };
    window.addEventListener(ERROR_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(ERROR_DIALOG_EVENT, onOpen);
  }, []);

  if (!cur) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={() => setCur(null)}
    >
      <div
        className="w-full max-w-md rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-danger">
            <CircleAlert className="h-4 w-4 shrink-0" />
            {cur.title}
          </h3>
          <button
            type="button"
            data-tip="关闭"
            aria-label="关闭"
            className="rounded p-0.5 text-text-4 hover:text-text"
            onClick={() => setCur(null)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {cur.detail ? (
          <pre className="nowheel mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-hairline bg-surface-2 p-2 text-[11px] leading-relaxed text-text-2">
            {cur.detail}
          </pre>
        ) : null}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(buildDiagnosticReport(cur.title, cur.detail))
                .catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "已复制" : "复制诊断报告"}
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            onClick={() => setCur(null)}
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
