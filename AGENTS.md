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
- `langflow/` langflow 引擎源码（自有 fork 经 `git subtree --squash` 并入，含 DMXAPI 出图修复、batch_asset_sheet 定制等补丁；已 tsconfig/eslint exclude）。重建环境：`./scripts/setup-langflow.sh`；更新 fork：`git subtree pull --prefix=langflow langflow main --squash`
- `scripts/` 端到端测试（node 集成测试 + auth 冒烟）+ `setup-langflow.sh`（langflow 环境重建 + flows 导入 + flow id 回写）

## 常用命令

```bash
./start_wingsight.sh            # 一键 start/stop/status（agent:8123 + 前端:8008，日志在 logs/）
pnpm dev --port 8008            # 前端
cd agent && uv run uvicorn main:app --port 8123 --host 127.0.0.1   # agent
pnpm exec tsc --noEmit && pnpm exec eslint components lib app       # 检查
node scripts/agui-client-test.mjs               # 两轮工具调用闭环（需 agent 在跑）
node scripts/script-to-canvas-test.mjs          # 剧本→建卡全链路
node scripts/shotlist-resume-compose-test.mjs   # 分镜表断点恢复/补缺图/一键成片（自建测试项目+mock，不出真实图）
python agent/auth-smoke-test.py                 # 认证冒烟
./scripts/setup-langflow.sh                     # langflow 环境重建/首个部署（装 venv → 起 7860 → 导 flows → flow id 回写 .env.local）
```

## 架构铁律

- **不做 fallback、不兼容历史版本**：除非用户主动提出，失败就报错让用户决策，不要静默降级/兜底方案；改数据结构、API、字段时直接改到位并迁移，不保留旧字段/旧格式的兼容读取（历史遗留值一律清除而非静默叠加）
- **画风闸（juben image_style_required 范式）**：出图类操作（分镜批量出图 / 资产卡 AI 出图 / 拆解自动出图链）要求画风已选——唯一入口 = 底部坞「画风」（全局）。无画风只拦视觉产物，文字流程（拆解/分镜表生成）与聊天自由出图不拦。前端三入口拦截 + `start_decompose_job` 兜底（visual_style 为空记 images_note）。分镜表卡原 visualStyle 字段已无 UI，遗留值静默叠加不参与闸
- **图生图参考（输入条直连管线 directImagegen）**：本卡已有图自动并入参考首位（面板亮「本卡原图」chip）——「在带图的卡上出图 = 改这张图」；参考序列 = 本卡原图 + @引用/上游连线卡（去重 ≤4，refIds 生成时自愈已删卡）。显式引用（@/连线）存在却一张可用图都没有时**明报拦下**（不发任务，卡上出错误说明），不静默降级文生图（孝庄太后项目踩坑：引用空卡+已删卡被静默丢，纯文生图被当成「没参考」）；空卡无引用的纯文生图不受影响
- 前端与 agent 间一切流量走**同源代理**（`next.config.ts` rewrites：`/agent-service*`、`/api/v1/*` → 127.0.0.1:8123）。密钥（AGENT/LANGFLOW/DMX key）只存在根目录 `.env.local`（agent 经 dotenv 读取），**绝不下发浏览器、绝不提交**
- 主 Agent 是**瘦编排者**：系统提示只放"宪法"（`graph.py` SYSTEM_PROMPT），任务知识一律放 Langflow 技能或工具 docstring。新增能力 = 新工具/技能，不是加提示词
- **LLM 生成类能力一律走 Langflow**（做成 flow，不在 agent 代码里直调模型/写死提示词）；唯一例外是聊天主循环本身（`graph.py` LangGraph 直连 DeepSeek）。约定与清单见下节「Langflow 工作流」
- **前端工具调用优先路由**：模型消息里混有前端/后端工具调用时必须 END 等浏览器执行（含后端调用的消息进 ToolNode 会返回 invalid tool 破坏交替）；`graph.py` 的 `_unanswered_frontend_calls` 与 `_sanitize_messages_for_model` 是历史交替守卫，勿删
- @ag-ui/client 0.0.57：公共 API 是 `runAgent()`（自动带 runId/管理 agent.messages），误用 `run()` 会 422；nodeType 字段驱动 React Flow 渲染器选择

## Langflow 工作流（LLM 生成能力全走这里）

