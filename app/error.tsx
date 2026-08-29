"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CircleAlert, House, RotateCw } from "lucide-react";

/** 路由级错误页（Next 16 约定：{ error, retry }），对标 open-ai-canvas route-error */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <CircleAlert className="h-10 w-10 text-danger" />
      <div>
        <h1 className="font-editorial text-lg font-semibold text-text">
          页面出错了
        </h1>
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-text-3">
          {error.message || "发生了意外错误，当前内容不会被覆盖。"}
          {error.digest ? (
            <span className="ml-1 text-text-4">（{error.digest}）</span>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={retry}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
        >
          <RotateCw className="h-3.5 w-3.5" />
          重试
        </button>
        <Link
          href="/"
          className="flex items-center gap-1.5 rounded-md border border-hairline px-3.5 py-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <House className="h-3.5 w-3.5" />
          回主页
        </Link>
      </div>
    </div>
  );
}
