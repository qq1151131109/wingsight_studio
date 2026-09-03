# Agent 对话体验对标：竞品拆解与差距梳理

> 2026-09-02 盘点并落地第一轮优化。方法：本项目代码实查 + `references/` 下 8 个竞品源码扫描，所有结论带文件路径证据。
> **落地状态（同日晚）**：P0 五项全修、P1 四项落地、P2 第一层（工具卡分型 + 审批内联）落地，E2E `scripts/chat-tool-cards-test.mjs` 全绿。文中所有状态标记已刷新到落地后；带 ✅ 的同时给出实现位置。
> 决策过程沉淀在会话记忆 `wingsight-chat-ux-review`（含 CopilotKit v1.69.3 的 API 事实，改聊天前先读）。
>
> **2026-09-03 UI 壳换代（v2 官方组件）**：经竞品调研（deer-flow / open-ai-canvas 的自研消息层最值得抄，但无人直接用 CopilotKit）与三条现成路对比（CopilotKit v2 UI / assistant-ui / Vercel AI Elements），选定 **CopilotKit v2 官方 UI**（同包 `/v2` subpath，license 实测无门控）整体换壳——消息渲染（Streamdown 流式 markdown + 代码高亮 + CJK）、消息工具栏（复制/重试/赞踩，悬浮浮现）、思考折叠、打字光标全部用官方内置。自研面只剩 slot：header=ThreadsBar、input=ChatInput（@引用/附件/任务条/思考条）、suggestionView=空态 chips、toggleButton=关闭态 FAB。**v1 数据层零改动**：`useCopilotAction`（render→v2 renderToolCalls 注册表、handler→useFrontendTool）经官方兼容层继续工作，工具卡/计划卡/审批卡原样可见。同时修掉 4 个连锁坑：① v1 `react-ui/styles.css` 与 v2 类名冲突把侧栏压成 opacity:0（layout.tsx 摘除，输入区样式在 globals 自给）；② Turbopack 与包内 cpk: 工具类层叠不稳，侧栏骨架/主题变量在 globals 用 !important 自给（`aside.copilotKitSidebar` + `[data-copilotkit]` 语义变量映射米黄 token，夜间自动跟随）；③ v2 输入浮层整体 `pointer-events-none`，自绘输入容器必须自行恢复；④ 水合竞态——用户先开口时水合放弃却留下未水合标记，保存被永久闸死（ChatPersistence 已修，且消息源改订阅原始 agent 单例，绕开 useAgent 临时 agent 换真身的订阅失效）。顺带把 ChatInput/CanvasAgentBridge 的 `useCopilotChatHeadless_c`（license 门控桩，sendMessage 空操作）换成开源 `useCopilotChat`——多模态发送从静默失灵变为真正可用。agent 侧同日修：chat_node 改 `astream` 逐 token 聚合（此前 ainvoke 单发整段，打字机效果缺失）。注：旧记录里的"GLM 思考长尾"是错误归因——luna 实测不思考也不认 thinking 参数，首 token 前的沉默是 DMX 网关排队/冷启动延迟。E2E 全绿（canvas_ops/计划卡/任务条措辞已显式点名工具，避免 GLM 思考长尾与工具决策波动造成的假失败）。

---

## 0. TL;DR

- 前两轮打磨做齐了**基础盘**（持久化、多会话、@引用、附件、进度消息、建议 chips），本轮把 **4 个真 bug 断链**全部修掉（工具白名单矛盾、会话记忆串台、停止不取消后端、切会话竞态），并落地了与竞品差距最大的**结构化消息流第一层**：后端工具卡分型渲染 + 破坏性操作审批内联聊天流。
- 落地过程中揪出一个**更严重的潜伏回归**：聊天输入打字不触发 onChange（MentionInput 提取重构时丢失链路），发送按钮/Enter 完全失灵——已修。
- 剩余差距集中在 P2 后半：计划卡、任务面板、思考透传、工具级回滚、画布节点拖入聊天。

---

## 1. 我们现状盘点（2026-09-02 落地后）

### 1.1 已落地能力