业务 flow 是**纯链式**（非 Agent 组件），只经 **v1 阻塞 API** 调用（agui 流不产 TEXT_MESSAGE）。

- **版本化源在本项目 `agent/flows/`**（README 有 flow 清单 / flow id / tweaks 节点对照表）；langflow 自己的 SQLite 只是运行时存储。**引擎源码 subtree 并入 `langflow/`**（fork：github.com/qq1151131109/langflow；flow id 是导入时生成的 UUID，换机器导入后会变——用 `scripts/setup-langflow.sh` 自动导 flow 并回写 `.env.local`）
- **调用**：`skills.run_flow_blocking`（`POST /api/v1/run/{flow_id}`，超时 300s）；flow id 存根目录 `.env.local` 的 `LANGFLOW_*_FLOW_ID`。参数两种注法——tweaks 按**节点 id** 注入（Prompt 模板变量只收**字符串**，传 int 会 500），或拼进 `input_value` 文本头（分镜表生成即此式，不怕节点重建换 id）
- **改 flow**：UI（localhost:7860）里改并**保存** → 下一次调用立即生效（运行时现读 DB，无需重启）；然后 `cd agent/flows && ./export.sh <flow_id> <文件>.json` 回写本目录保持一致。注意：删节点重建会换节点 id，代码里按 id 注参的（宣发文案 `PromptTemplate-Writer`、出图 `BatchAssetSheet-img02`）要同步；改自定义组件源码需重启 langflow（模块缓存）
- **新建能力**：UI 画 flow → 调试 → `export.sh` 收进 `agent/flows/` → flow id 记入 `.env.local` → agent 加薄端点/技能包装（参考 `POST /storyboard/generate`）

## 已知坑

