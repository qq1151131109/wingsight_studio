# 🎞️阿里万象视频

> 来源：https://doc.dmxapi.cn/wan2.6-t2v.html
> 官方标题：wan2.6 文生视频文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# wan2.6 文生视频文档 ​
万相文生视频模型基于文本提示词，生成一段流畅的视频。
## 请求地址 ​

```
https://www.dmxapi.cn/v1/responses
```

## 模型名称 ​

- wan2.6-t2v
## 提交视频任务 ​

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
api_key = "sk-*********************************"
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
      "model": "wan2.6-t2v",
    "input": {

        # 【prompt】: 文本提示词。用来描述生成视频中期望包含的元素和视觉特点。支持中英文，每个汉字/字母占一个字符，超过部分会自动截断。
        # wan2.6长度不超过1500个字符

        "prompt": "一幅史诗级可爱的场景。一只小巧可爱的卡通小猫将军，身穿细节精致的金色盔甲，头戴一个稍大的头盔，勇敢地站在悬崖上。他骑着一匹虽小但英勇的战马，说：\"青海长云暗雪山，孤城遥望玉门关。黄沙百战穿金甲，不破楼兰终不还。\"。悬崖下方，一支由老鼠组成的、数量庞大、无穷无尽的军队正带着临时制作的武器向前冲锋。这是一个戏剧性的、大规模的战斗场景，灵感来自中国古代的战争史诗。远处的雪山上空，天空乌云密布。整体氛围是\"可爱\"与\"霸气\"的搞笑和史诗般的融合。",

        # 【audio_url】: 音频文件URL，模型将使用该音频生成视频。
        # 支持输入的格式：公网URL：支持 HTTP 和 HTTPS 协议。
        #
        "audio_url": "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250923/hbiayh/%E4%BB%8E%E5%86%9B%E8%A1%8C.mp3",

        # 【negative_prompt】: 反向提示词，用来描述不希望在视频画面中看到的内容，可以对视频画面进行限制。支持中英文，长度不超过500个字符，超过部分会自动# 截断。示例值：低分辨率、错误、最差质量、低质量、残缺、多余的手指、比例不良等。
        "negative_prompt": "",
    },
    "parameters": {
        #【size】指定生成的视频分辨率，格式为宽*高。默认值为 1920*1080（1080P）。可选分辨率：720P、1080P对应的所有分辨率。
        # 720P档位：可选的视频分辨率及其对应的视频宽高比为：
          # 1280*720：16:9。
          # 720*1280：9:16。
          # 960*960：1:1。
          # 1088*832：4:3。
          # 832*1088：3:4。
        # 1080P档位：可选的视频分辨率及其对应的视频宽高比为：
          # 1920*1080： 16:9。
          # 1080*1920： 9:16。
          # 1440*1440： 1:1。
          # 1632*1248： 4:3。
          # 1248*1632： 3:4。
        "size": "1920*1080",

        #【prompt_extend】是否开启prompt智能改写。开启后使用大模型对输入prompt进行智能改写。对于较短的prompt生成效果提升明显，但会增加耗时。
        # true：默认值，开启智能改写。false：不开启智能改写。
        "prompt_extend": True,
        "duration": 10, #生成视频的时长，单位为秒。wan2.6-t2v：取值为[2, 15]之间的整数。默认值为5

        #【shot_type】指定生成视频的镜头类型，即视频是由一个连续镜头还是多个切换镜头组成
        # 生效条件：仅当"prompt_extend": true 时生效。
        # 参数优先级：shot_type > prompt。例如，若 shot_type设置为"single"，即使 prompt 中包含“生成多镜头视频”，模型仍会输出单镜头视频。
        # 可选值：
        #     single：默认值，输出单镜头视频。
        #     multi：输出多镜头视频。
        "shot_type": "multi",
        "watermark": False,# 是否添加水印标识，水印位于视频右下角，文案固定为“AI生成”。
        "seed": 666 # 随机数种子，取值范围为[0, 2147483647]。未指定时，系统自动生成随机种子。若需提升生成结果的可复现性，建议固定seed值
    },

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
  "request_id": "9af01318-023e-4205-9093-806f523fbe32",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"task_id\":\"3a7d8355-ef78-48cd-863c-6cdb9707ba91\",\"task_status\":\"PENDING\"}"
        }
      ]
    }
  ],
  "usage": {
    "total_tokens": 100000,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 100000,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

## 查询任务结果 ​

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
api_key = "sk-**********************************"
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
    "model": "wan2.6-get",
    "input": "3a7d8355-ef78-48cd-863c-6cdb9707ba91",
}
# ═══════════════════════════════════════════════════════════════
# 📤 步骤4: 发送请求并输出结果
# ═══════════════════════════════════════════════════════════════

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)
result = response.json()
# 格式化输出 JSON 响应
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
print(json.dumps(result, indent=2, ensure_ascii=False))
# ═══════════════════════════════════════════════════════════════
# 🎬 步骤5: 提取并输出可直接使用的视频链接
# ═══════════════════════════════════════════════════════════════

