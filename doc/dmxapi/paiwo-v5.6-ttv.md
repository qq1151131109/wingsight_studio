# 🎞️拍我视频

> 来源：https://doc.dmxapi.cn/paiwo-v5.6-ttv.html
> 官方标题：paiwo-v5.6-ttv 文生视频 API 文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# paiwo-v5.6-ttv 文生视频 API 文档 ​
paiwo视频模型 可根据视频内容智能生成完整的声音体系，包括环境音效、背景音乐与角色台词，并支持指定音色，实现真正的“音画同步生成”。同时，它还能自动设计推拉、摇移、切换及景别变化等镜头语言，让生成的 10 秒视频具备节奏与呼吸感，呈现更完整的叙事段落，而非单调的动图。
## 接口地址 ​

```
https://www.dmxapi.cn/v1/responses
```

## 模型名称 ​
paiwo-v5.6-ttv
## 生成视频 示例代码 ​

```python
import requests
import json

# ═══════════════════════════════════════════════════════════════
# 🔑 步骤1: 配置 API 连接信息
# ═══════════════════════════════════════════════════════════════

# 🌐 DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# 🔐 DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-********************************************"  #输入您的密钥

# ═══════════════════════════════════════════════════════════════
# 📋 步骤2: 配置请求头
# ═══════════════════════════════════════════════════════════════

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",    # token 认证方式
}

# ═══════════════════════════════════════════════════════════════
# 💬 步骤3: 配置请求参数
# ═══════════════════════════════════════════════════════════════

payload = {
    "model": "paiwo-v5.6-ttv",#(必需)
    "input": "一只小猫在草地上玩耍",#用户提示词，限制在2048 Characters 以内(必需)
    "aspect_ratio": "16:9", # 视频宽高比，支持"16:9","9.16","4:3","3:4","1:1" 画幅比 (必需)

    #【分辨率quality & 视频时长duration】
    #360p: 5s,8s,10s
    #540p: 5s,8s,10s
    #720p: 5s,8s,10s
    #1080p:5s,8s

    "duration": 5, # 视频时长(必需)
    "quality": "540p",#视频分辨率(必需)

    "motion_mode": "normal", # 运动模式,支持"normal","fast"，其中"fast" 不支持 8s,  "v5" 不支持此字段
    "negative_prompt": "不需要出现人物",  # 负面提示词,限制在2048 Characters 以内 (可选)

    "generate_audio_switch": True, #生成音频开关：只能v5.5与v5.6使用
    "seed": 0  # 随机种子，可传随机数 0 - 2147483647
}

# ═══════════════════════════════════════════════════════════════
# 📤 步骤4: 发送请求并输出结果
# ═══════════════════════════════════════════════════════════════

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)

# 格式化输出 JSON 响应
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

## 返回示例 ​

```json
{
  "ErrCode": 0,
  "ErrMsg": "success",
  "Resp": {
    "video_id": 385043936817661,
    "credits": 80
  },
  "usage": {
    "total_tokens": 240000,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 240000,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

## 获取生成视频 示例代码 ​

```python
import requests
import json

# ═══════════════════════════════════════════════════════════════
# 🔑 步骤1: 配置 API 连接信息
# ═══════════════════════════════════════════════════════════════

# 🌐 DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# 🔐 DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-********************************************"

# ═══════════════════════════════════════════════════════════════
# 📋 步骤2: 配置请求头
# ═══════════════════════════════════════════════════════════════

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",    # token 认证方式
}

# ═══════════════════════════════════════════════════════════════
# 💬 步骤3: 配置请求参数
# ═══════════════════════════════════════════════════════════════

payload = {
    "model": "paiwo-get",
    "input": "385039976497636",# 输入请求代码返回的视频ID

}

# ═══════════════════════════════════════════════════════════════
# 📤 步骤4: 发送请求并输出结果
# ═══════════════════════════════════════════════════════════════

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)

# 格式化输出 JSON 响应
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

## 返回示例 ​

```json
{
  "ErrCode": 0,
  "ErrMsg": "Success",
  "Resp": {
    "id": 385043936817661,
    "prompt": "一只小猫在草地上玩耍",
    "negative_prompt": "不需要出现人物",
    "url": "https://media.pixverseai.cn/pixverse%2Fmp4%2Fmedia%2Fweb%2Fori%2Ff0252026-da74-429e-b279-977385175a34_seed713039308.mp4",
    "status": 1,
    "seed": 713039308,
    "create_time": "2026-02-03T15:21:29Z",
    "modify_time": "2026-02-03T15:21:54Z",
    "outputWidth": 1024,
    "outputHeight": 576,
    "has_audio": true,
    "credits": 80
  }
}
```

© 2026 DMXAPI paiwo-v5.6-ttv