| 能力 | 位置 |
|---|---|
| 聊天持久化 + 多会话（SQLite chat_threads/chat_messages） | `agent/projects.py`、`components/copilot/ChatPersistence.tsx` |
| 会话 id ↔ agent 记忆贯通（✅ 本轮）：UI threadId 直通 `<CopilotKit threadId>`（v1 官方 prop，内部 ThreadsProvider→agent.threadId），新会话现场铸造 id、首存时服务端同 id 建会话——**UI 会话 = LangGraph checkpoint，一一对应** | `lib/chat/session.ts`（agentThreadId）、`app/agent-provider.tsx`、`agent/projects.py` create_thread 收客户端 id |
| 真取消（✅ 本轮）：`POST /chat/cancel` 按 thread_id 取消在途后端工具（出图逐张 task、拆解/技能整工具任务，在途 http 中止不再计费）；停止按钮 / 切会话 / 删当前会话 / 切项目四处触发；出图批 `gather(return_exceptions)` 取消不炸整批 | `agent/skills.py` CHAT_RUN_TASKS、`agent/main.py`、`ChatInput.tsx`、`ThreadsBar.tsx` |
| 删会话连带清 agent checkpoint（adelete_thread） | `agent/main.py` api_delete_thread |
| 后端工具卡分型渲染（✅ 本轮 P2）：6 个 LangGraph 工具 render-only 注册（`available:"disabled"` 拦截 stock 灰盒）——出图卡带成败/取消计数 + 结果图缩略条、拆解/技能/调研/查进度状态卡、长文本 `<details>` 折叠 | `components/copilot/toolCards.tsx` |
| read_node 从静默变卡片（✅ 本轮 P2） | `CanvasAgentBridge.tsx` |
| 破坏性操作审批内联聊天流（✅ 本轮 P2）：原生 confirm → 审批卡（人话影响摘要 + 允许/拒绝），挂起请求走 zustand store | `toolCards.tsx` useToolApproval + `CanvasAgentBridge.tsx` CanvasOpsRunning |
| 聊天输入修复（✅ 本轮）：MentionInput onInput 非 IME 组合时回吐 onChange——此前发送按钮永不点亮、Enter 静默失败 | `components/canvas/MentionInput.tsx` |
| 错误人话化（✅ 本轮）：网络/登录/限流/超时/额度/5xx 映射，原文折叠"错误详情" | `Sidebar.tsx` friendlyError |
| 进度节流（✅ 本轮）：出图进度静默 ≥3s 或全部完成才播累计行（30 张图 ~31 条 → ~8 条） | `agent/skills.py` generate_asset_images |
| canvasSummary 注入收敛（✅ 本轮）：去掉末尾重复 SystemMessage，仅 system prompt 一份 | `agent/graph.py` chat_node |
| 导出 md 修复（✅ 本轮）：`WS_PARTS::` envelope 解码 + 多模态 parts 转可读 Markdown | `lib/chat/content.ts`、`ThreadsBar.tsx` |
| 会话搜索 / 导出 md | `components/copilot/ThreadsBar.tsx` |
| 后端工具进度消息（progress_ 前缀，不落库） | `agent/skills.py` _emit_progress |
| 空态建议 chips、@画布卡引用（chip 点击定位）、/slash 技能菜单、图片/文档附件（拖放+粘贴）、失败重试、canvas_ops 结果缩略图回显 + 定位、工具卡耗时、夜间模式、IME 安全输入 | `Sidebar.tsx` / `ChatInput.tsx` / `MentionInput.tsx` / `CanvasAgentBridge.tsx` |

### 1.2 本轮修复的 bug 台账

| # | 问题（原状） | 修法 |
|---|---|---|
| B1 | read_node 断链：系统提示两处让模型调用，但 `FRONTEND_TOOL_ALLOWLIST={"canvas_ops"}` 把它滤掉，调用必失败 | 白名单补 read_node（`agent/graph.py:385`） |
| B2 | 会话与模型记忆串台：UI threadId 从未接 CopilotKit，ag-ui 按内部单一 thread_id 存 checkpoint，「新会话」只清界面、模型带旧记忆 | threadId prop 直通 + 客户端铸造 id 两边同源（见 1.1） |
| B3 | 停止只掐客户端：`generate_asset_images` 后端循环继续烧钱 | CHAT_RUN_TASKS 注册表 + /chat/cancel（见 1.1） |
| B4 | 运行中切会话竞态：不 abort run，流式增量写已被换掉的 messages，保存可能把 A 会话内容写进 B | threadId 切换时框架自带 detach/abort + 前端 cancel 透传 + 水合前快照防覆盖 |
| B5 | 导出 md 把多模态消息导成 `WS_PARTS::` 原始 JSON | 编解码抽 `lib/chat/content.ts` 共享，导出走 contentToMarkdown |
| B6 | **聊天输入失灵（潜伏回归，落地 E2E 时发现）**：MentionInput 提取重构后 onInput 只更新 @ 触发器不回吐 onChange → lastRead 恒空 → 发送按钮禁用、Enter 被守卫静默拦截；画布 PromptBar 同病 | onInput 非 IME 组合时补 emitChange（`MentionInput.tsx`） |
| B7 | **长聊天流 ~30s 被掐（结构性，本-round 任务条 E2E 复现）**：Next 同源代理对上游 socket 的空闲超时（`experimental.proxyTimeout`，默认 30s）——拆解/技能 flow 中段静默期一过，SSE 流被 destroy（ERR_INCOMPLETE_CHUNKED_ENCODING / agent network error） | `next.config.ts` 设 `experimental.proxyTimeout: 600_000`；流式数据会重置空闲计时，真正的死连接最多多挂 10 分钟 |

