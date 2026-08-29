/** 画布进程内 UI 事件（卡片 ↔ 画布视图 ↔ agent 桥之间解耦用） */

/** 让视口聚焦到指定节点（平移/缩放到可见）：agent 建卡后、卡片"+"建下游卡后触发 */
export const FOCUS_NODES_EVENT = "wingsight:focus-nodes";

export type FocusNodesDetail = { ids: string[] };

/** 视频卡"AI 拉片"→ 抽帧上传完成后发此事件，桥接层转成含帧 URL 的聊天指令 */
export const FRAME_ANALYSIS_EVENT = "wingsight:frame-analysis";

export type FrameAnalysisDetail = {
  nodeId: string;
  /** 等间隔抽帧上传后的资产 URL 与对应时间点（秒） */
  frames: { url: string; t: number }[];
};
