"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle } from "lucide-react";
import { onToast, type ToastItem } from "@/lib/toast";
import { useMounted } from "@/lib/use-mounted";

/** Toast 存活时长与退场时长（毫秒）：退场动画跑完才真从数组里摘掉 */
const TOAST_TTL_MS = 4000;
const TOAST_EXIT_MS = 150;

/** 全局 toast 宿主（layout 挂载，portal 到 body）：底部居中，4 秒后下沉淡出。
 *  入场/退场动画在 globals.css（.ws-toast-in / .ws-toast-out），走 prefers-reduced-motion
 *  时被全局钳制成瞬切。 */
export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  /** 正在退场的 toast id：先挂 .ws-toast-out 播动画，再真删 */
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const mounted = useMounted();

  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const off = onToast((t) => {
      if (!alive) return;
      setItems((prev) => [...prev.slice(-3), t]);
      timers.push(
        setTimeout(() => {
          setLeaving((prev) => new Set(prev).add(t.id));
          timers.push(
            setTimeout(() => {
              setItems((prev) => prev.filter((x) => x.id !== t.id));
              setLeaving((prev) => {
                const next = new Set(prev);
                next.delete(t.id);
                return next;
              });
            }, TOAST_EXIT_MS),
          );
        }, TOAST_TTL_MS),
      );
    });
    return () => {
      alive = false;
      off();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  if (!mounted) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[1250] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <p
          key={t.id}
          className={`flex items-center gap-1.5 rounded-lg border border-danger/40 bg-surface-1 px-3 py-2 text-xs text-danger shadow-lg ${
            leaving.has(t.id) ? "ws-toast-out" : "ws-toast-in"
          }`}
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {t.text}
        </p>
      ))}
    </div>,
    document.body,
  );
}
