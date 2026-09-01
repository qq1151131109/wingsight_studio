# 🎞️快乐马

> 来源：https://doc.dmxapi.cn/happyhorse-1.0-t2v-text-to-video.html
> 官方标题：happyhorse-1.0-t2v 文生视频 API 使用文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# happyhorse-1.0-t2v 文生视频 API 使用文档 ​
HappyHorse 文生视频 API 基于 happyhorse-1.0-t2v 模型，输入文本提示词即可生成物理真实、运动流畅的视频内容。支持 720P 和 1080P 两种分辨率、9 种宽高比（16:9、9:16、1:1、4:3、3:4、4:5、5:4、9:21、21:9），可自定义视频时长（3–15 秒），并支持水印控制与随机种子固定。接口采用两步异步模式：先提交任务获取任务 ID，再通过任务 ID 查询并获取生成视频。
## 模型名称 ​

- happyhorse-1.0-t2v
## 接口地址 ​

|  | 接口 | 请求方式 | URL
|  | 提交任务 | POST | https://www.dmxapi.cn/v1/responses
|  | 获取结果 | POST | https://www.dmxapi.cn/v1/responses

WARNING
请妥善保管您的 API Key！严禁将密钥泄露给他人、硬编码到代码中或提交到公开的代码仓库。
## 文生视频 示例代码 ​

```python
import requests
import json

# 步骤1: 配置 API 连接信息
url = "https://www.dmxapi.cn/v1/responses"
api_key = "sk-******************************************"

# 步骤2: 配置请求头
headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",            # token 认证方式
}

# 步骤3: 配置请求参数
payload = {
    # 【model】(string, 必填) 模型名称
    # 可选值: "happyhorse-1.0-t2v"
    "model": "happyhorse-1.0-t2v",
    # 【input】(array, 必填) 模型的输入信息列表
    "input": [{
        # 【prompt】(string, 必填) 文本提示词，用于描述期望生成的视频内容
        # 支持任何语言输入，长度不超过 5000 个非中文字符或 2500 个中文字符，超过部分将自动截断
        "prompt": "一座由硬纸板和瓶盖搭建的微型城市，在夜晚焕发出生机。一列硬纸板火车缓缓驶过，小灯点缀其间，照亮前路。"
    }],
    # 【parameters】(object, 可选) 视频处理参数，如设置视频分辨率、设置视频时长等
    "parameters": {
        # 【resolution】(string, 可选) 指定生成视频的分辨率档位
        # 可选值: "720P" / "1080P"（默认值）
        "resolution": "720P",
        # 【ratio】(string, 可选) 指定生成视频的宽高比
        # 可选值: "16:9"（默认值）/ "9:16" / "1:1" / "4:3" / "3:4" / "4:5" / "5:4" / "9:21" / "21:9"
        "ratio": "16:9",
        # 【duration】(integer, 可选) 指定生成视频的时长，单位为秒
        # 取值范围: [3, 15]，默认值为 5
        "duration": 5,
        # 【watermark】(boolean, 可选) 是否在生成的视频上添加水印标识
        # 水印位于视频右下角，文案固定为 "Happy Horse"
        # true（默认值）: 添加水印 / false: 不添加水印
        "watermark": True,
        # 【seed】(integer, 可选) 随机数种子，用于提升生成结果的可复现性
        # 取值范围: [0, 2147483647]，未指定时系统自动生成随机种子
        # 注意：由于模型生成具有概率性，即使使用相同 seed 也不能保证每次结果完全一致
        "seed": 11
    }
}

# 步骤4: 发送请求并输出结果
response = requests.post(url, headers=headers, json=payload)
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

## 返回示例 ​

```json
{
  "request_id": "1ff8c4c4-5fe9-9ed8-acb4-f7ae8beed217",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"task_id\":\"7b6647fc-5ea5-4472-889b-ab4eb235e243\",\"task_status\":\"PENDING\"}"
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 45000,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 45000
  }
}
```

提交成功后，从 output[0].content[0].text 解析出的 JSON 中提取 task_id，用于第二步查询结果。任务 ID 有效期为 24 小时，请勿重复创建任务，轮询获取即可。
## 获取结果 示例代码 ​

```python
import requests
import json

# 步骤1: 配置 API 连接信息
url = "https://www.dmxapi.cn/v1/responses"
api_key = "sk-******************************************"

# 步骤2: 配置请求头
headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",            # token 认证方式
}

# 步骤3: 配置请求参数
payload = {
    # 【model】(string, 必填) 查询模型名称，固定为 "happyhorse-get"
    "model": "happyhorse-get",
    # 【input】(string, 必填) 提交任务时返回的 task_id，用于查询任务状态与结果
    # task_id 有效期为 24 小时，超时后将无法查询（接口返回状态 UNKNOWN）
    # 任务状态枚举: PENDING(排队中) / RUNNING(处理中) / SUCCEEDED(成功) / FAILED(失败) / CANCELED(已取消) / UNKNOWN(不存在或已过期)
    # 视频生成通常需要 1~5 分钟，建议每隔约 15 秒轮询一次（重新执行本步骤），直到状态变为 SUCCEEDED；请勿重复创建任务
    "input": "62967e89-6174-4d38-9828-aedd2c5d151f"
}

# 步骤4: 发送请求并输出结果
response = requests.post(url, headers=headers, json=payload)

data = response.json()
print(json.dumps(data, indent=2, ensure_ascii=False))

# 提取 video_url（嵌套在 output[0].content[0].text 的 JSON 字符串里）
try:
    text = data["output"][0]["content"][0]["text"]
    inner = json.loads(text)
    video_url = inner.get("video_url")
    if video_url:
        print("\n视频链接:")
        print(video_url)
        # 注意：video_url 有效期为 24 小时，请及时下载并转存至本地或永久存储（如 OSS）
    else:
        print("\n未找到 video_url，任务状态:", inner.get("task_status"))
except (KeyError, IndexError, json.JSONDecodeError) as e:
    print("\n解析 video_url 失败:", e)
```

## 返回示例 ​

```json
{
  "request_id": "a011c69c-ef4a-9903-a89e-78f72c9ef33c",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"task_id\":\"62967e89-6174-4d38-9828-aedd2c5d151f\",\"task_status\":\"SUCCEEDED\",\"submit_time\":\"2026-04-28 14:26:42.286\",\"scheduled_time\":\"2026-04-28 14:26:42.330\",\"end_time\":\"2026-04-28 14:28:24.417\",\"video_url\":\"https://dashscope-a717.oss-accelerate.aliyuncs.com/...refiner_watermark.mp4?Expires=...\"}"
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 0,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 0
  }
}

视频链接:
https://dashscope-a717.oss-accelerate.aliyuncs.com/...refiner_watermark.mp4?Expires=...
```

© 2026 DMXAPI happyhorse-1.0-t2v 文生视频
