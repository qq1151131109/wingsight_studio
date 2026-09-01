# 🎞️豆包视频

> 来源：https://doc.dmxapi.cn/doubao-seedance-2-0-text-to-video.html
> 官方标题：doubao-seedance-2-0-260128 文生视频 API 使用文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# doubao-seedance-2-0-260128 文生视频 API 使用文档 ​
基于字节跳动 Seedance 2.0 模型的 AI 文生视频接口，可通过文本提示词生成高质量写实风格视频。支持最高 4k 分辨率，视频时长最长 15 秒，支持 7 种宽高比（含 adaptive 自适应模式），并可同步生成匹配的人声、音效及背景音乐。采用异步任务模式，提交任务后通过任务 ID 直接查询获取视频结果。
## 🎬 模型名称 ​

- doubao-seedance-2-0-260128
## 🔗 接口地址 ​

|  | 接口 | 请求方式 | URL
|  | 提交任务 | POST | https://www.dmxapi.cn/v1/responses
|  | 获取结果 | POST | https://www.dmxapi.cn/v1/responses

WARNING
请妥善保管您的 API Key！严禁将密钥泄露给他人、硬编码到代码中或提交到公开的代码仓库。如果怀疑密钥已泄露，请立即前往 DMXAPI 官网重新生成。

异步任务，请妥善保存任务 ID
本模型为异步任务接口：提交任务后不会直接返回视频，只返回一个任务 ID（响应中的 id 字段），需再用查询模型 seedance-2-0-get 凭该 ID 换取最终视频地址。请在提交成功后立即将任务 ID 落库或写入日志妥善保存——一旦丢失将无法找回，本次生成结果也无法再取回，但费用已产生。
## 🎥 文生视频 示例代码 ​

```python
import requests
import json

# 步骤1: 配置 API 连接信息

url = "https://www.dmxapi.cn/v1/responses"
api_key = "sk-******************************************"

# 步骤2: 配置请求头

headers = {
    "Content-Type": "application/json",
    "Authorization": f"{api_key}",
}

# 步骤3: 配置请求参数

payload = {
    # 【model】(string, 必填) 调用的模型 ID
    "model": "doubao-seedance-2-0-260128",

    # 【input】(object[], 必填) 输入给模型的内容，文生视频只需提供文本
    # 也支持与图片（type: "image_url"）、视频（type: "video"）等组合输入
    "input": [
        {
            "type": "text",
            "text": "写实风格，晴朗的蓝天之下，一大片白色的雏菊花田，镜头逐渐拉近，最终定格在一朵雏菊花的特写上，花瓣上有几颗晶莹的露珠",
        }
    ],

    # 【ratio】(string, 可选) 生成视频的宽高比，Seedance 2.0 默认 adaptive
    # 可选值: "16:9"(横屏) / "4:3" / "1:1"(方形) / "3:4" / "9:16"(竖屏) / "21:9"(超宽) / "adaptive"(根据提示词智能选择)
    "ratio": "16:9",

    # 【resolution】(string, 可选) 视频分辨率，Seedance 2.0 默认 720p
    # 可选值: "480p" / "720p"/ "1080p" / "4k"
    "resolution": "480p",

    # 【duration】(integer, 可选) 视频时长（秒），默认值 5
    # Seedance 2.0 取值范围: [4, 15]
    "duration": 4,

    # 【generate_audio】(boolean, 可选) 是否生成与画面同步的音频，默认 true
    # true: 自动生成匹配的人声、音效及背景音乐（生成的有声视频均为单声道）
    # false: 生成无声视频
    "generate_audio": True,

    # 【seed】(integer, 可选) 随机种子，默认 -1（使用随机种子）
    # 取值范围: [-1, 2^32-1]，固定相同 seed 值可复现类似结果，但不保证完全一致
    "seed": -1,

    # 【watermark】(boolean, 可选) 生成视频是否包含水印，默认 false
    # false: 不含水印；true: 含有水印
    "watermark": False,

    # 【return_last_frame】(boolean, 可选) 是否返回视频尾帧图像，默认 false
    # true: 返回 png 格式尾帧，宽高像素与生成视频一致，无水印，可用于衔接下一段连续视频
    "return_last_frame": False,

    # 【execution_expires_after】(integer, 可选) 任务超时阈值（秒），默认 172800（48 小时）
    # 取值范围: [3600, 259200]，超时后任务自动终止并标记为 expired 状态
    "execution_expires_after": 172800,

    # 【callback_url】(string, 可选) 任务状态回调地址
    # 状态变化时推送 POST 请求，状态枚举: queued(排队中) / running(运行中) / succeeded(成功) / failed(失败) / expired(超时)
    "callback_url": "https://www.dmxapi.cn",

    # 【tools】(array, 可选) 可选工具列表，模型根据提示词自主判断是否调用
    "tools": [{"type": "web_search"}],
}

# 步骤4: 发送请求并输出结果

response = requests.post(url, headers=headers, json=payload)
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

### 返回示例 ​

```json
{
  "id": "task_ry9i4RkwdGRnIWYLKgdD6VvHyUFoQU3W",
  "usage": {
    "total_tokens": 18480,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 18480,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

## 📥 获取结果 示例代码 ​

```python
import requests
import json

url = "https://www.dmxapi.cn/v1/responses"
api_key = "sk-******************************************"

headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {api_key}",
}

payload = {
    "model": "seedance-2-0-get",
    "input": "task_ry9i4RkwdGRnIWYLKgdD6VvHyUFoQU3W"
}

response = requests.post(url, headers=headers, json=payload)
result = response.json()
print(json.dumps(result, indent=2, ensure_ascii=False))

# 提取 video_url
try:
    text = result["output"][0]["content"][0]["text"]
    inner = json.loads(text)
    video_url = inner["content"]["video_url"]
    print(f"\n视频链接: {video_url}")
except Exception as e:
    print(f"提取 URL 失败: {e}")
```

### 返回示例 ​

```json
{
  "request_id": "task_ry9i4RkwdGRnIWYLKgdD6VvHyUFoQU3W",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"content\":{\"video_url\":\"https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/02177520799968800000000000000000000ffffac14d8d3a26bee.mp4?X-Tos-Algorithm=TOS4-HMAC-SHA256\\u0026X-Tos-Credential=AKLT_REDACTED\\u0026X-Tos-Date=20260403T092312Z\\u0026X-Tos-Expires=86400\\u0026X-Tos-Signature=bb8d118946ac5480113f9146ae733131fb22614e5b2970c89c52a89575868415\\u0026X-Tos-SignedHeaders=host\"},\"id\":\"cgt-20260403171827-s64n7\",\"model\":\"doubao-seedance-2-0-260128\",\"status\":\"succeeded\"}"
        }
      ]
    }
  ],
  "usage": {
    "total_tokens": 0,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 0,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}

视频链接: https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/02177520799968800000000000000000000ffffac14d8d3a26bee.mp4?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260403T092312Z&X-Tos-Expires=86400&X-Tos-Signature=bb8d118946ac5480113f9146ae733131fb22614e5b2970c89c52a89575868415&X-Tos-SignedHeaders=host
```

© 2026 DMXAPI doubao-seedance-2-0-260128 文生视频
