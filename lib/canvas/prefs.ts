"use client";

/**
 * 画布视图偏好（小地图 / 网格吸附 / 连线显隐）：
 * 纯设备本地 UI 偏好，存 localStorage，不进画布数据——服务端画布 JSON
 * 只存内容事实源，显示开关属于「看的人」而非「画布本身」。
 * 自建轻量 external store：CanvasView 消费渲染态，CanvasShortcuts
 * 直调 get/set 做快捷键切换。
 */

import { useCallback, useSyncExternalStore } from "react";

export type CanvasPrefKey = "minimap" | "snap" | "edges";

const STORAGE_KEY = "wingsight_canvas_prefs";

const DEFAULTS: Record<CanvasPrefKey, boolean> = {
  minimap: true,
  snap: true,
  edges: true,
};

let prefs: Record<CanvasPrefKey, boolean> = { ...DEFAULTS };
const listeners = new Set<() => void>();
let loaded = false;

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Record<CanvasPrefKey, unknown>>;
    for (const k of Object.keys(DEFAULTS) as CanvasPrefKey[]) {
      if (typeof parsed[k] === "boolean") prefs[k] = parsed[k];
    }
  } catch {
    /* 数据损坏按默认值 */
  }
}

export function getCanvasPref(k: CanvasPrefKey): boolean {
  load();
  return prefs[k];
}

export function setCanvasPref(k: CanvasPrefKey, v: boolean): void {
  load();
  if (prefs[k] === v) return;
  prefs = { ...prefs, [k]: v };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式等写失败不阻塞 */
  }
  listeners.forEach((l) => l());
}

/** SSR 返回默认值（水合安全），客户端水合完成后切到本地快照 */
export function useCanvasPref(k: CanvasPrefKey): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => getCanvasPref(k),
    () => DEFAULTS[k],
  );
  const set = useCallback((v: boolean) => setCanvasPref(k, v), [k]);
  return [value, set];
}
