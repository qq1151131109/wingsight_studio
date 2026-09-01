# 🎞️VIDU视频

> 来源：https://doc.dmxapi.cn/viduq2-pro.html
> 官方标题：Vidu视频模型 viduq2-pro 首尾帧生成视频 API使用文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# Vidu视频模型 viduq2-pro 首尾帧生成视频 API使用文档 ​
viduq2-pro动态幅度很大，画面更具想象力，语义理解与指令遵循能力强，能更准确遵循输入的 Prompt， 动漫风格表现突出，动漫风格视频效果更佳。
## 模型名称 ​
viduq2-pro
## 接口地址 ​
调用 viduq2-pro 官方接口需分两步：
- 提交视频生成任务
- 根据返回的 ID 查询结果

|  | 功能 | 端点
|  | 提交视频任务 | https://www.dmxapi.cn/v1/responses
|  | 查询视频结果 | https://www.dmxapi.cn/v1/responses
## 可选参数 ​

- resolution：视频分辨率，默认 720p，可选值：540p / 720p / 1080p
- duration：视频时长（单位：秒）

- 默认值：5
- 可选值：1 / 2 / 3 / 4 / 5 / 6 / 7 / 8
## python 请求发送示例代码 ​

```python
"""
================================================================================
DMXAPI 视频生成任务创建脚本
================================================================================

功能说明:
    本脚本用于通过 DMXAPI 平台创建 AI 视频生成任务。
    支持文本生成视频、图片生成视频等多种模式。

使用流程:
    1. 配置 API 密钥和请求参数
    2. 运行本脚本创建视频生成任务
    3. 获取返回的任务 ID

支持的生成模式:
    - 首尾帧生成视频: 指定首尾两帧图片，AI 自动生成中间过渡

依赖库:
    - requests: HTTP 请求库
    - json: JSON 处理库
================================================================================
"""
import requests  # HTTP 请求库 - 用于发送网络请求
import json      # JSON 处理库 - 用于解析 API 响应数据

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                           第一部分: API 连接配置                             ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分配置 API 服务器地址和身份验证信息
#       请确保 API 密钥的安全性，不要泄露给他人
#

# DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# DMXAPI 密钥 (API Key)
# - 用途: 身份验证，确保只有授权用户可以访问 API
# - 格式: 以 "sk-" 开头的字符串
# - 注意: 请妥善保管，不要将密钥提交到公开代码仓库
api_key = "sk-********************************"  # ⚠️ 请替换为你的API密钥

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                          第二部分: HTTP 请求头配置                           ║
# ╚════════════════════════════════════════════════════════════════════════════╝

headers = {
    "Content-Type": "application/json",
    "Authorization": f"{api_key}",
}

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                          第三部分: 视频生成参数配置                          ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分定义视频生成的所有参数
#       包括模型选择、视频属性、输入内容等
#

data = {
    # ========================= 3.1 基础配置 =========================

    # model: 指定使用的视频生成模型
    # - viduq2-pro: Vidu Q2 Pro 专业版模型
    "model": "viduq2-pro",

    # input: 视频生成的文本提示词 (Prompt)
    # - 描述你想要生成的视频内容
    # - 提示词越详细，生成效果越好
    # - 字符长度不能超过 2000 个字符
    # - 支持中英文输入
    "input": "一直小猫在愉快的玩耍",

    # ========================= 3.2 视频属性配置 =========================

    # duration: 视频时长（单位：秒）
    # - 默认值: 5
    # - 可选值: 1, 2, 3, 4, 5, 6, 7, 8
    "duration": 5,

    # seed: 随机种子
    # - 当默认不传或者传 0 时，会使用随机数替代
    "seed": 0,

    # resolution: 视频分辨率
    # - viduq2-pro 1-8秒：默认 720p，可选：540p、720p、1080p
    "resolution": "720p",

    # movement_amplitude: 运动幅度
    # - 默认 auto，可选值：auto、small、medium、large
    "movement_amplitude": "auto",

    # ========================= 3.3 图片输入配置 =========================

    # images: 图像
     #
    # - 支持输入两张图，上传的第一张图片视作首帧图，第二张图片视作尾帧图
    # - 模型将以此参数中传入的图片来生成视频
    # 注1: 首尾帧两张输入图的分辨率需相近，首帧图的分辨率/尾帧图的分辨率要在 0.8～1.25 之间
    #      且图片比例需要小于 1:4 或者 4:1
    # 注2: 支持传入图片 Base64 编码或图片 URL（确保可访问）
    # 注3: 图片支持 png、jpeg、jpg、webp 格式
    # 注4: 图片大小不超过 50M
    # 注5: base64 decode 之后的字节长度需要小于 10M，且编码必须包含适当的内容类型字符串
    "images": [
        "https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-1.jpeg",  # 首帧图片
        "https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-2.jpeg"   # 尾帧图片
    ],

    # ========================= 3.4 音频配置 =========================

    # bgm: 是否为生成的视频添加背景音乐
    # - 默认：false，可选值 true、false
    # - 传 true 时系统将从预设 BGM 库中自动挑选合适的音乐并添加；不传或为 false 则不添加 BGM
    # - BGM 不限制时长，系统根据视频时长自动适配
    "bgm": False,

    # ========================= 3.5 水印配置 =========================

    # watermark: 是否添加水印
    # - true：添加水印
    # - false：不添加水印
    "watermark": False,

    # wm_position: 水印位置
    # - 1: 左上角
    # - 2: 右上角
    # - 3: 左下角
    # - 4: 右下角
    # - 默认为为 3
    "wm_position": 3,

    # wm_url: 水印内容，此处为图片 URL
    # - 不传时，使用默认水印：内容由 AI 生成
    "wm_url": "https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-1.jpeg",

    # ========================= 3.6 回调配置 =========================

    # callback_url: Callback 协议
    # - 需要您在创建任务时主动设置 callback_url，请求方法为 POST
    # - 当视频生成任务有状态变化时，Vidu 将向此地址发送包含任务最新状态的回调请求
    # - 回调请求内容结构与查询任务 API 的返回体一致
    # 回调返回的 "status" 包括以下状态：
    # - processing：任务处理中
    # - success：任务完成（如发送失败，回调三次）
    # - failed：任务失败（如发送失败，回调三次）
    # "callback_url": "https://www.dmxapi.cn/v1/responses/callback"
}

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                       第四部分: 发送请求并处理响应                             ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分负责发送 HTTP 请求并处理服务器返回的响应
#       创建任务后会返回任务 ID，用于后续查询
#

# ----------------------------- 4.1 发送 API 请求 -----------------------------
# requests.post() 参数说明:
# - url: API 服务端点地址
# - headers: HTTP 请求头，包含认证信息
# - json: 请求体数据，会自动序列化为 JSON
# - stream=True: 启用流式响应，实时接收服务器返回数据
response = requests.post(url, headers=headers, json=data, stream=True)

# ----------------------------- 4.2 处理流式响应 -----------------------------
# 流式响应处理说明:
# - 服务器会实时返回任务创建状态
# - 成功创建后返回任务 ID
# - 任务 ID 格式: 纯数字字符串，如 "900541207950696448"
#
# 响应数据示例:
# {
#     "id": "900541207950696448",    // 任务 ID，用于查询进度
#     "status": "pending",           // 任务状态
#     "created_at": "2024-01-01..."  // 创建时间
# }
#
try:
    # iter_lines(): 迭代器方法，逐行读取响应内容
    # - 避免一次性加载全部数据到内存
    # - 适合处理流式数据
    for line in response.iter_lines():
        # 跳过空行
        if line:
            # 将字节数据解码为 UTF-8 字符串并去除首尾空白
            line_text = line.decode('utf-8').strip()

            # 输出服务器返回的原始数据
            # - 包含任务 ID 和状态信息
            # - 请记录任务 ID，用于 get.py 查询
            print(line_text)

# ----------------------------- 4.3 异常处理 -----------------------------
except KeyboardInterrupt:
    # 捕获 Ctrl+C 中断信号
    # 允许用户优雅地终止请求
    print("\n\n⚠️ 用户中断了请求")

except Exception as e:
    # 捕获所有其他异常
    # 包括网络错误、连接超时、服务器错误等
    print(f"\n\n❌ 发生错误: {e}")

# ----------------------------- 4.4 输出结束 -----------------------------
# 确保输出格式整洁，添加空行分隔
print()
```

