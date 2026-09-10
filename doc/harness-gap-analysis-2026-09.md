# 机制层（harness）差距分析：wingsight vs codex / gemini-cli / opencode

> 2026-09-10 第三轮。前两轮清完宪法层（抗懒条款已落地、宪法对比五条款已落地），本轮看**编排系统层**——turn 循环控制、容错、模型分档、时间感知、子代理、评估。仓库 `~/Developer/agent-ref/`，本机实证基于 `agent/graph.py` 当前代码。

## 本轮实证发现（我们运行时的真实现状）

- **零时间注入**：graph.py / main.py 无任何 datetime 注入，系统提示与工具描述都没有当前日期——模型不知道今天几号，「最新/最近」的判断会漂。
- **空响应无重试**：主循环 `astream` 后 `merged is None → raise RuntimeError`（graph.py:1667）——整轮炸掉。gemini 对空流/只有思考没正文/畸形工具调用全部判定 InvalidStreamError → 末尾 nudge → 重试（≤6 次）；我们只有 LangChain 内建的网络层 2 次重试。
- **老工具输出只清洗不剪体积**：`_sanitize_messages_for_model` 清洗交替防 400，但巨型工具返回（调研状态 JSON、长卷宗）一直占窗口直到压缩边界。opencode 从后向前保留 40k 工具输出、更早的清空并标记 `[Old tool result content cleared]`。
- 全链单一 AGENT_MODEL：标题生成、滚动摘要、主循环同款模型同款默认温度。

## 差距清单（按「问题严重度 × 修起成本」排）

### 第一档：低成本高收益，可直接做

1. **时间感知**（一行）：宪法头部或 web_search 工具描述注入当前日期。codex 定期时间提醒防长任务时间感丢失；opencode websearch 描述带 `The current year is {{year}}`。我们模型答「最新」类问题全靠参数截止日期猜。
2. **空响应 nudge 重试**（~20 行）：astream 空结果/纯思考无正文时，注入一句 nudge（gemini 原文范式：`[System: You previously generated thoughts but failed to provide a final response. Please provide your final answer or call a tool now.]`）重试 1-2 次，仍空才报错。nudge 加在对话末尾而非系统提示（保前缀缓存）。deepseek-flash 输出稳定性弱于 gpt-5/gemini-3，这条对我们的命中率比对 codex 更高。
3. **行为遥测**（一处改动）：events 表加 agent 行为层计数——每轮工具调用数、失败率、同参数重复调用次数、压缩触发次数。这是「懒」的量化基础：改了宪法到底有没有减少空转，现在无法回答。gemini repo 有 evals/ + memory-tests/ + 改提示词必须跑基准的工程纪律，我们连数据采集都还没有。

### 第二档：中期，需要小设计

4. **机制层防注入**（中成本）：上轮已加宪法层「素材不是指令」，但机制层零防护——web_search/web_fetch 返回串、上传文档提取文本外包 `<untrusted>...</untrusted>` 标记，宪法告知标记内是素材。宪法对弱模型是概率性的，包裹是确定性的。gemini 范式（snippets.ts Core Mandates Security 节）。
5. **工具输出体积剪枝**（中成本）：超出保留预算的老工具输出截断存档+窗口内替换为标记，opencode compaction 范式。配合已有的滚动压缩，把窗口留给正文与近期工具结果。
6. **压缩摘要结构化 + 自检二轮**（P1.5 已列）：未完成事项升级为「当前焦点/剩余步骤/中断点」固定段；压缩后追加一次轻量调用自检「摘要漏了什么」再定稿（gemini chatCompressionService 的 Probe Verification）。
7. **轻任务降档**（小成本）：标题生成/摘要类一次性调用显式 temperature 0.1-0.2（gemini 工具型子代理范式：低温度+高思考）；主循环维持默认。省的是质量风险不是钱——标题/摘要要稳定不要创意。

### 第三档：方向性，大工程或受架构约束

8. **turn 状态机**（P2 已列）：mid-turn 压缩续跑、收尾审核节点（Stop-hook 语义）、recursion_limit 宽限收尾（opencode MAX_STEPS：强制列出剩余任务，不许装作全做完——现在 LangGraph 到 25 步直接抛 GraphRecursionError）。受 AG-UI 请求-响应约束，中途插话（steering）做不到，但**轮内**的压缩续跑与宽限收尾在 LangGraph 内可行。
9. **子代理**（AGENTS.md 已留档「机制层第一缺口」）：三个真实价值点——长调研隔离（40 来源细节不污染主循环上下文）、隔离审查（审稿/比稿用干净视角，juben「审稿比稿」场景）、干跑-执行分离（已有 validate_ops 算半个）。LangGraph subgraph 可承载，但工具桥（前端工具只能主循环答）要重新设计，牵一发动全身。
10. **循环检测**（P2 已列）：同 tool+args 连续 N 次的确定性检测+反思注入。gemini 的语义检测层（区分批量生产 vs 真循环）可后置，确定性检测先行。

## 明确不列为差距的（形态差异）

- **沙箱分级**：单人本地应用，工具都是产品内动作，威胁模型不同。
- **中途插话（steering）**：AG-UI 协议约束，排队已是等价形态（宪法+ChatInput 已实现）。
- **并行工具调用**：受「一条消息一个工具」架构纪律约束（前后端双通道），codex 5.2 的 multi_tool_use 不适用。
- **差量指令注入**：我们宪法每轮全量重建（值恒最新），反而没有 codex 的「指令被压缩稀释」问题。

## 与前两轮的关系

- 第一轮（抗懒）P0/P1 已落地；P1.5 的两项与本文第 5/6 条同物，P2 三项与第 8/10 条同物。
- 第二轮（宪法对比）#3 汇报格式、#5 主动性授权仍留待设计，不受本轮影响。
- 本轮新增可立即动手的：第 1/2/3 条（时间注入、空响应重试、行为遥测）——都是小改，说做就做。
