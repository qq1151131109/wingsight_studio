# 📚TTS文本转语音

> 来源：https://doc.dmxapi.cn/minimax-speech.html
> 官方标题：MiniMax 旗下的 TTS 模型 speech 系列
> 抓取时间：2026-09-01（DMXAPI 文档为动态页面，以线上为准）

# MiniMax 旗下的 TTS 模型 speech 系列 ​
TTS，全称为 Text-to-Speech，即文本转语音。TTS 模型是一种将书面文本自动转换为人类可听的语音的人工智能模型。它的最终目标是生成听起来尽可能自然、清晰、富有表现力的语音，如同真人说话一般。
MiniMax speech 系列目前包含 speech-2.6 和 speech-2.8-hd 两个版本。2.6 系列提供 OpenAI 兼容的简洁调用方式，适合快速集成；2.8-hd 则提供高级语音合成能力，支持情绪控制、音色混合、音效、注音、LaTeX 公式朗读等丰富功能。
## 模型概览 ​

|  | 对比项 | speech-2.6 系列 | speech-2.8-hd
|  | 模型名称 | speech-2.6-hd / speech-2.6-turbo | speech-2.8-hd
|  | 接口地址 | /v1/audio/speech | /v1/responses
|  | 请求格式 | 简单（model, input, voice） | 详细（voice_setting, audio_setting 等）
|  | 功能特点 | 基础 TTS，80+ 预设音色 | 9 种情绪、19 种语气词、4 音色混合、音效等
|  | 音色 ID 格式 | male-qn-qingse 格式 | h20260212 格式，参考 [MiniMax 平台](https://platform.minimaxi.com/docs/faq/system-voice-id)
|  | 返回格式 | 二进制音频流 | hex 编码音频 / URL
## speech-2.6 系列（OpenAI 兼容接口） ​
### 模型名称 ​

- speech-2.6-hd
- speech-2.6-turbo
### 调用地址 ​
https://www.dmxapi.cn/v1/audio/speech
### Python 示例 ​

```python
# 文本转语音(TTS)调用示例（DMXAPI）
# 功能：将指定文本合成为 MP3 并保存到本地。
# 快速使用：
# 1) 安装依赖：pip install requests
# 2) 设置密钥：把下方 api_key 替换为您的DMXAPI密钥（生产建议用环境变量，如 os.getenv("DMXAPI_KEY")）
# 3) 运行脚本：python tts-openai.py
# 4) 输出位置：脚本同级的 outpu/ 目录，文件名包含时间戳。
# 注意：
# - 不要在生产环境硬编码密钥；避免泄露与误提交。

import requests  # 第三方 HTTP 库，用于发起网络请求
import os
from datetime import datetime

# DMXAPI 的 url
url = "https://www.dmxapi.cn/v1/audio/speech"

api_key = "sk-*******************************************"  # 替换为您的dmxapi的API密钥

# 请求负载（JSON 体）
# - model：使用的语音合成模型名称
# - input：要合成的文本内容
# - voice：音色/发音人，具体可查服务文档支持的取值
# 参数提示：
# - 长文本建议分段合成以提升稳定性
# - voice 可替换为平台支持的其他音色
payload = {
    "model": "speech-2.6-hd",
    "input": "DMXAPI，一个key使用全球大模型！",
    "voice": "male-qn-qingse"
}

try:
    # 发起 POST 请求到 TTS 服务
    # - headers：携带认证信息，使用 Token 方式
    # - json：以 JSON 格式提交负载

    response = requests.post(
        url,
        headers={"Authorization": f"{api_key}"},
        json=payload
    )

    # 如果服务返回 4xx/5xx 状态码，会抛出 HTTPError 异常，便于统一异常处理
    response.raise_for_status()

    # 处理音频响应：
    # 一般音频的 Content-Type 为 "audio/mpeg" 或 "audio/mp3"
    # 注意：此处直接访问 headers["Content-Type"]，如果服务未返回该头会触发 KeyError。
    # 在生产代码中可考虑使用 headers.get("Content-Type", "") 来更稳健地取值。
    if response.headers["Content-Type"] in ("audio/mpeg", "audio/mp3"):
        # 以二进制写入的方式保存音频文件到本地
        # 输出目录（默认 'outpu'；如需更改可修改此处）
        output_dir = os.path.join(os.path.dirname(__file__), "output")
        os.makedirs(output_dir, exist_ok=True)
        # 使用时间戳保证文件名唯一，避免被覆盖
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(output_dir, f"output_{timestamp}.mp3")
        # 将音频二进制内容写入目标文件
        with open(output_path, "wb") as f:
            _ = f.write(response.content)
        print(f"语音合成成功，已保存为{output_path}")
    else:
        # 如果不是音频类型，打印文本内容以便排查问题
        # 常见原因：参数错误、鉴权失败、服务端异常等
        print("错误响应:", response.text)

except Exception as e:
    # 捕获并输出所有异常，便于快速定位问题
    # 可能出现的异常包括：
    # - requests.exceptions.Timeout：请求超时
    # - requests.exceptions.ConnectionError：网络连接失败
    # - requests.exceptions.HTTPError：HTTP 状态码错误（由 raise_for_status 触发）
    print(f"请求出错: {e}")
```

运行输出示例：

```text
语音合成成功，已保存为c:\Users\98317\Desktop\xiangmu\kefang\outpu\output_20251029_155307.mp3
```

### Python 流式输出示例 ​

```python
# 文本转语音(TTS)调用示例（DMXAPI）
# 功能：将指定文本合成为 MP3，并以「纯流式」方式播放，不保存到磁盘。
# 快速使用：
# - 安装依赖：pip install requests
# - 设置密钥：将下方 api_key 替换为您的 DMXAPI 密钥（生产建议使用环境变量，例如 os.getenv("DMXAPI_KEY")）
# - 运行脚本：python tts_stream.py
# 注意：
# - 为实现纯流式播放，本脚本不进行文件落盘。如需播放请确保系统已安装 ffplay（FFmpeg）。

# 说明：
# - 本脚本优先尝试使用 ffplay 实现「边下边播」，仅当 ffplay 不可用或启动失败时，才回退为将音频保存到本地文件并在 Windows 上自动打开。
# - 可通过环境变量 `FFPLAY_PATH` 指定 ffplay 的绝对路径（例如 C:\FFmpeg\bin\ffplay.exe），设置 `FFPLAY_DEBUG=1` 可查看 ffplay 的详细日志。
# - 关键步骤（请求参数、流式下载、播放/保存分支、进度打印与资源清理）均已补充详细中文注释，便于理解与维护。

import requests
import os
import shutil
import subprocess
import sys
from datetime import datetime
from typing import BinaryIO

# 模块用途速览：
# - requests：发送 HTTP 请求并按流方式接收响应内容
# - os/shutil/subprocess：环境变量读取、外部播放器检查、调用系统程序
# - datetime：生成时间戳用于本地文件命名

# DMXAPI 的 URL
url = "https://www.dmxapi.cn/v1/audio/speech"

# 密钥：生产环境建议通过环境变量注入
api_key = os.getenv("DMXAPI_KEY", "sk-*******************************************")

# 安全提示：请避免在生产代码中硬编码密钥，推荐通过环境变量或密钥管控服务注入。

# 请求负载（JSON 体）
payload = {
    "model": "speech-2.6-hd",
    "input": "DMXAPI，一个key使用全球大模型！",
    "voice": "male-qn-qingse",
}

# 字段说明：
# - model：TTS 模型名称
# - input：待合成的文本内容
# - voice：发音人音色或角色（不同平台支持的枚举可能不同）

try:
    # 发起 POST 请求到 TTS 服务（开启流式传输）
    # 说明：Accept 指定期望的音频类型，`stream=True` 允许我们一边接收一边播放或写入文件。
    response = requests.post(
        url,
        headers={
            "Authorization": f"{api_key}",
            "Accept": "audio/mpeg",
        },
        json=payload,
        stream=True,
        timeout=(10, 120),  # 连接/读取超时（可根据网络情况调整）
    )

    # 若返回 4xx/5xx，抛出异常
    response.raise_for_status()

    # 处理音频响应：常见类型为 audio/mpeg、audio/mp3；也可能返回 application/octet-stream
    content_type = response.headers.get("Content-Type", "")
    print(f"Content-Type: {content_type}")
    if content_type.startswith("audio/") or content_type in ("audio/mpeg", "audio/mp3", "application/octet-stream", "binary/octet-stream"):
        total = int(response.headers.get("Content-Length", 0))
        written = 0
        chunk_size = 1024 * 64  # 64KB 每块
        last_percent = -1
        # 文件保存相关变量（当未使用 ffplay 时启用）
        f_out: BinaryIO | None = None
        output_path: str | None = None

        # 优先使用 ffplay 进行边下边播（不落盘）
        # 允许通过环境变量 FFPLAY_PATH 指定 ffplay 完整路径；否则回退 PATH 检测

        def _is_executable(path: str) -> bool:
            if not path:
                return False
            try:
                return os.path.isfile(path) and os.access(path, os.X_OK)
            except Exception:
                return False

        def find_ffplay_path() -> str | None:
            # 1) 显式环境变量
            env_path = os.getenv("FFPLAY_PATH")
            if env_path and _is_executable(env_path):
                return env_path

            # 2) PATH 中的 ffplay
            which_path = shutil.which("ffplay")
            if which_path and _is_executable(which_path):
                return which_path

            # 3) 常见的 Conda/Windows 安装位置（尤其是 conda-forge 的 Library\bin）
            candidates: list[str] = []
            if os.name == "nt":
                bases: list[str] = []
                # CONDA_PREFIX 优先，其次使用当前解释器前缀
                conda_prefix = os.getenv("CONDA_PREFIX")
                if conda_prefix:
                    bases.append(conda_prefix)
                if sys.prefix and (not bases or sys.prefix not in bases):
                    bases.append(sys.prefix)
                for base in bases:
                    candidates.extend([
                        os.path.join(base, "Library", "bin", "ffplay.exe"),
                        os.path.join(base, "Library", "mingw-w64", "bin", "ffplay.exe"),
                        os.path.join(base, "bin", "ffplay.exe"),
                        os.path.join(base, "Scripts", "ffplay.exe"),
                    ])
                # 常见系统安装位置
                candidates.extend([
                    r"C:\\ffmpeg\\bin\\ffplay.exe",
                    r"C:\\Program Files\\ffmpeg\\bin\\ffplay.exe",
                    r"C:\\Program Files (x86)\\ffmpeg\\bin\\ffplay.exe",
                    r"C:\\ProgramData\\chocolatey\\bin\\ffplay.exe",
                ])

            # 在调试模式下打印候选路径，便于排查
            if os.getenv("FFPLAY_DEBUG") == "1":
                try:
                    print("FFPLAY 检测候选:")
                    for p in candidates:
                        print(" -", p, "[存在]" if _is_executable(p) else "[缺失]")
                except Exception:
                    pass

            for p in candidates:
                if _is_executable(p):
                    return p
            return None

        ffplay_path = find_ffplay_path()
        ffplay_proc: subprocess.Popen[bytes] | None = None
        use_ffplay = bool(ffplay_path)

        # 说明：如果系统存在 ffplay，将尝试实时播放；否则进入保存到文件的回退分支。

        # 先读取首块数据用于格式嗅探与快速启动 ffplay
        it = response.iter_content(chunk_size=chunk_size)
        try:
            first_chunk_raw = next(it)  # pyright: ignore[reportAny]
            first_chunk: bytes = first_chunk_raw if isinstance(first_chunk_raw, bytes) else b""
        except StopIteration:
            print("音频流为空，未收到数据")
            first_chunk = b""

        def looks_like_mp3(buf: bytes) -> bool:
            # MP3 开头可能是 ID3 标签或帧同步字节 0xFFExx
            return buf.startswith(b"ID3") or (len(buf) >= 2 and buf[0] == 0xFF and (buf[1] & 0xE0) == 0xE0)

        if use_ffplay and ffplay_path:
            try:
                ffplay_args: list[str] = [ffplay_path, "-hide_banner", "-nodisp", "-autoexit", "-loglevel", "error"]
                # ffplay 参数说明：
                # - -nodisp：不显示视频/波形窗口；
                # - -autoexit：播放结束后自动退出；
                # - -loglevel error：仅输出错误级别日志，减少控制台噪音。
                if content_type in ("audio/mpeg", "audio/mp3") or looks_like_mp3(first_chunk):
                    ffplay_args += ["-f", "mp3", "-i", "pipe:0"]
                else:
                    ffplay_args += ["-i", "pipe:0"]
                ffplay_proc = subprocess.Popen(
                    ffplay_args,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=None if os.getenv("FFPLAY_DEBUG") == "1" else subprocess.DEVNULL,
                )
                print(f"已启动 ffplay 进行实时播放（不保存文件），路径：{ffplay_path}")
            except Exception as _e:
                print(f"启动 ffplay 失败：{_e}，将启用回退逻辑：保存到本地并在结束后自动播放。")
                use_ffplay = False

        # 若 ffplay 不可用，准备保存到文件
        if not use_ffplay:
            try:
                # 注意：为与现有项目结构保持一致，音频文件存放在 `outpu` 子目录下。
                output_dir = os.path.join(os.path.dirname(__file__), "output")
                os.makedirs(output_dir, exist_ok=True)
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                ext = ".mp3" if (content_type in ("audio/mpeg", "audio/mp3") or looks_like_mp3(first_chunk)) else ".bin"
                output_path = os.path.join(output_dir, f"tts_{ts}{ext}")
                f_out = open(output_path, "wb")
                hint = "（可设置环境变量 FFPLAY_PATH 指向 ffplay.exe 或将其加入 PATH）"
                print(f"未检测到 ffplay，将保存到文件：{output_path} {hint}")
            except Exception as _e:
                print(f"打开输出文件失败：{_e}，将仅显示下载进度（不保存、不播放）。")
                f_out = None

        # 将首块数据写入 ffplay 并更新进度
        if first_chunk:
            written += len(first_chunk)
            # 写入 ffplay
            if use_ffplay and ffplay_proc and ffplay_proc.poll() is None and ffplay_proc.stdin:
                try:
                    _ = ffplay_proc.stdin.write(first_chunk)
                    ffplay_proc.stdin.flush()
                except Exception:
                    ffplay_proc = None
            # 写入文件
            if f_out is not None:
                try:
                    _ = f_out.write(first_chunk)
                    f_out.flush()
                except Exception:
                    pass
            # 打印首块后的进度
            if total > 0:
                percent = int(written * 100 / total)
                if percent % 5 == 0:
                    print(f"下载进度 {percent}% ({written/1024:.0f} KB)", end="\r")
            else:
                print(f"已下载 {written/(1024*1024):.2f} MB...", end="\r")

        # 继续写入剩余数据
        for chunk in it:  # pyright: ignore[reportAny]
            chunk_bytes: bytes = chunk if isinstance(chunk, bytes) else b""
            if not chunk_bytes:
                continue
            written += len(chunk_bytes)
            if use_ffplay and ffplay_proc and ffplay_proc.poll() is None and ffplay_proc.stdin:
                try:
                    _ = ffplay_proc.stdin.write(chunk_bytes)
                    ffplay_proc.stdin.flush()
                except BrokenPipeError:
                    ffplay_proc = None
                except Exception:
                    ffplay_proc = None
            # 同时写入文件（当启用回退保存时）
            if f_out is not None:
                try:
                    _ = f_out.write(chunk_bytes)
                except Exception:
                    pass

            # 简单进度输出：有 Content-Length 时按百分比，否则按 MB 计数
            if total > 0:
                percent = int(written * 100 / total)
                if percent != last_percent and percent % 5 == 0:  # 每 5% 打印一次
                    print(f"下载进度 {percent}% ({written/1024:.0f} KB)", end="\r")
                    last_percent = percent
            else:
                if written % (1024 * 1024) < chunk_size:  # 约每 1MB 打印
                    print(f"已下载 {written/(1024*1024):.2f} MB...", end="\r")

        # 播放结束时清理 ffplay 的输入并等待退出
        if use_ffplay and ffplay_proc and ffplay_proc.stdin:
            try:
                ffplay_proc.stdin.close()
            except Exception:
                pass
            try:
                ffplay_proc.wait(timeout=5)  # pyright: ignore[reportUnusedCallResult]
            except Exception:
                pass

        # 若保存到文件，关闭并尝试自动打开
        if f_out is not None:
            try:
                f_out.close()
            except Exception:
                pass
            # 尝试用系统默认播放器打开（Windows）
            try:
                if output_path and os.name == "nt":
                    # Windows 环境：使用系统默认播放器打开生成的音频文件。
                    os.startfile(output_path)
                    print(f"\n语音合成成功，已保存并自动打开：{output_path}")
                else:
                    print(f"\n语音合成成功，已保存：{output_path}")
            except Exception as _e:
                print(f"\n语音合成成功，已保存：{output_path}（自动打开失败：{_e}）")
        else:
            if use_ffplay:
                print("\n语音合成成功（纯流式播放已完成，未保存文件）")
            else:
                print("\n语音合成功能已以流式方式完成下载与消费，但未播放且不保存文件。建议安装 FFmpeg 的 ffplay 以实现边下边播。")
    else:
        # 若非音频类型，流式读取文本内容以便排查问题
        # 说明：部分错误情况下服务可能返回 JSON 或纯文本，打印出来有助于定位问题。
        err_lines: list[str] = []
        for line in response.iter_lines(decode_unicode=True):  # pyright: ignore[reportAny]
            line_str: str = line if isinstance(line, str) else str(line)  # pyright: ignore[reportAny]
            if line_str:
                err_lines.append(line_str)
                if sum(len(x) for x in err_lines) > 4000:
                    break
        err_text = "\n".join(err_lines) if err_lines else response.text
        print("错误响应:", err_text)

except Exception as e:
    # 统一异常捕获与输出
    # 顶层兜底：避免未处理异常导致脚本直接中断，便于在控制台查看问题原因。
    print(f"请求出错: {e}")
```

运行输出示例：

```text
Content-Type: audio/mpeg
已启动 ffplay 进行实时播放（不保存文件），路径：C:\ffmpeg\ffmpeg-master-latest-win64-gpl\bin\ffplay.exe
已下载 0.06 MB...
语音合成成功（纯流式播放已完成，未保存文件）
```

### 可选择音色列表 ​

|  | 序号 | 语言 | Voice ID | 音色名称
|  | 1 | 中文 (普通话) | male-qn-qingse | 青涩青年音色
|  | 2 | 中文 (普通话) | male-qn-jingying | 精英青年音色
|  | 3 | 中文 (普通话) | male-qn-badao | 霸道青年音色
|  | 4 | 中文 (普通话) | male-qn-daxuesheng | 青年大学生音色
|  | 5 | 中文 (普通话) | female-shaonv | 少女音色
|  | 6 | 中文 (普通话) | female-yujie | 御姐音色
|  | 7 | 中文 (普通话) | female-chengshu | 成熟女性音色
|  | 8 | 中文 (普通话) | female-tianmei | 甜美女性音色
|  | 9 | 中文 (普通话) | male-qn-qingse-jingpin | 青涩青年音色-beta
|  | 10 | 中文 (普通话) | male-qn-jingying-jingpin | 精英青年音色-beta
|  | 11 | 中文 (普通话) | male-qn-badao-jingpin | 霸道青年音色-beta
|  | 12 | 中文 (普通话) | male-qn-daxuesheng-jingpin | 青年大学生音色-beta
|  | 13 | 中文 (普通话) | female-shaonv-jingpin | 少女音色-beta
|  | 14 | 中文 (普通话) | female-yujie-jingpin | 御姐音色-beta
|  | 15 | 中文 (普通话) | female-chengshu-jingpin | 成熟女性音色-beta
|  | 16 | 中文 (普通话) | female-tianmei-jingpin | 甜美女性音色-beta
|  | 17 | 中文 (普通话) | clever_boy | 聪明男童
|  | 18 | 中文 (普通话) | cute_boy | 可爱男童
|  | 19 | 中文 (普通话) | lovely_girl | 萌萌女童
|  | 20 | 中文 (普通话) | cartoon_pig | 卡通猪小琪
|  | 21 | 中文 (普通话) | bingjiao_didi | 病娇弟弟
|  | 22 | 中文 (普通话) | junlang_nanyou | 俊朗男友
|  | 23 | 中文 (普通话) | chunzhen_xuedi | 纯真学弟
|  | 24 | 中文 (普通话) | lengdan_xiongzhang | 冷淡学长
|  | 25 | 中文 (普通话) | badao_shaoye | 霸道少爷
|  | 26 | 中文 (普通话) | tianxin_xiaoling | 甜心小玲
|  | 27 | 中文 (普通话) | qiaopi_mengmei | 俏皮萌妹
|  | 28 | 中文 (普通话) | wumei_yujie | 妩媚御姐
|  | 29 | 中文 (普通话) | diadia_xuemei | 嗲嗲学妹
|  | 30 | 中文 (普通话) | danya_xuejie | 淡雅学姐
|  | 31 | 中文 (普通话) | Chinese (Mandarin)_Reliable_Executive | 沉稳高管
|  | 32 | 中文 (普通话) | Chinese (Mandarin)_News_Anchor | 新闻女声
|  | 33 | 中文 (普通话) | Chinese (Mandarin)_Mature_Woman | 傲娇御姐
|  | 34 | 中文 (普通话) | Chinese (Mandarin)_Unrestrained_Young_Man | 不羁青年
|  | 35 | 中文 (普通话) | Arrogant_Miss | 嚣张小姐
|  | 36 | 中文 (普通话) | Robot_Armor | 机械战甲
|  | 37 | 中文 (普通话) | Chinese (Mandarin)_Kind-hearted_Antie | 热心大婶
|  | 38 | 中文 (普通话) | Chinese (Mandarin)_HK_Flight_Attendant | 港普空姐
|  | 39 | 中文 (普通话) | Chinese (Mandarin)_Humorous_Elder | 搞笑大爷
|  | 40 | 中文 (普通话) | Chinese (Mandarin)_Gentleman | 温润男声
|  | 41 | 中文 (普通话) | Chinese (Mandarin)_Warm_Bestie | 温暖闺蜜
|  | 42 | 中文 (普通话) | Chinese (Mandarin)_Male_Announcer | 播报男声
|  | 43 | 中文 (普通话) | Chinese (Mandarin)_Sweet_Lady | 甜美女声
|  | 44 | 中文 (普通话) | Chinese (Mandarin)_Southern_Young_Man | 南方小哥
|  | 45 | 中文 (普通话) | Chinese (Mandarin)_Wise_Women | 阅历姐姐
|  | 46 | 中文 (普通话) | Chinese (Mandarin)_Gentle_Youth | 温润青年
|  | 47 | 中文 (普通话) | Chinese (Mandarin)_Warm_Girl | 温暖少女
|  | 48 | 中文 (普通话) | Chinese (Mandarin)_Kind-hearted_Elder | 花甲奶奶
|  | 49 | 中文 (普通话) | Chinese (Mandarin)_Cute_Spirit | 憨憨萌兽
|  | 50 | 中文 (普通话) | Chinese (Mandarin)_Radio_Host | 电台男主播
|  | 51 | 中文 (普通话) | Chinese (Mandarin)_Lyrical_Voice | 抒情男声
|  | 52 | 中文 (普通话) | Chinese (Mandarin)_Straightforward_Boy | 率真弟弟
|  | 53 | 中文 (普通话) | Chinese (Mandarin)_Sincere_Adult | 真诚青年
|  | 54 | 中文 (普通话) | Chinese (Mandarin)_Gentle_Senior | 温柔学姐
|  | 55 | 中文 (普通话) | Chinese (Mandarin)_Stubborn_Friend | 嘴硬竹马
|  | 56 | 中文 (普通话) | Chinese (Mandarin)_Crisp_Girl | 清脆少女
|  | 57 | 中文 (普通话) | Chinese (Mandarin)_Pure-hearted_Boy | 清澈邻家弟弟
|  | 58 | 中文 (普通话) | Chinese (Mandarin)_Soft_Girl | 软软女孩
|  | 59 | 中文 (粤语) | Cantonese_ProfessionalHost（F) | 专业女主持
|  | 60 | 中文 (粤语) | Cantonese_GentleLady | 温柔女声
|  | 61 | 中文 (粤语) | Cantonese_ProfessionalHost（M) | 专业男主持
|  | 62 | 中文 (粤语) | Cantonese_PlayfulMan | 活泼男声
|  | 63 | 中文 (粤语) | Cantonese_CuteGirl | 可爱女孩
|  | 64 | 中文 (粤语) | Cantonese_KindWoman | 善良女声
|  | 65 | 英文 | Santa_Claus | Santa Claus
|  | 66 | 英文 | Grinch | Grinch
|  | 67 | 英文 | Rudolph | Rudolph
|  | 68 | 英文 | Arnold | Arnold
|  | 69 | 英文 | Charming_Santa | Charming Santa
|  | 70 | 英文 | Charming_Lady | Charming Lady
|  | 71 | 英文 | Sweet_Girl | Sweet Girl
|  | 72 | 英文 | Cute_Elf | Cute Elf
|  | 73 | 英文 | Attractive_Girl | Attractive Girl
|  | 74 | 英文 | Serene_Woman | Serene Woman
|  | 75 | 英文 | English_Trustworthy_Man | Trustworthy Man
|  | 76 | 英文 | English_Graceful_Lady | Graceful Lady
|  | 77 | 英文 | English_Aussie_Bloke | Aussie Bloke
|  | 78 | 英文 | English_Whispering_girl | Whispering girl
|  | 79 | 英文 | English_Diligent_Man | Diligent Man
|  | 80 | 英文 | English_Gentle-voiced_man | Gentle-voiced man
## speech-2.8-hd（高级语音合成接口） ​
基于 MiniMax 最新 speech-2.8-hd 模型的文本转语音接口，支持同步与流式两种输出方式。提供 9 种情绪控制和 19 种语气词标签，支持最多 4 种音色按权重混合，内置声音效果器可调节音高、强度和音色，并可添加回音、电音等音效。同时支持停顿控制、注音替换、LaTeX 公式朗读，覆盖 40+ 语种及方言。
### 模型名称 ​

