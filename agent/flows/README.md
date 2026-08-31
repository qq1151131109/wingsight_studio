# agent/flows — langflow 业务工作流（版本化源）

langflow 的 SQLite 是运行时存储；本目录是本项目全部业务 flow 的**导出源**，
跟代码一起版本管理。langflow 仓库（`~/Desktop/langflow`）是上游产品源码，
不放业务资产。

## 流程清单

| 文件 | flow 名 | 用途 | 环境变量 | tweaks 关键节点 |
|---|---|---|---|---|
| `asset-decompose-character.json` | 角色拆解 | 剧本 → 角色 JSON（单类型专用提示词），额外输出 `looks:[{label,description}]` 造型规划（拆解→自动出图链用，juben look 范式） | `LANGFLOW_DECOMPOSE_CHARACTER_FLOW_ID` | `LanguageModelComponent-nFbmO`（system_message） |
| `asset-decompose-scene.json` | 场景拆解 | 剧本 → 场景 JSON（含大纲推断主要发生地） | `LANGFLOW_DECOMPOSE_SCENE_FLOW_ID` | 同上 |
| `asset-decompose-prop.json` | 道具拆解 | 剧本 → 道具 JSON | `LANGFLOW_DECOMPOSE_PROP_FLOW_ID` | 同上 |
| `asset-decompose-costume.json` | 服饰拆解 | 剧本 → 服饰 JSON（核心服装/造型套装，支撑造型一致性） | `LANGFLOW_DECOMPOSE_COSTUME_FLOW_ID` | 同上 |
| `asset-imagegen.json` | 单资产出图 | 资产 JSON（tweaks 注入）→ 豆包出图；`reference_images` 一致性锚点图会下载作参考 | `LANGFLOW_IMAGEGEN_FLOW_ID` | `BatchAssetSheet-img02`（assets_payload） |
| `prompt-optimize.json` | 提示词优化 | 出图提示词 AI 辅助（面板 ✦ 双态）：优化扩写（deepseek-v4-flash）/ 看图反推（gemini-2.5-flash 视觉；deepseek 经 DMX 带大图会丢图勿用） | `LANGFLOW_PROMPT_OPTIMIZE_FLOW_ID` | `PromptOptimize-main`（payload JSON + api_key） |
| `promo-copy.json` | 宣发文案生成 | 飞书宣发资料 → 三路大模型并行 → 合并文案 | `LANGFLOW_SKILLS_JSON`（技能注册内含 flowId） | `PromptTemplate-Writer`（title/count/platform/batch_kind/brief/form） |
| `shotlist-generate.json` | 分镜表生成 | 剧本 → 分镜 rows（景别/运镜/时长/画面/台词） | `LANGFLOW_SHOTLIST_FLOW_ID` | 无（参数走 input_value 文本头注入） |

注：三个分类型拆解 flow 由 agent 三路并发调用（`/assets/decompose`），各自
输出小、按类型定制提示词、单类失败不拖累其他；未配置三类变量时回落到
合并版 `asset-decompose.json`（`LANGFLOW_DECOMPOSE_FLOW_ID`）。
根 `.env.local` 里还有一个 `LANGFLOW_FLOW_ID`（fa971fe1…），指向的 flow
已从 langflow 删除，属历史遗留，待清理。

## 直连端点（前端不经聊天 LLM 调 flow）

| 端点 | 复用 flow | 说明 |
|---|---|---|
| `POST /storyboard/generate` + `GET /storyboard/generate/{jobId}` | 分镜表生成 | 剧本(+镜头数/时长/视觉风格/资产名单) → rows。**异步任务**：POST 返回 jobId，前端轮询 |
| `POST /assets/decompose` + `GET /assets/decompose/{jobId}` | 三路拆解（或合并版） | 剧本(+已有资产名单) → 类型化资产清单。**异步任务**：三路 flow 并发也常超 30s，阻塞等完必 500 |
| `POST /storyboard/images` + `GET /storyboard/images/{jobId}` | 单资产出图 | 分镜行批量出图：起任务立即返回 jobId，前端轮询（每张完成即写回任务状态）。**必须异步**——Next 同源代理约 30s 掐断长请求，阻塞等完必 500 |

## 导出（langflow → 本目录）

```bash
source ../.env.local   # 取 LANGFLOW_API_KEY
./export.sh <flow_id> <文件名.json>
```

## 导入（本目录 → langflow，重建环境用）

```bash
source ../.env.local
curl -s --compressed -X POST http://localhost:7860/api/v1/flows/ \
  -H "Content-Type: application/json" -H "x-api-key: $LANGFLOW_API_KEY" \
  -d @shotlist-generate.json
# 返回体里的 id 即新 flow id，写回 .env.local 对应变量
```

## 约定

- 导出时剥除 `_frontend_node_flow_id` / `_frontend_node_folder_id` 两个前端
  元数据（export.sh 已处理），避免残留旧 flow 引用
- agent 经 **v1 阻塞 API**（`/api/v1/run/{flow_id}`）调用，参数用 tweaks 按
  **节点 id** 注入；Prompt 模板变量只收字符串（传 int 会 500）
- 修改 flow 后：先在 langflow UI 调试，再 `export.sh` 回写本目录，保持两处一致
