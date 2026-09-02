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
| `ref-research-plan.json` | 参考图调研规划 | 资产参考图调研：资产上下文+已完成轮次 → 考据向搜索词（3-5 个）+ enough 判定（多轮补搜规划器，gpt-5.6-luna 经 DMX）。纯原生链，参数走 input_value JSON | `LANGFLOW_REF_PLAN_FLOW_ID` | 无（载荷走 input_value JSON） |
| `ref-research-select.json` | 参考图终选 | 资产参考图调研：候选缩略图 → LLM 看图终选适合做生图（i2i）参考的几张 + 取舍说明。单用途自定义组件 `RefSelectComponent`（gpt-5.6-luna 视觉经 DMX；**上游单请求限 50 张图**，agent 侧分批；候选下载已并发化） | `LANGFLOW_REF_SELECT_FLOW_ID` | `RefSelect-main`（payload JSON + api_key） |
| `text-write.json` | 文本撰写 | 画布文本卡/剧本卡「撰写」直连管线：指令+正文+参考上下文 → 处理后全文（续写保留原文、改写保原意、空正文直接创作）。卡片级 `data.textModel` 在此生效 | `LANGFLOW_TEXTWRITE_FLOW_ID` | `LanguageModelComponent`（model_name 覆盖文本模型） |
| `instruction-compose.json` | 出图指令合成 | 智能编排（novanova KEEP/OPTIMIZE 范式，提示词搬运自其 agent-image.md/optimization-image.md）：短指令结合卡片设定文本扩写成完整提示词；完整描述/改图指令 keep 原样。input_value 四段：生成指令/卡片设定文本/参考图职责/全局画风，输出 JSON {action,prompt} | `LANGFLOW_COMPOSE_FLOW_ID` | `LanguageModelComponent`（组件名注入文本模型） |

