# 剧本 → 资产设定图（Langflow 预置 flow）

输入剧本全文，LLM 拆解出角色/场景/道具清单，逐资产豆包搜索参考图，
按布局契约（角色白底四格三视图 / 场景无人空镜 / 道具浅灰多角度）并发出设定图。
每张图完成立即推送到聊天面板；未来专用前端可直接消费同一事件流。

- flow 文件：`asset-sheet.flow.json`
- 重新生成：`uv run python scripts/build_asset_sheet_flow.py`（节点模板由组件源码真实构建，
  组件字段变更后重跑即可同步；固定随机种子，产物字节稳定）

## 使用步骤

1. **导入 flow**：Langflow 新建 flow → 把 `asset-sheet.flow.json` 拖入画布（或菜单 Import JSON）。
   画布应出现 4 个节点、3 条连线：剧本输入 → Prompt → Language Model → 批量资产出图。
2. **创建全局变量**（Settings → Global Variables，类型选 Credential）：
   - `volc_search_api_key`：火山引擎「联网搜索控制台」创建的 API Key（免费 500 次/月）
   - `dmx_api_key`：DMXAPI 密钥（与宣发 flow 共用，见 `examples/promotion/README.md` 第 2 节的取 key 指引）
3. **配置模型提供商**（Settings → Model Providers）：配置步骤与槽位说明见
   `examples/promotion/README.md` 第 2 节（先例）。剧本拆解用任一文本模型槽位
   （如 DeepSeek）；出图走 DMXAPI 聚合网关，无需在设置页单独配置。
4. 在「批量资产出图」节点把两个 Key 字段（豆包搜索 Key / DMXAPI Key）指向对应全局变量
   （字段右侧地球图标选择）。
5. **选择语言模型**：Language Model 节点的模型选择器在导入后是空的（JSON 里刻意留空，
   避免绑定某台机器的提供商配置）——点开选择已配置的提供商与模型（如 DeepSeek）。
6. **运行**：剧本输入框已预置一段含角色/场景/道具的示例剧本，可直接点运行试通；
   正式使用时替换为你的剧本全文 → 聊天面板逐张收图；「批量资产出图」节点结果输出
   含每资产状态汇总（名称/类型/状态/参考图数/耗时）。

## 组件清单

| 组件 | 用途 | 单独使用 |
| --- | --- | --- |
| Text Input（剧本输入） | 粘贴剧本全文 | 本 flow 的入口 |
| Prompt Template（资产盘点指令） | 剧本 → 资产清单 JSON 的拆解指令 | 可（换下游） |
| Language Model（语言模型） | 执行拆解，输出资产清单 JSON | 可 |
| 批量资产出图 | 资产清单 → 并发出图 + 实时推送 | 本 flow 的编排核心 |
| 飞书文档（可选） | 粘贴飞书链接读剧本，替代手动粘贴 | 可（接 Prompt）；由独立交付引入 |
| 豆包搜图 | 关键词 → 参考图 | 可 |
| 图像生成 | prompt（+参考图）→ 设定图 | 可 |

后三个是「批量资产出图」内部调用的能力组件，也可在画布上单独拖用。

## 参数说明（批量资产出图节点）

- **并发数**：默认 3（上限 5）；豆包免费档有限流，组件自动退避重试
- **资产数上限**：默认 10，超出的资产被丢弃
- **参考图数**：默认 3，每个资产搜多少张参考图
- **清晰度**：1K / 2K / 4K，默认 1K
- **模型 / Base URL**：默认 DMXAPI 网关的 `gpt-image-2-03`，一般不用改
- **比例**：角色/场景 16:9，道具 4:3（组件内按类型固定，独立图像生成组件可改）
- **自定义模板**：留空用内置布局契约；搜图失败自动回退纯文生图（结果里 `reference_count=0`）

## 资产清单 JSON 契约

Language Model 的输出（也是「批量资产出图」的输入）格式：

```json
{"assets": [{"type": "character|scene|prop", "name": "...", "description": "...", "visual_notes": "...", "search_query": "..."}]}
```

`search_query` 必须是可公开搜索的名词短语（如「清代商人长袍」），不要用角色名。
