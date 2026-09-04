"""摄影机/镜头/布光档案库（机身部分移植自 tigerowo/infinite-canvas 的 camera
profiles，精编；布光预设融合 open-storyboard LightingControlPanel 八预设与
juben 布光语汇，2026-09-04 起结构化为单一事实源——打光弹窗、导演台布光区、
主 agent 速查表三处同源消费）。

供出图提示词拼装：在资产 visual_notes 或描述中引用这些短语，
让生成图带上电影摄影质感。
"""

CAMERA_PROFILES = {
    "ARRI Alexa 35": {
        "look": "ARRI Alexa 35 数字电影机质感，肤色还原自然，高光柔和过渡",
        "lenses": ["35mm", "50mm", "85mm"],
    },
    "RED Komodo": {
        "look": "RED 数字电影感，高锐度，宽动态范围",
        "lenses": ["24mm", "50mm"],
    },
    "Sony Venice": {
        "look": "Sony Venice 电影感，暖调高光，暗部干净",
        "lenses": ["35mm", "85mm"],
    },
    "Panavision Millennium DXL": {
        "look": "Panavision 经典电影质感",
        "lenses": ["40mm anamorphic", "75mm anamorphic"],
    },
    "Kodak Vision3 500T": {
        "look": "柯达 500T 胶片颗粒，夜景色调青绿偏移，霓虹晕染",
        "lenses": ["35mm", "50mm"],
    },
    "Fujifilm Eterna": {
        "look": "富士 Eterna 胶片低饱和柔和色调",
        "lenses": ["35mm", "85mm"],
    },
}

LENS_HINTS = {
    "24mm": "广角环境交代，空间纵深感",
    "35mm": "标准叙事视角，环境与人物均衡",
    "50mm": "接近人眼，自然专注",
    "85mm": "浅景深人像特写，背景奶油虚化",
    "anamorphic": "宽银幕变形镜头，水平蓝色光斑，椭圆形焦外",
}

LIGHT_PRESETS = [
    {
        "id": "rembrandt",
        "name": "伦勃朗光",
        "prompt": "伦勃朗光：45 度侧主光，明暗对比强，脸颊出现三角亮区，古典肖像画式阴影",
    },
    {
        "id": "goldenHour",
        "name": "黄金时刻",
        "prompt": "黄金时刻暖阳：低角度金色斜射光，柔和光斑与轻微眩光，温暖魔幻氛围",
    },
    {
        "id": "cyberpunk",
        "name": "赛博朋克霓虹",
        "prompt": "赛博朋克光：品红与青蓝双色霓虹，合成发光感，未来都市夜景氛围",
    },
    {
        "id": "sunset",
        "name": "落日逆光",
        "prompt": "落日逆光：暖色轮廓光，主体边缘发亮，长影子，柯达彩色胶片色调",
    },
    {
        "id": "blueBacklight",
        "name": "冷蓝逆光",
        "prompt": "冷蓝逆光：蓝色轮廓光，低色温冷调，剪影带彩色边缘，空灵氛围",
    },
    {
        "id": "mysterious",
        "name": "神秘暗调",
        "prompt": "低调黑色电影光：大面积深阴影，单点光源，高对比，悬疑氛围",
    },
    {
        "id": "overexposed",
        "name": "高调过曝",
        "prompt": "高调过曝胶片感：亮部溢出，柔光散射，整体明亮通透，复古胶片质感",
    },
    {
        "id": "nolanGrey",
        "name": "诺兰冷灰",
        "prompt": "诺兰式冷灰调：去饱和冷色板，青灰调色，IMAX 质感的大画幅摄影",
    },
    {
        "id": "window",
        "name": "柔和窗光",
        "prompt": "柔和窗光：大面积柔化的自然侧光，浅影调过渡，日间生活质感",
    },
    {
        "id": "volume",
        "name": "雾气体积光",
        "prompt": "雾气漫射体积光：光束穿透尘雾，空气透视，层次纵深感",
    },
    {
        "id": "topSilhouette",
        "name": "顶光剪影",
        "prompt": "顶光剪影：正上方硬光源，肩头与头部亮边，面部沉入阴影",
    },
    {
        "id": "rainNeon",
        "name": "雨夜霓虹",
        "prompt": "雨夜霓虹：湿面反射，霓虹点彩光斑，青橙混合夜色",
    },
]

# 兼容旧消费方的扁平视图（导演台多选 chips / 速查表）
LIGHT_HINTS = [p["name"] for p in LIGHT_PRESETS]

LIGHT_PROMPT_BY_NAME = {p["name"]: p["prompt"] for p in LIGHT_PRESETS}


def camera_cheat_sheet() -> str:
    """给主 agent 系统提示的速查文本。"""
    lines = ["可用摄影质感短语（出图时拼进资产的视觉描述里，让设定图更有电影感）："]
    for name, p in CAMERA_PROFILES.items():
        lines.append(f"- {name}：{p['look']}（镜头：{'/'.join(p['lenses'])}）")
    lines.append("镜头语汇：" + "；".join(f"{k}={v}" for k, v in LENS_HINTS.items()))
    lines.append("布光语汇：" + "；".join(LIGHT_HINTS))
    return "\n".join(lines)
