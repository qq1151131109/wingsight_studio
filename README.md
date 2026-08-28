# Wingsight Studio

CopilotKit 前端骨架：agent 对话经 AG-UI 网关接 Langflow。资产画布（React Flow）后续在此叠加。

## 架构

```
CopilotKit 聊天窗（本应用）
   │  标准 AG-UI RunAgentInput（POST /api/agent）
   ▼
网关 API route（app/api/agent/route.ts）
   - 最后一条 user 消息 → input_value
   - threadId → session_id（复用 langflow 会话记忆）
   - 注入 flow_id / API key（key 不下发浏览器）
   - langflow AG-UI SSE 事件流原样透传
   ▼
Langflow  POST /api/v2/workflows  (mode=stream, stream_protocol=agui)
```

## 启动

```bash
pnpm install
cp .env.example .env.local   # 填下面三个值
pnpm dev                     # http://localhost:3000
```

### .env.local 配置

| 变量 | 说明 |
| --- | --- |
| `LANGFLOW_URL` | langflow 后端地址，默认 `http://localhost:7860` |
| `LANGFLOW_FLOW_ID` | 要对话的 flow UUID（langflow 画布 URL `/flow/<uuid>` 里那段） |
| `LANGFLOW_API_KEY` | langflow API Key（Settings → API Keys 创建） |

### 注意事项

- 聊天窗出字依赖 flow 产生**消息事件**：带 **Agent 组件**或组件内调 `send_message()` 的 flow 才会在 AG-UI 流里产生 `TEXT_MESSAGE` 事件；纯 TextInput→TextOutput 型 flow 只能看到状态事件（不出字）
- 换对话对象 = 换 `LANGFLOW_FLOW_ID`（多 agent 路由以后在网关里按意图分发）
- langflow 侧 flow 的输入组件需为 ChatInput（v2 的 `input_value` 注入按类名 `ChatInput` 识别）

## 验证记录（2026-08-28）

- `pnpm build` 通过
- 端到端：langflow 回声 flow（自包含最小 ChatInput→ChatOutput）→ 网关 → AG-UI 事件流（RUN_STARTED / STATE_SNAPSHOT / STEP_FINISHED / RUN_FINISHED）透传正常

## 后续规划

1. 资产画布（React Flow，参考 langflow 仓库前端实现）
2. 出图结果渲染（消费 AG-UI CUSTOM 事件里的图片文件路径）
3. 多 flow 路由（剧本拆解 / 资产出图 / 宣发文案）
