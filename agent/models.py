"""图像模型目录：出图模型/分辨率切换的唯一事实源。

全部条目经 DMX 网关真实探针验证（2026-08-31，lfx generate_image 的
OpenAI images 调用形态）：images/generations 与 images/edits（参考图
路径）双通才收录。档位按 flow 真实计算尺寸探验（_ROUND_TO=16 网格：
16:9 1K/2K/4K = 2048x1152 / 2560x1440 / 3840x2160）：

- gpt-image-2-03：1K/2K/4K 全档通
- doubao-seedream-4-0：1K/2K/4K 全档通（上游单图上限 16777216 px，
  最大档 3840x2160=8.3M 未超）
- doubao-seedream-4-5：有最小像素约束（≥3686400 px）1K 档全灭、
  4:3 幅面 2K 档（1920x1440=2.76M）也不够——16:9 幅面 2K 档恰好
  3686400 压线通过；收 2K/4K，方图/4:3 等显式窄幅画幅用此模型请选 4K
  （资产设定图默认已是 16:9，不受此限）
- 未收录（images 接口）：qwen-image 系 / seedream-5.0-lite / z-image / wan（404）
- gemini-3.1-flash-image：DMX 走 v1beta generateContent 出图（Nano Banana 2，
  认证 x-goog-api-key——Authorization Bearer 会挂起），flow 侧
  _GEMINI_MODEL_PREFIXES 分流到 generate_image_gemini 原语；幅面/分辨率由
  imageConfig 接口参数精确控制（14 种比例 × 1K/2K/4K）

doubao-seedream-5-0-pro 走 /v1/responses 多图融合接口（2~10 参考图
融合成一张，flow 组件按模型名前缀分流，见 asset-imagegen.json 的
generate_image_responses）：参考图上限 10 张、size 显式像素上限
4194304，1K/2K 档显式尺寸全幅面通过、4K 超上限不开放。

参考图上限（max_references）：seedream-5-0-pro 的 2~10 张融合是实测；
其余模型走 images/edits 通道未做张数探针，按保守值 4 收录（超限探明后
直接改这里）。上限由调用方（画布桥接层）按所选模型校验明报，flow 组件
的 reference_count 由 skills 按实际张数注入，不再吃组件默认 3 的截断。

画幅（aspects）：flow 的 compute_image_size 接受任意 w:h（16 像素网格、
短边对齐档位），目录只收主流 6 档（分镜卡 ShotGenSettings 同款）；
seedream-5-0-pro 例外——responses 通道显式像素上限 4194304，21:9 2K
（3360x1440=4.84M）超限，枚举不做按档位组合、整档不收录。seedream-4-5
的最小像素约束（≥3686400）按档位收窄过 resolutions，幅面组合级（如
1:1 2K=2.07M 不够）仍由 flow/上游报错点名，不在目录复制一份像素数学。

这里只做目录与校验；调用拼装在 skills（tweaks 注入 model_name /
resolution / reference_count 到 imagegen flow 的 BatchAssetSheet-img02 组件）。
"""

import re
from typing import Any, Dict, List, Optional

DEFAULT_MODEL_ID = "gpt-image-2-03"

# 通用画幅枚举（分镜卡 ShotGenSettings 同款 6 档）；例外条目单独覆写
DEFAULT_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]

IMAGE_MODELS: List[Dict[str, Any]] = [
    {
        "id": "gpt-image-2-03",
        "label": "GPT Image 2",
        "tag": "均衡默认 · 参考图一致性好 · 1K/2K/4K",
        "resolutions": ["1K", "2K", "4K"],
        "aspects": DEFAULT_ASPECTS,
        "default_resolution": "2K",
        "recommended": True,
        "max_references": 4,
    },
    {
        "id": "gemini-3.1-flash-image",
        "label": "Gemini 3.1 Flash Image",
        "tag": "谷歌系 Nano Banana 2 · 幅面/分辨率接口级精确 · 1K/2K/4K",
        "resolutions": ["1K", "2K", "4K"],
        "aspects": DEFAULT_ASPECTS,
        "default_resolution": "1K",
        "max_references": 4,
    },
    {
        "id": "doubao-seedream-4-0-250828",
        "label": "Seedream 4.0",
        "tag": "中文影视审美强 · 支持参考图 · 1K/2K/4K",
        "resolutions": ["1K", "2K", "4K"],
        # 2:1 全景幅面（2026-09-04 探针实测：2K 2880x1440 / 4K 4320x2160，
        # 输出严格 2:1，见 doc/image-panorama-spec.md）
        "aspects": DEFAULT_ASPECTS + ["2:1"],
        "default_resolution": "1K",
        "max_references": 4,
    },
    {
        "id": "doubao-seedream-4-5-251128",
        "label": "Seedream 4.5",
        "tag": "旗舰画质 · 2K/4K（方图与 4:3 幅面需 4K）",
        "resolutions": ["2K", "4K"],
        # 2:1 全景幅面（2026-09-03 2K 探通；2026-09-04 4K 4320x2160 严格 2:1）
        "aspects": DEFAULT_ASPECTS + ["2:1"],
        "default_resolution": "2K",
        "max_references": 4,
    },
    {
        "id": "doubao-seedream-5-0-pro-260628",
        "label": "Seedream 5.0 Pro",
        "tag": "多图融合 · 最多 10 张参考图合成 · 1K/2K",
        "resolutions": ["1K", "2K"],
        # responses 通道显式像素上限：21:9 全档超限，不收录；2:1 全景
        # （2026-09-04 探针：1K 2048x1024 / 2K 2880x1440 均严格 2:1 且在限内）
        "aspects": ["16:9", "9:16", "1:1", "4:3", "3:4", "2:1"],
        "default_resolution": "1K",
        "max_references": 10,
    },
]

