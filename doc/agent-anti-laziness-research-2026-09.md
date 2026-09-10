# 先进 agent「抗懒」设计调研：codex / gemini-cli / opencode 对照借鉴

> 2026-09-10。起因：我们的 agent 经常「懒」——草草收场、声明完成但没做完整、失败就停、把问题推回用户。克隆了三个开源 agent 源码逐行研究它们的对策。
> 仓库位置：`~/Developer/agent-ref/{codex,gemini-cli,opencode}`（浅克隆，可随时翻原文）。

## 一句话结论

三家的共同底牌**不是喊口号让模型勤奋**，而是四件事：

1. **重定义「完成」**——验证过才算完，基于意图打勾是违规（"Never based on intent"）；
2. **机制闸门**——turn 结束由编排层状态机判定，不信模型自觉（codex `needs_follow_up` + Stop hook；gemini 空响应重试/循环检测；opencode 不信任 provider stop 信号）;
3. **失败重试纪律**——失败是「换路」的信号不是「收工」的理由，重试 3 次才强制重评假设，汇报必须交代验证缺口；
4. **压缩时死保任务状态**——摘要里「未完成清单 + 当前焦点 + 下一步」是固定结构化字段，永不丢。

我们的宪法在「问/做的边界」「共创契约」上其实写得比它们细（E 形态的治理领先），真正缺的是：**一条总纲性的完成定义、失败后的改道重试纪律、计划打勾的验证语义、机制层的完成审核**。

## 我们的「懒」形态诊断 → 三家对策索引

| 形态 | 现状 | 最对症的三家设计 |
|---|---|---|
| A 中途停下问「要不要继续」 | 已部分治理（决策原则 2「不要请示」） | codex「问了没答按最佳判断继续」；opencode 提问三原则 |
| B 失败后如实汇报然后停 | 只有「如实说明」——反而成了收工借口 | gemini「persist through errors + 回退重规划」+ 3 次强制重评 |
| C 声明完成但没做完整/没验证 | 零散条款，无总纲 | codex「Autonomy and Persistence」；opencode 打勾 "Never based on intent" |
| D 草草一版就交 | 共创契约有质量条款，执行层没有 | gemini「Validation is the only path to finality」；codex 反 AI-slop 条款 |
| E 空手把问题推回用户 | **领先**（共创契约「先铺开再收敛」） | gemini ask_user 白名单可作补充 |

---

## P0：提示词层，改 `agent/prompts/system.md` 当天可抄

### 1. 完成 = 做完 + 验证 + 交代（总纲，最高优先）

codex GPT-5.1 起新增的整节（`codex-rs/core/gpt_5_1_prompt.md:29,138`，5.0 版没有——OpenAI 是后来被逼加上去的）：

> "**Persist until the task is fully handled end-to-end** within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through **implementation, verification, and a clear explanation of outcomes** unless the user explicitly pauses or redirects you."
>
> "You must keep going until the query or task is completely resolved, before ending your turn... **persevere even when function calls fail**. Only terminate your turn when you are sure that the problem is solved."

gemini-cli 同义（`packages/core/src/prompts/snippets.ts:369`）：

> "**Validation is the only path to finality.** Never assume success or settle for unverified changes."

**落地建议**：执行纪律开头加一条总纲——「一轮内的任务要做完「产出 + 自检 + 交代」三件套才许收工；工具失败先换法子重试而不是汇报了事；只有确信完整交付（或被用户打断）才结束本轮」。这直接治 B、C 两种形态。

### 2. 失败处置三段式（治「合规式偷懒」）

我们现在是「某步失败时在汇报里如实说明」——模型把它理解成「失败→汇报→等用户」。gemini 的完整版（`snippets.ts:259,371-374`）：