另：点赞点踩是 CopilotKit stock 纯前端 state（无后端落库）——未动，属 P2 深化项。

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
- **审批/工具卡**：AgentPendingToolCard 审批卡带影响指标（操作/节点/删除/生成计数）+ `<details>` 技术详情折叠；完成的 AgentToolCard 同样可折叠看 JSON 详情。（✅ 我们已对标第一层）
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
| G1 | 消息流分型：message / tool / approval / plan / status 各有专属卡 | ✅ tool + approval 已做（`toolCards.tsx`）；plan / status 未做 |
| G2 | 工具卡可展开看参数/结果详情 | ✅ `<details>` 折叠 |
| G3 | 审批内联聊天流（非原生 confirm）+ 影响摘要 | ✅ 第一层（人话摘要；成本/时长预估未做；覆盖仍只删卡/成组，整卡覆写未纳审） |
| G4 | 错误消息人话化 + 重试/恢复草稿 | ✅ friendlyError + 重试本轮（恢复草稿/诊断包未做） |
| G5 | 工具执行状态实时可见 | ✅ 工具卡 executing 态 + 节流进度行 |
| G6 | 结果自动写回画布 + 可撤销 | ⚠️ 写回有；仅全画布 undo，无按批/按工具撤销 |
| G7 | 流式 markdown + 打字中指示 | ⚠️ 有流式，无打字光标/动画 |
| G8 | @引用画布资源 | ✅ 领先（chip 点击定位、实时同步） |
| G9 | 多会话 + 历史 + 新建 | ✅ 领先（含搜索/导出） |
| G10 | 画布上下文自动注入 | ✅（本轮去重为单份注入） |

## 4. 独有亮点（差异化借鉴候选）

- open-storyboard-canvas：工具级 rollbackToken、审批影响摘要/成本预估/过期、计划可编辑、生成任务断点恢复面板、预算控制、诊断包、token 估算、「定位输入/定位结果」双按钮。
- open-ai-canvas：按批撤销、ops postcondition 校验、语音输入、durable-ack 恢复、assistant 文本自动变 chips。
- novanova：SSE 重连 + requestId 幂等、队列状态机、思考流 reducer、**画布节点拖入聊天**、风格 chips。
- ai-moive-studio：审批卡内选执行模型。
- viedeo-workflow：Chat/Agent 双模式、消息级重发、图片「从该 prompt 生成」。

---

## 5. 差距对照总表

按体验维度归拢（✅=有，⚠️=半吊子，❌=无；✅/⚠️ 后括号为落地位置）：

### 5.1 消息流渲染
| 项 | 竞品 | 我们 |
|---|---|---|
| 工具卡分型渲染 | ✅ 全员 | ✅ 后端 6 工具 + read_node（toolCards.tsx）；plan/status 卡未做 |
| 工具卡折叠看详情 | ✅ open-ai-canvas 等 | ✅ `<details>` |
| 思考/推理展示（流式+折叠） | ✅ novanova / open-storyboard | ❌（需 v2 或自建 reasoning 通道） |
| 打字中指示 | ✅ open-ai-canvas「正在推演」/ ai-moive 打字机 | ❌ 只有三点 activityIcon |
| 进度聚合成任务卡 | ✅ ai-moive「执行中 N」/ 多家任务面板 | ⚠️ 节流累计行（同 id 原地更新受 ag-ui 桥 message_id 单次认领限制，真聚合要等 feed 分型） |
| 消息级时间戳 | 部分有 | ❌（DB 有 created_at，前端不显示） |
| 消息编辑/分支/重发 | ✅ viedeo-workflow 消息级重发 | ❌（仅失败重试本轮） |

