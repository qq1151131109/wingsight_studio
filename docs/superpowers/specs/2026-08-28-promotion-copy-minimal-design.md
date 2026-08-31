# 宣发文案最小闭环（Langflow 版）设计

日期：2026-08-28
状态：已确认（与用户对齐）

## 背景

juben（Wingsight）项目有一套基于 Claude Agent SDK 的「宣发 skill」：飞书文档导入 → 宣发事实卡 → 多路 LLM 并行写平台文案 → 物料工作台挑选。本设计把其中最小、最有价值的一环移植到 Langflow：**输入飞书文档链接 → LLM 理解文档内容 → 按平台规则写出宣发文案候选**。

## 目标与非目标

**目标**

1. 输入飞书文档链接，读取文档标题与正文作为写作上下文
2. 内置 Prompt 组件承载 juben 的平台写作规则（抖音/视频号/微博/朋友圈）
3. 多路 LLM 并行写作，各路候选合并输出（Langflow 可视化并行，天然支持）
4. 交付一个可直接导入的预置 flow，导入后配好模型 key 即可用

**非目标（明确不做）**

- 宣发事实卡、版本号、"待核对"机制
- 物料工作台（candidate → adopted/published 状态流）与落盘存储
- 海报生成、飞书内嵌图片下载
- 飞书旧版文档（/docs/）、sheets、base 等类型（只支持新版 docx 与 wiki 节点链接）

## 架构总览

```
[TextInput: 飞书链接] ──→ [飞书文档组件] ──(title, content)──┐
[TextInput: 平台/形态/批次/主题/简报/变体数 ×6] ─────────────┼→ [Prompt 组件] ─→ [LLM ×N 并行] ─→ [CombineText] ─→ [输出]
                                                            ┘  （模板 = juben 写作规则）
```

- 飞书读取是唯一需要写代码的部分（Langflow 无现成飞书组件）
- 写作规则以纯文本模板放进内置 Prompt 组件，画布上直接可见、可改
- 多路 LLM：flow 里并排放 N 个 LLM 组件（示例预置 2-3 路，用户自由增删），输出汇入 CombineText

## 组件设计：飞书文档（FeishuDocComponent）

**位置**：`src/lfx/src/lfx/components/tools/feishu_doc.py`，注册进 `tools/__init__.py`（按字母序）。

**类**：`FeishuDocComponent(Component)`，`display_name = "飞书文档"`，`icon = "FileText"`，类名一经发布不再改（Langflow 以类名匹配已保存 flow）。

**输入**：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `doc_url` | MessageTextInput（可被上游赋值） | 飞书文档链接，支持 `*.feishu.cn/docx/<token>`、`*.feishu.cn/wiki/<token>`，国际版 `*.larksuite.com` / `*.larkoffice.com` 同理 |
| `app_id` | SecretStrInput | 飞书自建应用 App ID，支持引用全局变量 |
| `app_secret` | SecretStrInput | 飞书自建应用 App Secret，支持引用全局变量 |
| `base_url` | DropdownInput，默认 `https://open.feishu.cn` | 中国版/国际版（`https://open.larksuite.com`） |

**输出**：`Message`，text 为 `"{标题}\n\n{正文}"`（Message 类型可直接接 Prompt 组件的 `{doc_content}` 变量，避免 Data→str 的类型转换问题）。

**内部逻辑**（移植 juben `lib/feishu/` 的最小子集，纯 httpx，零第三方 SDK）：

1. 解析链接 → `{doc_type, token, platform}`；域名与路径形态不符时抛中文错误（含"支持的链接形态"提示，参考 juben `link_parser.py` 的枚举拒绝策略）
2. wiki 链接 → `GET /open-apis/wiki/v2/spaces/get_node` 换取 `obj_token`
3. `POST /open-apis/auth/v3/tenant_access_token/internal` 换 token（有效期 2h，提前 5 分钟刷新；组件每次运行即取即用，不做跨请求缓存）
4. `GET /open-apis/docx/v1/documents/:id/raw_content` 拉正文；`GET /open-apis/docx/v1/documents/:id/basic_info` 拿标题
5. 所有错误（链接无效 / token 失败 / 无权限 `code 1770002`、`230002` / 文档不存在）转为中文异常信息，Langflow 画布节点直接红标显示原因

