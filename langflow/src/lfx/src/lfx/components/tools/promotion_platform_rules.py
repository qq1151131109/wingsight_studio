"""宣发平台规则组件：按平台/形态/批次输出当前组合的写作规则与正例。

移植自 Wingsight（juben）``lib/promotion_copywriter/prompts.py`` 的动态拼装
逻辑：每次只注入当前平台的 spec、朋友圈 form 细则、批次约束和该组合下的
正例，避免四平台全量塞入让模型自己挑段落。
"""

from __future__ import annotations

from lfx.custom.custom_component.component import Component
from lfx.io import DropdownInput, Output
from lfx.schema.message import Message

PLATFORM_NAMES: dict[str, str] = {
    "douyin": "抖音",
    "channels": "视频号",
    "weibo": "微博",
    "moments": "朋友圈",
}

PLATFORM_SPECS: dict[str, str] = {
    "douyin": (
        "信息流折叠文案：一句钩子成文，话题另起一行；确需补充最多再加 1 句。"
        "首句 ≤25 字（折叠线内抓人），正文（去话题）≤55 字，话题 ≤5 个、单井号格式（#话题）。"
        "文案与话题都不得出现播出平台名（爱奇艺/腾讯视频等，会被限流），"
        "捷报数据换“全网热播/热度攀升”等说法。结尾不用带链接。"
        "节点先亮片名再给钩子。不要职务 credits，不要把分集通稿塞进首行。表情可省，钩子够狠就不要堆。"
    ),
    "channels": (
        "一句钩子成文，确需补充最多再加 1 句。"
        "首句 ≤25 字，正文 ≤55 字，话题 ≤5 个单井号。文案与话题不出现其他平台名。"
        "节点把身份和钩子压进一两行。不要「出品人/导演 + 人名」开场。"
    ),
    "weibo": (
        "信息量可以更大、要有可讨论性：有效话题 ≤3 个、双井号格式（#话题#，首行片名话题 #片名#），"
        "结尾带播出平台与日期信息（如“8月13日起爱奇艺独播”）。"
        "可以稍长，但仍是一个点写完：列举 token 只服务这一个钩子，不要把核心看点逐条换行粘贴。"
        "默认不用表情。需要点情绪时最多 1 个，不要每条都堆，不要刷屏。"
        "节点先亮片名或出品机构，不要写成「#片名# 出品人某某」。收尾行逐条换写法。"
    ),
    "moments": (
        "转发裂变场景。首行亮身份（#片名# + 属性或一句钩子），"
        "末行给收看路径（平台名 + 【短链接】）。主创名单不进四行开场。"
        "表情按口吻：转发、轻松可以向在行首或收看行用一枚平台 emoji（爱奇艺🥝 / 腾讯视频🐧 / 优酷👖）；"
        "刑侦、品牌、对合作方，钩子够就不要堆。一组里带和不带都可以，不要每条行首都贴 💪🔥❤️。"
    ),
}

FORM_SPECS: dict[str, str] = {
    "short": (
        "四行文案形态（不折叠，最多 6 行含短链接与话题行）：每行短句，第一行亮身份"
        "（#片名 + 一句钩子；禁止出品人/导演+人名），"
        "中间 2-3 行把同一个钩子写具体，不要一行一个互不相关的剧情点，"
        "末行收看路径：平台名 +【短链接】；需要辨认平台时可用 🥝爱奇艺 / 🐧腾讯 / 👖优酷，不是每条都要带。"
        "像朋友转发时配的话，不像官方通稿。表情可有可无，不要为凑模板硬加。"
    ),
    "long": (
        "长文案形态（面向平台方/合作方，3 段以内）：第一段我是谁——出品机构或片名+"
        "档期平台；第二段只展开一个看点；第三段行动号召+【短链接】。"
        "段首 emoji 可有可无：轻松向再用 ❤️👉📱，对合作方或硬核题材不要整段贴表情。"
        "禁止“刷屏预警！”式空喊开头，禁止「#片名 出品人某某」开场。"
    ),
}

BATCH_CONSTRAINTS: dict[str, str] = {
    "daily": (
        "日常批次：第一句就是钩子（场面、台词、数字、反差），不要「即将上线」铺垫，不要职务名单当钩子。"
        "没有开播日期、也没有热度数字的热播，按日常写。行数按本平台规则写。"
    ),
    "milestone": (
        "节点批次：先让人知道是什么片。"
        "不要「出品人/导演 + 人名」开场，不要搬分集通稿。"
        "不要拿整部剧情填空。行数、表情、收看路径按本平台规则写。"
    ),
}

