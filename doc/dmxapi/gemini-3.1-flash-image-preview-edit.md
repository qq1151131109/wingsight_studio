# ----图片编辑

> 来源：https://doc.dmxapi.cn/gemini-3.1-flash-image-preview-edit.html
> 官方标题：Gemini 3.1 Flash Image 图片编辑
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# Gemini 3.1 Flash Image 图片编辑 ​
使用 Gemini 3.1 Flash Image 模型进行智能图片编辑
## 接口地址 ​

```
https://www.dmxapi.cn/v1beta/models/gemini-3.1-flash-image:generateContent
```

注意：
需要升级谷歌sdk为最新版
## 模型名称 ​
### Gemini 3.1 Flash Image ​

- 模型名称: gemini-3.1-flash-image
- 特点: 速度优先，支持 1K/2K/4K 分辨率，支持 Image Search 和 Thinking
## 示例代码 ​

SDKrequest

```python
"""
DMXAPI Gemini 3.1 Flash Image 图像修改示例
使用 Google Gemini API 修改图像，并保存到本地 output 文件夹
"""

from google import genai
from google.genai import types
from PIL import Image
import os
from datetime import datetime

# ============================================================================
# 配置部分
# ============================================================================

# DMXAPI 密钥和基础 URL
api_key = "sk-***********************************"  # 替换为你的 DMXAPI 密钥
BASE_URL = "https://www.dmxapi.cn"

# 输入图像路径
INPUT_IMAGE_PATH = "./b1.png"  # 替换为你要修改的图片路径

# 创建 Gemini 客户端
client = genai.Client(api_key=api_key, http_options={'base_url': BASE_URL})

# ============================================================================
# 图像修改提示词
# ============================================================================

# 读取要修改的图像
image = Image.open(INPUT_IMAGE_PATH)

# 定义图像修改的提示词
prompt = (
    "让图里的人手里拿着鲜花"
)

# ============================================================================
# 调用 DMXAPI 修改图像
# ============================================================================

response = client.models.generate_content(
    # 模型名称
    model="gemini-3.1-flash-image",

    # 输入内容：提示词 + 原始图像
    contents=[prompt, image],

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
        # - 使用实时信息修改图像（如根据最新资讯添加元素等）
        # - 可与 response_modalities=['Image'] 或 ['Text', 'Image'] 搭配使用
        #
        # Gemini 3.1 Flash Image 支持 Image Search（图片搜索）：
        tools=[types.Tool(google_search=types.GoogleSearch(
            search_types=types.SearchTypes(
                web_search=types.WebSearch(),
                image_search=types.ImageSearch()
            )
        ))]
        # tools=[{"google_search": {}}]
    )
)

# ============================================================================
# 处理响应并保存修改后的图像
# ============================================================================

# 检查响应是否有效
if not response.candidates:
    print("API 未返回任何候选结果。")
    print(f"完整响应: {response}")
elif response.candidates[0].finish_reason:
    print(f"结束原因: {response.candidates[0].finish_reason}")

if response.parts is None:
    print("响应中没有内容 (response.parts 为 None)，可能原因：")
    print("  1. 请求被安全过滤器拦截")
    print("  2. 模型/参数组合不支持")
    print("  3. API 返回了空响应")
    print(f"完整响应: {response}")
    exit(1)

for part in response.parts:
    # 处理文本响应（如果有）
    if part.text is not None:
        print(part.text)

    # 处理图像响应
    elif part.inline_data is not None:
        # 确保 output 文件夹存在
        os.makedirs("output", exist_ok=True)

        # 生成带时间戳的文件名
        # 格式: edited_image_20250121_143052.png (年月日_时分秒)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"output/edited_image_{timestamp}.png"

        # 将响应数据转换为 PIL Image 对象
        image = part.as_image()

        # 保存图像到文件
        image.save(filename)

        # 输出保存成功的提示信息
        print(f"修改后的图片已保存到 {filename}")
```

