# 长对话浏览与导航：业内做法 vs 我们的差距

调研日期 2026-09-11。对象 = 聊天侧「长对话怎么找、怎么跳、怎么看」这一模块
（轮次索引轨、会话内搜索、长内容折叠、回底、阅读位置、分支回退）。

证据来源分三路：① 消费级对话产品官方文档/帮助中心/changelog ② 本地源码精读
（`~/Developer/agent-ref/{codex,opencode,gemini-cli}`）③ 任务型 agent 与工作台官方文档。
凡未取到一手来源的一律标「未证实」。

---

## 一、结论摘要

1. **会话内导航（大纲/轮次索引/圆点轨）四家消费级产品全部没有原生实现**，这块市场由
   一整个第三方扩展品类补齐（ChatGPT Outline、ChatTOC、Thread Navigator for Claude、
   Long Chat Navigator for Gemini、Perplexity Thread ToC…）。我们**原生就有**，这是相对优势。
2. **会话内搜索一律回落浏览器 Cmd/Ctrl+F**，四家都没有产品级「命中计数 + 上/下一处」。
   Claude 桌面版有搜索框但缺匹配项键盘导航（社区在求 Cmd+G）。我们**原生有完整实现**，
   这一点领先主流。
3. 真正的差距不在「有没有」，而在**轨道不知道你读到哪**（无滚动同步）与**搜索只覆盖已挂载
   的消息**（虚拟化后搜不全）。生产数据已踩线：14 个会话里 2 个越过框架 50 条虚拟化阈值。
4. 次级差距：无轮次键盘导航、回底按钮无未读提示、无阅读位置记忆、面板行只有跳转没有动作、
   答案正文会自动折叠（与「过程折叠、答案展开」的行业共识方向相反）。
5. 有些能力**不必抄**：步骤/工具调用粒度的索引面板（主流也没有，三家 CLI 都只到消息粒度）、
   百分比进度条（无人用）、终端分页器（终端 scrollback 的产物，Web 不需要）。

---

## 二、我方基线（2026-09-11 现状）

| 能力 | 实现 | 位置 |
|---|---|---|
| 轮次索引轨 | 右侧圆点轨；锚=用户轮（`progress_*`/「（任务通知）」/「（用户中断」过滤掉）；悬停展开面板（18 字摘要+轮次号）；命中区 24px 宽列 | `components/copilot/TurnLocator.tsx` |
| 跳转 | 元素在 DOM → `scrollIntoView` + 落点确认（accent 竖条+底色冲刷）；被虚拟化卸载 → 按序位比例估滚，挂载后精跳 | 同上 `jump()` |
| 轨道动效 | 面板右滑淡入 / 新轮圆点回弹入场 / 点击脉冲 / 轨道淡入 / 悬停展宽变色 | `app/globals.css` 轮次轨节 |
| 会话内搜索 | Cmd/Ctrl+F 或头部放大镜；CSS Custom Highlight API 高亮；`cur/total` 计数；Enter/Shift+Enter 上下处；滚动居中；搜索中自动展开长消息；>50 条无命中时如实提示「仅搜索已加载部分」 | `components/copilot/ChatSearch.tsx` |
| 长回复折叠 | 正文**实测溢出** >480px×1.6 才折；最新一轮不折；流式中不折；搜索中不折；展开态按消息 id 存 store（抗虚拟化卸载） | `components/copilot/AssistantMessage.tsx` + `lib/chat/collapse.ts` |
| 过程折叠 | 工具卡长结果进 `<details>`「详情」（已对齐行业「过程收起」） | `components/copilot/toolCards.tsx` |
| 回到底部 | 框架内置按钮，我们只做纸感样式；**无未读计数** | `globals.css` |
| 重新生成 | 服务端 checkpoint 分叉（`/chat/regenerate`）+ 前端截断本地历史重跑；**无分支切换 UI** | `AssistantMessage.regenerate` |
| 长会话降级 | 滚动摘要压缩（`CHAT_COMPRESS_THRESHOLD_TOKENS` 400k，保最近 ~40% 预算原文） | `agent/graph.py` |
| 虚拟化 | 框架 `@tanstack/react-virtual`，阈值 50 条 | `@copilotkit/react-core` |

生产实测（`ssh wingsight`，agent/data/wingsight.db）：
14 个会话 / 366 条消息 / 中位 20.5 条；最长 **70 条 16 轮**、**67 条 19 轮**；
**2 个会话已越过 50 条阈值**（虚拟化路径已在真实使用中激活）。

