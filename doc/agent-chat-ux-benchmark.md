# Agent 对话体验对标：竞品拆解与差距梳理

> 2026-09-02 盘点。方法：本项目代码实查（含未提交改动）+ `references/` 下 8 个竞品源码扫描，所有结论带文件路径证据。
> 用途：聊天下一轮优化（P0/P1/P2）的决策输入。现状盘点另一份沉淀在会话记忆 `wingsight-chat-ux-review`。

---

## 0. TL;DR

- 我们的前两轮打磨把**基础盘**做齐了：持久化、多会话、@引用、附件、进度消息、审批、建议 chips 都在且能跑。
- 但当前存在 **4 个真 bug 级断链**（工具白名单矛盾、会话记忆串台、停止不取消后端、切会话竞态），属于"先修才能谈体验"。
- 与竞品的差距不在单点功能，而在**消息流的结构化**：竞品把聊天流做成"消息 / 工具卡 / 审批卡 / 计划卡 / 任务面板"的分型 feed，我们仍是"纯文本消息 + 一个 canvas_ops 自定义卡"，其余 6 个后端工具全走 stock 默认渲染。

---

## 1. 我们现状盘点（截至 2026-09-02）

### 1.1 已落地能力

| 能力 | 位置 |
|---|---|
| 聊天持久化 + 多会话（SQLite chat_threads/chat_messages） | `agent/projects.py:63-76,408-545`、`components/copilot/ChatPersistence.tsx` |
| 会话搜索 / 导出 md | `components/copilot/ThreadsBar.tsx:48-80,181-188` |
| 后端工具进度消息（progress_ 前缀，不落库） | `agent/skills.py:920-937`、`agent/graph.py:63,79`、逐张出图播报 `skills.py:883,911` |
| 空态建议 chips（写死 4 条，仅空会话显示） | `components/copilot/Sidebar.tsx:69-110` |
| 输入框 @画布卡引用（token 存节点 id、chip 点击定位） | `ChatInput.tsx:385-404`、`components/canvas/MentionInput.tsx` |
| /slash 技能菜单 | `ChatInput.tsx:37-44,134-160,450-484` |
| 图片/文档附件（≤6 个、文本 ≤64KB 内联、拖放+粘贴） | `ChatInput.tsx:172-217,318-325,376-383` |
| 破坏性操作审批（原生 confirm 弹窗，Promise 阻塞） | `components/copilot/CanvasAgentBridge.tsx:787-805,936-974` |
| 失败消息重试本轮 | `Sidebar.tsx:24-45` |
| canvas_ops 结果缩略图回显 + 点击定位画布 | `CanvasAgentBridge.tsx:892-930` |
| 工具卡耗时显示 | `CanvasAgentBridge.tsx:807-809,876-883` |
| 停止按钮（**仅掐客户端 run**） | `ChatInput.tsx:416-424` |
| 夜间模式、IME 安全输入、复制、重新生成（stock） | `Sidebar.tsx`、`MentionInput.tsx:543-579` |

### 1.2 真 bug（进入优化前必须先修）

| # | 问题 | 证据 |
|---|---|---|
| B1 | **read_node 断链**：系统提示两处让模型调 `read_node`，但 `FRONTEND_TOOL_ALLOWLIST={"canvas_ops"}` 在 bind_tools 时把它滤掉，模型拿不到 schema、照提示调用必失败 | `agent/graph.py:244` vs `graph.py:440,453`；前端已注册 `CanvasAgentBridge.tsx:415` |
| B2 | **会话与模型记忆串台**：UI threadId（`lib/chat/session.ts`）从未传给 `<CopilotKit>`；ag-ui 按 thread_id 存 LangGraph checkpoint 且消息去重后追加 → 「新会话」只清 UI、模型带旧会话记忆；切历史会话也不恢复对应 checkpoint | `app/agent-provider.tsx:29`（无 threadId prop）；`agent/graph.py:649-705` |
| B3 | **停止只掐客户端**：聊天触发的 `generate_asset_images` 后端循环继续烧钱跑完；聊天工具链路无取消端点（对照分镜批量出图有 `DELETE /storyboard/images/{job}`） | `agent/main.py:574-579`（仅分镜有） |
| B4 | **运行中切会话竞态**：切会话不 abort 进行中 run，流式增量继续写已被替换的 messages，1.2s debounce 整表覆盖保存可能把 A 会话内容写进 B | `ThreadsBar.tsx:211-214`、`ChatPersistence.tsx:107-214` |

