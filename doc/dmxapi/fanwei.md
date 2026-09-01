# openai请求格式

> 来源：https://doc.dmxapi.cn/fanwei.html
> 官方标题：API 统一请求格式
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# API 统一请求格式 ​
## 📖 概述 ​
所有模型（包括非 OpenAI 模型）的请求格式已统一转换为 OpenAI 格式，几乎兼容本站的所有模型。
## 🔗 请求地址 ​

```text
https://www.dmxapi.cn/v1/chat/completions
```

## 模型名称 ​

- 本页示例：gpt-5.6-sol
- 其他模型：替换 model，并检查该模型对推理、输出长度和工具参数的支持情况
## Python 示例代码 ​

```python
"""
DMXAPI 对话接口调用示例
功能：使用 gpt-5.6-sol 模型进行智能对话
"""

import json
import requests

# ==================== API 配置 ====================

# API 接口地址
url = "https://www.dmxapi.cn/v1/chat/completions"

# 请求头配置
headers = {
    "Authorization": "sk-**********************************",  # 替换为你的 DMXAPI 令牌
    "Content-Type": "application/json"
}

# ==================== 请求参数 ====================

# 构造请求数据
payload = {
    "model": "gpt-5.6-sol",  # 选择使用的模型
    "messages": [
        {
            "role": "system",
            "content": "You are a helpful assistant."  # 系统提示词：定义 AI 助手的角色
        },
        {
            "role": "user",
            "content": "周树人和鲁迅是兄弟吗？"  # 用户问题
        }
    ]
}

# ==================== 发送请求 ====================

try:
    # 发送 POST 请求到 API
    response = requests.post(url, headers=headers, data=json.dumps(payload))
    response.raise_for_status()  # 检查 HTTP 错误

    # 输出响应结果
    print("=" * 50)
    print("API 响应结果：")
    print("=" * 50)
    print(json.dumps(response.json(), indent=2, ensure_ascii=False))

except requests.exceptions.RequestException as e:
    # 异常处理
    print(f"❌ 请求失败: {e}")
```

## 返回示例 ​
以下结构依据 DMXAPI 实测结果整理，ID 与时间戳为虚构值。Chat Completions 可能返回带日期的模型快照名：

```json
{
  "id": "chatcmpl_example_gpt56_001",
  "object": "chat.completion",
  "created": 1787270400,
  "model": "gpt-5.6-sol-2026-07-09",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "不是。周树人是鲁迅的本名，鲁迅是他的笔名。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 27,
    "completion_tokens": 26,
    "total_tokens": 53
  }
}
```

© 2026 DMXAPI API 统一请求格式