---

## 三、业内事实

### 3.1 消费级产品（ChatGPT / Claude / Gemini / Perplexity）

- **会话内大纲：四家全无原生**。ChatGPT 无、Claude 无、Gemini「2025 年不存在内建 TOC/jump-to」、
  Perplexity 无。补位者是扩展品类，且这些扩展普遍要专门对抗虚拟化 DOM、做 scroll-sync 高亮、
  记忆阅读位置——**反过来证明「在虚拟化长列表里做稳定跳转与位置记忆」是这功能的真实技术难点**。
- **会话内搜索**：一律 = 浏览器原生 Cmd/Ctrl+F。ChatGPT 桌面版把 "Find in chat" (Cmd+F) 写进官方
  命令参考，并明说「不在其他会话间搜索」；ChatGPT 侧边栏的搜索是**跨会话**的（Ctrl/Cmd+K）。
  Claude 桌面版有搜索框但**缺 Cmd+G 上一处/下一处**，社区 issue 在求。Android 版 ChatGPT 在灰度
  「Find in chat」可跳到长对话对应位置（未发布）。
- **折叠方向：过程折叠、答案展开**。思考块（"Thought for X s"）、检索步骤（Perplexity Pro Search
  "Steps"）、工具调用默认收起；**助手正文不自动折叠**。ChatGPT 另有虚拟化导致的 bug：空白助手气泡、
  复制/导出把受影响轮次序列化成空串（实测 44000px 长线程只挂 3 个 assistant 节点）。
- **分支**：只以 `‹ 1/2 ›` 小箭头露出，**无树视图**（要看树得装扩展）。Claude 是三家里唯一在编辑
  框里**明说**「编辑会产生新分支，用箭头切换」的；且只「记得」当前分支，被放弃分支的 token 从上下文移除。
- **无「上/下一条消息」原生快捷键**（ChatGPT 只一个 jump to latest；社区 feature request 在求）。
- **回底按钮**：ChatGPT/Claude 有，**均未证实有未读计数**；Gemini/Perplexity 的原生缺失由扩展反证。
- **正确跟随范式 = 只在接近底部时跟随**（ChatKit 官方措辞），但 ChatGPT/Claude/Gemini **三家都被
  大量抱怨强制吸底且无原生开关**，对抗手段全是脚本/CSS。

### 3.2 CLI 编码 agent（codex / opencode / gemini-cli 源码）

| 维度 | codex | opencode | gemini-cli |
|---|---|---|---|
| 滚动 | 主视图交终端 scrollback；`Ctrl+T` 内置分页器（`Ctrl+U/D` 半屏、`PageUp/Down`、`Home/End`） | ScrollBox `stickyStart="bottom"` + `toBottom()` | Ink `<Static>` 或 alternate buffer + `VirtualizedList` |
| 贴底判据 | `is_scrolled_to_bottom()`（`tui/src/pager_overlay.rs:361`） | sticky 声明式 | `AppEvent.ScrollToBottom` 事件总线 |
| 逐消息跳转 | — | **`findNextVisibleMessage` / `scrollToMessage` / Jump to last user message**（`routes/session/index.tsx:377-421,831`） | — |
| 历史搜索 | `Ctrl+R`（只搜 **composer 输入历史**，不搜对话；去重+分批懒加载） | **无**（仅 ↑↓ 输入历史 + 会话列表标题 LIKE） | `Ctrl+R` 反向搜索（shell 历史 + **反转的用户消息**，增量缓存 100ms 防抖） |
| 轮次/回退 | `Esc Esc` → 高亮用户消息 → `Enter` 在该 prompt 前**分叉** | `<leader>g` **Timeline 对话框**：列全部用户消息（倒序），`Enter` → **Revert / Copy / Fork** 菜单 | `/rewind`（`RewindViewer`）+ `/chat save\|resume <tag>` 手动 checkpoint |
| 模型写的章节 | — | — | **`update_topic`：要求模型每 3-10 轮发布 `title+summary+strategic_intent`**，转写里渲染成章节标记 |
| 长输出 | head+tail 截断 + `Warning: truncated output (original token count: N)` | 截断 + **全文落盘**「用 Grep/Read 读，或委派子 agent 读」 | 按行高 `MaxSizedBox`（`... first N lines hidden (ctrl+O to show)`）+ 服务端 token 比例截断 |
| 渲染量 | 无虚拟化；按终端类型定重放行数上限（VS Code 1000 / Alacritty 10000） | 硬上限 100 条消息 | 真虚拟化 + 已定型项降级 `StaticRender` |
| 会话摘要 | 线程名靠**显式命名**，无则回落到首条消息 | **LLM 自动起标题**（仅当历史恰一条用户消息时触发） | `SessionSummaryService` 滑窗采样（前 N/2+后 N/2），摘要取代首条消息做列表显示名 |

