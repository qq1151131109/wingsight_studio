/**
 * 操作埋点（自托管 /api/v1/events，产品数据分析用）：
 *  - `trackEvent(name, props?)` 编程式上报（非点击流程也可用）
 *  - 按钮埋点走 `data-track="area.action"` 属性 + 全局点击捕获
 *    （components/telemetry/TelemetryListener），按钮各自零接线
 * 只记事件名与粗粒度属性（nodeType/kind 等），**绝不记正文/提示词内容**。
 * fire-and-forget：keepalive fetch、失败静默——分析数据永远不阻塞产品、
 * 不因 401 触发登录跳转（绕开 apiFetch 的 401 重定向副作用）。
 */

import { authHeaders } from "@/lib/auth";
import { useCanvasStore } from "@/lib/canvas/store";

export function trackEvent(name: string, props?: Record<string, unknown>) {
  if (typeof window === "undefined" || !name) return;
  const projectId = useCanvasStore.getState().projectId ?? undefined;
  try {
    void fetch("/api/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        name: name.slice(0, 120),
        project_id: projectId,
        ...(props ? { props } : {}),
      }),
    }).catch(() => undefined);
  } catch {
    /* 埋点永不抛错 */
  }
}