### 5.2 任务执行模型
| 项 | 竞品 | 我们 |
|---|---|---|
| 计划先行可编辑 + 逐项打勾 | ✅ open-storyboard / novanova | ❌ |
| 审批内联 + 影响摘要 | ✅ open-storyboard / open-ai-canvas | ✅ 第一层（CanvasOpsRunning + ApprovalCard）；成本/时长预估、整卡覆写纳审未做 |
| 运行中继续输入 / 排队 | ✅ 多家 | ❌ inProgress 禁发（`ChatInput.tsx`） |
| 真取消（后端停） | ✅ novanova cancel / open-ai-canvas 任务可取消 | ✅ /chat/cancel 四处触发 |
| 断点恢复在聊天/任务面板呈现 | ✅ open-storyboard GenerationTasksPanel | ⚠️ 分镜出图有恢复，聊天链路无面板 |
| 步数/成本预算 | ✅ open-storyboard agentBudget | ❌ |

### 5.3 画布↔聊天联动
| 项 | 竞品 | 我们 |
|---|---|---|
| 聊天→画布定位 | ✅ | ✅ FOCUS_NODES（领先） |
| 工具卡「定位输入/定位结果」双按钮 | ✅ open-storyboard | ❌ 只有结果定位 |
| 画布节点**拖进**聊天成引用 | ✅ novanova / viedeo-workflow | ❌ 只有 @ 菜单选择 |
| 聊天内图片放大/下载/重生成 | ✅ viedeo-workflow「从该 prompt 生成」 | ⚠️ 出图卡缩略条可开原图；Lightbox 仍仅画布 |
| 工具级/按批回滚 | ✅ open-storyboard / open-ai-canvas | ❌ 全画布 undo |

### 5.4 会话与输入
| 项 | 竞品 | 我们 |
|---|---|---|
| 会话 id 贯通模型侧记忆 | ✅ | ✅ threadId 直通 + 客户端铸造 id |
| 会话重命名体验 | — | ⚠️ window.prompt 风格割裂 |
| 上下文 token 估算显示 | ✅ open-storyboard | ❌ |
| 语音输入 | ✅ open-ai-canvas | ❌ |
| assistant 文本自动变选项 chips | ✅ open-ai-canvas | ❌（空态写死 4 条） |
| 风格/参数 chips 在聊天内多选 | ✅ novanova | ⚠️ 画风只有全局坞一处 |

### 5.5 错误恢复
| 项 | 竞品 | 我们 |
|---|---|---|
| 错误人话化 | ✅ | ✅ friendlyError + 详情折叠 |
| 恢复草稿重发 / 诊断包 | ✅ open-storyboard | ❌（有重试本轮） |
| 幂等/断线重连 | ✅ novanova SSE | ⚠️ ag-ui 自带流，无重连保障 |

---

## 6. 优化路线（2026-09-02 执行后状态）

### P0 —— 修 bug ✅ 全部完成
1. ✅ read_node 白名单矛盾（B1）。
2. ✅ threadId 接入 `<CopilotKit>`，会话切换/新建贯通 LangGraph checkpoint（B2）。
3. ✅ 聊天工具链路后端取消端点 `POST /chat/cancel`，停止按钮透传（B3）。
4. ✅ 切会话 abort + 取消透传（B4，框架 detach + 前端 cancel）。
5. ✅ 导出 md decode `WS_PARTS::`。
6. ✅（执行中发现）聊天输入 onChange 断链修复（B6）。

### P1 —— 体验补课 ✅ 基本完成
1. ✅ 错误人话化映射表 +「重试」保留。
2. ⚠️ 进度消息：聚合改为**源头节流**（同 id 原地更新受 ag-ui 桥限制，见 5.1）。
3. ❌ 审批覆盖扩大（整卡 body 覆写纳入确认）——未做，待与 P2 审批分级一起设计。
4. ⚠️ 聊天内图片：出图卡缩略条可开原图；接画布 Lightbox 未做。
5. ✅ 上下文去重：canvasSummary 收敛为 system prompt 单份。
6. ❌ 会话重命名对话框 / 发送后气泡 chip 样式——未做（低价值顺位）。