三家共同约定：贴底跟随是「默认+可脱开」且**都不做「新输出强制拽回底部」**；分页/懒加载是历史侧
统一答案；截断必带显式告知；回退三要素一致（选一条用户消息 → 在其前分叉 → 原 prompt 回填输入框 +
回滚文件改动）。**三家都没有跨整条对话的全文搜索，也都只到「消息」粒度、不到「工具调用」粒度。**
巧思：codex 插入历史时**把视口偏移补偿掉**（新内容在下面长出来而屏幕不跳）；codex `Ctrl+R` 不预览
最新条目且 `Esc` 连 Vim 编辑状态一起快照还原。

### 3.3 任务型 agent 与工作台（Devin / Manus / Cursor / Copilot / Claude Code / OpenHands / Replit / Lovable / bolt / v0）

- **计划是「可编辑的文档/卡」，不是只读进度条**（Cursor Plan Mode / Manus Plan Mode「未 Confirm 不动手」/
  Replit Drafts 看板列可 View plan·Accept tasks·Revise plan）。
- **锚点挂在消息上，不另开侧栏时间线**（Cursor chat timeline checkpoint、VS Code hover 请求 →
  Restore Checkpoint / Fork Conversation、OpenHands "Branch from here"、Manus 消息下 branch 图标、
  Lovable "Go to message in chat"）。例外：Replit 看板、Devin Progress tab。
- **打断是「在安全边界插入」而非硬停**：Cursor `Enter` 排队 / `Cmd+Enter` 立即 / Send now = 在**下一个
  工具调用**处 steer；Lovable「下一个自然停顿点接住且不丢已完成工作」；Copilot steering 在 tool call 之后应用。
- **状态用徽标/计数/列，无人用百分比进度条**（估不出时长）。VS Code：Unread sessions badge + In-progress
  badge（可点过滤）；OpenHands：composer 上一枚「当前未解决动作」chip，暂停/完成即消失。
- **版本回滚普遍不覆盖历史**（分叉代替回滚；v0 恢复旧版会**新建**一个最新版本）；且普遍**明写「不回滚
  什么」**（Lovable/bolt「不回滚数据库」、VS Code「不回滚已完成的终端命令/网络请求」、Devin「回滚不可逆」）。
- **跑完把用户带回结果普遍是缺口**：官方有完成通知的只有 Replit（移动端三类推送）与 Devin（Slack 私信 +
  status chip），Copilot/Cursor/Claude Code web/OpenHands 官方文档均未述。
- **超长会话两条路线**：压缩（Claude Code auto-compact / `/compact focus on X` / `/rewind` 分区间摘要 /
  `/autocontext`/OpenHands context meter + 手动 Compact）vs 分解（Manus Wide Research 每项独立 context 的
  子 agent、Devin managed Devins + Session Size 分档把 L/XL 判为 unhealthy 建议拆会话、Replit 看板任务 + 隔离副本）。

---

## 四、差距清单

### P0-1 轨道不知道你读到哪（无滚动同步）

**现状**：rail 只有「末点 accent」= 标记**最新一轮**，不是标记**你正在读的那一轮**。没有任何滚动监听。
**业内**：这块恰恰是第三方导航扩展的核心卖点——Flex & Nav for Gemini「时间线轨高亮跟随当前阅读位置」、
Chat Index Navigator「floating index with scroll sync」、Thread Navigator for Claude 的 Resume。
**为什么重要**：轮次索引的价值一半在「跳转」，另一半在「我在哪」。没有 scroll spy，用户在 19 轮对话里
翻到中间时，轨道给不出任何位置信息。
**做法**：订阅滚动视口（`findViewport` 已有）采样各轮锚点 rect，算当前可见轮；当前轮圆点提亮/加长
（与「末点 accent」用不同视觉，两者可以同时存在：第 7 轮是你读的、第 19 轮是最新的）；面板打开时
对应行同步高亮并 `scrollIntoView` 进面板视口。

