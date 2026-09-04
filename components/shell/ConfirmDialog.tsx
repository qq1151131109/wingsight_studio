"use client";

import { CircleAlert } from "lucide-react";

/** 轻量确认弹窗（模式照搬 juben ConfirmDialog，纸感样式）。 */
export default function ConfirmDialog({
  title,
  message,
  confirmText = "确认",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="ws-card w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal
      >
        <div className="flex items-center gap-2">
          {danger ? <CircleAlert className="h-4.5 w-4.5 text-danger" /> : null}
          <h3 className="font-editorial text-base font-semibold text-text">{title}</h3>
        </div>
        {message ? (
          <p className="mt-2 text-xs leading-relaxed text-text-2">{message}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
              danger ? "bg-danger" : "bg-accent"
            }`}
          >
            {busy ? "处理中…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