# ---------- 文本模型目录（剧本/分镜表/拆解/提示词优化等 LLM 文字生成） ----------
# 平台化多目录（2026-09-01 探针验证 + 平台化根治），每条目 provider
# 字段 = langflow 的一等命名平台（langflow/src/bundles/platforms/ 扩展包声明，
# 加平台见 bundles/platforms/README.md）：
# - BigModel = 智谱官方（BIGMODEL_BASE_URL/BIGMODEL_API_KEY 全局变量）
#   → glm-5.3-flash / glm-5.3
# - DeepSeek = DeepSeek 官方 API（DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY，
#   2026-09-07 起指向 api.deepseek.com——此前种子曾指向智谱 coding 网关，
#   而该网关只有 glm 系模型，DeepSeek 平台一用就 500「modelCode 不存在」）
#   → deepseek-v4-flash / v4-pro / v4-flash-vision-exp
# - DMX = DMXAPI 聚合网关（DMX_BASE_URL/DMX_API_KEY）
#   → gpt-5.6-luna / gemini-3.7-flash / claude-sonnet-5
# 注入方式：调用侧经 text_model_tweaks() 同时注 model_name + provider
# （按组件名 tweaks，不走节点 id，重建不失效）。旧 "OpenAI"/
# "OpenAI Compatible" 劫持命名已下线（连带 langflow 旧全局变量删除）。

DEFAULT_TEXT_MODEL_ID = "gpt-5.6-luna"

TEXT_MODELS: List[Dict[str, Any]] = [
    {
        "id": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "tag": "快 · 多模态 · 智谱官方",
        "provider": "BigModel",
    },
    {
        "id": "glm-5.3",
        "label": "GLM 5.3",
        "tag": "强推理 · 质量优先 · 智谱官方",
        "provider": "BigModel",
    },
    {
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "tag": "快 · 便宜 · DeepSeek V4 官方",
        "provider": "DeepSeek",
    },
    {
        "id": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro",
        "tag": "深推理 · 质量档 · DeepSeek V4 官方",
        "provider": "DeepSeek",
    },
    {
        "id": "deepseek-v4-flash-vision-exp",
        "label": "DeepSeek V4 Flash Vision",
        "tag": "多模态 · 看图 · DeepSeek V4 官方",
        "provider": "DeepSeek",
    },
    {
        "id": "gpt-5.6-luna",
        "label": "GPT 5.6 Luna",
        "tag": "分镜/剧本默认 · 创意文案 · DMX",
        "provider": "DMX",
        "recommended": True,
    },
    {
        "id": "gemini-3.7-flash",
        "label": "Gemini 3.7 Flash",
        "tag": "长上下文 · DMX",
        "provider": "DMX",
    },
    {
        "id": "claude-sonnet-5",
        "label": "Claude Sonnet 5",
        "tag": "写作质量 · DMX",
        "provider": "DMX",
    },
]


def text_model_tweaks(model_id: Optional[str]) -> Dict[str, Any]:
    """文本模型覆盖 tweaks：同时注 model_name 与 provider（通道路由）。

    键用逻辑组件名 LanguageModelComponent，由 run_flow_blocking 解析成
    真实节点 id（直接透传会静默空转）。空 id → {}（调用方应先落目录默认）。"""
    if not model_id:
        return {}
    entry = find_text_model(model_id)
    if entry and entry.get("provider"):
        return {"model_name": model_id, "provider": entry["provider"]}
    return {"model_name": model_id}



