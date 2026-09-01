# 🖌️香蕉绘图

> 来源：https://doc.dmxapi.cn/gemini-3.1-flash-image-preview.html
> 官方标题：Gemini 3.1 Flash Image 文生图（Nano Banana 2）
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# Gemini 3.1 Flash Image 文生图（Nano Banana 2） ​
通过 Gemini 3.1 Flash Image 模型生成高质量图像，支持多种宽高比和分辨率配置。

推荐模型：gemini-3.1-flash-image
Gemini 3.1 Flash Image 是目前最新的图像生成模型，相比前代有以下重要升级：

- 多档分辨率：支持 1K / 2K / 4K 三档分辨率
- 更多宽高比：新增 1:4、4:1、1:8、8:1 等极端比例，共支持 14 种宽高比
- Image Search 图片搜索：全新工具，可从网络图片中获取视觉参考辅助生成
- Thinking 思考配置：支持思考模式
## 接口地址 ​

```
https://www.dmxapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent
```

注意：
需要升级谷歌sdk为最新版
## 模型名称 ​
### Gemini 3.1 Flash Image ​

- 模型名称: gemini-3.1-flash-image
- 别名: Nano Banana 2
- 特点: 速度优先，支持 1K/2K/4K 分辨率
- 新特性: 支持 Image Search（图片搜索）生成、Thinking 思考配置
## 示例代码 ​

SDKrequest

```python
"""
DMXAPI Gemini 3.1 Flash Image 图像生成示例
使用 Google Gemini API 生成图像，并保存到本地 output 文件夹
"""

from google import genai
from google.genai import types
import os
from datetime import datetime

# ============================================================================
# 配置部分
# ============================================================================

# DMXAPI 密钥和基础 URL
api_key = "sk-************************************"  # 替换为你的 DMXAPI 密钥
BASE_URL = "https://www.dmxapi.cn"

# 创建 Gemini 客户端
client = genai.Client(api_key=api_key, http_options={'base_url': BASE_URL})

# ============================================================================
# 图像生成提示词
# ============================================================================

# 定义图像生成的提示词
prompt = (
    "Visualize the current weather forecast for the next 5 days in ShangHi as a clean, modern weather chart. Add a visual on what I should wear each day"
)

# ============================================================================
# 调用 DMXAPI 生成图像
# ============================================================================

response = client.models.generate_content(
    # 模型名称
    model="gemini-3.1-flash-image",

    # 输入内容
    contents=[prompt],

    # 生成配置
    config=types.GenerateContentConfig(
        # response_modalities: 设置响应模态
        # - ['Image']: 仅返回图片，不返回文本
        # - ['Text', 'Image']: 同时返回文本和图片（默认值）
        response_modalities=['Image'],

        # image_config: 图像配置选项
        image_config=types.ImageConfig(
            # aspect_ratio: 设置输出图片的宽高比（注意：使用驼峰命名）
            #
            # ┌────────────────────────────────────────────────────────────────┐
            # │ Gemini 3.1 Flash Image                                          │
            # ├──────────┬─────────────┬────────┬─────────────┬────────────┤
            # │ 宽高比    │ 1K 分辨率   │ 1K令牌  │ 2K 分辨率   │ 4K 分辨率  │
            # ├──────────┼─────────────┼────────┼─────────────┼────────────┤
            # │ 1:1      │ 1024x1024   │ 1120   │ 2048x2048   │ 4096x4096  │
            # │ 1:4      │ 512x2048    │ 1120   │ 1024x4096   │ 2048x8192  │
            # │ 1:8      │ 384x3072    │ 1120   │ 768x6144    │ 1536x12288 │
            # │ 2:3      │ 848x1264    │ 1120   │ 1696x2528   │ 3392x5056  │
            # │ 3:2      │ 1264x848    │ 1120   │ 2528x1696   │ 5056x3392  │
            # │ 3:4      │ 896x1200    │ 1120   │ 1792x2400   │ 3584x4800  │
            # │ 4:1      │ 2048x512    │ 1120   │ 4096x1024   │ 8192x2048  │
            # │ 4:3      │ 1200x896    │ 1120   │ 2400x1792   │ 4800x3584  │
            # │ 4:5      │ 928x1152    │ 1120   │ 1856x2304   │ 3712x4608  │
            # │ 5:4      │ 1152x928    │ 1120   │ 2304x1856   │ 4608x3712  │
            # │ 8:1      │ 3072x384    │ 1120   │ 6144x768    │ 12288x1536 │
            # │ 9:16     │ 768x1376    │ 1120   │ 1536x2752   │ 3072x5504  │
            # │ 16:9     │ 1376x768    │ 1120   │ 2752x1536   │ 5504x3072  │
            # │ 21:9     │ 1584x672    │ 1120   │ 3168x1344   │ 6336x2688  │
            # └──────────┴─────────────┴────────┴─────────────┴────────────┘
            # 注: 1K/2K令牌为1120, 4K令牌为2000
            #
            aspect_ratio="1:1",

            # image_size: 设置输出图片的分辨率
            # - "1K": 1K 分辨率（默认值）
            # - "2K": 2K 分辨率
            # - "4K": 4K 分辨率
            image_size="1K",
        ),

        # tools: Google 搜索工具（可选）
        # - 使用实时信息生成图像（如天气预报、股市图表、近期活动等）
        # - 可与 response_modalities=['Image'] 或 ['Text', 'Image'] 搭配使用
        # 示例: tools=[{"google_search": {}}]
        #
        # Gemini 3.1 Flash Image 支持 Image Search（图片搜索）：
        # tools=[types.Tool(google_search=types.GoogleSearch(
        #     search_types=types.SearchTypes(
        #         web_search=types.WebSearch(),
        #         image_search=types.ImageSearch()
        #     )
        # ))]
    )
)

# ============================================================================
# 处理响应并保存图像
# ============================================================================

for part in response.parts:
    # 处理文本响应（如果有）
    if part.text is not None:
        print(part.text)

    # 处理图像响应
    elif part.inline_data is not None:
        # 确保 output 文件夹存在
        os.makedirs("output", exist_ok=True)

        # 生成带时间戳的文件名
        # 格式: generated_image_20250121_143052.png (年月日_时分秒)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"output/generated_image_{timestamp}.png"

        # 将响应数据转换为 PIL Image 对象
        image = part.as_image()

        # 保存图像到文件
        image.save(filename)

        # 输出保存成功的提示信息
        print(f"图片已保存到 {filename}")
```