> "persist through errors and obstacles by diagnosing failures... and, if necessary, **backtracking to the research or strategy phases to adjust your approach until a successful, verified outcome is achieved**."
>
> "**Strategic Re-evaluation:** If you have attempted to fix a failing implementation more than 3 times without success, you must: 1. Stop and remind yourself of the original task description. 2. **List your current assumptions and identify which ones might be wrong.** 3. Propose a different architectural approach rather than continuing to patch the current one."

codex 的汇报侧补丁（`gpt_5_codex_prompt.md:43`）：

> "add **verify steps if you couldn't do something**."（汇报里交代验证缺口，不许假装验证过）

**落地建议**：改写执行纪律的失败条款为三段式——①失败先自诊换法重试（换参数/换工具/拆小步）；②同一问题改了 3 次仍不成：停下，回到原始需求列出可能错的假设，换方案而不是继续打补丁；③汇报必须写明「哪些做完了且验证过、哪些没做成、原因与剩余待办」。

### 3. 「说了要做就真做」（治口头完成）

opencode（`packages/opencode/src/session/prompt/beast.txt:9,28`）：

> "when you say you are going to make a tool call, make sure you **ACTUALLY make the tool call, instead of ending your turn**."
>
> "When you say 'Next I will do X' or 'Now I will do Y', **you MUST actually do X or Y** instead just saying that you will do it."

**落地建议**：执行纪律并入一句——「宣布了『接下来做 X』就必须真做 X 再收工，不许把计划当结论交付」。我们有「必须调 canvas_ops 不要只口头描述」，但只覆盖建卡类，泛化成总则。

### 4. 提问边界两块补丁

codex（`collaboration-mode-templates/templates/default.md:15` + `plan.md:41-49`）：

> "If `request_user_input` returns no answers, **continue with best judgment instead of asking again or treating the turn as blocked**."
>
> "**Eliminate unknowns in the prompt by discovering facts, not by asking the user**... Never ask questions you can answer from your environment."

opencode 最完整的版本（`packages/opencode/src/session/prompt/codex.txt:43-49`）：

> "Default: do the work without asking questions... If you must ask: **do all non-blocked work first, then ask exactly one targeted question, include your recommended default**, and state what would change based on the answer. **Never ask permission questions like 'Should I proceed?'**"

**落地建议**：决策原则补两句——①「问了没等到回答时，先做不受影响的部分，按推荐默认继续，不要原地卡死或再问一遍」；②「画布/工具能查到的事实（有什么卡、任务状态、模型清单）永远不许问用户」。注意与我们共创契约的边界：这两条管的是执行类请示，不碰「方向类决策呈报拍板」。

---

## P1：工具描述层，改 `planCards.tsx` / `graph.py`

### 5. 打勾的验证语义（治「计划走过场」）

现状：`update_plan` 描述只有「每完成一步调用它打勾」。模型可以一口气全打勾交差。codex 的计划纪律（`gpt_5_1_prompt.md:73`）：

> "exactly one item in_progress at a time; **Do not jump an item from pending to completed: always set it in_progress first. Do not batch-complete multiple items after the fact. Finish with all items completed or explicitly canceled/deferred before ending the turn.**"

opencode todowrite 工具描述（`packages/opencode/src/tool/todowrite.txt:26,28`）——最精辟的一句：

> "Mark `completed` **only after the required work is actually done, including any required verification. Never based on intent.**"
>
> "If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker."

gemini 任务追踪协议（`snippets.ts:591-592`）：

> "**VERIFICATION:** Before marking a task as complete, verify the work is actually done (e.g. run the test, check the file existence)."
> "**STATE OVER CHAT:** If the user says 'I think we finished that,' but the tool says it is 'pending', **trust the tool**."

**落地建议**：`propose_plan`/`update_plan` 描述补三句——打勾=该步产物已实际落卡/落库且你看过工具返回成功，凭「应该做好了」打勾是违规；受阻/部分完成的步保持未勾并在汇报里说明卡在哪；全部勾完（或显式说明跳过原因）才许收工。`steps` 参数描述里已有「可独立验证是否完成」，正好衔接。

