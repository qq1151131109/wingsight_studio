"""摄影机/镜头档案库（移植自 tigerowo/infinite-canvas 的 camera profiles，精编）。

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

LIGHT_HINTS = [
    "伦勃朗光（侧面高光+三角亮区）",
    "顶光剪影",
    "冷暖对比布光（青橙调）",
    "柔和窗光",
    "霓虹环境反射",
    "雾气漫射体积光",
]


def camera_cheat_sheet() -> str:
    """给主 agent 系统提示的速查文本。"""
    lines = ["可用摄影质感短语（出图时拼进资产的视觉描述里，让设定图更有电影感）："]
    for name, p in CAMERA_PROFILES.items():
        lines.append(f"- {name}：{p['look']}（镜头：{'/'.join(p['lenses'])}）")
    lines.append("镜头语汇：" + "；".join(f"{k}={v}" for k, v in LENS_HINTS.items()))
    lines.append("布光语汇：" + "；".join(LIGHT_HINTS))
    return "\n".join(lines)