```python
"""
Gemini 3.1 Flash Image - 文生图 API 调用示例
=================================================
"""

import requests  # HTTP 请求库
import base64    # Base64 编解码库

# ============================================================================
# API 配置
# ============================================================================
# DMXAPI 密钥 (请替换为你的实际密钥)
API_KEY = "sk-****************************************"

# API 请求地址
API_URL = "https://www.dmxapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent"

# ============================================================================
# 请求头
# ============================================================================
headers = {
    "x-goog-api-key": API_KEY,       # API 认证密钥
    "Content-Type": "application/json"  # 请求内容类型为 JSON
}

# ============================================================================
# 请求体
# ============================================================================
data = {
    "contents": [{                   # 内容数组
        "parts": [                   # 消息部分
            {
                # 图片生成提示词 (修改此处描述你想要生成的图片)
                "text": "生成一个美丽的日落风景，色彩丰富，充满艺术感。",
            }
        ]
    }],

    # ========================================================================
    # 生成配置
    # ========================================================================
    "generationConfig": {
        # responseModalities: 设置响应模态
        # - ["IMAGE"]: 仅返回图片，不返回文本
        # - ["TEXT", "IMAGE"]: 同时返回文本和图片（默认值）
        "responseModalities": ["IMAGE"],

        # imageConfig: 图像配置选项
        "imageConfig": {
            # aspectRatio: 设置输出图片的宽高比
            #
            # ┌────────────────────────────────────────────────────────────────┐
            # │ Gemini 3.1 Flash Image                                          │
            # ├──────────┬─────────────┬────────┬─────────────┬────────────┤
            # │ 宽高比    │ 1K 分辨率   │ 1K令牌  │ 2K 分辨率   │ 4K 分辨率  │
            # ├──────────┼─────────────┼────────┼─────────────┼────────────┤
            # │ 1:1      │ 1024x1024   │ 1120   │ 2048x2048   │ 4096x4096  │
            # │ 1:4      │ 512x2048    │ 1120   │ 1024x4096   │ 2048x8192  │
            # │ 1:8      │ 384x3072    │ 1120   │ 768x6144    │ 1536x12288 │
            # │ 2:3      │ 848x1264    │ 1120   │ 1696x2528   │ 3392x5056  │
            # │ 3:2      │ 1264x848    │ 1120   │ 2528x1696   │ 5056x3392  │
            # │ 3:4      │ 896x1200    │ 1120   │ 1792x2400   │ 3584x4800  │
            # │ 4:1      │ 2048x512    │ 1120   │ 4096x1024   │ 8192x2048  │
            # │ 4:3      │ 1200x896    │ 1120   │ 2400x1792   │ 4800x3584  │
            # │ 4:5      │ 928x1152    │ 1120   │ 1856x2304   │ 3712x4608  │
            # │ 5:4      │ 1152x928    │ 1120   │ 2304x1856   │ 4608x3712  │
            # │ 8:1      │ 3072x384    │ 1120   │ 6144x768    │ 12288x1536 │
            # │ 9:16     │ 768x1376    │ 1120   │ 1536x2752   │ 3072x5504  │
            # │ 16:9     │ 1376x768    │ 1120   │ 2752x1536   │ 5504x3072  │
            # │ 21:9     │ 1584x672    │ 1120   │ 3168x1344   │ 6336x2688  │
            # └──────────┴─────────────┴────────┴─────────────┴────────────┘
            # 注: 1K/2K令牌为1120, 4K令牌为2000
            "aspectRatio": "1:1",

            # image_size: 设置输出图片的分辨率
            # - "1K": 1K 分辨率（默认值）
            # - "2K": 2K 分辨率
            # - "4K": 4K 分辨率
            # "imageSize": "1K",
        }
    },

    # ========================================================================
    # 工具配置（可选）
    # ========================================================================
    # tools: Google 搜索工具（可选）
    # - 使用实时信息生成图像（如根据最新资讯添加元素等）
    # - 可与 responseModalities: ["IMAGE"] 或 ["TEXT", "IMAGE"] 搭配使用
    # "tools": [{"google_search": {}}]
    #
    # Gemini 3.1 Flash Image 支持 Image Search（图片搜索）：
    # "tools": [{"google_search": {"search_types": {"web_search": {}, "image_search": {}}}}]
}

# ============================================================================
# 发送请求
# ============================================================================
response = requests.post(
    API_URL,          # 请求地址
    headers=headers,  # 请求头
    json=data         # 请求体 (自动序列化为 JSON)
)

# ============================================================================
# 响应处理
# ============================================================================
if response.status_code == 200:
    # 请求成功，解析 JSON 响应
    result = response.json()

    try:
        # 响应结构: candidates[0].content.parts[].inlineData.data
        parts = result["candidates"][0]["content"]["parts"]

        for part in parts:
            # 检查是否包含图片数据
            if "inlineData" in part:
                # 提取 Base64 编码的图片数据
                image_data = part["inlineData"]["data"]

                # Base64 解码为二进制数据
                image_bytes = base64.b64decode(image_data)

                # 输出文件名
                output_file = "gemini-native-image.png"

                # 写入文件
                with open(output_file, "wb") as f:
                    f.write(image_bytes)

                print(f"[成功] 图片已保存: {output_file}")
                break

    except (KeyError, IndexError) as e:
        # 响应结构异常
        print(f"[错误] 响应解析失败: {e}")
        print(f"[调试] 响应内容: {result}")

else:
    # 请求失败
    print(f"[错误] API 请求失败, 状态码: {response.status_code}")
    print(f"[调试] 错误信息: {response.text}")
```

## 返回示例 ​

SDKrequest

```text
图片已保存到 output/generated_image_20260227_183649.png
```

```json
[成功] 图片已保存: gemini-native-image.png
```

## 注意事项 ​

- 请将代码中的 API 密钥替换为你自己的 DMXAPI 密钥
- 生成的图像会自动保存到 output 文件夹（如不存在会自动创建）
- response_modalities 参数可以控制返回内容类型（仅图像或图像+文本）
- 为获得最佳性能，请使用以下语言：英语、阿拉伯语（埃及）、德语（德国）、西班牙语（墨西哥）、法语（法国）、印地语（印度）、印度尼西亚语（印度尼西亚）、意大利语（意大利）、日语（日本）、韩语（韩国）、葡萄牙语（巴西）、俄语（俄罗斯）、乌克兰语（乌克兰）、越南语（越南）、中文（中国）。
- gemini-3.1-flash-image 支持额外的 1:4, 4:1, 1:8, 8:1 宽高比。
- gemini-3.1-flash-image 支持 Image Search 图片搜索工具，可从网络图片中获取视觉参考。
© 2026 DMXAPI Gemini模型
