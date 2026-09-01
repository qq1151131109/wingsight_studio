# 🎞️海螺视频

> 来源：https://doc.dmxapi.cn/hailuo-txt2video.html
> 官方标题：海螺 Hailuo 文生视频 API 接口文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# 海螺 Hailuo 文生视频 API 接口文档 ​
## 接口地址 ​

|  | 功能 | 接口地址
|  | 提交任务 | https://www.dmxapi.cn/v1/video_generation
|  | 查询任务 | https://www.dmxapi.cn/v1/query/video_generation
|  | 下载视频 | https://www.dmxapi.cn/v1/files/retrieve
## 支持的模型 ​

|  | 模型名称 | 说明
|  | MiniMax-Hailuo-2.3 | 最新版本，支持更高质量的视频生成，建议优先使用
|  | MiniMax-Hailuo-02 | 前代版本，保持向后兼容性
## 提交任务 ​
### 接口说明 ​
用于提交视频生成任务到 DMXAPI 平台。
### 示例代码 ​

```python
# ============================================================================
# 视频生成 DMXAPI 调用示例 - MiniMax Hailuo 模型
# ============================================================================

import requests
import json

# ============================================================================
# 【必填配置】API 令牌 - 请在此处填写您的 API 密钥
# ============================================================================
API_TOKEN = "sk-*******************************************"

# ============================================================================
# DMXAPI 端点配置
# ============================================================================
url = "https://www.dmxapi.cn/v1/video_generation"

# ============================================================================
# 请求参数配置
# ============================================================================
payload = {
    # 【模型选择】
    "model": "MiniMax-Hailuo-2.3",

    # 【提示词 (Prompt)】
    # 视频的文本描述，最大 2000 字符
    #
    # 支持运镜指令语法（针对 MiniMax-Hailuo-2.3、MiniMax-Hailuo-02）：
    #   可通过 [指令] 格式添加运镜指令，实现精确的镜头控制
    #
    # 支持的 15 种运镜指令：
    #   • 左右移: [左移], [右移]
    #   • 左右摇: [左摇], [右摇]
    #   • 推拉:   [推进], [拉远]
    #   • 升降:   [上升], [下降]
    #   • 上下摇: [上摇], [下摇]
    #   • 变焦:   [变焦推近], [变焦拉远]
    #   • 其他:   [晃动], [跟随], [固定]
    #
    # 运镜使用规则：
    #   1. 组合运镜：同一组 [] 内的多个指令会同时生效，如 [左摇,上升]（建议不超过 3 个）
    #   2. 顺序运镜：prompt 中前后出现的指令会依次生效，如 "...[推进], 然后...[拉远]"
    #   3. 自然语言：也支持通过自然语言描述运镜，但使用标准指令能获得更准确的响应
    "prompt": "A man picks up a book [Pedestal up], then reads [Static shot].",

    # 【视频时长】(秒)
    # 默认值: 6
    # 可用值与模型和分辨率相关：
    #   • MiniMax-Hailuo-2.3: 6/10 秒（768P）或 6 秒（1080P）
    #   • MiniMax-Hailuo-02:  6/10 秒（768P）或 6 秒（1080P）
    "duration": 6,

    # 【视频分辨率】
    # 可用值与模型相关：
    #   • MiniMax-Hailuo-2.3: 768P (默认), 1080P
    #   • MiniMax-Hailuo-02:  768P (默认), 1080P
    "resolution": "768P",

    # 【可选参数配置】
    # "prompt_optimizer": true,        # 是否自动优化 prompt（默认: true）
    # "fast_pretreatment": false,      # 是否缩短 prompt_optimizer 的优化耗时（默认: false）
    # "aigc_watermark": false,         # 是否在视频中添加水印（默认: false）
}

# ============================================================================
# 请求头配置
# ============================================================================
headers = {
    # Content-Type: 请求体格式为 JSON
    "Content-Type": "application/json",

    # Authorization: 使用上方配置的 API 令牌
    "Authorization": f"{API_TOKEN}"
}

# ============================================================================
# 发送请求并获取响应
# ============================================================================
response = requests.post(url, json=payload, headers=headers)

# ============================================================================
# 输出响应结果
# ============================================================================
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

### 返回示例 ​
成功响应包含任务ID，用于后续查询任务状态和下载视频。

```json
{
  "task_id": "335492703728059",
  "base_resp": {
    "status_code": 0,
    "status_msg": "success"
  }
}
```

返回字段说明：

|  | 字段 | 说明
|  | task_id | 视频生成任务的唯一标识符，用于查询任务状态和下载视频
|  | base_resp.status_code | 响应状态码，0 表示成功
|  | base_resp.status_msg | 响应状态信息
## 查询任务 ​
### 接口说明 ​
用于查询视频生成任务的当前状态和下载链接。
### 示例代码 ​

```python
# ================================
# 视频生成任务查询脚本
# ================================

import requests
import json

# ================================
# 1. 配置 DMXAPI 信息
# ================================

# DMXAPI 基础地址
base_url = "https://www.dmxapi.cn"

