# DMXAPI gpt-image 系绘图接口（本项目默认模型 gpt-image-2-03 的通道）

> 来源：https://doc.dmxapi.com/img-gpt-image-1.html 与
> https://doc.dmxapi.com/img-gpt-image-1-edit.html（抓取于 2026-09-01，要点整理）。
> DMX 文档以 gpt-image-1 为例；本项目用的 gpt-image-2-03 / gpt-image-2-ssvip
> 走同一 images 兼容通道（探针验证见 agent/models.py）。

## 文生图 / 多图合并

| 项目 | 内容 |
|---|---|
| 请求 URL | `https://www.dmxapi.cn/v1/images/generations` |
| 方法 | `POST` |
| 认证头 | `Authorization: Bearer YOUR_API_KEY` |
| Content-Type | `application/json` |

### 请求参数（文档列出的字段）

| 名称 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 图像描述文本 |
| `model` | string | 模型名（文档示例 `gpt-image-1`；本项目 `gpt-image-2-03` 等） |
| `n` | number | 生成数量 |
| `size` | string | 尺寸，如 `1024x1024` / `1024x1536` |

> **quality 参数：DMX 文档页未记载。** 上游 OpenAI images API 对 gpt-image 系
> 支持 `quality: low|medium|high|auto`（high 最贵最慢），DMX 作为透传网关是否
> 接受该参数以实测探针为准（2026-09-01 时点未验证，验证后应在本文件补记结论）。

### 请求示例

```http
POST /v1/images/generations
Authorization: Bearer sk-xxx
Content-Type: application/json

{"prompt": "描述文本", "model": "gpt-image-1", "n": 1, "size": "1024x1024"}
```

### 响应格式

JSON `data` 数组，每个元素可能是：

- `b64_json`：base64 编码的图片数据
- `url`：图片 URL

### Python 示例（要点等价）

```python
import requests, base64

r = requests.post(
    "https://www.dmxapi.cn/v1/images/generations",
    headers={"Authorization": "Bearer sk-xxx"},
    json={"prompt": "提示词", "model": "gpt-image-1", "n": 1, "size": "1024x1536"},
)
r.raise_for_status()
for i, item in enumerate(r.json()["data"]):
    if "b64_json" in item:
        with open(f"generated_{i}.png", "wb") as f:
            f.write(base64.b64decode(item["b64_json"]))
    elif "url" in item:
        print(item["url"])
```

## 单图编辑（/v1/images/edits）

| 项目 | 内容 |
|---|---|
| Base URL | `https://www.dmxapi.cn/v1/images/edits` |
| 请求方式 | `POST`（`multipart/form-data`，非 JSON） |
| 认证方式 | Bearer Token |

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 编辑要求描述 |
| `image` | file | 是 | 待编辑图片文件；参数名必须为 `"image"`（`image/png`、`image/jpeg`） |
| `size` | string | 否 | 输出尺寸（如 `1024x1024`）；编辑通常保持原图比例，强制指定可能裁剪/缩放 |

### 响应

编辑结果在 `data[0].b64_json`（base64），解码后落盘。

### 请求流程要点

```python
files = {"image": ("photo.png", open("photo.png", "rb"), "image/png")}
payload = {"prompt": "编辑要求", "size": "1024x1024"}  # size 可选
r = requests.post(url, headers=headers, data=payload, files=files)
# 200 → r.json()["data"][0]["b64_json"] → base64 解码写 PNG
```

## 成本提示

原文档称 gpt-image 系为效果最好但最贵的绘图模型（gpt-image-1 时代每张约 ￥0.8~1.2）。
