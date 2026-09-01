# DMXAPI 接入文档（离线快照）

抓自 [doc.dmxapi.cn](https://doc.dmxapi.cn/) 的官方文档 Markdown 快照（2026-09-01，
`scripts/fetch-dmx-docs.py` 可重抓）。DMXAPI 是我们所有出图/文本/未来视频能力的
统一网关（`.env.local` 的 `DMX_API_KEY`）。

**注意：线上文档为准，快照仅供离线查阅。** 我们已实测的网关怪癖见
`AGENTS.md` 已知坑与 flow 源码注释（gemini 认证方式、高宽倒置、通道分流等）。

## 与 wingsight 管线的对应

| 我们的环节 | 模型 | 接口通道 | 文档 |
|---|---|---|---|
| 出图默认（资产/分镜/拆解链/聊天） | gpt-image-2-03 / -ssvip | `/v1/images/generations` + `/v1/images/edits`（参考图），quality 固定 high | [gpt-image-2-text-to-image](gpt-image-2-text-to-image.md) |
| 出图（gemini 系） | gemini-3.1-flash-image | `/v1beta generateContent`（x-goog-api-key 认证） | [香蕉绘图](gemini-3.1-flash-image-preview.md) |
| 出图（seedream 系） | doubao-seedream-5-0-pro | `/v1/responses` 多图融合（2~10 参考图） | [豆包即梦](doubao-seedream-5.0-lite-t2i.md) |
| 文本（剧本/分镜表/拆解/提示词） | deepseek-v4-flash 等 | OpenAI chat 兼容 | [文本对话](openai-chat.md) / [openai请求格式](fanwei.md) |

## 目录

### 基础文档
- [快速开始](kaishi.md) — 计费、鉴权、通用约定
- [文本对话](openai-chat.md) — chat completions 基本用法
- [openai请求格式](fanwei.md)
- [gemini请求格式](gemini-chat.md)

### AI 绘图
- [GPT绘图](gpt-image-2-text-to-image.md) — gpt-image-2 文生图；quality/auto 尺寸/moderation 参数说明
- [香蕉绘图](gemini-3.1-flash-image-preview.md) — gemini-3.1-flash-image 文生图
- [图片编辑](gemini-3.1-flash-image-preview-edit.md) — gemini 图生图
- [多图合并](gemini-3.1-flash-image-preview-images.md) — 多参考图融合（对标 seedream responses 通道）
- [多轮对话绘图](gemini-3.1-flash-image-preview-duolun.md) — gemini 多轮迭代出图
- [阿里万象](wan2.7-image-text-to-image.md) — wan2.7 图生图（未接入，候选）
- [豆包即梦](doubao-seedream-5.0-lite-t2i.md) — seedream 5.0 lite 文生图（组图/联网搜索增强）

### AI 视频（视频执行层候选，均未接入）
- [海螺视频](hailuo-txt2video.md)
- [VIDU视频](viduq2-pro.md)
- [可灵视频](kling-v2-6-text2video.md)
- [豆包视频](doubao-seedance-2-0-text-to-video.md)
- [阿里万象视频](wan2.6-t2v.md)
- [拍我视频](paiwo-v5.6-ttv.md)
- [快乐马](happyhorse-1.0-t2v-text-to-video.md)

### AI 场景（未来配音/配乐候选，均未接入）
- [TTS文本转语音](minimax-speech.md)
- [AI音乐](music-2.0.md)