### 6. 工具返回串附带自检报告（机制层，低成本高杠杆）

opencode 的「LSP 诊断回注」范式（`packages/opencode/src/tool/edit.ts:196-201`）：编辑成功后自动跑诊断，有错就把错误清单**直接塞进工具结果**——修错成为默认下一步，不靠模型想起来。

**落地建议**（wingsight 版）：`generate_asset_images`、`canvas_ops` 等关键工具的返回串尾部自动附一段「当前画布还有 N 张卡停在 loading/error 未终态化」的清单（agent 侧读库即可拼）。模型看见清单就不得不管——把「绝不让卡片停在 loading」从提示词纪律变成每次工具调用后的强制对账。

---

## P2：机制层方向（工程量大，先留档）

### 7. Stop-hook 式完成闸门

codex 最强的一招（`codex-rs/core/src/session/turn.rs:616-654`）：模型想结束 turn 时 harness 先跑 Stop hook，hook 判「没做完」就注入 continuation prompt 把模型顶回循环。turn 的结束是状态机判定（`needs_follow_up`：无待处理工具结果 + 无待处理输入 + 模型声明结束 + 闸门放行，四条件同时满足），不靠模型自觉。

**wingsight 等价物**：LangGraph 的 chat_node 后加一个轻量「收尾审核」节点——本轮有 `status:"generating"` 的卡 / 有失败未回填的工具调用 / 计划有未勾步骤且未说明跳过 → 注入一条系统消息打回。gemini 的子代理版同思路：任何终止路径（超时/超轮/未提交）都强制一轮 "Final Warning Turn"（`local-executor.ts:413-488`），交出「目前最佳答案 + 中断说明」，空结果被参数校验直接拒绝。

### 8. 压缩摘要结构化保任务状态

现状：`_fold_into_summary`（`agent/graph.py:865`）的提示词有「未完成事项」四个字但无结构，模型折叠时容易丢。gemini 的 `<task_state>`（`snippets.ts:955-962`）把它做成强制字段：

> `1. [DONE] Map existing API endpoints. 2. [IN PROGRESS] Implement OAuth2 flow. <-- CURRENT FOCUS 3. [TODO] Add unit tests.`

opencode 的压缩模板固定六段，含 `## Work State (Completed|Active|Blocked)` + `## Next Move`，且带警告句「**anything you do not carry into the new summary is lost**」（`packages/core/src/session/compaction.ts:16-55`）。gemini 还做**摘要自检二轮**：压缩后追加一次轻量调用「批判性检查你刚才的快照漏了什么，生成改进版」（`chatCompressionService.ts:382-407`）。

**落地建议**：压缩提示词把「未完成事项」升级为固定结构段（进行到哪一步 ← 当前焦点 / 剩余步骤 / 被什么打断），长任务跨压缩后不失忆、不烂尾。自检二轮可选。

### 9. max-steps 收尾不许装完成

opencode（`packages/core/src/session/runner/max-steps.ts`）：步数耗尽被强制收尾时，必须输出「已达上限 + 已完成什么 + **剩余未完成任务清单** + 建议下一步」——被截断也不许谎报完成。我们 LangGraph 的 `recursion_limit`（默认 25）到顶直接抛 `GraphRecursionError`，没有收尾语义。可在 config 里捕获并走一次收尾调用。

### 10. 循环检测 + 反思注入（而非终止）

gemini 三层（`loopDetectionService.ts`）：同 tool+参数连续 5 次 → 判循环；LLM 语义检测会区分「批量处理不同对象≠循环」；**第一次检出不停机**，注入「退一步反思」消息重试，第二次才终止。我们只有提示词「无进展就停下汇报」。LangGraph 层可做同参数重复检测 + 注入，工程量中等。

### 11. 模型分级纪律强度

