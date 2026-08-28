# Wingsight Studio

AI 影视创作无限画布工作台：**React Flow 画布 + CopilotKit 聊天 + LangGraph 主 Agent**。
用户直接在画布上创作（剧本/角色/图片卡片、连线），Agent 能看见画布、也能通过工具调用直接操作画布；批量生成管线（宣发文案、资产设定图）经 Langflow 技能执行。

## 架构

```
Next.js 前端（8002）
├─ React Flow 无限画布（zustand + localStorage 持久化）
│   节点：note 便签 / script 剧本 / character 角色 / image 图片占位
├─ CopilotKit 1.69（v1 SDK，selfManagedAgents + HttpAgent）
│   ├─ 读通道：useCopilotReadable + useCoAgent 共享 canvasSummary（画布摘要 ground truth）
│   └─ 写通道：useCopilotAction("canvas_ops", available:"remote")（浏览器执行）
        ↓ AG-UI 协议（POST http://localhost:8123）
agent/ LangGraph 服务（FastAPI + ag-ui-langgraph）
├─ chat_node：模型工具循环（deepseek 等 OpenAI 兼容端点，env 可配）
│   ├─ 前端工具 canvas_ops：模型发起 TOOL_CALL → 本轮结束 → 浏览器执行 applyOps
│   │   → ToolMessage 随下一轮回传 → 模型基于结果续跑（连线等后续操作）
│   └─ 后端工具：list_langflow_skills / run_langflow_skill
└─ Langflow 技能（7860）：宣发文案生成、剧本转资产设定图（LANGFLOW_SKILLS_JSON 配置）
```

## 启动

```bash
# 1. 前端（8002 端口）
pnpm install
cp .env.example .env.local   # 填 AGENT_API_KEY 等
pnpm dev --port 8002

# 2. Agent 服务（8123 端口）
cd agent && uv sync
uv run uvicorn main:app --port 8123 --host 127.0.0.1
```

打开 http://localhost:8002 ：双击画布加便签 / 工具条加卡片 / 右侧聊天让助手建卡连线、调技能。

### .env.local 配置

| 变量 | 说明 |
| --- | --- |
| `AGENT_BASE_URL` / `AGENT_MODEL` / `AGENT_API_KEY` | 主 Agent 的 LLM（OpenAI 兼容端点，DeepSeek/GLM/Qwen 均可） |
| `LANGFLOW_URL` / `LANGFLOW_API_KEY` | Langflow 服务（技能用；不配技能可不填） |
| `LANGFLOW_SKILLS_JSON` | 技能表：`{"技能名": {"flowId": "...", "description": "..."}}` |
| `NEXT_PUBLIC_AGENT_URL` | 前端连 agent 服务的地址，默认走同源代理 `/agent-service`（next.config.ts rewrites → 127.0.0.1:8123），本地和远程隧道访问都无需修改 |

### 远程访问（ddnsto 等隧道）

通过隧道域名访问 dev 服务器时，Next.js 默认会拒绝非 localhost 来源的 dev 资源请求（403）。
`next.config.ts` 的 `allowedDevOrigins` 已放行 `*.ddnsto.net`，其他隧道域名按需追加。
Agent 走同源代理 `/agent-service`，隧道访问无需为 8123 单独开隧道。

## canvas_ops 契约（Agent 写画布）

```jsonc
[
  {"op": "add_node", "nodeType": "note|script|character|image", "title": "…", "body": "…", "position": {"x":0,"y":0}},  // position 可省，自动布局
  {"op": "update_node", "id": "n_xxx", "title": "…", "body": "…"},
  {"op": "delete_nodes", "ids": ["n_xxx"]},
  {"op": "connect_nodes", "fromId": "n_xxx", "toId": "n_xyy"},
  {"op": "set_viewport", "x": 0, "y": 0, "zoom": 1}
]
```

实现见 `lib/canvas/ops.ts`（校验从严：非法项记入 errors 不中断整批），工具结果返回 `{applied, createdIds, errors}`。

## 集成测试

```bash
node scripts/agui-client-test.mjs   # 需 agent 服务已启动；验证两轮工具调用闭环
```

## 验证记录（2026-08-28）

- 两轮工具调用闭环：建卡 → TOOL_CALL 事件 → ToolMessage 回传 → connect_nodes 续跑 ✓（`scripts/agui-client-test.mjs`）
- 画布摘要 ground truth 注入（STATE_SNAPSHOT / RAW 事件确认）✓
- Langflow 技能调用：list_langflow_skills / run_langflow_skill 端到端（含 404/参数错误优雅降级）✓

## 已知边界

- 设计系统移植自 juben（米黄纸感 / 砖红 accent / Fraunces + Noto Serif SC），暗色跟随系统或左下角手动切换
- agent 会话记忆为进程内 MemorySaver，重启即失（后续可换 SqliteSaver）
- 出图结果渲染进 image 节点、多画布、服务端持久化：待做

## 后续规划

1. 出图结果渲染（run_langflow_skill 返回图片路径 → image 卡片 + 生成中状态）
2. 画布 ops 扩展（分组、批量布局、分镜卡类型）
3. 会话持久化（SqliteSaver）+ 多技能意图路由