小 bug：导出 md 未 decode `WS_PARTS::` envelope，多模态消息导出成原始 JSON（`ThreadsBar.tsx:66`，envelope 编码在 `ChatPersistence.tsx:44-46`）；点赞点踩是 CopilotKit stock 纯前端 state，无后端落库。

---

## 2. 竞品逐家拆解

### 2.1 open-storyboard-canvas —— 最完整的 agent feed 范式 ⭐ 头号对标

位置：`references/open-storyboard-canvas/src/features/canvas/agent/`

- **结构化消息流**：`ui/agentPanelStore.ts` 把 feed item 分 7 型——message / reasoning / tool / approval / plan / skill / status，每型有专属卡片渲染。
- **工具级回滚**：tool item 带 `receiptId` + `rollbackToken`，单次工具调用可单独回滚（`application/agentCanvasRollback.ts`、`ui/AgentFeedCard.tsx`），不是全画布 undo。
- **审批卡**：`application/agentApproval.ts` 按影响分级（read / canvas-write / config-write / external-submit），卡片带**影响摘要**（动几个节点几条边、预估成本与时长、置信度）、过期时间、审批台账持久化；ApprovalCard 内联批准/拒绝，还能现场调预算上限。
- **计划卡**：`application/agentPlan.ts`——agent 先出计划 → 计划**可编辑修订** → 确认/取消后才执行。
- **画布定位双向**：`ui/agentFeedProjection.ts` 从工具输出提取 input/result 节点 id，工具卡上直接给「定位输入」「定位结果」两个按钮。
- **任务面板 + 断点恢复**：`ui/GenerationTasksPanel.tsx` 独立任务列表，失败任务 `recoverPersistedGenerationResult` 恢复落卡。
- **错误恢复**：失败消息带「恢复草稿重发」+ 诊断包下载（`agentDiagnostics.ts`）；`agentBudget.ts` 做步数/成本预算。
- **会话与 composer**：多会话持久化（`infrastructure/agentSessionRepository.ts`）；Dock 三视图 conversation / history / tasks；输入框显示上下文 token 估算；manual/auto 执行模式；中文 IME Enter 防误发（`shouldSubmitCanvasAgentComposerEnter`）。

### 2.2 open-ai-canvas —— 输入交互与撤销体系 ⭐ 次级对标

位置：`references/open-ai-canvas/web/src/components/canvas/`

- **输入**：slash 技能菜单（选中替换为 `@[skill:id]` token，同我们）；@ mention 芯片高亮，支持**文件拖到芯片上替换**（`canvas-resource-mention-textarea.tsx`）；图片粘贴；语音输入（`conversation/voice-recording-button.tsx`）。
- **assistant 文本自动变 chips**：`canvas-agent-chat-ui.tsx` 从助手回复里提取可点击的快捷选项。
- **审批/工具卡**：AgentPendingToolCard 审批卡带影响指标（操作/节点/删除/生成计数）+ `<details>` 技术详情折叠；完成的 AgentToolCard 同样可折叠看 JSON 详情。
- **撤销体系**：`canvas-assistant-panel.tsx`——ops 写回前 snapshot + validate + postcondition 校验，**按批撤销**（工具栏显示可撤销批数）；读写工具白名单分流。
- **断点恢复**：cinematic 会话 durable-ack（`lib/canvas/canvas-agent-session.ts`）。
- **多任务**：`canvas-active-task-panel.tsx` 并行任务进度、可取消。
- **落画布**：`canvas_apply_ops` / `canvas_create_workflow` 一步生成节点+连线。

### 2.3 novanova-studio —— 状态机与思考流

位置：`references/novanova-studio/web/src/features/`

