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

/** 分镜表某行的"出图"→ 桥接层转成聊天指令，agent 生成后 update_row 回填 */
export const ROW_GENERATE_EVENT = "wingsight:row-generate";

export type RowGenerateDetail = {
  nodeId: string;
  rid: string;
  prompt: string;
  refIds: string[];
};

/** 拖媒体到生成输入面板=设为引用（PromptBar 监听） */
export const ADD_REF_EVENT = "wingsight:add-ref";

export type AddRefDetail = { nodeId: string };

/** 提示词库点选 → PromptBar 追加到输入框 */
export const PROMPT_PICK_EVENT = "wingsight:prompt-pick";

export type PromptPickDetail = { text: string };

/** 分镜表标注重绘 → 桥接层转聊天指令（原图+标注图双参考，只改标注区域） */
export const MASK_REDRAW_EVENT = "wingsight:mask-redraw";

export type MaskRedrawDetail = {
  nodeId: string;
  /** 标注合成图（红笔=要改的区域） */
  annotatedUrl: string;
  /** 原图 URL */
  originUrl: string;
  /** 想改什么的描述 */
  prompt: string;
};