# 正例来源：juben 账号发布模版截图与实投干净化版本；学结构与语感，事实换成当前资料。
FEW_SHOTS: tuple[dict[str, str], ...] = (
    {
        "platform": "douyin",
        "form": "",
        "batch_kind": "daily",
        "label": "一句戏当钩子",
        "body": "命案目击者接受警察问询，崩溃边缘展示超绝记忆力\n#终于等到悬案王传凯出场了 #剧集悬案 #曾美慧孜",
        "lesson": "钩子是场面词，零介绍。",
    },
    {
        "platform": "douyin",
        "form": "",
        "batch_kind": "daily",
        "label": "台词直接上台",
        "body": "王妃：在下略懂一些刀法，什么刀你别管\n#御赐小仵作2开播 #御赐小仵作2 #苏晓彤",
        "lesson": "原话够狠就一句成文，不要再解释人物背景。",
    },
    {
        "platform": "douyin",
        "form": "",
        "batch_kind": "daily",
        "label": "一句场面",
        "body": "萧北冥一进门，桌上那份卷宗还没拆\n#定风波 #悬疑",
        "lesson": "追更就写这一下，不要复述场面撑条。",
    },
    {
        "platform": "douyin",
        "form": "",
        "batch_kind": "milestone",
        "label": "卖片种不复述剧情",
        "body": "#入局开播 卧底大案层层反转\n最强烧脑，谁是终极boss\n#入局 #悬疑",
        "lesson": "卖为什么点进去，不写成某某是卧底。",
    },
    {
        "platform": "weibo",
        "form": "",
        "batch_kind": "milestone",
        "label": "捷报数字当新闻",
        "body": "【师弟播报】恭喜 #剧集南部档案# 爱奇艺热度峰值达 9303！\n开播后第一次站上这个数\n锁定正在热播！",
        "lesson": "捷报数据放开头；有效话题只有片名一个。",
    },
    {
        "platform": "weibo",
        "form": "",
        "batch_kind": "milestone",
        "label": "身份 + 一个点 + 收看",
        "body": "#迟到27年的无罪判决#\n等了 9778 天，从死缓等到无罪。\n8月26日爱奇艺独家播出",
        "lesson": "有数字就让数字当钩子，卡里没有的身份不要加。",
    },
    {
        "platform": "weibo",
        "form": "",
        "batch_kind": "milestone",
        "label": "只抛悬念",
        "body": "#双面棋#\n越查越不像自己人。看到最后才知道，谁才是那个boss。\n即将上线",
        "lesson": "留问题就停，人名不出现。",
    },
    {
        "platform": "weibo",
        "form": "",
        "batch_kind": "daily",
        "label": "一个场面写完",
        "body": "#御赐小仵作2开播#\n王妃：在下略懂一些刀法，什么刀你别管\n正在播出",
        "lesson": "一个场面或一句原话写完，不套定档骨架。",
    },
    {
        "platform": "moments",
        "form": "short",
        "batch_kind": "milestone",
        "label": "身份 + 一个点 + 收看",
        "body": "#华夏风云人物·南宋篇开播\n翼视界出品，AI 重现岳飞一生\n爱奇艺首播，锁定观看！",
        "lesson": "四行是身份、一个点、收看；出品写机构品牌。",
    },
    {
        "platform": "moments",
        "form": "short",
        "batch_kind": "milestone",
        "label": "IP 属性先行",
        "body": "#迟到27年的无罪判决\n9778天，从死缓等到无罪\n🥝8月26日爱奇艺独家播出【短链接】",
        "lesson": "中间只写这一个点，转发向可带平台 emoji。",
    },
    {
        "platform": "moments",
        "form": "short",
        "batch_kind": "milestone",
        "label": "转发向卖观感",
        "body": "#夜线开播\n卧底进局，层层反转\n最强烧脑，看到最后才知道谁是boss\n【播出平台】【短链接】",
        "lesson": "中间两行是观感，不要一行一个剧情点。",
    },
    {
        "platform": "moments",
        "form": "short",
        "batch_kind": "daily",
        "label": "日常一个场面",
        "body": "#御赐小仵作2# 开播\n王妃那句「什么刀你别管」，刀还没亮\n正在热播【短链接】",
        "lesson": "中间只展开这一个场面，热播无数据按日常写。",
    },
    {
        "platform": "moments",
        "form": "long",
        "batch_kind": "milestone",
        "label": "身份 + 一个体验 + 行动",
        "body": (
            "8月3日由山西博物院、央视视频、北京翼视界文化传媒联合出品的AR沉浸式互动#晋游记 已正式开启！\n"
            "让文物活起来、让历史走到身边，以参与者身份走进晋国风云，边玩边学。\n"
            "诚邀热爱历史文化的你，来山西博物院线下，一起共赴这场穿越千年的探索。"
        ),
        "lesson": "长文三段——出品机构第一段，第二段只展开一个体验，第三段行动号召。",
    },
    {
        "platform": "moments",
        "form": "long",
        "batch_kind": "milestone",
        "label": "卖体验不剧透",
        "body": (
            "小河文化出品的#夹缝#开播了。\n"
            "今年最能熬的一部：卧底进局，层层反转，看到最后才知道谁是boss。\n"
            "去【播出平台】看：【短链接】"
        ),
        "lesson": "第二段写看下去的理由，不复述谁干了什么。",
    },
)