**权限前提**：飞书自建应用开通文档只读权限（`docx:document:readonly` 等），申请步骤沿用 juben `docs/feishu-setup.md`，本设计的 README 摘要引用。

## Prompt 模板设计

从 juben `lib/promotion_copywriter/prompts.py` 移植，整理为 Prompt 组件的单模板（system 与规则合并进一个 user prompt，靠 Langflow LLM 组件无需 system 输入）：

**变量**（Langflow Prompt 组件标准 `{var}` 语法）：

| 变量 | 来源 | 示例 |
| --- | --- | --- |
| `{doc_content}` | 飞书组件输出（标题 + 空行 + 正文） | `香港奇案\n\n文档正文…` |
| `{platform}` | 用户填 | `douyin` / `channels` / `weibo` / `moments` |
| `{form}` | 用户填（仅朋友圈） | `short` / `long`，非朋友圈填空 |
| `{batch_kind}` | 用户填 | `daily` / `milestone` |
| `{title}` | 用户填 | 本批物料主题名 |
| `{brief}` | 用户填（可选） | 附加要求原话（如「更口语」「突出首发」） |
| `{count}` | 用户填 | 每路变体数，默认 5 |

**模板内容清单**（顺序即 juben `build_copy_prompt` 的组装顺序）：

1. 角色与写法核心：卖"为什么点进去"不复述剧情、第一句即钩子、变体间换切入（场面/台词/数字/反差/提问）、红线（事实没写的不编、待定用 `【短链接】` 占位、不编"我看完了"、不出品人职务 credits 开场）
2. 批次约束：`daily`（第一句就是钩子）/ `milestone`（先亮身份再给钩子）——两个批次的说明都写进模板，用 `{batch_kind}` 的值让模型自对号
3. 四个平台规则全文（juben `PLATFORM_SPECS` + 朋友圈 `_FORM_SPECS`）：抖音首句 ≤25 字/话题 ≤5 个单井号/不出现播出平台名；视频号同抖音；微博话题 ≤3 个双井号/结尾带平台与日期；朋友圈按 `{form}` 分四行/长文两形态
4. 输出格式契约：`## 变体 N · 钩子类型`（钩子类型枚举：数字/反差/身份反差/场景代入/悬念/台词/未解之谜/极端事实/质感/时间线/提问/热梗），变体之外不输出任何解释文字
5. Few-shot 正例：juben `FEW_SHOT_EXAMPLES` 全量搬入（17 条，按平台分组列出；模板注明"学语感结构，事实与片名换成当前文档"）

事实来源段落写作：juben 以"事实卡"为唯一事实源；本设计用文档正文 `{doc_content}` 承担该角色，模板中的段落标题相应写"宣发资料（唯一事实来源，没写的不编）"。

## 模型接入（设置 → 模型提供商，不写进 flow）

juben 的 `promotion_copy_backends` 三路写手全部是 OpenAI 兼容接口。langflow 的统一模型体系里每个提供商槽位一组全局凭证（存全局变量、带连接验证按钮、从端点动态发现模型列表），两个接入点占两个槽位：

| 设置页槽位 | 配置 | 承载 |
| --- | --- | --- |
| OpenAI Compatible | Base URL `https://www.dmxapi.cn/v1` + DMXAPI key | 路 2 `gpt-5.6-luna`、路 3 `gemini-3.7-flash`（`/v1/models` 动态发现，直接出现在选单） |
| OpenAI | Base URL（`OPENAI_BASE_URL`）`https://api.deepseek.com` + DeepSeek key | 路 1 `deepseek-v4-flash`（设置 Base URL 后同样从端点动态发现模型） |

