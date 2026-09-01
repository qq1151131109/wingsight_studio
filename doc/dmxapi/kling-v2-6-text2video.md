# 🎞️可灵视频

> 来源：https://doc.dmxapi.cn/kling-v2-6-text2video.html
> 官方标题：可灵视频模型 kling-v2-6-text2video API使用文档（异步）
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# 可灵视频模型 kling-v2-6-text2video API使用文档（异步） ​
基于前沿的深度学习架构，可灵 AI 具备卓越的文生视频与图生视频能力。它突破了传统 AI 视频生成的瓶颈，能精准模拟物理世界的运动规律，确保画面动态流畅、主体高度一致。作为全球视频生成领域的第一梯队产品，可灵 AI 性能对标国际顶尖模型，且已全面开放使用，致力于为创作者提供触手可及的专业级视频创作体验。
## 🌻模型名称 ​
kling-v2-6-text2video
## 🚗接口地址 ​
视频生成需分两步：
- 提交视频生成任务
- 根据返回的 ID 查询结果

|  | 功能 | 端点
|  | 提交视频任务 | https://www.dmxapi.cn/v1/responses
|  | 查询视频结果 | https://www.dmxapi.cn/v1/responses
## ☀️部分可选参数 ​

- duration：视频时长（单位：秒），可选值：5 / 10
## ✈️生成视频 示例代码 ​