注：两态由前端按按钮态显式路由（请求体 `mode: optimize\|reversal`，agent
端点校验各态必填项），不再混装单 flow——旧双态组件 `PromptOptimizerComponent`
（组件内按 prompt 空否判态）已废弃删除。
| `promo-copy.json` | 宣发文案生成 | 飞书宣发资料 → 三路大模型并行 → 合并文案 | `LANGFLOW_SKILLS_JSON`（技能注册内含 flowId） | `PromptTemplate-Writer`（title/count/platform/batch_kind/brief/form） |
| `shotlist-generate.json` | 分镜表生成 | 剧本 → 分镜 rows（景别/运镜/时长/画面/台词） | `LANGFLOW_SHOTLIST_FLOW_ID` | 无（参数走 input_value 文本头注入） |
| `topic-triage.json` | 选题研判 | 多源信号条目（material/validated/benchmark/anniversary 四类研判方式）→ 聚类+判垂类（垂类清单随载荷下发，注册表见 `topic_pool.VERTICAL_SPECS`）+价值排序的短名单（选题池管线第 1 步） | `LANGFLOW_TOPIC_TRIAGE_FLOW_ID` | 无（载荷走 input_value JSON） |
| `topic-research-plan.json` | 选题调研规划 | 热点+研判线索 → ≤4 条覆盖证据面的检索查询（第 2 步） | `LANGFLOW_TOPIC_PLAN_FLOW_ID` | 无（同上） |
| `topic-research-followup.json` | 选题调研追查 | 已执行检索记录 → 判断证据是否足够，不足给 ≤3 条追加查询（第 3 步） | `LANGFLOW_TOPIC_FOLLOWUP_FLOW_ID` | 无（同上） |
| `topic-verdict.json` | 选题两级结论 | 研判线索+调研证据(+angleOptions 候选角度) → 建议卡或观察卡（证据驱动+角度择优+entities 实体抽取；第 4 步） | `LANGFLOW_TOPIC_VERDICT_FLOW_ID` | 无（同上） |
| `topic-rescan-plan.json` | 选题复查规划 | 观察卡缺口+已核实事实 → ≤3 条冲着缺口去的复查查询（观察卡复查第 1 步；复查的追查/结论复用 followup/verdict） | `LANGFLOW_TOPIC_RESCAN_PLAN_FLOW_ID` | 无（同上） |
| `topic-angle-gen.json` | 选题角度生成 | 研判线索+调研证据 → 2-3 个爆款角度模板×具体切口的候选方案（verdict 带 angleOptions 择优成卡，缺配时 verdict 自选角度） | `LANGFLOW_TOPIC_ANGLE_FLOW_ID` | 无（同上） |
| `research-plan.json` | 调研开题 | 主题+侧重 → 观看问题+2-5 个取证方向（各带检索词）+风险预判（深度调研第 1 步，编排 `agent/research.py`） | `LANGFLOW_RESEARCH_PLAN_FLOW_ID` | 无（同上）；运行时注 glm-5.3-flash 快模型 |
| `research-extract.json` | 调研提纯 | 页面正文/摘要 → 相关性+来源分类（一手史料/学术/可靠媒体/自媒体/百科辞书/其他）+≤8 条带引句事实；严禁补写 content 外内容 | `LANGFLOW_RESEARCH_EXTRACT_FLOW_ID` | 无（同上）；快模型 |
| `research-evaluate.json` | 调研完整性评估 | 已提纯证据 → 是否可开写+缺口+换角度补搜词（轮间步，Skywork CompletenessEvaluation 范式） | `LANGFLOW_RESEARCH_EVAL_FLOW_ID` | 无（同上）；快模型 |
| `research-dossier.json` | 调研卷宗撰写 | 来源底账+提纯事实 → 五段卷宗（叙事脊/已证实事实/真实争议双版本/风险/材料簇），全 S 编号引用；agent 侧逐条校验引用剔幻觉 | `LANGFLOW_RESEARCH_DOSSIER_FLOW_ID` | 无（同上）——出厂模型保质量 |
| `script-review-compliance.json` | 剧本审查·合规 | 剧本全文+敏感词表参考底料（`agent/lexicons/sensitive-lexicon.txt`）→ 合规 findings（类目/严重度/依据/改写建议），语境判定不搞词表精确匹配 | `LANGFLOW_SCRIPT_COMPLIANCE_FLOW_ID` | 无（载荷走 input_value JSON） |
| `script-review-consistency.json` | 剧本审查·一致性 | 剧本全文 → 内部矛盾 findings（人物/时间线/设定，双位置引文） | `LANGFLOW_SCRIPT_CONSISTENCY_FLOW_ID` | 无（同上） |
| `script-review-fact-claims.json` | 剧本审查·事实抽取 | 剧本全文 → 可核查现实事实断言 ≤12 条（quote+检索用 claim） | `LANGFLOW_SCRIPT_FACTCLAIMS_FLOW_ID` | 无（同上） |
| `script-review-fact-verdict.json` | 剧本审查·事实判定 | 断言+Serper 证据清单 → 逐条 verdict（true/false/uncertain/unverifiable，S 编号引用） | `LANGFLOW_SCRIPT_FACTVERDICT_FLOW_ID` | 无（同上） |

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
| `POST /projects/{pid}/refs/research` + `GET .../refs/research/{jobId}` | 参考图调研规划+终选 | 资产参考图调研全链路：AI 出词（手填可覆盖）→ 豆包搜图+Wikimedia 双渠道 → 候选下载落盘 → gpt-5.6-luna 看图终选（recommended 落库）。**异步任务**：前端轮询。候选增删/采纳走 `/projects/{pid}/refs/candidates*`（采纳建参考卡连线进参考序列）。编排 `agent/imgresearch.py`，路由 `agent/ref_routes.py` |
| `POST /projects/{pid}/research` + `GET .../research/{jobId}`（另有 `.../confirm`、`.../cancel`、`.../gap`、`.../sources`） | 调研四 flow 全链 | 深度调研：发起即开题（观看问题+方向）→ 聊天里确认 → 多轮（Serper Google 网页搜索→原文抓取→提纯→完整性评估→补搜）→ 五段卷宗（叙事脊/事实边界/争议/风险/材料簇，S 编号引用）。**异步任务**：job 落 SQLite，重启标 interrupted、证据保留可 gap 补研续跑。聊天工具 `start_deep_research`/`confirm_research_plan`/`get_research_result`（graph.py）；前端调研卡（nodeType:"research"，凭 researchId 轮询）+ ResearchReader 阅读器。编排 `agent/research.py`，路由 `agent/research_routes.py`；单测 `agent/test_research.py` |
| `POST /projects/{pid}/script-review` + `GET .../script-review/{jobId}`（另有 `?nodeId=` 最新摘要、`.../findings/{fid}/dismiss`、`.../cancel`） | 剧本审查四 flow | 剧本三维度审查：合规（敏感词表 `agent/lexicons/sensitive-lexicon.txt` 作参考底料+语境判定，不做代码层规则匹配）/ 一致性（内部矛盾双引文）/ 事实核查（抽断言 ≤12 → Serper 取证 → 逐条判定，属实不报）。**异步任务**：job 落 SQLite（review_jobs/review_findings），findings 带正文锚点（quote+字符区间），job 记 body_sha1 供前端比对标过期；单维度软失败明报，取消 1s 粒度打断在途 flow。前端剧本卡 footer「审查」+ reviewJobId 锚续链 + ScriptReviewDialog（master-detail 高亮定位/忽略/应用建议）。编排 `agent/script_review.py`，路由 `agent/script_review_routes.py`；回归 `scripts/script-review-test.mjs` |

出图类端点（storyboard/images、assets/decompose）均可带 `params: {model?, resolution?}`
（项目级出图设置，目录与校验见 `agent/models.py`，`GET /models/image` 下发），
非法组合 400 明报；合法则经 tweaks 注入 `BatchAssetSheet-img02` 的
`model_name` / `resolution`，缺省走 flow 默认（gpt-image-2-03 · 2K）。

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
