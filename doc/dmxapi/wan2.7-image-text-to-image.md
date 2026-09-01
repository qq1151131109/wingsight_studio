# 🖌️阿里万象

> 来源：https://doc.dmxapi.cn/wan2.7-image-text-to-image.html
> 官方标题：wan2.7-image 文生图 API 使用文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# wan2.7-image 文生图 API 使用文档 ​
万相 2.7 image 是阿里云百炼推出的高效文生图模型，通过 /v1/responses 端点调用，支持最高 2K（2048×2048）分辨率输出，提供思考模式以增强推理能力提升出图质量，并支持自定义颜色主题（3-10 种颜色混调）、随机种子控制和组图批量输出（最多 12 张）。相较于专业版 wan2.7-image-pro，标准版生成速度更快，适合对出图效率有较高要求的多样化文生图场景。
## 🌐 请求地址 ​

```
https://www.dmxapi.cn/v1/responses
```

WARNING
请妥善保管您的 API Key！严禁将密钥泄露给他人、硬编码到代码中或提交到公开的代码仓库。如果怀疑密钥已泄露，请立即前往 DMXAPI 官网重新生成。
## 🤖 模型名称 ​

- wan2.7-image
## 🖼️ 文生图示例代码 ​

```python
import requests
import json

# 步骤1: 配置 API 连接信息

# DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-******************************************"

# 步骤2: 配置请求头

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",           # token 认证方式
}

# 步骤3: 配置请求参数

payload = {
    # 【model】(string, 必选) 模型名称
    "model": "wan2.7-image",
    "input": {
        # 【messages】(array, 必选) 请求内容数组
        # 当前仅支持单轮对话，即传入一组 role、content 参数，不支持多轮对话
        "messages": [
            {
                # 【role】(string, 必选) 消息的角色，此参数固定设置为 "user"
                "role": "user",
                # 【content】(array, 必选) 消息内容数组
                "content": [
                    # 【text】(string, 可选) 用户输入提示词
                    # 支持中英文，长度不超过 5000 个字符（每个汉字、字母、数字或符号计为一个字符）
                    # 超过部分会自动截断
                    {"text": "一间有着精致窗户的花店，漂亮的木质门，摆放着花朵"}
                ],
            }
        ]
    },
    "parameters": {
        # 【enable_sequential】(boolean, 可选) 控制生图模式
        # false: 默认值，普通生图模式，n 的取值范围为 1-4
        # true: 启用组图输出模式，n 的取值范围变为 1-12，实际数量由模型决定
        "enable_sequential": False,
        # 【size】(string, 可选) 输出图片分辨率，支持以下两种方式，不可混用
        # 方式一（推荐）指定规格: "1K"(1024x1024) / "2K"(2048x2048，默认)
        # 方式二 指定宽高像素值: 如 "1024*768"，总像素在 [768x768, 2048x2048]，宽高比范围 [1:8, 8:1]
        "size": "2K",
        # 【n】(int, 可选) 生成图像数量，直接影响费用（费用 = 单价 × 成功生成的图片张数）
        # 关闭组图模式（enable_sequential=false）时: 取值范围 1-4，默认为 4
        # 开启组图模式（enable_sequential=true）时: 取值范围 1-12，默认为 12，实际数量由模型决定且不超过 n
        "n": 1,
        # 【watermark】(bool, 可选) 是否在图片右下角添加"AI生成"水印
        # false: 默认值，不添加水印
        # true: 添加水印
        "watermark": False,
        # 【thinking_mode】(boolean, 可选) 是否开启思考模式，默认为 true（开启）
        # 仅在关闭组图模式（enable_sequential=false）且无图片输入（纯文生图）时生效
        # 开启时模型将增强推理能力以提升出图质量，但会增加生成耗时
        "thinking_mode": True,
        # 【seed】(integer, 可选) 随机数种子，取值范围 [0, 2147483647]
        # 使用相同的 seed 值可使生成内容保持相对稳定；不提供则由算法自动使用随机种子
        # 注意: 模型生成具有概率性，即使相同 seed 也不能保证每次结果完全一致
        "seed": 42,
        # 【color_palette】(array, 可选) 自定义颜色主题
        # 包含颜色(hex)和占比(ratio)的对象数组，需包含 3 至 10 种颜色，推荐设置为 8 种
        # 仅在关闭组图模式（enable_sequential=false）时可用
        "color_palette": [
            {
                # 【hex】(string, 必选) 十六进制(HEX)格式的色值，如 "#FF5733"
                # 【ratio】(string, 必选) 颜色所占百分比，需精确到小数点后两位（如 "25.00%"）
                # 所有 ratio 值相加总和必须为 100.00%
                "hex": "#FF5733", "ratio": "25.00%"
            },
            {"hex": "#33FF57", "ratio": "25.00%"},
            {"hex": "#3357FF", "ratio": "25.00%"},
            {"hex": "#F0E68C", "ratio": "25.00%"},
        ],
    },
}

# 步骤4: 发送请求并输出结果

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)

# 格式化输出 JSON 响应
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

## 📋 返回示例 ​

```json
{
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "image",
          "text": "https://dashscope-7c2c.oss-accelerate.aliyuncs.com/1d/1f/20260407/9f3c4033/8e4c044c-1c47-4407-bd1a-b7eab3cac906_0.png?Expires=1775663477&OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1&Signature=5bAmea4%2FfLq2mPwtjQunXRdkg9k%3D"
        }
      ]
    }
  ],
  "request_id": "27027308-61b0-9f7e-acf4-3f26bdf15211",
  "usage": {
    "total_tokens": 2000,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 2000,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

说明：output[0].content[0].text 字段为生成图像的 URL（PNG 格式），链接有效期为 24 小时，请及时下载并保存图像。
© 2026 DMXAPI wan2.7-image 文生图