- **SSE 状态机**：`canvas/hooks/use-agent-sse.ts` 断线重连 + 迟到事件按 requestId 幂等匹配；队列状态机 `queued→running 不回退`（`chat/agent-event-match.ts`）；`cancelAgentChat` 真取消。
- **思考流**：`chat/use-agent-thinking.ts` 思考块 reducer（delta/complete/耗时），`ThinkingBlock` 折叠组件。
- **计划执行**：计划卡（onPlanCreated）+ **任务逐项打勾**（onPlanTaskStatus）+ 提示词优化策略 meta（`canvas/pages/canvas-client-page.tsx`）。
- **画布→聊天拖拽**：画布节点**拖进聊天**成为引用（`canvas/components/canvas-chat-panel.tsx`）；GenerationStyleChips 风格多选。
- **消息聚合**：消息按角色分组聚合（`domain/canvas-agent-message.ts`）；`generation/components/agent-activity-timeline.tsx` 步骤状态时间线。

### 2.4 ai-moive-studio —— interrupt 审批与工具聚合（Vue）

位置：`references/ai-moive-studio/frontend/src/components/canvas/assistant/`

- `CanvasAssistantTimeline.vue` 事件时间线，rAF 节流打字机。
- `CanvasAssistantConfirmationCard.vue` interrupt 审批卡，**卡内可选执行模型**再确认。
- `CanvasAssistantToolSummary.vue` 工具调用聚合卡：实时 thinking buffer + 「执行中 N」徽标；流式/待确认期间禁发。

### 2.5 viedeo-workflow —— 双模式与消息级操作

位置：`references/viedeo-workflow/src/components/`

- `ChatPanel.tsx` / `ChatMessage.tsx` / `hooks/useAgentChat.ts`。
- Chat / Agent 双模式切换；SSE 事件分型（thinking / tool_start / tool_result / actions / done）。
- 工具卡图标 + 中文标签映射（canvas_query→「查看画布状态」）。
- 画布图片/视频节点拖入聊天；历史会话列表/加载/删除。
- 消息级「重新发送」；图片消息一键「从该 prompt 生成」。

### 2.6 其余三家

- **Storyboard-Copilot**：无 agent/chat 目录，是 open-storyboard-canvas 的无 agent 基线版，可作"加 agent 前后"对照。
- **OpenLovart**：仅示例卡片点击发送 + 非流式 + 兜底文案，无流式无画布联动——**反面教材**。
- **AIGCCanvasFlow**：h5 无聊天组件，agent 逻辑在 Java 后端——聊天体验缺失。

---

## 3. 跨项目共性基线（"该有"清单）

多数竞品都有、属于结构化 agent 产品的底线能力：

| # | 能力 | 我们 |
|---|---|---|
| G1 | 消息流分型：message / tool / approval / plan / status 各有专属卡 | ❌ 仅 canvas_ops 一张自定义卡，6 个后端工具走 stock 默认 |
| G2 | 工具卡可展开看参数/结果 JSON 详情 | ❌ 无 |
| G3 | 审批内联聊天流（非原生 confirm）+ 影响摘要 | ❌ 原生 confirm，且只盖删卡/成组（`CanvasAgentBridge.tsx:788-790`），整卡覆写不审 |
| G4 | 错误消息人话化 + 重试/恢复草稿 | ⚠️ 有重试按钮，但错误原文裸甩（`Sidebar.tsx:30`） |
| G5 | 工具执行状态实时可见（执行中/成功/失败） | ⚠️ 只有 canvas_ops 卡 + progress 文本消息 |
| G6 | 结果自动写回画布 + 可撤销 | ⚠️ 有写回，只有全画布 undo，无按批/按工具撤销 |
| G7 | 流式 markdown + 打字中指示 | ⚠️ 有流式，无打字光标/动画 |
| G8 | @引用画布资源 | ✅ 已做（且 chip 点击定位领先多数竞品） |
| G9 | 多会话 + 历史 + 新建 | ✅ 已做（含搜索/导出，领先） |
| G10 | 画布上下文自动注入 | ✅ 已做（但一轮注入 3 份，token 浪费） |