# DMXAPI 端点：查询视频生成状态
endpoint = "/v1/query/video_generation"

# 视频生成任务 ID
task_id = "335492703728059"

# ================================
# 2. 认证信息
# ================================

# DMMXAPI 授权令牌（Token）
token = "sk-*******************************************"

# ================================
# 3. 构建 HTTP 请求
# ================================

# 完整的请求 URL
url = f"{base_url}{endpoint}?task_id={task_id}"

# 请求头，包含认证信息
headers = {
    "Authorization": f"{token}"
}

# ================================
# 4. 发送 API 请求
# ================================

response = requests.get(url, headers=headers)

# ================================
# 5. 处理和显示响应
# ================================

# 显示 HTTP 状态码
print(f"Status Code: {response.status_code}")

# 显示完整的 JSON 响应（格式化输出）
print("Response:")
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

### 返回示例 ​
成功响应包含任务状态、文件ID和视频分辨率信息。

```json
Status Code: 200
Response:
{
  "status": "Success",
  "file_id": "335560631603474",
  "task_id": "335558695837779",
  "base_resp": {
    "status_msg": "success",
    "status_code": 0
  },
  "video_width": 1366,
  "video_height": 768
}
```

返回字段说明：

|  | 字段 | 说明
|  | status | 任务状态，"Success" 表示生成完成
|  | file_id | 生成的视频文件ID，用于下载视频
|  | task_id | 任务ID
|  | video_width | 生成的视频宽度（像素）
|  | video_height | 生成的视频高度（像素）
|  | base_resp.status_code | 响应状态码，0 表示成功
|  | base_resp.status_msg | 响应状态信息
## 下载视频 ​
### 接口说明 ​
用于下载已生成的视频文件。使用查询任务接口返回的 file_id 和 task_id 来获取可下载的视频链接。
### 示例代码 ​

```python
import requests
import json

# ======================== API 配置 ========================
# DMXAPI 基础 URL
BASE_URL = "https://www.dmxapi.cn"  # 替换为实际的 API 域名

# 文件 ID - 用于标识要检索的文件
FILE_ID = "335560631603474"

# 任务 ID - 用于标识相关的任务
TASK_ID = "335558695837779"

# 认证令牌 - 用于 DMXAPI 请求的身份验证
TOKEN = "sk-*******************************************"

# ======================== 构建 API 请求 ========================
# 文件检索端点 URL
url = f"{BASE_URL}/v1/files/retrieve"

# 请求参数：包含文件 ID 和任务 ID
params = {
    "file_id": FILE_ID,      # 指定要检索的文件
    "task_id": TASK_ID       # 指定相关的任务
}

# 请求头：包含认证信息
headers = {
    "Authorization": f"{TOKEN}"  # 令牌认证
}

# ======================== 发送 API 请求 ========================
# 发送 GET 请求到 API 端点
response = requests.get(url, params=params, headers=headers)

# ======================== 输出响应结果 ========================
# 输出 HTTP 状态码
print(f"Status Code: {response.status_code}")

# 输出格式化的 JSON 响应内容
print(f"Response:\n{json.dumps(response.json(), indent=2, ensure_ascii=False)}")
```

### 返回示例 ​
成功响应包含视频文件信息和可下载的文件链接（有效期内）。

```json
Status Code: 200
Response:
{
  "file": {
    "file_id": 335560631603474,
    "bytes": 0,
    "created_at": 1763477381,
    "filename": "output_aigc.mp4",
    "purpose": "video_generation",
    "download_url": "https://public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com/inference_output%2Fvideo%2F2025-11-18%2F6da9f9d0-69eb-4081-b645-a79622b99453%2Foutput_aigc.mp4?Expires=1763510682&OSSAccessKeyId=LTAI5tAmwsjSaaZVA6cEFAUu&Signature=9Z9J8h5b%2B3QI8KwBnEJAR4H1Kmk%3D"
  },
  "base_resp": {
    "status_code": 0,
    "status_msg": "success"
  }
}
```

返回字段说明：

|  | 字段 | 说明
|  | file.file_id | 视频文件的唯一标识符
|  | file.filename | 生成的视频文件名
|  | file.created_at | 文件创建时间戳（Unix时间）
|  | file.download_url | 视频的可下载链接，包含有效期和签名信息
|  | file.purpose | 文件用途标识，"video_generation" 表示由视频生成服务产生
|  | base_resp.status_code | 响应状态码，0 表示成功
|  | base_resp.status_msg | 响应状态信息
注意事项：

- 下载链接有有效期限制，请及时下载
- 下载链接包含签名信息，请勿修改URL内容
## 完整的工作流程 ​
使用海螺文生视频API的标准流程：
- 提交任务 → 调用 /v1/video_generation 提交视频生成请求，获得 task_id
- 轮询查询 → 定期调用 /v1/query/video_generation 查询任务状态，等待任务完成（status: "Success"），获得 file_id
- 下载视频 → 调用 /v1/files/retrieve 获取下载链接，从 URL 下载视频文件
© 2026 DMXAPI 海螺视频 - 文生视频 API 服务
