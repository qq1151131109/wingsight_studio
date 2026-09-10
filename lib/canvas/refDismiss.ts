"use client";

/**
 * 参考卡删除 → 服务端取消采纳（2026-09-10）。
 *
 * 语义：删掉一张考据参考卡 = 这张参考不要了——不再作为出图参考（连线随之删掉，
 * 本来就不会再被带上），**也不再被对账物化成卡**。没有这一步的话对账只认
 * 「这张图 URL 有没有卡」，分不清「用户删过」与「从没建过」，删了下次打开项目
 * 又长回来。
 *
 * 为什么走注册钩子而不是直接调接口：`lib/canvas/store.ts` 只管画布状态、不碰
 * 网络（持久化归 ProjectManager），而这个副作用必须挂在删除的唯一入口
 * `store.deleteNodes` 上（工具条删除 / 键盘 Delete / 批量删都走它，逐个 UI 路径
 * 挂钩必漏）。所以 store 只广播「哪些参考卡被删了」，由常挂载的 TaskEvents
 * 注册实际处理。载荷用结构化类型，避免 store ↔ 本模块的 import 环。
 */

export type DroppedRefCard = {
  /** 服务端候选 id（卡片数据 refCandidateId） */
  candidateId: string;
  /** 该参考卡连着的资产卡（采纳归属；连线缺失则无法取消采纳） */
  assetNodeId: string;
};

type Sink = (drops: DroppedRefCard[]) => void;

let sink: Sink | null = null;

/** 注册处理器（返回注销函数）。同一时刻只有一个消费者：常挂载的 TaskEvents。 */
export function onRefCardsDeleted(fn: Sink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/** store.deleteNodes 调用：把被删的参考卡播给处理器（fire-and-forget） */
export function notifyRefCardsDeleted(drops: DroppedRefCard[]): void {
  if (!drops.length) return;
  try {
    sink?.(drops);
  } catch (err) {
    console.warn("[参考卡] 取消采纳失败（服务端仍在采纳态，下次打开可能重建）", err);
  }
}
