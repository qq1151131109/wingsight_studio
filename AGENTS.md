<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Wingsight Studio

AI 影视创作无限画布工作台：React Flow 画布 + CopilotKit 聊天 + LangGraph 主 Agent（Python）+ Langflow 技能。设计系统移植自 juben（米黄纸感 oklch token，见 `app/globals.css` 顶部 `@theme`）。

## 结构

- `app/` Next.js 16 前端（Turbopack）。`agent-provider.tsx` 注册自管 Agent；`page.tsx` = 活动栏 + 画布 + 聊天侧栏
- `components/canvas/` 画布（`CanvasView`、`nodes.tsx` 自定义卡、`CanvasShortcuts` 撤销/粘贴、`AssetTray` 素材库面板 + 自动入库、`DirectorPanel` 导演台（语汇来自 `agent/camera.py` 经 `/agent-service/camera-vocab` 下发，编译成 body 的【摄影】段））；`components/copilot/` 桥接（`CanvasAgentBridge` 读写通道、`ProjectManager` 项目同步）；`components/shell/ActivityBar`
- `lib/canvas/store.ts` zustand 画布状态（**服务端为唯一事实源**，localStorage 仅离线缓存；`addNode` 自动从 `data.nodeType` 推导 `node.type`，漏推导会渲染成空白默认节点）；`lib/canvas/ops.ts` canvas_ops 契约与校验
- `agent/` Python 服务（FastAPI + LangGraph + ag-ui-langgraph，uv 管理）：`graph.py` 主图与系统提示、`skills.py` Langflow 调用（v1 阻塞 API + tweaks）、`projects.py` 项目/画布/聊天/素材库 SQLite、`compose.py` ffmpeg 视频拼接（compose 卡直连，不经 LLM）、`auth*.py` 认证、`camera.py` 摄影语汇库
- `scripts/` 端到端测试（node 集成测试 + auth 冒烟）

## 常用命令

```bash
./start_wingsight.sh            # 一键 start/stop/status（agent:8123 + 前端:8002，日志在 logs/）
pnpm dev --port 8002            # 前端
cd agent && uv run uvicorn main:app --port 8123 --host 127.0.0.1   # agent
pnpm exec tsc --noEmit && pnpm exec eslint components lib app       # 检查
node scripts/agui-client-test.mjs               # 两轮工具调用闭环（需 agent 在跑）
node scripts/script-to-canvas-test.mjs          # 剧本→建卡全链路
python agent/auth-smoke-test.py                 # 认证冒烟
```

## 架构铁律

- 前端与 agent 间一切流量走**同源代理**（`next.config.ts` rewrites：`/agent-service*`、`/api/v1/*` → 127.0.0.1:8123）。密钥（AGENT/LANGFLOW/DMX key）只存在根目录 `.env.local`（agent 经 dotenv 读取），**绝不下发浏览器、绝不提交**
- 主 Agent 是**瘦编排者**：系统提示只放"宪法"（`graph.py` SYSTEM_PROMPT），任务知识一律放 Langflow 技能或工具 docstring。新增能力 = 新工具/技能，不是加提示词
- Langflow 拆解/出图 flow 是纯链式（非 Agent 组件），只经 **v1 阻塞 API** 调用（agui 流不产 TEXT_MESSAGE）。参数用 tweaks 按**节点 id**注入；Prompt 模板变量字段只收**字符串**（传 int 会 500）
- **前端工具调用优先路由**：模型消息里混有前端/后端工具调用时必须 END 等浏览器执行（含后端调用的消息进 ToolNode 会返回 invalid tool 破坏交替）；`graph.py` 的 `_unanswered_frontend_calls` 与 `_sanitize_messages_for_model` 是历史交替守卫，勿删
- @ag-ui/client 0.0.57：公共 API 是 `runAgent()`（自动带 runId/管理 agent.messages），误用 `run()` 会 422；nodeType 字段驱动 React Flow 渲染器选择

## 已知坑

- 画布基础交互（对标 Figma）：左拖空白=框选（`panOnDrag={[1]}` 是前提，另配 `selectionMode=Partial`）、中键/Space+拖/双指滚动=平移、⌘+滚/捏合=缩放、Alt+拖卡=原位克隆（store 的 `altDragClone` 改道拖动帧，注意"先改道后清表"）、双击空白=「添加节点」选择器、右键空白=上传/添加节点/撤销/重做/粘贴菜单（reference 产品范式）。滚轮语义按设备启发式切换（`CanvasView` 的 `onWheelCapture`：鼠标轮离散步进=缩放、触控板连续小步进=平移）。右键拖不做平移（macOS contextmenu 在 mousedown 即触发，会和右键菜单打架）。库级陷阱 2：RF 的 `onPointerCancel` 不清 `userSelectionRect`，pointercancel/漏 pointerup 会卡死框选——`CanvasView` 的 `SelectionGuard` 窗口级兜底，勿删
- Langflow 的 SSRF 白名单在 `~/Desktop/langflow/.env` 的 `LANGFLOW_SSRF_ALLOWED_HOSTS`（含 dmxapi/amazonaws/deepseek 等）——出图报 Broken pipe / blocked IP 时先查这里，改后需重启 langflow
- `references/` 是外部参考项目（已 tsconfig exclude + gitignore，勿编译勿提交）；`agent/data/`、`agent/static/assets/`、`logs/` 均为运行时产物
- 远程访问经隧道（bore/ddnsto），`allowedDevOrigins` 已放行，改访问域名需同步 next.config.ts
- xyflow 12.11 的 `fitView` prop **不是只在挂载时生效**：StoreUpdater 监听它，prop 值一旦翻转就置 `fitViewQueued` 重新 fit（空画布建第一卡会怼到 maxZoom）。要"只挂载时 fit"就用 `useState` 初值冻结（`CanvasView` 的 `fitOnMount`），勿写回随状态变化的表达式
- 改 `agent/graph.py` 系统提示后必须重启 agent（uvicorn 无 --reload）；改 langflow 自定义组件源码后须重启 langflow（模块缓存）