```python
"""
================================================================
Gemini 3.1 Flash Image 图文生图示例
================================================================
功能说明：
    使用 Google Gemini API 的接口，根据文字提示词和输入图片生成新图片。
    支持调整输出图片的比例、大小，以及调用谷歌搜索工具。
================================================================
"""
import requests
import base64
import os
from datetime import datetime

# ========================================
# API 配置信息
# ========================================
# 你的 DMXAPI 密钥（请替换为真实密钥）
API_KEY = "sk-**************************************"

# DMXAPI 请求地址
BASE_URL = "https://www.dmxapi.cn/v1beta"

# ========================================
# 图片配置
# ========================================
# 输入图片路径
INPUT_IMAGE_PATH = "./b1.png"

# ========================================
# 图片编码函数
# ========================================
def encode_image_to_base64(image_path: str) -> tuple[str, str]:
    """读取图片文件并转换为 base64 编码"""
    ext = os.path.splitext(image_path)[1].lower()
    mime_types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
    }
    mime_type = mime_types.get(ext, 'image/jpeg')

    with open(image_path, 'rb') as f:
        image_data = f.read()

    return base64.b64encode(image_data).decode('utf-8'), mime_type

# ========================================
# 构建请求头
# ========================================
headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": API_KEY,
}

# ========================================
# 构建请求体
# ========================================
# 编码图片为 base64
img_base64, mime_type = encode_image_to_base64(INPUT_IMAGE_PATH)

payload = {
    "model": "gemini-3.1-flash-image",                          # 指定使用的 AI 模型
    "contents": [{
        "parts": [
            {"text": "在图像中加入梵高的自画像,画面左上角有今天的日期"},
            {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": img_base64
                }
            }
        ]
    }],
    "generationConfig": {
        # responseModalities: 设置响应模态
        # - ['IMAGE']: 仅返回图片，不返回文本
        # - ['TEXT', 'IMAGE']: 同时返回文本和图片（默认值）
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

            # imageSize: 设置输出图片的分辨率
            # - "1K": 1K 分辨率（默认值）
            # - "2K": 2K 分辨率
            # - "4K": 4K 分辨率
            "imageSize": "1K"
        }
    },

    # tools: Google 搜索工具（可选）
    # - 使用实时信息生成图像（如根据最新资讯添加元素等）
    # - 可与 responseModalities: ["IMAGE"] 或 ["TEXT", "IMAGE"] 搭配使用
    #
    # Gemini 3.1 Flash Image 支持 Image Search（图片搜索）：
    "tools": [{"google_search": {"search_types": {"web_search": {}, "image_search": {}}}}]
}

# 完整的 API 端点
API_URL = f"{BASE_URL}/models/{payload['model']}:generateContent"

# ========================================
# 发送 API 请求并处理响应
# ========================================
try:
    # 发送 POST 请求到 API 服务器
    response = requests.post(API_URL, headers=headers, json=payload, timeout=(30, 300))

    # 检查 HTTP 响应状态码
    response.raise_for_status()

    # ========================================
    # 输出成功结果
    # ========================================
    print("请求成功!")
    print("=" * 60)

    result = response.json()
    image_saved = False

    for candidate in result.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if "text" in part:
                print(f"文本响应: {part['text']}")
            elif "inlineData" in part:
                image_data = part["inlineData"].get("data", "")
                if image_data:
                    os.makedirs("output", exist_ok=True)
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    filename = f"output/gemini-edited-image_{timestamp}.png"

                    with open(filename, 'wb') as f:
                        f.write(base64.b64decode(image_data))

                    print(f"图片已保存到: {filename}")
                    image_saved = True

    if not image_saved:
        print("响应中没有找到图片数据")

except requests.exceptions.RequestException as e:
    print(f"请求失败: {e}")
except ValueError as e:
    print(f"数据解析错误: {e}")
```

## 返回示例 ​

SDKrequest

```text
结束原因: FinishReason.STOP
修改后的图片已保存到 output/edited_image_20260227_165150.png
```

```json
请求成功!
============================================================
图片已保存到: output/gemini-edited-image_20260227_170409.png
```

## 注意事项 ​

- 请将代码中的 API 密钥替换为你自己的 DMXAPI 密钥
- 确保 INPUT_IMAGE_PATH 指向的图片文件存在
- 支持 1K/2K/4K 分辨率，且额外支持 1:4, 4:1, 1:8, 8:1 宽高比
- 支持 Image Search 图片搜索工具，可从网络图片中获取视觉参考
© 2026 DMXAPI - Gemini 图像编辑 API 文档
