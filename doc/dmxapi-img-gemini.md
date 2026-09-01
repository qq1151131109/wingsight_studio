# DMXAPI gemini 图像（Nano Banana）接口存档

> 来源：https://doc.dmxapi.com/img-nano-banana-images.html（抓取于 2026-09-01）。
> **注意**：本项目 gemini-3.1-flash-image 实际不走这篇的 images 兼容层，而是走
> Gemini 原生 `v1beta generateContent`（x-goog-api-key 认证、imageConfig 控制
> 幅面/档位）——见 agent/flows/asset-imagegen.json 的 generate_image_gemini
> 组件。本文仅作 DMX 官方通道存档备查。

## 模型名

- `nano-banana`
- `gemini-2.5-flash-image`

## 基础信息

- **Base URL**: `https://www.dmxapi.cn/v1/images/generations`
- **请求方式**: POST
- **认证方式**: Bearer Token（`Authorization: Bearer {API_KEY}`）

## 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| prompt | string | 是 | 图像描述文本 |
| size | string | 是 | 比例：`1x1` / `3x4` / `4x3` / `9x16` / `16x9` |
| seed | int | 否 | 随机种子（-1 表示随机） |

⚠️ 代码示例中还实际使用了表格外字段：`model`（指定模型）、`image`（图片 URL
数组，多图合并）。

## Python 示例

```python
import json, requests

payload = json.dumps({
    "model": "gemini-2.5-flash-image",
    "prompt": "把DMXAPI的logo放在女人的T恤上面",
    "image": [
        "https://v3.fal.media/files/penguin/xxx_image.webp",
        "https://dmxapi.com/DMXAPI-Banner.png",
    ],
})
headers = {"Authorization": "Bearer sk-***", "Content-Type": "application/json"}
response = requests.post("https://www.dmxapi.cn/v1/images/generations",
                         headers=headers, data=payload)
print(response.text)
```

## 响应示例

```json
{
  "data": [ { "url": "https://....png" } ],
  "created": 1756276430
}
```

- 本地图合并另有 base64 版文档：
  https://doc.dmxapi.com/img-nano-banana-images-base64.html（走 /v1/images/edits，
  multipart/form-data 上传本地图片）。