- Flow 里三路全部用统一 **Language Model 组件**：只选 provider + model，**不含任何 key**；key 集中在设置页管理，换 key 不用动 flow
- juben 的 `custom-3` 即 DeepSeek 官方直连，`dmx` 即 DMXAPI 中转；langflow 侧按接入点语义配置，不再沿用 juben 内部代号
- 取值来源（README 注明）：DeepSeek key 在 juben `custom_provider` 表 id=3；DMX key 在 juben `provider_credential` 表 provider=dmx
- **占用说明**：本实例的「OpenAI」槽位被 DeepSeek 借用后，如需真 OpenAI 官方模型需换回 Base URL 或改用其他槽位；README 提示这一点。备选方案（不采用）：路 1 用 DeepSeek 原生组件（`DeepSeekModelComponent`，逐节点 base_url + api_key），配置分散，仅当 OpenAI 槽位必须留给官方 OpenAI 时再切换

## Flow JSON 设计

**位置**：`examples/promotion/promotion-copy.flow.json` + `examples/promotion/README.md`（含导入步骤、飞书应用权限配置、「设置 → 模型提供商」两个槽位的填写指引与 key 取值来源）。

**节点清单**：

| 节点 | 组件 | 预置值 |
| --- | --- | --- |
| 飞书链接 | TextInput | 空 |
| 飞书凭证 | （引用全局变量 `feishu_app_id` / `feishu_app_secret`） | 在飞书文档组件上配 |
| 平台 / 形态 / 批次 / 主题 / 简报 / 变体数 | TextInput ×6 | `douyin` / 空 / `daily` / 空 / 空 / `5` |
| 飞书文档 | FeishuDocComponent | — |
| 写作 Prompt | Prompt 组件 | 上述完整模板 |
| LLM ×3 | Language Model 组件 ×3 | 预置上表「模型接入」三路（provider + model 选好；key 在设置页配，flow 内无任何密钥）；用户可增删路数 |
| 合并 | CombineText | 直接拼接各路输出，不做路前缀——候选按 juben 理念对模型匿名，靠变体编号与钩子类型辨认 |
| 输出 | TextOutput | — |

## 错误处理

- **飞书组件**：链接解析失败、token 失败、无权限、文档不存在 → 中文异常；Langflow 在节点上直接显示
- **LLM 路**：Langflow 原生处理（某路失败该路红标，不影响他路展示——用户在画布上逐路看结果）
- **超时**：httpx 客户端统一 20s 超时（与 juben 一致）

## 测试

- 位置：`src/backend/tests/unit/components/tools/test_feishu_doc.py`，用 `ComponentTestBaseWithoutClient`
- 飞书 HTTP 层用 `httpx.MockTransport` 模拟（juben `tests/` 已有同款模式可搬）
- 覆盖：
  1. docx 直链解析 + raw_content 输出（含标题合并）
  2. wiki 链接 → get_node → 文档 id → 正文
  3. lark 国际版域名 → base_url 切换
  4. 链接形态不支持（sheets/docs/base）→ 中文错误信息
  5. token 接口失败 / 业务 code 非 0（无权限 1770002）→ 中文错误信息
- 组件测试必备 fixtures：`component_class`、`default_kwargs`、`file_names_mapping`（按 AGENTS.md 规范）

## 交付物清单

1. `src/lfx/src/lfx/components/tools/feishu_doc.py` —— 飞书文档组件
2. `src/lfx/src/lfx/components/tools/__init__.py` —— 注册
3. `examples/promotion/promotion-copy.flow.json` —— 预置 flow
4. `examples/promotion/README.md` —— 导入与配置说明（飞书应用权限、全局变量、模型配置）
5. `src/backend/tests/unit/components/tools/test_feishu_doc.py` —— 单测