### P0-2 搜索只覆盖已挂载的 DOM

**现状**：`collectRanges(.copilotKitMessages)` 走 DOM 文本节点 → 框架 >50 条虚拟化后未挂载的消息搜不到，
只在无命中时提示「仅搜索已加载部分」。生产已有 2/14 会话越过阈值（最长 70 条 / 19 轮）。
**业内**：三家 CLI 都没做全文搜索（所以不算落后主流），但**我们的数据源本来就有全文**
（`langgraphAgent.messages`，与 ChatPersistence 同源）。
**做法**：搜索改成「扫数据源得命中（消息 id + 在正文中的序号）→ 映射到所在轮 → 跳该轮（复用 rail 已有的
估位跳转）→ 挂载后精确定位到该命中并高亮」。DOM 高亮保留作为渲染层，命中清单从数据来——这样
计数天然是全集，`cur/total` 也变成可信数字（现在是「已挂载部分里的第几处」）。

### P1-1 无轮次键盘导航

**业内**：三家 CLI 全有（codex `Ctrl+U/D`+`PageUp/Down`+`Home/End`；gemini-cli `PAGE_UP/DOWN`+`shift+↑↓`+
`ctrl+home/end`）；扩展生态统一补 `Alt+↑/↓`、`j/k`。
**我们**：画布有 `CanvasShortcuts` 体系，聊天轮次一个键位都没有。
**做法**：`Alt+↑/↓` = 上/下一轮（复用 `jump`，落点确认照旧）；`Alt+Home/End` = 首/末轮；与搜索的
`Enter/Shift+Enter` 不冲突（搜索打开时归搜索）。

### P1-2 回底按钮无未读/新消息提示

**业内**：普遍缺口（ChatGPT/Claude 均未证实有计数）；做得好的少数：VS Code 的 Unread badge
（点它过滤未读）、Replit 移动端推送三类状态。
**我们**：有 eventbus（任务终态事件）+ 任务通知浮条，缺的是把它折到按钮上。
**做法**：`copilot-scroll-to-bottom` 按钮上加计数徽标——来源两类：后台任务终态（已有 eventbus）+
用户离开底部期间到达的 agent/系统消息。

### P1-3 无阅读位置记忆

**业内**：Thread Navigator for Claude 的 **Resume**（一键回到上次阅读位置）与 **Starred turns**（收藏轮次）；
Manus/Devin 的会话恢复也回到原位。
**我们**：切会话/刷新后回到框架默认位置。
**做法**：按 `threadId` 记最后的可见轮 id（store，可选 localStorage 跨刷新）；进会话时提供「继续上次位置」。
与 P0-1 是同一套 scroll spy 数据，做 P0-1 时可一并落地。

### P2-1 面板行只有跳转，没有轮次动作

**业内**：opencode Timeline 行 `Enter` → **Revert / Copy / Fork** 动作菜单；codex `Esc Esc` 选中用户消息 →
`Enter` **在该轮前分叉**并把原 prompt 回填输入框。
**我们**：服务端已有真正的 fork 能力（`/chat/regenerate` 分叉 checkpoint），但入口只有「重新生成」一个，
且是「截断重跑」语义；没有「从这一轮分叉」「复制这一轮」。
**价值**：导演用户会反复比较方案，能否从任一历史轮长出新分支是有实际用量的诉求。

### P2-2 轮次标签是原始截断，不是摘要

**业内**：gemini-cli 的 `update_topic` 是**唯一**「让模型给长会话分段」的做法——每 3-10 轮发布
`title + summary + strategic_intent`。opencode/gemini-cli 的**会话级**自动标题我们已有
（`chat-autotitle-test`）。
**判断**：**倾向缓做**。18 字摘要 + 面板内检索已经够用；模型写的标题可能与用户自己的措辞不一致，
反而找不到。若要做，优先给「无正文可截断」的轮次（纯媒体消息）生成标签。

### P2-3 折叠方向可能反了（折答案 vs 折过程）

**业内共识**：**过程折叠、答案展开**——思考块、检索步骤、工具调用默认收起，助手正文不自动折叠。
**我们**：工具卡已对齐（长结果进 `<details>`）；但**答案正文会自动折叠**（480px / 1.6×）。
2026-09-11 用户反馈「所有回复都默认折叠，影响观看」后我们把阈值从 340px 放宽到 480px——
**但方向仍与主流相反**。
**做法**：考虑把自动折叠收得更紧——只在答案极长（比如 >2000 字）时折，或改为「不自动折，只提供
手动折叠」。注意与「导演看长文」的使用场景权衡：我们的正文可能是剧本/策划案，用户确实想通读。