- 画布基础交互（对标 Figma）：左拖空白=框选（`panOnDrag={[1]}` 是前提，另配 `selectionMode=Partial`）、中键/Space+拖/滚轮/双指滚动=平移（`panOnScrollSpeed={1}` 物理跟速）、⌘+滚/捏合=缩放（`zoomOnScroll=false`+`panOnScroll` 常开；`zoomActivationKeyCode` 默认 mac=Meta，按住即把 wheel 处理器重绑回 d3 缩放）、Alt+拖卡=原位克隆（store 的 `altDragClone` 改道拖动帧，注意"先改道后清表"）、双击空白=「添加节点」选择器、右键空白=上传/添加节点/撤销/重做/粘贴菜单（reference 产品范式）。滚轮**不做鼠标/触控板设备判定**（按 deltaY 量级猜设备的启发式会被触控板快扫/惯性步进误判成鼠标轮，平移中途误缩放；`onWheelCapture` 只留 nowheel 动态化——可滚动容器滚内容，不可滚动的现场摘类放行画布平移）。右键拖不做平移（macOS contextmenu 在 mousedown 即触发，会和右键菜单打架）。库级陷阱 2：RF 的 `onPointerCancel` 不清 `userSelectionRect`，pointercancel/漏 pointerup 会卡死框选——`CanvasView` 的 `SelectionGuard` 窗口级兜底，勿删
- Langflow 的 SSRF 白名单在 `langflow/.env`（仓库内，随 fork 走）的 `LANGFLOW_SSRF_ALLOWED_HOSTS`（含 dmxapi/amazonaws/deepseek/volces 等——volces 是 seedream 系出图产物 URL 的落域，缺了在保存图片一步报错）——出图报 Broken pipe / blocked IP 时先查这里，改后需重启 langflow
- 出图模型/分辨率切换：目录唯一事实源 `agent/models.py`（DMX 实探验证，双路径 generate+edit 通才收录；档位按 flow 真实计算尺寸探验——16 像素网格，16:9 4K=3840x2160），`GET /models/image` 下发。三级参数：项目级默认（`meta.imagegen`，底部坞「出图」）→ 卡片级覆盖（`data.gen`，PromptBar 模型 chip / 分镜卡出图设置写入；请求体里镜头级 params 赢过请求级）→ 聊天工具 model/resolution 入参。分镜画幅 `data.aspect`（ShotGenSettings，6 档，资产设定图不开放——幅面与布局契约绑定）；每镜候选张数 `data.genCount`（1/2/4，候选聚合成行图卡的 imageUrls 变体，任务 rid 带 `#k` 后缀）。非法组合整批 400 点名镜头；seedream 4.5 有最小像素约束（4:3 幅面 2K 档不够，见 models.py 注）
- 文本模型三通道多目录（剧本/分镜表/拆解/提示词优化等 LLM 文字生成）：同文件唯一事实源（TEXT_MODELS，每条目带 `provider` 字段），`GET /models/text` 下发。glm-5.3-flash（出厂默认）/glm-5.3 → 智谱官方（langflow 全局变量 OPENAI_BASE_URL/OPENAI_API_KEY）；deepseek-v4-flash/v4-pro/v4-flash-vision-exp → DeepSeek 官方（DEEPSEEK_API_KEY，fork 在 model_metadata.py+instantiation.py 加了 DeepSeek provider，缺省 api.deepseek.com）；gpt-5.6-luna/gemini-3.7-flash → DMX（OPENAI_COMPATIBLE_*）。卡片级覆盖 `data.textModel`——chip 在**选中剧本/分镜表/文本卡后的下方输入条**（空=flow 出厂 glm-5.3-flash；剧本卡「拆分镜表」会把选择带给新建分镜表卡），端点透传：分镜表生成 `model` / 拆解 `text_model` / 提示词优化 `model` / 文本撰写 `model`（`/text/rewrite`，文本卡/剧本卡「撰写」直连管线——结果预览采用才覆盖正文，不再经聊天主循环），非法 id 400 明报。注入走 tweaks **组件名**：skills 经 `models.text_model_tweaks()` 同时注 model_name+provider（通道路由，不烧节点 id；提示词优化已拆双 flow——扩写态走原生链同此，看图反推为固定 gemini 视觉不开放切换）；聊天改分镜表不经此（聊天主循环走 `AGENT_MODEL`=glm-5.3-flash+AGENT_VISION_ENABLED=1）
- node 集成/E2E 测试直连 agent API 需认证（`AUTH_ENABLED=true`）：登录 `POST /api/v1/auth/token`（form 表单，admin + `.env.local` 的 `AUTH_PASSWORD`），脚本侧 fetch 带 Bearer、Playwright 侧 `context.addInitScript` 预置 localStorage `wingsight_studio_token`（先例 `scripts/shotlist-resume-compose-test.mjs` 头部）
- `references/` 是外部参考项目（已 tsconfig exclude + gitignore，勿编译勿提交）；`agent/data/`、`agent/static/assets/`、`agent/static/thumbs/`、`logs/` 均为运行时产物。图片展示分两级：小尺寸一律走 `/agent-service/thumbs/{stem}.webp`（落盘时 ffmpeg 产 512px webp，`agent/thumbs.py`；缺失时端点现场自愈生成，存量可跑 `cd agent && uv run python backfill_thumbs.py` 预热；前端 `lib/asset-thumb.ts` 的 `assetThumbUrl` 换算），Lightbox 放大/下载才用原图；`/assets` 与 `/thumbs` 均打 `Cache-Control: immutable`（文件名随机 hex 内容不可变），裸 FileResponse 不做 304 协商，别指望 etag
- 远程访问经隧道（bore/ddnsto），`allowedDevOrigins` 已放行，改访问域名需同步 next.config.ts
- xyflow 12.11 的 `fitView` prop **不是只在挂载时生效**：StoreUpdater 监听它，prop 值一旦翻转就置 `fitViewQueued` 重新 fit（空画布建第一卡会怼到 maxZoom）。要"只挂载时 fit"就用 `useState` 初值冻结（`CanvasView` 的 `fitOnMount`），勿写回随状态变化的表达式
- xyflow 新节点首帧带 **`visibility: hidden`**（等 ResizeObserver 测量出尺寸才翻 visible），此窗口内对节点内元素调 `focus()` **静默失败**（无报错无焦点事件）。要"建卡即输入"必须逐帧重试到 `document.activeElement` 落位（`nodes.tsx` 的 `focusWhenVisible`），裸 `autoFocus`/mount effect 一次 focus 都会丢
- Next 同源代理对长请求约 **30s 掐断**（rewrite 转发的超时，前端表现 500）。凡超 30s 的直连能力必须做**异步任务 + 轮询**（先例：`POST /storyboard/images` 返回 jobId + `GET /storyboard/images/{jobId}`），不能阻塞等 flow 跑完
- 改 `agent/graph.py` 系统提示后必须重启 agent（uvicorn 无 --reload）；改 langflow 自定义组件源码后须重启 langflow（模块缓存）