def select_few_shots(platform: str, form: str, batch_kind: str) -> tuple[dict[str, str], ...]:
    """按平台/形态/批次筛选正例；视频号复用抖音正例（juben 同款别名规则）。

    ``form="both"``（仅朋友圈）返回 short 与 long 两组正例，short 在前。
    """
    key = "douyin" if platform == "channels" else platform
    if platform == "moments":
        forms = ("short", "long") if form == "both" else (form,)
        return tuple(
            shot
            for shot in FEW_SHOTS
            if shot["platform"] == key and shot["batch_kind"] == batch_kind and shot["form"] in forms
        )
    return tuple(shot for shot in FEW_SHOTS if shot["platform"] == key and shot["batch_kind"] == batch_kind)


_FORM_LABELS = {"short": "四行", "long": "长文"}


def build_rules_text(platform: str, form: str, batch_kind: str) -> str:
    """拼装当前组合的规则文本：平台 spec + form 细则 + 批次约束 + 正例。"""
    if platform not in PLATFORM_SPECS:
        msg = f"不支持的平台：{platform}（可选 douyin / channels / weibo / moments）"
        raise ValueError(msg)

    spec = PLATFORM_SPECS[platform]
    form_line = ""
    output_extra = ""
    if platform == "moments":
        if form == "both":
            spec = f"{spec}\n\n【short 形态】{FORM_SPECS['short']}\n\n【long 形态】{FORM_SPECS['long']}"
            form_line = "；形态：both（四行 + 长文，两种都要）"
            output_extra = (
                "\n\n# 输出要求补充\n\n先给 short（四行）形态，再给 long（长文）形态，"
                "两种形态数量相同、变体编号连续，钩子互不重复。"
            )
        elif form in FORM_SPECS:
            spec = f"{spec}\n\n【{form} 形态】{FORM_SPECS[form]}"
            form_line = f"；形态：{form}"
        else:
            msg = f"朋友圈形态须为 short / long / both，当前为 {form}"
            raise ValueError(msg)

    shots = select_few_shots(platform, form, batch_kind)
    sections = [
        f"当前平台：{PLATFORM_NAMES[platform]}（{platform}）{form_line}；批次：{batch_kind}",
        f"# 平台规则\n\n{spec}{output_extra}",
        f"# 批次约束\n\n{BATCH_CONSTRAINTS[batch_kind]}",
    ]
    if shots:
        shot_text = [
            "# 本平台正例（只学结构、节奏与话题写法）",
            "",
            "注意：部分正例来自同一项目的历史实投文案——其中的语句、数字、案件细节一律不得复用到本次产出；"
            "本次取材只回到宣发资料正文，句子必须重新写。",
        ]
        for shot in shots:
            tag = f"〔{_FORM_LABELS[shot['form']]}〕" if platform == "moments" and form == "both" else ""
            shot_text += ["", f"## {tag}{shot['label']}", "", "```", shot["body"], "```", "", f"学：{shot['lesson']}"]
        sections.append("\n".join(shot_text))
    else:
        sections.append("# 本平台正例\n\n（当前组合暂无正例，按平台规则与批次约束写）")
    return "\n\n".join(sections)


class PromotionPlatformRulesComponent(Component):
    display_name = "宣发平台规则"
    description = "按平台/形态/批次输出宣发写作规则与正例（只含当前组合，供 Prompt 引用）。"
    icon = "BookOpen"
    name = "PromotionPlatformRules"

    inputs = [
        DropdownInput(
            name="platform",
            display_name="平台",
            options=list(PLATFORM_SPECS),
            value="douyin",
            required=True,
            info="douyin 抖音 / channels 视频号 / weibo 微博 / moments 朋友圈",
        ),
        DropdownInput(
            name="form",
            display_name="形态",
            options=["both", "short", "long"],
            value="both",
            info="仅朋友圈使用：both 四行+长文都要 / short 四行文案 / long 长文案",
        ),
        DropdownInput(
            name="batch_kind",
            display_name="批次",
            options=["daily", "milestone"],
            value="daily",
            info="daily 日常（追更/花絮/名场面）/ milestone 节点（定档/开播/收官/捷报）",
        ),
    ]

    outputs = [
        Output(display_name="规则", name="rules", method="build_rules"),
    ]

    def build_rules(self) -> Message:
        text = build_rules_text(str(self.platform), str(self.form), str(self.batch_kind))
        self.status = text[:200]
        return Message(text=text)
