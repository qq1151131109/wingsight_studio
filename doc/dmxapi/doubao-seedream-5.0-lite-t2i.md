# 🖌️豆包即梦

> 来源：https://doc.dmxapi.cn/doubao-seedream-5.0-lite-t2i.html
> 官方标题：doubao-seedream-5.0-lite 文生图 API 使用文档
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# doubao-seedream-5.0-lite 文生图 API 使用文档 ​
基于字节跳动 Seedream 5.0 lite 模型的文生图接口，通过 DMXAPI /v1/responses 端点调用。仅需文本提示词即可生成高质量图片，支持 2K / 3K / 4K 三档分辨率（方式二最高 4096×4096=16777216 总像素）、组图批量生成（单次最多 15 张）、联网搜索增强（tools: web_search，提升商品、天气等时效性内容的准确度）、自定义输出格式（png / jpeg）以及流式输出，适合营销海报、概念设计、内容配图等需要高分辨率与时效性的图像生成场景。
## 接口地址 ​

|  | 接口 | 请求方式 | URL
|  | 文生图 | POST | https://www.dmxapi.cn/v1/responses

WARNING
请妥善保管您的 API Key！严禁将密钥泄露给他人、硬编码到代码中或提交到公开的代码仓库。如果怀疑密钥已泄露，请立即前往 DMXAPI 官网重新生成。
## 模型名称 ​

- doubao-seedream-5.0-lite
## 文生图 示例代码 ​

非流式流式

```python
import requests
import json

# ===============================================================
# 步骤1: 配置 API 连接信息
# ===============================================================

# DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-***********************************************"

# ===============================================================
# 步骤2: 配置请求头
# ===============================================================

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",           # token 认证方式
}

# ===============================================================
# 步骤3: 配置请求参数
# ===============================================================

payload = {
    # 【model】(string, 必填) 您需要调用的模型 ID
    "model": "doubao-seedream-5.0-lite",

    # 【input】(string, 必填) 用于生成图像的提示词，支持中英文
    # 建议不超过 300 个汉字或 600 个英文单词；字数过多信息容易分散，
    # 模型可能因此忽略细节、只关注重点，造成图片缺失部分元素
    # 组图场景下可在提示词中说明期望的数量（如"生成5张..."），由模型在 auto 模式下自主判断
    "input": "生成5张科技感满满宇宙飞船",

    # 【size】(string, 可选) 指定生成图像的尺寸信息，支持以下两种方式，不可混用
    #   方式 1 | 指定分辨率，并在 input 提示词中用自然语言描述宽高比/形状/用途，由模型判断具体大小
    #     可选值：2K、3K、4K
    #   方式 2 | 指定宽高像素值，默认值 2048x2048，需同时满足：
    #     总像素取值范围：[2560x1440=3686400, 4096x4096=16777216]
    #     宽高比取值范围：[1/16, 16]
    #     说明：总像素是对单张图宽度和高度的像素乘积限制，而非对宽度或高度单独限制
    #       有效示例 3750x1250：总像素 3750x1250=4687500 符合 [3686400, 16777216]，
    #                          宽高比 3750/1250=3 符合 [1/16, 16]，故有效
    #       无效示例 1500x1500：总像素 1500x1500=2250000 未达到 3686400 最低要求，
    #                          虽宽高比 1 符合范围，但未同时满足两项限制，故无效
    #   推荐的宽高像素值：
    #     2K | 1:1=2048x2048  4:3=2304x1728  3:4=1728x2304  16:9=2848x1600
    #        | 9:16=1600x2848  3:2=2496x1664  2:3=1664x2496  21:9=3136x1344
    #     3K | 1:1=3072x3072  4:3=3456x2592  3:4=2592x3456  16:9=4096x2304
    #        | 9:16=2304x4096  3:2=3744x2496  2:3=2496x3744  21:9=4704x2016
    #     4K | 1:1=4096x4096  4:3=4704x3520  3:4=3520x4704  16:9=5504x3040
    #        | 9:16=3040x5504  3:2=4992x3328  2:3=3328x4992  21:9=6240x2656
    "size": "2K",

    # 【sequential_image_generation】(string, 可选) 控制是否开启组图功能，默认值 disabled
    #   组图：基于您输入的内容，生成的一组内容关联的图片
    #   auto：自动判断模式，模型根据提示词自主判断是否返回组图以及组图包含的图片数量
    #   disabled：关闭组图功能，模型只会生成一张图
    "sequential_image_generation": "auto",

    # 【sequential_image_generation_options】(object, 可选) 组图功能的配置，仅当 sequential_image_generation 为 auto 时生效
    "sequential_image_generation_options": {
        # 【max_images】(integer, 可选) 指定本次请求最多可生成的图片数量，默认值 15，取值范围 [1, 15]
        # 实际可生成的图片数量除受 max_images 影响外，还受输入参考图数量影响：
        # 输入的参考图数量 + 最终生成的图片数量 ≤ 15 张
        "max_images": 15
    },

    # 【tools】(array of object, 可选) 配置模型要调用的工具
    "tools": [{
        # 【tools.type】(string, 可选) 指定使用的工具类型
        #   web_search：联网搜索功能，开启后模型根据提示词自主判断是否搜索互联网内容（如商品、天气等），
        #               提升生成图片的时效性，但也会增加一定的时延
        #   实际搜索次数可通过返回字段 usage.tool_usage.web_search 查询，为 0 表示未搜索
        "type": "web_search"
    }],

    # 【stream】(boolean, 可选) 控制是否开启流式输出模式，默认值 false
    #   false：非流式输出，等待所有图片全部生成结束后再一次性返回所有信息
    #   true：流式输出，即时返回每张图片输出的结果；在生成单图和组图场景下均生效
    "stream": False,

    # 【output_format】(string, 可选) 指定生成图像的文件格式，默认值 jpeg
    #   可选值：png、jpeg
    "output_format": "png",

    # 【response_format】(string, 可选) 指定生成图像的返回格式，默认值 url
    #   url：返回图片下载链接，链接在图片生成后 24 小时内有效，请及时下载图片
    #   b64_json：以 Base64 编码字符串的 JSON 格式返回图像数据
    "response_format": "url",

    # 【watermark】(boolean, 可选) 是否在生成的图片中添加水印，默认值 true
    #   false：不添加水印
    #   true：在图片右下角添加"AI生成"字样的水印标识
    "watermark": False,

    # 【optimize_prompt_options】(object, 可选) 提示词优化功能的配置
    "optimize_prompt_options": {
        # 【optimize_prompt_options.mode】(string, 可选) 设置提示词优化功能使用的模式，默认值 standard
        #   standard：标准模式，生成内容的质量更高，耗时较长
        #   fast：快速模式，生成内容的耗时更短，质量一般；当前 doubao-seedream-5.0-lite 不支持
        "mode": "standard"
    }
}

# ===============================================================
# 步骤4: 发送请求并输出结果
# ===============================================================

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)

# 格式化输出 JSON 响应
# - indent=2: 缩进 2 空格，便于阅读
# - ensure_ascii=False: 正确显示中文字符
print(json.dumps(response.json(), indent=2, ensure_ascii=False))
```

