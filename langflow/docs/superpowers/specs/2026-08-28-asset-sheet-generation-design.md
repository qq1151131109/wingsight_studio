# 剧本 → 资产设定图批量生成（Langflow 侧）设计

日期：2026-08-28
状态：已实施（终审修复后收尾，偏离记录见文末）
关联：`2026-08-28-promotion-copy-minimal-design.md`（飞书组件、DMX key 全局变量与宣发设计共用）

## 背景与目标

juben（Wingsight）有完整的资产生产体系（资产候选库、researcher agent 调研循环、角色多阶段流水线、版本管理）。本设计只移植其核心出图能力到 Langflow：

**输入剧本 → LLM 拆解资产清单 → 逐资产豆包搜图做参考 → 并发出设定图 → 聊天流逐张弹卡片。**

专用前端（卡片网格"长图"体验）后置：本设计产出的事件流（`send_message` 逐张推送）就是未来前端经 `POST /api/v2/workflows`（stream 模式）消费的数据源，接前端时 langflow 侧无需返工。

## 范围与非目标

**目标**

1. 剧本全文输入（粘贴文本；飞书文档组件为可选输入，复用宣发设计）
2. LLM 结构化拆解出资产清单：角色 / 场景 / 道具三类，每条含名称、外形描述、视觉要点、搜图关键词，上限默认 10
3. 每个资产自动豆包搜索（火山引擎联网搜索 image 模式）取前 3 张参考图
4. 按 juben 布局契约模板组装设定图 prompt，参考图走 `images.edit`（图生图）、无参考图回退 `images.generate`（文生图）
5. 并发 3 批量出图（DMXAPI `gpt-image-2-03`，与 juben 配置一致），每张完成立刻 `send_message` 到聊天流（Playground 里逐张弹图片卡片）
6. 汇总输出：每资产的状态/图路径/参考图数/失败原因

**非目标（明确不做）**

- 画布动态节点（产品级改造，已评估排除）；专用前端（用户明确后置）
- 资产候选库 / 修订冲突系统、researcher「搜索→审阅→提交」人审循环（搜到前 3 张直接全用）
- 角色多阶段（选角候选→脸→身体→Look）、服装/产品两类资产、版本管理、任务队列、资产 CRUD 工作台

## 架构总览

```
[TextInput 剧本全文]（或 飞书文档组件[宣发设计]，可选）
        ↓
[Prompt：剧本拆解指令] → [Language Model] → [Structured Output：资产清单 schema]
        ↓ （Data 列表，上限 10）
[批量资产出图组件 ★自定义]
    内部信号量并发 3，每资产：
      豆包搜图(前3张,下载) → 布局契约 prompt → DMXAPI 出图(edit/generate)
      → send_message(资产名+类型+图) 实时推送
        ↓
[输出：汇总 Data（每资产 name/type/status/image_path/reference_count/error）]
```

画布上另有「豆包搜图」「图像生成」两个独立组件（批量组件共享其底层逻辑），单独可用于手动单资产场景。

## 自定义组件设计（3 个，均在 `src/lfx/src/lfx/components/tools/`）

底层逻辑（HTTP 调用、解析、下载、尺寸计算）写在各组件文件中并被批量组件复用；组件类名一经发布不再改。

### 1. 豆包搜图 `VolcImageSearchComponent`

移植 juben `lib/image_search/volc_search.py`。

- **输入**：`query`（MessageTextInput）；`api_key`（SecretStrInput，引用全局变量 `volc_search_api_key`）；`limit`（IntInput，默认 3，上限 5——豆包 image 模式单次最多 5 条）
- **输出**：`Data` 列表，每条 `{url, width, height, local_path}`（已下载到本地，经图片有效性校验）
- **逻辑**：`POST https://open.feedcoopapi.com/search_api/web_search`，`{"Query": q, "SearchType": "image", "Count": n}`，`Authorization: Bearer <key>` → 解析结构化图片结果（Url/宽高）→ 下载 top N 到临时目录（httpx，20s 超时，`PIL.Image.verify` 校验）
- **错误语义**：未配 key → 中文异常；限流（CodeN 700429）→ 指数退避重试至多 3 次；额度不足（10406/10412）/未开通（10402/10403）→ 中文异常；**无结果 → 返回空列表不抛错**（调用方回退纯文生图）

### 2. 图像生成 `ImageGenerationComponent`

通用 OpenAI 兼容 images 接口组件（openai SDK，复用 langflow 的 `ssrf_protected_openai_clients_for_url`），默认值即 DMXAPI。