if "output" in result and len(result["output"]) > 0:
    content = result["output"][0].get("content", [])
    if content and "text" in content[0]:
        inner_data = json.loads(content[0]["text"])
        task_status = inner_data.get("task_status")
        if task_status == "SUCCEEDED":
            print("\n" + "="*50)
            print("✅ 视频生成成功！可直接复制的链接：")
            print(inner_data.get("video_url"))
            print("="*50)
        elif task_status == "PENDING" or task_status == "RUNNING":
            print(f"\n⏳ 任务状态: {task_status}，请稍后再次查询")
        elif task_status == "FAILED":
            print(f"\n❌ 任务失败: {inner_data.get('message', '未知错误')}")
        else:
            print(f"\n任务状态: {task_status}")
```

## 返回示例 ​

```json
{
  "request_id": "ced69e65-4786-4567-8553-1e2a47175c04",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "{\"end_time\":\"2026-02-11 13:42:25.332\",\"orig_prompt\":\"一幅史诗级可爱的场景。一只小巧可爱的卡通小猫将军，身穿细节精致的金色盔甲，头戴一个稍大的头盔，勇敢地站在悬崖上。他骑着一匹虽小但英勇的战马，说 ：\\\"青海长云暗雪山，孤城遥望玉门关。黄沙百战穿金甲，不破楼兰终不还。\\\"。悬崖下方，一支由老鼠组成的、数量庞大、无穷无尽的军队正带着临时制作的武器向前冲锋。这是一个戏剧性的、大规模的战斗场景，灵感来自中国古代的战争史诗。远处的雪山上空，天空乌云密布。整体氛围是\\\"可爱\\\"与\\\"霸气\\\"的搞笑和史诗般的融合。\",\"scheduled_time\":\"2026-02-11 13:37:27.332\",\"submit_time\":\"2026-02-11 13:37:18.020\",\"task_id\":\"3a7d8355-ef78-48cd-863c-6cdb9707ba91\",\"task_status\":\"SUCCEEDED\",\"video_url\":\"https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/1d/03/20260211/b6472f62/31703410-3a7d8355-ef78-48cd-863c-6cdb9707ba91.mp4?Expires=1770874935\\u0026OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1\\u0026Signature=eFkjP45eqYZDbRPLcwYQJNp%2FF8s%3D\"}"
        }
      ]
    }
  ],
  "usage": {
    "total_tokens": 100000,
    "input_tokens": 100000,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 0,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
==================================================
✅ 视频生成成功！可直接复制的链接：
https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/1d/03/20260211/b6472f62/31703410-3a7d8355-ef78-48cd-863c-6cdb9707ba91.mp4?Expires=1770874935&OSSAccessKeyId=LTAI5tPxpiCM2hjmWrFXrym1&Signature=eFkjP45eqYZDbRPLcwYQJNp%2FF8s%3D
==================================================
```

© 2026 DMXAPI wan2.6-t2v
