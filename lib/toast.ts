"use client";

/** 极简全局 toast：模块级发布订阅，ToastHost 在 layout 挂载一次。
 *  给「必须让用户看见的失败」用（上传失败等），调用 showToast 即可，
 *  无需任何组件接线。 */

export interface ToastItem {
  id: number;
  text: string;
}

let seq = 0;
const listeners = new Set<(t: ToastItem) => void>();

export function onToast(fn: (t: ToastItem) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function showToast(text: string): void {
  const item: ToastItem = { id: ++seq, text };
  for (const fn of listeners) fn(item);
}