- **输入**：
  - `prompt`（MessageTextInput）
  - `reference_images`（Data 列表，可选；取其 `local_path`/`path`）
  - `model_name`（DropdownInput combobox，默认 `gpt-image-2-03`）
  - `base_url`（StrInput，默认 `https://www.dmxapi.cn/v1`）
  - `api_key`（SecretStrInput，引用全局变量 `dmx_api_key`，与宣发 flow 共用）
  - `aspect_ratio`（Dropdown：16:9 / 9:16 / 1:1 / 4:3 / 3:4）
  - `resolution`（Dropdown：1K / 2K / 4K，默认 1K——清晰度档位只决定短边像素，不决定比例）
- **输出**：`Data` `{path, width, height, model}`；同时 `self.status` 展示
- **逻辑**：无参考图 → `client.images.generate`；有参考图 → `client.images.edit`（参考图以文件字节上传，参考图与生成图对称下传 size）。尺寸按「比例优先、清晰度其次」计算（移植 juben `aspect_size` 简化版：比例 + 短边档位 → 精确比例且被 16 整除的 WxH，绝不把比例交给网关默认）。结果 b64 解码 → 存临时文件 → 输出
- **错误**：模型返回空/截断、HTTP 失败 → 中文异常（含模型名与 HTTP 状态）

### 3. 批量资产出图 `BatchAssetSheetComponent`

- **输入**：
  - `assets`（Data 列表，接结构化输出；每条 `{type, name, description, visual_notes, search_query}`；超过 `max_assets`（默认 10）截断并在结果中记录）
  - `concurrency`（IntInput，默认 3，上限 5）
  - 搜图/出图的 key、base_url、model、分辨率透传（默认值同上两个组件）
  - `prompt_template`（MultilineInput，advanced，可选——留空用内置模板，覆盖时可用 `{type}`/`{name}`/`{description}`/`{visual_notes}` 变量）
- **输出**：`Data` 列表汇总（每资产 `name/type/status(ok|failed)/image_path/reference_count/error/elapsed_seconds`）
- **逻辑**：`asyncio.Semaphore(concurrency)` 并发；每资产流水线 = 豆包搜图（3 张，失败/空则 0 张继续）→ 模板渲染（按 type 分支的布局契约 + 文字守卫）→ 图像生成（比例按类型：character 16:9 / scene 16:9 / prop 4:3）→ `await self.send_message(Message(text=f"{类型} · {资产名}", files=[图]))` 逐张实时推送 → 记录结果。单资产失败不中断批次（`error` 记原因）
- **内置布局契约模板**（移植 juben `prompt_builders.py`，单阶段 sheet 版）：
  - character：横版 16:9 四格布局，纯白 #FFFFFF 背景——左 40% 胸像特写，右三等宽面板为正面/四分之三侧面/背面 A-Pose 全身
  - scene：可复用场景空间基准图，无人空镜，中性勘景视角完整呈现建筑/地貌/空间布局/材质/光线，不出现人物/动物/剧情行为
  - prop：纯净浅灰背景，按形态匹配布局（单件立体物三视 / 大型器械侧视机构 / 文字标牌正面主视 / 物件集合陈列 / 平面文书全貌），所有视图同一件道具
  - 通用文字守卫：画面不得出现任何可读文字、标签、编号、水印或界面元素
  - 模板结构 = 布局契约 + 资产事实（名称/描述/视觉要点）+ 参考图用途说明（继承形制与材质，不复刻白底三视图版式）

## Flow 编排与模型

- **剧本拆解 LLM**：内置 Language Model 组件，用设置页已配的槽位（建议 DeepSeek `deepseek-v4-flash`，拆解是纯文本任务、成本低；用户可在画布换）
- **结构化输出**：内置 Structured Output 组件，schema：
  ```json
  {"assets": [{"type": "character|scene|prop", "name": "...", "description": "...", "visual_notes": "...", "search_query": "..."}]}
  ```
  拆解指令（Prompt 组件模板）要求：只拆有画面感的实体、名称用剧本原名、search_query 用可搜索的名词短语（如「清代商人长袍」而非「林万年的衣服」）、按出场重要性排序
- **交付 flow**：`examples/asset-sheet/asset-sheet.flow.json` + `README.md`（导入步骤、`volc_search_api_key` / `dmx_api_key` 两个全局变量的创建指引——豆包 key 需在火山引擎「联网搜索控制台」创建，免费额度 500 次/月，juben 数据库中尚无此 key）