- speech-2.8-hd
### 请求地址 ​

```
https://www.dmxapi.cn/v1/responses
```

### 示例代码 ​

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
api_key = "sk-******************************************"
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
    "model": "speech-2.8-hd",

    # 【input】(string, 必填) 需要合成语音的文本，长度限制小于 10000 字符，若文本长度大于 3000 字符，推荐使用流式输出
    # 段落切换用换行符标记
    # 停顿控制：支持自定义文本之间的语音时间间隔，以实现自定义文本语音停顿时间的效果。使用方式：在文本中增加<#x#>标记，x 为停顿时长（单位：秒），范围 [0.01, 99.99]，最多保留两位小数。
    #   文本间隔时间需设置在两个可以语音发音的文本之间，不可连续使用多个停顿标记
    # 语气词标签：支持在文本中插入语气词标签。支持的语气词：
    #   (laughs)（笑声）、(chuckle)（轻笑）、(coughs)（咳嗽）、(clear-throat)（清嗓子）、
    #   (groans)（呻吟）、(breath)（正常换气）、(pant)（喘气）、(inhale)（吸气）、(exhale)（呼气）、(gasps)（倒吸气）、(sniffs)（吸鼻子）、
    #   (sighs)（叹气）、(snorts)（喷鼻息）、(burps)（打嗝）、(lip-smacking)（咂嘴）、(humming)（哼唱）、(hissing)（嘶嘶声）、(emm)（嗯）、(sneezes)（喷嚏）
    "input": "欢迎使用DMXAPI",

    "stream": False,# 控制是否流式输出。默认 false，即不开启流式
    "stream_options": {
            # 设置最后一个 chunk 是否包含拼接后的语音 hex 数据。默认值为 False，即最后一个 chunk 中包含拼接后的完整hex 数据
              "exclude_aggregated_audio": False
    },
    "voice_setting": {
        # 【voice_id】(string, 必填) 音色 ID
        # 合成音频的音色编号。若需要设置混合音色，请设置 timbre_weights 参数，本参数设置为空值。
        # 支持系统音色、复刻音色以及文生音色三种类型
        # 可查看 系统音色列表 或使用 查询可用音色 API 查询系统支持的全部音色，详见下方链接
        # 系统音色列表: https://platform.minimaxi.com/docs/faq/system-voice-id
        # 查询可用音色 API: https://platform.minimaxi.com/docs/api-reference/voice-management-get
        "voice_id": "h20260212",

        "speed": 1,# 合成音频的语速，取值越大，语速越快。取值范围 [0.5,2]，默认值为1.0

        "vol": 1,# 合成音频的音量，取值越大，音量越高。取值范围 (0,10]，默认值为 1.0

        "pitch": 0,# 合成音频的语调，取值范围 [-12,12]，默认值为 0，其中 0 为原音色输出

        # 【emotion】(string, 可选) 控制合成语音的情绪
        # 可选值: "happy"(高兴) / "sad"(悲伤) / "angry"(愤怒) / "fearful"(害怕) /
        #         "disgusted"(厌恶) / "surprised"(惊讶) / "calm"(平静) /
        #         "fluent"(生动) / "whisper"(耳语)
        # 模型会根据输入文本自动匹配合适的情绪，一般无需手动指定
        "emotion": "fluent",

        "text_normalization":  False, # 是否启用中文、英语文本规范化，开启后可提升数字阅读场景的性能，但会略微增加延迟，默认值为 false
        # 【latex_read】 控制是否朗读 latex 公式，默认为 false
        #   仅支持中文，开启该参数后，language_boost 参数会被设置为 Chinese
        #   请求中的公式需要在公式的首尾加上 $$
        #   请求中公式若有 "\"，需转义成 "\\".
        "latex_read": False
    },
    "audio_setting": {
        "sample_rate": 32000,# 生成音频的采样率。可选范围[8000，16000，22050，24000，32000，44100]，默认为 32000
        "bitrate": 128000,# 生成音频的比特率。可选范围[32000，64000，128000，256000]，默认值为 128000。该参数仅对 mp3 格式的音频生效
        "format": "mp3", # 生成音频的格式，wav 仅在非流式输出下支持。 可用选项:mp3,pcm,flac,wav
        "channel": 1,# 生成音频的声道数。可选范围：[1,2]，其中 1 为单声道，2 为双声道，默认值为 1

        # 【force_cbr】对于音频恒定比特率（cbr）控制，可选 false、 true。当此参数设置为 true，将以恒定比特率方式进行音频编码。
        # 注意：本参数仅当音频设置为流式输出，且音频格式为 mp3 时生效。
        "force_cbr": False
    },
    "pronunciation_dict": {
        # 【tone】定义需要特殊标注的文字或符号对应的注音或发音替换规则
        # 在中文文本中，声调用数字表示：
        #  一声为 1，二声为 2，三声为 3，四声为 4，轻声为 5
        # 示例: ["燕少飞/(yan4)(shao3)(fei1)", "omg/oh my god"]
        "tone": [
            "处理/(chu3)(li3)",
            "危险/dangerous"
        ]
    },
    "timber_weights":[{
        #【voice_id】合成音频的音色编号，须和weight参数同步填写。
        # 支持系统音色、复刻音色以及文生音色三种类型。
        # 系统支持的全部音色可查看 系统音色列表，也可使用 查询可用音色 API 查询系统支持的全部音色
        #  系统音色列表: https://platform.minimaxi.com/docs/faq/system-voice-id
        #  查询可用音色 API: https://platform.minimaxi.com/docs/api-reference/voice-management-get
        "voice_id":"Jonathan04",

        # 【weight】合成音频各音色所占的权重，须与 voice_id 同步填写
        # 可选值范围为[1, 100]，最多支持 4 种音色混合，单一音色取值占比越高，合成音色与该音色相似度越高.
        "weight":10
    }],
    # 【language_boost】 是否增强对指定的小语种和方言的识别能力。默认值为 null，可设置为 auto 让模型自主判断。
    # 支持的语言:
    #   Chinese, Chinese,Yue, English, Arabic, Russian, Spanish, French, Portuguese,
    #   German, Turkish, Dutch, Ukrainian, Vietnamese, Indonesian, Japanese, Italian,
    #   Korean, Thai, Polish, Romanian, Greek, Czech, Finnish, Hindi, Bulgarian,
    #   Danish, Hebrew, Malay, Persian, Slovak, Swedish, Croatian, Filipino, Hungarian,
    #   Norwegian, Slovenian, Catalan, Nynorsk, Tamil, Afrikaans, auto
    "language_boost":"auto",

    # 【subtitle_enable】控制是否开启字幕服务，默认值为 false
    # 此参数仅在非流式输出场景下有效
    "subtitle_enable": False,

    # 【voice_modify】声音效果器设置，该参数支持的音频格式：非流式：mp3, wav, flac；流式：mp3
    "voice_modify":{
        "pitch": 0,# 音高调整（低沉/明亮），范围 [-100,100]，数值接近 -100，声音更低沉；接近 100，声音更明亮。必填范围: -100 <= x <= 100
        "intensity" : 0,# 强度调整（力量感/柔和），范围 [-100,100]，数值接近 -100，声音更刚劲；接近 100，声音更轻柔。必填范围: -100 <= x <= 100
        "timbre": 0,# 音色调整（磁性/清脆），范围 [-100,100]，数值接近 -100，声音更浑厚；数值接近 100，声音更清脆。必填范围: -100 <= x <= 100

        # 【sound_effects】音效设置，单次仅能选择一种
        # 可选值: "spacious_echo（空旷回音 / auditorium_echo（礼堂广播） / lofi_telephone（电话失真） /robotic（电音）
        "sound_effects": "spacious_echo"
    },
    "subtitle_enable":False,  # 重复字段，同上
    # 【output_format】控制输出结果形式的参数，可选值范围为[url, hex]，默认值为 hex
    # 该参数仅在非流式场景生效，流式场景仅支持返回 hex 形式。返回的 url 有效期为 24 小时
    "output_format":"hex",
    "aigc_watermark":False,# 控制在合成音频的末尾添加音频节奏标识，默认值为 False。该参数仅对非流式合成生效
}