### P2-4 无分支切换（旧答案回不去）

**业内**：ChatGPT `‹ 1/2 ›`、Claude 分支切换器（且编辑框里明说会产生分支）。
**我们**：服务端 fork 做对了（比客户端分支更正确——客户端截断并不能让旧答案离开模型上下文，我们实测过），
但前端截断本地历史 → 旧答案从界面消失。
**做法**：至少保留「本轮的上一版答案」可回看（版本指针），不必做完整分支树。

---

## 五、我们相对主流做得好的（别在改动中弄丢）

1. **原生会话内导航**：四家消费级产品全无原生实现。我们的实现比多数扩展讲究——24px 命中区
   （扩展的圆点普遍很小）、虚拟化时「估位跳转 + 挂载后精跳」、系统消息不占轮次锚、落点确认动画。
2. **原生会话内搜索带命中计数与键盘跳转**：四家一律回落浏览器 Cmd+F；Claude 桌面版有搜索框但
   缺 `Cmd+G`（社区 issue）。我们还做了「搜索中自动展开折叠区」与诚实降级提示。
3. **落点确认**（accent 竖条 + 底色冲刷）：扩展生态几乎不做落点反馈。
4. **服务端 checkpoint 分叉式重新生成**：解决了「旧答案仍在模型上下文里」（实测模型能逐字复述
   已删答案），这是客户端分支切换做不到的。
5. **长会话压缩**与行业「压缩」路线一致（对比另外一条「分解」路线，见 §3.3）。
6. **系统消息过滤**：任务通知/中断标记不进轮次索引——扩展生态普遍会把它们当轮次。

---

## 六、不建议照抄的

- **步骤/工具调用粒度的索引面板**：主流也没有（codex/gemini-cli/opencode 都只到「消息」粒度）。
- **百分比进度条**：无人使用，因为估不出时长；状态用徽标/计数/列表达。
- **终端分页器 / Copy Mode / scrollback 重放上限**：终端 scrollback 的产物，Web 无对应问题。
- **对话树全视图**：ChatGPT/Claude 都没有（要看树得装扩展），收益低于成本。

---

## 七、未证实清单（诚实交代）

| 事项 | 状态 |
|---|---|
| ChatGPT 回底按钮是否显示未读计数 | 未证实（无正面证据） |
| ChatGPT 桌面版 "Find in chat" 原文措辞、统一搜索细节 | 抓取失败，仅搜索摘要转引 |
| Claude 网页版是否有工具/长输入折叠 | 折叠证据来自 Claude Code，网页版未证实 |
| Claude 打开长会话是停在顶部还是底部 | 两条来源互相张力，需实测 |
| Gemini 是否虚拟化、是否有原生回底按钮、是否有会话内搜索 | 仅扩展反证，未证实 |
| Perplexity 原生大纲/搜索/分支 | 未证实 |
| Devin 会话页三级状态日志、Manus 五阶段状态与 Task Progress 卡 | 仅第三方来源 |
| OpenHands tasklist/planner tab | 仅 DeepWiki 与 PR，官方文档未述 |
| 腾讯元宝原生右侧跳转箭头 | 单一社交媒体来源 |

方法说明：本轮命中了 WebSearch 用量上限，部分条目依赖搜索摘要。**亲自抓取并逐句核对**的页面：
OpenAI 帮助中心 ChatGPT Search 页、Anthropic 帮助中心 Search and reference chats 页、
OpenAI 开发者社区长线程虚拟化技术帖；另有 3 页抓取失败（Chrome 商店扩展页、learn.chatgpt.com
命令参考、OpenAI release notes）。CLI 部分全部为本地源码精读（含文件行号），证据等级最高。

参考的源码位置：`~/Developer/agent-ref/codex/codex-rs/tui/src/{pager_overlay.rs,keymap.rs,app_backtrack.rs}`、
`~/Developer/agent-ref/opencode/packages/tui/src/routes/session/{index.tsx,dialog-timeline.tsx,dialog-message.tsx}`、
`~/Developer/agent-ref/gemini-cli/packages/cli/src/ui/components/{MainContent.tsx,RewindViewer.tsx}`。
