# DMXAPI 通用接口（OpenAI 兼容）

> 来源：https://doc.dmxapi.com/jiekou.html（抓取于 2026-09-01，要点整理）

## 支持的接口格式

| 格式 | 说明 | Base URL |
|---|---|---|
| OpenAI 官方格式 | 统一格式，Gemini、Claude、DeepSeek 等所有模型均可用此格式请求 | `https://www.dmxapi.cn/v1` |
| Claude 官方格式 | 支持 Claude 原始格式 | `https://www.dmxapi.cn` |
| Google Gemini 官方格式 | 支持 Gemini 原始格式 | `https://www.dmxapi.cn` |

## 端点列表

| 功能 | 接口地址 |
|---|---|
| 对话 | `https://www.dmxapi.cn/v1/chat/completions` |
| 对话（新推出） | `https://www.dmxapi.cn/v1/responses` |
| 嵌入 (Embed) | `https://www.dmxapi.cn/v1/embeddings` |
| 图片生成/编辑 | `https://www.dmxapi.cn/v1/images/generations` |
| 图片编辑 | `https://www.dmxapi.cn/v1/images/edits` |
| 语音转文字 STT | `https://www.dmxapi.cn/v1/audio/transcriptions` |
| 文字转语音 TTS | `https://www.dmxapi.cn/v1/audio/speech` |

## 认证

```
Authorization: Bearer sk-你的key
```

## Python 示例（openai sdk）

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-***",
    base_url="https://www.dmxapi.cn/v1"  # 中转地址需加 /v1 端点
)

response = client.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[{"role": "user", "content": "你好"}]
)
print(response.choices[0].message.content)
```

## curl 示例

```bash
curl --request POST \
  --url https://www.dmxapi.cn/v1/chat/completions \
  --header 'Authorization: Bearer sk-替换为你的key' \
  -H "Content-Type: application/json" \
  --data '{
    "max_tokens": 8192,
    "model": "gpt-4.1-mini",
    "temperature": 0.8,
    "messages": [
      {"role": "system", "content": "你是我的全能助手"},
      {"role": "user", "content": "你好"}
    ]
  }'
```

## 安全提示

妥善保管 API 密钥，不要泄露。
