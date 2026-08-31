# 宣发文案生成 Flow 使用指南

粘贴一篇飞书宣发资料文档的链接，填写平台、批次等参数，三路大模型并行产出可直接发布的平台文案候选。本目录提供预置 flow 与配套写作 Prompt 模板：

| 文件 | 说明 |
| --- | --- |
| `promotion-copy.flow.json` | 预置 flow（9 节点：飞书读取 + Prompt + 三路模型 + 合并输出），导入即用 |
| `prompt-template.md` | 写作 Prompt 模板参考（System 纪律 + 任务模板），与 flow 保持一致 |

## 1. 功能简介

flow 的完整链路：

```
  飞书文档组件（填链接）──读取标题与正文──▶ Prompt 模板（写作规则 + 平台等参数）
        │
        ├─▶ deepseek-v4-flash ──┐
        ├─▶ gpt-5.6-luna ──────┤ Combine Text 依次合并
        └─▶ gemini-3.7-flash ──┘
                              │
                              ▼
                        Text Output（查看结果）
```

- 飞书文档是唯一事实来源：资料里没写的事实不编造，待定项用【短链接】/【播出平台】占位。
- 三路模型同时按同一 Prompt 写作，钩子方向互不相同，供挑选发布。
- 每路各产「变体数」条（默认 5），三路合计默认 15 条候选。

## 2. 前置一：模型提供商配置

打开 Langflow 左侧 **Settings → 模型提供商**（Model Providers），需要配置两个槽位：

| 设置页槽位 | 实际接的服务 | Base URL | API Key |
| --- | --- | --- | --- |
| **OpenAI Compatible** | DMXAPI 聚合网关 | `https://www.dmxapi.cn/v1` | DMXAPI key |
| **OpenAI** | DeepSeek 官方（OpenAI 兼容接口） | `https://api.deepseek.com` | DeepSeek key |

### API Key 从哪里取

两个 key 都存放在 juben 仓库的数据库里（`projects/.wingsight.db`），用下面的只读查询取出（把 `<juben 仓库路径>` 替换成本机 juben 仓库的绝对路径）：

```bash
# DMXAPI key：provider_credential 表中 provider=dmx 的行
sqlite3 -readonly <juben 仓库路径>/projects/.wingsight.db \
  "SELECT base_url, api_key FROM provider_credential WHERE provider = 'dmx' AND is_active = 1;"

# DeepSeek key：custom_provider 表中 id=3 的行（display_name 为 DeepSeek）
sqlite3 -readonly <juben 仓库路径>/projects/.wingsight.db \
  "SELECT display_name, base_url, api_key FROM custom_provider WHERE id = 3;"
```

### 配置步骤

1. 设置页点击 **OpenAI Compatible**，填入 API Key（DMXAPI key）与 Base URL（`https://www.dmxapi.cn/v1`），点「保存」并「激活」。
2. 再配置 **OpenAI** 槽位：API Key 填 DeepSeek key，「OpenAI Base URL」填 `https://api.deepseek.com`，保存并激活。
3. 保存/激活时页面会自动校验连接；若提示「验证失败」，核对 key 与 Base URL 是否抄错。
4. **注意**：OpenAI 槽位被 DeepSeek 借用后，就不能同时接官方 OpenAI 了——需要切回官方 OpenAI 时，先在该槽位断开 DeepSeek 再换 key。

## 3. 前置二：飞书自建应用

读取飞书文档需要一个**企业自建应用**的凭证与授权：

- **App ID / App Secret**：应用凭证页获取。
- **权限**：`docx:document:readonly`（读取新版文档）、`wiki:wiki:readonly`（解析知识库节点链接）。
- **文档授权**：应用机器人需被加为文档**协作者**，或文档位于已授权给应用的**知识库**内——应用默认看不见任何文档，只配凭证不授权会报无权限。

申请步骤摘要：飞书开放平台（open.feishu.cn）→ 创建企业自建应用 → 权限管理开通上述两个权限 → 版本管理与发布（发布后权限才生效）→ 把应用机器人拉进目标文档的协作者，或把文档放进授权知识库。

完整图文步骤见 juben 仓库 `docs/feishu-setup.md`。

## 4. 导入 Flow

1. Langflow UI → 左侧 **Flows** → **Import**，选择本目录的 `promotion-copy.flow.json`。
2. **核对三个模型节点的预选模型**（必做）：三个 Language Model 节点应分别预选 `deepseek-v4-flash` / `gpt-5.6-luna` / `gemini-3.7-flash`。若导入时预选丢失（节点下拉为空），在节点下拉里重新选择对应模型——下拉候选来自设置页两个槽位连接成功后的**动态发现列表**，所以先完成前置一：

   | 模型节点 | 模型 | 所属槽位 |
   | --- | --- | --- |
   | Language Model（DeepSeek 路） | `deepseek-v4-flash` | OpenAI（DeepSeek） |
   | Language Model（GPT 路） | `gpt-5.6-luna` | OpenAI Compatible（DMXAPI） |
   | Language Model（Gemini 路） | `gemini-3.7-flash` | OpenAI Compatible（DMXAPI） |