## 错误处理汇总

| 环节 | 失败表现 | 处理 |
| --- | --- | --- |
| 拆解 LLM | 结构化输出解析失败 | Langflow 原生报错（画布红标） |
| 豆包搜图 | 未配 key / 未开通 / 额度尽 | 中文异常，画布红标（整批停止——属配置问题） |
| 豆包搜图 | 单资产查询无结果 / 下载失败 | 空参考图继续，该资产走纯文生图，`reference_count=0` |
| 豆包搜图 | QPS 限流 | 指数退避重试 ≤3 次，仍失败按无结果处理 |
| 出图 | 单路模型失败 | 重试 1 次，仍失败该资产 `status=failed` + 原因，不中断批次 |
| 出图 | 全部资产失败 | 汇总输出全部 failed + send_message 一条批次失败通知 |

## 测试

- 位置：`src/backend/tests/unit/components/tools/`，`ComponentTestBaseWithoutClient`；HTTP 层全部 `httpx.MockTransport` 模拟（豆包/DMXAPI 响应体按真实格式构造）
- 覆盖：
  1. 豆包响应解析（含宽高透传）、限流码退避、无结果空列表、未配 key 异常
  2. 图下载 + PIL 校验（模拟非图片字节被拒）
  3. images.edit / images.generate 的参数组装（size 计算精确比例且被 16 整除；参考图字节上传）
  4. 尺寸计算：各比例 × 各档位 → W×H 校验；比例优先不受档位干扰
  5. 批量组件：mock 底层，验证并发信号量、单资产失败不中断、超上限截断、汇总字段完整
- 组件测试 fixtures：`component_class` / `default_kwargs` / `file_names_mapping`

## 交付物清单

1. `src/lfx/src/lfx/components/tools/volc_image_search.py`
2. `src/lfx/src/lfx/components/tools/image_generation.py`
3. `src/lfx/src/lfx/components/tools/batch_asset_sheet.py`
4. `src/lfx/src/lfx/components/tools/__init__.py` 注册 ×3
5. `examples/asset-sheet/asset-sheet.flow.json`
6. `examples/asset-sheet/README.md`
7. `src/backend/tests/unit/components/tools/test_volc_image_search.py` / `test_image_generation.py` / `test_batch_asset_sheet.py`

## 与宣发设计的关系

- 飞书组件：宣发设计已规划、未实施；本 flow 作为可选输入引用，实施顺序上先做飞书组件（两 flow 共用）
- `dmx_api_key` 全局变量共用；豆包 `volc_search_api_key` 为本设计新增
- 独立 flow、独立 examples 目录，互不依赖同时可用

## 实施偏离记录（2026-08-28 终审收尾）

实施与本文设计的差异，均已在组件与测试中落地：

1. **资产清单输入为 JSON 文本（MultilineInput）而非 Data 列表**：未使用 Structured Output
   组件，Language Model 直接输出 JSON 文本连入「资产清单 JSON」字段，由
   `parse_assets_payload` 容错解析（剥 code fence、首尾大括号截取兜底）。交付 flow 为
   4 节点：剧本输入 → Prompt → Language Model → 批量资产出图。
2. **部分失败不发汇总消息**：成功的资产逐张 `send_message` 实时推送即可；仅当全部
   资产失败时才补发一条批次失败通知（含资产名清单）。失败明细始终在结果 Data 的
   `error` 字段里。
3. **自定义模板整体替换（含标题行）**：`prompt_template` 非空时完全替代内置模板，
   标题行「{类型}设定图：{名称}」也不例外，由模板作者全权决定。
4. **搜索错误分两类**：配置类错误（要用搜索但 Key 未配）在并发前预校验并整批抛中文
   异常（画布红标停止）；网络/单次搜索失败仍降级纯文生图（`reference_count=0`，
   降级原因写入组件日志）。
5. **尺寸算法为短边档位语义**：1K/2K/4K 对应短边下限 1024/1440/2160（4K=2160），
   在 (aw×16, ah×16) 网格上取短边不低于档位的最小倍数，比例零偏差且两边被 16 整除。
6. **出图失败不重试**：设计错误表中「单路模型失败重试 1 次」未实施，直接置
   `status=failed` 记原因、不中断批次（豆包搜图侧保留限流退避重试 ≤3 次）。
7. **组件无「搜索端点」输入**：豆包搜索端点在组件内固定常量，未暴露为可配置字段。