```python
import requests
import json

# ===============================================================
# 步骤1: 配置 API 连接信息
# ===============================================================

# DMXAPI 服务端点地址
url = "https://www.dmxapi.cn/v1/responses"

# DMXAPI 密钥 (请替换为您自己的密钥)
# 获取方式: 登录 DMXAPI 官网 -> 个人中心 -> API 密钥管理
api_key = "sk-***********************************************"

# ===============================================================
# 步骤2: 配置请求头
# ===============================================================

headers = {
    "Content-Type": "application/json",      # 指定请求体为 JSON 格式
    "Authorization": f"{api_key}",           # token 认证方式
}

# ===============================================================
# 步骤3: 配置请求参数
# ===============================================================

payload = {
    # 【model】(string, 必填) 您需要调用的模型 ID
    "model": "doubao-seedream-5.0-lite",

    # 【input】(string, 必填) 用于生成图像的提示词，支持中英文
    # 建议不超过 300 个汉字或 600 个英文单词；字数过多信息容易分散，
    # 模型可能因此忽略细节、只关注重点，造成图片缺失部分元素
    # 组图场景下可在提示词中说明期望的数量（如"生成5张..."），由模型在 auto 模式下自主判断
    "input": "生成5张科技感满满宇宙飞船",

    # 【size】(string, 可选) 指定生成图像的尺寸信息，支持以下两种方式，不可混用
    #   方式 1 | 指定分辨率，并在 input 提示词中用自然语言描述宽高比/形状/用途，由模型判断具体大小
    #     可选值：2K、3K、4K
    #   方式 2 | 指定宽高像素值，默认值 2048x2048，需同时满足：
    #     总像素取值范围：[2560x1440=3686400, 4096x4096=16777216]
    #     宽高比取值范围：[1/16, 16]
    #     说明：总像素是对单张图宽度和高度的像素乘积限制，而非对宽度或高度单独限制
    #       有效示例 3750x1250：总像素 3750x1250=4687500 符合 [3686400, 16777216]，
    #                          宽高比 3750/1250=3 符合 [1/16, 16]，故有效
    #       无效示例 1500x1500：总像素 1500x1500=2250000 未达到 3686400 最低要求，
    #                          虽宽高比 1 符合范围，但未同时满足两项限制，故无效
    #   推荐的宽高像素值：
    #     2K | 1:1=2048x2048  4:3=2304x1728  3:4=1728x2304  16:9=2848x1600
    #        | 9:16=1600x2848  3:2=2496x1664  2:3=1664x2496  21:9=3136x1344
    #     3K | 1:1=3072x3072  4:3=3456x2592  3:4=2592x3456  16:9=4096x2304
    #        | 9:16=2304x4096  3:2=3744x2496  2:3=2496x3744  21:9=4704x2016
    #     4K | 1:1=4096x4096  4:3=4704x3520  3:4=3520x4704  16:9=5504x3040
    #        | 9:16=3040x5504  3:2=4992x3328  2:3=3328x4992  21:9=6240x2656
    "size": "2K",

    # 【sequential_image_generation】(string, 可选) 控制是否开启组图功能，默认值 disabled
    #   组图：基于您输入的内容，生成的一组内容关联的图片
    #   auto：自动判断模式，模型根据提示词自主判断是否返回组图以及组图包含的图片数量
    #   disabled：关闭组图功能，模型只会生成一张图
    "sequential_image_generation": "auto",

    # 【sequential_image_generation_options】(object, 可选) 组图功能的配置，仅当 sequential_image_generation 为 auto 时生效
    "sequential_image_generation_options": {
        # 【max_images】(integer, 可选) 指定本次请求最多可生成的图片数量，默认值 15，取值范围 [1, 15]
        # 实际可生成的图片数量除受 max_images 影响外，还受输入参考图数量影响：
        # 输入的参考图数量 + 最终生成的图片数量 ≤ 15 张
        "max_images": 15
    },

    # 【tools】(array of object, 可选) 配置模型要调用的工具
    "tools": [{
        # 【tools.type】(string, 可选) 指定使用的工具类型
        #   web_search：联网搜索功能，开启后模型根据提示词自主判断是否搜索互联网内容（如商品、天气等），
        #               提升生成图片的时效性，但也会增加一定的时延
        #   实际搜索次数可通过返回字段 usage.tool_usage.web_search 查询，为 0 表示未搜索
        "type": "web_search"
    }],

    # 【stream】(boolean, 可选) 控制是否开启流式输出模式，默认值 false
    #   false：非流式输出，等待所有图片全部生成结束后再一次性返回所有信息
    #   true：流式输出，即时返回每张图片输出的结果；在生成单图和组图场景下均生效
    "stream": True,

    # 【output_format】(string, 可选) 指定生成图像的文件格式，默认值 jpeg
    #   可选值：png、jpeg
    "output_format": "png",

    # 【response_format】(string, 可选) 指定生成图像的返回格式，默认值 url
    #   url：返回图片下载链接，链接在图片生成后 24 小时内有效，请及时下载图片
    #   b64_json：以 Base64 编码字符串的 JSON 格式返回图像数据
    "response_format": "url",

    # 【watermark】(boolean, 可选) 是否在生成的图片中添加水印，默认值 true
    #   false：不添加水印
    #   true：在图片右下角添加"AI生成"字样的水印标识
    "watermark": False,

    # 【optimize_prompt_options】(object, 可选) 提示词优化功能的配置
    "optimize_prompt_options": {
        # 【optimize_prompt_options.mode】(string, 可选) 设置提示词优化功能使用的模式，默认值 standard
        #   standard：标准模式，生成内容的质量更高，耗时较长
        #   fast：快速模式，生成内容的耗时更短，质量一般；当前 doubao-seedream-5.0-lite 不支持
        "mode": "standard"
    }
}

# ===============================================================
# 步骤4: 发送请求并输出结果
# ===============================================================

# 发送 POST 请求到 API 服务器（stream=True 开启流式传输）
response = requests.post(url, headers=headers, json=payload, stream=True)

print(response.status_code)

# 流式读取响应，只保留关键信息
current_event = None
for line in response.iter_lines():
    if line:
        line = line.decode('utf-8')

        # 记录事件类型
        if line.startswith('event: '):
            current_event = line[7:]
            continue

        # 处理数据行
        if line.startswith('data: '):
            data_str = line[6:]
        else:
            data_str = line

        # 只输出图片生成事件和完成事件
        if current_event == 'response.output_text.delta':
            # data_str 是 JSON 字符串；delta 字段里的 URL 含转义字符，
            # 需 json.loads 后再取 delta，才是浏览器可直接打开的真实 URL
            try:
                delta = json.loads(data_str).get('delta', '')
            except json.JSONDecodeError:
                delta = data_str
            print(f"event: {current_event}")
            print(delta)
        elif current_event == 'response.completed':
            try:
                data = json.loads(data_str)
                usage = data.get('response', {}).get('usage', {})
                print(f"event: {current_event}")
                print(json.dumps({
                    "status": "completed",
                    "usage": usage
                }, ensure_ascii=False))
            except:
                print(data_str)
        elif data_str == '[DONE]':
            print('[DONE]')
```

