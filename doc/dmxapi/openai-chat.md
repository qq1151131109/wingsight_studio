# 文本对话

> 来源：https://doc.dmxapi.cn/openai-chat.html
> 官方标题：OpenAI Chat Completions 非流式调用
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# OpenAI Chat Completions 非流式调用 ​
## 🔗 请求地址 ​

```text
https://www.dmxapi.cn/v1/chat/completions
```

## 模型名称 ​

- 本页示例：gpt-5.6-sol
- 其他模型：替换 model，并检查该模型对推理、输出长度和工具参数的支持情况
## 调用示例 ​

SDKrequests

```python
"""
DMXAPI OpenAI SDK 调用示例
功能：使用 gpt-5.6-sol 模型进行智能对话
"""

from openai import OpenAI
import json

# ==================== 客户端初始化 ====================

# 创建 OpenAI 客户端实例
client = OpenAI(
    api_key="sk-**************************************",  # 替换为你的 DMXAPI 令牌
    base_url="https://www.dmxapi.cn/v1"  # DMXAPI 接口地址
)

# ==================== 发送对话请求 ====================

# 调用对话完成接口
chat_completion = client.chat.completions.create(
    messages=[
        {
            "role": "user",  # 用户角色
            "content": "周树人和鲁迅是兄弟吗？"  # 用户提问
        }
    ],
    model="gpt-5.6-sol"  # 指定使用的模型
)

# ==================== 格式化输出结果 ====================

# 将响应对象转换为字典
result = chat_completion.model_dump()

# 美化输出
print("=" * 50)
print("✨ API 响应结果")
print("=" * 50)
print(json.dumps(result, indent=2, ensure_ascii=False))
print("=" * 50)

# 输出关键信息摘要
print("📊 关键信息摘要：")
print(f"  • 模型: {result['model']}")
print(f"  • 回复: {result['choices'][0]['message']['content']}")
print(f"  • Token 使用: {result['usage']['total_tokens']} (输入: {result['usage']['prompt_tokens']}, 输出: {result['usage']['completion_tokens']})")
```

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
            "content": "介绍下鲁迅"  # 用户问题
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

```json
{
  "id": "chatcmpl_example_gpt56_nonstream_001",
  "object": "chat.completion",
  "created": 1787270400,
  "model": "gpt-5.6-sol-2026-07-09",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "鲁迅，原名周树人，是中国现代文学的重要作家，代表作包括《狂人日记》《阿Q正传》等。"
      },
      "finish_reason": "stop"
    }
  ]
}
```

## 注意事项 ​

- 两种调用都沿用修改前的基础结构，不设置思考等级和最大输出。
- DMXAPI 实测的 Chat Completions 响应模型名为版本化快照 gpt-5.6-sol-2026-07-09。
© 2026 DMXAPI OpenAI Chat Completions 非流式调用
