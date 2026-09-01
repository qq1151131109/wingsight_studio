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
| `asset-imagegen.json` | 单资产出图 | 资产 JSON（tweaks 注入）→ 出图；`reference_images` 一致性锚点图会下载作参考。布局契约四类：`character` 四格定妆 / `scene` 无人空镜勘景 / `prop` 单件平铺（服饰卡按此契约）/ `shot` 剧情剧照（分镜行出图，有人物有剧情）。模型分流在组件内按模型名前缀：`doubao-seedream-5*` → `/v1/responses` 多图融合（`generate_image_responses`，2~10 参考图合成一张）；`gemini*` → v1beta `generateContent`（`generate_image_gemini`，Nano Banana 2：imageConfig 精确幅面/分辨率 1K/2K/4K、参考图 inlineData、认证 x-goog-api-key——Bearer 会挂起；**DMX 网关 aspectRatio 按「高:宽」解析，原语内已做翻转补偿，DMX 修正后需移除**）；其余走 OpenAI images 接口 | `LANGFLOW_IMAGEGEN_FLOW_ID` | `BatchAssetSheet-img02`（assets_payload / model_name / resolution） |
| `prompt-optimize-text.json` | 提示词优化-扩写 | 出图提示词 AI 辅助（✦ 优化扩写态）：当前提示词 → 扩写成完整出图提示词。纯原生链（ChatInput→LLM→ChatOutput），prompt 在 system_message，参数走 input_value 文本头 | `LANGFLOW_PROMPT_OPTIMIZE_TEXT_FLOW_ID` | `LanguageModelComponent`（model_name 覆盖文本模型） |
| `prompt-optimize-image.json` | 提示词优化-看图反推 | 出图提示词 AI 辅助（✦ 看图反推态）：参考图 → 反推出图提示词。单用途自定义组件 `PromptImageReverseComponent`（gemini-2.5-flash 视觉经 DMX；deepseek 带大图会丢图勿用） | `LANGFLOW_PROMPT_OPTIMIZE_IMAGE_FLOW_ID` | `PromptOptimize-main`（payload JSON + api_key） |
| `style-reverse.json` | 画风反推 | 我的画风：参考图 → 画风描述（只提炼可复用画风，不带主体/构图）。单用途自定义组件 `StyleReverseComponent`（gemini 视觉经 DMX），与看图反推同范式不同提示词 | `LANGFLOW_STYLE_REVERSE_FLOW_ID` | `StyleReverse-main`（payload JSON + api_key） |
| `text-write.json` | 文本撰写 | 画布文本卡/剧本卡「撰写」直连管线：指令+正文+参考上下文 → 处理后全文（续写保留原文、改写保原意、空正文直接创作）。卡片级 `data.textModel` 在此生效 | `LANGFLOW_TEXTWRITE_FLOW_ID` | `LanguageModelComponent`（model_name 覆盖文本模型） |

注：两态由前端按按钮态显式路由（请求体 `mode: optimize\|reversal`，agent
端点校验各态必填项），不再混装单 flow——旧双态组件 `PromptOptimizerComponent`
（组件内按 prompt 空否判态）已废弃删除。
| `promo-copy.json` | 宣发文案生成 | 飞书宣发资料 → 三路大模型并行 → 合并文案 | `LANGFLOW_SKILLS_JSON`（技能注册内含 flowId） | `PromptTemplate-Writer`（title/count/platform/batch_kind/brief/form） |
| `shotlist-generate.json` | 分镜表生成 | 剧本 → 分镜 rows（景别/运镜/时长/画面/台词） | `LANGFLOW_SHOTLIST_FLOW_ID` | 无（参数走 input_value 文本头注入） |
| `topic-triage.json` | 选题研判 | 原始信号条目 → 聚类+判垂类(history/crime)+价值排序的短名单（选题池管线第 1 步） | `LANGFLOW_TOPIC_TRIAGE_FLOW_ID` | 无（载荷走 input_value JSON） |
| `topic-research-plan.json` | 选题调研规划 | 热点+研判线索 → ≤4 条覆盖证据面的检索查询（第 2 步） | `LANGFLOW_TOPIC_PLAN_FLOW_ID` | 无（同上） |
| `topic-research-followup.json` | 选题调研追查 | 已执行检索记录 → 判断证据是否足够，不足给 ≤3 条追加查询（第 3 步） | `LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID` | 无（同上） |
| `topic-verdict.json` | 选题两级结论 | 研判线索+调研证据 → 建议卡或观察卡（证据驱动，信源纪律；第 4 步） | `LANGFLOW_TOPIC_VERDICT_FLOW_ID` | 无（同上） |