def text_models_payload() -> List[Dict[str, Any]]:
    """GET /models/text 的响应体（前端文本模型选择直接渲染）。"""
    return TEXT_MODELS


def find_text_model(model_id: str) -> Optional[Dict[str, Any]]:
    return next((m for m in TEXT_MODELS if m["id"] == model_id), None)


def resolve_text_model(raw: Any) -> Optional[str]:
    """校验调用方传来的文本模型（字符串，可空）。

    空/缺省 → None（调用方一律以 `or DEFAULT_TEXT_MODEL_ID` 落到目录默认
    gpt-5.6-luna 再注入——全站 LLM 默认模型，flow 出厂值不再参与）；
    合法 → 模型 id（tweaks 的 model_name 直接可用）；不合法 → ValueError
    端点转 400 中文报错，绝不静默回退（与出图同一铁律）。
    """
    model = str(raw or "").strip()
    if not model:
        return None
    if find_text_model(model) is None:
        known = " / ".join(m["id"] for m in TEXT_MODELS)
        raise ValueError(f"未知文本模型：{model}（可用：{known}）")
    return model


# ---------- 视频模型目录（BigModel/智谱 CogVideoX 系，2026-09-07 实探验证） ----------
# 供应商选型实录（探针留档，勿凭印象改供应商）：
# - DMX /v1/videos：海螺系提交+轮询通、但产物取件链坏——/videos/{id}/content 与
#   /tasks/{id}/artifacts 双面均 artifact_gone/404（完成即刻也取不到，2026-09-07
#   五连探针实锤）；wan/kling/vidu 适配器 fail_to_fetch_task；seedance/sora 无渠道
# - 火山方舟 ark 直连：REST 契约已从 juben 后端验证（contents/generations/tasks），
#   但手头 ark key 未开通 seedance（ModelNotOpen）——开通后可按 juben 范式接
# - BigModel 官方 paas 路径（open.bigmodel.cn/api/paas/v4/videos/generations）：
#   coding 套餐 key 即可用，flash 免费档 + cogvideox-3 付费档双通（base64 图生
#   视频、async-result 轮询、URL 可下载，mp4/h264、v3 带 AAC 音轨全验证）
# cogvideox-3：文生/图生（image_url 单图或 [首帧,尾帧] 数组）·5/10s·30/60fps·
#   speed/quality 双档·with_audio AI 音效·至高 4K；i2v 不传 size 时按原图比例
#   自适配（短边 1080）——分镜图生视频默认走这条免传 size
# cogvideox-flash：免费·图生视频（单图）·无时长/音效参数（固定 ~5s 无音轨）

DEFAULT_VIDEO_MODEL_ID = "cogvideox-flash"

VIDEO_MODELS: List[Dict[str, Any]] = [
    {
        "id": "cogvideox-flash",
        "label": "CogVideoX Flash",
        "tag": "免费档 · 图生视频 · 固定约5秒 · 无音轨",
        "sizes": [
            "720x480", "1024x1024", "1280x960", "960x1280",
            "1920x1080", "1080x1920", "2048x1080", "3840x2160",
        ],
        "durations": [],
        "default": True,
    },
    {
        "id": "cogvideox-3",
        "label": "CogVideoX 3",
        "tag": "质量档 · 图生/文生/首尾帧 · 5或10秒 · 可带AI音效",
        "sizes": [
            "1280x720", "720x1280", "1024x1024",
            "1920x1080", "1080x1920", "2048x1080", "3840x2160",
        ],
        "durations": [5, 10],
        "qualities": ["speed", "quality"],
        "with_audio": True,
    },
]


def video_models_payload() -> List[Dict[str, Any]]:
    """GET /models/video 的响应体（前端视频生成设置直接渲染）。"""
    return VIDEO_MODELS


def find_video_model(model_id: str) -> Optional[Dict[str, Any]]:
    return next((m for m in VIDEO_MODELS if m["id"] == model_id), None)


