---
name: wingsight-e2e
description: "为 Wingsight Studio 的改动选对回归验证：按改动域挑出该跑的 scripts/ 回归、判断 mock 还是真跑 LLM、并给出改完后的收尾动作。Use when you changed canvas / chat / agent code in this repo and need to verify it actually works, or when asked which regression covers a change. Not for starting or building the app."
---

# Wingsight Studio 回归验证

这个仓库的正确性由 `scripts/` 下几十个回归脚本守着，不靠单测覆盖率。改完代码先从这里挑最小回归集，不要临时写一次性探针脚本代替。

## 前置：服务真的在跑

```bash
./start_wingsight.sh status      # 期望 agent:8123 + 前端:8008
```

- 前端默认起**生产模式**。凡是回归里用 `window.__wsCanvasStore` / `__wsSetViewport` 的，必须 `./start_wingsight.sh dev`——生产实例不挂这些钩子，跑出来是 `Cannot read properties of undefined`，看着像功能坏了，实际是钩子没挂。新写的脚本别依赖它们，走 HTTP + DOM 断言（范例：`ref-report-reconcile-test.mjs`）。
- 不想打断当前实例就换端口跑：`WS_BASE=http://127.0.0.1:8009 node scripts/<脚本>.mjs`。
- 测试脚本自建 `e2e-*` 临时项目、结束时自删；**崩在半路不会自删**，收尾见下。
- 少数脚本 import 的是 `.ts`，必须 `pnpm dlx tsx` 跑，裸 `node` 会 `ERR_MODULE_NOT_FOUND`（`canvas-read-channel-test.mjs`、`episode-*`、`ref-group-collapse-test.mjs`）。

## 改动域 → 最小回归集

改一处通常只需要 1–2 条，别全量跑。

| 改了什么 | 先跑 |
| --- | --- |
| 画布读写通道 / ops 契约（`lib/canvas/ops.ts`、`store.ts`） | `pnpm dlx tsx scripts/canvas-read-channel-test.mjs` |
| 拆资产、考据简报、参考注入（`agent/skills.py`、`graph.py`） | `cd agent && uv run python test_asset_research_brief.py` |
| 长任务持久化 / 重启恢复（`jobstore.py`、`imagejobs.py`、`eventbus.py`） | `cd agent && uv run python ../scripts/job-recovery-test.py` |
| 考据条目 / 报告 / 大纲契约 | `cd agent && uv run python test_ref_report.py` |
| 参考图管线、调研产物对账、折叠组框 | `node scripts/ref-pipeline-test.mjs`、`node scripts/ref-report-reconcile-test.mjs`、`pnpm dlx tsx scripts/ref-group-collapse-test.mjs` |
| 输入条 @ 引用 / 附件 | `node scripts/mention-inline-test.mjs`（需 dev）、`node scripts/mention-gaps-test.mjs`、`node scripts/attach-race-test.mjs` |
| 聊天消息渲染、间距、长内容、引导打断 | `node scripts/chat-spacing-test.mjs`、`chat-longcontent-test.mjs`、`chat-interrupt-queue-test.mjs` |
| 卡片编辑 / 导出 / 全屏 / 版本历史 / 工具条 | `card-editing-test.mjs`、`card-export-test.mjs`、`doc-fullscreen-test.mjs`、`version-history-test.mjs`、`node-toolbar-select-test.mjs` |
| 图片节点操作层（裁剪/机位/画风闸/宫格） | `node scripts/image-node-ops-test.mjs` |
| 剧本→建卡、分镜表、造型链 | `node scripts/script-to-canvas-test.mjs`、`chat-storyboard-test.mjs`、`look-chain-e2e-test.mjs`、`shot-continuity-test.mjs`（需 dev） |
| 意图路由 / 技能手册 / 系统提示（`agent/prompts/`、`agent/skills/`） | `node scripts/intent-routing-test.mjs`、`node scripts/skill-routing-test.mjs` |
| 工作台布局、侧栏让位 | `node scripts/sidebar-width-reserve-test.mjs` |
| 认证 | `cd agent && uv run python ../scripts/auth-smoke-test.py` |

改 agent 的决策原则、工具 docstring 或技能手册后，`intent-routing` + `skill-routing` 是硬闸：这两条会给出「14/14」「15/15」这样的命中计数，掉下来就是路由真被带偏了。

## mock 还是真跑

- 纯函数与 HTTP 契约类回归是秒级的，改完随手跑。
- 真跑 LLM 的很贵：`intent-routing` 约 6–8 分钟，`skill-routing` 约 5–6 分钟，`ref-adopt-tool` 约 5 分钟。只在改到 agent 行为时才跑，别为了"保险"连跑两遍。
- 出图类多数走 mock，脚本头部注释会写 `REAL=1` / `SKIP_API=1 FIXED_IMAGE=<url>` 这类开关，按注释来。

## 判定的口径

脚本统一用 `check()` 收集结果，结尾 `process.exit(failed.length ? 1 : 0)`，全过打印 `✓✓ …全过（N 项）`。

- 看**退出码 + ✗ 行**，不要只看"跑完了"。
- 头部注释里的断言数（如「107 项」「79 断言」「34 项」）是覆盖面声明；数字变了先怀疑自己动了覆盖范围。

## 收尾

```bash
node scripts/cleanup-test-projects.mjs --dry-run   # 先看残留
node scripts/cleanup-test-projects.mjs             # 真删（走服务端级联删除）
cd agent && uv run python ../scripts/prune-checkpoints.py   # 清 checkpoint 孤儿线程
```

清理必须走服务端 `DELETE /projects/{id}`，不要直接在 SQLite 上写 SQL——会漏掉 `canvases` / `chat_threads` / `chat_messages` / `assets` 的引用。

## 新增脚本

按仓库既有骨架写，读 [references/script-conventions.md](references/script-conventions.md)。