3. **填飞书组件凭证**（必做）：「飞书文档」节点的 App ID / App Secret 导入后**留空待填**，二选一：
   - 直接在组件字段粘贴明文（注意：明文会随 flow 导出文件一起带出，仅建议本地自用时）；
   - 推荐：先在 **Settings → 全局变量** 新建变量（类型选凭证）保存 App ID / App Secret，然后在组件字段里引用该变量。

## 5. 运行

两种入口：

- **画布**：飞书文档节点的 `文档链接` 字段贴链接（或走聊天入口，见下），点 Text Output 节点的 ▶ 全链运行
- **Playground / 聊天**：Chat Input 节点的消息就是文档链接——在 Playground 输入框直接粘贴飞书链接发送，候选结果回到聊天输出

每次要改的参数：

| 位置 | 字段 | 预填 | 说明 |
| --- | --- | --- | --- |
| Prompt 节点 | platform（下拉） | `douyin` | douyin 抖音 / channels 视频号 / weibo 微博 / moments 朋友圈 |
| Prompt 节点 | batch_kind | `daily` | daily 日常 / milestone 节点（定档/开播/收官/捷报） |
| Prompt 节点 | form | `both` | 仅朋友圈生效：both=四行+长文都要 / short / long |
| Prompt 节点 | title | 空 | 片名，写进「为《{title}》写…」 |
| Prompt 节点 | brief | 空 | 可选；附加要求原话 |
| Prompt 节点 | count | `5` | 每路变体数，三路合计 3 × count 条 |

（结构极简：平台/批次/形态都是 Prompt 节点的下拉字段，规则内嵌模板，无路由无自定义规则组件；唯一自定义组件是飞书文档读取）

**注意**：粘贴国际版（Lark）链接时，需要把「飞书文档」组件的「平台」下拉从默认「飞书（中国版）」切到「Lark（国际版）」，否则会报文档不存在/无权限。

填好后点 **Run**，运行结束点击 **Text Output** 节点查看结果。三路模型的输出由两个 Combine Text 节点顺序拼接（DeepSeek + GPT，再拼 Gemini），每路各自带「变体 n · 钩子类型」小节，从中挑选即可发布。

## 6. 常见错误对照表

| 运行报错信息 | 原因 | 处理办法 |
| --- | --- | --- |
| 飞书应用凭证缺失：请在组件上填写 app_id 与 app_secret（或引用全局变量） | App ID / App Secret 留空就点 Run（凭证未填时的首个报错） | 在组件上直接填写，或在 **Settings → 全局变量** 新建变量后在组件里引用 |
| 飞书应用凭证校验失败（app_id/app_secret 无效或应用未发布） | App ID/Secret 填错，或应用尚未发布版本 | 核对组件上的 App ID / App Secret；确认应用已在开放平台发布版本 |
| 飞书应用凭证校验失败（tenant_access_token 无效…） | 凭证在取 token 环节被拒 | 同上，核对凭证后重跑 |
| 网络连接失败（无法访问飞书开放平台）：…（后接具体网络原因） | 本机连不上飞书开放平台（DNS 失败、连接被拒或超时等网络异常） | 检查本机到 open.feishu.cn 的网络连通性与代理设置 |
| 应用没有该文档的访问权限…… | 机器人不是该文档协作者，文档也不在授权知识库内 | 在飞书文档「分享」里把应用机器人加为协作者，或把文档移入已授权的知识库 |
| 飞书文档不存在或已被删除 / 知识库节点不存在或已被删除 | 链接失效或文档被删 | 回飞书重新复制文档链接再填 |
| 文档「××」正文为空（可能是空文档或应用无权限读取内容） | 文档本身没内容，或权限不足以读到正文 | 确认文档有正文；若正文存在则核对应用权限与协作者身份 |
| 不是飞书文档链接…… / 暂不支持××链接 / 无法识别的文档类型 | 链接域名或类型不对 | 仅支持 `/docx/`（新版文档）与 `/wiki/`（知识库节点）；旧版 doc、电子表格、多维表格等不支持 |
| 模型节点下拉为空，或运行报模型相关错误 | 提供商槽位未配置、校验失败或未激活 | 回到前置一检查两个槽位的 key / Base URL，重新保存并激活 |
| 设置页提示「验证失败」 | API Key 或 Base URL 抄错 | 对照第 2 节的表格逐项核对，从数据库重新取 key |

## 7. 改写作规则

写作规则分三处：

- **写作纪律**（怎么写好、红线、输出格式）在三个 **Language Model** 节点的 **System Message** 字段里——三处是同一份文本，改动时三处同步。放 System 位置是为了长上下文下约束更稳。
- **平台规则与正例**在画布的 **Prompt Template** 节点 `template` 文本里（四平台规则紧凑版 + 7 条干净正例，模型按 platform 变量对号入座——实测配合 System 纪律不串台）。
- **任务结构**在画布的 **Prompt Template** 节点 `template` 文本里，点开节点即可直接编辑。

模板源文件在 `examples/promotion/prompt-template.md`（三部分都记录在内），改完画布后建议同步回该文件。改完记得保存 flow。