opencode 按模型分提示词（`session/system.ts:28-51`）：弱/易懒模型（o1/o3/gpt-4）配大写命令式的 beast 版（"NEVER end your turn..."、"Failing to test sufficiently is the NUMBER ONE failure mode"），强模型配原则式。我们的启示：宪法条款要适配当前 backbone 的档位——用户已有结论「抽象程序对弱思考模型有效」，命令式短句比原则长段更可靠；换更强模型时可以减码。

---

## 三家独门细节（一句话存档）

- **codex**：Persistent effort 档位整套设计（「pending/running/inconclusive 结果不算完成，Never invent an early stopping point」+ 可被新输入提前唤醒的 sleep 工具）——完美适配视频生成这类长耗时异步任务的轮询值守，但我们已有任务通知自动续跑机制等价。
- **codex**：压缩摘要前缀 "build on the work that has already been done and **avoid duplicating work**"——防压缩后重复劳动。
- **gemini**：工具调用后禁止空响应/沉默（"You MUST NEVER return an empty response"），空流判定为协议错误强制重试 + 末尾 nudge「你已经想过了，现在必须给答案或调工具」。
- **gemini**：沙箱失败「**不先解释失败，自动带权限重试**」——禁止把环境错误推给用户。
- **gemini**：子代理终止条件 = 「Questions to Resolve 清单清空」——把「彻底」做成可检查的空列表条件，可移植成「设定/节奏/参考的疑问未清完不许宣布方案完成」。
- **opencode**：kimi 版「勤快体现在动作而非解释里」（"Be thorough in your actions — test what you build — not in your explanations"）+ 「把代码贴在聊天里不算交付」——对创作域：把策划案贴在聊天里不算交付，落卡才算（我们已有「成稿落卡」宪法，口径一致）。
- **opencode**：子任务失败显式传播（Task 工具自身报错 "Subagent failed"），禁止静默降级为「部分成功」——与我们的「不做 fallback」铁律同源。

## 落地路线建议

1. **本周可做**：P0 四条（完成总纲 / 失败三段式 / 说了就做 / 提问补丁）改 `system.md`——宪法加内容必须 A/B（跑 intent-routing-test + skill-routing-test 回归，历史教训：多集口径曾把 intent-routing 打到 10/14）。
2. **顺手做**：P1 打勾语义改 `planCards.tsx` 工具描述（工具描述是唯一真相源，注意三处同步：工具描述 / SKILL.md / 宪法）。
3. **下个迭代**：P1 自检报告回注（graph.py 工具返回串拼画布对账清单）+ P2 压缩摘要结构化。
4. **留档待议**：Stop-hook 完成闸门（改图结构，收益最大工程量也最大）、循环检测、max-steps 收尾。

## 原文索引

| 主题 | codex | gemini-cli | opencode |
|---|---|---|---|
| 完成总纲 | `codex-rs/core/gpt_5_1_prompt.md:29,138` | `packages/core/src/prompts/snippets.ts:369` | `packages/opencode/src/session/prompt/beast.txt:1,9,28` |
| 打勾纪律 | `gpt_5_1_prompt.md:73` | `snippets.ts:578-596`, `gemini-3.ts:499-564` | `packages/opencode/src/tool/todowrite.txt:26` |
| 失败重试 | `gpt_5_1_prompt.md:138`（persevere） | `snippets.ts:259,371-374` | `session/prompt/kimi.txt:93` |
| 提问边界 | `collab.../default.md:11-15`, `plan.md:41-49` | `snippets.ts:258,482-498` | `session/prompt/codex.txt:43-49` |
| Stop 闸门 | `codex-rs/core/src/session/turn.rs:616-654` | `agents/local-executor.ts:413-488` | `core/src/session/runner/max-steps.ts` |
| 压缩保任务 | `prompts/templates/compact/prompt.md` | `snippets.ts:885-964`（task_state） | `core/src/session/compaction.ts:16-55` |
| 循环检测 | — | `services/loopDetectionService.ts` | — |