```python
"""
╔═══════════════════════════════════════════════════════════════╗
║              DMXAPI Kling 视频生成模型调用示例                 ║
╚═══════════════════════════════════════════════════════════════╝

📝 功能说明:
   本脚本演示如何使用 requests 库调用 DMXAPI 的 Kling v2.6 文生视频模型
   通过 responses 接口生成视频（非流式输出）

═══════════════════════════════════════════════════════════════
"""
import requests
import json

# ═══════════════════════════════════════════════════════════════
# 🔑 步骤1: 配置 API 连接信息
# ═══════════════════════════════════════════════════════════════

# 🌐 DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# 🔐 DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-************************************"

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
    "model": "kling-v2-6-text2video",
    "input": "生成一个海边有一个人跳舞的视频",  # 必填，正向文本提示词，不超过2500字符
    "negative_prompt": "",      # 可选，负向文本提示词，不超过2500字符
    "mode": "pro",              # 可选，生成模式: std(标准模式), pro(高品质模式)
    "sound": "off",             # 可选，是否生成声音: on, off (仅V2.6及后续版本支持)
    "aspect_ratio": "16:9",     # 可选，画面纵横比: 16:9, 9:16, 1:1
    "duration": 5,              # 可选，视频时长(秒): 5, 10
    "callback_url": "https://www.dmxapi.cn"  # 可选，任务状态变更回调通知地址
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

## 🐯返回示例 ​

```json
{
  "code": 0,
  "message": "SUCCEED",
  "request_id": "1a06838f-d2cc-4328-a73e-401cb23e8080", // 查询生成结果所需要的ID号
  "data": {
    "task_id": "841036370235252746",
    "task_status": "submitted",
    "task_status_msg": "",
    "task_info": {},
    "created_at": 1768358011822,
    "updated_at": 1768358011822
  },
  "usage": {
    "total_tokens": 2125,
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 2125,
    "output_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

## 🚀查询生成结果 示例代码 ​

注意

- 视频生成需要一定时间，建议先在任务日志 [https://www.dmxapi.cn/task](https://www.dmxapi.cn/task) 中确认完成后再下载。
- 您需要使用请求返回的 id 来获取视频文件。

```python
"""
╔═══════════════════════════════════════════════════════════════╗
║              DMXAPI Kling 文本转视频任务查询示例                ║
╚═══════════════════════════════════════════════════════════════╝

📝 功能说明:
   本脚本演示如何使用 requests 库调用 DMXAPI 的 Kling 的kling-text2video-get模型，文本转视频查询接口
   通过 responses 接口查询视频生成任务状态（流式输出）

═══════════════════════════════════════════════════════════════
"""
import requests
import json
import sys
import time
import threading

# ═══════════════════════════════════════════════════════════════
# 🔑 步骤1: 配置 API 连接信息
# ═══════════════════════════════════════════════════════════════

# 🌐 DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# 🔐 DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-***********************************"

# ═══════════════════════════════════════════════════════════════
# 📋 步骤2: 配置请求头
# ═══════════════════════════════════════════════════════════════

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",    # token 认证方式
}

# ═══════════════════════════════════════════════════════════════
# 💬 步骤3: 配置查询参数
# ═══════════════════════════════════════════════════════════════

payload = {
    "model": "kling-text2video-get",
    "input": "841036370235252746",
    "stream": True
}

# ═══════════════════════════════════════════════════════════════
# 📊 进度条类
# ═══════════════════════════════════════════════════════════════

class FakeProgressBar:
    """预估进度条"""

    def __init__(self):
        self.current_progress = 0
        self.running = False
        self.completed = False
        self.thread = None
        self.start_time = None

    def _render(self):
        """渲染进度条"""
        bar_length = 40
        filled = int(bar_length * self.current_progress / 100)
        bar = "█" * filled + "░" * (bar_length - filled)
        sys.stdout.write(f"\r⏳ 处理中: [{bar}] {self.current_progress:.1f}%")
        sys.stdout.flush()

    def _run(self):

        self.start_time = time.time()
        while self.running:
            elapsed = time.time() - self.start_time
            # 使用渐近函数：进度永远接近但不会到达99.9%
            # 前3分钟涨到约95%，之后越来越慢但一直在涨
            self.current_progress = 99.9 * (1 - 1 / (1 + elapsed / 60))
            self._render()
            time.sleep(0.1)

    def start(self):
        """启动进度条"""
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self._render()

    def complete(self):
        """完成进度条"""
        self.running = False
        self.completed = True
        self.current_progress = 100
        self._render()
        print()  # 换行

    def stop(self):
        """停止进度条（不完成）"""
        self.running = False
        print()

# ═══════════════════════════════════════════════════════════════
# 📤 步骤4: 发送请求并输出结果
# ═══════════════════════════════════════════════════════════════

# 创建并启动进度条
progress = FakeProgressBar()
progress.start()

# 发送 POST 请求到 API 服务器（启用流式传输）
response = requests.post(url, headers=headers, json=payload, stream=True)

final_result = None

# 流式处理响应
# - 逐行读取 SSE 格式的数据
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
for line in response.iter_lines():
    if line:
        line_text = line.decode('utf-8')
        # 处理 SSE 格式数据
        if line_text.startswith('data: '):
            data = line_text[6:]  # 去掉 "data: " 前缀
            if data != '[DONE]':
                try:
                    json_data = json.loads(data)
                    final_result = json_data
                except json.JSONDecodeError:
                    pass

# 完成进度条并输出结果
progress.complete()

print("\n" + "═" * 60)
print("✅ 查询完成！")
print("═" * 60 + "\n")

if final_result:
    # 尝试提取视频URL
    try:
        status = final_result.get("response", {}).get("status", "")
        output = final_result.get("response", {}).get("output", [])

        if status == "completed" and output:
            text_content = output[0].get("content", [{}])[0].get("text", "")

            # 提取任务ID
            if "任务ID:" in text_content:
                task_id = text_content.split("任务ID:")[1].split("\n")[0].strip()
                print(f"📋 任务ID: {task_id}")

            # 提取视频URL（查找 http 开头到 .mp4 结尾的部分，包括查询参数）
            import re
            url_match = re.search(r'(https?://[^\s]+\.mp4[^\s]*)', text_content)
            if url_match:
                video_url = url_match.group(1)
                # 清理URL末尾可能的杂字符
                video_url = re.sub(r'[\n\r].*$', '', video_url)
                print(f"\n🎬 视频链接:")
                print(video_url)

            # 提取时长
            duration_match = re.search(r'时长:\s*[\d.]+', text_content)
            if duration_match:
                print(f"\n⏱️  {duration_match.group(0)}秒")
        else:
            # 非完成状态，输出原始JSON
            print(json.dumps(final_result, indent=2, ensure_ascii=False))
    except Exception:
        # 解析失败，输出原始JSON
        print(json.dumps(final_result, indent=2, ensure_ascii=False))
```

## 🦁返回示例 ​

```json
⏳ 处理中: [████████████████████████████████████████] 100.0%

════════════════════════════════════════════════════════════
✅ 查询完成！
════════════════════════════════════════════════════════════

📋 任务ID: 841036370235252746

🎬 视频链接:
https://v4-fdl.kechuangai.com/ksc2/kdDWtKH8kEZgms9USQDhhBiDebstrRGHrI8frWDTxRbLWo7ILpEU4FHbk5pEO9WL5PfbRFN_NkwOjSlv2GFVTlBd-za0zMDkfbmrvB6H6yQWJAvzeu6NLSpW-HV-HQPsgVwF6SbTogdvCd7dIhW-sugI2tO39E9UNtwNxUEm15t_DQ9q3bZzr_y9szaUZVPhdwLfJOKwK_zZXec8vPgrSg.mp4?cacheKey=ChtzZWN1cml0eS5rbGluZy5tZXRhX2VuY3J5cHQSsAGU0jXO8A6vYUR6LoJUQAljWmoB6U47dLzwSzUHB3rgCF0EltJS7Fo-29gnB8aJCgcp5lfdS4u4o5px6oPIk2VlIheCzB0z9KitwuNY1AWvX47ZpuG1k5OiaZS2g3ksc8vhml7PE5JpsHjnLkKIRNaRl0z86fwGPGGKHfj3Uh7mUr8FUoPewRXC8fu5s15tWI1pv1WC7YPW4GeESx3Dfqi-RqgooPHaTRP1ibrTjRezaRoSj4dfrTYhUzYe6jlYP2ZR__D3IiCfA83goDVjmNTmrTMpF1ggIebcrbBU9NU_IVuciVlapigFMAE&x-kcdn-pid=112757&pkey=AAUIz0KCHmuLmZHE9IGCWAw2uZUC4EAMjYU1Yf7WAAhv-j9RHBSDJ7iWlHBOlOCuUeA3EaH14n_tVZ2yt2C-4u2wMrN9rrQlJ9gxLw9ROQZHYYbmTuc4R03IfOQunGSxv2s
```

© 2026 DMXAPI kling-v2-6-text2video
