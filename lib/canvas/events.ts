/** 画布进程内 UI 事件（卡片 ↔ 画布视图 ↔ agent 桥之间解耦用） */

/** 让视口聚焦到指定节点（平移/缩放到可见）：agent 建卡后、卡片"+"建下游卡后触发 */
export const FOCUS_NODES_EVENT = "wingsight:focus-nodes";

export type FocusNodesDetail = { ids: string[] };