## 返回示例 ​

非流式流式

```json
{
  "background": false,
  "completed_at": 1772426414,
  "created_at": 1772426414,
  "error": null,
  "id": "resp_8d4f166d227246228dda783119c86455",
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": 128000,
  "max_tool_calls": null,
  "metadata": {},
  "model": "doubao-seedream-5.0-lite",
  "object": "response",
  "output": [
    {
      "content": [
        {
          "annotations": [],
          "logprobs": [],
          "text": "![Image 1](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/...)\n![Image 2](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/...)\n![Image 3](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/...)\n![Image 4](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/...)\n![Image 5](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/...)",
          "type": "output_text"
        }
      ],
      "id": "msg_ec3f52d7ae79466c99702ca49577aea2",
      "role": "assistant",
      "status": "completed",
      "type": "message"
    }
  ],
  "parallel_tool_calls": true,
  "previous_response_id": null,
  "reasoning": {
    "effort": "none",
    "summary": null
  },
  "service_tier": "default",
  "status": "completed",
  "store": true,
  "temperature": 1,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tools": [],
  "top_p": 1,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 0,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 11000,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 11000
  },
  "user": null
}
```

```text
200
event: response.output_text.delta
![Image 1](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/021779274638395d54a2e8b6146550b9b78e5e06cf50b2233c9be_0.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260520T105746Z&X-Tos-Expires=86400&X-Tos-Signature=ac9efa4a6f6da9457144e0e6cda82950487a3c65b6a5272c5eef6b6b381f8477&X-Tos-SignedHeaders=host)
event: response.output_text.delta
![Image 2](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/021779274638395d54a2e8b6146550b9b78e5e06cf50b2233c9be_4.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260520T105813Z&X-Tos-Expires=86400&X-Tos-Signature=0c6ba0ae42d1ba33d2edd0998c6cf4841c65cbd2a97c0b4404fa53fcc7a99742&X-Tos-SignedHeaders=host)
event: response.output_text.delta
![Image 3](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/021779274638395d54a2e8b6146550b9b78e5e06cf50b2233c9be_2.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260520T105820Z&X-Tos-Expires=86400&X-Tos-Signature=c5cfd85211bab860b88eba45833df1d18a24a909a1e942587681f712651f9d24&X-Tos-SignedHeaders=host)
event: response.output_text.delta
![Image 4](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/021779274638395d54a2e8b6146550b9b78e5e06cf50b2233c9be_1.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260520T105826Z&X-Tos-Expires=86400&X-Tos-Signature=ea80218b9f1db4ad4bb6312f881064fab2ba2c9bceaaf8acc19afb030dafc638&X-Tos-SignedHeaders=host)
event: response.output_text.delta
![Image 5](https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/021779274638395d54a2e8b6146550b9b78e5e06cf50b2233c9be_3.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLT_REDACTED&X-Tos-Date=20260520T105833Z&X-Tos-Expires=86400&X-Tos-Signature=d29e4609e2567a3ff579d9a6f56759ccc40b5c524b4df73135cb2b5357c4b7c1&X-Tos-SignedHeaders=host)
event: response.completed
{"status": "completed", "usage": {"input_tokens": 1, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 11000, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 11001}}
```

© 2026 DMXAPI doubao-seedream-5.0-lite 文生图