注：三个分类型拆解 flow 由 agent 三路并发调用（`/assets/decompose`），各自
输出小、按类型定制提示词、单类失败不拖累其他；未配置三类变量时回落到
合并版 `asset-decompose.json`（`LANGFLOW_DECOMPOSE_FLOW_ID`）。
根 `.env.local` 里还有一个 `LANGFLOW_FLOW_ID`（fa971fe1…），指向的 flow
已从 langflow 删除，属历史遗留，待清理。

## 直连端点（前端不经聊天 LLM 调 flow）

| 端点 | 复用 flow | 说明 |
|---|---|---|
| `POST /storyboard/generate` + `GET /storyboard/generate/{jobId}` | 分镜表生成 | 剧本(+镜头数/时长/视觉风格/资产名单) → rows。**异步任务**：POST 返回 jobId，前端轮询 |
| `POST /topics/refresh`（轮询 `GET /topics` 的 refreshing） | 选题四 flow | 选题池策展刷新：材料窗口采集(80 条) → 研判 → 逐簇迭代取证 → 两级结论，单飞后台任务，一轮约 15 分钟。编排见 `agent/topic_pool.py`，路由 `agent/topic_routes.py` |
| `POST /assets/decompose` + `GET /assets/decompose/{jobId}` | 三路拆解（或合并版） | 剧本(+已有资产名单) → 类型化资产清单。**异步任务**：三路 flow 并发也常超 30s，阻塞等完必 500 |
| `POST /storyboard/images` + `GET /storyboard/images/{jobId}` | 单资产出图 | 分镜行批量出图：起任务立即返回 jobId，前端轮询（每张完成即写回任务状态）。**必须异步**——Next 同源代理约 30s 掐断长请求，阻塞等完必 500 |
| `POST /styles/reverse` + `GET /styles/reverse/{jobId}` | 画风反推 | 我的画风「从参考图反推」：起任务返回 jobId，前端轮询。路由 `agent/style_routes.py`（CRUD 同文件），任务机制同 prompt-optimize |

出图类端点（storyboard/images、assets/decompose）均可带 `params: {model?, resolution?}`
（项目级出图设置，目录与校验见 `agent/models.py`，`GET /models/image` 下发），
非法组合 400 明报；合法则经 tweaks 注入 `BatchAssetSheet-img02` 的
`model_name` / `resolution`，缺省走 flow 默认（gpt-image-2-03 · 1K）。

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
- 文本模型切换走**组件名注入**（非节点 id，删节点重建不失效）：
  `tweaks={"LanguageModelComponent": {"model_name": "<models.py TEXT_MODELS id>", "provider": "<BigModel|DeepSeek|DMX>"}}`——
  provider = langflow 一等平台名（声明在 langflow/src/bundles/platforms/，随包种子的
  <前缀>_BASE_URL/<前缀>_API_KEY 全局变量路由）；
  LM 组件的 model_name 覆盖字段留空即用 flow 保存的模型，运行时覆盖经此通道；
  看图反推是视觉模型（gemini 固定，组件 model_name），不走此通道。
  目录与校验唯一事实源 `agent/models.py`（TEXT_MODELS，DMX chat 探针验证），
  `GET /models/text` 下发；分镜表生成（model）/拆解（text_model）/提示词优化（model）
  三个端点透传，非法 id 400 明报
- 修改 flow 后：先在 langflow UI 调试，再 `export.sh` 回写本目录，保持两处一致