结论：G8/G9 我们领先，**G1-G6 是主差距**。

## 4. 独有亮点（差异化借鉴候选）

- open-storyboard-canvas：工具级 rollbackToken、审批影响摘要/成本预估/过期、计划可编辑、生成任务断点恢复面板、预算控制、诊断包、token 估算、「定位输入/定位结果」双按钮。
- open-ai-canvas：按批撤销、ops postcondition 校验、语音输入、durable-ack 恢复、assistant 文本自动变 chips、语音输入。
- novanova：SSE 重连 + requestId 幂等、队列状态机、思考流 reducer、**画布节点拖入聊天**、风格 chips。
- ai-moive-studio：审批卡内选执行模型。
- viedeo-workflow：Chat/Agent 双模式、消息级重发、图片「从该 prompt 生成」。

---

## 5. 差距对照总表

按体验维度归拢（✅=有，⚠️=半吊子，❌=无）：

### 5.1 消息流渲染
| 项 | 竞品 | 我们 |
|---|---|---|
| 工具卡分型渲染 | ✅ 全员 | ❌ 后端工具全 stock 默认；read_node 静默无卡（B1） |
| 工具卡折叠看详情 | ✅ open-ai-canvas 等 | ❌ |
| 思考/推理展示（流式+折叠） | ✅ novanova / open-storyboard | ❌ |
| 打字中指示 | ✅ open-ai-canvas「正在推演」/ ai-moive 打字机 | ❌ 只有三点 activityIcon |
| 进度聚合成任务卡 | ✅ ai-moive「执行中 N」/ 多家任务面板 | ❌ progress 文本逐条刷屏（30 张图=30 条消息） |
| 消息级时间戳 | 部分有 | ❌（DB 有 created_at，前端不显示） |
| 消息编辑/分支/重发 | ✅ viedeo-workflow 消息级重发 | ❌ |

### 5.2 任务执行模型
| 项 | 竞品 | 我们 |
|---|---|---|
| 计划先行可编辑 + 逐项打勾 | ✅ open-storyboard / novanova | ❌ |
| 审批内联 + 影响摘要/成本预估 | ✅ open-storyboard / open-ai-canvas | ⚠️ 原生 confirm、覆盖窄 |
| 运行中继续输入 / 排队 | ✅ 多家 | ❌ inProgress 禁发（`ChatInput.tsx:231`） |
| 真取消（后端停） | ✅ novanova cancel / open-ai-canvas 任务可取消 | ❌ B3 |
| 断点恢复在聊天/任务面板呈现 | ✅ open-storyboard GenerationTasksPanel | ⚠️ 分镜出图有恢复，聊天链路无 |
| 步数/成本预算 | ✅ open-storyboard agentBudget | ❌ |

### 5.3 画布↔聊天联动
| 项 | 竞品 | 我们 |
|---|---|---|
| 聊天→画布定位 | ✅ | ✅ FOCUS_NODES（领先） |
| 工具卡「定位输入/定位结果」双按钮 | ✅ open-storyboard | ❌ 只有结果定位 |
| 画布节点**拖进**聊天成引用 | ✅ novanova / viedeo-workflow | ❌ 只有 @ 菜单选择 |
| 聊天内图片放大/下载/重生成 | ✅ viedeo-workflow「从该 prompt 生成」 | ❌ 只能点击定位（Lightbox 仅画布） |
| 工具级/按批回滚 | ✅ open-storyboard / open-ai-canvas | ❌ 全画布 undo |

### 5.4 会话与输入
| 项 | 竞品 | 我们 |
|---|---|---|
| 会话 id 贯通模型侧记忆 | ✅（各家会话隔离正常） | ❌ B2 串台 |
| 会话重命名体验 | — | ⚠️ window.prompt 风格割裂 |
| 上下文 token 估算显示 | ✅ open-storyboard | ❌ |
| 语音输入 | ✅ open-ai-canvas | ❌ |
| assistant 文本自动变选项 chips | ✅ open-ai-canvas | ❌（空态写死 4 条） |
| 风格/参数 chips 在聊天内多选 | ✅ novanova | ⚠️ 画风只有全局坞一处 |

