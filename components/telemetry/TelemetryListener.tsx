"use client";

/**
 * 全局点击埋点（capture 阶段）：点按任意带 `data-track="area.action"` 的
 * 元素即上报一条事件，可选 `data-track-props='{"kind":"image"}'` 附加粗粒度
 * 属性。按钮各自零接线——以后新按钮想进统计，加一个属性就行。
 * 不拦不阻断：埋点失败对产品零影响（见 lib/telemetry）。
 */

import { useEffect } from "react";
import { trackEvent } from "@/lib/telemetry";

export default function TelemetryListener() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        "[data-track]",
      ) as HTMLElement | null;
      if (!el) return;
      const name = el.dataset.track;
      if (!name) return;
      let props: Record<string, unknown> | undefined;
      const raw = el.dataset.trackProps;
      if (raw) {
        try {
          props = JSON.parse(raw);
        } catch {
          /* 非法 JSON 忽略属性 */
        }
      }
      trackEvent(name, props);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