### P2 —— 结构化 feed（进行中）
> **已落地第一层 + 计划先行**：`components/copilot/toolCards.tsx`（后端 6 工具 render-only 卡 +
> `available:"disabled"` 拦截 stock 渲染）、`components/copilot/planCards.tsx`（propose_plan 阻塞确认 +
> update_plan 实时打勾，zustand store 驱动流内更新）、read_node 卡片化、审批卡内联。
> E2E：`scripts/chat-tool-cards-test.mjs`（真实 LLM，9 断言全绿）。
> 落地时确认的框架事实：v1 useCopilotAction 无 handler 无 available 会 throw
> "Invalid action configuration"；render 不能返回 null（返回空 fragment）；render props =
> {status, args(自动解析), result(ToolMessage 字符串)}。

1. ✅ 消息流分型：tool/approval/plan 卡；status 卡未做。
2. ✅ 计划先行：propose_plan（≥3 步任务先确认，流内计划卡 + 开始执行/暂缓）+ update_plan（每步打勾实时更新）；计划可编辑修订未做。系统提示加「计划先行」节（graph.py，单步操作不出计划）。
3. ✅ 审批卡内联化 + 人话影响摘要；成本/时长预估、按影响分级未做。
4. ✅ 任务面板第一层：输入框上方常驻任务条（`ws-task-row`）——`GET /chat/jobs?threadId=` 轮询（3s）拉 `skills.CHAT_JOBS`，展示出图进度 done/total、逐任务取消（/chat/cancel 带 jobId）；独立面板/断点恢复入口未做。
5. ⚠️ 思考透传（2026-09-02 落地第一层）：协议链路已打通——GLM `thinking:enabled` 吐 reasoning_content（langchain-openai 1.6 默认丢弃 → graph.py 兼容子类 `_convert_chunk_to_generation_chunk` 捡回进 additional_kwargs）→ ag-ui 桥发 REASONING_MESSAGE_* 事件 → core 不认识、打成 RAW 包装事件透给浏览器。UI 用输入框上方「思考中」指示条（`ChatInput.tsx` ws-thinking-row，直接订阅原始 agent 实例的 onEvent 攒增量；注意 useAgent 返回的是 core 包装 agent，其 messages 与订阅回调都过滤了 reasoning）。思考触发与否取决于模型自愿，E2E 中为软断言。消息内嵌折叠卡（novanova ThinkingBlock 完整形态）仍需 v2。
6. ✅ 画布节点拖进聊天（卡片标题行拖拽把手 → ChatInput 落 @chip，复用 appendMention，`nodrag` 与 xyflow 拖动隔离）+ read_node 卡「定位到画布」按钮；通用工具卡「定位输入/定位结果」双按钮未做。
7. ❌ 工具级回滚 / 按批撤销（依赖 ops snapshot 体系，参考 open-ai-canvas postcondition 校验）。

### 明确不做（本轮结论）
- OpenLovart 式的非流式聊天；消息级分支编辑（CopilotKit v1 下成本高，先做重发）；语音输入（优先级最低）。

---

## 附：我们的相对优势（保持并继续放大）

- @引用 chip 体系：token 存节点 id、点击定位、改名/删除实时同步——比 open-ai-canvas 的文本 token 更稳。
- 多会话 + 搜索 + 导出 md，会话管理完整度高于全部竞品；会话 id 与模型 checkpoint 同源（多数竞品未做这层贯通）。
- 附件全链路（多模态 parts → 非视觉模型降级 URL 清单）已实测可用。
- 分镜批量出图的断点恢复/补缺图——聊天链路的任务面板（P2-4）可以直接复用这套 job 机制。
- 破坏性操作审批 + 真取消贯通到后端工具（多数竞品的 cancel 只停客户端）。

## 附：回归与验证入口

- `scripts/chat-tool-cards-test.mjs` —— 聊天工具卡 + 审批内联 + 输入链路（真实 LLM，自建项目隔离）。
- `node scripts/agui-client-test.mjs` —— AG-UI 两轮工具调用闭环（注：「第 1 轮操作数量不足」告警是既有的 GLM 首轮不带 op 字段问题，与聊天改动无关，stash 实验已验证 HEAD 同样失败）。
- `pnpm exec tsc --noEmit && pnpm exec eslint components lib app`。