def resolve_video_params(raw: Any) -> Optional[Dict[str, Any]]:
    """校验视频生成参数（{model?, size?, duration?, quality?, with_audio?, fps?}）。

    缺省/空对象 → None（全默认：flash 模型 + size 不传按原图比例自适配）；
    不合法 → ValueError（端点转 400 中文点名，与出图同一铁律：选了不支持的
    组合必须让用户知道，绝不静默换参数出视频）。
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("params 必须是对象（{model?, size?, duration?, quality?, with_audio?}）")
    model = str(raw.get("model") or "").strip()
    if not model:
        return None
    entry = find_video_model(model)
    if entry is None:
        known = " / ".join(m["id"] for m in VIDEO_MODELS)
        raise ValueError(f"未知视频模型：{model}（可用：{known}）")
    out: Dict[str, Any] = {"model_name": model}
    size = str(raw.get("size") or "").strip()
    if size:
        if size not in entry["sizes"]:
            raise ValueError(
                f"{entry['label']} 不支持尺寸 {size}（支持：{'/'.join(entry['sizes'])}）"
            )
        out["size"] = size
    durations = entry.get("durations") or []
    dur = raw.get("duration")
    if dur is not None and str(dur).strip():
        try:
            d = int(dur)
        except (TypeError, ValueError):
            raise ValueError(f"时长不合法：{dur}（应为整数秒）")
        if d not in durations:
            hint = "/".join(str(x) for x in durations) if durations else "该模型不支持指定时长"
            raise ValueError(f"{entry['label']} 不支持 {d} 秒（支持：{hint}）")
        out["duration"] = d
    qualities = entry.get("qualities") or []
    quality = str(raw.get("quality") or "").strip()
    if quality:
        if quality not in qualities:
            hint = "/".join(qualities) if qualities else "该模型不支持质量档"
            raise ValueError(f"{entry['label']} 不支持质量档 {quality}（支持：{hint}）")
        out["quality"] = quality
    if raw.get("with_audio") is not None:
        if not entry.get("with_audio"):
            raise ValueError(f"{entry['label']} 不支持 AI 音效")
        out["with_audio"] = bool(raw.get("with_audio"))
    fps = raw.get("fps")
    if fps is not None and str(fps).strip():
        if int(fps) not in (30, 60):
            raise ValueError(f"帧率不合法：{fps}（支持 30/60）")
        out["fps"] = int(fps)
    return out


def image_models_payload() -> List[Dict[str, Any]]:
    """GET /models/image 的响应体（前端出图设置面板直接渲染）。"""
    return IMAGE_MODELS


def find_model(model_id: str) -> Optional[Dict[str, Any]]:
    return next((m for m in IMAGE_MODELS if m["id"] == model_id), None)


def resolve_imagegen_params(raw: Any) -> Optional[Dict[str, str]]:
    """校验调用方传来的出图参数（{model?, resolution?}）。

    合法 → {"model_name": id, "resolution": 档位}（tweaks 直接可用）；
    缺省/空对象 → None（全默认，不注参数）；不合法 → ValueError，
    端点转 400 中文报错，绝不静默回退默认（用户选了不支持的组合
    必须让他知道，而不是悄悄换模型出图）。
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("params 必须是对象（{model?, resolution?}）")
    model = str(raw.get("model") or "").strip()
    resolution = str(raw.get("resolution") or "").strip()
    if not model and not resolution:
        return None
    if model:
        entry = find_model(model)
        if entry is None:
            known = " / ".join(m["id"] for m in IMAGE_MODELS)
            raise ValueError(f"未知出图模型：{model}（可用：{known}）")
    else:
        entry = find_model(DEFAULT_MODEL_ID)
    assert entry is not None
    res = resolution or str(entry["default_resolution"])
    if res not in entry["resolutions"]:
        raise ValueError(
            f"{entry['label']} 不支持 {res} 档（支持：{'/'.join(entry['resolutions'])}）"
        )
    return {"model_name": entry["id"], "resolution": res}


def resolve_aspect(raw: Any, model_id: str) -> Optional[str]:
    """校验画幅覆写（w:h 字符串，可空；请求级缺省 + 镜头级覆盖由调用方合并）。

    空 → None（自动：flow 按资产类型默认幅面——资产设定图一律横版 16:9；
    带参考图的直连出图由前端吸附参考图比例后传具体值，但设定图语义
    ——资产卡本尊/Look 卡——不吸附，恒走 16:9）；格式不对或
    模型不支持 → ValueError，端点转 400 中文报错，绝不静默回退（与模型/
    档位同一铁律）。幅面×档位像素组合级约束（seedream-4-5 最小像素等）
    不在这里复制 flow 的像素数学，仍由 flow/上游报错点名。"""
    aspect = str(raw or "").strip()
    if not aspect:
        return None
    if not re.fullmatch(r"\d{1,2}:\d{1,2}", aspect):
        raise ValueError(f"画幅不合法：{aspect}（应为 w:h，如 16:9 / 9:16）")
    entry = find_model(model_id)
    if entry is not None and aspect not in entry["aspects"]:
        raise ValueError(
            f"{entry['label']} 不支持 {aspect} 画幅（支持：{'/'.join(entry['aspects'])}）"
        )
    return aspect
