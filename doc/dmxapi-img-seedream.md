# DMXAPI 豆包即梦（seedream / seededit）绘图接口

> 来源：https://doc.dmxapi.com/img-seedream-images.html 与
> https://doc.dmxapi.com/img-seedream-edit.html（抓取于 2026-09-01，要点整理）。
> 对应本项目 doubao-seedream-4-0-250828（4-5 / 5-0-pro 亦为豆包系，5-0-pro 走
> /v1/responses 多图融合通道，DMX 文档站未见专页）。

## 多图合并 / 文生图（/v1/images/generations）

- **模型名**：`doubao-seedream-4-0-250828`、`seededit-3.0`
- **端点**：`POST https://www.dmxapi.cn/v1/images/generations`
- **认证**：`Authorization: Bearer sk-***`，`Content-Type: application/json`

### 请求参数

| 参数 | 说明 |
|------|------|
| `model` | 模型名称 |
| `prompt` | 图像生成的文本描述提示词 |
| `image` | 输入的图像 URL **数组**，支持多张图片合并（图生图/多图融合） |

### 请求体示例

```json
{
  "model": "doubao-seedream-4-0-250828",
  "prompt": "把DMXAPI的logo放在T恤上面",
  "image": [
    "https://dmxapi.com/img/yifu.png",
    "https://dmxapi.com/DMXAPI-Banner.png"
  ]
}
```

### 注意事项

1. **URL 转义**：响应里的图片 URL 含转义字符（如 `\u0026` 代表 `&`），需替换后
   再 JSON 解析，并 `urllib.parse.unquote` 解码才能得到可访问 URL。
2. **多图合并**：`image` 传 URL 数组即可融合生成（示例：T恤图 + logo 图合成）。
3. 官方参考：即梦4 https://www.volcengine.com/docs/82379/1541523

## seededit 图片编辑（单图）

- **端点**：同上 `/v1/images/generations`，`image` 传**单个 URL 字符串**（非数组）

| 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| model | string | 是 | 如 `doubao-seedream-4-0-250828` |
| prompt | string | 是 | 图像编辑的文本描述 |
| image | string | 是 | 待编辑原始图像的 URL |

### curl 示例

```bash
curl -X POST "https://www.dmxapi.cn/v1/images/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key-here" \
  -d '{
    "model": "doubao-seedream-4-0-250828",
    "prompt": "改成方块形状的泡泡",
    "image": "https://ark-project.tos-cn-beijing.volces.com/doc_image/seededit_i2i.jpeg"
  }'
```

### 响应

```json
{ "data": [ { "url": "https://example.com/generated-image.jpg" } ] }
```

### 补充要点

- Prompt 越详细效果越好（主体、艺术风格、色彩、构图）。
- 固定 `seed` 可复现相同图片；`-1` 为随机。
- 错误码：`401` 认证失败 / `400` 参数错误 / `429` 频率限制 / `500` 服务器内部错误。
