/** 画布进程内 UI 事件（卡片 ↔ 画布视图 ↔ agent 桥之间解耦用） */

/** 让视口聚焦到指定节点（平移/缩放到可见）：agent 建卡后、卡片"+"建下游卡后触发 */
export const FOCUS_NODES_EVENT = "wingsight:focus-nodes";

export type FocusNodesDetail = { ids: string[] };

/** 调研卡轮询观察到任务进入终态（完成/失败/中断/取消）。AG-UI 会话没有
 *  服务端主动推送通道，后台调研任务跑完不会唤醒 agent 说话——由前端轮询
 *  发现终态后广播，通知桥（ResearchNotice）插聊天瞬时消息 + 浮条动作 */
export const RESEARCH_TERMINAL_EVENT = "wingsight:research-terminal";

export type ResearchTerminalDetail = {
  nodeId: string;
  jobId: string;
  title: string;
  status: "done" | "error" | "interrupted" | "stopped";
  error: string;
  sourcesCount: number;
  findingsCount: number;
};

/** 请求打开某调研卡的卷宗阅读器（通知浮条「查看卷宗」动作用） */
export const OPEN_RESEARCH_READER_EVENT = "wingsight:open-research-reader";

export type OpenResearchReaderDetail = { nodeId: string };

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

/** 远程聚焦编辑：让指定文本卡正文进入编辑态（novanova 的 onEditText
 *  通道——agent 建卡后命令浏览器聚焦，未来任何外部触发都可复用）。
 *  常驻编辑（Editable always）下语义 = 把光标移入新卡正文 */
export const FOCUS_EDIT_EVENT = "wingsight:focus-edit";

export type FocusEditDetail = { nodeId: string };

export const dispatchFocusEdit = (nodeId: string) => {
  // 必须等一拍：建卡路径里本函数在 React 提交新节点前被调用，卡上的
  // FOCUS_EDIT 监听器尚未挂载，同步发事件会丢
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent<FocusEditDetail>(FOCUS_EDIT_EVENT, {
        detail: { nodeId },
      }),
    );
  }, 0);
};

/** 请求打开节点信息弹窗（卡片悬浮工具条 → CanvasView 的 infoNode 状态） */
export const NODE_INFO_EVENT = "wingsight:node-info";

export type NodeInfoDetail = { nodeId: string };

/** 拖媒体到生成输入面板=设为引用（PromptBar 监听） */
export const ADD_REF_EVENT = "wingsight:add-ref";

export type AddRefDetail = { nodeId: string };

/** 提示词库点选 → PromptBar 追加到输入框 */
export const PROMPT_PICK_EVENT = "wingsight:prompt-pick";

export type PromptPickDetail = { text: string };

/** 画风闸拦截（出图类操作未选画风）→ 请求打开底部坞「项目画风」弹窗：
 *  与其让用户找底坞入口，不如拦下的同时把设定弹窗递到眼前 */
export const OPEN_STYLE_EVENT = "wingsight:open-style";

/** 底部坞「快捷键」按钮 → 打开快捷键速查表（ShortcutsModal 自听） */
export const OPEN_SHORTCUTS_EVENT = "wingsight:open-shortcuts";

/** 聊天侧栏「助手能力」按钮 → 打开能力面板（CapabilitiesDialog 自听） */
export const OPEN_CAPABILITIES_EVENT = "wingsight:open-capabilities";

/** 能力面板点了示例/技能 → 往聊天输入条插入文本（ChatInput 自听；
 *  detail.text 必填，插入后自动聚焦输入条） */
export const CHAT_INSERT_TEXT_EVENT = "wingsight:chat-insert-text";

export type ChatInsertTextDetail = { text: string };

/** 用户消息编辑重发（UserBubble 铅笔 → ChatInput 自听）：detail 带被编辑
 *  消息 id 与原文；输入条进入编辑态，提交时截断该消息之后的历史再重发 */
export const CHAT_EDIT_MESSAGE_EVENT = "wingsight:chat-edit-message";

export type ChatEditMessageDetail = { id: string; text: string };

/** Tab 键（CanvasShortcuts）→ 在视口中央打开「添加节点」选择器，
 *  与双击空白共用 CanvasView 的 ctxMenu(kind=add) */
export const OPEN_ADD_MENU_EVENT = "wingsight:open-add-menu";

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

/** 图片节点操作（doc/image-node-ops-spec.md）：右键菜单 → 全局单例弹窗
 *  （ImageToolDialogs 挂 CanvasView，任何卡类型都能触发，弹窗自读 store）。
 *  裁剪=原位替换+旧图入版本档；模板四件=建空卡+连线后对新卡 GENERATE_EVENT */
export const IMAGE_TOOL_EVENT = "wingsight:image-tool";

export type ImageToolDetail = {
  nodeId: string;
  tool: "crop" | "multiview" | "turnaround" | "lighting" | "texture";
};
