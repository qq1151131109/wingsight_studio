"use client";

/**
 * 标准空态/加载/错误状态组件（对标 open-ai-canvas workspace-state）：
 * 图标 + 标题 + 描述 + 可选操作按钮，全站复用一个视觉语言。
 * 错误态文案明确"当前内容不会被覆盖"，降低用户焦虑。
 */

import type { ReactNode } from "react";
import { CircleAlert, Loader2 } from "lucide-react";

export function WorkspaceState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon ?? null}
      <p className="font-editorial text-base font-medium text-text-2">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-text-3">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function WorkspaceErrorState({
  title = "加载失败",
  description = "当前内容不会被覆盖，可直接重试。",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <WorkspaceState
      icon={<CircleAlert className="mb-3 h-8 w-8 text-danger" />}
      title={title}
      description={description}
      action={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-hairline px-3.5 py-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            重试
          </button>
        ) : null
      }
    />
  );
}

export function WorkspaceLoadingState({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-text-3">
      <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" />
      {label}
    </div>
  );
}
