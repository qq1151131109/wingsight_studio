# Wingsight Studio

AI 影视创作无限画布工作台：**React Flow 画布 + CopilotKit 聊天 + LangGraph 主 Agent**。
用户直接在画布上创作（剧本/角色/图片卡片、连线），Agent 能看见画布、也能通过工具调用直接操作画布；批量生成管线（宣发文案、资产设定图）经 Langflow 技能执行。

## 架构

```
Next.js 前端（8002）
├─ React Flow 无限画布（zustand；多项目服务端持久化，localStorage 作离线缓存）
│   节点：note 便签 / script 剧本 / character 角色 / storyboard 分镜 / image 图片
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

打开 http://localhost:8002 ：首页项目仪表盘（新建/搜索/协作者/删改）→ 点击项目卡进入画布：
双击画布加便签 / 工具条加卡片 / 连线拖到空白处快速建卡 / 右键呼出四态菜单（空白：加卡/粘贴/全选；节点与多选：复制/打成一组/删除；连线：删除）/ 右侧聊天让助手建卡连线、调技能。左侧栏房子图标回首页。

画布快捷键：`Cmd/Ctrl+Z` 撤销、`Shift+Cmd/Ctrl+Z` 或 `Ctrl+Y` 重做、`Cmd/Ctrl+C/V` 复制粘贴选中卡（连线随行）、`Cmd/Ctrl+A` 全选、粘贴系统剪贴板图片直接落成图片卡（经 `/agent-service/assets` 上传）。文本编辑中不拦截。

其他画布能力：拖拽图片或 `.txt`/`.md` 文件进画布直接建卡（图片走上传、md 当剧本、txt 当便签）；框选多卡后可打成分组框（子卡跟随移动，删除分组自动解散并保留子卡）；节点拖拽带 16px 网格吸附。

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
  {"op": "add_node", "nodeType": "note|script|character|storyboard|image", "title": "…", "body": "…", "position": {"x":0,"y":0}},  // position 可省，自动布局；分镜卡可带 shotSize（景别）/ duration（时长）
  {"op": "update_node", "id": "n_xxx", "title": "…", "body": "…"},
  {"op": "delete_nodes", "ids": ["n_xxx"]},
  {"op": "connect_nodes", "fromId": "n_xxx", "toId": "n_xyy"},
  {"op": "set_viewport", "x": 0, "y": 0, "zoom": 1},
  {"op": "group_nodes", "ids": ["n_xxx", "n_xyy"], "title": "分组名"}  // 把多张卡收进分组框
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
- 画布体验 P0/P1（撤销重做/复制粘贴/粘贴图片、分镜卡、视口双向同步）：tsc + eslint + next build 全绿 ✓
- 画布体验 P2（右键菜单四态、拖拽文件导入、分组框、网格吸附、Cmd+A）：tsc + eslint + next build 全绿 ✓（自动化浏览器后端不可用，交互细节待人工冒烟）

## 用户与认证（移植自 juben / Wingsight 主项目）

默认 `AUTH_ENABLED=false`：全链路匿名 admin，单人使用零登录（与旧版行为一致）。

开启多人模式：`.env.local` 设 `AUTH_ENABLED=true`，配置 `AUTH_USERNAME` / `AUTH_PASSWORD`
（留空则首次启动自动生成并回写）与 `AUTH_TOKEN_SECRET`。能力：

- JWT（7 天）+ Argon2 密码哈希；env 管理员 + DB 用户双轨登录；角色 admin / member
- API Key（`wingsight-` 前缀 Bearer，SHA-256 落库，明文仅创建时返回一次）
- 项目归属隔离：owner / 协作者可见可编辑，他人一律 404（防探测枚举）；
  存量项目（owner=default）全员可见，向后兼容
- 协作者共享：owner 在项目上增删协作者（按用户名）
- 用户管理：`/api/v1/admin/users`（不能停用自己 / 不能降级最后一个 admin）
- 自助注册默认关闭（`AUTH_REGISTER_OPEN=true` 开放）

前端：`/` 项目仪表盘首页（搜索/排序/建删改名/协作者管理，进入 `/project/[pid]` 画布）；
`/admin` 管理后台（用户管理 + API Key，仅 admin 可见入口）；`/login` `/register` + AuthGate 守卫
（关闭认证时自动跳过）；API 调用统一走 `apiFetch`（自动 Bearer、401 回登录）；Agent 请求带 Bearer header。

已知边界：AG-UI 根端点与 `/assets` 静态文件未鉴权（资源名为随机 hex，
等价 capability URL）。后端冒烟测试：`cd agent && uv run python ../scripts/auth-smoke-test.py`（34 项）。

## 已知边界

- 设计系统移植自 juben（米黄纸感 / 砖红 accent / Fraunces + Noto Serif SC），暗色跟随系统或左下角手动切换
- 撤销/重做与复制/粘贴为进程内快照栈（上限 50，刷新即清；项目切换时历史栈自动清空）
- `set_viewport` 视口已双向同步（agent 可带用户看画布，用户平移回写供持久化）

## 后续规划

1. 平台余项：项目 ZIP 导入导出（juben 有实现可搬）、公开只读分享链接（juben 也没有，需自建）、用量统计页
2. 画布体验余项：对齐辅助线、悬停工具条、撤销/重做的工具条按钮
3. `@引用` token（提示词引用上游卡/参考图）→ 角色一致性管线（三视图 + 接力帧）
4. 分镜卡批量生成画面；多技能意图路由
