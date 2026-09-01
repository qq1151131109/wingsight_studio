# DMXAPI 接入文档（本地存档）

> 来源：DMXAPI 官方文档站 `doc.dmxapi.com`（静态页，抓取于 2026-09-01）。
> 用户给的入口 `https://www.dmxapi.cn/dmxapi/iframe/5cddc343-...` 是 Apifox
> 分享文档的 iframe，JS 动态渲染、抓取只得到空壳；实际内容在 doc.dmxapi.com
> 的静态页与 `imagemodels.dmxapi.com`（后者证书已过期，2026-09-01 起无法访问）。

## 与本项目的通道映射（agent/models.py 目录 ↔ 文档）

| 本项目模型 | DMX 通道 | 对应文档 |
|---|---|---|
| gpt-image-2-03 / gpt-image-2-ssvip（默认） | OpenAI images 兼容：`/v1/images/generations`、`/v1/images/edits` | [dmxapi-img-gpt-image.md](dmxapi-img-gpt-image.md) |
| doubao-seedream-4-0 / 4-5 | images 兼容，参考图走 `image` URL 数组；编辑走 `image` 单 URL | [dmxapi-img-seedream.md](dmxapi-img-seedream.md) |
| doubao-seedream-5-0-pro | `/v1/responses`（多图融合，2~10 张参考图；DMX 文档站未见专页，本档无官方文档，以探针实测为准） | — |
| gemini-3.1-flash-image | 我们走 Gemini 原生 `v1beta generateContent`（x-goog-api-key 认证）；DMX 官方给的形态是 images 兼容层，仅存档参考 | [dmxapi-img-gemini.md](dmxapi-img-gemini.md) |
| 文本模型（deepseek / glm / kimi / qwen / minimax） | OpenAI chat 兼容：`/v1/chat/completions`（新对话接口 `/v1/responses`） | [dmxapi-api-general.md](dmxapi-api-general.md) |

## 关键事实速查

- 统一 Base URL：`https://www.dmxapi.cn/v1`（OpenAI 格式）；也支持 Claude / Gemini 原生格式（域名不带 /v1）。
- 认证：`Authorization: Bearer <DMX 令牌>`（本项目密钥只存根目录 `.env.local`，agent 经 dotenv 读取）。
- 响应两种形态：`data[].url`（需处理 `\u0026` 转义 + URL decode）与 `data[].b64_json`（base64 解码落盘）。
- **quality 参数：DMX 文档对 gpt-image 系未记载 quality；上游 OpenAI images API
  支持 `quality: low|medium|high|auto`，DMX 为透传网关，可用性以实测探针为准**
  （本仓库若已启用，见 agent/flows/asset-imagegen.json 的 generate_image 组件）。
- flux / qwen-image / midjourney 等：本目录不收（models.py 未收录的通道，调用 404/受限）。

## 原始链接

- 通用接口：https://doc.dmxapi.com/jiekou.html
- gpt-image 文生图：https://doc.dmxapi.com/img-gpt-image-1.html
- gpt-image 编辑：https://doc.dmxapi.com/img-gpt-image-1-edit.html
- 即梦多图合并：https://doc.dmxapi.com/img-seedream-images.html
- seededit 网络图编辑：https://doc.dmxapi.com/img-seedream-edit.html
- nano banana（gemini-2.5-flash-image）：https://doc.dmxapi.com/img-nano-banana-images.html
- 模型总览（证书过期）：http://imagemodels.dmxapi.com/