### 5.5 错误恢复
| 项 | 竞品 | 我们 |
|---|---|---|
| 错误人话化 | ✅ | ❌ 原文 slice(160) 裸甩 |
| 恢复草稿重发 / 诊断包 | ✅ open-storyboard | ❌ |
| 幂等/断线重连 | ✅ novanova SSE | ⚠️ ag-ui 自带流，无重连保障 |

---

## 6. 优化路线草案（供讨论）

### P0 —— 修 bug（小改动，先恢复信任）
1. read_node 白名单矛盾：`FRONTEND_TOOL_ALLOWLIST` 补 read_node，或删提示词两处（B1）。
2. threadId 接入 `<CopilotKit>`，会话切换/新建贯通 LangGraph checkpoint（B2）。
3. 聊天工具链路加后端取消端点，停止按钮透传（B3）。
4. 切会话 abort 进行中 run + 保存竞态防护（B4）。
5. 导出 md decode `WS_PARTS::`（5 分钟级）。

### P1 —— 体验补课（不动架构，复用现有消息通道）
1. 错误人话化映射表 +「重试」保留。
2. 进度消息聚合：同任务 progress 合并为一张动态更新的进度卡（可先从出图链路做起）。
3. 审批覆盖扩大：整卡 body 覆写（AI 重写剧本/分镜卡）纳入确认。
4. 聊天内图片接 Lightbox（放大/下载，动作区沿用画布灯箱注入模式）。
5. 上下文去重：canvasSummary 三处注入收敛为一处。
6. 会话重命名换成对话框；多行输入、发送后气泡渲染成 chip 样式。

### P2 —— 结构化 feed（单独立项，对标 open-storyboard-canvas）
> **进度 2026-09-02：第 1、3 项已落地第一层**——`components/copilot/toolCards.tsx`：6 个后端工具
> 注册 render-only action（`available:"disabled"`，框架按工具名拦截 stock 渲染）分型成卡；
> read_node 从静默变卡片；canvas_ops 破坏性操作审批从原生 confirm 换成聊天流内联审批卡
> （zustand store 驱动，聊天消息列表不需重渲染也能出现/点击）。E2E：`scripts/chat-tool-cards-test.mjs`。
> 落地中发现并修复：聊天输入打字不触发 onChange（MentionInput 提取时丢了 onInput→emitChange
> 链路，发送按钮/Enter 全体失灵，画布面板 PromptBar 同病）——onInput 非 IME 组合时补 emitChange。

1. 消息流分型：tool/approval/plan/status 卡片体系，工具卡折叠看详情（✅ 后端工具+审批已做；plan/status 未做）
2. 计划先行：拆解/批量出图类任务先出计划卡确认再执行，逐项打勾。
3. 审批卡内联化 + 影响摘要（✅ 已内联；影响摘要有人话描述，成本/时长预估未做）
4. 任务面板：长任务独立面板、并行展示、可取消、断点恢复入口。
5. 思考透传：V4 思考模式 + AG-UI ReasoningMessage 事件族已在协议层，缺 UI（novanova ThinkingBlock 范式或 v2 折叠组件）。
6. 画布节点拖进聊天、工具卡「定位输入/定位结果」双按钮。
7. 工具级回滚 / 按批撤销（依赖 ops snapshot 体系，参考 open-ai-canvas postcondition 校验）。

### 明确不做（本轮结论）
- OpenLovart 式的非流式聊天；消息级分支编辑（CopilotKit v1 下成本高，先做重发）；语音输入（优先级最低）。

---

## 附：我们的相对优势（保持并继续放大）

- @引用 chip 体系：token 存节点 id、点击定位、改名/删除实时同步——比 open-ai-canvas 的文本 token 更稳。
- 多会话 + 搜索 + 导出 md，会话管理完整度高于全部竞品。
- 附件全链路（多模态 parts → 非视觉模型降级 URL 清单）已实测可用。
- 分镜批量出图的断点恢复/补缺图——聊天链路的任务面板（P2-4）可以直接复用这套 job 机制。