### 返回示例 ​

```json
{"task_id":"900539403250700288","type":"headtailimg2video","state":"created","model":"viduq2-pro","style":"general","prompt":"你好","images":["https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-1.jpeg","https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-2.jpeg"],"duration":2,"seed":837612233,"aspect_ratio":"","resolution":"1080p","movement_amplitude":"auto","created_at":1766376840,"credits":70,"payload":"","cus_priority":0,"off_peak":false,"watermark":true,"is_rec":false,"wm_position":"bottom_right","wm_url":"https://prod-ss-images.s3.cn-northwest-1.amazonaws.com.cn/vidu-maas/template/startend2video-1.jpeg","meta_data":"","client_request_id":"","usage":{"total_tokens":28002,"input_tokens":2,"input_tokens_details":{"cached_tokens":0},"output_tokens":28000,"output_tokens_details":{"reasoning_tokens":0}}}
```

## python get响应 示例代码 ​

```python
"""
================================================================================
DMXAPI 视频生成任务查询脚本
================================================================================

功能说明:
    本脚本用于查询 DMXAPI 平台上视频生成任务的状态和结果。
    通过提供任务 ID，可以实时获取视频生成进度，并在完成后获取下载链接。
依赖库:
    - requests: HTTP 请求库，用于发送 API 请求
    - json: JSON 解析库，用于处理响应数据

================================================================================
"""

import requests  # HTTP 请求库 - 用于发送网络请求
import json      # JSON 处理库 - 用于解析 API 响应数据

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                           第一部分: API 连接配置                              ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分配置 API 服务器地址和身份验证信息
#       请确保 API 密钥的安全性，不要泄露给他人
#

# API 服务端点地址
# - 生产环境: https://www.dmxapi.cn/v1/responses
# - 该接口用于查询视频生成任务的状态和结果
url = "https://www.dmxapi.cn/v1/responses"

# API 密钥 (API Key)
# - 用途: 身份验证，确保只有授权用户可以访问 API
# - 格式: 以 "sk-" 开头的字符串
# - 注意: 请妥善保管，不要将密钥提交到公开代码仓库
api_key = "sk-******************************************"

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                          第二部分: HTTP 请求头配置                            ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: HTTP 请求头用于告知服务器请求的格式和认证信息
#       这是 RESTful API 调用的标准配置
#

headers = {
    # Content-Type: 指定请求体的媒体类型
    # - application/json 表示请求体为 JSON 格式
    # - 服务器会根据此字段正确解析请求数据
    "Content-Type": "application/json",

    # Authorization: 身份验证头
    # - 认证方案: OAuth 2.0 标准的令牌认证方式
    # - 格式: "<token>"
    # - 服务器通过此字段验证请求者身份
    "Authorization": f"{api_key}",
}

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                          第三部分: 请求参数配置                               ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分定义发送给 API 的核心参数
#       包括模型选择、任务 ID 和响应模式
#

data = {
    # model: 指定查询所使用的模型/接口
    # - 不同模型对应不同的视频生成能力
    "model": "vidu-get",

    # input: 要查询的任务 ID
    # - 此 ID 由创建任务时返回
    # - 每个任务有唯一的 ID 标识
    # - 请替换为您实际的任务 ID
    "input": "900541207950696448",

    # stream: 是否启用流式响应
    # - True: 启用 SSE 流式传输，实时接收生成进度
    # - False: 等待任务完成后一次性返回结果
    # - 推荐使用 True 以获得更好的用户体验
    "stream": True
}

# ╔════════════════════════════════════════════════════════════════════════════╗
# ║                       第四部分: 发送请求并处理响应                             ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# 说明: 此部分负责发送 HTTP 请求并处理服务器返回的流式响应
#       使用 SSE 技术实时接收任务进度更新
#

# ----------------------------- 4.1 输出启动信息 -----------------------------
# 向用户显示程序已开始执行，提供清晰的视觉分隔
print("=" * 60)
print("🚀 发送流式请求...")
print("=" * 60)

# ----------------------------- 4.2 发送 API 请求 -----------------------------
# requests.post() 参数说明:
# - url: API 服务端点地址
# - headers: HTTP 请求头，包含认证信息
# - json: 请求体数据，会自动序列化为 JSON
# - stream=True: 启用流式响应，允许逐行读取返回数据
response = requests.post(url, headers=headers, json=data, stream=True)

# 输出 HTTP 状态码，便于调试和确认请求是否成功
# - 200: 请求成功
# - 401: 认证失败（检查 API 密钥）
# - 404: 任务不存在（检查任务 ID）
# - 500: 服务器内部错误
print(f"状态码: {response.status_code}")
print("-" * 60)
print()

# ----------------------------- 4.3 处理流式响应 -----------------------------
# SSE (Server-Sent Events) 响应格式说明:
# - 每条消息以 "data: " 开头
# - 后跟 JSON 格式的数据
# - 消息之间用空行分隔
#
# 响应数据结构示例:
# {
#     "delta": "当前进度: 50%",        // 增量更新内容
#     "type": "response.completed"    // 响应类型标识
# }
#
try:
    # iter_lines(): 迭代器方法，逐行读取响应内容
    # - 避免一次性加载全部数据到内存
    # - 适合处理大量或持续的流式数据
    for line in response.iter_lines():
        # 跳过空行（SSE 协议中用于分隔消息）
        if line:
            # 将字节数据解码为 UTF-8 字符串
            decoded_line = line.decode('utf-8')

            # --------------- 4.3.1 解析 SSE 数据格式 ---------------
            # 检查是否为标准 SSE 数据行
            if decoded_line.startswith('data: '):
                # 提取 JSON 部分（去掉 "data: " 前缀，共 6 个字符）
                json_str = decoded_line[6:]

                try:
                    # 将 JSON 字符串解析为 Python 字典
                    data_obj = json.loads(json_str)

                    # --------------- 4.3.2 处理增量更新 ---------------
                    # delta 字段包含实时进度信息
                    if 'delta' in data_obj:
                        delta_text = data_obj['delta']

                        # 检测任务完成信号
                        # 当收到完成消息时，显示 100% 进度条
                        if '✅ 视频生成完成' in delta_text:
                            print('\r[████████████████████] 100.00% 生成完成!', flush=True)

                        # 输出增量内容
                        # - end='': 不换行，保持进度条在同一行更新
                        # - flush=True: 立即刷新输出缓冲区
                        print(delta_text, end='', flush=True)

                    # --------------- 4.3.3 处理完成信号 ---------------
                    # type='response.completed' 表示响应流结束
                    elif data_obj.get('type') == 'response.completed':
                        # 响应完成，无需额外处理
                        # 此时所有数据已通过 delta 输出
                        pass

                except json.JSONDecodeError:
                    # JSON 解析失败时，直接输出原始内容
                    # 可能是服务器返回了非标准格式的数据
                    print(decoded_line)

# ----------------------------- 4.4 异常处理 -----------------------------
except KeyboardInterrupt:
    # 捕获 Ctrl+C 中断信号
    # 允许用户优雅地终止长时间运行的查询
    print("\n\n⚠️ 用户中断了请求")

except Exception as e:
    # 捕获所有其他异常
    # 包括网络错误、连接超时等
    print(f"\n\n❌ 发生错误: {e}")

# ----------------------------- 4.5 输出结束信息 -----------------------------
# 程序执行完毕，输出结束标识
print()
print("=" * 60)
print("🏁 流式输出结束")
print("=" * 60)
```

