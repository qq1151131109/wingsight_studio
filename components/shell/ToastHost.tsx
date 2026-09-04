"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle } from "lucide-react";
import { onToast, type ToastItem } from "@/lib/toast";
import { useMounted } from "@/lib/use-mounted";

/** 全局 toast 宿主（layout 挂载，portal 到 body）：底部居中，4 秒自动消失。 */
export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const mounted = useMounted();

  useEffect(
    () =>
      onToast((t) => {
        setItems((prev) => [...prev.slice(-3), t]);
        setTimeout(
          () => setItems((prev) => prev.filter((x) => x.id !== t.id)),
          4000,
        );
      }),
    [],
  );

  if (!mounted) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[1250] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <p
          key={t.id}
          className="flex items-center gap-1.5 rounded-lg border border-danger/40 bg-surface-1 px-3 py-2 text-xs text-danger shadow-lg"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {t.text}
        </p>
      ))}
    </div>,
    document.body,
  );
}