# ═══════════════════════════════════════════════════════════════
# 📤 步骤4: 发送请求并输出结果
# ═══════════════════════════════════════════════════════════════

# 发送 POST 请求到 API 服务器
response = requests.post(url, headers=headers, json=payload)
# 处理响应
if response.status_code == 200:
    result = response.json()
    print("请求成功！")
    # 打印不含音频数据的JSON结构
    import copy
    result_preview = copy.deepcopy(result)
    if "data" in result_preview and "audio" in result_preview["data"]:
        result_preview["data"]["audio"] = f"[hex数据, 长度: {len(result['data']['audio'])} 字符]"
    print("原始JSON返回内容:", result_preview)

    # 如果返回了音频数据，保存为文件
    if "data" in result and "audio" in result["data"]:
        audio_data = result["data"]["audio"]
        # 解码hex编码的音频数据并保存
        audio_bytes = bytes.fromhex(audio_data)
        with open("output.mp3", "wb") as f:
            f.write(audio_bytes)
        print("音频已保存为 output.mp3")
    else:
        print("响应内容:", result)
else:
    print(f"请求失败，状态码: {response.status_code}")
    print("错误信息:", response.text)
```

### 返回示例 ​

```json
请求成功！
原始JSON返回内容: {'data': {'audio': '[hex数据, 长度: 69096 字符]', 'status': 2}, 'trace_id': '05dd2113bc65d614d53af98b1818ad79', 'extra_info': {'audio_length': 2052, 'audio_sample_rate': 32000, 'audio_size': 34548, 'bitrate': 128000, 'word_count': 10, 'invisible_character_ratio': 0, 'usage_characters': 14, 'audio_channel': 1, 'audio_format': 'mp3'}, 'base_resp': {'status_code': 0, 'status_msg': 'success'}, 'usage': {'total_tokens': 14, 'input_tokens': 0, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens': 14, 'output_tokens_details': {'reasoning_tokens': 0}}}
音频已保存为 output.mp3
```

© 2026 DMXAPI MiniMax speech 系列语音合成