### 返回示例 ​

```json
============================================================
🚀 发送流式请求...
============================================================
状态码: 200
------------------------------------------------------------

[████████████████████] 100.00% 生成完成!

✅ 视频生成完成！

任务ID: 900539403250700288

--- 创作 1 ---
视频URL: https://prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn/infer/tasks/25/1222/04/900539403250700288/creation-01/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIARRHG6JR7EMNHVUWT%2F20251222%2Fcn-northwest-1%2Fs3%2Faws4_request&X-Amz-Date=20251222T041501Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&response-cache-control=max-age%3D86400&response-content-disposition=attachment%3Bfilename%3Dgeneral-3-2025-12-22T04%253A14%253A55Z.mp4&x-id=GetObject&X-Amz-Signature=29a1ac29fbcf2af1a2f635909291110d87590da5251cdad328c0e17df24b63c6
封面URL: https://prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn/infer/tasks/25/1222/04/900539403250700288/creation-01/cover.jpeg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIARRHG6JR7EMNHVUWT%2F20251222%2Fcn-northwest-1%2Fs3%2Faws4_request&X-Amz-Date=20251222T041501Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&response-cache-control=max-age%3D86400&x-id=GetObject&X-Amz-Signature=f4036a950da1be990b24ef2203130b83b9f66d4acef67f7a11318dcb02161390
水印视频: https://prod-ss-vidu.s3.cn-northwest-1.amazonaws.com.cn/infer/tasks/25/1222/04/900539403250700288/creation-01/watermarked.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIARRHG6JR7EMNHVUWT%2F20251222%2Fcn-northwest-1%2Fs3%2Faws4_request&X-Amz-Date=20251222T041501Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&response-cache-control=max-age%3D86400&response-content-disposition=attachment%3Bfilename%3Dgeneral-3-2025-12-22T04%253A14%253A55Z.mp4&x-id=GetObject&X-Amz-Signature=ca0a9cd624e2ae8f54f0d7fb0e86cdf7337b2a6fabd0dea6d908ba8f98b759aa

============================================================
🏁 流式输出结束
============================================================
```

© 2026 DMXAPI viduq2-pro
