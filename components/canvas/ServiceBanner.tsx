"use client";

/**
 * 画布服务健康横幅（对标 Storyboard-Copilot MissingApiKeyHint 的"直达修复"模式）：
 * agent 服务不可达时顶部横幅提示，附启动命令；可本次会话内关闭。
 */

import { useEffect, useState } from "react";
import { CircleAlert, X } from "lucide-react";

const DISMISS_KEY = "wingsight:svc-banner-dismissed";

export default function ServiceBanner() {
  const [down, setDown] = useState(false);
  const [dismissed, setDismissed] = useState(
    () =>
      typeof window !== "undefined" &&
      sessionStorage.getItem(DISMISS_KEY) === "1",
  );

  useEffect(() => {
    let alive = true;
    const check = () =>
      void fetch("/agent-service/healthz", { cache: "no-store" })
        .then((r) => {
          if (alive) setDown(!r.ok);
        })
        .catch(() => {
          if (alive) setDown(true);
        });
    check();
    const t = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!down || dismissed) return null;
  return (
    <div className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger shadow">
      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
      <span>助手服务未连接——生成与聊天不可用，画布仍可编辑</span>
      <code className="rounded bg-surface-1 px-1 py-0.5 text-[10px] text-text-3">
        ./start_wingsight.sh start
      </code>
      <button
        type="button"
        title="本次会话不再提示"
        className="rounded p-0.5 hover:bg-danger/20"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
